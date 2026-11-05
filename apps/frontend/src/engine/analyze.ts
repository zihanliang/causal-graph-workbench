import type {
  AnalysisRequest,
  AnalysisResult,
  AssumptionItem,
  DataContext,
  DataDiagnostics,
  EstimatorRecommendation,
  GraphSpec,
  Issue,
  ReproductionInputs,
  ValidationSummary,
  VariableTiming,
  VariableType,
} from "@causal-graph-workbench/shared";

import {
  chooseRecommendedSet,
  createAdjustmentProblem,
  findCautionVariables,
  findForbiddenVariables,
  isValidAdjustmentSet,
  listMinimalSets,
  listValidSets,
  summarizeAdjustmentSets,
} from "./adjustment";
import { runAudit, type AuditInput, type AuditSnapshot } from "./audit";
import { generateCodeSnippets } from "./codegen";
import {
  binaryCoding,
  inferNodeType,
  profileDataset,
  resolvedColumnBindings,
  withCovariateDiagnostics,
} from "./data/diagnostics";
import type { DataTable } from "./data/table";
import type { EffectContext } from "./effect";
import { recommendEstimators } from "./estimators";
import { Dag, sortedSet } from "./graph";
import { mergeUpdate } from "./mergeUpdate";
import { countDirectedPaths, enumeratePaths, materializePaths, MAX_LISTED_PATHS, pathStatus } from "./paths";
import { summarizeNodeRoles } from "./roles";
import { validateGraph } from "./validation";

/** Path-by-path explanations are kept for the current set, the recommended set and a few alternatives. */
const MAX_EXPLAINED_SETS = 6;

const ASSUMPTIONS: AssumptionItem[] = [
  {
    id: "dag-correctness",
    title: "DAG correctness is assumed",
    description: "The tool does not verify the DAG is true. It only reasons conditionally on the DAG provided by the user.",
    category: "identification",
    level: "critical",
  },
  {
    id: "no-unobserved-confounding",
    title: "No unobserved confounding after adjustment",
    description:
      "Backdoor-based recommendations assume the selected adjustment set closes the relevant noncausal paths and that important confounders are represented in the DAG.",
    category: "identification",
    level: "critical",
  },
  {
    id: "positivity",
    title: "Positivity / overlap",
    description: "Each treatment level should remain plausible across the covariate strata used for adjustment.",
    category: "data",
    level: "warning",
  },
  {
    id: "model-specification",
    title: "Correct model specification",
    description:
      "If you use parametric estimators such as OLS or logistic regression, the functional form and link assumptions still matter.",
    category: "estimation",
    level: "warning",
  },
];

function appendIssue(validation: ValidationSummary, issue: Omit<Issue, "nodeIds" | "edgeIds" | "details"> & Partial<Issue>): ValidationSummary {
  return { ...validation, issues: [...validation.issues, { nodeIds: [], edgeIds: [], details: [], ...issue }] };
}

function effectiveType(requested: VariableType | undefined, nodeId: string, diagnostics: DataDiagnostics | null): VariableType {
  return requested && requested !== "unknown" ? requested : inferNodeType(nodeId, diagnostics);
}

function emptyResult(graph: GraphSpec, validation: ValidationSummary, diagnostics: DataDiagnostics | null): AnalysisResult {
  return {
    validation,
    graphStats: { nodeCount: graph.nodes.length, edgeCount: graph.edges.length, openBackdoorPathCount: 0, directedPathCount: 0 },
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
    assumptions: ASSUMPTIONS,
    estimatorRecommendations: [],
    codeSnippets: [],
    dataDiagnostics: diagnostics,
  };
}

const PROPENSITY_ESTIMATORS = new Set(["propensity-weighting", "matching", "aipw"]);

/** Keeps the recommendation honest when the data checks have already flagged a problem with it. */
function withOverlapCaveat(estimators: EstimatorRecommendation[], diagnostics: DataDiagnostics | null): EstimatorRecommendation[] {
  if (!diagnostics?.overlapDiagnostics?.warnings.length) {
    return estimators;
  }
  const caveat = "The overlap check flagged problems with this data (see Checks), so estimators that use the propensity score may be unstable.";
  return estimators.map((item) => (PROPENSITY_ESTIMATORS.has(item.id) ? { ...item, caveats: [...item.caveats, caveat] } : item));
}

