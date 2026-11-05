import type { GraphSpec } from "@causal-graph-workbench/shared";
import { describe, expect, test } from "vitest";

import { layoutGraph } from "./layout";

function unplaced(edges: [string, string][]): GraphSpec {
  const ids = [...new Set(edges.flat())];
  return {
    nodes: ids.map((id) => ({ id, label: id, x: 0, y: 0 })),
    edges: edges.map(([source, target]) => ({ id: `${source}->${target}`, source, target })),
    treatmentId: null,
    outcomeId: null,
  };
}

/** Variables an arrow runs behind, given arrows are drawn as straight lines between centres. */
function arrowsBehindVariables(graph: GraphSpec): string[] {
  const at = new Map(graph.nodes.map((node) => [node.id, node]));
  const hits: string[] = [];
  for (const edge of graph.edges) {
    const from = at.get(edge.source)!;
    const to = at.get(edge.target)!;
    for (const node of graph.nodes) {
      if (node.id === edge.source || node.id === edge.target || node.x <= from.x || node.x >= to.x) {
        continue;
      }
      const lineY = from.y + ((to.y - from.y) * (node.x - from.x)) / (to.x - from.x);
      if (Math.abs(node.y - lineY) < 30) {
        hits.push(`${edge.id} behind ${node.id}`);
      }
    }
  }
  return hits;
}

describe("graph layout", () => {
  test("arrows run left to right in causal order", () => {
    const { nodes } = layoutGraph(unplaced([["Z", "X"], ["X", "M"], ["M", "Y"]]));
    const x = (id: string) => nodes.find((node) => node.id === id)!.x;
    expect(x("Z")).toBeLessThan(x("X"));
    expect(x("X")).toBeLessThan(x("M"));
    expect(x("M")).toBeLessThan(x("Y"));
  });

  test("a direct arrow does not run behind the mediator it skips", () => {
    const graph = layoutGraph(unplaced([["X", "M"], ["M", "Y"], ["X", "Y"]]));
    expect(arrowsBehindVariables(graph)).toEqual([]);
  });

  test("a denser graph stays clear of its long arrows", () => {
    const graph = layoutGraph(
      unplaced([
        ["A", "X"],
        ["A", "Y"],
        ["B", "M"],
        ["B", "Y"],
        ["X", "M"],
        ["M", "N"],
        ["N", "Y"],
        ["X", "Y"],
        ["X", "N"],
      ]),
    );
    expect(arrowsBehindVariables(graph)).toEqual([]);
  });

  test("variables already placed stay where they are", () => {
    const graph = unplaced([["X", "Y"]]);
    graph.nodes[0] = { ...graph.nodes[0], x: 500, y: 300 };
    const placed = layoutGraph(graph).nodes.find((node) => node.id === "X")!;
    expect([placed.x, placed.y]).toEqual([500, 300]);
  });

  test("every variable gets a place even if the arrows form a cycle", () => {
    const { nodes } = layoutGraph(unplaced([["A", "B"], ["B", "A"]]));
    expect(nodes.every((node) => node.x > 0 && node.y > 0)).toBe(true);
  });
});
