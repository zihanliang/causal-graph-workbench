import { beforeEach, describe, expect, test } from "vitest";

import { useWorkbenchStore } from "./useWorkbenchStore";

describe("workbench store", () => {
  beforeEach(() => {
    useWorkbenchStore.setState({
      graph: {
        nodes: [
          { id: "Z", label: "Z", x: 0, y: 0 },
          { id: "X", label: "X", x: 100, y: 0 },
          { id: "Y", label: "Y", x: 200, y: 0 },
        ],
        edges: [
          { id: "Z->X", source: "Z", target: "X" },
          { id: "Z->Y", source: "Z", target: "Y" },
        ],
        treatmentId: "X",
        outcomeId: "Y",
      },
      textDraft: "Z -> X\nZ -> Y",
      parseError: null,
      uploadedDataset: null,
      selectedExplainable: null,
      highlightedPathId: null,
    });
  });

  test("removing a node clears treatment and outcome selection when needed", () => {
    useWorkbenchStore.getState().removeNode("X");
    expect(useWorkbenchStore.getState().graph.treatmentId).toBeNull();

    useWorkbenchStore.getState().removeNode("Y");
    expect(useWorkbenchStore.getState().graph.outcomeId).toBeNull();
  });

  test("importFromText updates the single graph source of truth", () => {
    useWorkbenchStore.setState({ textDraft: "U -> X\nU -> Y\nX -> Y" });
    useWorkbenchStore.getState().importFromText();

    const state = useWorkbenchStore.getState();
    expect(state.graph.nodes.map((node) => node.id).sort()).toEqual(["U", "X", "Y"]);
    expect(state.graph.edges.map((edge) => edge.id).sort()).toEqual(["U->X", "U->Y", "X->Y"]);
    expect(state.parseError).toBeNull();
  });

  test("setTextDraft reports parser errors immediately without mutating the graph", () => {
    const previousNodeIds = useWorkbenchStore.getState().graph.nodes.map((node) => node.id);
    useWorkbenchStore.getState().setTextDraft("X - Y");

    const state = useWorkbenchStore.getState();
    expect(state.parseError).toContain('Unable to parse line: "X - Y"');
    expect(state.graph.nodes.map((node) => node.id)).toEqual(previousNodeIds);
  });

  test("renameNode rewires edges and preserves treatment outcome references", () => {
    useWorkbenchStore.getState().renameNode("X", "Treatment");

    const state = useWorkbenchStore.getState();
    expect(state.graph.nodes.map((node) => node.id).sort()).toEqual(["Treatment", "Y", "Z"]);
    expect(state.graph.edges.map((edge) => edge.id).sort()).toEqual(["Z->Treatment", "Z->Y"]);
    expect(state.graph.treatmentId).toBe("Treatment");
  });

  test("clearGraph resets the workspace to a usable empty state", () => {
    useWorkbenchStore.setState({
      analysis: { validation: { canAnalyze: true, issues: [] } } as never,
      apiError: "stale error",
      activeTab: "paths",
    });

    useWorkbenchStore.getState().clearGraph();

    const state = useWorkbenchStore.getState();
    expect(state.graph.nodes).toEqual([]);
    expect(state.analysis).toBeNull();
    expect(state.apiError).toBeNull();
    expect(state.activeTab).toBe("summary");
  });
});
