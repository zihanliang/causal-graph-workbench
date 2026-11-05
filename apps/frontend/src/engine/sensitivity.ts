import type { EValueSummary, RobustnessSummary, SensitivityBenchmark } from "@causal-graph-workbench/shared";

import { CI_MULTIPLIER, linearDesign, sampleStandardDeviation, type EffectContext, type EffectFit } from "./effect";
import { dot } from "./stats/linalg";
import { fitOls } from "./stats/ols";
import { studentTQuantile } from "./stats/studentT";

/**
 * How strong something unmeasured would have to be to change the conclusion. Every formula here follows a
 * published method and is checked against its reference implementation in `sensitivity.test.ts`:
 *
 * - AIPW: Chernozhukov, Cinelli, Newey, Sharma and Syrgkanis (2022), against DoubleML.
 * - Linear regression: Cinelli and Hazlett (2020), against the R package sensemakr. Those formulas use the
 *   classical standard error, as sensemakr does, even though the app reports a robust one.
 * - E-values: VanderWeele and Ding (2017), against the R package EValue.
 */

/** A treatment share at or above 1 has no meaning, and would make the bound infinite. */
const MAX_TREATMENT_SHARE = 0.999;
/** Below this prevalence an odds ratio approximates a risk ratio. Above it, its square root does. */
const RARE_OUTCOME_PREVALENCE = 0.15;
/** Conversion of a standardized difference to a risk ratio, from VanderWeele and Ding (2017). */
const SMD_TO_LOG_RR = 0.91;
const SMD_SE_TO_LOG_RR = 1.78;

// ---------------------------------------------------------------------------
// E-values
// ---------------------------------------------------------------------------

function eValueOfRiskRatio(riskRatio: number): number {
  const away = riskRatio < 1 ? 1 / riskRatio : riskRatio;
  return away + Math.sqrt(away * (away - 1));
}

function summarizeEValue(
  basis: EValueSummary["basis"],
  contrast: EValueSummary["contrast"],
  riskRatio: number,
  riskRatioLow: number,
  riskRatioHigh: number,
): EValueSummary {
  const includesNull = riskRatioLow <= 1 && riskRatioHigh >= 1;
  const nearer = riskRatio >= 1 ? riskRatioLow : riskRatioHigh;
  return {
    basis,
    contrast,
    riskRatio,
    riskRatioLow,
    riskRatioHigh,
    point: eValueOfRiskRatio(riskRatio),
    interval: includesNull ? 1 : eValueOfRiskRatio(nearer),
  };
}

function standardizedEValue(difference: number, standardError: number, contrast: EValueSummary["contrast"]): EValueSummary {
  return summarizeEValue(
    "standardized_difference",
    contrast,
    Math.exp(SMD_TO_LOG_RR * difference),
    Math.exp(SMD_TO_LOG_RR * difference - SMD_SE_TO_LOG_RR * standardError),
    Math.exp(SMD_TO_LOG_RR * difference + SMD_SE_TO_LOG_RR * standardError),
  );
}

export function computeEValue(fit: EffectFit, context: EffectContext): EValueSummary | null {
  const summary = eValueOf(fit, context);
  return summary && Number.isFinite(summary.point) && Number.isFinite(summary.interval) ? summary : null;
}

function eValueOf(fit: EffectFit, context: EffectContext): EValueSummary | null {
  const design = linearDesign(context, [], fit.rows);
  if (!design) {
    return null;
  }
  const { t, y } = design;

  if (fit.method === "aipw") {
    if (!fit.outcomeIsBinary) {
      const sd = sampleStandardDeviation(y);
      return sd > 0 ? standardizedEValue(fit.estimate / sd, fit.standardError / sd, "treated_vs_untreated") : null;
    }
    const detail = fit.detail;
    if (!detail || !(detail.treatedMean > 0) || !(detail.controlMean > 0)) {
      return null;
    }
    const logInfluence = Float64Array.from(
      detail.treatedInfluence,
      (value, row) => value / detail.treatedMean - detail.controlInfluence[row] / detail.controlMean,
    );
    const logRatio = Math.log(detail.treatedMean / detail.controlMean);
    const halfWidth = (CI_MULTIPLIER * sampleStandardDeviation(logInfluence)) / Math.sqrt(logInfluence.length);
    return summarizeEValue("risk_ratio", "treated_vs_untreated", Math.exp(logRatio), Math.exp(logRatio - halfWidth), Math.exp(logRatio + halfWidth));
  }

  // A numeric treatment has no natural contrast, so the E-value would change with its units. One SD does not.
  const sdTreatment = sampleStandardDeviation(t);
  if (!(sdTreatment > 0)) {
    return null;
  }
  if (fit.method === "ols") {
    const sdOutcome = sampleStandardDeviation(y);
    return sdOutcome > 0
      ? standardizedEValue((fit.estimate * sdTreatment) / sdOutcome, (fit.standardError * sdTreatment) / sdOutcome, "one_sd_of_treatment")
      : null;
  }
  const prevalence = y.reduce((total, value) => total + value, 0) / y.length;
  const isRare = prevalence < RARE_OUTCOME_PREVALENCE;
  const toRiskRatio = (logOdds: number) => Math.exp(isRare ? logOdds * sdTreatment : (logOdds * sdTreatment) / 2);
  return summarizeEValue(
    isRare ? "odds_ratio_rare" : "odds_ratio_common",
    "one_sd_of_treatment",
    toRiskRatio(fit.estimate),
    toRiskRatio(fit.estimate - CI_MULTIPLIER * fit.standardError),
    toRiskRatio(fit.estimate + CI_MULTIPLIER * fit.standardError),
  );
}

