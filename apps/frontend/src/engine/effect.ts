import type { EffectEstimate, EffectMethod, Estimand, VariableType } from "@causal-graph-workbench/shared";

import { binaryValues, completeRows, expandColumn, takeRows, type CovariateTerm } from "./data/design";
import { inferBinaryLabels, type DataTable } from "./data/table";
import { fitLogistic } from "./stats/logistic";
import { fitOls } from "./stats/ols";

/** Must stay in step with the generated code, so that its script reproduces the number shown in the app. */
export const CI_MULTIPLIER = 1.959964;
export const PROPENSITY_FLOOR = 0.01;
export const PROPENSITY_CEILING = 0.99;
const MAX_CATEGORY_LEVELS = 30;
/** Squaring anything larger would overflow, and everything downstream squares. */
const MAX_MAGNITUDE = 1e100;
const CLIPPED_WARNING_SHARE = 0.1;

export interface BoundColumn {
  column: string;
  type: VariableType;
}

export interface EffectContext {
  table: DataTable;
  treatment: BoundColumn;
  outcome: BoundColumn;
  estimand: Estimand;
  /** The column behind a graph variable, or null when it is not in the file. */
  columnOf: (node: string) => BoundColumn | null;
}

export interface EffectFit {
  method: EffectMethod;
  estimand: Estimand | null;
  scale: EffectEstimate["scale"];
  outcomeIsBinary: boolean;
  estimate: number;
  standardError: number;
  /** Rows used, as indexes into the table. */
  rows: number[];
  /** Mean-zero per-row contribution to the estimate. Comparing two fits on the same rows uses these. */
  influence: Float64Array;
  warnings: string[];
  adjustmentSet: string[];
  /** AIPW only: the two parts of the omitted-variable bound. See sensitivity.ts. */
  bound: { sigma2: number; nu2: number } | null;
  /** Only when asked for, because these are large and fits are cached. */
  detail: AipwDetail | null;
}

/** Per-row values behind an AIPW fit, for a standard error on the bound and for a risk ratio. */
export interface AipwDetail {
  sigmaElements: Float64Array;
  nuElements: Float64Array;
  treatedMean: number;
  controlMean: number;
  treatedInfluence: Float64Array;
  controlInfluence: Float64Array;
}

export interface FitOptions {
  /** Keep the per-row values that sensitivity analysis needs. */
  detail?: boolean;
}

export type FitOutcome = { ok: true; fit: EffectFit } | { ok: false; reason: string };

function unavailable(reason: string): FitOutcome {
  return { ok: false, reason };
}

function numericValues(bound: BoundColumn, table: DataTable): Float64Array {
  return expandColumn(bound.column, "continuous", table).terms[0].values;
}

function covariateTerms(nodes: string[], context: EffectContext): { terms: CovariateTerm[] } | { reason: string } {
  const terms: CovariateTerm[] = [];
  for (const node of nodes) {
    const bound = context.columnOf(node);
    if (!bound) {
      return { reason: `${node} has no column in this file.` };
    }
    const expanded = expandColumn(bound.column, bound.type, context.table);
    if (expanded.levelCount > MAX_CATEGORY_LEVELS) {
      return { reason: `${bound.column} has ${expanded.levelCount} categories, which is too many to adjust for directly.` };
    }
    // Drop the first level of a category to keep the design matrix full rank.
    terms.push(...(bound.type === "categorical" ? expanded.terms.slice(1) : expanded.terms));
  }
  return { terms };
}

