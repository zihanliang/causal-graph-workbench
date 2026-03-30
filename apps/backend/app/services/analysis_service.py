from __future__ import annotations

import networkx as nx

from apps.backend.app.core.adjustment import (
    choose_recommended_set,
    forbidden_lookup,
    forbidden_variables,
    minimal_adjustment_sets,
    valid_adjustment_sets,
    summarize_adjustment_sets,
)
from apps.backend.app.core.codegen import generate_code_snippets
from apps.backend.app.core.data_diagnostics import infer_node_type, profile_dataset, resolved_column_bindings
from apps.backend.app.core.estimators import recommend_estimators
from apps.backend.app.core.graph_utils import build_dag, normalize_adjustment_set
from apps.backend.app.core.path_analysis import enumerate_raw_paths, materialize_path_analysis
from apps.backend.app.core.roles import summarize_node_roles
from apps.backend.app.core.validation import validate_graph
from apps.backend.app.models.schemas import (
    AnalysisRequest,
    AnalysisResult,
    AssumptionItem,
    GraphTemplate,
    GraphSpec,
    GraphNode,
    GraphEdge,
    Issue,
    ValidationSummary,
)


def analyze_request(request: AnalysisRequest) -> AnalysisResult:
    validation = validate_graph(request.graph)
    data_diagnostics = profile_dataset(request.graph, request.dataset, request.dataContext.columnBindings)
    effective_data_context = _effective_data_context(request, data_diagnostics)
    if not validation.canAnalyze:
        return AnalysisResult(
            validation=validation,
            graphStats=_graph_stats(request.graph, [], request.graph.treatmentId, request.graph.outcomeId),
            assumptions=_assumptions(),
            dataDiagnostics=data_diagnostics,
        )

    treatment = request.graph.treatmentId
    outcome = request.graph.outcomeId
    assert treatment is not None
    assert outcome is not None

    dag = build_dag(request.graph)
    raw_paths = enumerate_raw_paths(dag, treatment, outcome)
    node_roles = summarize_node_roles(dag, raw_paths, treatment, outcome)
    valid_sets = valid_adjustment_sets(dag, raw_paths, treatment, outcome)
    minimal_sets = minimal_adjustment_sets(valid_sets)
    if not valid_sets:
        validation = _append_issue(
            validation,
            Issue(
                severity="warning",
                code="no_valid_adjustment_set",
                message=(
                    "No valid observed adjustment set was found under backdoor adjustment. "
                    "Estimator recommendations and code templates are withheld."
                ),
            ),
        )
    forbidden_items = forbidden_variables(dag, treatment, outcome, node_roles)
    forbidden_map = forbidden_lookup(forbidden_items)
    recommended_set = choose_recommended_set(valid_sets, node_roles, forbidden_map)
    evaluation_sets = _dedupe_sets(
        [
            *minimal_sets,
            *(([recommended_set] if recommended_set is not None else [])),
        ]
    )
    paths = materialize_path_analysis(dag, raw_paths, evaluation_sets)
    adjustment_sets = summarize_adjustment_sets(dag, raw_paths, valid_sets, minimal_sets, recommended_set, forbidden_map)
    recommended_covariates = list(recommended_set) if recommended_set is not None else []
    column_bindings = resolved_column_bindings(request.graph, data_diagnostics)
    treatment_type = _effective_variable_type(effective_data_context.treatmentType, treatment, data_diagnostics)
    outcome_type = _effective_variable_type(effective_data_context.outcomeType, outcome, data_diagnostics)
    estimators = (
        recommend_estimators(
            treatment,
            outcome,
            recommended_covariates,
            effective_data_context,
            treatment_type=treatment_type,
            outcome_type=outcome_type,
            column_bindings=column_bindings,
        )
        if valid_sets
        else []
    )
    code_snippets = (
        generate_code_snippets(
            treatment,
            outcome,
            recommended_covariates,
            effective_data_context,
            treatment_type=treatment_type,
            outcome_type=outcome_type,
            column_bindings=column_bindings,
        )
        if valid_sets
        else []
    )

    return AnalysisResult(
        validation=validation,
        graphStats=_graph_stats(request.graph, raw_paths, treatment, outcome),
        paths=paths,
        nodeRoles=node_roles,
        adjustmentSets=adjustment_sets,
        recommendedAdjustmentSet=recommended_covariates,
        forbiddenVariables=forbidden_items,
        assumptions=_assumptions(),
        estimatorRecommendations=estimators,
        codeSnippets=code_snippets,
        dataDiagnostics=data_diagnostics,
    )


