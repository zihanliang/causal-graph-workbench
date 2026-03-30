from __future__ import annotations

from apps.backend.app.models.schemas import AnalysisRequest, GraphEdge, GraphNode, GraphSpec
from apps.backend.app.services.analysis_service import analyze_request


def node(node_id: str, x: float = 0.0, y: float = 0.0, *, observed: bool = True) -> GraphNode:
    return GraphNode(id=node_id, label=node_id, x=x, y=y, observed=observed)


def edge(source: str, target: str, edge_id: str | None = None) -> GraphEdge:
    return GraphEdge(id=edge_id or f"{source}->{target}", source=source, target=target)


def graph(
    *,
    nodes: list[GraphNode],
    edges: list[GraphEdge],
    treatment: str | None,
    outcome: str | None,
) -> GraphSpec:
    return GraphSpec(nodes=nodes, edges=edges, treatmentId=treatment, outcomeId=outcome)


def analyze(graph_spec: GraphSpec):
    return analyze_request(
        AnalysisRequest(
            graph=graph_spec,
        )
    )
