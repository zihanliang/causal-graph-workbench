import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import App from "./App";
import { useWorkbenchStore } from "./store/useWorkbenchStore";

const analyzeGraph = vi.fn();

vi.mock("./engine/client", () => ({
  analyzeGraph: (...args: unknown[]) => analyzeGraph(...args),
}));

vi.mock("./components/TopBar", () => ({
  TopBar: () => <div>topbar</div>,
}));

vi.mock("./components/StartScreen", () => ({
  StartScreen: () => <div>start</div>,
}));

vi.mock("./components/CanvasWorkspace", () => ({
  CanvasWorkspace: () => <div>canvas</div>,
}));

vi.mock("./components/StepPanel", () => ({
  StepPanel: () => <div>panel</div>,
}));

const emptyResult = {
  validation: { canAnalyze: true, issues: [] },
  graphStats: { nodeCount: 3, edgeCount: 2, openBackdoorPathCount: 0, directedPathCount: 1 },
  paths: [],
  nodeRoles: [],
  adjustmentSets: [],
  recommendedAdjustmentSet: [],
  forbiddenVariables: [],
  cautionVariables: [],
  limits: { pathsTruncated: false, adjustmentSetsTruncated: false },
  baselineSet: null,
  effect: null,
  sensitivity: null,
  audit: null,
  comparison: null,
  scan: null,
  reproduction: null,
  assumptions: [],
  estimatorRecommendations: [],
  codeSnippets: [],
  dataDiagnostics: null,
};

describe("App analysis sync", () => {
  beforeEach(() => {
    // Tell React that the test environment supports wrapped updates.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
    vi.useFakeTimers();
    analyzeGraph.mockReset();
    analyzeGraph.mockResolvedValue(emptyResult);

    useWorkbenchStore.setState({
      graph: {
        nodes: [
          { id: "Z", label: "Z", x: 0, y: 0 },
          { id: "X", label: "X", x: 100, y: 0 },
          { id: "Y", label: "Y", x: 200, y: 0 },
        ],
        edges: [
          { id: "Z->X", source: "Z", target: "X" },
          { id: "X->Y", source: "X", target: "Y" },
        ],
        treatmentId: "X",
        outcomeId: "Y",
      },
      dataContext: {
        hasData: false,
        treatmentType: "unknown",
        outcomeType: "unknown",
        datasetName: null,
        highDimensional: false,
        columnBindings: {},
      },
      analysis: null,
      uploadedDataset: null,
      activeTab: "assumptions",
      textDraft: "Z -> X\nX -> Y",
      parseError: null,
      isAnalyzing: false,
      analysisError: null,
      selectedExplainable: null,
      highlightedPathId: null,
    });
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  async function settle() {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(400);
    });
  }

  test("graph changes trigger a fresh analysis", async () => {
    render(<App />);
    await settle();

    expect(analyzeGraph).toHaveBeenCalledTimes(1);
    expect(analyzeGraph.mock.calls[0][0].graph.nodes).toHaveLength(3);

    act(() => {
      useWorkbenchStore.getState().addNode("W");
    });
    await settle();

    expect(analyzeGraph).toHaveBeenCalledTimes(2);
    expect(analyzeGraph.mock.calls[1][0].graph.nodes).toHaveLength(4);
  });

  test("showing another graph keeps the comparison on the page until the new one arrives", async () => {
    const comparison = { status: "complete", shownId: "graph-a", graphs: [], answers: [], sharedSet: null, sameClaims: [] };
    useWorkbenchStore.getState().addVersion({ edit: "add", source: "Z", target: "Y" });
    analyzeGraph.mockResolvedValueOnce({ ...emptyResult, comparison });
    render(<App />);
    await settle();
    expect(useWorkbenchStore.getState().analysis?.comparison?.shownId).toBe("graph-a");

    analyzeGraph.mockResolvedValueOnce({ ...emptyResult, comparison: null });
    act(() => useWorkbenchStore.getState().selectVersion("graph-b"));
    await settle();
    expect(useWorkbenchStore.getState().analysis?.comparison?.shownId).toBe("graph-b");

    // Changing a graph changes the comparison, so the old one must not linger.
    analyzeGraph.mockResolvedValueOnce({ ...emptyResult, comparison: null });
    act(() => useWorkbenchStore.getState().connectNodes("Y", "Z"));
    await settle();
    expect(useWorkbenchStore.getState().analysis?.comparison).toBeNull();
    act(() => useWorkbenchStore.getState().removeVersion("graph-b"));
    await settle();
  });

  test("dragging a node does not rerun the analysis", async () => {
    render(<App />);
    await settle();
    expect(analyzeGraph).toHaveBeenCalledTimes(1);

    act(() => {
      useWorkbenchStore.getState().updateNodePosition("X", 300, 300);
    });
    await settle();

    expect(analyzeGraph).toHaveBeenCalledTimes(1);
  });

  test("progress is shown while the analysis is still running", async () => {
    const partial = { ...emptyResult, graphStats: { ...emptyResult.graphStats, nodeCount: 99 } };
    analyzeGraph.mockImplementation((_request, onProgress) => {
      onProgress(partial);
      return new Promise(() => {});
    });
    render(<App />);
    await settle();
    expect(useWorkbenchStore.getState().analysis?.graphStats.nodeCount).toBe(99);
    expect(useWorkbenchStore.getState().isAnalyzing).toBe(true);
  });

  test("marking when a variable is fixed reruns the analysis", async () => {
    render(<App />);
    await settle();
    act(() => {
      useWorkbenchStore.getState().setNodeTiming("Z", "baseline");
    });
    await settle();
    expect(analyzeGraph).toHaveBeenCalledTimes(2);
  });

  test("an engine failure is shown as an error, not silently dropped", async () => {
    analyzeGraph.mockRejectedValue(new Error("bad input"));
    render(<App />);
    await settle();
    expect(useWorkbenchStore.getState().analysisError).toBe("bad input");
    expect(useWorkbenchStore.getState().analysis).toBeNull();
  });
});