def template_graphs() -> list[GraphTemplate]:
    return [
        GraphTemplate(
            id="simple-confounding",
            name="Simple confounding",
            description="One confounder causes both treatment and outcome.",
            graph=GraphSpec(
                nodes=[
                    GraphNode(id="Z", label="Z", x=120, y=80),
                    GraphNode(id="X", label="X", x=320, y=60),
                    GraphNode(id="Y", label="Y", x=520, y=220),
                ],
                edges=[
                    GraphEdge(id="e1", source="Z", target="X"),
                    GraphEdge(id="e2", source="Z", target="Y"),
                    GraphEdge(id="e3", source="X", target="Y"),
                ],
                treatmentId="X",
                outcomeId="Y",
            ),
        ),
        GraphTemplate(
            id="mediation",
            name="Mediation example",
            description="A mediator lies on the directed path from treatment to outcome.",
            graph=GraphSpec(
                nodes=[
                    GraphNode(id="X", label="X", x=120, y=140),
                    GraphNode(id="M", label="M", x=320, y=140),
                    GraphNode(id="Y", label="Y", x=520, y=140),
                    GraphNode(id="Z", label="Z", x=320, y=20),
                ],
                edges=[
                    GraphEdge(id="e1", source="X", target="M"),
                    GraphEdge(id="e2", source="M", target="Y"),
                    GraphEdge(id="e3", source="X", target="Y"),
                    GraphEdge(id="e4", source="Z", target="X"),
                    GraphEdge(id="e5", source="Z", target="Y"),
                ],
                treatmentId="X",
                outcomeId="Y",
            ),
        ),
        GraphTemplate(
            id="collider-bias",
            name="Collider bias",
            description="Conditioning on a collider opens a noncausal path.",
            graph=GraphSpec(
                nodes=[
                    GraphNode(id="X", label="X", x=120, y=180),
                    GraphNode(id="C", label="C", x=320, y=100),
                    GraphNode(id="Y", label="Y", x=520, y=180),
                    GraphNode(id="U", label="U", x=320, y=260),
                ],
                edges=[
                    GraphEdge(id="e1", source="X", target="C"),
                    GraphEdge(id="e2", source="U", target="C"),
                    GraphEdge(id="e3", source="U", target="Y"),
                ],
                treatmentId="X",
                outcomeId="Y",
            ),
        ),
        GraphTemplate(
            id="selection-bias-shape",
            name="Selection bias example",
            description="Selection-like collider structure. The workbench still only reasons via standard backdoor logic.",
            graph=GraphSpec(
                nodes=[
                    GraphNode(id="X", label="X", x=120, y=180),
                    GraphNode(id="S", label="S", x=320, y=100),
                    GraphNode(id="Y", label="Y", x=520, y=180),
                    GraphNode(id="U", label="U", x=320, y=260),
                ],
                edges=[
                    GraphEdge(id="e1", source="X", target="S"),
                    GraphEdge(id="e2", source="Y", target="S"),
                    GraphEdge(id="e3", source="U", target="X"),
                    GraphEdge(id="e4", source="U", target="Y"),
                ],
                treatmentId="X",
                outcomeId="Y",
            ),
        ),
    ]


def _assumptions() -> list[AssumptionItem]:
    return [
        AssumptionItem(
            id="dag-correctness",
            title="DAG correctness is assumed",
            description="The tool does not verify the DAG is true. It only reasons conditionally on the DAG provided by the user.",
            category="identification",
            level="critical",
        ),
        AssumptionItem(
            id="no-unobserved-confounding",
            title="No unobserved confounding after adjustment",
            description="Backdoor-based recommendations assume the selected adjustment set closes the relevant noncausal paths and that important confounders are represented in the DAG.",
            category="identification",
            level="critical",
        ),
        AssumptionItem(
            id="positivity",
            title="Positivity / overlap",
            description="Each treatment level should remain plausible across the covariate strata used for adjustment.",
            category="data",
            level="warning",
        ),
        AssumptionItem(
            id="model-specification",
            title="Correct model specification",
            description="If you use parametric estimators such as OLS or logistic regression, the functional form and link assumptions still matter.",
            category="estimation",
            level="warning",
        ),
    ]


def _effective_variable_type(
    requested_type: str,
    node_id: str,
    data_diagnostics,
) -> str:
    if requested_type != "unknown":
        return requested_type
    inferred = infer_node_type(node_id, data_diagnostics)
    return inferred if inferred != "unknown" else requested_type


def _effective_data_context(request: AnalysisRequest, data_diagnostics) -> "DataContext":
    has_uploaded_data = bool(data_diagnostics and data_diagnostics.hasData)
    return request.dataContext.model_copy(
        update={
            "hasData": bool(request.dataContext.hasData or has_uploaded_data),
            "datasetName": request.dataContext.datasetName or (data_diagnostics.datasetName if data_diagnostics else None),
        }
    )


def _dedupe_sets(items: list[tuple[str, ...]]) -> list[tuple[str, ...]]:
    seen: set[tuple[str, ...]] = set()
    ordered: list[tuple[str, ...]] = []
    for item in items:
        normalized = normalize_adjustment_set(item)
        if normalized in seen:
            continue
        seen.add(normalized)
        ordered.append(normalized)
    return ordered


def _append_issue(validation: ValidationSummary, issue: Issue) -> ValidationSummary:
    return validation.model_copy(update={"issues": [*validation.issues, issue]})


def _graph_stats(
    graph: GraphSpec,
    raw_paths: list,
    treatment: str | None,
    outcome: str | None,
) -> dict[str, int]:
    directed_paths = len([path for path in raw_paths if getattr(path, "category", None) == "directed_causal"])
    open_backdoor_paths = 0
    if treatment and outcome and graph.nodes and graph.edges:
        dag = build_dag(graph)
        if nx.is_directed_acyclic_graph(dag) and treatment in dag and outcome in dag:
            open_backdoor_paths = len(
                [
                    path
                    for path in raw_paths
                    if getattr(path, "category", None) == "backdoor"
                    and materialize_path_analysis(dag, [path], [tuple()])[0].defaultEvaluation.isOpen
                ]
            )
    return {
        "nodeCount": len(graph.nodes),
        "edgeCount": len(graph.edges),
        "openBackdoorPathCount": open_backdoor_paths,
        "directedPathCount": directed_paths,
    }
