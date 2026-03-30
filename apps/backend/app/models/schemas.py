from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, Field


Severity = Literal["error", "warning", "info"]
VariableType = Literal["unknown", "binary", "continuous", "categorical"]
PathCategory = Literal["directed_causal", "backdoor", "noncausal"]
PathStatus = Literal["open", "blocked"]
PathNodeKind = Literal["collider", "non_collider"]
PathStepEffect = Literal["opens_path", "blocks_path", "keeps_path_open"]
RoleType = Literal[
    "confounder",
    "mediator",
    "collider",
    "descendant_of_treatment",
    "ancestor_of_treatment",
    "ancestor_of_outcome",
]


class GraphNode(BaseModel):
    id: str
    label: str
    x: float
    y: float
    observed: bool = True
    description: str | None = None


class GraphEdge(BaseModel):
    id: str
    source: str
    target: str


class GraphSpec(BaseModel):
    nodes: list[GraphNode] = Field(default_factory=list)
    edges: list[GraphEdge] = Field(default_factory=list)
    treatmentId: str | None = None
    outcomeId: str | None = None


class DataContext(BaseModel):
    hasData: bool = False
    treatmentType: VariableType = "unknown"
    outcomeType: VariableType = "unknown"
    datasetName: str | None = None
    highDimensional: bool = False
    columnBindings: dict[str, str] = Field(default_factory=dict)


class UploadedDataset(BaseModel):
    filename: str | None = None
    content: str
    delimiter: str | None = None


class AnalysisRequest(BaseModel):
    graph: GraphSpec
    dataContext: DataContext = Field(default_factory=DataContext)
    dataset: UploadedDataset | None = None


class Issue(BaseModel):
    severity: Severity
    code: str
    message: str
    nodeIds: list[str] = Field(default_factory=list)
    edgeIds: list[str] = Field(default_factory=list)
    details: list[str] = Field(default_factory=list)


class ValidationSummary(BaseModel):
    canAnalyze: bool
    issues: list[Issue] = Field(default_factory=list)


class PathEvaluation(BaseModel):
    conditioningSet: list[str] = Field(default_factory=list)
    status: PathStatus
    isOpen: bool
    reason: str
    blockedBy: list[str] = Field(default_factory=list)
    openedBy: list[str] = Field(default_factory=list)
    steps: list["PathEvaluationStep"] = Field(default_factory=list)


class PathEvaluationStep(BaseModel):
    nodeId: str
    kind: PathNodeKind
    conditionedOnNode: bool
    conditionedOnDescendant: bool
    descendantWitnesses: list[str] = Field(default_factory=list)
    effect: PathStepEffect
    explanation: str


class PathAnalysisItem(BaseModel):
    id: str
    nodes: list[str]
    pathString: str
    category: PathCategory
    involvesCollider: bool
    colliders: list[str] = Field(default_factory=list)
    defaultEvaluation: PathEvaluation
    adjustmentEvaluations: list[PathEvaluation] = Field(default_factory=list)
    explanation: str


class NodeRoleSummary(BaseModel):
    nodeId: str
    roles: list[RoleType] = Field(default_factory=list)
    summary: str
    evidence: list[str] = Field(default_factory=list)


class AdjustmentSetSummary(BaseModel):
    id: str
    variables: list[str] = Field(default_factory=list)
    isValid: bool
    isMinimal: bool
    isRecommended: bool
    practicalRating: Literal["recommended", "acceptable", "avoid"]
    explanation: str
    blockedPathIds: list[str] = Field(default_factory=list)
    openedPathIds: list[str] = Field(default_factory=list)
    practicalConcerns: list[str] = Field(default_factory=list)


class ForbiddenVariable(BaseModel):
    nodeId: str
    reasons: list[str] = Field(default_factory=list)


class AssumptionItem(BaseModel):
    id: str
    title: str
    description: str
    category: Literal["identification", "estimation", "data"]
    level: Literal["critical", "warning", "info"]


class EstimatorRecommendation(BaseModel):
    id: str
    name: str
    family: str
    summary: str
    rationale: list[str] = Field(default_factory=list)
    supportedWhen: list[str] = Field(default_factory=list)
    formulaPreview: str
    recommended: bool
    priority: int = 0
    caveats: list[str] = Field(default_factory=list)


class CodeSnippet(BaseModel):
    id: str
    label: str
    language: Literal["python", "r"]
    estimatorId: str
    content: str


class GraphTemplate(BaseModel):
    id: str
    name: str
    description: str
    graph: GraphSpec


class VariableBinding(BaseModel):
    nodeId: str
    columnName: str | None = None
    matched: bool
    matchType: Literal["exact", "normalized", "provided", "unmatched"]
    note: str | None = None


class ColumnProfile(BaseModel):
    columnName: str
    inferredType: VariableType
    nonMissingCount: int
    missingCount: int
    missingRate: float
    uniqueCount: int
    exampleValues: list[str] = Field(default_factory=list)
    boundNodeIds: list[str] = Field(default_factory=list)


class MissingnessItem(BaseModel):
    columnName: str
    missingCount: int
    missingRate: float


class BalanceMetric(BaseModel):
    columnName: str
    treatedValue: str
    controlValue: str
    absoluteDifference: float | None = None
    standardizedDifference: float | None = None


class TreatmentBalanceSummary(BaseModel):
    available: bool
    treatmentColumn: str | None = None
    treatmentType: VariableType = "unknown"
    treatedCount: int | None = None
    controlCount: int | None = None
    treatedRate: float | None = None
    metrics: list[BalanceMetric] = Field(default_factory=list)
    note: str


class OverlapMetric(BaseModel):
    columnName: str
    overlapScore: float | None = None
    treatedRange: str | None = None
    controlRange: str | None = None
    note: str


class OverlapDiagnostics(BaseModel):
    available: bool
    note: str
    metrics: list[OverlapMetric] = Field(default_factory=list)
    warnings: list[str] = Field(default_factory=list)


class DataDiagnostics(BaseModel):
    hasData: bool
    datasetName: str | None = None
    rowCount: int = 0
    columnCount: int = 0
    columnProfiles: list[ColumnProfile] = Field(default_factory=list)
    variableBindings: list[VariableBinding] = Field(default_factory=list)
    missingness: list[MissingnessItem] = Field(default_factory=list)
    warnings: list[str] = Field(default_factory=list)
    treatmentBalance: TreatmentBalanceSummary | None = None
    overlapDiagnostics: OverlapDiagnostics | None = None


class AnalysisResult(BaseModel):
    validation: ValidationSummary
    graphStats: dict[str, int]
    paths: list[PathAnalysisItem] = Field(default_factory=list)
    nodeRoles: list[NodeRoleSummary] = Field(default_factory=list)
    adjustmentSets: list[AdjustmentSetSummary] = Field(default_factory=list)
    recommendedAdjustmentSet: list[str] = Field(default_factory=list)
    forbiddenVariables: list[ForbiddenVariable] = Field(default_factory=list)
    assumptions: list[AssumptionItem] = Field(default_factory=list)
    estimatorRecommendations: list[EstimatorRecommendation] = Field(default_factory=list)
    codeSnippets: list[CodeSnippet] = Field(default_factory=list)
    dataDiagnostics: DataDiagnostics | None = None
