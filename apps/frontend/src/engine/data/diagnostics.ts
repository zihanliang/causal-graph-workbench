import type {
  BalanceMetric,
  ColumnProfile,
  DataDiagnostics,
  GraphSpec,
  OverlapDiagnostics,
  PropensityOverlap,
  TreatmentBalanceSummary,
  UploadedDataset,
  VariableBinding,
  VariableType,
} from "@causal-graph-workbench/shared";

import { fitLogistic } from "../stats/logistic";
import { expandColumn, type CovariateTerm } from "./design";
import {
  inferBinaryLabels,
  inferVariableType,
  isMissing,
  normalizeName,
  normalizeScalar,
  parseDataset,
  toNumber,
  type DataTable,
} from "./table";

export const EXTREME_LOW = 0.05;
export const EXTREME_HIGH = 0.95;
const SUPPORT_WARNING_SHARE = 0.1;
const IMBALANCE_THRESHOLD = 0.1;
const MAX_LEVELS_IN_MODEL = 30;
const MAX_LEVELS_IN_BALANCE = 12;
const MIN_ROWS_PER_TERM = 10;

/** Graph-independent facts about the file; the adjustment-set checks are added later. */
export function profileDataset(
  graph: GraphSpec,
  dataset: UploadedDataset,
  providedBindings: Record<string, string> = {},
): { diagnostics: DataDiagnostics; table: DataTable } {
  const table = parseDataset(dataset);
  const bindings = inferVariableBindings(graph, table.headers, providedBindings);
  const columnProfiles = buildColumnProfiles(table, bindings);
  return {
    table,
    diagnostics: {
      hasData: true,
      datasetName: dataset.filename ?? null,
      rowCount: table.rowCount,
      columnCount: table.headers.length,
      columnProfiles,
      variableBindings: bindings,
      missingness: columnProfiles
        .map(({ columnName, missingCount, missingRate }) => ({ columnName, missingCount, missingRate }))
        .sort((left, right) => right.missingRate - left.missingRate),
      warnings: [...table.warnings, ...buildDataWarnings(graph, columnProfiles, bindings)],
      treatmentBalance: null,
      overlapDiagnostics: null,
    },
  };
}

function inferVariableBindings(graph: GraphSpec, headers: string[], provided: Record<string, string>): VariableBinding[] {
  const byNormalizedName = new Map<string, string[]>();
  for (const header of headers) {
    const key = normalizeName(header);
    byNormalizedName.set(key, [...(byNormalizedName.get(key) ?? []), header]);
  }

  return graph.nodes.map((node): VariableBinding => {
    if (node.observed === false) {
      return { nodeId: node.id, columnName: null, matched: false, matchType: "unmatched", note: "Marked as not measured." };
    }
    const providedColumn = provided[node.id];
    if (providedColumn === "") {
      return { nodeId: node.id, columnName: null, matched: false, matchType: "unmatched", note: "Marked as not in this file." };
    }
    if (providedColumn && headers.includes(providedColumn)) {
      return {
        nodeId: node.id,
        columnName: providedColumn,
        matched: true,
        matchType: "provided",
        note: "Using the column binding supplied by the client.",
      };
    }
    if (headers.includes(node.id)) {
      return { nodeId: node.id, columnName: node.id, matched: true, matchType: "exact", note: "Exact header match." };
    }
    const normalized = byNormalizedName.get(normalizeName(node.id)) ?? [];
    if (normalized.length === 1) {
      return {
        nodeId: node.id,
        columnName: normalized[0],
        matched: true,
        matchType: "normalized",
        note: "Matched after normalizing casing and separators.",
      };
    }
    return {
      nodeId: node.id,
      columnName: null,
      matched: false,
      matchType: "unmatched",
      note: "No uploaded column could be matched to this graph variable.",
    };
  });
}