/** Estimates the effect with this adjustment set. `alsoComplete` restricts to rows where those variables are present too. */
export function fitEffect(context: EffectContext, covariates: string[], alsoComplete: string[] = [], options: FitOptions = {}): FitOutcome {
  const { table, treatment, outcome } = context;

  if (table.rowCount < 3) {
    return unavailable(
      table.rowCount ? `This file has only ${table.rowCount} ${table.rowCount === 1 ? "row" : "rows"}, too few to estimate an effect.` : "This file has no rows of data.",
    );
  }
  if (outcome.type !== "binary" && outcome.type !== "continuous") {
    return unavailable(`${outcome.column} needs to be numeric or have exactly two values to estimate an effect.`);
  }
  if (treatment.type !== "binary" && treatment.type !== "continuous") {
    return unavailable(`${treatment.column} needs to be numeric or have exactly two values to estimate an effect.`);
  }
  for (const [bound, label] of [
    [treatment, "Treatment"],
    [outcome, "Outcome"],
  ] as const) {
    if (bound.type === "binary" && inferBinaryLabels(table.columns.get(bound.column)!)[0] === null) {
      return unavailable(`${label} column ${bound.column} does not have exactly two values.`);
    }
  }

  const resolved = covariateTerms(covariates, context);
  if ("reason" in resolved) {
    return unavailable(resolved.reason);
  }
  const extra = covariateTerms(alsoComplete, context);
  if ("reason" in extra) {
    return unavailable(extra.reason);
  }

  const treatmentValues =
    treatment.type === "binary" ? binaryValues(table.columns.get(treatment.column)!) : numericValues(treatment, table);
  const outcomeValues = outcome.type === "binary" ? binaryValues(table.columns.get(outcome.column)!) : numericValues(outcome, table);

  const rows = completeRows(
    [treatmentValues, outcomeValues, ...resolved.terms.map((term) => term.values), ...extra.terms.map((term) => term.values)],
    table.rowCount,
  );
  if (rows.length < 3) {
    const empty = covariates.find((node) => {
      const bound = context.columnOf(node);
      return bound && expandColumn(bound.column, bound.type, table).terms.every((term) => term.values.every(Number.isNaN));
    });
    return unavailable(empty ? `${context.columnOf(empty)!.column} has no values in this file.` : "Too few rows have complete data for these variables.");
  }

  const t = takeRows(treatmentValues, rows);
  const y = takeRows(outcomeValues, rows);
  if (y.every((value) => value === y[0])) {
    return unavailable(`${outcome.column} has the same value in every row used, so there is no effect to estimate.`);
  }
  for (const [values, bound] of [
    [t, treatment],
    [y, outcome],
  ] as const) {
    if (values.some((value) => Math.abs(value) > MAX_MAGNITUDE)) {
      return unavailable(`${bound.column} has values too large to compute with. Rescale it first.`);
    }
  }
  const covariateColumns = resolved.terms.map((term) => takeRows(term.values, rows));
  const labels = resolved.terms.map((term) => term.label);
  const shared = { rows, adjustmentSet: [...covariates].sort(), outcomeIsBinary: outcome.type === "binary" };

  return treatment.type === "binary"
    ? fitAipw(t, y, covariateColumns, labels, context.estimand, shared, options)
    : fitRegression(t, y, covariateColumns, labels, shared);
}

interface SharedFields {
  rows: number[];
  adjustmentSet: string[];
  outcomeIsBinary: boolean;
}

function fitRegression(
  t: Float64Array,
  y: Float64Array,
  covariates: Float64Array[],
  labels: string[],
  shared: SharedFields,
): FitOutcome {
  const intercept = new Float64Array(t.length).fill(1);
  const columns = [intercept, t, ...covariates];
  if (t.length <= columns.length) {
    return unavailable("There are not enough rows for this many covariates.");
  }

  const warnings: string[] = [];
  let estimate: number;
  let standardError: number;
  let influence: Float64Array;
  let droppedColumns: number[];
  let kept: number[];

  if (shared.outcomeIsBinary) {
    const fit = fitLogistic({ columns, y });
    droppedColumns = fit.droppedColumns;
    kept = fit.keptColumns;
    if (!kept.includes(1)) {
      return unavailable("Treatment is fully determined by the covariates, so its effect cannot be separated from theirs.");
    }
    const position = kept.indexOf(1);
    estimate = fit.params[position];
    standardError = fit.robustStandardErrors()[position];
    influence = fit.coefficientInfluence(1);
    if (fit.separationSuspected) {
      warnings.push("The covariates almost perfectly predict the outcome in part of the data, so this estimate is unreliable.");
    }
  } else {
    const fit = fitOls(columns, y);
    droppedColumns = fit.droppedColumns;
    kept = fit.keptColumns;
    if (!kept.includes(1)) {
      return unavailable("Treatment is fully determined by the covariates, so its effect cannot be separated from theirs.");
    }
    const position = kept.indexOf(1);
    estimate = fit.params[position];
    standardError = fit.robustStandardErrors()[position];
    influence = fit.coefficientInfluence(1);
  }

  const dropped = droppedColumns.filter((index) => index >= 2).map((index) => labels[index - 2]);
  if (dropped.length) {
    warnings.push(`Collinear terms were removed: ${dropped.join(", ")}.`);
  }
  return {
    ok: true,
    fit: {
      method: shared.outcomeIsBinary ? "logistic" : "ols",
      estimand: null,
      scale: shared.outcomeIsBinary ? "log_odds_ratio" : "difference",
      estimate,
      standardError,
      influence,
      warnings,
      bound: null,
      detail: null,
      ...shared,
    },
  };
}

