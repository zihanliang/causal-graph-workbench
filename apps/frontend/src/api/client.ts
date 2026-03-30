import type { AnalysisRequest, AnalysisResult, GraphTemplate } from "@causal-graph-workbench/shared";

import { apiUrl } from "../lib/urls";

async function requestJson<T>(input: RequestInfo, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers);

  if (init?.body !== undefined && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }

  const response = await fetch(input, {
    ...init,
    headers,
  });

  if (!response.ok) {
    throw new Error(`Request failed with status ${response.status}`);
  }

  return response.json() as Promise<T>;
}

export function analyzeGraph(request: AnalysisRequest): Promise<AnalysisResult> {
  return requestJson<AnalysisResult>(apiUrl("analyze"), {
    method: "POST",
    body: JSON.stringify(request),
  });
}

export function fetchTemplates(): Promise<GraphTemplate[]> {
  return requestJson<GraphTemplate[]>(apiUrl("templates"));
}
