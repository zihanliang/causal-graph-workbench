import type { AnalysisRequest, AnalysisResult, GraphTemplate } from "@causal-workbench/shared";

import { apiUrl } from "../lib/urls";

async function requestJson<T>(input: RequestInfo, init?: RequestInit): Promise<T> {
  const response = await fetch(input, {
    headers: {
      "Content-Type": "application/json",
      ...(init?.headers ?? {}),
    },
    ...init,
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
