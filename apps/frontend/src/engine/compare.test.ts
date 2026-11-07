import type { AnalysisResult, GraphSpec, GraphVersion } from "@causal-graph-workbench/shared";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, test } from "vitest";

import { analyze, analyzeInStages } from "./analyze";
import { describeChange } from "./compare";
import { combineUpdates, mergeUpdate, type AnalysisUpdate } from "./mergeUpdate";

const content = readFileSync(resolve(__dirname, "../../public/demo-data/training-program-study.csv"), "utf-8");
const dataset = { filename: "training-program-study.csv", content };
const TRUE_EFFECT = 2.8;

type Arrow = [string, string];
const MEASURED = ["age", "education", "prior_earnings", "training", "skills_after", "earnings_after", "promoted"];
const TIMING: Record<string, "baseline" | "before" | "after"> = { age: "baseline", education: "baseline", prior_earnings: "before", skills_after: "after", promoted: "after" };

const A: Arrow[] = [
  ["age", "prior_earnings"],
  ["education", "prior_earnings"],
  ["age", "training"],
  ["prior_earnings", "training"],
  ["age", "earnings_after"],
  ["education", "earnings_after"],
  ["prior_earnings", "earnings_after"],
  ["training", "skills_after"],
  ["education", "skills_after"],
  ["skills_after", "earnings_after"],
  ["training", "earnings_after"],
  ["training", "promoted"],
  ["earnings_after", "promoted"],
];
const B: Arrow[] = [...A, ["education", "training"]];
const D: Arrow[] = [...A, ["U", "education"], ["U", "training"]];
const F: Arrow[] = [...A, ["U", "training"], ["U", "earnings_after"]];
const R: Arrow[] = B.map(([source, target]) => (source === "prior_earnings" && target === "training" ? ["training", "prior_earnings"] : [source, target]));

const saturated = (order: string[]): Arrow[] => order.flatMap((from, index) => order.slice(index + 1).map((to): Arrow => [from, to]));
const G = saturated(MEASURED);
const G2 = saturated(["age", "prior_earnings", "training", "education", "skills_after", "earnings_after", "promoted"]);

function spec(arrows: Arrow[], { unmeasured = [] as string[], timing = true } = {}): GraphSpec {
  return {
    nodes: [...MEASURED, ...unmeasured].map((id, index) => ({
      id,
      label: id,
      x: index * 40,
      y: index * 30,
      observed: !unmeasured.includes(id),
      ...(timing && TIMING[id] ? { timing: TIMING[id] } : {}),
    })),
    edges: arrows.map(([source, target]) => ({ id: `${source}->${target}`, source, target })),
    treatmentId: "training",
    outcomeId: "earnings_after",
  };
}

const version = (name: string, graph: GraphSpec): GraphVersion => ({ id: name, name: `Graph ${name}`, graph });

function compare(versions: GraphVersion[], extra: Partial<Parameters<typeof analyze>[0]> = {}): NonNullable<AnalysisResult["comparison"]> {
  return analyze({ graph: versions[0].graph, dataset, versions, ...extra }).comparison!;
}

const row = (comparison: NonNullable<AnalysisResult["comparison"]>, id: string) => comparison.graphs.find((graph) => graph.id === id)!;
const contradicted = (comparison: NonNullable<AnalysisResult["comparison"]>, id: string) => row(comparison, id).checks!.filter((check) => check.conflict).length;

