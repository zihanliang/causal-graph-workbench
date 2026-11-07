import type { DataContext, DataDiagnostics, GraphSpec, NodeRoleSummary, VariableType } from "@causal-graph-workbench/shared";

import { chooseRecommendedSet, isValidAdjustmentSet, type AdjustmentProblem } from "./adjustment";
import { inferNodeType, resolvedColumnBindings } from "./data/diagnostics";
import type { DataTable } from "./data/table";
import type { EffectContext } from "./effect";
import { sortedSet } from "./graph";

/** What a graph needs from the file, shared by the analysis of one graph and the comparison of several. */

function effectiveType(requested: VariableType | undefined, nodeId: string, diagnostics: DataDiagnostics | null): VariableType {
  return requested && requested !== "unknown" ? requested : inferNodeType(nodeId, diagnostics);
}

/** Variables the file cannot supply are treated as unmeasured, so a recommendation can always be estimated. */
export function unmatchedVariables(graph: GraphSpec, diagnostics: DataDiagnostics | null): string[] {
  if (!diagnostics) {
    return [];
  }
  return diagnostics.variableBindings
    .filter((binding) => !binding.matched && binding.nodeId !== graph.treatmentId && binding.nodeId !== graph.outcomeId)
    .map((binding) => binding.nodeId);
}

function unavailableEffectReason(graph: GraphSpec, diagnostics: DataDiagnostics): string | null {
  const isBound = (node: string | null) => diagnostics.variableBindings.some((binding) => binding.nodeId === node && binding.matched);
  if (!isBound(graph.treatmentId)) {
    return `No column is matched to ${graph.treatmentId}. Match it under Data to estimate the effect.`;
  }
  if (!isBound(graph.outcomeId)) {
    return `No column is matched to ${graph.outcomeId}. Match it under Data to estimate the effect.`;
  }
  return null;
}

export interface EffectSetup {
  treatmentType: VariableType;
  outcomeType: VariableType;
  bindings: Record<string, string>;
  /** Variables that have a usable column. */
  boundNodes: Set<string>;
  unavailable: string | null;
  /** Null when there is no data, or treatment or outcome has no column. */
  effectContext: EffectContext | null;
}

export function effectSetup(graph: GraphSpec, dataContext: DataContext, diagnostics: DataDiagnostics | null, table: DataTable | null): EffectSetup {
  const treatment = graph.treatmentId!;
  const outcome = graph.outcomeId!;
  const treatmentType = effectiveType(dataContext.treatmentType, treatment, diagnostics);
  const outcomeType = effectiveType(dataContext.outcomeType, outcome, diagnostics);
  const bindings = resolvedColumnBindings(graph, diagnostics);
  const boundNodes = new Set(diagnostics ? diagnostics.variableBindings.filter((binding) => binding.matched).map((binding) => binding.nodeId) : []);
  const unavailable = diagnostics ? unavailableEffectReason(graph, diagnostics) : null;
  const typeOfColumn = (column: string): VariableType => diagnostics?.columnProfiles.find((profile) => profile.columnName === column)?.inferredType ?? "unknown";
  const effectContext: EffectContext | null =
    table && diagnostics && !unavailable
      ? {
          table,
          treatment: { column: bindings[treatment], type: treatmentType },
          outcome: { column: bindings[outcome], type: outcomeType },
          estimand: dataContext.estimand ?? "ate",
          columnOf: (node) => (boundNodes.has(node) ? { column: bindings[node], type: typeOfColumn(bindings[node]) } : null),
        }
      : null;
  return { treatmentType, outcomeType, bindings, boundNodes, unavailable, effectContext };
}

export interface ChosenSets {
  recommended: string[] | null;
  /** The set the user asked for, when it names variables in this graph. */
  chosen: string[] | null;
  chosenIsValid: boolean;
  /** The user's own set when it is valid; otherwise it is only shown for comparison. */
  baseline: string[] | null;
}

export function chooseSets(graph: GraphSpec, problem: AdjustmentProblem, minimalSets: string[][], nodeRoles: NodeRoleSummary[], dataContext: DataContext): ChosenSets {
  const recommended = chooseRecommendedSet(minimalSets, nodeRoles);
  const known = new Set(graph.nodes.map((node) => node.id));
  const chosen = dataContext.chosenSet ? sortedSet(dataContext.chosenSet.filter((node) => known.has(node))) : null;
  const chosenIsValid = chosen !== null && isValidAdjustmentSet(problem, chosen);
  return { recommended, chosen, chosenIsValid, baseline: chosenIsValid ? chosen : recommended };
}
