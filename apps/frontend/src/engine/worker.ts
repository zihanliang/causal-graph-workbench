import type { AnalysisRequest, AnalysisResult } from "@causal-graph-workbench/shared";

import { analyzeInStages } from "./analyze";
import type { AuditSnapshot } from "./audit";

/** Sending a result to the page has a cost, so progress is published a few times a second at most. */
const PUBLISH_INTERVAL_MS = 150;
/** On a quick run the page gets one complete result, rather than an empty panel for a moment first. */
const STRUCTURE_HOLD_MS = 80;

let latestRequest = 0;

function nextTurn(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

self.onmessage = async (event: MessageEvent<{ id: number; request: AnalysisRequest }>) => {
  const { id, request } = event.data;
  latestRequest = id;

  try {
    const started = performance.now();
    let structure: AnalysisResult | null = null;
    let structureSent = false;
    let lastPublished = 0;
    let unpublished: AuditSnapshot | null = null;

    for (const stage of analyzeInStages(request)) {
      if ("structure" in stage) {
        structure = stage.structure;
      } else {
        unpublished = stage.update;
      }
      const now = performance.now();
      if (!structureSent && now - started >= STRUCTURE_HOLD_MS && structure) {
        self.postMessage({ id, kind: "structure", result: structure });
        structureSent = true;
      }
      if (structureSent && unpublished && now - lastPublished >= PUBLISH_INTERVAL_MS) {
        self.postMessage({ id, kind: "update", update: unpublished });
        unpublished = null;
        lastPublished = now;
      }
      // Lets a newer request arrive. Results already cached by this run stay available to it.
      await nextTurn();
      if (latestRequest !== id) {
        return;
      }
    }
    self.postMessage({ id, kind: "done", result: structureSent ? null : structure, update: unpublished });
  } catch (error) {
    self.postMessage({ id, kind: "error", error: error instanceof Error ? error.message : "The analysis could not be completed." });
  }
};
