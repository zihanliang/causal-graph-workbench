from __future__ import annotations

from fastapi import APIRouter

from apps.backend.app.models.schemas import AnalysisRequest, AnalysisResult, GraphTemplate, ValidationSummary
from apps.backend.app.services.analysis_service import analyze_request, template_graphs
from apps.backend.app.core.validation import validate_graph


router = APIRouter(prefix="/api")


@router.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok"}


@router.get("/templates", response_model=list[GraphTemplate])
def get_templates() -> list[GraphTemplate]:
    return template_graphs()


@router.post("/validate", response_model=ValidationSummary)
def validate(request: AnalysisRequest) -> ValidationSummary:
    return validate_graph(request.graph)


@router.post("/analyze", response_model=AnalysisResult)
def analyze(request: AnalysisRequest) -> AnalysisResult:
    return analyze_request(request)

