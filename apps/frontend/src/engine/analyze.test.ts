import type { AnalysisResult, DataContext, GraphSpec, UploadedDataset } from "@causal-graph-workbench/shared";
import { describe, expect, test } from "vitest";

import { analyze } from "./analyze";
import { Dag } from "./graph";
import { enumeratePaths, materializePaths } from "./paths";
import { validateGraph } from "./validation";

function graph(edges: string, treatment: string | null = "X", outcome: string | null = "Y", unobserved: string[] = [], extraNodes: string[] = []): GraphSpec {
  const pairs = edges
    .split(",")
    .map((edge) => edge.trim())
    .filter(Boolean)
    .map((edge) => edge.split("->").map((part) => part.trim()) as [string, string]);
  const ids = [...new Set([...pairs.flat(), ...extraNodes])];
  return {
    nodes: ids.map((id) => ({ id, label: id, x: 0, y: 0, observed: !unobserved.includes(id) })),
    edges: pairs.map(([source, target]) => ({ id: `${source}->${target}`, source, target })),
    treatmentId: treatment,
    outcomeId: outcome,
  };
}

function run(spec: GraphSpec, dataContext?: DataContext, dataset?: UploadedDataset): AnalysisResult {
  return analyze({ graph: spec, dataContext, dataset });
}

function setsOf(result: AnalysisResult) {
  return new Map(result.adjustmentSets.map((item) => [item.variables.join(","), item]));
}

function rolesOf(result: AnalysisResult, node: string) {
  return new Set(result.nodeRoles.find((item) => item.nodeId === node)?.roles);
}

function snippet(result: AnalysisResult, id: string): string {
  return result.codeSnippets.find((item) => item.id === id)!.content;
}