/**
 * The same rows as a fit, as columns: treatment, outcome, and each variable's terms. A linear regression
 * on these is what the partial R-squared bound is defined on.
 */
export function linearDesign(
  context: EffectContext,
  nodes: string[],
  rows: number[],
): { t: Float64Array; y: Float64Array; termsOf: Map<string, Float64Array[]> } | null {
  const { table, treatment, outcome } = context;
  const termsOf = new Map<string, Float64Array[]>();
  for (const node of nodes) {
    const resolved = covariateTerms([node], context);
    if ("reason" in resolved) {
      return null;
    }
    termsOf.set(
      node,
      resolved.terms.map((term) => takeRows(term.values, rows)),
    );
  }
  const values = (bound: BoundColumn) => (bound.type === "binary" ? binaryValues(table.columns.get(bound.column)!) : numericValues(bound, table));
  return { t: takeRows(values(treatment), rows), y: takeRows(values(outcome), rows), termsOf };
}

function subset(column: Float64Array, keep: boolean[]): Float64Array {
  const values: number[] = [];
  for (let row = 0; row < column.length; row += 1) {
    if (keep[row]) {
      values.push(column[row]);
    }
  }
  return Float64Array.from(values);
}

/** Predictions for every row from an outcome model fitted only on one treatment group. */
function predictArm(
  columns: Float64Array[],
  y: Float64Array,
  inArm: boolean[],
  outcomeIsBinary: boolean,
): { predictions: Float64Array; separated: boolean } {
  const armColumns = columns.map((column) => subset(column, inArm));
  const armY = subset(y, inArm);
  const fit = outcomeIsBinary ? fitLogistic({ columns: armColumns, y: armY }) : fitOls(armColumns, armY);
  const kept = fit.keptColumns;

  const predictions = new Float64Array(y.length);
  for (let row = 0; row < y.length; row += 1) {
    let linear = 0;
    kept.forEach((column, position) => {
      linear += fit.params[position] * columns[column][row];
    });
    predictions[row] = outcomeIsBinary ? 1 / (1 + Math.exp(-linear)) : linear;
  }
  return { predictions, separated: "separationSuspected" in fit ? fit.separationSuspected : false };
}

/**
 * Doubly robust AIPW. Fitting the outcome model separately in each group is the same fit as a fully
 * interacted pooled model, which is how the generated Python writes it.
 */
