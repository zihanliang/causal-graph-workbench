import type { UploadedDataset, VariableType } from "@causal-graph-workbench/shared";
import Papa from "papaparse";

/** Includes the markers pandas treats as missing, so generated scripts drop the same rows the app does. */
const MISSING_TOKENS = new Set([
  "",
  "na",
  "n/a",
  "#n/a",
  "#n/a n/a",
  "#na",
  "<na>",
  "nan",
  "-nan",
  "-1.#ind",
  "-1.#qnan",
  "1.#ind",
  "1.#qnan",
  "null",
  "none",
  "missing",
]);
const TRUE_TOKENS = new Set(["1", "true", "yes", "y", "treated"]);
const FALSE_TOKENS = new Set(["0", "false", "no", "n", "control"]);
const NUMERIC = /^[+-]?(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?$/;

/** Column-oriented CSV contents, with every cell trimmed. */
export interface DataTable {
  headers: string[];
  columns: Map<string, string[]>;
  rowCount: number;
  warnings: string[];
}

export function normalizeScalar(value: string): string {
  return value.trim().toLowerCase();
}

export function isMissing(value: string | undefined | null): boolean {
  return value === undefined || value === null || MISSING_TOKENS.has(normalizeScalar(value));
}

/** Strict parse: `Number()` would also accept "", " ", "0x10" and "Infinity". */
export function toNumber(value: string): number | null {
  const trimmed = value.trim();
  return NUMERIC.test(trimmed) ? Number(trimmed) : null;
}

export function normalizeName(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "");
}

let cached: { content: string; delimiter: string | null | undefined; table: DataTable } | null = null;

/** Parses a CSV, remembering the latest result so that graph edits do not re-read an unchanged file. */
export function parseDataset(dataset: UploadedDataset): DataTable {
  if (cached && cached.content === dataset.content && cached.delimiter === dataset.delimiter) {
    return cached.table;
  }
  const table = parseCsv(dataset.content, dataset.delimiter);
  cached = { content: dataset.content, delimiter: dataset.delimiter, table };
  return table;
}

function parseCsv(content: string, delimiter?: string | null): DataTable {
  const text = content.replace(/^﻿/, "");
  if (!text.trim()) {
    return { headers: [], columns: new Map(), rowCount: 0, warnings: [] };
  }

  const parsed = Papa.parse<string[]>(text, { header: false, delimiter: delimiter ?? "", skipEmptyLines: "greedy" });
  const [headerRow = [], ...rows] = parsed.data;
  const warnings: string[] = [];

  const seen = new Set<string>();
  const headers = headerRow.map((raw, index) => {
    const base = raw.trim() || `column_${index + 1}`;
    let name = base;
    for (let suffix = 2; seen.has(name); suffix += 1) {
      name = `${base}_${suffix}`;
    }
    if (name !== raw.trim()) {
      warnings.push(`Column ${index + 1} has an empty or repeated header and was read as "${name}".`);
    }
    seen.add(name);
    return name;
  });

  const columns = new Map(headers.map((header) => [header, new Array<string>(rows.length)]));
  let irregular = 0;
  rows.forEach((row, rowIndex) => {
    if (row.length !== headers.length) {
      irregular += 1;
    }
    headers.forEach((header, columnIndex) => {
      columns.get(header)![rowIndex] = (row[columnIndex] ?? "").trim();
    });
  });
  if (irregular) {
    warnings.push(`${irregular} row(s) have a different number of fields than the header. Check the delimiter and quoting.`);
  }

  return { headers, columns, rowCount: rows.length, warnings };
}

export function inferVariableType(values: string[]): VariableType {
  if (!values.length) {
    return "unknown";
  }
  const unique = new Set(values.map(normalizeScalar));
  const allBinaryTokens = [...unique].every((value) => TRUE_TOKENS.has(value) || FALSE_TOKENS.has(value));
  if (allBinaryTokens && unique.size <= 2) {
    return "binary";
  }

  const numbers = [...unique].map(toNumber);
  if (numbers.every((value) => value !== null)) {
    const distinct = new Set(numbers);
    const onlyZeroOne = [...distinct].every((value) => value === 0 || value === 1);
    return onlyZeroOne && distinct.size <= 2 ? "binary" : "continuous";
  }
  return unique.size === 2 ? "binary" : "categorical";
}

/** Which of the two values means "treated". Returns nulls unless exactly two values are present. */
export function inferBinaryLabels(values: string[]): [string, string] | [null, null] {
  const unique = [...new Set(values.filter((value) => !isMissing(value)).map(normalizeScalar))].sort();
  if (unique.length !== 2) {
    return [null, null];
  }
  if (unique.includes("1") && unique.includes("0")) {
    return ["1", "0"];
  }
  const treated = unique.find((value) => TRUE_TOKENS.has(value));
  const control = unique.find((value) => FALSE_TOKENS.has(value));
  if (treated !== undefined && control !== undefined) {
    return [treated, control];
  }
  return [unique[1], unique[0]];
}