describe("defects found in the previous engine", () => {
  const butterfly = "U1 -> X, U1 -> M, U2 -> M, U2 -> Y, M -> X, M -> Y, X -> Y";

  test("butterfly graph: recommends a valid set instead of adjusting for nothing", () => {
    const result = run(graph(butterfly));
    expect(result.recommendedAdjustmentSet).toContain("M");
    expect(result.recommendedAdjustmentSet).toHaveLength(2);
    expect(result.adjustmentSets.filter((item) => item.isMinimal).map((item) => item.variables.join(",")).sort()).toEqual(["M,U1", "M,U2"]);
    expect(result.forbiddenVariables.map((item) => item.nodeId)).not.toContain("M");
    for (const item of result.codeSnippets) {
      expect(item.content).toContain('"M"');
    }
    expect(result.estimatorRecommendations.find((item) => item.recommended)!.formulaPreview).toMatch(/Y ~ X \+ M \+ U[12]/);
  });

  test("butterfly graph: M is flagged as required but not safe alone", () => {
    const caution = run(graph(butterfly)).cautionVariables.find((item) => item.nodeId === "M")!;
    expect(caution.required).toBe(true);
    expect(caution.reasons.join(" ")).toMatch(/must include M/);
    expect(caution.reasons.join(" ")).toMatch(/collider/);
  });

  test("an instrument is not labelled a confounder", () => {
    const result = run(graph("Z -> X, X -> Y"));
    expect(rolesOf(result, "Z").has("confounder")).toBe(false);
    expect(rolesOf(result, "Z").has("instrument_like")).toBe(true);
    expect(result.nodeRoles.find((item) => item.nodeId === "Z")!.summary).toMatch(/only through treatment/);
    expect(result.recommendedAdjustmentSet).toEqual([]);
  });

  test("a confounder reached through a mediating variable still counts", () => {
    const result = run(graph("Z -> W, W -> X, W -> Y, X -> Y"));
    expect(rolesOf(result, "Z").has("confounder")).toBe(true);
    expect(rolesOf(result, "W").has("confounder")).toBe(true);
  });

  test("M-bias: the empty set is recommended and M is a caution rather than forbidden when companions exist", () => {
    const result = run(graph("U1 -> X, U1 -> M, U2 -> M, U2 -> Y, X -> Y"));
    expect(result.recommendedAdjustmentSet).toEqual([]);
    expect(result.adjustmentSets.some((item) => item.variables.length === 0 && item.isRecommended)).toBe(true);
    expect(result.forbiddenVariables.map((item) => item.nodeId)).not.toContain("M");
    expect(result.cautionVariables.find((item) => item.nodeId === "M")!.required).toBe(false);
  });

  test("M-bias with unobserved companions: M really is forbidden", () => {
    const result = run(graph("U1 -> X, U1 -> M, U2 -> M, U2 -> Y, X -> Y", "X", "Y", ["U1", "U2"]));
    expect(result.recommendedAdjustmentSet).toEqual([]);
    expect(result.forbiddenVariables.find((item) => item.nodeId === "M")!.reasons.join(" ")).toMatch(/No valid adjustment set/);
    expect(result.adjustmentSets.map((item) => item.variables.join(","))).toEqual([""]);
  });

  test("a variable needed for validity is never rated as something to avoid", () => {
    const result = run(graph(butterfly));
    for (const item of result.adjustmentSets.filter((entry) => entry.isMinimal)) {
      expect(item.practicalRating).not.toBe("avoid");
    }
  });

  test("an unneeded outcome predictor is acceptable, while an unneeded instrument is not", () => {
    const result = run(graph("Z -> X, Z -> Y, V -> Y, W -> X, X -> Y"));
    const sets = setsOf(result);
    expect(sets.get("V,Z")!.practicalRating).toBe("acceptable");
    expect(sets.get("W,Z")!.practicalRating).toBe("avoid");
    expect(sets.get("W,Z")!.practicalConcerns.join(" ")).toMatch(/W affects the outcome only through treatment/);
  });

  test("large graphs are analysed instead of hanging", () => {
    const names = Array.from({ length: 24 }, (_, index) => `V${String(index).padStart(2, "0")}`);
    const edges = names.flatMap((left, leftIndex) =>
      names.slice(leftIndex + 1).filter((_, offset) => (leftIndex * 7 + offset * 13) % 4 === 0).map((right) => `${left} -> ${right}`),
    );
    const started = performance.now();
    const result = run(graph(edges.join(","), "V12", "V23"));
    const elapsed = performance.now() - started;
    expect(result.limits.pathsTruncated).toBe(true);
    expect(result.paths.length).toBeLessThanOrEqual(300);
    expect(result.adjustmentSets.length).toBeGreaterThan(0);
    expect(result.validation.issues.map((issue) => issue.code)).toContain("paths_truncated");
    expect(elapsed).toBeLessThan(5000);
  });
});

describe("adjustment engine", () => {
  test("returns valid sets and marks minimal ones", () => {
    const result = run(graph("Z -> X, Z -> Y, W -> X, X -> Y"));
    const sets = setsOf(result);
    expect(sets.get("Z")!.isMinimal).toBe(true);
    expect(sets.get("W,Z")!.isMinimal).toBe(false);
    expect(result.recommendedAdjustmentSet).toEqual(["Z"]);
    expect(sets.get("W,Z")!.practicalRating).toBe("avoid");
  });

  test("finds multiple minimal sets", () => {
    const result = run(graph("Z -> X, Z -> W1, Z -> W2, W1 -> Y, W2 -> Y, X -> Y"));
    const minimal = result.adjustmentSets.filter((item) => item.isMinimal).map((item) => item.variables.join(","));
    expect(minimal).toContain("Z");
    expect(minimal).toContain("W1,W2");
    expect(result.recommendedAdjustmentSet).toEqual(["Z"]);
  });

  test("a structurally valid but needlessly risky set is not recommended", () => {
    const result = run(graph("A -> X, A -> C, B -> C, B -> Y, U -> X, U -> Y"));
    const sets = setsOf(result);
    expect(sets.has("U")).toBe(true);
    expect(sets.get("A,C,U")!.isValid).toBe(true);
    expect(sets.get("A,C,U")!.practicalRating).toBe("avoid");
    expect(sets.get("A,C,U")!.practicalConcerns.join(" ").toLowerCase()).toContain("collider");
    expect(result.recommendedAdjustmentSet).toEqual(["U"]);
  });

  test("mediators, treatment descendants and post-treatment colliders are forbidden", () => {
    const result = run(graph("Z -> X, Z -> Y, X -> M, M -> Y, M -> D, X -> C, U -> C, U -> Y"));
    const forbidden = result.forbiddenVariables.map((item) => item.nodeId);
    expect(forbidden).toEqual(expect.arrayContaining(["M", "D", "C"]));
    expect(result.recommendedAdjustmentSet).toEqual(["Z"]);
  });

  test("with unobserved confounding, recommendations and code are withheld", () => {
    const result = run(graph("U -> X, U -> Y", "X", "Y", ["U"]));
    expect(result.adjustmentSets).toEqual([]);
    expect(result.recommendedAdjustmentSet).toEqual([]);
    expect(result.estimatorRecommendations).toEqual([]);
    expect(result.codeSnippets).toEqual([]);
    expect(result.validation.issues.map((issue) => issue.code)).toContain("no_valid_adjustment_set");
  });
});

