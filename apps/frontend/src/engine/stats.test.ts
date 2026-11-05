import type { GraphSpec } from "@causal-graph-workbench/shared";
import { describe, expect, test } from "vitest";

import { analyze } from "./analyze";
import { inferVariableType, toNumber } from "./data/table";
import golden from "./__fixtures__/golden.json";
import { conditioningBasis, holmAdjust, normalTwoSidedP, testConditionalIndependence } from "./stats/independence";
import { fitLogistic } from "./stats/logistic";
import { fitOls } from "./stats/ols";

interface LogisticCase {
  name: string;
  columns: string[];
  X: number[][];
  y: number[];
  params: number[];
  bse: number[];
  robustBse: number[];
  logLikelihood: number;
}

interface OlsCase {
  name: string;
  columns: string[];
  X: number[][];
  y: number[];
  params: number[];
  robustBse: number[];
}

interface GcmCase {
  name: string;
  a: number[];
  b: number[];
  condition: number[][];
  pValue: number;
  correlation: number;
}

const logisticCases = golden.logisticCases as LogisticCase[];
const diagnosticsCases = golden.diagnosticsCases as unknown as DiagnosticsCase[];

function toColumns(rows: number[][]): Float64Array[] {
  return rows[0].map((_, column) => Float64Array.from(rows, (row) => row[column]));
}

function expectClose(actual: number, expected: number, tolerance: number, label: string) {
  expect(Math.abs(actual - expected), `${label}: ${actual} vs ${expected}`).toBeLessThanOrEqual(tolerance);
}

describe("logistic regression against statsmodels", () => {
  test.each(logisticCases.map((item) => [item.name, item] as const))("%s", (_, item) => {
    const fit = fitLogistic({ columns: toColumns(item.X), y: Float64Array.from(item.y) });
    expect(fit.converged).toBe(true);
    expect(fit.droppedColumns).toEqual([]);
    expect(fit.separationSuspected).toBe(false);
    item.params.forEach((value, index) => {
      const tolerance = 1e-6 * Math.max(1, Math.abs(value));
      expectClose(fit.params[index], value, tolerance, `param ${item.columns[index]}`);
      expectClose(fit.standardErrors[index], item.bse[index], 1e-5 * Math.max(1, Math.abs(item.bse[index])), `se ${item.columns[index]}`);
    });
    expectClose(fit.logLikelihood, item.logLikelihood, 1e-5, "log likelihood");
    const robust = fit.robustStandardErrors();
    item.robustBse.forEach((value, index) => {
      expectClose(robust[index], value, 1e-5 * Math.max(1, Math.abs(value)), `robust se ${item.columns[index]}`);
    });
  });

  test("a collinear column is dropped and the rest of the fit is unchanged", () => {
    const item = logisticCases[0];
    const columns = toColumns(item.X);
    const duplicate = Float64Array.from(columns[1], (value) => 2 * value + 3);
    const fit = fitLogistic({ columns: [...columns, duplicate], y: Float64Array.from(item.y) });
    expect(fit.droppedColumns).toEqual([columns.length]);
    item.params.forEach((value, index) => {
      expectClose(fit.params[index], value, 1e-6 * Math.max(1, Math.abs(value)), `param ${index}`);
    });
  });

  test("perfect separation is reported rather than returning a confident fit", () => {
    const predictor = Float64Array.from({ length: 40 }, (_, index) => index);
    const y = Float64Array.from(predictor, (value) => (value >= 20 ? 1 : 0));
    const fit = fitLogistic({ columns: [new Float64Array(40).fill(1), predictor], y });
    expect(fit.separationSuspected).toBe(true);
  });
});

describe("linear regression against statsmodels", () => {
  test.each((golden.olsCases as OlsCase[]).map((item) => [item.name, item] as const))("%s", (_, item) => {
    const fit = fitOls(toColumns(item.X), Float64Array.from(item.y));
    expect(fit.droppedColumns).toEqual([]);
    const robust = fit.robustStandardErrors();
    item.params.forEach((value, index) => {
      expectClose(fit.params[index], value, 1e-6 * Math.max(1, Math.abs(value)), `param ${item.columns[index]}`);
      expectClose(robust[index], item.robustBse[index], 1e-6 * Math.max(1, Math.abs(item.robustBse[index])), `robust se ${item.columns[index]}`);
    });
  });

  test("a collinear column is dropped", () => {
    const item = (golden.olsCases as OlsCase[])[0];
    const columns = toColumns(item.X);
    const fit = fitOls([...columns, Float64Array.from(columns[1], (value) => value * 3 - 1)], Float64Array.from(item.y));
    expect(fit.droppedColumns).toEqual([columns.length]);
    expectClose(fit.params[1], item.params[1], 1e-6, "param");
  });
});

