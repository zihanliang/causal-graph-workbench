import { afterEach, describe, expect, test, vi } from "vitest";

import { analyze } from "../engine/analyze";
import { buildGraphSvg, buildMarkdownReport, buildPrintableReportHtml, openAnalysisPdf, parseProjectSnapshotText } from "./export";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("project files", () => {
  test.each(["{ not json", "", "[1, 2]", '{"hello": "world"}'])("%j gets one plain message, not a parser's", (text) => {
    expect(() => parseProjectSnapshotText(text)).toThrow("That file could not be opened, because it is not a project saved from this app.");
  });
});

describe("the printable report", () => {
  const graph = {
    nodes: [
      { id: "Z", label: "Z", x: 200, y: 20 },
      { id: "X", label: "X", x: 20, y: 200 },
      { id: "Y", label: "Y", x: 400, y: 200 },
    ],
    edges: [
      { id: "Z->X", source: "Z", target: "X" },
      { id: "Z->Y", source: "Z", target: "Y" },
      { id: "X->Y", source: "X", target: "Y" },
    ],
    treatmentId: "X",
    outcomeId: "Y",
  };
  const html = buildPrintableReportHtml(graph, analyze({ graph }));

  test("leaves printing to the page that asks, so the dialog cannot open twice", () => {
    expect(html).not.toMatch(/<script/i);
    expect(html).not.toContain("print()");
  });

  test("the frame it prints from has the size of a page, because a 0 by 0 frame can collapse the report", () => {
    vi.useFakeTimers();
    const frames: HTMLIFrameElement[] = [];
    const append = vi.spyOn(document.body, "appendChild").mockImplementation((node) => {
      frames.push(node as HTMLIFrameElement);
      return node;
    });
    openAnalysisPdf(graph, analyze({ graph }));
    append.mockRestore();
    vi.useRealTimers();
    expect(frames[0].style.width).toBe("794px");
    expect(frames[0].style.height).toBe("1123px");
    expect(frames[0].style.left).toBe("-10000px");
  });

  test("has the graph in it, as a drawing", () => {
    expect(html).toContain("<svg");
    expect(html).not.toContain("<?xml");
    expect(html).toContain(">treatment<");
  });

  test("does not talk about itself, or show internal codes", () => {
    expect(html).not.toMatch(/print-to-PDF|Printable/);
    expect(html).not.toMatch(/graph_summary|path-\d+/);
  });

  test("a warning on the graph reads as a sentence, without its internal code", () => {
    const lonely = { ...graph, nodes: [...graph.nodes, { id: "Q", label: "Q", x: 0, y: 0 }] };
    const report = buildPrintableReportHtml(lonely, analyze({ graph: lonely }));
    expect(report).toContain("Isolated or disconnected");
    expect(report).not.toContain("isolated_node");
    const markdown = buildMarkdownReport(lonely, analyze({ graph: lonely }));
    expect(markdown).toContain("Warning: Isolated or disconnected");
    expect(markdown).not.toContain("isolated_node");
  });

  test("sets margins, and does not forbid long sections from breaking across pages", () => {
    expect(html).toContain("@page");
    expect(html).not.toMatch(/section\s*\{[^}]*break-inside/);
  });
});

