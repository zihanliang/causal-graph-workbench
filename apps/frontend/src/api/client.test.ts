import type { AnalysisRequest } from "@causal-graph-workbench/shared";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { analyzeGraph, fetchTemplates } from "./client";

const okResponse = {
  ok: true,
  json: vi.fn().mockResolvedValue({}),
} satisfies Pick<Response, "ok" | "json">;

describe("API client", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(okResponse));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  test("fetchTemplates avoids sending a JSON content-type header for GET requests", async () => {
    await fetchTemplates();

    const fetchMock = vi.mocked(fetch);
    const [, requestInit] = fetchMock.mock.calls[0] ?? [];
    const headers = new Headers(requestInit?.headers);

    expect(headers.has("Content-Type")).toBe(false);
  });

  test("analyzeGraph sends JSON for POST requests", async () => {
    const request: AnalysisRequest = {
      graph: {
        nodes: [
          { id: "X", label: "X", x: 0, y: 0 },
          { id: "Y", label: "Y", x: 120, y: 0 },
        ],
        edges: [{ id: "X->Y", source: "X", target: "Y" }],
        treatmentId: "X",
        outcomeId: "Y",
      },
    };

    await analyzeGraph(request);

    const fetchMock = vi.mocked(fetch);
    const [, requestInit] = fetchMock.mock.calls[0] ?? [];
    const headers = new Headers(requestInit?.headers);

    expect(requestInit?.method).toBe("POST");
    expect(headers.get("Content-Type")).toBe("application/json");
    expect(requestInit?.body).toBe(JSON.stringify(request));
  });
});
