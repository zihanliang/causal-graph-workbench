import type { Estimand, VariableType } from "@causal-graph-workbench/shared";
import { describe, expect, test } from "vitest";

import { inferVariableType, isMissing, parseDataset, type DataTable } from "./data/table";
import { fitEffect, shiftStandardError, type EffectContext } from "./effect";
import golden from "./__fixtures__/golden.json";

interface EffectCase {
  name: string;
  csv: string;
  treatment: string;
  outcome: string;
  covariates: string[];
  estimand: Estimand;
  method: string;
  expected: { estimate: number; standardError: number; rowsUsed: number };
}

const effectCases = golden.effectCases as unknown as EffectCase[];

function typeOf(table: DataTable, column: string): VariableType {
  return inferVariableType(table.columns.get(column)!.filter((value) => !isMissing(value)));
}

function contextFor(csv: string, treatment: string, outcome: string, estimand: Estimand = "ate"): EffectContext {
  const table = parseDataset({ content: csv });
  const bound = (column: string) => ({ column, type: typeOf(table, column) });
  return {
    table,
    treatment: bound(treatment),
    outcome: bound(outcome),
    estimand,
    columnOf: (node) => (table.columns.has(node) ? bound(node) : null),
  };
}

function simulated(rows: number, write: (index: number) => string, header: string): string {
  return [header, ...Array.from({ length: rows }, (_, index) => write(index))].join("\n");
}

describe("effect estimates against an independent statsmodels calculation", () => {
  test.each(effectCases.map((item) => [item.name, item] as const))("%s", (_, item) => {
    const outcome = fitEffect(contextFor(item.csv, item.treatment, item.outcome, item.estimand), item.covariates);
    if (!outcome.ok) {
      throw new Error(outcome.reason);
    }
    const { fit } = outcome;
    expect(fit.method).toBe(item.method);
    expect(fit.rows.length).toBe(item.expected.rowsUsed);
    expect(Math.abs(fit.estimate - item.expected.estimate)).toBeLessThan(1e-6);
    expect(Math.abs(fit.standardError - item.expected.standardError)).toBeLessThan(1e-6);
  });
});

describe("what an estimate reports", () => {
  const csv = simulated(
    200,
    (index) => {
      const z = ((index * 37) % 100) / 50 - 1;
      const t = (index * 13) % 7 < 3 + 2 * z ? 1 : 0;
      return `${t},${(2 * t + z + ((index * 17) % 11) / 11).toFixed(4)},${z.toFixed(3)}`;
    },
    "t,y,z",
  );

  test("influence values have mean zero and reproduce the standard error", () => {
    const outcome = fitEffect(contextFor(csv, "t", "y"), ["z"]);
    if (!outcome.ok) {
      throw new Error(outcome.reason);
    }
    const { influence, standardError, rows } = outcome.fit;
    const mean = influence.reduce((total, value) => total + value, 0) / influence.length;
    expect(Math.abs(mean)).toBeLessThan(1e-9);
    const variance = influence.reduce((total, value) => total + value * value, 0) / (influence.length - 1);
    expect(Math.sqrt(variance / rows.length)).toBeCloseTo(standardError, 8);
  });

  test("comparing a fit with itself shows no shift", () => {
    const outcome = fitEffect(contextFor(csv, "t", "y"), ["z"]);
    if (!outcome.ok) {
      throw new Error(outcome.reason);
    }
    expect(shiftStandardError(outcome.fit, outcome.fit)).toBe(0);
  });

  test("alsoComplete restricts both fits to the same rows", () => {
    const withGaps = simulated(
      100,
      (index) => `${index % 2},${index / 10},${index % 7},${index % 5 === 0 ? "" : index % 3}`,
      "t,y,z,w",
    );
    const context = contextFor(withGaps, "t", "y");
    const narrow = fitEffect(context, ["z"]);
    const paired = fitEffect(context, ["z"], ["w"]);
    expect(narrow.ok && narrow.fit.rows.length).toBe(100);
    expect(paired.ok && paired.fit.rows.length).toBe(80);
  });
});

describe("when an effect cannot be estimated", () => {
  const reason = (csv: string, treatment: string, outcome: string, covariates: string[] = []) => {
    const result = fitEffect(contextFor(csv, treatment, outcome), covariates);
    return result.ok ? null : result.reason;
  };

  test("a multi-category treatment or outcome", () => {
    expect(reason("t,y\na,1\nb,2\nc,3\na,4\n", "t", "y")).toMatch(/numeric or have exactly two values/);
    expect(reason("t,y\n1,a\n0,b\n1,c\n0,a\n", "t", "y")).toMatch(/numeric or have exactly two values/);
  });

  test("a treatment group left empty by missing values", () => {
    expect(reason("t,y,z\n1,1,5\n1,2,6\n1,3,7\n0,4,\n0,5,\n", "t", "y", ["z"])).toMatch(/only one treatment group/);
  });

  test("too few rows for the model", () => {
    expect(reason("t,y,z\n1,1,5\n0,2,6\n1,3,7\n0,4,9\n", "t", "y", ["z"])).toMatch(/too few to fit/);
  });

  test("a variable with no column", () => {
    expect(reason("t,y\n1,2\n0,3\n1,4\n0,5\n", "t", "y", ["nothere"])).toMatch(/no column/);
  });

  test("a category with too many levels", () => {
    const csv = simulated(200, (index) => `${index % 2},${index},id${index}`, "t,y,person");
    expect(reason(csv, "t", "y", ["person"])).toMatch(/too many to adjust/);
  });
});
