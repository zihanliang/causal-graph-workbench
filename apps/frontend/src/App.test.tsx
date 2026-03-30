import { act, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import App from "./App";
import { useWorkbenchStore } from "./store/useWorkbenchStore";

const analyzeGraph = vi.fn();
const fetchTemplates = vi.fn();

vi.mock("./api/client", () => ({
  analyzeGraph: (...args: unknown[]) => analyzeGraph(...args),
  fetchTemplates: (...args: unknown[]) => fetchTemplates(...args),
}));

vi.mock("./components/TopBar", () => ({
  TopBar: () => <div>topbar</div>,
}));

vi.mock("./components/BuilderSidebar", () => ({
  BuilderSidebar: () => <div>builder</div>,
}));

vi.mock("./components/CanvasWorkspace", () => ({
  CanvasWorkspace: () => <div>canvas</div>,
}));

vi.mock("./components/ResultsPanel", () => ({
  ResultsPanel: () => <div>results</div>,
}));

vi.mock("./components/ExplainPanel", () => ({
  ExplainPanel: () => <div>explain</div>,
}));

describe("App analysis sync", () => {
  beforeEach(() => {
    // Tell React that the test environment supports wrapped updates.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
    vi.useFakeTimers();
    analyzeGraph.mockReset();
    fetchTemplates.mockReset();
    fetchTemplates.mockResolvedValue([]);
    analyzeGraph.mockResolvedValue({
      validation: { canAnalyze: true, issues: [] },
      graphStats: { nodeCount: 3, edgeCount: 2, openBackdoorPathCount: 0, directedPathCount: 1 },
      paths: [],
      nodeRoles: [],
      adjustmentSets: [],
      recommendedAdjustmentSet: [],
      forbiddenVariables: [],
      assumptions: [],
      estimatorRecommendations: [],
      codeSnippets: [],
      dataDiagnostics: null,
    });

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
      templates: [],
      analysis: null,
      uploadedDataset: null,
      activeTab: "summary",
      textDraft: "Z -> X\nX -> Y",
      parseError: null,
      isAnalyzing: false,
      apiError: null,
      selectedExplainable: null,
      highlightedPathId: null,
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  test("graph changes trigger a fresh backend analysis request", async () => {
    render(<App />);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(400);
    });

    expect(analyzeGraph).toHaveBeenCalledTimes(1);
    expect(analyzeGraph.mock.calls[0][0].graph.nodes).toHaveLength(3);

    act(() => {
      useWorkbenchStore.getState().addNode("W");
    });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(400);
    });

    expect(analyzeGraph).toHaveBeenCalledTimes(2);
    expect(analyzeGraph.mock.calls[1][0].graph.nodes).toHaveLength(4);
  });
});
