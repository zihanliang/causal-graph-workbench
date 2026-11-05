import { describe, expect, test } from "vitest";

import { graphToEdgeListText, parseEdgeListText, sanitizeVariableName } from "./edgeList";

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

  test("marks unmeasured variables, and round-trips them through the text", () => {
    const { graph } = parseEdgeListText("U -> X\nU -> Y\nX -> Y\nU [unobserved]");
    expect(graph.nodes.find((node) => node.id === "U")!.observed).toBe(false);
    expect(graph.nodes.find((node) => node.id === "X")!.observed).toBe(true);

    const text = graphToEdgeListText(graph);
    expect(text).toContain("U [unobserved]");
    expect(parseEdgeListText(text).graph.nodes.find((node) => node.id === "U")!.observed).toBe(false);
  });

  test("accepts [latent] as well", () => {
    expect(parseEdgeListText("U [latent]").graph.nodes[0].observed).toBe(false);
  });

  test("removing the marker makes a variable measured again, and timing survives editing", () => {
    const existing = {
      nodes: [{ id: "Z", label: "Z", x: 5, y: 6, observed: false, timing: "baseline" as const }],
      treatmentId: null,
      outcomeId: null,
    };
    const node = parseEdgeListText("Z -> X", existing).graph.nodes.find((item) => item.id === "Z")!;
    expect(node.observed).toBe(true);
    expect(node.timing).toBe("baseline");
    expect(node.x).toBe(5);
  });

  test("still rejects anything else", () => {
    expect(() => parseEdgeListText("U [secret]")).toThrow(/Unable to parse/);
  });
});

describe("names in any script", () => {
  test("Chinese names survive typing, text and the arrow syntax", () => {
    expect(sanitizeVariableName("教育 年限")).toBe("教育_年限");
    const { graph } = parseEdgeListText("教育 -> 收入\n年龄 [unobserved]");
    expect(graph.nodes.map((node) => node.id).sort()).toEqual(["年龄", "收入", "教育"].sort());
    expect(graph.nodes.find((node) => node.id === "年龄")!.observed).toBe(false);
  });

  test("a name still cannot start with a number, and symbols still go", () => {
    expect(sanitizeVariableName("9lives")).toBe("V_9lives");
    expect(sanitizeVariableName("a-b/c")).toBe("abc");
  });
});
