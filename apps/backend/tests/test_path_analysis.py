from apps.backend.app.core.graph_utils import build_dag
from apps.backend.app.core.path_analysis import enumerate_raw_paths, materialize_path_analysis
from apps.backend.tests.helpers import analyze, edge, graph, node


def test_path_analysis_enumerates_and_classifies_relevant_paths() -> None:
    result = analyze(
        graph(
            nodes=[node("Z"), node("X"), node("M"), node("Y")],
            edges=[edge("Z", "X"), edge("Z", "Y"), edge("X", "M"), edge("M", "Y"), edge("X", "Y")],
            treatment="X",
            outcome="Y",
        )
    )

    path_strings = {path.pathString: path for path in result.paths}
    assert set(path_strings) == {"X <- Z -> Y", "X -> M -> Y", "X -> Y"}
    assert path_strings["X <- Z -> Y"].category == "backdoor"
    assert path_strings["X -> M -> Y"].category == "directed_causal"
    assert path_strings["X -> Y"].category == "directed_causal"


def test_collider_path_is_blocked_by_default_and_opened_by_conditioning_on_collider_or_descendant() -> None:
    graph_spec = graph(
        nodes=[node("X"), node("A"), node("C"), node("D"), node("B"), node("Y")],
        edges=[edge("A", "X"), edge("A", "C"), edge("B", "C"), edge("C", "D"), edge("B", "Y")],
        treatment="X",
        outcome="Y",
    )
    dag = build_dag(graph_spec)
    raw_paths = enumerate_raw_paths(dag, "X", "Y")
    paths = materialize_path_analysis(dag, raw_paths, [("C",), ("D",)])

    collider_path = next(path for path in paths if path.pathString == "X <- A -> C <- B -> Y")
    assert collider_path.category == "backdoor"
    assert collider_path.involvesCollider is True
    assert collider_path.colliders == ["C"]
    assert collider_path.defaultEvaluation.isOpen is False
    assert collider_path.defaultEvaluation.blockedBy == ["C"]
    assert any(step.nodeId == "C" and step.effect == "blocks_path" for step in collider_path.defaultEvaluation.steps)

    conditioned_on_c = next(
        evaluation for evaluation in collider_path.adjustmentEvaluations if evaluation.conditioningSet == ["C"]
    )
    assert conditioned_on_c.isOpen is True
    assert conditioned_on_c.openedBy == ["C"]

    conditioned_on_d = next(
        evaluation for evaluation in collider_path.adjustmentEvaluations if evaluation.conditioningSet == ["D"]
    )
    assert conditioned_on_d.isOpen is True
    assert conditioned_on_d.openedBy == ["D"]
    assert any(step.nodeId == "C" and step.conditionedOnDescendant for step in conditioned_on_d.steps)


def test_path_analysis_reports_why_a_backdoor_path_is_blocked_by_conditioning() -> None:
    result = analyze(
        graph(
            nodes=[node("Z"), node("X"), node("Y")],
            edges=[edge("Z", "X"), edge("Z", "Y"), edge("X", "Y")],
            treatment="X",
            outcome="Y",
        )
    )

    backdoor_path = next(path for path in result.paths if path.category == "backdoor")
    adjusted = next(evaluation for evaluation in backdoor_path.adjustmentEvaluations if evaluation.conditioningSet == ["Z"])
    assert adjusted.isOpen is False
    assert adjusted.blockedBy == ["Z"]
    assert "blocks the path" in adjusted.reason
    assert any(step.nodeId == "Z" and step.effect == "blocks_path" for step in adjusted.steps)