function fitAipw(
  t: Float64Array,
  y: Float64Array,
  covariates: Float64Array[],
  labels: string[],
  estimand: Estimand,
  shared: SharedFields,
  options: FitOptions,
): FitOutcome {
  const count = t.length;
  const treatedCount = t.reduce((total, value) => total + value, 0);
  const controlCount = count - treatedCount;
  if (!treatedCount || !controlCount) {
    return unavailable("After removing rows with missing values, only one treatment group remains.");
  }
  const columns = [new Float64Array(count).fill(1), ...covariates];
  if (Math.min(treatedCount, controlCount) <= columns.length) {
    return unavailable(
      `The smaller treatment group has ${Math.min(treatedCount, controlCount)} complete ${Math.min(treatedCount, controlCount) === 1 ? "row" : "rows"}, too few to fit ${columns.length} model terms.`,
    );
  }

  const warnings: string[] = [];
  const propensity = fitLogistic({ columns, y: t });
  const dropped = propensity.droppedColumns.filter((index) => index >= 1).map((index) => labels[index - 1]);
  if (dropped.length) {
    warnings.push(`Collinear terms were removed: ${dropped.join(", ")}.`);
  }

  // The ATT weights controls by e / (1 - e), which is harmless near 0, so only the ATE needs a floor.
  // Flooring there would hand real weight to controls that look nothing like anyone treated.
  const floor = estimand === "att" ? 0 : PROPENSITY_FLOOR;
  let clipped = 0;
  const scores = Float64Array.from(propensity.fitted, (value) => {
    if (value < floor || value > PROPENSITY_CEILING) {
      clipped += 1;
    }
    return Math.min(PROPENSITY_CEILING, Math.max(floor, value));
  });
  if (clipped / count > CLIPPED_WARNING_SHARE) {
    warnings.push(
      `${((clipped / count) * 100).toFixed(1)}% of rows have an extreme propensity score and were clipped to ${floor || "0"}-${PROPENSITY_CEILING}, so this estimate leans heavily on the outcome model.`,
    );
  }
  if (propensity.separationSuspected) {
    warnings.push("The covariates almost perfectly predict treatment in part of the data, so overlap is poor.");
  }

  const treated = Array.from(t, (value) => value === 1);
  const control = treated.map((value) => !value);
  const armOne = predictArm(columns, y, treated, shared.outcomeIsBinary);
  const armZero = predictArm(columns, y, control, shared.outcomeIsBinary);
  if (armOne.separated || armZero.separated) {
    warnings.push("The covariates almost perfectly predict the outcome within a treatment group, so the outcome model is unreliable there.");
  }
  const mu1 = armOne.predictions;
  const mu0 = armZero.predictions;

  const raw = new Float64Array(count);
  let estimate = 0;
  if (estimand === "att") {
    const share = treatedCount / count;
    for (let row = 0; row < count; row += 1) {
      const gap = y[row] - mu0[row];
      raw[row] = (t[row] * gap - ((1 - t[row]) * scores[row] * gap) / (1 - scores[row])) / share;
      estimate += raw[row];
    }
    estimate /= count;
    for (let row = 0; row < count; row += 1) {
      raw[row] -= (t[row] / share) * estimate;
    }
  } else {
    for (let row = 0; row < count; row += 1) {
      raw[row] =
        mu1[row] - mu0[row] + (t[row] * (y[row] - mu1[row])) / scores[row] - ((1 - t[row]) * (y[row] - mu0[row])) / (1 - scores[row]);
      estimate += raw[row];
    }
    estimate /= count;
    for (let row = 0; row < count; row += 1) {
      raw[row] -= estimate;
    }
  }

  // The omitted-variable bound of Chernozhukov et al. (2022): sigma2 is what the outcome models leave
  // unexplained, nu2 the variance of the weights. The forms below are the ones DoubleML uses, simplified
  // so that a score of exactly 0 cannot produce 0 / 0 for the ATT.
  const share = treatedCount / count;
  const sigmaElements = new Float64Array(count);
  const nuElements = new Float64Array(count);
  let sigma2 = 0;
  let nu2 = 0;
  for (let row = 0; row < count; row += 1) {
    const e = scores[row];
    const residual = y[row] - t[row] * mu1[row] - (1 - t[row]) * mu0[row];
    sigmaElements[row] = residual * residual;
    let weightGain: number;
    let weight: number;
    if (estimand === "att") {
      weightGain = t[row] / (share * share * (1 - e));
      weight = (t[row] - ((1 - t[row]) * e) / (1 - e)) / share;
    } else {
      weightGain = 1 / e + 1 / (1 - e);
      weight = t[row] / e - (1 - t[row]) / (1 - e);
    }
    nuElements[row] = 2 * weightGain - weight * weight;
    sigma2 += sigmaElements[row];
    nu2 += nuElements[row];
  }
  sigma2 /= count;
  nu2 /= count;

  return {
    ok: true,
    fit: {
      method: "aipw",
      estimand,
      scale: "difference",
      estimate,
      standardError: sampleStandardDeviation(raw) / Math.sqrt(count),
      influence: raw,
      warnings,
      bound: { sigma2, nu2 },
      detail: options.detail ? aipwDetail(t, y, mu1, mu0, scores, raw, estimate, estimand, sigmaElements, nuElements) : null,
      ...shared,
    },
  };
}