describe("normal tail probabilities against scipy", () => {
  test.each(golden.normalTwoSided.map((item) => [item.z, item.p] as const))("z = %f", (z, expected) => {
    expect(Math.abs(normalTwoSidedP(z) - expected)).toBeLessThanOrEqual(1e-12 * Math.max(expected, 1e-300) + 1e-300);
    expect(normalTwoSidedP(-z)).toBeCloseTo(normalTwoSidedP(z), 15);
  });
});

describe("conditional independence test against the research prototype", () => {
  test.each((golden.gcmCases as GcmCase[]).map((item) => [item.name, item] as const))("%s", (_, item) => {
    const numeric = (values: number[]) => ({ kind: "numeric" as const, values: Float64Array.from(values) });
    const result = testConditionalIndependence([numeric(item.a)], [numeric(item.b)], item.condition.map(numeric), item.a.length);
    expect(Math.abs(result.pValue - item.pValue)).toBeLessThanOrEqual(1e-8 * Math.max(item.pValue, 1e-30));
    expectClose(result.correlation, item.correlation, 1e-8, "correlation");
  });

  test("a rich basis is cut down when there are few rows, curvature before main effects", () => {
    const rows = 40;
    const variables = Array.from({ length: 4 }, (_, offset) => ({
      kind: "numeric" as const,
      values: Float64Array.from({ length: rows }, (_, row) => Math.sin(row * (offset + 1))),
    }));
    expect(conditioningBasis(variables, rows, 5)).toHaveLength(5);
    expect(conditioningBasis(variables, rows, 13)).toHaveLength(13);
    expect(conditioningBasis(variables, rows, 100)).toHaveLength(1 + 4 + 8 + 8 + 6);
  });

  test("flags enter the basis once, with no curvature terms", () => {
    const flag = { kind: "flag" as const, values: Float64Array.from({ length: 10 }, (_, row) => row % 2) };
    expect(conditioningBasis([flag], 10, 100)).toHaveLength(2);
  });
});

describe("Holm adjustment", () => {
  test("matches a worked example and stays monotone", () => {
    expect(holmAdjust([0.01, 0.04, 0.03, 0.5])).toEqual([0.04, 0.09, 0.09, 0.5]);
    expect(holmAdjust([])).toEqual([]);
    expect(holmAdjust([0.9, 0.9])).toEqual([1, 1]);
  });
});

interface DiagnosticsCase {
  name: string;
  csv: string;
  treatment: string;
  outcome: string;
  edges: [string, string][];
  covariates: string[];
  expected: {
    balance: Record<string, number>;
    rowsUsed: number;
    propensity: null | {
      treatedRange: [number, number];
      controlRange: [number, number];
      treatedOutsideSupport: number;
      controlOutsideSupport: number;
      extremeShare: number;
    };
  };
}

function graphFor(item: DiagnosticsCase): GraphSpec {
  const ids = [...new Set(item.edges.flat())];
  return {
    nodes: ids.map((id) => ({ id, label: id, x: 0, y: 0 })),
    edges: item.edges.map(([source, target]) => ({ id: `${source}->${target}`, source, target })),
    treatmentId: item.treatment,
    outcomeId: item.outcome,
  };
}

describe("data diagnostics against pandas and statsmodels", () => {
  test.each(diagnosticsCases.map((item) => [item.name, item] as const))("%s", (_, item) => {
    const result = analyze({ graph: graphFor(item), dataset: { filename: "case.csv", content: item.csv } });
    const diagnostics = result.dataDiagnostics!;

    const metrics = Object.fromEntries(
      diagnostics.treatmentBalance!.metrics.map((metric) => [metric.columnName, metric.standardizedDifference]),
    );
    expect(Object.keys(metrics).sort()).toEqual(Object.keys(item.expected.balance).sort());
    for (const [label, value] of Object.entries(item.expected.balance)) {
      expectClose(metrics[label]!, value, 1e-6, `SMD ${label}`);
    }

    const overlap = diagnostics.overlapDiagnostics!;
    if (item.expected.propensity === null) {
      expect(overlap.propensity).toBeNull();
      return;
    }
    const propensity = overlap.propensity!;
    expect(propensity.rowsUsed).toBe(item.expected.rowsUsed);
    expectClose(propensity.treatedRange[0], item.expected.propensity.treatedRange[0], 1e-4, "treated min");
    expectClose(propensity.treatedRange[1], item.expected.propensity.treatedRange[1], 1e-4, "treated max");
    expectClose(propensity.controlRange[0], item.expected.propensity.controlRange[0], 1e-4, "control min");
    expectClose(propensity.controlRange[1], item.expected.propensity.controlRange[1], 1e-4, "control max");
    // The fixture rounds these shares to 8 decimal places.
    expectClose(propensity.treatedOutsideSupport, item.expected.propensity.treatedOutsideSupport, 1e-7, "treated outside");
    expectClose(propensity.controlOutsideSupport, item.expected.propensity.controlOutsideSupport, 1e-7, "control outside");
    expectClose(propensity.extremeShare, item.expected.propensity.extremeShare, 1e-7, "extreme share");
  });

  test("near-perfect separation produces a warning, which the old range check could not", () => {
    const item = diagnosticsCases.find((entry) => entry.name.startsWith("near-perfect"))!;
    const result = analyze({ graph: graphFor(item), dataset: { filename: "case.csv", content: item.csv } });
    const overlap = result.dataDiagnostics!.overlapDiagnostics!;
    expect(overlap.warnings.length).toBeGreaterThan(0);
    expect(overlap.propensity!.extremeShare).toBeGreaterThan(0.5);
  });
});

