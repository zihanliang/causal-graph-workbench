from apps.backend.app.core.validation import validate_graph
from apps.backend.tests.helpers import edge, graph, node


def test_validation_flags_cycle_and_self_loop() -> None:
    result = validate_graph(
        graph(
            nodes=[node("X"), node("Y")],
            edges=[edge("X", "Y", "e1"), edge("Y", "X", "e2"), edge("X", "X", "e3")],
            treatment="X",
            outcome="Y",
        )
    )

    assert result.canAnalyze is False
    codes = {issue.code for issue in result.issues}
    assert "self_loop" in codes
    assert "cycle_detected" in codes


def test_validation_flags_duplicate_edge_and_empty_graph_and_invalid_names() -> None:
    empty_result = validate_graph(graph(nodes=[], edges=[], treatment=None, outcome=None))
    assert empty_result.canAnalyze is False
    assert "empty_graph" in {issue.code for issue in empty_result.issues}

    invalid_result = validate_graph(
        graph(
            nodes=[node("1bad"), node("Y")],
            edges=[edge("1bad", "Y", "e1"), edge("1bad", "Y", "e2")],
            treatment="1bad",
            outcome="Y",
        )
    )

    codes = {issue.code for issue in invalid_result.issues}
    assert "invalid_variable_name" in codes
    assert "duplicate_edge" in codes


def test_validation_warns_on_isolated_node_and_unreachable_treatment_outcome() -> None:
    result = validate_graph(
        graph(
            nodes=[node("X"), node("Y"), node("Z")],
            edges=[],
            treatment="X",
            outcome="Y",
        )
    )

    codes = {issue.code for issue in result.issues}
    assert result.canAnalyze is True
    assert "isolated_node" in codes
    assert "treatment_outcome_unreachable" in codes


def test_validation_requires_treatment_and_outcome() -> None:
    result = validate_graph(graph(nodes=[node("Z")], edges=[], treatment=None, outcome=None))

    assert result.canAnalyze is False
    codes = {issue.code for issue in result.issues}
    assert "missing_treatment" in codes
    assert "missing_outcome" in codes


def test_validation_warns_when_no_directed_causal_path_exists() -> None:
    result = validate_graph(
        graph(
            nodes=[node("X"), node("Y")],
            edges=[edge("Y", "X")],
            treatment="X",
            outcome="Y",
        )
    )

    assert result.canAnalyze is True
    assert "no_directed_path" in {issue.code for issue in result.issues}
