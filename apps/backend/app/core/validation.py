from __future__ import annotations

import re

import networkx as nx

from apps.backend.app.core.graph_utils import build_dag, get_node_ids
from apps.backend.app.models.schemas import GraphSpec, Issue, ValidationSummary


VARIABLE_NAME_RE = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*$")


def _issue(
    severity: str,
    code: str,
    message: str,
    *,
    node_ids: list[str] | None = None,
    edge_ids: list[str] | None = None,
    details: list[str] | None = None,
) -> Issue:
    return Issue(
        severity=severity,
        code=code,
        message=message,
        nodeIds=node_ids or [],
        edgeIds=edge_ids or [],
        details=details or [],
    )


def validate_graph(graph: GraphSpec) -> ValidationSummary:
    issues: list[Issue] = []
    node_ids = get_node_ids(graph)

    if not graph.nodes:
        issues.append(_issue("error", "empty_graph", "Graph is empty. Add at least one node."))

    duplicate_nodes = sorted({node.id for node in graph.nodes if sum(other.id == node.id for other in graph.nodes) > 1})
    if duplicate_nodes:
        issues.append(
            _issue(
                "error",
                "duplicate_node_id",
                "Duplicate node ids detected.",
                node_ids=duplicate_nodes,
            )
        )

    invalid_names = sorted({node.id for node in graph.nodes if not VARIABLE_NAME_RE.match(node.id)})
    if invalid_names:
        issues.append(
            _issue(
                "error",
                "invalid_variable_name",
                "Variable names must match ^[A-Za-z_][A-Za-z0-9_]*$.",
                node_ids=invalid_names,
            )
        )

    seen_edges: set[tuple[str, str]] = set()
    duplicate_edges: list[str] = []
    dangling_edges: list[str] = []
    self_loops: list[str] = []
    for edge in graph.edges:
        if edge.source == edge.target:
            self_loops.append(edge.id)
        key = (edge.source, edge.target)
        if key in seen_edges:
            duplicate_edges.append(edge.id)
        seen_edges.add(key)
        if edge.source not in node_ids or edge.target not in node_ids:
            dangling_edges.append(edge.id)

    if self_loops:
        issues.append(_issue("error", "self_loop", "Self-loops are not allowed in a DAG.", edge_ids=self_loops))
    if duplicate_edges:
        issues.append(_issue("error", "duplicate_edge", "Duplicate directed edges detected.", edge_ids=duplicate_edges))
    if dangling_edges:
        issues.append(
            _issue(
                "error",
                "dangling_edge",
                "Some edges reference nodes that do not exist.",
                edge_ids=dangling_edges,
            )
        )

    if graph.treatmentId is None or graph.treatmentId not in node_ids:
        issues.append(_issue("error", "missing_treatment", "Select a valid treatment node."))
    if graph.outcomeId is None or graph.outcomeId not in node_ids:
        issues.append(_issue("error", "missing_outcome", "Select a valid outcome node."))

    hard_block_codes = {
        "empty_graph",
        "duplicate_node_id",
        "invalid_variable_name",
        "duplicate_edge",
        "dangling_edge",
    }

    if not any(issue.code in hard_block_codes for issue in issues):
        dag = build_dag(graph)
        if not nx.is_directed_acyclic_graph(dag):
            issues.append(_issue("error", "cycle_detected", "The graph contains a directed cycle."))
        isolated = sorted(nx.isolates(dag))
        if isolated:
            issues.append(
                _issue(
                    "warning",
                    "isolated_node",
                    "Isolated or disconnected nodes were detected.",
                    node_ids=isolated,
                )
            )
        treatment = graph.treatmentId if graph.treatmentId in node_ids else None
        outcome = graph.outcomeId if graph.outcomeId in node_ids else None
        if treatment and outcome:
            if not nx.has_path(dag.to_undirected(), treatment, outcome):
                issues.append(
                    _issue(
                        "warning",
                        "treatment_outcome_unreachable",
                        "Treatment and outcome are disconnected in the graph.",
                    )
                )
            elif not nx.has_path(dag, treatment, outcome):
                issues.append(
                    _issue(
                        "warning",
                        "no_directed_path",
                        "No directed causal path from treatment to outcome was found.",
                    )
                )
        issues.append(
            _issue(
                "info",
                "graph_summary",
                f"{len(graph.nodes)} nodes and {len(graph.edges)} edges loaded.",
            )
        )

    return ValidationSummary(
        canAnalyze=not any(issue.severity == "error" for issue in issues),
        issues=issues,
    )