describe("graph as SVG", () => {
  const graph = {
    nodes: [
      { id: "Z", label: "Z", x: 200, y: 20 },
      { id: "X", label: "X", x: 20, y: 200 },
      { id: "Y", label: "Y", x: 400, y: 200 },
    ],
    edges: [
      { id: "Z->X", source: "Z", target: "X" },
      { id: "Z->Y", source: "Z", target: "Y" },
      { id: "X->Y", source: "X", target: "Y" },
    ],
    treatmentId: "X",
    outcomeId: "Y",
  };
  const svg = buildGraphSvg(graph, analyze({ graph }));

  test("every arrow stops outside the box it points to, so its direction can be seen", () => {
    const boxes = [...svg.matchAll(/<rect x="(-?[\d.]+)" y="(-?[\d.]+)" rx="8" ry="8" width="([\d.]+)" height="([\d.]+)"/g)].map((match) => match.slice(1).map(Number));
    const arrows = [...svg.matchAll(/<line x1="[^"]+" y1="[^"]+" x2="([^"]+)" y2="([^"]+)"/g)].map((match) => [Number(match[1]), Number(match[2])]);
    expect(boxes).toHaveLength(3);
    expect(arrows).toHaveLength(3);
    for (const [x, y] of arrows) {
      for (const [left, top, width, height] of boxes) {
        expect(x > left && x < left + width && y > top && y < top + height).toBe(false);
      }
    }
  });

  test("the arrows carrying the effect are the coloured ones, and variables say what they are", () => {
    expect(svg.match(/url\(#arrow-causal\)/g)).toHaveLength(1);
    expect(svg.match(/url\(#arrow\)/g)).toHaveLength(2);
    expect(svg).toContain(">treatment<");
    expect(svg).toContain(">outcome<");
    expect(svg).toContain(">confounder<");
  });

  test("a variable that was not measured is drawn dashed, and names are escaped", () => {
    const special = {
      ...graph,
      nodes: graph.nodes.map((node) => (node.id === "Z" ? { ...node, label: "a<b", observed: false } : node)),
    };
    const output = buildGraphSvg(special, analyze({ graph: special }));
    expect(output).toContain('stroke-dasharray="4 3"');
    expect(output).toContain("a&lt;b");
    expect(output).toContain(">not measured<");
  });
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
        cautionVariables: [],
        limits: { pathsTruncated: false, adjustmentSetsTruncated: false },
        baselineSet: null,
        effect: null,
        sensitivity: null,
        audit: null,
        reproduction: null,
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
        cautionVariables: [],
        limits: { pathsTruncated: false, adjustmentSetsTruncated: false },
        baselineSet: null,
        effect: null,
        sensitivity: null,
        audit: null,
        reproduction: null,
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

  test("buildMarkdownReport carries cautions, balance and overlap from a real analysis", () => {
    const ids = ["U1", "U2", "M", "X", "Y"];
    const graph = {
      nodes: ids.map((id) => ({ id, label: id, x: 0, y: 0 })),
      edges: [
        ["U1", "X"],
        ["U1", "M"],
        ["U2", "M"],
        ["U2", "Y"],
        ["M", "X"],
        ["M", "Y"],
        ["X", "Y"],
      ].map(([source, target]) => ({ id: `${source}->${target}`, source, target })),
      treatmentId: "X",
      outcomeId: "Y",
    };
    const rows = Array.from({ length: 40 }, (_, index) => `${index % 2},${index / 3},${(index * 7) % 11},${(index * 3) % 7},${index % 5}`);
    const analysis = analyze({ graph, dataset: { filename: "s.csv", content: ["X,Y,U1,U2,M", ...rows].join("\n") } });
    const markdown = buildMarkdownReport(graph, analysis, { hasData: true });

    expect(markdown).toContain("Recommended adjustment set: {M, U1}");
    expect(markdown).toContain("M (required)");
    expect(markdown).toContain("### Covariate Balance");
    expect(markdown).toContain("### Overlap");
    expect(markdown).toContain("Treated propensity range");
    expect(markdown).toContain("## Estimated Effect");
    expect(markdown).toContain("### The same data with other adjustment sets");
    expect(markdown).toContain("## What This Result Depends On");
    expect(markdown).toContain("These checks cannot see something unmeasured");
    expect(markdown.toLowerCase()).not.toMatch(/\b(passed|confirmed|verified|validated)\b/);
    expect(markdown).toContain("- U1 → X");
    expect(markdown).toContain("- X → X (exact)");
    expect(markdown).not.toMatch(/ (->|<-) /);
  });

  test("an empty recommendation is stated as no adjustment needed", () => {
    const graph = {
      nodes: ["X", "Y"].map((id) => ({ id, label: id, x: 0, y: 0 })),
      edges: [{ id: "X->Y", source: "X", target: "Y" }],
      treatmentId: "X",
      outcomeId: "Y",
    };
    expect(buildMarkdownReport(graph, analyze({ graph }))).toContain("Recommended adjustment set: {} (no adjustment needed)");
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