describe("path analysis", () => {
  test("enumerates and classifies relevant paths", () => {
    const result = run(graph("Z -> X, Z -> Y, X -> M, M -> Y, X -> Y"));
    const byString = new Map(result.paths.map((path) => [path.pathString, path]));
    expect([...byString.keys()].sort()).toEqual(["X -> M -> Y", "X -> Y", "X <- Z -> Y"]);
    expect(byString.get("X <- Z -> Y")!.category).toBe("backdoor");
    expect(byString.get("X -> M -> Y")!.category).toBe("directed_causal");
    expect(byString.get("X -> Y")!.category).toBe("directed_causal");
  });

  test("a collider path is blocked until the collider or a descendant is conditioned on", () => {
    const dag = Dag.fromSpec(graph("A -> X, A -> C, B -> C, C -> D, B -> Y"));
    const { paths } = enumeratePaths(dag, "X", "Y");
    const items = materializePaths(dag, paths, [["C"], ["D"]]);
    const path = items.find((item) => item.pathString === "X <- A -> C <- B -> Y")!;

    expect(path.category).toBe("backdoor");
    expect(path.involvesCollider).toBe(true);
    expect(path.colliders).toEqual(["C"]);
    expect(path.defaultEvaluation.isOpen).toBe(false);
    expect(path.defaultEvaluation.blockedBy).toEqual(["C"]);
    expect(path.defaultEvaluation.steps.some((step) => step.nodeId === "C" && step.effect === "blocks_path")).toBe(true);

    const onC = path.adjustmentEvaluations.find((item) => item.conditioningSet.join() === "C")!;
    expect(onC.isOpen).toBe(true);
    expect(onC.openedBy).toEqual(["C"]);

    const onD = path.adjustmentEvaluations.find((item) => item.conditioningSet.join() === "D")!;
    expect(onD.isOpen).toBe(true);
    expect(onD.openedBy).toEqual(["D"]);
    expect(onD.steps.some((step) => step.nodeId === "C" && step.conditionedOnDescendant)).toBe(true);
  });

  test("explains why a backdoor path is blocked by conditioning", () => {
    const result = run(graph("Z -> X, Z -> Y, X -> Y"));
    const path = result.paths.find((item) => item.category === "backdoor")!;
    const adjusted = path.adjustmentEvaluations.find((item) => item.conditioningSet.join() === "Z")!;
    expect(adjusted.isOpen).toBe(false);
    expect(adjusted.blockedBy).toEqual(["Z"]);
    expect(adjusted.reason).toContain("blocks the path");
    expect(adjusted.steps.some((step) => step.nodeId === "Z" && step.effect === "blocks_path")).toBe(true);
  });
});

describe("node roles", () => {
  test("are relative to the selected treatment and outcome", () => {
    const result = run(graph("Z -> X, Z -> Y, X -> M, M -> Y, M -> D, X -> C, U -> C, U -> Y"));
    expect([...rolesOf(result, "Z")]).toEqual(expect.arrayContaining(["confounder", "ancestor_of_treatment", "ancestor_of_outcome"]));
    expect([...rolesOf(result, "M")]).toEqual(expect.arrayContaining(["mediator", "descendant_of_treatment", "ancestor_of_outcome"]));
    expect(rolesOf(result, "D").has("descendant_of_treatment")).toBe(true);
    expect([...rolesOf(result, "C")]).toEqual(expect.arrayContaining(["collider", "descendant_of_treatment"]));
    expect(rolesOf(result, "U").has("ancestor_of_outcome")).toBe(true);
  });
});

