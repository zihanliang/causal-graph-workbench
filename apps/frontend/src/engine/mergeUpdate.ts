import type { AnalysisResult } from "@causal-graph-workbench/shared";

/** The parts of a result that later stages of the analysis fill in. */
export type AnalysisUpdate = Partial<Pick<AnalysisResult, "audit" | "effect" | "sensitivity" | "comparison" | "scan">>;

/**
 * Applies a later stage of the analysis to the structural result. Kept apart from analyze.ts, because the
 * worker's client runs on the page and must not pull the whole engine into the main bundle.
 */
export function mergeUpdate(result: AnalysisResult, update: AnalysisUpdate): AnalysisResult {
  return { ...result, ...update };
}

/** Updates not yet sent to the page. Each stage fills different parts, so a later one must not erase an earlier one. */
export function combineUpdates(earlier: AnalysisUpdate | null, later: AnalysisUpdate): AnalysisUpdate {
  return { ...earlier, ...later };
}