function buildColumnProfiles(table: DataTable, bindings: VariableBinding[]): ColumnProfile[] {
  const nodesByColumn = new Map<string, string[]>();
  for (const binding of bindings) {
    if (binding.columnName) {
      nodesByColumn.set(binding.columnName, [...(nodesByColumn.get(binding.columnName) ?? []), binding.nodeId]);
    }
  }
  return table.headers.map((header) => {
    const values = table.columns.get(header)!;
    const present = values.filter((value) => !isMissing(value));
    const missingCount = values.length - present.length;
    return {
      columnName: header,
      inferredType: inferVariableType(present),
      nonMissingCount: present.length,
      missingCount,
      missingRate: values.length ? missingCount / values.length : 0,
      uniqueCount: new Set(present.map(normalizeScalar)).size,
      exampleValues: [...new Set(present.slice(0, 3))],
      boundNodeIds: nodesByColumn.get(header) ?? [],
    };
  });
}

function profileForNode(
  nodeId: string | null,
  profiles: ColumnProfile[],
  bindings: VariableBinding[],
): ColumnProfile | null {
  const column = bindings.find((binding) => binding.nodeId === nodeId)?.columnName;
  return column ? (profiles.find((profile) => profile.columnName === column) ?? null) : null;
}

function buildDataWarnings(graph: GraphSpec, profiles: ColumnProfile[], bindings: VariableBinding[]): string[] {
  const warnings: string[] = [];
  const declaredUnmeasured = new Set(graph.nodes.filter((node) => node.observed === false).map((node) => node.id));
  const unmatched = bindings
    .filter((binding) => !binding.matched && !declaredUnmeasured.has(binding.nodeId))
    .map((binding) => binding.nodeId);
  const endpoints = unmatched.filter((node) => node === graph.treatmentId || node === graph.outcomeId);
  const others = unmatched.filter((node) => !endpoints.includes(node));
  if (endpoints.length) {
    warnings.push(`No column is matched to ${endpoints.join(" and ")}, so no effect can be estimated. Match it under Data.`);
  }
  if (others.length) {
    warnings.push(
      `No column is matched to ${others.join(", ")}, so ${others.length === 1 ? "it is" : "they are"} treated as not measured. If your file has ${
        others.length === 1 ? "it" : "them"
      }, match the column under Data.`,
    );
  }
  const highMissing = profiles.filter((profile) => profile.missingRate >= 0.3).map((profile) => profile.columnName);
  if (highMissing.length) {
    warnings.push(
      `High missingness detected in: ${highMissing.join(", ")}. The missingness pattern may be informative and should be considered carefully.`,
    );
  }
  if ((profileForNode(graph.treatmentId, profiles, bindings)?.missingCount ?? 0) > 0) {
    warnings.push("Treatment has missing values. Estimation code may require explicit filtering or imputation decisions.");
  }
  if ((profileForNode(graph.outcomeId, profiles, bindings)?.missingCount ?? 0) > 0) {
    warnings.push("Outcome has missing values. Estimation code may require explicit filtering or imputation decisions.");
  }
  return warnings;
}

interface TreatmentArms {
  column: string;
  type: VariableType;
  treatedLabel: string;
  controlLabel: string;
  /** 1 for treated, 0 for control, NaN when missing. */
  assignment: Float64Array;
  treatedCount: number;
  controlCount: number;
}

type ArmLookup = { arms: TreatmentArms } | { unavailable: TreatmentBalanceSummary };

function resolveArms(graph: GraphSpec, base: DataDiagnostics, table: DataTable): ArmLookup {
  const profile = profileForNode(graph.treatmentId, base.columnProfiles, base.variableBindings);
  if (!profile) {
    return {
      unavailable: {
        available: false,
        treatmentType: "unknown",
        metrics: [],
        note: "Upload data with a matched treatment column to preview treatment balance.",
      },
    };
  }
  const column = profile.columnName;
  if (profile.inferredType !== "binary") {
    return {
      unavailable: {
        available: false,
        treatmentColumn: column,
        treatmentType: profile.inferredType,
        metrics: [],
        note: "The balance preview currently expects a binary treatment.",
      },
    };
  }
  const values = table.columns.get(column)!;
  const [treatedLabel, controlLabel] = inferBinaryLabels(values);
  if (treatedLabel === null || controlLabel === null) {
    return {
      unavailable: {
        available: false,
        treatmentColumn: column,
        treatmentType: profile.inferredType,
        metrics: [],
        note: "The uploaded treatment column does not have two usable levels after removing missing values.",
      },
    };
  }
  const assignment = new Float64Array(values.length);
  let treatedCount = 0;
  let controlCount = 0;
  values.forEach((value, row) => {
    const normalized = normalizeScalar(value);
    if (normalized === treatedLabel) {
      assignment[row] = 1;
      treatedCount += 1;
    } else if (normalized === controlLabel) {
      assignment[row] = 0;
      controlCount += 1;
    } else {
      assignment[row] = Number.NaN;
    }
  });
  return { arms: { column, type: profile.inferredType, treatedLabel, controlLabel, assignment, treatedCount, controlCount } };
}

