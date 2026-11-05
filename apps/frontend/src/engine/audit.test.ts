import type { GraphSpec, VariableTiming } from "@causal-graph-workbench/shared";
import { describe, expect, test } from "vitest";

import { createAdjustmentProblem, isValidAdjustmentSet } from "./adjustment";
import { analyze } from "./analyze";
import { listSingleArrowErrors, nearestValidSet, impliedIndependencies, runAudit, type AuditInput } from "./audit";
import golden from "./__fixtures__/golden.json";
import { Dag, isDSeparated } from "./graph";

interface AuditCase {
  nodes: string[];
  edges: [string, string][];
  treatment: string;
  outcome: string;
  unobserved: string[];
  timing: Record<string, VariableTiming>;
  baseline: string[];
  editsChecked: number;
  ruledOutByTiming: number;
  breaking: { edit: string; source: string; target: string; repairDistance: number | null }[];
}

const auditCases = golden.auditCases as unknown as AuditCase[];

function graphOnlyAudit(item: AuditCase) {
  const input: AuditInput = {
    dag: new Dag(item.nodes, item.edges, item.unobserved),
    treatment: item.treatment,
    outcome: item.outcome,
    baseline: item.baseline,
    minimalSets: [],
    invalidChosenSet: null,
    timing: new Map(Object.entries(item.timing)),
    effectContext: null,
    effectUnavailableReason: null,
    boundNodes: new Set(),
    hasData: false,
  };
  let last = null;
  for (const snapshot of runAudit(input)) {
    last = snapshot;
  }
  return last!;
}

describe("single-arrow errors against networkx brute force", () => {
  test.each(auditCases.map((item, index) => [index, item] as const))("case %i", (_, item) => {
    const { audit } = graphOnlyAudit(item);
    const label = JSON.stringify({ edges: item.edges, t: item.treatment, y: item.outcome, baseline: item.baseline, timing: item.timing });
    expect(audit.status).toBe("complete");
    expect(audit.editsChecked, label).toBe(item.editsChecked);
    expect(audit.editsRuledOutByTiming, label).toBe(item.ruledOutByTiming);

    const key = (edit: string, source: string, target: string) => `${edit}:${source}:${target}`;
    expect(audit.assumptions.map((entry) => entry.id).sort(), label).toEqual(
      item.breaking.map((entry) => key(entry.edit, entry.source, entry.target)).sort(),
    );

    for (const expected of item.breaking) {
      const found = audit.assumptions.find((entry) => entry.id === key(expected.edit, expected.source, expected.target))!;
      if (expected.repairDistance === null) {
        expect(found.repair, label).toBeNull();
        expect(found.severity).toBe("no_valid_set");
      } else {
        const distance = found.addedToSet.length + found.removedFromSet.length;
        expect(distance, `${label} ${found.id} repair ${found.repair}`).toBe(expected.repairDistance);
      }
    }
  });

  test("every proposed repair really is valid in the altered graph", () => {
    let checked = 0;
    for (const item of auditCases) {
      const dag = new Dag(item.nodes, item.edges, item.unobserved);
      for (const entry of graphOnlyAudit(item).audit.assumptions) {
        if (!entry.repair) {
          continue;
        }
        const edges = item.edges.filter(([from, to]) => entry.edit === "add" || !(from === entry.source && to === entry.target));
        if (entry.edit === "add") {
          edges.push([entry.source, entry.target]);
        }
        if (entry.edit === "reverse") {
          edges.push([entry.target, entry.source]);
        }
        const altered = new Dag(dag.nodes, edges, item.unobserved);
        expect(isValidAdjustmentSet(createAdjustmentProblem(altered, item.treatment, item.outcome), entry.repair)).toBe(true);
        checked += 1;
      }
    }
    expect(checked).toBeGreaterThan(20);
  });
});

function graph(edges: string, treatment = "X", outcome = "Y", extra: Partial<Record<string, Partial<GraphSpec["nodes"][number]>>> = {}): GraphSpec {
  const pairs = edges
    .split(",")
    .map((edge) => edge.trim())
    .filter(Boolean)
    .map((edge) => edge.split("->").map((part) => part.trim()) as [string, string]);
  const ids = [...new Set(pairs.flat())];
  return {
    nodes: ids.map((id) => ({ id, label: id, x: 0, y: 0, ...extra[id] })),
    edges: pairs.map(([source, target]) => ({ id: `${source}->${target}`, source, target })),
    treatmentId: treatment,
    outcomeId: outcome,
  };
}