// ---------------------------------------------------------------------------
// The robustness value and its benchmarks
// ---------------------------------------------------------------------------

/** The equal share c at which c^2 / (1 - c) reaches `f` squared. */
function robustnessValueOf(f: number): number {
  return f > 0 ? 2 / (1 + Math.sqrt(1 + 4 / (f * f))) : 0;
}

function strengthOf(treatmentShare: number, outcomeShare: number): number {
  const treatment = Math.min(treatmentShare, MAX_TREATMENT_SHARE);
  return Math.sqrt((outcomeShare * treatment) / (1 - treatment));
}

/** A comparison that came out as NaN, for instance from a variable that does not vary, is no comparison. */
function finiteBenchmark(benchmark: SensitivityBenchmark): SensitivityBenchmark | null {
  return Number.isFinite(benchmark.shareOfEstimate) && Number.isFinite(benchmark.treatmentShare) && Number.isFinite(benchmark.outcomeShare) ? benchmark : null;
}

function clip(value: number, low: number, high: number): number {
  return Math.min(high, Math.max(low, value));
}

export interface RobustnessStart {
  summary: RobustnessSummary;
  /** Compares one variable in the current set. Needs a fit without it when the estimate is AIPW. */
  benchmark: (variable: string, withoutIt: EffectFit | null) => SensitivityBenchmark | null;
}

/** The share at which the interval reaches zero, from the per-row contributions to the estimate and the bound. */
function aipwIntervalValue(fit: EffectFit, scale: number): number {
  const { detail, bound } = fit;
  if (!detail || !bound) {
    return 0;
  }
  const count = fit.influence.length;
  const direction = fit.estimate >= 0 ? 1 : -1;
  const scaleInfluence = new Float64Array(count);
  for (let row = 0; row < count; row += 1) {
    scaleInfluence[row] = (bound.sigma2 * (detail.nuElements[row] - bound.nu2) + bound.nu2 * (detail.sigmaElements[row] - bound.sigma2)) / (2 * scale);
  }
  const lowerEnd = (share: number): number => {
    const strength = share / Math.sqrt(1 - share);
    const contribution = Float64Array.from(fit.influence, (value, row) => direction * value - strength * scaleInfluence[row]);
    return direction * fit.estimate - strength * scale - (CI_MULTIPLIER * sampleStandardDeviation(contribution)) / Math.sqrt(count);
  };
  if (lowerEnd(0) <= 0) {
    return 0;
  }
  let low = 0;
  let high = 0.9999;
  if (lowerEnd(high) > 0) {
    return high;
  }
  for (let i = 0; i < 60 && high - low > 1e-9; i += 1) {
    const middle = (low + high) / 2;
    if (lowerEnd(middle) > 0) {
      low = middle;
    } else {
      high = middle;
    }
  }
  return (low + high) / 2;
}

