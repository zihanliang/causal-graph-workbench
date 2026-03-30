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
  | "ancestor_of_outcome";

export interface GraphNode {
  id: string;
  label: string;
  x: number;
  y: number;
  observed?: boolean;
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
  columnBindings?: Record<string, string>;
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
}

export interface TreatmentBalanceSummary {
  available: boolean;
  treatmentColumn?: string | null;
  treatmentType: VariableType;
  treatedCount?: number | null;
  controlCount?: number | null;
  treatedRate?: number | null;
  metrics: BalanceMetric[];
  note: string;
}

export interface OverlapMetric {
  columnName: string;
  overlapScore?: number | null;
  treatedRange?: string | null;
  controlRange?: string | null;
  note: string;
}

export interface OverlapDiagnostics {
  available: boolean;
  note: string;
  metrics: OverlapMetric[];
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

export interface ExplainableSelection {
  kind: "node" | "path" | "adjustment" | "estimator";
  id: string;
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
  recommendedAdjustmentSet: string[];
  forbiddenVariables: ForbiddenVariable[];
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

export const CONTRACT_VERSION = "0.2.0";