describe("graph-only audit", () => {
  test("names the arrow the set depends on, explains why, and proposes the fix", () => {
    const result = analyze({ graph: graph("Z -> X, Z -> Y, W -> Y, X -> Y") });
    const entry = result.audit!.assumptions.find((item) => item.id === "add:W:X")!;
    expect(result.baselineSet).toEqual(["Z"]);
    expect(entry.statement).toBe("You assume W has no direct effect on X.");
    expect(entry.consequence).toBe("If it does, this backdoor path stays open: X <- W -> Y.");
    expect(entry.repair).toEqual(["W", "Z"]);
    expect(entry.addedToSet).toEqual(["W"]);
    expect(entry.dataCheckNote).toMatch(/Add data/);
  });

  test("an arrow from treatment into the set is explained as making it post-treatment", () => {
    const result = analyze({ graph: graph("Z -> X, Z -> Y, X -> Y") });
    const reverse = result.audit!.assumptions.find((item) => item.id === "reverse:Z:X")!;
    expect(reverse.statement).toBe("You assume Z affects X, not the other way round.");
    expect(reverse.consequence).toMatch(/Z would be affected by treatment/);
    expect(reverse.removedFromSet).toEqual(["Z"]);
    expect(reverse.dataCheckNote).toMatch(/Add data/);
  });

  test("an error that no measured set can survive is reported as such", () => {
    const result = analyze({ graph: graph("Z -> X, Z -> Y, U -> Y, X -> Y", "X", "Y", { U: { observed: false } }) });
    const entry = result.audit!.assumptions.find((item) => item.id === "add:U:X")!;
    expect(entry.repair).toBeNull();
    expect(entry.severity).toBe("no_valid_set");
    expect(result.audit!.assumptions[0].severity).toBe("no_valid_set");
  });

  test("marking when variables are fixed rules out impossible errors", () => {
    const edges = "Z -> X, Z -> Y, X -> Y";
    const untimed = analyze({ graph: graph(edges) }).audit!;
    const timed = analyze({ graph: graph(edges, "X", "Y", { Z: { timing: "baseline" } }) }).audit!;
    expect(untimed.assumptions.map((item) => item.id)).toContain("reverse:Z:X");
    expect(timed.assumptions.map((item) => item.id)).not.toContain("reverse:Z:X");
    expect(timed.editsRuledOutByTiming).toBeGreaterThan(0);
    expect(timed.editsChecked).toBeLessThan(untimed.editsChecked);
  });

  test("an arrow drawn backwards in time is flagged", () => {
    const result = analyze({ graph: graph("X -> Z, Z -> Y, X -> Y", "X", "Y", { Z: { timing: "before" } }) });
    expect(result.validation.issues.find((issue) => issue.code === "timing_conflict")!.message).toContain("X -> Z");
  });

  test("the outcome causing treatment is never considered", () => {
    const { errors } = listSingleArrowErrors({
      dag: new Dag(["X", "Y"], [["X", "Y"]]),
      treatment: "X",
      outcome: "Y",
      timing: new Map(),
      baseline: [],
    });
    expect(errors.map((error) => `${error.edit}:${error.source}:${error.target}`)).toEqual(["remove:X:Y"]);
  });

  test("errors touching treatment or the current set are checked first", () => {
    const { errors } = listSingleArrowErrors({
      dag: new Dag(["A", "B", "C", "X", "Y"], [["X", "Y"], ["A", "B"]]),
      treatment: "X",
      outcome: "Y",
      timing: new Map(),
      baseline: [],
    });
    const firstUnrelated = errors.findIndex((error) => error.source !== "X" && error.target !== "X");
    const lastRelated = errors.map((error) => error.source === "X" || error.target === "X").lastIndexOf(true);
    expect(lastRelated).toBeLessThan(firstUnrelated);
  });

  test("a chosen valid set becomes the current set, and the code follows it", () => {
    const spec = graph("Z -> X, Z -> Y, W -> Z, X -> Y");
    const result = analyze({ graph: spec, dataContext: { chosenSet: ["W", "Z"], treatmentType: "binary", outcomeType: "continuous" } });
    expect(result.recommendedAdjustmentSet).toEqual(["Z"]);
    expect(result.baselineSet).toEqual(["W", "Z"]);
    expect(result.audit!.baselineSet).toEqual(["W", "Z"]);
    expect(result.codeSnippets[0].content).toContain('adjustment_covariates = ["W","Z"]');
  });

  test("a chosen invalid set does not take over, whatever it contains", () => {
    const spec = graph("Z -> X, Z -> Y, X -> M, M -> Y");
    const result = analyze({ graph: spec, dataContext: { chosenSet: ["M"] } });
    expect(result.baselineSet).toEqual(["Z"]);
    expect(result.codeSnippets[0].content).toContain('adjustment_covariates = ["Z"]');
  });
});

