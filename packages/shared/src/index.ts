export type Severity = "error" | "warning" | "info";
export type VariableType = "unknown" | "binary" | "continuous" | "categorical";
export type PathCategory = "directed_causal" | "backdoor" | "noncausal";
export type PathStatus = "open" | "blocked";
export type PathNodeKind = "collider" | "non_collider";
export type PathStepEffect = "opens_path" | "blocks_path" | "keeps_path_open";
export type RoleType =
  | "confounder"
  | "mediator"
  | "collider"
  | "descendant_of_treatment"
  | "ancestor_of_treatment"
  | "ancestor_of_outcome"
  | "instrument_like";

/** When a variable is fixed relative to treatment. Rules out arrows that would run backwards in time. */
export type VariableTiming = "baseline" | "before" | "after";

export type Estimand = "ate" | "att";

export interface GraphNode {
  id: string;
  label: string;
  x: number;
  y: number;
  observed?: boolean;
  timing?: VariableTiming | null;
  description?: string;
}

export interface GraphEdge {
  id: string;
  source: string;
  target: string;
}

export interface GraphSpec {
  nodes: GraphNode[];
  edges: GraphEdge[];
  treatmentId: string | null;
  outcomeId: string | null;
}

export interface DataContext {
  hasData?: boolean;
  treatmentType?: VariableType;
  outcomeType?: VariableType;
  datasetName?: string | null;
  highDimensional?: boolean;
  /** Node id to column name. An empty string means the variable is not in this file. */
  columnBindings?: Record<string, string>;
  estimand?: Estimand;
  /** The adjustment set the user wants to analyse instead of the recommended one. */
  chosenSet?: string[] | null;
}

export interface UploadedDataset {
  filename?: string | null;
  content: string;
  delimiter?: string | null;
}

export interface AnalysisRequest {
  graph: GraphSpec;
  dataContext?: DataContext;
  dataset?: UploadedDataset | null;
}

export interface Issue {
  severity: Severity;
  code: string;
  message: string;
  nodeIds?: string[];
  edgeIds?: string[];
  details?: string[];
}

export interface ValidationSummary {
  canAnalyze: boolean;
  issues: Issue[];
}

export interface PathEvaluation {
  conditioningSet: string[];
  status: PathStatus;
  isOpen: boolean;
  reason: string;
  blockedBy: string[];
  openedBy: string[];
  steps: PathEvaluationStep[];
}

export interface PathEvaluationStep {
  nodeId: string;
  kind: PathNodeKind;
  conditionedOnNode: boolean;
  conditionedOnDescendant: boolean;
  descendantWitnesses: string[];
  effect: PathStepEffect;
  explanation: string;
}

export interface PathAnalysisItem {
  id: string;
  nodes: string[];
  pathString: string;
  category: PathCategory;
  involvesCollider: boolean;
  colliders: string[];
  defaultEvaluation: PathEvaluation;
  adjustmentEvaluations: PathEvaluation[];
  explanation: string;
}

export interface NodeRoleSummary {
  nodeId: string;
  roles: RoleType[];
  summary: string;
  evidence: string[];
}

export interface AdjustmentSetSummary {
  id: string;
  variables: string[];
  isValid: boolean;
  isMinimal: boolean;
  isRecommended: boolean;
  practicalRating: "recommended" | "acceptable" | "avoid";
  explanation: string;
  blockedPathIds: string[];
  openedPathIds: string[];
  practicalConcerns: string[];
}

export interface ForbiddenVariable {
  nodeId: string;
  reasons: string[];
}

export interface CautionVariable {
  nodeId: string;
  reasons: string[];
  /** True when every valid adjustment set must contain this variable. */
  required: boolean;
}

export interface AnalysisLimits {
  /** Only part of the treatment-outcome paths were listed; path counts are lower bounds. */
  pathsTruncated: boolean;
  /** Only part of the valid adjustment sets were listed. Validity checks are unaffected. */
  adjustmentSetsTruncated: boolean;
}

export interface AssumptionItem {
  id: string;
  title: string;
  description: string;
  category: "identification" | "estimation" | "data";
  level: "critical" | "warning" | "info";
}

export interface EstimatorRecommendation {
  id: string;
  name: string;
  family: string;
  summary: string;
  rationale: string[];
  supportedWhen: string[];
  formulaPreview: string;
  recommended: boolean;
  priority: number;
  caveats: string[];
}

export interface CodeSnippet {
  id: string;
  label: string;
  language: "python" | "r";
  estimatorId: string;
  content: string;
}

export interface VariableBinding {
  nodeId: string;
  columnName: string | null;
  matched: boolean;
  matchType: "exact" | "normalized" | "provided" | "unmatched";
  note?: string | null;
}

export interface ColumnProfile {
  columnName: string;
  inferredType: VariableType;
  nonMissingCount: number;
  missingCount: number;
  missingRate: number;
  uniqueCount: number;
  exampleValues: string[];
  boundNodeIds: string[];
}