describe("validation", () => {
  const codes = (spec: GraphSpec) => new Set(validateGraph(spec).issues.map((issue) => issue.code));

  test("flags a cycle and a self-loop", () => {
    const spec: GraphSpec = {
      nodes: ["X", "Y"].map((id) => ({ id, label: id, x: 0, y: 0 })),
      edges: [
        { id: "e1", source: "X", target: "Y" },
        { id: "e2", source: "Y", target: "X" },
        { id: "e3", source: "X", target: "X" },
      ],
      treatmentId: "X",
      outcomeId: "Y",
    };
    expect(validateGraph(spec).canAnalyze).toBe(false);
    expect(codes(spec).has("self_loop")).toBe(true);
    expect(codes(spec).has("cycle_detected")).toBe(true);
  });

  test("flags an empty graph, duplicate edges and invalid names", () => {
    const empty: GraphSpec = { nodes: [], edges: [], treatmentId: null, outcomeId: null };
    expect(validateGraph(empty).canAnalyze).toBe(false);
    expect(codes(empty).has("empty_graph")).toBe(true);

    const invalid: GraphSpec = {
      nodes: ["1bad", "Y"].map((id) => ({ id, label: id, x: 0, y: 0 })),
      edges: [
        { id: "e1", source: "1bad", target: "Y" },
        { id: "e2", source: "1bad", target: "Y" },
      ],
      treatmentId: "1bad",
      outcomeId: "Y",
    };
    expect(codes(invalid).has("invalid_variable_name")).toBe(true);
    expect(codes(invalid).has("duplicate_edge")).toBe(true);
  });

  test("warns on isolated nodes and an unreachable treatment-outcome pair", () => {
    const spec = graph("", "X", "Y", [], ["X", "Y", "Z"]);
    expect(validateGraph(spec).canAnalyze).toBe(true);
    expect(codes(spec).has("isolated_node")).toBe(true);
    expect(codes(spec).has("treatment_outcome_unreachable")).toBe(true);
  });

  test("requires a treatment and an outcome", () => {
    const spec = graph("", null, null, [], ["Z"]);
    expect(validateGraph(spec).canAnalyze).toBe(false);
    expect(codes(spec).has("missing_treatment")).toBe(true);
    expect(codes(spec).has("missing_outcome")).toBe(true);
  });

  test("warns when there is no directed path from treatment to outcome", () => {
    const spec = graph("Y -> X");
    expect(validateGraph(spec).canAnalyze).toBe(true);
    expect(codes(spec).has("no_directed_path")).toBe(true);
  });

  test("rejects using the same variable as treatment and outcome", () => {
    const spec = graph("Z -> X, X -> Y", "X", "X");
    expect(validateGraph(spec).canAnalyze).toBe(false);
    expect(codes(spec).has("treatment_equals_outcome")).toBe(true);
    expect(run(spec).adjustmentSets).toEqual([]);
  });
});