describe("implied independencies", () => {
  test("hold in the graph they come from", () => {
    for (const item of auditCases) {
      const dag = new Dag(item.nodes, item.edges, item.unobserved);
      const bound = new Set(item.nodes.filter((node) => !item.unobserved.includes(node)));
      const { specs } = impliedIndependencies(dag, bound);
      for (const spec of specs) {
        expect(isDSeparated(dag, [spec.left], [spec.right], spec.given), JSON.stringify({ edges: item.edges, spec })).toBe(true);
        expect(spec.given.every((node) => bound.has(node))).toBe(true);
      }
    }
  });

  test("a pair joined only through something unmeasured cannot be tested", () => {
    const dag = new Dag(["A", "B", "U"], [["U", "A"], ["U", "B"]], ["U"]);
    const { specs, untestablePairs } = impliedIndependencies(dag, new Set(["A", "B"]));
    expect(specs).toEqual([]);
    expect(untestablePairs).toBe(1);
  });
});

describe("nearest valid set", () => {
  test("changes the current set as little as possible", () => {
    const dag = new Dag(["A", "B", "C", "X", "Y"], [["A", "X"], ["A", "Y"], ["B", "X"], ["B", "Y"], ["C", "Y"], ["X", "Y"]]);
    const problem = createAdjustmentProblem(dag, "X", "Y");
    expect(nearestValidSet(problem, ["A", "C"])).toEqual(["A", "B", "C"]);
  });

  test("is null when nothing measured works", () => {
    const dag = new Dag(["U", "X", "Y"], [["U", "X"], ["U", "Y"], ["X", "Y"]], ["U"]);
    expect(nearestValidSet(createAdjustmentProblem(dag, "X", "Y"), [])).toBeNull();
  });
});

/** Known truth: Z and W both confound X -> Y, but the drawn graph leaves out W -> X. */
function confoundedFile(rows = 1500) {
  let state = 7;
  const random = () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 4294967296;
  };
  const normal = () => Math.sqrt(-2 * Math.log(random() || 1e-12)) * Math.cos(2 * Math.PI * random());
  const lines = ["X,Y,Z,W,V"];
  for (let row = 0; row < rows; row += 1) {
    const z = normal();
    const w = normal();
    const v = normal();
    const x = random() < 1 / (1 + Math.exp(-(0.8 * z + 1.2 * w))) ? 1 : 0;
    const y = 1.0 * x + 0.7 * z + 1.1 * w + 0.5 * v + normal();
    lines.push([x, y.toFixed(4), z.toFixed(4), w.toFixed(4), v.toFixed(4)].join(","));
  }
  return lines.join("\n");
}

describe("audit with data, on a file with a known answer", () => {
  const spec = graph("Z -> X, Z -> Y, W -> Y, V -> Y, X -> Y");
  const result = analyze({ graph: spec, dataset: { filename: "known.csv", content: confoundedFile() } });
  const audit = result.audit!;
  const effect = result.effect!;

  test("the wrong graph gives a biased estimate, and the audit finds the arrow responsible", () => {
    expect(result.baselineSet).toEqual(["Z"]);
    expect(effect.estimate!.estimate).toBeGreaterThan(1.3);
    const top = audit.assumptions[0];
    expect(top.id).toBe("add:W:X");
    expect(top.dataCheck).toBe("conflict");
    expect(top.dataCheckNote).toMatch(/something unmeasured affects both/);
    expect(top.repair).toEqual(["W", "Z"]);
    expect(top.alternativeEstimate!.estimate).toBeGreaterThan(0.8);
    expect(top.alternativeEstimate!.estimate).toBeLessThan(1.2);
    expect(top.shift!).toBeLessThan(0);
    expect(["changes_conclusion", "moves_estimate"]).toContain(top.severity);
  });

  test("an arrow that does not exist does not get flagged as a conflict", () => {
    const entry = audit.assumptions.find((item) => item.id === "add:V:X")!;
    expect(entry.dataCheck).toBe("no_conflict");
    expect(entry.dataCheckNote).toMatch(/does not show the arrow is absent/);
    expect(entry.severity).toBe("small_shift");
  });

  test("errors the data cannot speak to say so", () => {
    expect(audit.assumptions.find((item) => item.id === "reverse:Z:X")!.dataCheckNote).toMatch(/cannot tell which way/);
  });

  test("no test result is ever described as confirming the graph", () => {
    const text = JSON.stringify(audit).toLowerCase();
    expect(text).not.toMatch(/\b(passed|confirmed|verified|validated)\b/);
  });

  test("the comparison table includes the crude estimate and everything measured", () => {
    const kinds = effect.comparisons.map((item) => item.kind);
    expect(kinds).toContain("baseline");
    expect(kinds).toContain("none");
    const none = effect.comparisons.find((item) => item.kind === "none")!;
    expect(none.isValid).toBe(false);
    expect(none.invalidReason).toMatch(/backdoor path stays open/);
    expect(none.estimate!.estimate).toBeGreaterThan(effect.estimate!.estimate);
  });

  test("a mediator in 'everything measured' is explained as invalid", () => {
    const withMediator = analyze({
      graph: graph("Z -> X, Z -> Y, X -> W, W -> Y, X -> Y"),
      dataset: { filename: "known.csv", content: confoundedFile(400) },
    });
    const all = withMediator.effect!.comparisons.find((item) => item.kind === "all")!;
    expect(all.isValid).toBe(false);
    expect(all.invalidReason).toMatch(/W is downstream of treatment/);
  });

  test("a set the user tried that is invalid appears only as a comparison", () => {
    const tried = analyze({
      graph: graph("Z -> X, Z -> Y, X -> W, W -> Y, X -> Y"),
      dataContext: { chosenSet: ["W"] },
      dataset: { filename: "known.csv", content: confoundedFile(400) },
    });
    expect(tried.baselineSet).toEqual(["Z"]);
    const custom = tried.effect!.comparisons.find((item) => item.kind === "custom")!;
    expect(custom.variables).toEqual(["W"]);
    expect(custom.isValid).toBe(false);
  });
});

