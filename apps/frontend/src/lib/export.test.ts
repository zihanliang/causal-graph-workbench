import { afterEach, describe, expect, test, vi } from "vitest";

import { buildMarkdownReport, openAnalysisPdf, parseProjectSnapshotText } from "./export";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("export helpers", () => {
  test("parseProjectSnapshotText validates the saved project shape", () => {
    const snapshot = parseProjectSnapshotText(`{
      "version": "0.2.0",
      "savedAt": "2026-03-29T00:00:00.000Z",
      "graph": { "nodes": [], "edges": [], "treatmentId": null, "outcomeId": null },
      "dataContext": { "hasData": false, "treatmentType": "unknown", "outcomeType": "unknown", "datasetName": null, "highDimensional": false, "columnBindings": {} },
      "uploadedDataset": null
    }`);

    expect(snapshot.version).toBe("0.2.0");
    expect(snapshot.graph.nodes).toEqual([]);
  });

  test("buildMarkdownReport includes the DAG disclaimer and recommended set", () => {
    const markdown = buildMarkdownReport(
      {
        nodes: [
          { id: "Z", label: "Z", x: 0, y: 0 },
          { id: "X", label: "X", x: 100, y: 0 },
          { id: "Y", label: "Y", x: 200, y: 0 },
        ],
        edges: [
          { id: "Z->X", source: "Z", target: "X" },
          { id: "Z->Y", source: "Z", target: "Y" },
          { id: "X->Y", source: "X", target: "Y" },
        ],
        treatmentId: "X",
        outcomeId: "Y",
      },
      {
        validation: { canAnalyze: true, issues: [] },
        graphStats: { nodeCount: 3, edgeCount: 3, openBackdoorPathCount: 1, directedPathCount: 1 },
        paths: [],
        nodeRoles: [],
        adjustmentSets: [
          {
            id: "adj-1",
            variables: ["Z"],
            isValid: true,
            isMinimal: true,
            isRecommended: true,
            practicalRating: "recommended",
            explanation: "Adjusting for {Z} blocks the open backdoor path.",
            blockedPathIds: ["path-1"],
            openedPathIds: [],
            practicalConcerns: [],
          },
        ],
        recommendedAdjustmentSet: ["Z"],
        forbiddenVariables: [],
        assumptions: [
          {
            id: "dag-correctness",
            title: "DAG correctness is assumed",
            description: "The tool does not verify the DAG is true. It only reasons conditionally on the DAG provided by the user.",
            category: "identification",
            level: "critical",
          },
        ],
        estimatorRecommendations: [],
        codeSnippets: [],
        dataDiagnostics: null,
      },
      { hasData: false, treatmentType: "unknown", outcomeType: "unknown", datasetName: null, highDimensional: false, columnBindings: {} },
    );

    expect(markdown).toContain("The tool does not verify the DAG is true.");
    expect(markdown).toContain("Recommended adjustment set: {Z}");
  });

  test("buildMarkdownReport does not misstate an empty recommended set when no valid backdoor adjustment exists", () => {
    const markdown = buildMarkdownReport(
      {
        nodes: [
          { id: "U", label: "U", x: 0, y: 0, observed: false },
          { id: "X", label: "X", x: 100, y: 0 },
          { id: "Y", label: "Y", x: 200, y: 0 },
        ],
        edges: [
          { id: "U->X", source: "U", target: "X" },
          { id: "U->Y", source: "U", target: "Y" },
        ],
        treatmentId: "X",
        outcomeId: "Y",
      },
      {
        validation: {
          canAnalyze: true,
          issues: [
            {
              severity: "warning",
              code: "no_valid_adjustment_set",
              message: "No valid observed adjustment set was found under backdoor adjustment.",
              nodeIds: [],
              edgeIds: [],
              details: [],
            },
          ],
        },
        graphStats: { nodeCount: 3, edgeCount: 2, openBackdoorPathCount: 1, directedPathCount: 0 },
        paths: [],
        nodeRoles: [],
        adjustmentSets: [],
        recommendedAdjustmentSet: [],
        forbiddenVariables: [],
        assumptions: [],
        estimatorRecommendations: [],
        codeSnippets: [],
        dataDiagnostics: null,
      },
      { hasData: false, treatmentType: "unknown", outcomeType: "unknown", datasetName: null, highDimensional: false, columnBindings: {} },
    );

    expect(markdown).toContain("Recommended adjustment set: none identified via backdoor adjustment");
    expect(markdown).toContain("No valid observed adjustment sets were identified under backdoor adjustment.");
    expect(markdown).not.toContain("Recommended adjustment set: {}");
  });

  test("openAnalysisPdf prints through a hidden iframe instead of a popup", () => {
    const originalCreateElement = document.createElement.bind(document);
    const fakePrintWindow = {
      focus: vi.fn(),
      print: vi.fn(),
      onafterprint: null as (() => void) | null,
    };

    let loadHandler: (() => void) | null = null;
    const fakeFrame = {
      id: "",
      style: {} as Record<string, string>,
      contentWindow: fakePrintWindow,
      setAttribute: vi.fn(),
      addEventListener: vi.fn((event: string, handler: () => void) => {
        if (event === "load") {
          loadHandler = handler;
        }
      }),
      remove: vi.fn(),
      set srcdoc(value: string) {
        void value;
        loadHandler?.();
      },
    } as unknown as HTMLIFrameElement;

    vi.spyOn(document, "getElementById").mockReturnValue(null);
    vi.spyOn(document, "createElement").mockImplementation(((tagName: string) => {
      if (tagName === "iframe") {
        return fakeFrame;
      }
      return originalCreateElement(tagName);
    }) as typeof document.createElement);
    vi.spyOn(document.body, "appendChild").mockImplementation(((node: Node) => node) as typeof document.body.appendChild);
    vi.spyOn(window, "setTimeout").mockImplementation(((handler: TimerHandler) => {
      if (typeof handler === "function") {
        handler();
      }
      return 1;
    }) as typeof window.setTimeout);
    vi.spyOn(window, "clearTimeout").mockImplementation(() => {});

    openAnalysisPdf(
      { nodes: [], edges: [], treatmentId: null, outcomeId: null },
      null,
      { hasData: false, treatmentType: "unknown", outcomeType: "unknown", datasetName: null, highDimensional: false, columnBindings: {} },
    );

    expect(document.body.appendChild).toHaveBeenCalledWith(fakeFrame);
    expect(fakePrintWindow.focus).toHaveBeenCalled();
    expect(fakePrintWindow.print).toHaveBeenCalled();
  });
});