export interface MissingnessItem {
  columnName: string;
  missingCount: number;
  missingRate: number;
}

export interface BalanceMetric {
  columnName: string;
  treatedValue: string;
  controlValue: string;
  absoluteDifference?: number | null;
  standardizedDifference?: number | null;
  /** Absolute standardized difference is above the conventional 0.1 threshold. */
  imbalanced?: boolean;
}

export interface TreatmentBalanceSummary {
  available: boolean;
  treatmentColumn?: string | null;
  treatmentType: VariableType;
  treatedCount?: number | null;
  controlCount?: number | null;
  treatedRate?: number | null;
  /** Value read as "treated" after lower-casing, so an inferred coding can be checked. */
  treatedLabel?: string | null;
  controlLabel?: string | null;
  metrics: BalanceMetric[];
  note: string;
}

export interface PropensityOverlap {
  /** Model terms actually fitted, with categorical columns expanded to dummies. */
  terms: string[];
  /** Terms removed because they were collinear with earlier terms. */
  droppedTerms: string[];
  rowsUsed: number;
  rowsDropped: number;
  treatedRange: [number, number];
  controlRange: [number, number];
  /** Interval covered by both groups, or null when the groups do not overlap at all. */
  commonSupport: [number, number] | null;
  treatedOutsideSupport: number;
  controlOutsideSupport: number;
  /** Share of rows with an estimated propensity below 0.05 or above 0.95. */
  extremeShare: number;
  converged: boolean;
  separationSuspected: boolean;
}

export interface OverlapDiagnostics {
  available: boolean;
  note: string;
  propensity?: PropensityOverlap | null;
  warnings: string[];
}

export interface DataDiagnostics {
  hasData: boolean;
  datasetName?: string | null;
  rowCount: number;
  columnCount: number;
  columnProfiles: ColumnProfile[];
  variableBindings: VariableBinding[];
  missingness: MissingnessItem[];
  warnings: string[];
  treatmentBalance?: TreatmentBalanceSummary | null;
  overlapDiagnostics?: OverlapDiagnostics | null;
}

export type EffectMethod = "aipw" | "ols" | "logistic";

export interface EffectEstimate {
  method: EffectMethod;
  estimand: Estimand | null;
  /** What the number means, in plain words. */
  description: string;
  /** Scale of the numeric fields below. A log odds ratio is shown to people as an odds ratio. */
  scale: "difference" | "log_odds_ratio";
  estimate: number;
  standardError: number;
  ciLow: number;
  ciHigh: number;
  rowsUsed: number;
  rowsDropped: number;
  adjustmentSet: string[];
  warnings: string[];
  /** The generated snippet that reproduces this number. */
  snippetId: string;
}

export interface EffectComparison {
  id: string;
  label: string;
  kind: "baseline" | "minimal" | "none" | "all" | "custom";
  variables: string[];
  isValid: boolean;
  invalidReason: string | null;
  estimate: EffectEstimate | null;
  unavailableReason: string | null;
}

export interface EffectSummary {
  status: "running" | "complete";
  estimate: EffectEstimate | null;
  unavailableReason: string | null;
  comparisons: EffectComparison[];
}

/** How a variable you did measure compares, for scale, with something unmeasured. */
export interface SensitivityBenchmark {
  variable: string;
  /** Strength with treatment of something this strong: the share of what the current set leaves unexplained. */
  treatmentShare: number;
  /** The same for the outcome. */
  outcomeShare: number;
  /**
   * About how far it could move the estimate, as a share of the estimate. 1 or more could explain all of it.
   * In simulation this is centred on the true bias of a variable that strong, so it is a guide, not a limit.
   */
  shareOfEstimate: number;
}

/** How strong something unmeasured would have to be, measured by the share of variation it explains. */
export interface RobustnessSummary {
  /**
   * "aipw" is the bound of Chernozhukov et al. (2022) on the estimate shown. "linear" is that of Cinelli and
   * Hazlett (2020). "linear_probability" applies the latter to a linear probability model on the same variables,
   * because the bound does not apply to an odds ratio directly.
   */
  basis: "aipw" | "linear" | "linear_probability";
  /** The equal share of treatment and outcome that would bring the estimate to zero. */
  value: number;
  /** The equal share that would bring the 95% interval to zero. 0 when it already includes zero. */
  valueForInterval: number;
  /** (estimate / bias scale) squared. Strengths (x, y) reach zero along y = ratio * (1 - x) / x. */
  ratio: number;
  /** Strongest first. */
  benchmarks: SensitivityBenchmark[];
  /** False when the time budget ran out before every variable was compared. */
  benchmarksComplete: boolean;
}