describe("audit edge cases", () => {
  test("a variable with no column is treated as unmeasured, so the recommendation can be estimated", () => {
    const result = analyze({
      graph: graph("Z -> X, Z -> Y, W -> X, W -> Y, X -> Y"),
      dataset: { filename: "known.csv", content: "X,Y,Z\n" + Array.from({ length: 60 }, (_, i) => `${i % 2},${i},${i % 5}`).join("\n") },
    });
    expect(result.adjustmentSets).toEqual([]);
    expect(result.effect?.estimate ?? null).toBeNull();
    expect(result.dataDiagnostics!.warnings.join(" ")).toMatch(/No column is matched to W/);
  });

  test("an unmatched treatment explains why there is no estimate", () => {
    const result = analyze({
      graph: graph("Z -> X, Z -> Y, X -> Y"),
      dataset: { filename: "known.csv", content: "Y,Z\n" + Array.from({ length: 60 }, (_, i) => `${i},${i % 5}`).join("\n") },
    });
    expect(result.effect!.estimate).toBeNull();
    expect(result.effect!.unavailableReason).toMatch(/No column is matched to X/);
    expect(result.audit!.status).toBe("complete");
  });

  test("a variable explicitly marked as not in the file is not auto-matched", () => {
    const result = analyze({
      graph: graph("Z -> X, Z -> Y, X -> Y"),
      dataContext: { columnBindings: { Z: "" } },
      dataset: { filename: "known.csv", content: "X,Y,Z\n" + Array.from({ length: 60 }, (_, i) => `${i % 2},${i},${i % 5}`).join("\n") },
    });
    expect(result.dataDiagnostics!.variableBindings.find((item) => item.nodeId === "Z")!.matched).toBe(false);
    expect(result.adjustmentSets).toEqual([]);
  });

  test("no valid set means no audit and no estimate", () => {
    const result = analyze({ graph: graph("U -> X, U -> Y, X -> Y", "X", "Y", { U: { observed: false } }) });
    expect(result.audit).toBeNull();
    expect(result.effect).toBeNull();
  });

  test("the same analysis gives the same numbers when repeated, with results reused from cache", () => {
    const request = { graph: graph("Z -> X, Z -> Y, W -> Y, V -> Y, X -> Y"), dataset: { filename: "k.csv", content: confoundedFile(600) } };
    const first = analyze(request);
    const started = performance.now();
    const second = analyze(request);
    expect(second.effect!.estimate!.estimate).toBe(first.effect!.estimate!.estimate);
    expect(second.audit!.assumptions.map((item) => item.shift)).toEqual(first.audit!.assumptions.map((item) => item.shift));
    expect(performance.now() - started).toBeLessThan(500);
  });

  test("stages deliver the structure first and finish with a complete audit", async () => {
    const { analyzeInStages } = await import("./analyze");
    const stages = [...analyzeInStages({ graph: graph("Z -> X, Z -> Y, X -> Y") })];
    expect("structure" in stages[0]).toBe(true);
    const last = stages[stages.length - 1];
    expect("update" in last && last.update.audit.status).toBe("complete");
  });
});
