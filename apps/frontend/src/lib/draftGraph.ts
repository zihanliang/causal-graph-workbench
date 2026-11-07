import type { DataContext, GraphEdge, GraphNode, GraphSpec, UncertainPair } from "@causal-graph-workbench/shared";

import { createNode, createNodeId, makeEdgeId } from "./edgeList";

/** When a column was fixed, relative to treatment. */
export type DraftRole = "before" | "after" | "unsure" | "leave";

export interface DraftColumn {
  name: string;
  role: DraftRole;
}

export interface Draft {
  graph: GraphSpec;
  columnBindings: NonNullable<DataContext["columnBindings"]>;
  uncertainPairs: UncertainPair[];
}

const COLUMN_GAP = 210;
const ROW_GAP = 104;
/** Beyond this many earlier variables, they wrap into another column, so that the graph stays large enough to read. */
const ROWS_PER_COLUMN = 7;

/**
 * A first graph that says only what time order allows: anything earlier may affect anything later. It has an arrow
 * for every such pair, because leaving one out would claim the two are unrelated, and the data would rightly object.
 * The arrows that bear on the question are drawn as usual, and the rest faintly, so that the graph can still be read.
 *
 * Variables whose timing is not known go with the earlier ones, and are marked as unsure against treatment, so that
 * the other possibility is tried as well.
 */
export function buildDraft(columns: DraftColumn[], treatment: string, outcome: string): Draft {
  const used = new Set<string>();
  const idOf = new Map<string, string>();
  for (const name of [treatment, outcome, ...columns.filter((column) => column.role !== "leave").map((column) => column.name)]) {
    const id = createNodeId(name, used);
    used.add(id);
    idOf.set(name, id);
  }
  const t = idOf.get(treatment)!;
  const y = idOf.get(outcome)!;
  const named = (role: DraftRole) => columns.filter((column) => column.role === role && column.name !== treatment && column.name !== outcome).map((column) => column.name);
  const unsure = named("unsure").map((name) => idOf.get(name)!);
  const before = [...named("before").map((name) => idOf.get(name)!), ...unsure];
  const after = named("after").map((name) => idOf.get(name)!);

  const edges: GraphEdge[] = [];
  const arrow = (source: string, target: string, background = false) => edges.push({ id: makeEdgeId(source, target), source, target, ...(background ? { background: true } : {}) });
  before.forEach((node, index) => {
    arrow(node, t);
    arrow(node, y);
    before.slice(index + 1).forEach((later) => arrow(node, later, true));
    after.forEach((later) => arrow(node, later, true));
  });
  arrow(t, y);
  after.forEach((node, index) => {
    arrow(t, node);
    arrow(node, y);
    after.slice(index + 1).forEach((later) => arrow(node, later, true));
  });

  // Earlier variables down the left, the later ones on the right, and treatment above the arrows that pass beneath it.
  const columnsOfEarlier = Math.max(1, Math.ceil(before.length / ROWS_PER_COLUMN));
  const treatmentX = 40 + columnsOfEarlier * COLUMN_GAP + COLUMN_GAP / 2;
  const laterX = treatmentX + COLUMN_GAP * 1.6;
  const rows = Math.max(Math.min(before.length, ROWS_PER_COLUMN), after.length + 1, 2);
  const nodes: GraphNode[] = [
    ...before.map((id, index) => {
      const column = Math.floor(index / ROWS_PER_COLUMN);
      const row = index % ROWS_PER_COLUMN;
      return { ...createNode(id, 40 + column * COLUMN_GAP + (row % 2) * 70, 90 + row * ROW_GAP), ...(unsure.includes(id) ? {} : { timing: "before" as const }) };
    }),
    { ...createNode(t, treatmentX, 0) },
    ...after.map((id, index) => ({ ...createNode(id, laterX + (index % 2) * 70, index * ROW_GAP), timing: "after" as const })),
    { ...createNode(y, treatmentX + COLUMN_GAP, 90 + rows * ROW_GAP) },
  ];

  return {
    graph: { nodes, edges, treatmentId: t, outcomeId: y },
    columnBindings: Object.fromEntries([...idOf].map(([name, id]) => [id, name])),
    uncertainPairs: unsure.map((node) => ({ first: node, second: t })),
  };
}

/** A column that identifies rows, or never changes, cannot be a cause of anything. */
export function looksUnusable(values: string[], name: string): boolean {
  const present = values.filter((value) => value !== "");
  const distinct = new Set(present).size;
  if (distinct <= 1) {
    return true;
  }
  const isNumeric = present.every((value) => !Number.isNaN(Number(value)));
  const allDifferent = distinct === present.length;
  return allDifferent && (!isNumeric || /(^|[_\s-])id$/i.test(name) || /^id$/i.test(name));
}
