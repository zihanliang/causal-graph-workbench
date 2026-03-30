from apps.backend.tests.helpers import analyze, edge, graph, node


def test_node_roles_are_relative_to_selected_treatment_and_outcome() -> None:
    result = analyze(
        graph(
            nodes=[node("Z"), node("X"), node("M"), node("D"), node("C"), node("U"), node("Y")],
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

    roles = {item.nodeId: set(item.roles) for item in result.nodeRoles}
    assert {"confounder", "ancestor_of_treatment", "ancestor_of_outcome"} <= roles["Z"]
    assert {"mediator", "descendant_of_treatment", "ancestor_of_outcome"} <= roles["M"]
    assert {"descendant_of_treatment"} <= roles["D"]
    assert {"collider", "descendant_of_treatment"} <= roles["C"]
    assert {"ancestor_of_outcome"} <= roles["U"]