/** The two potential-outcome means behind the estimate, with their per-row contributions. */
function aipwDetail(
  t: Float64Array,
  y: Float64Array,
  mu1: Float64Array,
  mu0: Float64Array,
  scores: Float64Array,
  influence: Float64Array,
  estimate: number,
  estimand: Estimand,
  sigmaElements: Float64Array,
  nuElements: Float64Array,
): AipwDetail {
  const count = t.length;
  const treatedInfluence = new Float64Array(count);
  const controlInfluence = new Float64Array(count);
  let treatedMean = 0;
  let controlMean = 0;
  if (estimand === "att") {
    const share = t.reduce((total, value) => total + value, 0) / count;
    for (let row = 0; row < count; row += 1) {
      treatedMean += (t[row] * y[row]) / share;
    }
    treatedMean /= count;
    controlMean = treatedMean - estimate;
    for (let row = 0; row < count; row += 1) {
      treatedInfluence[row] = (t[row] / share) * (y[row] - treatedMean);
      controlInfluence[row] = treatedInfluence[row] - influence[row];
    }
  } else {
    for (let row = 0; row < count; row += 1) {
      treatedInfluence[row] = mu1[row] + (t[row] * (y[row] - mu1[row])) / scores[row];
      controlInfluence[row] = mu0[row] + ((1 - t[row]) * (y[row] - mu0[row])) / (1 - scores[row]);
      treatedMean += treatedInfluence[row];
      controlMean += controlInfluence[row];
    }
    treatedMean /= count;
    controlMean /= count;
    for (let row = 0; row < count; row += 1) {
      treatedInfluence[row] -= treatedMean;
      controlInfluence[row] -= controlMean;
    }
  }
  return { sigmaElements, nuElements, treatedMean, controlMean, treatedInfluence, controlInfluence };
}

export function sampleStandardDeviation(values: Float64Array): number {
  let total = 0;
  for (let i = 0; i < values.length; i += 1) {
    total += values[i];
  }
  const mean = total / values.length;
  let squares = 0;
  for (let i = 0; i < values.length; i += 1) {
    squares += (values[i] - mean) ** 2;
  }
  return Math.sqrt(squares / (values.length - 1));
}

/** Standard error of the difference between two fits on the same rows, from their paired influence values. */
export function shiftStandardError(alternative: EffectFit, baseline: EffectFit): number {
  const difference = Float64Array.from(alternative.influence, (value, row) => value - baseline.influence[row]);
  return sampleStandardDeviation(difference) / Math.sqrt(difference.length);
}

function describe(fit: EffectFit): string {
  if (fit.method === "aipw") {
    const unit = fit.outcomeIsBinary ? " as a risk difference" : "";
    return fit.estimand === "att"
      ? `Average effect among the treated (ATT)${unit}, estimated by doubly robust AIPW.`
      : `Average effect in the whole sample (ATE)${unit}, estimated by doubly robust AIPW.`;
  }
  return fit.method === "logistic"
    ? "Odds ratio per one-unit increase in treatment, from a logistic regression with robust standard errors."
    : "Change in outcome per one-unit increase in treatment, from a linear regression with robust standard errors.";
}

export function toEffectEstimate(fit: EffectFit, totalRows: number): EffectEstimate {
  return {
    method: fit.method,
    estimand: fit.estimand,
    description: describe(fit),
    scale: fit.scale,
    estimate: fit.estimate,
    standardError: fit.standardError,
    ciLow: fit.estimate - CI_MULTIPLIER * fit.standardError,
    ciHigh: fit.estimate + CI_MULTIPLIER * fit.standardError,
    rowsUsed: fit.rows.length,
    rowsDropped: totalRows - fit.rows.length,
    adjustmentSet: fit.adjustmentSet,
    warnings: fit.warnings,
    snippetId: fit.method === "aipw" ? "python-aipw" : "python-statsmodels",
  };
}
