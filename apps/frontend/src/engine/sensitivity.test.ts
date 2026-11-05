import type { Estimand, VariableType } from "@causal-graph-workbench/shared";
import { describe, expect, test } from "vitest";

import { analyze } from "./analyze";
import { inferVariableType, isMissing, parseDataset, type DataTable } from "./data/table";
import { fitEffect, type EffectContext } from "./effect";
import { computeEValue, startRobustness } from "./sensitivity";
import { studentTQuantile } from "./stats/studentT";
import golden from "./__fixtures__/sensitivity.json";

/** Every expected value here comes from DoubleML, sensemakr or EValue. See generate_sensitivity_golden.py. */
interface Case {
  name: string;
  kind: "aipw" | "linear";
  csv: string;
  treatment: string;
  outcome: string;
  covariates: string[];
  estimand: Estimand;
  expected: {
    estimate: number;
    value: number;
    valueForInterval: number;
    sigma2?: number;
    nu2?: number;
    standardError?: number;
    dof?: number;
    benchmarks: Record<string, { treatmentShare: number; outcomeShare: number; adjustedEstimate?: number }>;
    evalue: { riskRatio: number; riskRatioLow: number; riskRatioHigh: number; point: number; interval: number; rare?: boolean };
  };
}

const cases = golden.cases as unknown as Case[];
const aipwCases = cases.filter((item) => item.kind === "aipw");
const linearCases = cases.filter((item) => item.kind === "linear");
/** DoubleML finds its robustness values with a bounded numeric search, which stops at about this precision. */
const SEARCH_TOLERANCE = 1e-3;

function typeOf(table: DataTable, column: string): VariableType {
  return inferVariableType(table.columns.get(column)!.filter((value) => !isMissing(value)));
}

function contextFor(item: Case): EffectContext {
  const table = parseDataset({ content: item.csv });
  const bound = (column: string) => ({ column, type: typeOf(table, column) });
  return {
    table,
    treatment: bound(item.treatment),
    outcome: bound(item.outcome),
    estimand: item.estimand,
    columnOf: (node) => (table.columns.has(node) ? bound(node) : null),
  };
}

function setUp(item: Case) {
  const context = contextFor(item);
  const outcome = fitEffect(context, item.covariates, [], { detail: true });
  if (!outcome.ok) {
    throw new Error(outcome.reason);
  }
  const start = startRobustness(outcome.fit, context, item.covariates);
  if (!start) {
    throw new Error("No robustness result");
  }
  return { context, fit: outcome.fit, start };
}

describe("student t quantile, against scipy", () => {
  test.each(golden.tQuantiles.map((item) => [item.p, item.df, item.value] as const))("p = %f, df = %f", (p, df, value) => {
    expect(studentTQuantile(p, df)).toBeCloseTo(value, 6);
  });
});

describe("AIPW bound, against DoubleML given the same predictions", () => {
  test.each(aipwCases.map((item) => [item.name, item] as const))("%s", (_, item) => {
    const { context, fit, start } = setUp(item);
    expect(fit.estimate).toBeCloseTo(item.expected.estimate, 6);
    expect(fit.bound!.sigma2).toBeCloseTo(item.expected.sigma2!, 6);
    expect(fit.bound!.nu2).toBeCloseTo(item.expected.nu2!, 6);
    expect(Math.abs(start.summary.value - item.expected.value)).toBeLessThan(SEARCH_TOLERANCE);
    expect(Math.abs(start.summary.valueForInterval - item.expected.valueForInterval)).toBeLessThan(SEARCH_TOLERANCE);

    for (const variable of item.covariates) {
      const short = fitEffect(context, item.covariates.filter((node) => node !== variable), item.covariates);
      if (!short.ok) {
        throw new Error(short.reason);
      }
      const benchmark = start.benchmark(variable, short.fit)!;
      expect(benchmark.treatmentShare).toBeCloseTo(item.expected.benchmarks[variable].treatmentShare, 6);
      expect(benchmark.outcomeShare).toBeCloseTo(item.expected.benchmarks[variable].outcomeShare, 6);
    }
  });
});

describe("the interval value, where DoubleML's reported number is not used", () => {
  // DoubleML 0.11.4 gives the bound's standard error the wrong sign relative to the estimate's. The generator
  // shows that this is the only difference and that a bootstrap supports the corrected sign. See interval_value.
  test("the correction matters in at least one case, so this test can tell the two apart", () => {
    const gaps = aipwCases.map((item) => Math.abs(item.expected.valueForInterval - (item.expected as unknown as { doubleMLValueForInterval: number }).doubleMLValueForInterval));
    expect(Math.max(...gaps)).toBeGreaterThan(SEARCH_TOLERANCE);
  });
});

