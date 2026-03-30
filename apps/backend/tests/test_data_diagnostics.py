from apps.backend.app.models.schemas import AnalysisRequest, DataContext, UploadedDataset
from apps.backend.app.services.analysis_service import analyze_request
from apps.backend.tests.helpers import edge, graph, node


def test_data_diagnostics_infer_types_missingness_balance_and_overlap() -> None:
    result = analyze_request(
        AnalysisRequest(
            graph=graph(
                nodes=[node("X"), node("Y"), node("Z")],
                edges=[edge("Z", "X"), edge("Z", "Y"), edge("X", "Y")],
                treatment="X",
                outcome="Y",
            ),
            dataContext=DataContext(hasData=True, treatmentType="unknown", outcomeType="unknown"),
            dataset=UploadedDataset(
                filename="study.csv",
                content=(
                    "X,Y,Z\n"
                    "1,10,20\n"
                    "0,7,25\n"
                    "1,11,\n"
                    "0,6,27\n"
                    "1,12,21\n"
                    "0,5,28\n"
                ),
            ),
        )
    )

    assert result.dataDiagnostics is not None
    assert result.dataDiagnostics.hasData is True
    assert result.dataDiagnostics.rowCount == 6
    profiles = {profile.columnName: profile for profile in result.dataDiagnostics.columnProfiles}
    assert profiles["X"].inferredType == "binary"
    assert profiles["Y"].inferredType == "continuous"
    assert profiles["Z"].missingCount == 1
    assert result.dataDiagnostics.treatmentBalance is not None
    assert result.dataDiagnostics.treatmentBalance.available is True
    assert result.dataDiagnostics.overlapDiagnostics is not None
    assert result.dataDiagnostics.overlapDiagnostics.available is True


def test_estimator_recommendation_uses_data_presence_and_high_dimensional_hint() -> None:
    result = analyze_request(
        AnalysisRequest(
            graph=graph(
                nodes=[node("Z1"), node("Z2"), node("Z3"), node("Z4"), node("Z5"), node("Z6"), node("Z7"), node("X"), node("Y")],
                edges=[
                    edge("Z1", "X"), edge("Z1", "Y"),
                    edge("Z2", "X"), edge("Z2", "Y"),
                    edge("Z3", "X"), edge("Z3", "Y"),
                    edge("Z4", "X"), edge("Z4", "Y"),
                    edge("Z5", "X"), edge("Z5", "Y"),
                    edge("Z6", "X"), edge("Z6", "Y"),
                    edge("Z7", "X"), edge("Z7", "Y"),
                    edge("X", "Y"),
                ],
                treatment="X",
                outcome="Y",
            ),
            dataContext=DataContext(hasData=True, treatmentType="binary", outcomeType="continuous", highDimensional=True),
        )
    )

    recommendations = {item.id: item for item in result.estimatorRecommendations}
    assert "aipw" in recommendations
    assert "matching" in recommendations
    assert any("high-dimensional" in caveat.lower() for caveat in recommendations["aipw"].caveats)
    assert any("matching becomes harder" in caveat.lower() for caveat in recommendations["matching"].caveats)


def test_estimator_recommendation_selects_a_single_default_estimator() -> None:
    aipw_result = analyze_request(
        AnalysisRequest(
            graph=graph(
                nodes=[node("Z"), node("X"), node("Y")],
                edges=[edge("Z", "X"), edge("Z", "Y"), edge("X", "Y")],
                treatment="X",
                outcome="Y",
            ),
            dataContext=DataContext(hasData=True, treatmentType="binary", outcomeType="continuous"),
        )
    )

    aipw_defaults = [item.id for item in aipw_result.estimatorRecommendations if item.recommended]
    assert aipw_defaults == ["aipw"]

    logistic_result = analyze_request(
        AnalysisRequest(
            graph=graph(
                nodes=[node("Z"), node("X"), node("Y")],
                edges=[edge("Z", "X"), edge("Z", "Y"), edge("X", "Y")],
                treatment="X",
                outcome="Y",
            ),
            dataContext=DataContext(hasData=False, treatmentType="binary", outcomeType="binary"),
        )
    )

    logistic_defaults = [item.id for item in logistic_result.estimatorRecommendations if item.recommended]
    assert logistic_defaults == ["logistic-regression"]
