from __future__ import annotations

import networkx as nx

from apps.backend.app.core.graph_utils import RawPathRecord, ancestors_map, descendants_map, is_collider
from apps.backend.app.models.schemas import NodeRoleSummary


def find_mediators(dag: nx.DiGraph, treatment: str, outcome: str) -> set[str]:
    mediators: set[str] = set()
    if not nx.has_path(dag, treatment, outcome):
        return mediators
    for path in nx.all_simple_paths(dag, treatment, outcome):
        mediators.update(path[1:-1])
    return mediators


def summarize_node_roles(
    dag: nx.DiGraph,
    raw_paths: list[RawPathRecord],
    treatment: str,
    outcome: str,
) -> list[NodeRoleSummary]:
    ancestors = ancestors_map(dag)
    descendants = descendants_map(dag)
    mediators = find_mediators(dag, treatment, outcome)
    collider_nodes = {
        node
        for raw_path in raw_paths
        for previous_node, node, next_node in zip(raw_path.nodes, raw_path.nodes[1:], raw_path.nodes[2:], strict=False)
        if is_collider(dag, previous_node, node, next_node)
    }

    summaries: list[NodeRoleSummary] = []
    for node in sorted(dag.nodes):
        if node in {treatment, outcome}:
            continue
        roles: list[str] = []
        evidence: list[str] = []
        if node in ancestors[treatment]:
            roles.append("ancestor_of_treatment")
            evidence.append(f"{node} is an ancestor of {treatment}.")
        if node in ancestors[outcome]:
            roles.append("ancestor_of_outcome")
            evidence.append(f"{node} is an ancestor of {outcome}.")
        if node in descendants[treatment]:
            roles.append("descendant_of_treatment")
            evidence.append(f"{node} is a descendant of {treatment}.")
        if node in mediators:
            roles.append("mediator")
            evidence.append(f"{node} lies on at least one directed path from {treatment} to {outcome}.")
        if node in collider_nodes:
            roles.append("collider")
            evidence.append(f"{node} acts as a collider on at least one treatment-outcome path.")
        if node in ancestors[treatment] and node in ancestors[outcome] and node not in descendants[treatment]:
            roles.append("confounder")
            evidence.append(f"{node} is an ancestor of both treatment and outcome, creating confounding structure.")
        if not roles:
            evidence.append(f"{node} does not play a highlighted role relative to ({treatment}, {outcome}).")
        summaries.append(
            NodeRoleSummary(
                nodeId=node,
                roles=roles,
                summary=_role_summary(node, roles),
                evidence=evidence,
            )
        )
    return summaries


def _role_summary(node: str, roles: list[str]) -> str:
    if "confounder" in roles:
        return f"{node} behaves like a confounder relative to the selected treatment and outcome."
    if "mediator" in roles:
        return f"{node} sits on a directed treatment-to-outcome path and acts as a mediator."
    if "collider" in roles:
        return f"{node} is a collider on at least one relevant path and should be handled carefully."
    if "descendant_of_treatment" in roles:
        return f"{node} is downstream of treatment and is generally not recommended for total-effect adjustment."
    if "ancestor_of_treatment" in roles or "ancestor_of_outcome" in roles:
        return f"{node} is structurally upstream of the selected treatment/outcome pair."
    return f"{node} has no highlighted role in the current analysis."

