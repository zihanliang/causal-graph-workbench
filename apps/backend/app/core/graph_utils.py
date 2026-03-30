from __future__ import annotations

from collections.abc import Iterable
from dataclasses import dataclass

import networkx as nx

from apps.backend.app.models.schemas import GraphSpec


@dataclass(frozen=True)
class RawPathRecord:
    nodes: tuple[str, ...]
    category: str
    involves_collider: bool
    colliders: tuple[str, ...]
    path_string: str


def build_dag(graph: GraphSpec) -> nx.DiGraph:
    dag = nx.DiGraph()
    for node in graph.nodes:
        dag.add_node(node.id, label=node.label, observed=node.observed)
    for edge in graph.edges:
        dag.add_edge(edge.source, edge.target, id=edge.id)
    return dag


def get_node_ids(graph: GraphSpec) -> set[str]:
    return {node.id for node in graph.nodes}


def normalize_adjustment_set(values: Iterable[str]) -> tuple[str, ...]:
    return tuple(sorted(set(values)))


def arrow_points_into(dag: nx.DiGraph, source: str, target: str) -> bool:
    return dag.has_edge(source, target)


def is_collider(dag: nx.DiGraph, previous_node: str, node: str, next_node: str) -> bool:
    return arrow_points_into(dag, previous_node, node) and arrow_points_into(dag, next_node, node)


def format_path_string(dag: nx.DiGraph, nodes: list[str]) -> str:
    parts: list[str] = [nodes[0]]
    for left, right in zip(nodes, nodes[1:], strict=False):
        if dag.has_edge(left, right):
            parts.append(f"-> {right}")
        else:
            parts.append(f"<- {right}")
    return " ".join(parts)


def path_category(dag: nx.DiGraph, nodes: list[str]) -> str:
    if all(dag.has_edge(left, right) for left, right in zip(nodes, nodes[1:], strict=False)):
        return "directed_causal"
    if len(nodes) > 1 and dag.has_edge(nodes[1], nodes[0]):
        return "backdoor"
    return "noncausal"


def descendants_map(dag: nx.DiGraph) -> dict[str, set[str]]:
    return {node: nx.descendants(dag, node) for node in dag.nodes}


def ancestors_map(dag: nx.DiGraph) -> dict[str, set[str]]:
    return {node: nx.ancestors(dag, node) for node in dag.nodes}