/** VanderWeele and Ding (2017), on the risk ratio scale. */
export interface EValueSummary {
  /** What the estimate was converted to a risk ratio from. Only "risk_ratio" needs no approximation. */
  basis: "risk_ratio" | "standardized_difference" | "odds_ratio_rare" | "odds_ratio_common";
  contrast: "treated_vs_untreated" | "one_sd_of_treatment";
  riskRatio: number;
  riskRatioLow: number;
  riskRatioHigh: number;
  /** For the estimate. */
  point: number;
  /** For the end of the interval nearer the null. 1 when the interval includes the null. */
  interval: number;
}

export interface SensitivitySummary {
  status: "running" | "complete";
  robustness: RobustnessSummary | null;
  evalue: EValueSummary | null;
}

export type AssumptionEdit = "add" | "remove" | "reverse";
export type AssumptionSeverity = "changes_conclusion" | "no_valid_set" | "moves_estimate" | "small_shift" | "not_estimated";
export type DataCheckVerdict = "conflict" | "no_conflict" | "not_testable";

/** A conditional independence the DAG implies, tested against the data. */
export interface ImpliedIndependenceTest {
  id: string;
  left: string;
  right: string;
  given: string[];
  pValue: number;
  /** Holm-adjusted across every test in this audit. */
  adjustedPValue: number;
  conflict: boolean;
  /** Residual correlation, as a rough measure of strength. */
  correlation: number;
  rowsUsed: number;
}

/** One way the graph could be wrong that would stop the current adjustment set from being valid. */
export interface LoadBearingAssumption {
  id: string;
  edit: AssumptionEdit;
  /** For "add", the arrow that would be missing. For "remove" and "reverse", the arrow as drawn. */
  source: string;
  target: string;
  statement: string;
  consequence: string;
  /** The closest valid set if this error were real, or null when no measured set would work. */
  repair: string[] | null;
  addedToSet: string[];
  removedFromSet: string[];
  dataCheck: DataCheckVerdict;
  dataCheckNote: string;
  testId: string | null;
  alternativeEstimate: EffectEstimate | null;
  /** The current set's estimate on the same rows as the alternative, for a fair comparison. */
  baselineOnSameRows: number | null;
  shift: number | null;
  shiftStandardError: number | null;
  severity: AssumptionSeverity;
}

export interface AssumptionAudit {
  status: "running" | "complete";
  baselineSet: string[];
  /** Single-arrow errors checked against the current set. */
  editsChecked: number;
  /** Single-arrow errors not considered because the variables' timing makes them impossible. */
  editsRuledOutByTiming: number;
  /** The time budget ran out, so some arrows were not checked. */
  truncated: boolean;
  assumptions: LoadBearingAssumption[];
  tests: ImpliedIndependenceTest[];
  /** Test ids where the data disagrees with the graph but no adjustment set is affected. */
  conflictsWithoutConsequence: string[];
  /** Variable pairs the graph says are independent but that could not be tested. */
  untestablePairs: number;
  /** Tests used a random sample of this many rows, because the file is large. */
  testSampleSize: number | null;
}

export interface ExplainableSelection {
  kind: "node" | "path" | "adjustment" | "estimator";
  id: string;
}

/** What a script needs to read the file the way the app did. Null without a file. */
export interface ReproductionInputs {
  filename: string;
  /** Column for each graph variable that has one. */
  columnOf: Record<string, string>;
  /** How each of those variables was read. */
  typeOf: Record<string, VariableType>;
  estimand: Estimand;
}

export interface AnalysisResult {
  validation: ValidationSummary;
  graphStats: {
    nodeCount: number;
    edgeCount: number;
    openBackdoorPathCount: number;
    directedPathCount: number;
  };
  paths: PathAnalysisItem[];
  nodeRoles: NodeRoleSummary[];
  adjustmentSets: AdjustmentSetSummary[];
  /** Empty means "no adjustment needed" when valid sets exist, and "none" when `adjustmentSets` is empty. */
  recommendedAdjustmentSet: string[];
  /** Variables that appear in no valid adjustment set. */
  forbiddenVariables: ForbiddenVariable[];
  /** Variables that can be part of a valid set but cannot safely be used alone. */
  cautionVariables: CautionVariable[];
  limits: AnalysisLimits;
  /** The set the effect, audit and code below use: the user's choice if valid, otherwise the recommended set. */
  baselineSet: string[] | null;
  effect: EffectSummary | null;
  /** How strong something unmeasured would have to be. Null without an estimate. */
  sensitivity: SensitivitySummary | null;
  audit: AssumptionAudit | null;
  reproduction: ReproductionInputs | null;
  assumptions: AssumptionItem[];
  estimatorRecommendations: EstimatorRecommendation[];
  codeSnippets: CodeSnippet[];
  dataDiagnostics?: DataDiagnostics | null;
}

export interface GraphTemplate {
  id: string;
  name: string;
  description: string;
  graph: GraphSpec;
}

export const CONTRACT_VERSION = "0.4.0";