/** Variables the file cannot supply are treated as unmeasured, so a recommendation can always be estimated. */
function unmatchedVariables(graph: GraphSpec, diagnostics: DataDiagnostics | null): string[] {
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

interface Prepared {
  result: AnalysisResult;
  auditInput: AuditInput | null;
}

function prepare(request: AnalysisRequest): Prepared {
  const { graph } = request;
  const dataContext: DataContext = request.dataContext ?? {};
  let validation = validateGraph(graph);

  let table: DataTable | null = null;
  let diagnostics: DataDiagnostics | null = null;
  if (request.dataset) {
    const profiled = profileDataset(graph, request.dataset, dataContext.columnBindings ?? {});
    table = profiled.table;
    diagnostics = profiled.diagnostics;
  }

  if (!validation.canAnalyze) {
    return { result: emptyResult(graph, validation, diagnostics), auditInput: null };
  }

  const treatment = graph.treatmentId!;
  const outcome = graph.outcomeId!;
  const dag = Dag.fromSpec(graph, unmatchedVariables(graph, diagnostics));
  const problem = createAdjustmentProblem(dag, treatment, outcome);

  const { paths: rawPaths, truncated: pathsTruncated } = enumeratePaths(dag, treatment, outcome);
  const nodeRoles = summarizeNodeRoles(dag, treatment, outcome);
  const minimal = listMinimalSets(problem);
  const valid = listValidSets(problem);
  const seen = new Set<string>();
  const allSets = [...minimal.sets, ...valid.sets].filter((set) => {
    const key = set.join("\u0000");
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });

  const recommended = chooseRecommendedSet(minimal.sets, nodeRoles);
  const forbiddenVariables = findForbiddenVariables(problem, nodeRoles);
  const cautionVariables = findCautionVariables(problem, nodeRoles, forbiddenVariables);

  // The user's own set takes over when it is valid; otherwise it is only shown for comparison.
  const known = new Set(graph.nodes.map((node) => node.id));
  const chosen = dataContext.chosenSet ? sortedSet(dataContext.chosenSet.filter((node) => known.has(node))) : null;
  const chosenIsValid = chosen !== null && isValidAdjustmentSet(problem, chosen);
  const baseline = chosenIsValid ? chosen : recommended;

  if (recommended === null) {
    validation = appendIssue(validation, {
      severity: "warning",
      code: "no_valid_adjustment_set",
      message:
        "No valid observed adjustment set was found under backdoor adjustment. Estimator recommendations and code templates are withheld.",
    });
  }
  if (pathsTruncated) {
    validation = appendIssue(validation, {
      severity: "info",
      code: "paths_truncated",
      message: `This graph has too many paths to list, so the shortest ${MAX_LISTED_PATHS} are shown. Adjustment sets are still exact, because they do not depend on this list.`,
    });
  }
  const adjustmentSetsTruncated = minimal.truncated || valid.truncated;
  if (adjustmentSetsTruncated) {
    validation = appendIssue(validation, {
      severity: "info",
      code: "adjustment_sets_truncated",
      message: "There are too many valid adjustment sets to list them all. Each set shown is valid, and the recommendation is unaffected.",
    });
  }

  if (diagnostics && table) {
    diagnostics = withCovariateDiagnostics(graph, diagnostics, table, baseline);
  }

  const evaluationKeys = new Set<string>();
  const evaluationSets = [
    ...(baseline ? [baseline] : []),
    ...(recommended ? [recommended] : []),
    ...minimal.sets.slice(0, MAX_EXPLAINED_SETS),
  ].filter((set) => {
    const key = set.join("\u0000");
    if (evaluationKeys.has(key)) {
      return false;
    }
    evaluationKeys.add(key);
    return true;
  });

  const treatmentType = effectiveType(dataContext.treatmentType, treatment, diagnostics);
  const outcomeType = effectiveType(dataContext.outcomeType, outcome, diagnostics);
  const bindings = resolvedColumnBindings(graph, diagnostics);
  const covariates = baseline ?? [];
  const estimand = dataContext.estimand ?? "ate";
  const context: DataContext = {
    ...dataContext,
    hasData: Boolean(dataContext.hasData || diagnostics?.hasData),
    datasetName: dataContext.datasetName ?? diagnostics?.datasetName ?? null,
  };

  if (baseline !== null && outcomeType === "categorical") {
    validation = appendIssue(validation, {
      severity: "warning",
      code: "categorical_outcome_unsupported",
      message: `${outcome} has more than two categories. Estimator recommendations and code are withheld; recode it to a binary or numeric outcome first.`,
      nodeIds: [outcome],
    });
  }

  let reproduction: ReproductionInputs | null = null;
  if (diagnostics?.hasData && request.dataset) {
    const matched = diagnostics.variableBindings.filter((binding) => binding.matched && binding.columnName);
    reproduction = {
      filename: request.dataset.filename ?? dataContext.datasetName ?? "your_data.csv",
      delimiter: table?.delimiter ?? ",",
      columnOf: Object.fromEntries(matched.map((binding) => [binding.nodeId, binding.columnName!])),
      typeOf: Object.fromEntries(
        matched.map((binding) => [
          binding.nodeId,
          binding.nodeId === treatment
            ? treatmentType
            : binding.nodeId === outcome
              ? outcomeType
              : (diagnostics!.columnProfiles.find((profile) => profile.columnName === binding.columnName)?.inferredType ?? "unknown"),
        ]),
      ),
      estimand,
    };
  }

  let auditInput: AuditInput | null = null;
  if (baseline !== null) {
    const boundNodes = new Set(
      diagnostics ? diagnostics.variableBindings.filter((binding) => binding.matched).map((binding) => binding.nodeId) : [],
    );
    const unavailable = diagnostics ? unavailableEffectReason(graph, diagnostics) : null;
    const typeOfColumn = (column: string): VariableType =>
      diagnostics?.columnProfiles.find((profile) => profile.columnName === column)?.inferredType ?? "unknown";
    const effectContext: EffectContext | null =
      table && diagnostics && !unavailable
        ? {
            table,
            treatment: { column: bindings[treatment], type: treatmentType },
            outcome: { column: bindings[outcome], type: outcomeType },
            estimand,
            columnOf: (node) => (boundNodes.has(node) ? { column: bindings[node], type: typeOfColumn(bindings[node]) } : null),
          }
        : null;

    auditInput = {
      dag,
      treatment,
      outcome,
      baseline,
      minimalSets: minimal.sets,
      invalidChosenSet: chosen !== null && !chosenIsValid ? chosen : null,
      timing: new Map(
        graph.nodes.filter((node) => node.timing).map((node) => [node.id, node.timing as VariableTiming]),
      ),
      effectContext,
      effectUnavailableReason: unavailable,
      boundNodes,
      hasData: Boolean(diagnostics),
    };
  }

  const result: AnalysisResult = {
    validation,
    graphStats: {
      nodeCount: graph.nodes.length,
      edgeCount: graph.edges.length,
      openBackdoorPathCount: rawPaths.filter(
        (path) => path.category === "backdoor" && pathStatus(dag, path.nodes, new Set()).isOpen,
      ).length,
      directedPathCount: countDirectedPaths(dag, treatment, outcome),
    },
    paths: materializePaths(dag, rawPaths, evaluationSets),
    nodeRoles,
    adjustmentSets: summarizeAdjustmentSets(problem, rawPaths, allSets, minimal.sets, recommended, nodeRoles, pathsTruncated),
    recommendedAdjustmentSet: recommended ?? [],
    forbiddenVariables,
    cautionVariables,
    limits: { pathsTruncated, adjustmentSetsTruncated },
    baselineSet: baseline,
    effect: null,
    sensitivity: null,
    audit: null,
    reproduction,
    assumptions: ASSUMPTIONS,
    estimatorRecommendations:
      baseline === null
        ? []
        : withOverlapCaveat(
            recommendEstimators(treatment, outcome, covariates, context, { treatmentType, outcomeType, bindings }),
            diagnostics,
          ),
    codeSnippets:
      baseline === null
        ? []
        : generateCodeSnippets({
            treatmentColumn: bindings[treatment],
            outcomeColumn: bindings[outcome],
            covariateColumns: covariates.map((node) => bindings[node]),
            treatmentType,
            outcomeType,
            treatmentCoding: binaryCoding(treatment, diagnostics, table),
            outcomeCoding: binaryCoding(outcome, diagnostics, table),
            filename: request.dataset?.filename ?? dataContext.datasetName,
            estimand,
          }),
    dataDiagnostics: diagnostics,
  };
  return { result, auditInput };
}

/**
 * The structural result comes first and is fast. The audit and estimates follow as updates, so a large
 * file never holds up the graph. `structure` is yielded once; each update replaces the previous one.
 */
export function* analyzeInStages(request: AnalysisRequest): Generator<{ structure: AnalysisResult } | { update: AuditSnapshot }, void, void> {
  const { result, auditInput } = prepare(request);
  yield { structure: result };
  if (auditInput) {
    for (const update of runAudit(auditInput)) {
      yield { update };
    }
  }
}

/** Runs every stage to completion. */
export function analyze(request: AnalysisRequest): AnalysisResult {
  let result: AnalysisResult | null = null;
  for (const stage of analyzeInStages(request)) {
    if ("structure" in stage) {
      result = stage.structure;
    } else if (result) {
      result = mergeUpdate(result, stage.update);
    }
  }
  return result!;
}