function formatValue(value: number): string {
  return value.toFixed(3);
}

function balanceMetric(label: string, values: Float64Array, assignment: Float64Array): BalanceMetric | null {
  let treatedCount = 0;
  let treatedSum = 0;
  let treatedSquares = 0;
  let controlCount = 0;
  let controlSum = 0;
  let controlSquares = 0;
  for (let row = 0; row < values.length; row += 1) {
    const value = values[row];
    if (Number.isNaN(value) || Number.isNaN(assignment[row])) {
      continue;
    }
    if (assignment[row] === 1) {
      treatedCount += 1;
      treatedSum += value;
      treatedSquares += value * value;
    } else {
      controlCount += 1;
      controlSum += value;
      controlSquares += value * value;
    }
  }
  if (!treatedCount || !controlCount) {
    return null;
  }
  const treatedMean = treatedSum / treatedCount;
  const controlMean = controlSum / controlCount;
  const difference = Math.abs(treatedMean - controlMean);

  let standardizedDifference: number | null = null;
  if (treatedCount > 1 && controlCount > 1) {
    const treatedVariance = (treatedSquares - treatedCount * treatedMean * treatedMean) / (treatedCount - 1);
    const controlVariance = (controlSquares - controlCount * controlMean * controlMean) / (controlCount - 1);
    const pooled = Math.sqrt((treatedVariance + controlVariance) / 2);
    standardizedDifference = pooled > 0 ? difference / pooled : null;
  }
  return {
    columnName: label,
    treatedValue: formatValue(treatedMean),
    controlValue: formatValue(controlMean),
    absoluteDifference: difference,
    standardizedDifference,
    imbalanced: standardizedDifference !== null && standardizedDifference > IMBALANCE_THRESHOLD,
  };
}

function covariateColumns(covariates: string[], base: DataDiagnostics) {
  const resolved: { node: string; column: string; type: VariableType }[] = [];
  const unmatched: string[] = [];
  for (const node of covariates) {
    const profile = profileForNode(node, base.columnProfiles, base.variableBindings);
    if (profile) {
      resolved.push({ node, column: profile.columnName, type: profile.inferredType });
    } else {
      unmatched.push(node);
    }
  }
  return { resolved, unmatched };
}

function buildBalance(arms: TreatmentArms, covariates: string[] | null, base: DataDiagnostics, table: DataTable): TreatmentBalanceSummary {
  const summary = {
    available: true,
    treatmentColumn: arms.column,
    treatmentType: arms.type,
    treatedCount: arms.treatedCount,
    controlCount: arms.controlCount,
    treatedRate: arms.treatedCount + arms.controlCount ? arms.treatedCount / (arms.treatedCount + arms.controlCount) : null,
    treatedLabel: arms.treatedLabel,
    controlLabel: arms.controlLabel,
  };

  if (covariates === null) {
    return { ...summary, metrics: [], note: "No valid adjustment set was found, so there are no covariates to compare." };
  }
  if (!covariates.length) {
    return { ...summary, metrics: [], note: "The recommended adjustment set is empty, so there are no covariates to compare." };
  }

  const { resolved, unmatched } = covariateColumns(covariates, base);
  const metrics: BalanceMetric[] = [];
  let hiddenLevels = 0;
  for (const { column, type } of resolved) {
    const { terms } = expandColumn(column, type, table);
    const shown = type === "categorical" ? terms.slice(0, MAX_LEVELS_IN_BALANCE) : terms;
    hiddenLevels += terms.length - shown.length;
    for (const term of shown) {
      const metric = balanceMetric(term.label, term.values, arms.assignment);
      if (metric) {
        metrics.push(metric);
      }
    }
  }

  const notes = [
    "Compares the covariates in the recommended adjustment set, before any adjustment. This describes the imbalance that adjustment must remove; it does not show that exchangeability holds.",
  ];
  if (unmatched.length) {
    notes.push(`No column was matched for: ${unmatched.join(", ")}.`);
  }
  if (hiddenLevels) {
    notes.push(`${hiddenLevels} additional category level(s) are not shown.`);
  }
  return { ...summary, metrics, note: notes.join(" ") };
}