describe("comparing graphs on the worked example", () => {
  const versions = [
    version("A", spec(A)),
    version("B", spec(B)),
    version("D", spec(D, { unmeasured: ["U"] })),
    version("R", spec(R)),
    version("F", spec(F, { unmeasured: ["U"] })),
  ];
  const comparison = compare(versions, { graph: versions[1].graph, activeVersionId: "B" });

  test("each graph gets its own set and estimate", () => {
    expect(comparison.status).toBe("complete");
    expect(row(comparison, "A").adjustmentSet).toEqual(["age", "prior_earnings"]);
    expect(row(comparison, "A").estimate!.estimate).toBeCloseTo(4.63, 2);
    expect(row(comparison, "B").adjustmentSet).toEqual(["age", "education", "prior_earnings"]);
    expect(row(comparison, "B").estimate!.estimate).toBeCloseTo(2.882, 2);
    expect(row(comparison, "R").adjustmentSet).toEqual(["age", "education"]);
    expect(row(comparison, "R").estimate!.estimate).toBeCloseTo(2.032, 2);
  });

  test("a graph's row matches what the page shows when that graph is open", () => {
    for (const item of versions) {
      const alone = analyze({ graph: item.graph, dataset });
      const shown = row(comparison, item.id);
      expect(shown.adjustmentSet).toEqual(alone.baselineSet);
      expect(shown.estimate?.estimate).toBe(alone.effect?.estimate?.estimate);
      expect(shown.estimate?.ciLow).toBe(alone.effect?.estimate?.ciLow);
      if (alone.audit) {
        const byId = (tests: { id: string }[]) => [...tests].sort((left, right) => left.id.localeCompare(right.id));
        expect(byId(shown.checks!)).toEqual(byId(alone.audit.tests));
      }
    }
  });

  test("graphs that lead to the same set are one answer, whatever their stories", () => {
    expect(comparison.answers.map((answer) => answer.graphIds)).toEqual([["A"], ["B", "D"], ["R"], ["F"]]);
    expect(comparison.answers[3].adjustmentSet).toBeNull();
  });

  test("the data can reject a graph, and rejecting one does not pick another", () => {
    expect(contradicted(comparison, "A")).toBe(1);
    expect(row(comparison, "A").checks!.find((check) => check.conflict)).toMatchObject({ left: "education", right: "training" });
    expect(contradicted(comparison, "B")).toBe(0);
    expect(contradicted(comparison, "R")).toBe(0);
    // R passes every check and is wrong: its interval misses the true effect.
    expect(row(comparison, "R").estimate!.ciHigh).toBeLessThan(TRUE_EFFECT);
  });

  test("a graph with no valid set is still checked against the data", () => {
    expect(row(comparison, "F").adjustmentSet).toBeNull();
    expect(row(comparison, "F").estimate).toBeNull();
    expect(contradicted(comparison, "F")).toBe(1);
  });

  test("names the set valid under the most graphs, and the graphs it is not valid under", () => {
    expect(comparison.sharedSet).toMatchObject({
      variables: ["age", "education", "prior_earnings"],
      validIn: ["A", "B", "D"],
      notValidIn: ["R", "F"],
    });
    expect(comparison.sharedSet!.estimate!.estimate).toBeCloseTo(2.882, 2);
  });

  test("says which graphs the checks cannot separate, even when their answers differ", () => {
    // F differs from A only by something unmeasured behind treatment and outcome, which leaves no trace in any test.
    expect(comparison.sameClaims).toEqual([["A", "F"], ["B", "D", "R"]]);
  });

  test("says which graph is the one on the page", () => {
    expect(comparison.shownId).toBe("B");
  });

  test("timing is what can separate them", () => {
    expect(row(comparison, "R").timingConflict).toMatch(/training → prior_earnings/);
    expect(row(comparison, "B").timingConflict).toBeNull();
  });

  test("describes each graph by how it differs from the first", () => {
    expect(row(comparison, "A").changeFromFirst).toBeNull();
    expect(row(comparison, "B").changeFromFirst).toBe("+ education → training");
    expect(row(comparison, "D").changeFromFirst).toBe("+ U → education, + U → training; U not measured");
    expect(row(comparison, "R").changeFromFirst).toBe("prior_earnings → training reversed, + education → training");
  });
});

describe("what a comparison must not suggest", () => {
  test("a graph with every arrow claims nothing, so it can never be contradicted, right or wrong", () => {
    const comparison = compare([version("G", spec(G)), version("W", spec(G2, { timing: false }))]);
    expect(row(comparison, "G").checks).toEqual([]);
    expect(row(comparison, "W").checks).toEqual([]);
    expect(row(comparison, "W").adjustmentSet).toEqual(["age", "prior_earnings"]);
    expect(row(comparison, "W").estimate!.ciLow).toBeGreaterThan(TRUE_EFFECT);
    expect(comparison.sameClaims).toEqual([["G", "W"]]);
  });

  test("an arrow that changes no set adds no new answer", () => {
    const comparison = compare([version("B", spec(B)), version("C", spec([...B, ["education", "promoted"]]))]);
    expect(comparison.answers).toHaveLength(1);
    expect(comparison.sharedSet).toBeNull();
    expect(comparison.sameClaims).toEqual([]);
  });
});

describe("a shared set has to earn its place", () => {
  test("it is not singled out when simply taking one side covers as many graphs", () => {
    // Treatment might affect M, or M treatment, or neither. Adjusting for M is right in one, and leaving it out in the other.
    const arrows = (extra: Arrow[]): GraphSpec => ({
      nodes: ["X", "Y", "M"].map((id) => ({ id, label: id, x: 0, y: 0 })),
      edges: [["X", "Y"], ["M", "Y"], ...extra].map(([source, target]) => ({ id: `${source}->${target}`, source, target })),
      treatmentId: "X",
      outcomeId: "Y",
    });
    const comparison = analyze({
      graph: arrows([["M", "X"]]),
      versions: [
        { id: "confounder", name: "Graph A", graph: arrows([["M", "X"]]) },
        { id: "mediator", name: "Graph B", graph: arrows([["X", "M"]]) },
        { id: "neither", name: "Graph C", graph: arrows([]) },
      ],
    }).comparison!;
    expect(comparison.answers).toHaveLength(2);
    expect(comparison.sharedSet).toBeNull();
  });
});

