from apps.backend.tests.helpers import analyze, edge, graph, node


def test_adjustment_engine_returns_all_valid_sets_and_marks_minimal_sets() -> None:
    result = analyze(
        graph(
            nodes=[node("Z"), node("W"), node("X"), node("Y")],
            edges=[edge("Z", "X"), edge("Z", "Y"), edge("W", "X"), edge("X", "Y")],
            treatment="X",
            outcome="Y",
        )
    )

    summaries = {tuple(item.variables): item for item in result.adjustmentSets}
    assert ("Z",) in summaries
    assert ("W", "Z") in summaries
    assert summaries[("Z",)].isMinimal is True
    assert summaries[("W", "Z")].isMinimal is False
    assert result.recommendedAdjustmentSet == ["Z"]
    assert summaries[("W", "Z")].practicalRating == "avoid"


def test_adjustment_engine_finds_multiple_minimal_sets() -> None:
    result = analyze(
        graph(
            nodes=[node("Z"), node("W1"), node("W2"), node("X"), node("Y")],
            edges=[edge("Z", "X"), edge("Z", "W1"), edge("Z", "W2"), edge("W1", "Y"), edge("W2", "Y"), edge("X", "Y")],
            treatment="X",
            outcome="Y",
        )
    )

    minimal_sets = {tuple(item.variables) for item in result.adjustmentSets if item.isMinimal}
    assert ("Z",) in minimal_sets
    assert ("W1", "W2") in minimal_sets
    assert result.recommendedAdjustmentSet == ["Z"]


def test_structurally_valid_but_practically_bad_set_is_not_recommended() -> None:
    result = analyze(
        graph(
            nodes=[node("A"), node("U"), node("X"), node("C"), node("B"), node("Y")],
            edges=[
                edge("A", "X"),
                edge("A", "C"),
                edge("B", "C"),
                edge("B", "Y"),
                edge("U", "X"),
                edge("U", "Y"),
            ],
            treatment="X",
            outcome="Y",
        )
    )

    summaries = {tuple(item.variables): item for item in result.adjustmentSets}
    assert ("U",) in summaries
    assert ("A", "C", "U") in summaries
    assert summaries[("A", "C", "U")].isValid is True
    assert summaries[("A", "C", "U")].practicalRating == "avoid"
    assert any("collider" in concern.lower() for concern in summaries[("A", "C", "U")].practicalConcerns)
    assert result.recommendedAdjustmentSet == ["U"]


def test_forbidden_variables_and_recommendation_exclude_mediator_collider_and_treatment_descendants() -> None:
    result = analyze(
        graph(
            nodes=[node("Z"), node("X"), node("M"), node("D"), node("Y"), node("C"), node("U")],
            edges=[
                edge("Z", "X"),
                edge("Z", "Y"),
                edge("X", "M"),
                edge("M", "Y"),
                edge("M", "D"),
                edge("X", "C"),
                edge("U", "C"),
                edge("U", "Y"),
            ],
            treatment="X",
            outcome="Y",
        )
    )

    forbidden = {item.nodeId: item.reasons for item in result.forbiddenVariables}
    assert "M" in forbidden
    assert "D" in forbidden
    assert "C" in forbidden
    assert result.recommendedAdjustmentSet == ["Z"]


def test_no_valid_adjustment_set_with_unobserved_confounding_withholds_recommendations_and_code() -> None:
    result = analyze(
        graph(
            nodes=[node("U", observed=False), node("X"), node("Y")],
            edges=[edge("U", "X"), edge("U", "Y")],
            treatment="X",
            outcome="Y",
        )
    )

    assert result.adjustmentSets == []
    assert result.recommendedAdjustmentSet == []
    assert result.estimatorRecommendations == []
    assert result.codeSnippets == []
    assert any(issue.code == "no_valid_adjustment_set" for issue in result.validation.issues)
