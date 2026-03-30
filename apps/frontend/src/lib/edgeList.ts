import type { GraphEdge, GraphNode, GraphSpec } from "@causal-workbench/shared";

import { layoutGraph } from "./layout";

const EDGE_PATTERN = /^([A-Za-z_][A-Za-z0-9_]*)\s*->\s*([A-Za-z_][A-Za-z0-9_]*)$/;
const NODE_PATTERN = /^([A-Za-z_][A-Za-z0-9_]*)$/;

export interface ParsedEdgeList {
  graph: GraphSpec;
  warnings: string[];
}

export function graphToEdgeListText(graph: GraphSpec): string {
  const edgeLines = graph.edges
    .slice()
    .sort((left, right) => left.source.localeCompare(right.source) || left.target.localeCompare(right.target))
    .map((edge) => `${edge.source} -> ${edge.target}`);

  const connected = new Set(graph.edges.flatMap((edge) => [edge.source, edge.target]));
  const standaloneNodeLines = graph.nodes
    .map((node) => node.id)
    .filter((nodeId) => !connected.has(nodeId))
    .sort();

  return [...edgeLines, ...standaloneNodeLines].join("\n");
}

export function parseEdgeListText(text: string, existing?: Partial<GraphSpec>): ParsedEdgeList {
  const warnings: string[] = [];
  const nodes = new Map<string, GraphNode>();
  const edges: GraphEdge[] = [];
  const positions = new Map((existing?.nodes ?? []).map((node) => [node.id, node]));

  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  for (const line of lines) {
    const edgeMatch = line.match(EDGE_PATTERN);
    if (edgeMatch) {
      const [, source, target] = edgeMatch;
      upsertNode(nodes, positions, source);
      upsertNode(nodes, positions, target);
      edges.push({ id: makeEdgeId(source, target), source, target });
      continue;
    }
    const nodeMatch = line.match(NODE_PATTERN);
    if (nodeMatch) {
      upsertNode(nodes, positions, nodeMatch[1]);
      continue;
    }
    throw new Error(`Unable to parse line: "${line}"`);
  }

  const graph: GraphSpec = layoutGraph({
    nodes: Array.from(nodes.values()),
    edges,
    treatmentId: existing?.treatmentId ?? null,
    outcomeId: existing?.outcomeId ?? null,
  });

  if (!graph.nodes.length) {
    warnings.push("No nodes were parsed from the text input.");
  }

  return { graph, warnings };
}

export function sanitizeVariableName(raw: string): string {
  const trimmed = raw.trim().replace(/\s+/g, "_").replace(/[^A-Za-z0-9_]/g, "");
  const normalized = /^[A-Za-z_]/.test(trimmed) ? trimmed : `V_${trimmed || "node"}`;
  return normalized;
}

export function createNode(nodeId: string, x = 0, y = 0): GraphNode {
  return {
    id: nodeId,
    label: nodeId,
    x,
    y,
    observed: true,
  };
}

export function createNodeId(label: string, usedIds: Set<string>): string {
  const base = sanitizeVariableName(label);
  if (!usedIds.has(base)) {
    return base;
  }
  let index = 2;
  while (usedIds.has(`${base}_${index}`)) {
    index += 1;
  }
  return `${base}_${index}`;
}

export function makeEdgeId(source: string, target: string): string {
  return `${source}->${target}`;
}

function upsertNode(
  nodes: Map<string, GraphNode>,
  positions: Map<string, Partial<GraphNode>>,
  nodeId: string,
): void {
  if (nodes.has(nodeId)) {
    return;
  }
  const existing = positions.get(nodeId);
  nodes.set(
    nodeId,
    createNode(nodeId, existing?.x ?? 0, existing?.y ?? 0),
  );
}