function percent(share: number): string {
  return `${(share * 100).toFixed(1)}%`;
}

function buildOverlap(arms: TreatmentArms, covariates: string[] | null, base: DataDiagnostics, table: DataTable): OverlapDiagnostics {
  if (covariates === null) {
    return { available: false, note: "No valid adjustment set was found, so there is no propensity model to check.", warnings: [] };
  }
  if (!covariates.length) {
    return {
      available: true,
      note: "The recommended adjustment set is empty, so every unit has the same estimated propensity and there is nothing to overlap on.",
      propensity: null,
      warnings: [],
    };
  }

  const { resolved, unmatched } = covariateColumns(covariates, base);
  const warnings: string[] = [];
  if (unmatched.length) {
    warnings.push(`The propensity model leaves out ${unmatched.join(", ")} because no column was matched.`);
  }

  const terms: CovariateTerm[] = [];
  for (const { column, type } of resolved) {
    const expanded = expandColumn(column, type, table);
    if (type === "categorical" && expanded.levelCount > MAX_LEVELS_IN_MODEL) {
      warnings.push(`${column} has ${expanded.levelCount} levels and was left out of the propensity model.`);
      continue;
    }
    // Drop the first level of a category to keep the design matrix full rank.
    terms.push(...(type === "categorical" ? expanded.terms.slice(1) : expanded.terms));
  }
  if (!terms.length) {
    return {
      available: false,
      note: "None of the recommended covariates could be used in a propensity model.",
      warnings,
    };
  }

  const rows: number[] = [];
  for (let row = 0; row < table.rowCount; row += 1) {
    if (!Number.isNaN(arms.assignment[row]) && terms.every((term) => !Number.isNaN(term.values[row]))) {
      rows.push(row);
    }
  }
  const y = Float64Array.from(rows, (row) => arms.assignment[row]);
  const treatedInSample = y.reduce((total, value) => total + value, 0);
  if (!treatedInSample || treatedInSample === rows.length) {
    return {
      available: false,
      note: "After removing rows with missing values, only one treatment group remains.",
      warnings,
    };
  }

  const columns = [
    new Float64Array(rows.length).fill(1),
    ...terms.map((term) => Float64Array.from(rows, (row) => term.values[row])),
  ];
  const fit = fitLogistic({ columns, y });
  const droppedTerms = fit.droppedColumns.map((index) => terms[index - 1].label);
  const retainedTerms = terms.map((term) => term.label).filter((label) => !droppedTerms.includes(label));

  const treatedScores: number[] = [];
  const controlScores: number[] = [];
  let extremeCount = 0;
  fit.fitted.forEach((score, index) => {
    (y[index] === 1 ? treatedScores : controlScores).push(score);
    if (score < EXTREME_LOW || score > EXTREME_HIGH) {
      extremeCount += 1;
    }
  });
  const treatedRange = extent(treatedScores);
  const controlRange = extent(controlScores);
  const low = Math.max(treatedRange[0], controlRange[0]);
  const high = Math.min(treatedRange[1], controlRange[1]);
  const commonSupport: [number, number] | null = low <= high ? [low, high] : null;
  const outside = (scores: number[]) =>
    commonSupport ? scores.filter((score) => score < low || score > high).length / scores.length : 1;

  const propensity: PropensityOverlap = {
    terms: retainedTerms,
    droppedTerms,
    rowsUsed: rows.length,
    rowsDropped: table.rowCount - rows.length,
    treatedRange,
    controlRange,
    commonSupport,
    treatedOutsideSupport: outside(treatedScores),
    controlOutsideSupport: outside(controlScores),
    extremeShare: extremeCount / rows.length,
    converged: fit.converged,
    separationSuspected: fit.separationSuspected,
  };

  if (!commonSupport) {
    warnings.push("Estimated propensities for the two groups do not overlap at all. These groups cannot be compared without extrapolating.");
  } else {
    if (propensity.treatedOutsideSupport > SUPPORT_WARNING_SHARE) {
      warnings.push(`${percent(propensity.treatedOutsideSupport)} of treated units fall outside the range covered by controls.`);
    }
    if (propensity.controlOutsideSupport > SUPPORT_WARNING_SHARE) {
      warnings.push(`${percent(propensity.controlOutsideSupport)} of control units fall outside the range covered by treated units.`);
    }
  }
  if (propensity.extremeShare > SUPPORT_WARNING_SHARE) {
    warnings.push(
      `${percent(propensity.extremeShare)} of rows have an estimated propensity below ${EXTREME_LOW} or above ${EXTREME_HIGH}. Positivity looks fragile, and weighting estimators will be unstable.`,
    );
  }
  if (fit.separationSuspected) {
    warnings.push("The covariates almost perfectly predict treatment in part of the data, so the propensity model is unreliable there.");
  }
  if (droppedTerms.length) {
    warnings.push(`Collinear terms were removed from the propensity model: ${droppedTerms.join(", ")}.`);
  }
  const smallerArm = Math.min(treatedInSample, rows.length - treatedInSample);
  if (smallerArm / retainedTerms.length < MIN_ROWS_PER_TERM) {
    warnings.push(`The smaller group has ${smallerArm} rows for ${retainedTerms.length} model term(s), so these estimates are imprecise.`);
  }

  return {
    available: true,
    note: "Based on a logistic propensity model using the recommended adjustment set. This can reveal poor overlap; it cannot prove that positivity holds.",
    propensity,
    warnings,
  };
}

