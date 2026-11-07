import type { GraphEdge, GraphSpec, PairState } from "@causal-graph-workbench/shared";

/** The graph with each pair set to this state. Kept apart from the engine, because the page uses it too. */
export function applyPairStates(graph: GraphSpec, states: PairState[]): GraphSpec {
  const inPair = (edge: GraphEdge) => states.some(({ first, second }) => (edge.source === first && edge.target === second) || (edge.source === second && edge.target === first));
  const arrows: GraphEdge[] = states.flatMap(({ first, second, state }) => {
    if (state === "none") {
      return [];
    }
    const [source, target] = state === "first_to_second" ? [first, second] : [second, first];
    return [{ id: `${source}->${target}`, source, target }];
  });
  return { ...graph, edges: [...graph.edges.filter((edge) => !inPair(edge)), ...arrows] };
}

/** What the graph says about a pair now. */
export function currentPairState(graph: GraphSpec, first: string, second: string): PairState["state"] {
  if (graph.edges.some((edge) => edge.source === first && edge.target === second)) {
    return "first_to_second";
  }
  return graph.edges.some((edge) => edge.source === second && edge.target === first) ? "second_to_first" : "none";
}
