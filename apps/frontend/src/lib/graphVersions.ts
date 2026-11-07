import type { AssumptionEdit, GraphSpec, GraphVersion } from "@causal-graph-workbench/shared";

import { createNode, createNodeId, makeEdgeId } from "./edgeList";

/** More than this and the comparison stops being readable. */
export const MAX_GRAPH_VERSIONS = 6;
/** Every combination is tried, three ways per pair, so this makes 81 at most. */
export const MAX_UNCERTAIN_PAIRS = 4;

const NAME_LETTERS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";

/** A change to the graph that the user is considering: an arrow, or something unmeasured behind two variables. */
export type GraphChange = { edit: AssumptionEdit | "unmeasured"; source: string; target: string };

/** Everything analysis depends on. Moving a node on the canvas does not change it, nor does the order things were drawn in. */
export function structuralKey(graph: GraphSpec): string {
  return JSON.stringify({
    nodes: graph.nodes.map((node) => [node.id, node.observed !== false, node.timing ?? null]).sort((left, right) => String(left[0]).localeCompare(String(right[0]))),
    edges: graph.edges.map((edge) => [edge.source, edge.target]).sort((left, right) => `${left[0]}|${left[1]}`.localeCompare(`${right[0]}|${right[1]}`)),
    treatment: graph.treatmentId,
    outcome: graph.outcomeId,
  });
}

export const samePair = (left: { first: string; second: string }, right: { first: string; second: string }) =>
  (left.first === right.first && left.second === right.second) || (left.first === right.second && left.second === right.first);

export function firstVersion(graph: GraphSpec): { versions: GraphVersion[]; activeVersionId: string } {
  return { versions: [{ id: "graph-a", name: "Graph A", graph }], activeVersionId: "graph-a" };
}

/** The store edits the open graph directly, so its entry in the list can be behind. */
export function currentVersions(state: { versions: GraphVersion[]; activeVersionId: string; graph: GraphSpec }): GraphVersion[] {
  return state.versions.map((version) => (version.id === state.activeVersionId ? { ...version, graph: state.graph } : version));
}

/** The first letter not in use, so that a removed graph's name can be used again. */
export function nextVersionIdentity(versions: GraphVersion[]): { id: string; name: string } {
  const letter = [...NAME_LETTERS].find((item) => !versions.some((version) => version.name === `Graph ${item}`)) ?? String(versions.length + 1);
  return { id: `graph-${letter.toLowerCase()}`, name: `Graph ${letter}` };
}

function placeUnmeasured(graph: GraphSpec, source: string, target: string): [number, number] {
  const from = graph.nodes.find((node) => node.id === source);
  const to = graph.nodes.find((node) => node.id === target);
  const x = from && to ? (from.x + to.x) / 2 : 100;
  let y = from && to ? Math.min(from.y, to.y) - 110 : 100;
  while (graph.nodes.some((node) => Math.abs(node.x - x) < 160 && Math.abs(node.y - y) < 80)) {
    y -= 90;
  }
  return [x, y];
}

export function applyChange(graph: GraphSpec, { edit, source, target }: GraphChange): GraphSpec {
  if (edit === "unmeasured") {
    const id = createNodeId("U", new Set(graph.nodes.map((node) => node.id)));
    return {
      ...graph,
      nodes: [...graph.nodes, { ...createNode(id, ...placeUnmeasured(graph, source, target)), observed: false }],
      edges: [...graph.edges, { id: makeEdgeId(id, source), source: id, target: source }, { id: makeEdgeId(id, target), source: id, target }],
    };
  }
  const without = graph.edges.filter((item) => !(item.source === source && item.target === target));
  const edges =
    edit === "remove"
      ? without
      : edit === "reverse"
        ? [...without, { id: makeEdgeId(target, source), source: target, target: source }]
        : [...graph.edges, { id: makeEdgeId(source, target), source, target }];
  return { ...graph, edges };
}

export function renameInGraph(graph: GraphSpec, nodeId: string, nextId: string): GraphSpec {
  return {
    ...graph,
    nodes: graph.nodes.map((node) => (node.id === nodeId ? { ...node, id: nextId, label: nextId } : node)),
    edges: graph.edges.map((edge) => {
      const source = edge.source === nodeId ? nextId : edge.source;
      const target = edge.target === nodeId ? nextId : edge.target;
      return { ...edge, source, target, id: makeEdgeId(source, target) };
    }),
    treatmentId: graph.treatmentId === nodeId ? nextId : graph.treatmentId,
    outcomeId: graph.outcomeId === nodeId ? nextId : graph.outcomeId,
  };
}

/** The letter is enough where a graph is named many times over. */
export function shortName(name: string): string {
  return name.replace(/^Graph /, "");
}
