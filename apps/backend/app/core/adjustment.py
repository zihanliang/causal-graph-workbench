from __future__ import annotations

from itertools import combinations

import networkx as nx

from apps.backend.app.core.graph_utils import RawPathRecord, descendants_map, normalize_adjustment_set
from apps.backend.app.core.path_analysis import evaluate_path
from apps.backend.app.core.roles import find_mediators
from apps.backend.app.models.schemas import AdjustmentSetSummary, ForbiddenVariable, NodeRoleSummary


def candidate_adjustment_nodes(dag: nx.DiGraph, treatment: str, outcome: str) -> list[str]:
    treatment_descendants = descendants_map(dag)[treatment]
    return sorted(
        node
        for node, attrs in dag.nodes(data=True)
        if node not in {treatment, outcome}
        and node not in treatment_descendants
        and attrs.get("observed", True)
    )


def valid_adjustment_sets(
    dag: nx.DiGraph,
    raw_paths: list[RawPathRecord],
    treatment: str,
    outcome: str,
) -> list[tuple[str, ...]]:
    backdoor_paths = [path for path in raw_paths if path.category == "backdoor"]
    candidates = candidate_adjustment_nodes(dag, treatment, outcome)

    valid_sets: list[tuple[str, ...]] = []
    for size in range(0, len(candidates) + 1):
        for combo in combinations(candidates, size):
            if is_valid_adjustment_set(dag, backdoor_paths, treatment, combo):
                valid_sets.append(combo)
    return valid_sets


def minimal_adjustment_sets(valid_sets: list[tuple[str, ...]]) -> list[tuple[str, ...]]:
    minimal: list[tuple[str, ...]] = []
    for candidate in sorted(valid_sets, key=lambda value: (len(value), value)):
        if any(set(existing).issubset(candidate) for existing in minimal):
            continue
        minimal.append(candidate)
    return minimal


def is_valid_adjustment_set(
    dag: nx.DiGraph,
    backdoor_paths: list[RawPathRecord],
    treatment: str,
    adjustment_set: tuple[str, ...] | list[str] | set[str],
) -> bool:
    descendants_lookup = descendants_map(dag)
    conditioning_set = set(adjustment_set)
    if descendants_lookup[treatment] & conditioning_set:
        return False
    for backdoor_path in backdoor_paths:
        evaluation = evaluate_path(dag, list(backdoor_path.nodes), conditioning_set, descendants_lookup)
        if evaluation.isOpen:
            return False
    return True


def summarize_adjustment_sets(
    dag: nx.DiGraph,
    raw_paths: list[RawPathRecord],
    valid_sets: list[tuple[str, ...]],
    minimal_sets: list[tuple[str, ...]],
    recommended_set: tuple[str, ...] | None,
    forbidden_lookup: dict[str, list[str]],
) -> list[AdjustmentSetSummary]:
    backdoor_paths = [path for path in raw_paths if path.category == "backdoor"]
    minimal_lookup = {normalize_adjustment_set(item) for item in minimal_sets}
    summaries: list[AdjustmentSetSummary] = []

    for index, adjustment_set in enumerate(sorted(valid_sets, key=lambda value: (len(value), value)), start=1):
        blocked_path_ids: list[str] = []
        opened_path_ids: list[str] = []
        opened_by_path: dict[str, list[str]] = {}

        for raw_path_index, path in enumerate(raw_paths, start=1):
            evaluation = evaluate_path(dag, list(path.nodes), set(adjustment_set))
            if path.category == "backdoor" and not evaluation.isOpen:
                blocked_path_ids.append(f"path-{raw_path_index}")
            if evaluation.openedBy:
                opened_path_ids.append(f"path-{raw_path_index}")
                opened_by_path[f"path-{raw_path_index}"] = evaluation.openedBy

        practical_concerns = _practical_concerns(
            adjustment_set=adjustment_set,
            minimal_lookup=minimal_lookup,
            forbidden_lookup=forbidden_lookup,
            opened_path_ids=opened_path_ids,
            opened_by_path=opened_by_path,
        )
        practical_rating = _practical_rating(adjustment_set, recommended_set, practical_concerns)

        summaries.append(
            AdjustmentSetSummary(
                id=f"adj-{index}",
                variables=list(adjustment_set),
                isValid=True,
                isMinimal=normalize_adjustment_set(adjustment_set) in minimal_lookup,
                isRecommended=recommended_set is not None and adjustment_set == recommended_set,
                practicalRating=practical_rating,
                explanation=_adjustment_explanation(
                    adjustment_set=adjustment_set,
                    blocked_count=len(blocked_path_ids),
                    total_backdoor_paths=len(backdoor_paths),
                    is_minimal=normalize_adjustment_set(adjustment_set) in minimal_lookup,
                    practical_concerns=practical_concerns,
                ),
                blockedPathIds=blocked_path_ids,
                openedPathIds=sorted(set(opened_path_ids)),
                practicalConcerns=practical_concerns,
            )
        )

    return summaries