describe("estimator recommendations", () => {
  const simple = () => graph("Z -> X, Z -> Y, X -> Y");

  test("unknown treatment type does not offer binary-only estimators or code", () => {
    const result = run(simple(), { treatmentType: "unknown", outcomeType: "unknown" });
    for (const id of ["propensity-weighting", "matching", "aipw"]) {
      expect(result.estimatorRecommendations.map((item) => item.id)).not.toContain(id);
    }
    for (const id of ["python-weighting", "python-matching", "python-aipw"]) {
      expect(result.codeSnippets.map((item) => item.id)).not.toContain(id);
    }
  });

  test("a binary treatment inferred from data restores binary-only estimators and code", () => {
    const result = run(
      simple(),
      { hasData: true, treatmentType: "unknown", outcomeType: "continuous" },
      { filename: "study.csv", content: "Z,X,Y\n0,0,1.2\n1,1,2.4\n1,0,1.1\n0,1,2.0\n" },
    );
    for (const id of ["propensity-weighting", "matching", "aipw"]) {
      expect(result.estimatorRecommendations.map((item) => item.id)).toContain(id);
    }
    for (const id of ["python-weighting", "python-matching", "python-aipw"]) {
      expect(result.codeSnippets.map((item) => item.id)).toContain(id);
    }
  });

  test("uses data presence and the high-dimensional hint", () => {
    const names = ["Z1", "Z2", "Z3", "Z4", "Z5", "Z6", "Z7"];
    const edges = [...names.flatMap((name) => [`${name} -> X`, `${name} -> Y`]), "X -> Y"].join(",");
    const result = run(graph(edges), { hasData: true, treatmentType: "binary", outcomeType: "continuous", highDimensional: true });
    const byId = new Map(result.estimatorRecommendations.map((item) => [item.id, item]));
    expect(byId.get("aipw")!.caveats.join(" ").toLowerCase()).toContain("high-dimensional");
    expect(byId.get("matching")!.caveats.join(" ").toLowerCase()).toContain("matching becomes harder");
  });

  test("selects a single default estimator", () => {
    const withData = run(simple(), { hasData: true, treatmentType: "binary", outcomeType: "continuous" });
    expect(withData.estimatorRecommendations.filter((item) => item.recommended).map((item) => item.id)).toEqual(["aipw"]);
    const withoutData = run(simple(), { hasData: false, treatmentType: "binary", outcomeType: "binary" });
    expect(withoutData.estimatorRecommendations.filter((item) => item.recommended).map((item) => item.id)).toEqual(["logistic-regression"]);
  });

  test("matching is described as an ATT and AIPW promises an interval", () => {
    const result = run(simple(), { hasData: true, treatmentType: "binary", outcomeType: "continuous" });
    const byId = new Map(result.estimatorRecommendations.map((item) => [item.id, item]));
    expect(byId.get("matching")!.summary).toContain("ATT");
    expect(byId.get("aipw")!.summary).toContain("confidence interval");
  });

  test("a multi-category outcome withholds estimators rather than emitting code that would crash", () => {
    const result = run(simple(), {}, { filename: "s.csv", content: "Z,X,Y\n0,0,a\n1,1,b\n1,0,c\n0,1,a\n" });
    expect(result.estimatorRecommendations).toEqual([]);
    expect(result.codeSnippets).toEqual([]);
    expect(result.validation.issues.map((issue) => issue.code)).toContain("categorical_outcome_unsupported");
  });
});

describe("data diagnostics", () => {
  test("infers types and missingness and reports balance and overlap", () => {
    const result = run(
      graph("Z -> X, Z -> Y, X -> Y"),
      { hasData: true },
      { filename: "study.csv", content: "X,Y,Z\n1,10,20\n0,7,25\n1,11,\n0,6,27\n1,12,21\n0,5,28\n" },
    );
    const diagnostics = result.dataDiagnostics!;
    expect(diagnostics.rowCount).toBe(6);
    const profiles = new Map(diagnostics.columnProfiles.map((profile) => [profile.columnName, profile]));
    expect(profiles.get("X")!.inferredType).toBe("binary");
    expect(profiles.get("Y")!.inferredType).toBe("continuous");
    expect(profiles.get("Z")!.missingCount).toBe(1);
    expect(diagnostics.treatmentBalance!.available).toBe(true);
    expect(diagnostics.overlapDiagnostics!.available).toBe(true);
  });

  test("the graph can be invalid and the file is still profiled", () => {
    const result = run(graph("Y -> X, X -> Y"), {}, { filename: "s.csv", content: "X,Y\n1,2\n0,3\n" });
    expect(result.validation.canAnalyze).toBe(false);
    expect(result.dataDiagnostics!.rowCount).toBe(2);
  });
});