/** A plain loop, because Math.min(...scores) overflows the call stack on large files. */
function extent(scores: number[]): [number, number] {
  let low = Number.POSITIVE_INFINITY;
  let high = Number.NEGATIVE_INFINITY;
  for (const score of scores) {
    low = Math.min(low, score);
    high = Math.max(high, score);
  }
  return [low, high];
}

/** Adds balance and overlap for the recommended set; null means no valid set exists. */
export function withCovariateDiagnostics(
  graph: GraphSpec,
  base: DataDiagnostics,
  table: DataTable,
  covariates: string[] | null,
): DataDiagnostics {
  const lookup = resolveArms(graph, base, table);
  if ("unavailable" in lookup) {
    return {
      ...base,
      treatmentBalance: lookup.unavailable,
      overlapDiagnostics: {
        available: false,
        note: lookup.unavailable.note.replace("treatment balance", "overlap").replace("balance preview", "overlap preview"),
        warnings: [],
      },
    };
  }
  return {
    ...base,
    treatmentBalance: buildBalance(lookup.arms, covariates, base, table),
    overlapDiagnostics: buildOverlap(lookup.arms, covariates, base, table),
  };
}

export function inferNodeType(nodeId: string, diagnostics: DataDiagnostics | null): VariableType {
  if (!diagnostics) {
    return "unknown";
  }
  return profileForNode(nodeId, diagnostics.columnProfiles, diagnostics.variableBindings)?.inferredType ?? "unknown";
}

export function resolvedColumnBindings(graph: GraphSpec, diagnostics: DataDiagnostics | null): Record<string, string> {
  const resolved = Object.fromEntries(graph.nodes.map((node) => [node.id, node.id]));
  for (const binding of diagnostics?.variableBindings ?? []) {
    if (binding.columnName) {
      resolved[binding.nodeId] = binding.columnName;
    }
  }
  return resolved;
}

/** How a binary column is written in the file, so generated code can recode it to 0/1. */
export function binaryCoding(nodeId: string, diagnostics: DataDiagnostics | null, table: DataTable | null): BinaryCoding | null {
  if (!diagnostics || !table) {
    return null;
  }
  const profile = profileForNode(nodeId, diagnostics.columnProfiles, diagnostics.variableBindings);
  if (!profile || profile.inferredType !== "binary") {
    return null;
  }
  const [high, low] = inferBinaryLabels(table.columns.get(profile.columnName)!);
  if (high === null || low === null || (toNumber(high) !== null && toNumber(low) !== null)) {
    return null;
  }
  return { high, low };
}

export interface BinaryCoding {
  /** Lower-cased value recoded to 1. */
  high: string;
  /** Lower-cased value recoded to 0. */
  low: string;
}
