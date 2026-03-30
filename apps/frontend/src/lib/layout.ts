import type { GraphSpec } from "@causal-graph-workbench/shared";

export function layoutGraph(graph: GraphSpec): GraphSpec {
  const incoming = new Map<string, number>();
  const outgoing = new Map<string, string[]>();
  const indegree = new Map<string, number>();

  for (const node of graph.nodes) {
    incoming.set(node.id, 0);
    indegree.set(node.id, 0);
    outgoing.set(node.id, []);
  }

  for (const edge of graph.edges) {
    indegree.set(edge.target, (indegree.get(edge.target) ?? 0) + 1);
    outgoing.set(edge.source, [...(outgoing.get(edge.source) ?? []), edge.target]);
  }

  const queue = Array.from(indegree.entries())
    .filter(([, count]) => count === 0)
    .map(([nodeId]) => nodeId);
  const layerMap = new Map<string, number>();
  const visited: string[] = [];

  while (queue.length) {
    const nodeId = queue.shift()!;
    visited.push(nodeId);
    const currentLayer = layerMap.get(nodeId) ?? 0;
    for (const target of outgoing.get(nodeId) ?? []) {
      const nextLayer = Math.max(layerMap.get(target) ?? 0, currentLayer + 1);
      layerMap.set(target, nextLayer);
      indegree.set(target, (indegree.get(target) ?? 1) - 1);
      if ((indegree.get(target) ?? 0) === 0) {
        queue.push(target);
      }
    }
  }

  const shouldFallbackToGrid = visited.length !== graph.nodes.length;
  if (shouldFallbackToGrid) {
    return {
      ...graph,
      nodes: graph.nodes.map((node, index) => ({
        ...node,
        x: node.x || 120 + (index % 3) * 220,
        y: node.y || 120 + Math.floor(index / 3) * 140,
      })),
    };
  }

  const layers = new Map<number, string[]>();
  for (const node of graph.nodes) {
    const layer = layerMap.get(node.id) ?? 0;
    layers.set(layer, [...(layers.get(layer) ?? []), node.id]);
  }

  const positioned = graph.nodes.map((node) => {
    const layer = layerMap.get(node.id) ?? 0;
    const layerNodes = (layers.get(layer) ?? []).slice().sort();
    const row = layerNodes.indexOf(node.id);
    return {
      ...node,
      x: node.x || 120 + layer * 230,
      y: node.y || 100 + row * 150,
    };
  });

  return { ...graph, nodes: positioned };
}

