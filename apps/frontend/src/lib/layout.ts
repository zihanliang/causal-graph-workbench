import type { GraphSpec } from "@causal-graph-workbench/shared";

const COLUMN_GAP = 210;
const ROW_GAP = 130;
const ORIGIN = { x: 60, y: 60 };
/** How far an arrow must stay from the centre of a variable it does not connect to. */
const CLEARANCE = 44;

/**
 * Places any variable without a position, left to right in causal order. Arrows are drawn straight,
 * so within a column variables are ordered to shorten them and moved aside from any arrow that
 * would otherwise run behind them.
 */
export function layoutGraph(graph: GraphSpec): GraphSpec {
  const layers = causalLayers(graph);
  if (!layers) {
    return {
      ...graph,
      nodes: graph.nodes.map((node, index) => ({
        ...node,
        x: node.x || 120 + (index % 3) * 220,
        y: node.y || 120 + Math.floor(index / 3) * 140,
      })),
    };
  }

  const position = placeInColumns(graph, layers);
  moveAsideFromArrows(graph, layers, position);

  const lowest = Math.min(...[...position.values()].map((point) => point.y));
  const shift = ORIGIN.y - lowest;
  return {
    ...graph,
    nodes: graph.nodes.map((node) => {
      const point = position.get(node.id)!;
      return { ...node, x: node.x || point.x, y: node.y || point.y + shift };
    }),
  };
}

/** The longest chain of arrows leading to each variable, or null if the arrows form a cycle. */
function causalLayers(graph: GraphSpec): Map<string, number> | null {
  const indegree = new Map(graph.nodes.map((node) => [node.id, 0]));
  const outgoing = new Map<string, string[]>(graph.nodes.map((node) => [node.id, []]));
  for (const edge of graph.edges) {
    indegree.set(edge.target, (indegree.get(edge.target) ?? 0) + 1);
    outgoing.get(edge.source)?.push(edge.target);
  }

  const queue = graph.nodes.map((node) => node.id).filter((id) => indegree.get(id) === 0);
  const layers = new Map(queue.map((id) => [id, 0]));
  let visited = 0;
  while (queue.length) {
    const id = queue.shift()!;
    visited += 1;
    for (const target of outgoing.get(id) ?? []) {
      layers.set(target, Math.max(layers.get(target) ?? 0, (layers.get(id) ?? 0) + 1));
      indegree.set(target, (indegree.get(target) ?? 1) - 1);
      if (indegree.get(target) === 0) {
        queue.push(target);
      }
    }
  }
  return visited === graph.nodes.length ? layers : null;
}

function placeInColumns(graph: GraphSpec, layers: Map<string, number>): Map<string, { x: number; y: number }> {
  const columns = new Map<number, string[]>();
  for (const node of [...graph.nodes].sort((left, right) => left.id.localeCompare(right.id))) {
    const layer = layers.get(node.id) ?? 0;
    columns.set(layer, [...(columns.get(layer) ?? []), node.id]);
  }

  // Order each column by the average height of the variables pointing into it, then centre it.
  const rows = new Map<string, number>();
  const parents = new Map<string, string[]>(graph.nodes.map((node) => [node.id, []]));
  for (const edge of graph.edges) {
    parents.get(edge.target)?.push(edge.source);
  }
  const position = new Map<string, { x: number; y: number }>();
  for (const layer of [...columns.keys()].sort((left, right) => left - right)) {
    const column = columns.get(layer)!;
    const pull = (id: string) => {
      const heights = parents.get(id)!.map((parent) => rows.get(parent)).filter((value): value is number => value !== undefined);
      return heights.length ? heights.reduce((sum, value) => sum + value, 0) / heights.length : 0;
    };
    const ordered = [...column].sort((left, right) => pull(left) - pull(right));
    ordered.forEach((id, index) => {
      const row = index - (ordered.length - 1) / 2;
      rows.set(id, row);
      position.set(id, { x: ORIGIN.x + layer * COLUMN_GAP, y: row * ROW_GAP });
    });
  }
  return position;
}

function moveAsideFromArrows(graph: GraphSpec, layers: Map<string, number>, position: Map<string, { x: number; y: number }>) {
  const longArrows = graph.edges.filter((edge) => (layers.get(edge.target) ?? 0) - (layers.get(edge.source) ?? 0) > 1);
  // Once a variable has moved one way it keeps going that way, so it leaves a bundle of arrows
  // rather than bouncing between two of them.
  const direction = new Map<string, number>();
  for (let pass = 0; pass < 40; pass += 1) {
    let moved = false;
    for (const edge of longArrows) {
      const from = position.get(edge.source);
      const to = position.get(edge.target);
      if (!from || !to) {
        continue;
      }
      for (const [id, point] of position) {
        const isBetween = point.x > from.x && point.x < to.x;
        if (!isBetween || id === edge.source || id === edge.target) {
          continue;
        }
        const lineY = from.y + ((to.y - from.y) * (point.x - from.x)) / (to.x - from.x);
        const distance = point.y - lineY;
        if (Math.abs(distance) < CLEARANCE) {
          const way = direction.get(id) ?? (distance >= 0 ? 1 : -1);
          direction.set(id, way);
          point.y = lineY + way * (CLEARANCE + 20);
          moved = true;
        }
      }
    }
    if (!moved) {
      return;
    }
  }
}