describe("balance only looks at the adjustment set", () => {
  const graph: GraphSpec = {
    nodes: ["treatment_status", "outcome_score", "baseline_risk", "after"].map((id) => ({ id, label: id, x: 0, y: 0 })),
    edges: [
      ["baseline_risk", "treatment_status"],
      ["baseline_risk", "outcome_score"],
      ["treatment_status", "outcome_score"],
      ["treatment_status", "after"],
    ].map(([source, target]) => ({ id: `${source}->${target}`, source, target })),
    treatmentId: "treatment_status",
    outcomeId: "outcome_score",
  };
  const csv = [
    "treatment_status,outcome_score,baseline_risk,after,unrelated",
    ...Array.from({ length: 30 }, (_, index) => {
      const treated = index % 2;
      return `${treated},${10 + treated * 3 + index / 10},${0.4 + treated * 0.2 + (index % 7) / 40},${treated + index / 50},${index}`;
    }),
  ].join("\n");

  test("the outcome, post-treatment columns and unrelated columns are excluded", () => {
    const result = analyze({ graph, dataset: { filename: "demo.csv", content: csv } });
    const balance = result.dataDiagnostics!.treatmentBalance!;
    expect(result.recommendedAdjustmentSet).toEqual(["baseline_risk"]);
    expect(balance.metrics.map((metric) => metric.columnName)).toEqual(["baseline_risk"]);
    expect(balance.metrics[0].imbalanced).toBe(true);
    expect(balance.treatedLabel).toBe("1");
  });
});

describe("csv parsing and type inference", () => {
  test("quoted delimiters and newlines stay inside one field", () => {
    const result = analyze({
      graph: {
        nodes: [
          { id: "t", label: "t", x: 0, y: 0 },
          { id: "y", label: "y", x: 0, y: 0 },
        ],
        edges: [{ id: "t->y", source: "t", target: "y" }],
        treatmentId: "t",
        outcomeId: "y",
      },
      dataset: { content: 't,y,note\n1,2,"a, b"\n0,3,"line\nbreak"\n' },
    });
    expect(result.dataDiagnostics!.rowCount).toBe(2);
    expect(result.dataDiagnostics!.columnCount).toBe(3);
  });

  test("semicolon files and byte-order marks are handled", () => {
    const result = analyze({
      graph: {
        nodes: [
          { id: "t", label: "t", x: 0, y: 0 },
          { id: "y", label: "y", x: 0, y: 0 },
        ],
        edges: [{ id: "t->y", source: "t", target: "y" }],
        treatmentId: "t",
        outcomeId: "y",
      },
      dataset: { content: "﻿t;y\n1;2\n0;3\n" },
    });
    expect(result.dataDiagnostics!.variableBindings.every((binding) => binding.matched)).toBe(true);
  });

  test("numeric parsing rejects what Number() would wrongly accept", () => {
    expect(toNumber("")).toBeNull();
    expect(toNumber(" ")).toBeNull();
    expect(toNumber("0x10")).toBeNull();
    expect(toNumber("Infinity")).toBeNull();
    expect(toNumber("1e-3")).toBe(0.001);
    expect(toNumber(" -2.5 ")).toBe(-2.5);
  });

  test("types follow the documented rules", () => {
    expect(inferVariableType(["1", "0", "1"])).toBe("binary");
    expect(inferVariableType(["1.0", "0.0"])).toBe("binary");
    expect(inferVariableType(["treated", "control"])).toBe("binary");
    expect(inferVariableType(["A", "B"])).toBe("binary");
    expect(inferVariableType(["A", "B", "C"])).toBe("categorical");
    expect(inferVariableType(["1", "2", "3"])).toBe("continuous");
    expect(inferVariableType([])).toBe("unknown");
  });
});
