import type { AnalysisResult } from "@causal-graph-workbench/shared";

import type { AuditSnapshot } from "./audit";

/**
 * Applies a later stage of the analysis to the structural result. Kept apart from analyze.ts, because the
 * worker's client runs on the page and must not pull the whole engine into the main bundle.
 */
export function mergeUpdate(result: AnalysisResult, update: AuditSnapshot): AnalysisResult {
  return { ...result, audit: update.audit, effect: update.effect, sensitivity: update.sensitivity };
}
