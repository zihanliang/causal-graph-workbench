import type { AnalysisResult, ExplainableSelection } from "@causal-graph-workbench/shared";

export function getExplainableKindLabel(selection: ExplainableSelection | null): string {
  if (!selection) {
    return "Nothing selected";
  }

  switch (selection.kind) {
    case "node":
      return "Node";
    case "path":
      return "Path";
    case "adjustment":
      return "Adjustment set";
    case "estimator":
      return "Estimator";
  }
}

export function getExplainableDisplayLabel(
  analysis: AnalysisResult | null,
  selection: ExplainableSelection | null,
): string | null {
  if (!selection) {
    return null;
  }

  if (selection.kind === "node") {
    return selection.id;
  }

  if (selection.kind === "path") {
    return analysis?.paths.find((item) => item.id === selection.id)?.pathString ?? selection.id;
  }

  if (selection.kind === "adjustment") {
    const adjustmentSet = analysis?.adjustmentSets.find((item) => item.id === selection.id);
    if (!adjustmentSet) {
      return selection.id;
    }
    return adjustmentSet.variables.length ? `{${adjustmentSet.variables.join(", ")}}` : "{}";
  }

  return analysis?.estimatorRecommendations.find((item) => item.id === selection.id)?.name ?? selection.id;
}
