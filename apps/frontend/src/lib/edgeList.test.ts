import { describe, expect, test } from "vitest";

import { graphToEdgeListText, parseEdgeListText } from "./edgeList";

describe("edge list parser", () => {
  test("parses edge list text into a graph", () => {
    const parsed = parseEdgeListText("Z -> X\nZ -> Y\nX -> Y");

    expect(parsed.graph.nodes.map((node) => node.id).sort()).toEqual(["X", "Y", "Z"]);
    expect(parsed.graph.edges.map((edge) => edge.id).sort()).toEqual(["X->Y", "Z->X", "Z->Y"]);
  });

  test("serializes isolated nodes as standalone lines", () => {
    const parsed = parseEdgeListText("Z -> X\nY");

    expect(graphToEdgeListText(parsed.graph)).toContain("Y");
  });
});