function startAipw(fit: EffectFit): RobustnessStart | null {
  const { bound } = fit;
  if (!bound || !(bound.sigma2 > 0) || !(bound.nu2 > 0)) {
    return null;
  }
  const scale = Math.sqrt(bound.sigma2 * bound.nu2);
  if (!Number.isFinite(scale)) {
    return null;
  }
  const f = Math.abs(fit.estimate) / scale;
  return {
    summary: {
      basis: "aipw",
      value: robustnessValueOf(f),
      valueForInterval: aipwIntervalValue(fit, scale),
      ratio: f * f,
      benchmarks: [],
      benchmarksComplete: true,
    },
    benchmark: (variable, withoutIt) => {
      if (!withoutIt?.bound || !(withoutIt.bound.nu2 > 0) || !(bound.sigma2 > 0)) {
        return null;
      }
      // DoubleML's gain statistics: what this variable adds, relative to the model that already has it.
      const treatmentShare = clip((bound.nu2 - withoutIt.bound.nu2) / withoutIt.bound.nu2, 0, 1);
      const outcomeShare = clip((withoutIt.bound.sigma2 - bound.sigma2) / bound.sigma2, 0, 1);
      return finiteBenchmark({ variable, treatmentShare, outcomeShare, shareOfEstimate: (strengthOf(treatmentShare, outcomeShare) * scale) / Math.abs(fit.estimate) });
    },
  };
}

function residualSum(columns: Float64Array[], target: Float64Array): number {
  const { residuals } = fitOls(columns, target);
  return dot(residuals, residuals);
}

function startLinear(fit: EffectFit, context: EffectContext, covariates: string[]): RobustnessStart | null {
  const design = linearDesign(context, covariates, fit.rows);
  if (!design) {
    return null;
  }
  const { t, y, termsOf } = design;
  const intercept = new Float64Array(t.length).fill(1);
  const terms = (nodes: string[]) => nodes.flatMap((node) => termsOf.get(node) ?? []);
  const allTerms = [intercept, ...terms(covariates)];

  // With the treatment's partial coefficient, by the Frisch-Waugh-Lovell theorem.
  const outcomeFit = fitOls([intercept, t, ...terms(covariates)], y);
  if (!outcomeFit.keptColumns.includes(1)) {
    return null;
  }
  const estimate = outcomeFit.params[outcomeFit.keptColumns.indexOf(1)];
  const dof = t.length - outcomeFit.keptColumns.length;
  const treatmentResiduals = fitOls(allTerms, t).residuals;
  const treatmentVariation = dot(treatmentResiduals, treatmentResiduals);
  const outcomeResidualSum = dot(outcomeFit.residuals, outcomeFit.residuals);
  if (dof < 2 || !(treatmentVariation > 0) || !(outcomeResidualSum > 0) || !Number.isFinite(outcomeResidualSum) || !Number.isFinite(treatmentVariation)) {
    return null;
  }
  const standardError = Math.sqrt(outcomeResidualSum / dof / treatmentVariation);
  const tValue = estimate / standardError;
  const f = Math.abs(tValue) / Math.sqrt(dof);

  // sensemakr's robustness_value with alpha = 0.05, including its "extreme" case.
  const critical = studentTQuantile(0.975, dof - 1) / Math.sqrt(dof - 1);
  const gap = f - critical;
  let valueForInterval = 0;
  if (gap > 0) {
    valueForInterval = f > 1 / critical ? (f * f - critical * critical) / (1 + f * f) : robustnessValueOf(gap);
  }

  const scale = standardError * Math.sqrt(dof);
  return {
    summary: {
      basis: fit.method === "logistic" ? "linear_probability" : "linear",
      value: robustnessValueOf(f),
      valueForInterval,
      ratio: f * f,
      benchmarks: [],
      benchmarksComplete: true,
    },
    benchmark: (variable) => {
      const others = terms(covariates.filter((node) => node !== variable));
      const treatmentBefore = residualSum([intercept, ...others], t);
      const outcomeBefore = residualSum([intercept, t, ...others], y);
      const r2Treatment = treatmentBefore > 0 ? clip((treatmentBefore - treatmentVariation) / treatmentBefore, 0, 0.999999) : 0;
      const r2Outcome = outcomeBefore > 0 ? clip((outcomeBefore - outcomeResidualSum) / outcomeBefore, 0, 0.999999) : 0;

      // sensemakr's ovb_partial_r2_bound with kd = ky = 1.
      const treatmentShare = clip(r2Treatment / (1 - r2Treatment), 0, 1);
      const gain = (r2Treatment * r2Treatment) / ((1 - r2Treatment) * (1 - r2Treatment));
      const outcomeShare =
        gain >= 1 ? 1 : clip(((1 + Math.sqrt(gain)) ** 2 / (1 - gain)) * (r2Outcome / (1 - r2Outcome)), 0, 1);
      return finiteBenchmark({ variable, treatmentShare, outcomeShare, shareOfEstimate: (strengthOf(treatmentShare, outcomeShare) * scale) / Math.abs(estimate) });
    },
  };
}

export function startRobustness(fit: EffectFit, context: EffectContext, covariates: string[]): RobustnessStart | null {
  return fit.method === "aipw" ? startAipw(fit) : startLinear(fit, context, covariates);
}
