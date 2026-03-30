from __future__ import annotations

from dataclasses import dataclass

import networkx as nx

from apps.backend.app.core.graph_utils import (
    RawPathRecord,
    descendants_map,
    format_path_string,
    is_collider,
    normalize_adjustment_set,
    path_category,
)
from apps.backend.app.models.schemas import PathAnalysisItem, PathEvaluation, PathEvaluationStep


@dataclass(frozen=True)
class EvaluatedPath:
    record: RawPathRecord
    default_evaluation: PathEvaluation


def evaluate_path(
    dag: nx.DiGraph,
    nodes: list[str],
    conditioning_set: set[str],
    descendants_lookup: dict[str, set[str]] | None = None,
) -> PathEvaluation:
    descendants_lookup = descendants_lookup or descendants_map(dag)
    blocked_by: list[str] = []
    opened_by: list[str] = []
    steps: list[PathEvaluationStep] = []

    for previous_node, node, next_node in zip(nodes, nodes[1:], nodes[2:], strict=False):
        collider = is_collider(dag, previous_node, node, next_node)
        descendants_conditioned = sorted(descendants_lookup[node] & conditioning_set)
        if collider:
            if node in conditioning_set or descendants_conditioned:
                witness = node if node in conditioning_set else descendants_conditioned[0]
                opened_by.append(witness)
                steps.append(
                    PathEvaluationStep(
                        nodeId=node,
                        kind="collider",
                        conditionedOnNode=node in conditioning_set,
                        conditionedOnDescendant=bool(descendants_conditioned),
                        descendantWitnesses=descendants_conditioned,
                        effect="opens_path",
                        explanation=(
                            f"{node} is a collider and is activated by conditioning on "
                            f"{node if node in conditioning_set else descendants_conditioned[0]}."
                        ),
                    )
                )
                continue
            blocked_by.append(node)
            steps.append(
                PathEvaluationStep(
                    nodeId=node,
                    kind="collider",
                    conditionedOnNode=False,
                    conditionedOnDescendant=False,
                    descendantWitnesses=[],
                    effect="blocks_path",
                    explanation=f"{node} is a collider and remains unconditioned, so it blocks the path.",
                )
            )
            continue

        if node in conditioning_set:
            blocked_by.append(node)
            steps.append(
                PathEvaluationStep(
                    nodeId=node,
                    kind="non_collider",
                    conditionedOnNode=True,
                    conditionedOnDescendant=False,
                    descendantWitnesses=[],
                    effect="blocks_path",
                    explanation=f"{node} is a non-collider in the conditioning set, so it blocks the path.",
                )
            )
            continue

        steps.append(
            PathEvaluationStep(
                nodeId=node,
                kind="non_collider",
                conditionedOnNode=False,
                conditionedOnDescendant=False,
                descendantWitnesses=[],
                effect="keeps_path_open",
                explanation=f"{node} is a non-collider and is not conditioned on, so the path stays open here.",
            )
        )

    is_open = not blocked_by
    if is_open:
        reason = " ".join(step.explanation for step in steps) or "No internal nodes block this path."
    else:
        reason = _blocked_reason(steps, blocked_by, opened_by)

    return PathEvaluation(
        conditioningSet=list(normalize_adjustment_set(conditioning_set)),
        status="open" if is_open else "blocked",
        isOpen=is_open,
        reason=reason,
        blockedBy=blocked_by,
        openedBy=opened_by,
        steps=steps,
    )


def enumerate_raw_paths(dag: nx.DiGraph, treatment: str, outcome: str) -> list[RawPathRecord]:
    undirected = dag.to_undirected()
    paths: list[RawPathRecord] = []
    for nodes in nx.all_simple_paths(undirected, treatment, outcome):
        colliders = tuple(
            node
            for previous_node, node, next_node in zip(nodes, nodes[1:], nodes[2:], strict=False)
            if is_collider(dag, previous_node, node, next_node)
        )
        paths.append(
            RawPathRecord(
                nodes=tuple(nodes),
                category=path_category(dag, nodes),
                involves_collider=bool(colliders),
                colliders=colliders,
                path_string=format_path_string(dag, nodes),
            )
        )
    return paths


def materialize_path_analysis(
    dag: nx.DiGraph,
    raw_paths: list[RawPathRecord],
    conditioning_sets: list[tuple[str, ...]],
) -> list[PathAnalysisItem]:
    descendants_lookup = descendants_map(dag)
    items: list[PathAnalysisItem] = []
    for index, raw_path in enumerate(raw_paths, start=1):
        default_eval = evaluate_path(dag, list(raw_path.nodes), set(), descendants_lookup)
        adjustment_evals = [
            evaluate_path(dag, list(raw_path.nodes), set(conditioning_set), descendants_lookup)
            for conditioning_set in conditioning_sets
        ]
        explanation = explain_path(raw_path, default_eval)
        items.append(
            PathAnalysisItem(
                id=f"path-{index}",
                nodes=list(raw_path.nodes),
                pathString=raw_path.path_string,
                category=raw_path.category,
                involvesCollider=raw_path.involves_collider,
                colliders=list(raw_path.colliders),
                defaultEvaluation=default_eval,
                adjustmentEvaluations=adjustment_evals,
                explanation=explanation,
            )
        )
    return items


def explain_path(raw_path: RawPathRecord, default_eval: PathEvaluation) -> str:
    if raw_path.category == "directed_causal":
        base = (
            f"{raw_path.path_string} is a directed causal path from treatment to outcome. "
            f"It represents part of the causal effect rather than a backdoor path."
        )
    elif raw_path.category == "backdoor":
        base = (
            f"{raw_path.path_string} is a backdoor path because it starts with an arrow into the treatment. "
            f"By default it is {default_eval.status}."
        )
    else:
        base = (
            f"{raw_path.path_string} is a noncausal path connecting treatment and outcome. "
            f"By default it is {default_eval.status}."
        )

    if raw_path.involves_collider:
        collider_list = ", ".join(raw_path.colliders)
        return f"{base} It involves collider structure at {collider_list}."
    return base


def _blocked_reason(steps: list[PathEvaluationStep], blocked_by: list[str], opened_by: list[str]) -> str:
    step_text = " ".join(step.explanation for step in steps)
    blocked_clause = f"The path is blocked by {', '.join(blocked_by)}."
    opened_clause = (
        f" Conditioning also activates collider structure via {', '.join(opened_by)}, but the path remains blocked overall."
        if opened_by
        else ""
    )
    return f"{step_text} {blocked_clause}{opened_clause}".strip()