describe("code generation", () => {
  test("uses the recommended covariates consistently across templates", () => {
    const result = run(graph("Z -> X, Z -> Y, X -> Y"), { treatmentType: "binary", outcomeType: "continuous" });
    const statsmodels = snippet(result, "python-statsmodels");
    expect(statsmodels).toContain('adjustment_covariates = ["Z"]');
    expect(statsmodels).toContain('treatment_col = "X"');
    expect(statsmodels).toContain('outcome_col = "Y"');
    expect(snippet(result, "python-dowhy")).toContain("common_causes=adjustment_covariates");
    expect(snippet(result, "r-template")).toContain('treatment_col <- "X"');
    expect(snippet(result, "r-template")).toContain('adjustment_covariates <- c("Z")');
  });

  test("binds uploaded column names and the actual file name", () => {
    const result = run(
      graph("Z -> X, Z -> Y, X -> Y"),
      { hasData: true, columnBindings: { X: "treatment_status", Y: "outcome_flag", Z: "age_years" } },
      { filename: "study.csv", content: "treatment_status,outcome_flag,age_years\n1,0,20\n0,1,34\n1,1,29\n" },
    );
    const statsmodels = snippet(result, "python-statsmodels");
    expect(statsmodels).toContain('treatment_col = "treatment_status"');
    expect(statsmodels).toContain('outcome_col = "outcome_flag"');
    expect(statsmodels).toContain('adjustment_covariates = ["age_years"]');
    expect(statsmodels).toContain('pd.read_csv("study.csv"');
    expect(snippet(result, "r-template")).toContain('read.csv("study.csv"');
  });

  test("handles an empty adjustment set without inventing covariates", () => {
    const result = run(graph("X -> Y"), { hasData: true, treatmentType: "binary", outcomeType: "continuous" });
    expect(snippet(result, "python-statsmodels")).toContain("adjustment_covariates = []");
    expect(snippet(result, "r-template")).toContain("adjustment_covariates <- character(0)");
    expect(snippet(result, "python-matching")).toContain("if adjustment_covariates:");
    expect(snippet(result, "python-matching")).toContain("crude contrast");
  });

  test("words used for a binary treatment are recoded in the generated code", () => {
    const result = run(
      graph("Z -> arm, Z -> Y, arm -> Y", "arm"),
      {},
      { filename: "s.csv", content: "Z,arm,Y\n1,treated,2\n0,control,3\n1,control,4\n0,treated,5\n" },
    );
    expect(snippet(result, "python-aipw")).toContain('.map({"treated": 1, "control": 0})');
    expect(snippet(result, "r-template")).toContain('ifelse(coded == "treated", 1');
  });

  test("assumptions state plainly that the DAG is not verified", () => {
    const result = run(graph("Z -> X, Z -> Y, X -> Y"));
    expect(result.assumptions.map((item) => item.description)).toContain(
      "The tool does not verify the DAG is true. It only reasons conditionally on the DAG provided by the user.",
    );
  });
});

