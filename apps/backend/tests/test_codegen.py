from apps.backend.app.models.schemas import AnalysisRequest, DataContext, UploadedDataset
from apps.backend.tests.helpers import edge, graph, node
from apps.backend.app.services.analysis_service import analyze_request


def test_codegen_uses_recommended_covariates_consistently_across_templates() -> None:
    result = analyze_request(
        AnalysisRequest(
            graph=graph(
                nodes=[node("Z"), node("X"), node("Y")],
                edges=[edge("Z", "X"), edge("Z", "Y"), edge("X", "Y")],
                treatment="X",
                outcome="Y",
            ),
            dataContext=DataContext(treatmentType="binary", outcomeType="continuous"),
        )
    )

    snippets = {snippet.id: snippet.content for snippet in result.codeSnippets}
    assert "adjustment_covariates = ['Z']" in snippets["python-statsmodels"]
    assert 'treatment_col = "X"' in snippets["python-statsmodels"]
    assert 'outcome_col = "Y"' in snippets["python-statsmodels"]
    assert "treatment_node =" not in snippets["python-statsmodels"]
    assert "adjustment_nodes =" not in snippets["python-statsmodels"]
    assert "common_causes=adjustment_covariates" in snippets["python-dowhy"]
    assert 'treatment_col <- "X"' in snippets["r-template"]


def test_codegen_binds_uploaded_column_names_when_dataset_is_present() -> None:
    result = analyze_request(
        AnalysisRequest(
            graph=graph(
                nodes=[node("Z"), node("X"), node("Y")],
                edges=[edge("Z", "X"), edge("Z", "Y"), edge("X", "Y")],
                treatment="X",
                outcome="Y",
            ),
            dataContext=DataContext(
                hasData=True,
                treatmentType="unknown",
                outcomeType="unknown",
                columnBindings={"X": "treatment_status", "Y": "outcome_flag", "Z": "age_years"},
            ),
            dataset=UploadedDataset(
                filename="study.csv",
                content="treatment_status,outcome_flag,age_years\n1,0,20\n0,1,34\n1,1,29\n",
            ),
        )
    )

    snippets = {snippet.id: snippet.content for snippet in result.codeSnippets}
    assert 'treatment_col = "treatment_status"' in snippets["python-statsmodels"]
    assert 'outcome_col = "outcome_flag"' in snippets["python-statsmodels"]
    assert "adjustment_covariates = ['age_years']" in snippets["python-statsmodels"]
    assert 'treatment_col <- "treatment_status"' in snippets["r-template"]


def test_analysis_result_exposes_structured_assumptions_and_estimators() -> None:
    result = analyze_request(
        AnalysisRequest(
            graph=graph(
                nodes=[node("Z"), node("X"), node("Y")],
                edges=[edge("Z", "X"), edge("Z", "Y"), edge("X", "Y")],
                treatment="X",
                outcome="Y",
            ),
            dataContext=DataContext(treatmentType="binary", outcomeType="binary"),
        )
    )

    assert result.assumptions
    assert all(item.id and item.title and item.category for item in result.assumptions)
    assert any(
        item.description == "The tool does not verify the DAG is true. It only reasons conditionally on the DAG provided by the user."
        for item in result.assumptions
    )
    assert result.estimatorRecommendations
    assert all(item.id and item.name and item.family for item in result.estimatorRecommendations)


def test_codegen_handles_empty_adjustment_sets_without_inventing_covariates() -> None:
    result = analyze_request(
        AnalysisRequest(
            graph=graph(
                nodes=[node("X"), node("Y")],
                edges=[edge("X", "Y")],
                treatment="X",
                outcome="Y",
            ),
            dataContext=DataContext(hasData=True, treatmentType="binary", outcomeType="continuous"),
        )
    )

    snippets = {snippet.id: snippet.content for snippet in result.codeSnippets}
    assert "adjustment_covariates = []" in snippets["python-statsmodels"]
    assert "if adjustment_covariates:" in snippets["python-matching"]
    assert "crude treated-control contrast" in snippets["python-matching"]
