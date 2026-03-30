from apps.backend.app.models.schemas import AnalysisRequest, DataContext, UploadedDataset
from apps.backend.app.services.analysis_service import analyze_request
from apps.backend.tests.helpers import edge, graph, node


def test_unknown_treatment_type_does_not_offer_binary_treatment_only_estimators_or_code() -> None:
    result = analyze_request(
        AnalysisRequest(
            graph=graph(
                nodes=[node("Z"), node("X"), node("Y")],
                edges=[edge("Z", "X"), edge("Z", "Y"), edge("X", "Y")],
                treatment="X",
                outcome="Y",
            ),
            dataContext=DataContext(treatmentType="unknown", outcomeType="unknown"),
        )
    )

    estimator_ids = {item.id for item in result.estimatorRecommendations}
    snippet_ids = {item.id for item in result.codeSnippets}

    assert "propensity-weighting" not in estimator_ids
    assert "matching" not in estimator_ids
    assert "aipw" not in estimator_ids
    assert "python-weighting" not in snippet_ids
    assert "python-matching" not in snippet_ids
    assert "python-aipw" not in snippet_ids


def test_binary_treatment_inferred_from_uploaded_data_restores_binary_treatment_estimators() -> None:
    result = analyze_request(
        AnalysisRequest(
            graph=graph(
                nodes=[node("Z"), node("X"), node("Y")],
                edges=[edge("Z", "X"), edge("Z", "Y"), edge("X", "Y")],
                treatment="X",
                outcome="Y",
            ),
            dataContext=DataContext(hasData=True, treatmentType="unknown", outcomeType="continuous"),
            dataset=UploadedDataset(
                filename="study.csv",
                content="Z,X,Y\n0,0,1.2\n1,1,2.4\n1,0,1.1\n0,1,2.0\n",
            ),
        )
    )

    estimator_ids = {item.id for item in result.estimatorRecommendations}
    snippet_ids = {item.id for item in result.codeSnippets}

    assert "propensity-weighting" in estimator_ids
    assert "matching" in estimator_ids
    assert "aipw" in estimator_ids
    assert "python-weighting" in snippet_ids
    assert "python-matching" in snippet_ids
    assert "python-aipw" in snippet_ids