describe("reading a file the way people write them", () => {
  const graph: GraphSpec = {
    nodes: ["X", "Y", "Z"].map((id) => ({ id, label: id, x: 0, y: 0 })),
    edges: [
      { id: "Z->X", source: "Z", target: "X" },
      { id: "Z->Y", source: "Z", target: "Y" },
      { id: "X->Y", source: "X", target: "Y" },
    ],
    treatmentId: "X",
    outcomeId: "Y",
  };
  const file = (zAt: (index: number) => string) => {
    const rows = Array.from({ length: 200 }, (_, index) => {
      const z = Math.sin(index * 1.3);
      return `${z + Math.cos(index * 2.1) > 0 ? 1 : 0},${(z + Math.sin(index * 4.7)).toFixed(3)},${zAt(index) || z.toFixed(3)}`;
    });
    return ["X,Y,Z", ...rows].join("\n");
  };
  const warningsFor = (content: string) => analyze({ graph, dataset: { filename: "s.csv", content } }).dataDiagnostics!.warnings;

  test("a dot means missing, as Stata and SAS write it", () => {
    const result = analyze({ graph, dataset: { filename: "s.csv", content: file((index) => (index % 20 === 0 ? "." : "")) } });
    expect(result.effect!.estimate).not.toBeNull();
    expect(result.effect!.estimate!.rowsDropped).toBe(10);
  });

  test("a stray cell in a numeric column is pointed out, with an example", () => {
    const warnings = warningsFor(file((index) => (index === 7 ? "oops" : "")));
    expect(warnings.some((warning) => /Z is mostly numbers, but 1 value is not, such as "oops"/.test(warning))).toBe(true);
  });

  test("numbers written with commas or symbols are pointed out", () => {
    const content = file((index) => `"$1,${String(100 + index)}"`);
    expect(warningsFor(content).some((warning) => /Z looks like numbers written with commas or symbols/.test(warning))).toBe(true);
  });

  test("comma decimals are pointed out", () => {
    const content = file((index) => `"${index},5"`);
    expect(warningsFor(content).some((warning) => /Z looks like numbers written with commas or symbols/.test(warning))).toBe(true);
  });

  test("real categories are not called numbers", () => {
    const warnings = warningsFor(file((index) => ["north", "south", "east"][index % 3]));
    expect(warnings.some((warning) => /numbers/.test(warning))).toBe(false);
  });

  test("a file with no rows says so", () => {
    expect(warningsFor("X,Y,Z\n").some((warning) => /header but no rows/.test(warning))).toBe(true);
    expect(warningsFor("").some((warning) => /No rows could be read/.test(warning))).toBe(true);
  });

  test("variables can have names in any script, and match their columns", () => {
    const chinese: GraphSpec = {
      nodes: ["教育", "收入", "年龄"].map((id) => ({ id, label: id, x: 0, y: 0 })),
      edges: [
        { id: "年龄->教育", source: "年龄", target: "教育" },
        { id: "年龄->收入", source: "年龄", target: "收入" },
        { id: "教育->收入", source: "教育", target: "收入" },
      ],
      treatmentId: "教育",
      outcomeId: "收入",
    };
    const result = analyze({ graph: chinese, dataset: { filename: "s.csv", content: file(() => "").replace("X,Y,Z", "教育,收入,年龄") } });
    expect(result.validation.canAnalyze).toBe(true);
    expect(result.dataDiagnostics!.variableBindings.every((binding) => binding.matched)).toBe(true);
    expect(result.effect!.estimate).not.toBeNull();
  });
});

describe("generated code", () => {
  const graph: GraphSpec = {
    nodes: ["X", "Y", "Z"].map((id) => ({ id, label: id, x: 0, y: 0 })),
    edges: [
      { id: "Z->X", source: "Z", target: "X" },
      { id: "Z->Y", source: "Z", target: "Y" },
      { id: "X->Y", source: "X", target: "Y" },
    ],
    treatmentId: "X",
    outcomeId: "Y",
  };

  test("a line break in a cell cannot start a line of code", () => {
    const rows = Array.from({ length: 100 }, (_, index) => {
      const z = Math.sin(index);
      return `"${z > 0 ? "yes\nrun_this()\n#" : "control"}",${(z + index / 100).toFixed(3)},${z.toFixed(3)}`;
    });
    const { codeSnippets } = analyze({ graph, dataset: { filename: "s.csv", content: ["X,Y,Z", ...rows].join("\n") } });
    expect(codeSnippets.length).toBeGreaterThan(0);
    for (const snippet of codeSnippets) {
      expect(snippet.content.split("\n").some((line) => line.trim().startsWith("run_this"))).toBe(false);
    }
  });

  test("a quote in a column name cannot end the string in a formula", () => {
    const { codeSnippets } = analyze({
      graph,
      dataContext: { columnBindings: { Z: 'z"); run_this(); ("' } },
      dataset: { filename: "s.csv", content: 'X,Y,"z""); run_this(); ("""\n1,2,3\n0,1,2\n1,3,1\n0,2,2\n' },
    });
    const python = codeSnippets.find((snippet) => snippet.id === "python-statsmodels")!.content;
    expect(python).toContain("{col!r}");
    expect(python).not.toContain('Q("{col}")');
    const r = codeSnippets.find((snippet) => snippet.id === "r-template")!.content;
    expect(r).toContain("gsub");
  });
});