describe("linear bound, against sensemakr", () => {
  test.each(linearCases.map((item) => [item.name, item] as const))("%s", (_, item) => {
    const { fit, start } = setUp(item);
    expect(start.summary.value).toBeCloseTo(item.expected.value, 8);
    expect(start.summary.valueForInterval).toBeCloseTo(item.expected.valueForInterval, 8);
    expect(start.summary.ratio).toBeCloseTo(item.expected.estimate ** 2 / (item.expected.standardError! ** 2 * item.expected.dof!), 8);

    for (const variable of item.covariates) {
      const benchmark = start.benchmark(variable, null)!;
      const expected = item.expected.benchmarks[variable];
      expect(benchmark.treatmentShare).toBeCloseTo(expected.treatmentShare, 8);
      expect(benchmark.outcomeShare).toBeCloseTo(expected.outcomeShare, 8);
      // sensemakr's adjusted estimate is the estimate reduced by exactly the bias this share describes.
      const reduced = 1 - Math.abs(expected.adjustedEstimate!) / Math.abs(item.expected.estimate);
      if (Math.sign(expected.adjustedEstimate!) === Math.sign(item.expected.estimate)) {
        expect(benchmark.shareOfEstimate).toBeCloseTo(reduced, 8);
      } else {
        expect(benchmark.shareOfEstimate).toBeGreaterThanOrEqual(1);
      }
    }
    expect(fit.method === "logistic" ? start.summary.basis === "linear_probability" : start.summary.basis === "linear").toBe(true);
  });

  test("the extreme case of the robustness value is exercised", () => {
    const item = linearCases.find((entry) => entry.name.includes("few rows"))!;
    expect(item.expected.valueForInterval).toBeGreaterThan(0.5);
  });

  test("an interval that already includes zero needs no confounding at all", () => {
    const item = linearCases.find((entry) => entry.name.includes("includes zero"))!;
    expect(item.expected.valueForInterval).toBe(0);
    expect(setUp(item).start.summary.valueForInterval).toBe(0);
  });
});

describe("E-values, against the EValue package", () => {
  test.each(cases.map((item) => [item.name, item] as const))("%s", (_, item) => {
    const { context, fit } = setUp(item);
    const evalue = computeEValue(fit, context)!;
    expect(evalue.riskRatio).toBeCloseTo(item.expected.evalue.riskRatio, 6);
    expect(evalue.riskRatioLow).toBeCloseTo(item.expected.evalue.riskRatioLow, 6);
    expect(evalue.riskRatioHigh).toBeCloseTo(item.expected.evalue.riskRatioHigh, 6);
    expect(evalue.point).toBeCloseTo(item.expected.evalue.point, 6);
    expect(evalue.interval).toBeCloseTo(item.expected.evalue.interval, 6);
    if (item.expected.evalue.rare !== undefined) {
      expect(evalue.basis).toBe(item.expected.evalue.rare ? "odds_ratio_rare" : "odds_ratio_common");
    }
  });

  test("a treatment with two values is read as treated against untreated, a numeric one per SD", () => {
    const binary = aipwCases[0];
    const numeric = linearCases[0];
    expect(computeEValue(setUp(binary).fit, contextFor(binary))!.contrast).toBe("treated_vs_untreated");
    expect(computeEValue(setUp(numeric).fit, contextFor(numeric))!.contrast).toBe("one_sd_of_treatment");
  });
});

describe("in the full analysis", () => {
  const item = aipwCases[0];
  const request = {
    graph: {
      nodes: ["t", "y", "z", "w", "site"].map((id) => ({ id, label: id, x: 0, y: 0 })),
      edges: [
        ["z", "t"],
        ["z", "y"],
        ["w", "t"],
        ["w", "y"],
        ["site", "t"],
        ["site", "y"],
        ["t", "y"],
      ].map(([source, target]) => ({ id: `${source}->${target}`, source, target })),
      treatmentId: "t",
      outcomeId: "y",
    },
    dataset: { filename: "s.csv", content: item.csv },
  };

  test("the result carries the bound, the E-value and a benchmark for every adjusted variable", () => {
    const { sensitivity, effect } = analyze(request);
    expect(sensitivity!.status).toBe("complete");
    expect(sensitivity!.robustness!.basis).toBe("aipw");
    expect(Math.abs(sensitivity!.robustness!.value - item.expected.value)).toBeLessThan(SEARCH_TOLERANCE);
    expect(sensitivity!.robustness!.benchmarks.map((benchmark) => benchmark.variable).sort()).toEqual(["site", "w", "z"]);
    expect(sensitivity!.robustness!.benchmarksComplete).toBe(true);
    expect(sensitivity!.evalue!.point).toBeCloseTo(item.expected.evalue.point, 6);
    expect(effect!.estimate!.estimate).toBeCloseTo(item.expected.estimate, 6);
  });

  test("benchmarks are listed strongest first", () => {
    const shares = analyze(request).sensitivity!.robustness!.benchmarks.map((benchmark) => benchmark.shareOfEstimate);
    expect(shares).toEqual([...shares].sort((left, right) => right - left));
  });

  test("the curve passes through the robustness value", () => {
    const { value, ratio } = analyze(request).sensitivity!.robustness!;
    expect((ratio * (1 - value)) / value).toBeCloseTo(value, 8);
  });

  test("without data there is nothing to bound", () => {
    expect(analyze({ graph: request.graph }).sensitivity).toBeNull();
  });
});