def choose_recommended_set(
    valid_sets: list[tuple[str, ...]],
    node_roles: list[NodeRoleSummary],
    forbidden_lookup: dict[str, list[str]],
) -> tuple[str, ...] | None:
    confounder_nodes = {summary.nodeId for summary in node_roles if "confounder" in summary.roles}
    candidate_sets = [
        adjustment_set
        for adjustment_set in valid_sets
        if all(node not in forbidden_lookup for node in adjustment_set)
    ]
    if not candidate_sets:
        return None

    def score(adjustment_set: tuple[str, ...]) -> tuple[int, int, tuple[str, ...]]:
        non_confounder_count = sum(node not in confounder_nodes for node in adjustment_set)
        return (len(adjustment_set), non_confounder_count, tuple(adjustment_set))

    return min(candidate_sets, key=score)


def forbidden_variables(
    dag: nx.DiGraph,
    treatment: str,
    outcome: str,
    node_roles: list[NodeRoleSummary],
) -> list[ForbiddenVariable]:
    mediators = find_mediators(dag, treatment, outcome)
    descendants = descendants_map(dag)[treatment]
    forbidden: list[ForbiddenVariable] = []
    for summary in node_roles:
        reasons: list[str] = []
        node = summary.nodeId
        if node in mediators:
            reasons.append("Acts as a mediator on a directed treatment-to-outcome path.")
        if node in descendants:
            reasons.append("Is downstream of treatment and should not be used for total-effect adjustment.")
        if "collider" in summary.roles and node not in descendants:
            reasons.append("Acts as a collider on at least one treatment-outcome path and may open biasing structure.")
        if reasons:
            forbidden.append(ForbiddenVariable(nodeId=node, reasons=reasons))
    return forbidden


def forbidden_lookup(forbidden_items: list[ForbiddenVariable]) -> dict[str, list[str]]:
    return {item.nodeId: item.reasons for item in forbidden_items}


def _practical_concerns(
    *,
    adjustment_set: tuple[str, ...],
    minimal_lookup: set[tuple[str, ...]],
    forbidden_lookup: dict[str, list[str]],
    opened_path_ids: list[str],
    opened_by_path: dict[str, list[str]],
) -> list[str]:
    concerns: list[str] = []

    if normalize_adjustment_set(adjustment_set) not in minimal_lookup:
        concerns.append("A smaller structurally valid adjustment set exists, so this set includes unnecessary variables.")

    for node in adjustment_set:
        if node in forbidden_lookup:
            concerns.extend(forbidden_lookup[node])

    for path_id in sorted(set(opened_path_ids)):
        activators = ", ".join(opened_by_path[path_id])
        concerns.append(f"{path_id} contains collider structure activated by conditioning on {activators}.")

    seen: set[str] = set()
    deduped: list[str] = []
    for concern in concerns:
        if concern in seen:
            continue
        seen.add(concern)
        deduped.append(concern)
    return deduped


def _practical_rating(
    adjustment_set: tuple[str, ...],
    recommended_set: tuple[str, ...] | None,
    practical_concerns: list[str],
) -> str:
    if recommended_set is not None and adjustment_set == recommended_set:
        return "recommended"
    if practical_concerns:
        return "avoid"
    return "acceptable"


def _adjustment_explanation(
    *,
    adjustment_set: tuple[str, ...],
    blocked_count: int,
    total_backdoor_paths: int,
    is_minimal: bool,
    practical_concerns: list[str],
) -> str:
    if not adjustment_set:
        base = "No open backdoor paths remain after using the empty adjustment set."
    else:
        joined = ", ".join(adjustment_set)
        base = (
            f"Adjusting for {{{joined}}} blocks {blocked_count} of {total_backdoor_paths} backdoor paths "
            "under the backdoor criterion."
        )

    minimal_clause = " It is minimal." if is_minimal else " It is structurally valid but not minimal."
    concern_clause = f" Practical concerns: {' '.join(practical_concerns)}" if practical_concerns else ""
    return f"{base}{minimal_clause}{concern_clause}"
