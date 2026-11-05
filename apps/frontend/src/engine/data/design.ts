import type { VariableType } from "@causal-graph-workbench/shared";

import { inferBinaryLabels, isMissing, normalizeScalar, toNumber, type DataTable } from "./table";

export interface CovariateTerm {
  label: string;
  /** Numeric value per row, NaN when missing. */
  values: Float64Array;
}

export interface ExpandedColumn {
  terms: CovariateTerm[];
  /** Number of distinct categories, or 0 for a numeric or binary column. */
  levelCount: number;
}

const expansions = new WeakMap<DataTable, Map<string, ExpandedColumn>>();

/** Expands one column into numeric terms: itself, a 0/1 flag, or one flag per category level. */
export function expandColumn(column: string, type: VariableType, table: DataTable): ExpandedColumn {
  let cache = expansions.get(table);
  if (!cache) {
    cache = new Map();
    expansions.set(table, cache);
  }
  const key = `${type}|${column}`;
  let expanded = cache.get(key);
  if (!expanded) {
    expanded = computeExpansion(column, type, table);
    cache.set(key, expanded);
  }
  return expanded;
}

function computeExpansion(column: string, type: VariableType, table: DataTable): ExpandedColumn {
  const values = table.columns.get(column)!;

  if (type === "continuous" || type === "unknown") {
    const numeric = Float64Array.from(values, (value) => (isMissing(value) ? Number.NaN : (toNumber(value) ?? Number.NaN)));
    return { terms: [{ label: column, values: numeric }], levelCount: 0 };
  }
  if (type === "binary") {
    return { terms: [{ label: column, values: binaryValues(values) }], levelCount: 0 };
  }

  const levels = [...new Set(values.filter((value) => !isMissing(value)))].sort();
  const terms = levels.map((level) => ({
    label: `${column}=${level}`,
    values: Float64Array.from(values, (value) => (isMissing(value) ? Number.NaN : value === level ? 1 : 0)),
  }));
  return { terms, levelCount: levels.length };
}

/** 1 for the "high" label, 0 for the other, NaN for anything else. */
export function binaryValues(values: string[]): Float64Array {
  const [high, low] = inferBinaryLabels(values);
  return Float64Array.from(values, (value) => {
    if (isMissing(value)) {
      return Number.NaN;
    }
    const normalized = normalizeScalar(value);
    return normalized === high ? 1 : normalized === low ? 0 : Number.NaN;
  });
}

/** Rows where every one of these columns has a usable value. */
export function completeRows(columns: Float64Array[], rowCount: number): number[] {
  const rows: number[] = [];
  for (let row = 0; row < rowCount; row += 1) {
    if (columns.every((column) => !Number.isNaN(column[row]))) {
      rows.push(row);
    }
  }
  return rows;
}

export function takeRows(values: Float64Array, rows: number[]): Float64Array {
  return Float64Array.from(rows, (row) => values[row]);
}