describe("graphs that cannot be compared as they are", () => {
  test("a graph with a cycle says so and does not stop the others", () => {
    const comparison = compare([version("A", spec(A)), version("C", spec([...A, ["training", "education"]]))]);
    expect(row(comparison, "C").problem).toMatch(/cycle/);
    expect(row(comparison, "C").checks).toBeNull();
    expect(row(comparison, "A").estimate).not.toBeNull();
    expect(comparison.answers.map((answer) => answer.graphIds)).toEqual([["A"]]);
    expect(comparison.status).toBe("complete");
  });

  test("without data it still compares sets and what the graphs claim", () => {
    const comparison = compare([version("A", spec(A)), version("B", spec(B)), version("R", spec(R))], { dataset: null });
    expect(row(comparison, "B").adjustmentSet).toEqual(["age", "education", "prior_earnings"]);
    expect(row(comparison, "B").estimate).toBeNull();
    expect(row(comparison, "B").checks).toBeNull();
    expect(comparison.sameClaims).toEqual([["B", "R"]]);
    expect(comparison.sharedSet).toMatchObject({ validIn: ["A", "B"], estimate: null });
  });

  test("a set the user chose is used wherever it is valid, as it would be with that graph open", () => {
    const chosen = { chosenSet: ["age", "education", "prior_earnings"] };
    const comparison = compare([version("A", spec(A)), version("R", spec(R))], { dataContext: chosen });
    expect(row(comparison, "A").adjustmentSet).toEqual(chosen.chosenSet);
    expect(row(comparison, "R").adjustmentSet).toEqual(["age", "education"]);
    const open = analyze({ graph: spec(A), dataset, dataContext: chosen });
    expect(row(comparison, "A").estimate!.estimate).toBe(open.effect!.estimate!.estimate);
  });

  test("the choice of estimand applies to every graph", () => {
    const comparison = compare([version("A", spec(A)), version("B", spec(B))], { dataContext: { estimand: "att" } });
    expect(row(comparison, "A").estimate!.estimand).toBe("att");
    expect(row(comparison, "B").estimate!.estimand).toBe("att");
  });
});

describe("the stages reach the page", () => {
  const versions = [version("A", spec(A)), version("B", spec(B))];

  /** The way the worker holds back updates between sends, and the page applies them. */
  function throughTheChannel(sendEvery: number): AnalysisResult {
    let result: AnalysisResult | null = null;
    let held: AnalysisUpdate | null = null;
    let count = 0;
    for (const stage of analyzeInStages({ graph: versions[0].graph, dataset, versions })) {
      if ("structure" in stage) {
        result = stage.structure;
        continue;
      }
      held = combineUpdates(held, stage.update);
      count += 1;
      if (count % sendEvery === 0) {
        result = mergeUpdate(result!, held);
        held = null;
      }
    }
    return held ? mergeUpdate(result!, held) : result!;
  }

  test.each([1, 2, 1000])("nothing is lost when updates are sent every %i stages", (sendEvery) => {
    const received = throughTheChannel(sendEvery);
    const direct = analyze({ graph: versions[0].graph, dataset, versions });
    expect(received.audit!.status).toBe("complete");
    expect(received.effect!.estimate!.estimate).toBe(direct.effect!.estimate!.estimate);
    expect(received.sensitivity!.status).toBe("complete");
    expect(received.comparison!.status).toBe("complete");
    expect(received.comparison!.answers).toEqual(direct.comparison!.answers);
  });

  test("a single graph does not run a comparison", () => {
    expect(analyze({ graph: versions[0].graph, dataset, versions: [versions[0]] }).comparison).toBeNull();
    expect(analyze({ graph: versions[0].graph, dataset }).comparison).toBeNull();
  });
});

describe("how a change is described", () => {
  const graph = (arrows: Arrow[]) => spec(arrows);

  test("identical graphs say so", () => {
    expect(describeChange(graph(A), graph(A))).toBe("Same arrows as the first graph");
  });

  test("a removed arrow and a long list stay readable", () => {
    expect(describeChange(graph(A), graph(A.slice(1)))).toBe("− age → prior_earnings");
    expect(describeChange(graph(A), graph(A.slice(6)))).toBe("− age → prior_earnings, − education → prior_earnings, − age → training, − prior_earnings → training and 2 more");
  });
});

describe("the potential outcomes behind the estimate", () => {
  test("their difference is the estimate, for both estimands", () => {
    for (const estimand of ["ate", "att"] as const) {
      const estimate = analyze({ graph: spec(B), dataset, dataContext: { estimand } }).effect!.estimate!;
      expect(estimate.potentialMeans!.treated - estimate.potentialMeans!.control).toBeCloseTo(estimate.estimate, 9);
    }
  });

  test("a numeric treatment has none", () => {
    const file = ["X,Y,Z", ...Array.from({ length: 60 }, (_, index) => `${index},${index * 2 + (index % 7)},${index % 5}`)].join("\n");
    const estimate = analyze({
      graph: {
        nodes: ["X", "Y", "Z"].map((id) => ({ id, label: id, x: 0, y: 0 })),
        edges: [
          { id: "Z->X", source: "Z", target: "X" },
          { id: "Z->Y", source: "Z", target: "Y" },
          { id: "X->Y", source: "X", target: "Y" },
        ],
        treatmentId: "X",
        outcomeId: "Y",
      },
      dataset: { content: file },
    }).effect!.estimate!;
    expect(estimate.method).toBe("ols");
    expect(estimate.potentialMeans).toBeNull();
  });
});
