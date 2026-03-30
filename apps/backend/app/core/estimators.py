from __future__ import annotations

from apps.backend.app.models.schemas import DataContext, EstimatorRecommendation, VariableType


def model_formula(
    outcome: str,
    treatment: str,
    covariates: list[str],
    column_bindings: dict[str, str] | None = None,
) -> str:
    column_bindings = column_bindings or {}
    outcome_name = column_bindings.get(outcome, outcome)
    rhs_terms = [column_bindings.get(treatment, treatment), *[column_bindings.get(node, node) for node in covariates]]
    rhs = " + ".join(rhs_terms) if rhs_terms else "1"
    return f"{outcome_name} ~ {rhs}"


def recommend_estimators(
    treatment: str,
    outcome: str,
    covariates: list[str],
    data_context: DataContext,
    *,
    treatment_type: VariableType,
    outcome_type: VariableType,
    column_bindings: dict[str, str] | None = None,
) -> list[EstimatorRecommendation]:
    formula = model_formula(outcome, treatment, covariates, column_bindings)
    has_data = bool(data_context.hasData)
    confounder_count = len(covariates)
    high_dimensional = bool(data_context.highDimensional) or confounder_count >= 8
    recommendations: list[EstimatorRecommendation] = []

    if outcome_type in {"continuous", "unknown"}:
        recommendations.append(
            EstimatorRecommendation(
                id="linear-regression",
                name="Linear regression adjustment",
                family="regression",
                summary="Fit a linear outcome model with treatment and the recommended adjustment covariates.",
                rationale=[
                    "Continuous outcomes are naturally aligned with a linear outcome model.",
                    "The backdoor adjustment set enters directly and transparently.",
                    "This remains a strong default when data are available and the confounder set is moderate.",
                ],
                supportedWhen=[
                    "Outcome is continuous or approximately continuous.",
                    "Model specification can be defended.",
                ],
                formulaPreview=formula,
                recommended=False,
                priority=95 if outcome_type == "continuous" else 60,
                caveats=_common_caveats(
                    has_data,
                    confounder_count,
                    high_dimensional,
                    treatment_type=treatment_type,
                    outcome_type=outcome_type,
                ),
            )
        )

    if outcome_type in {"binary", "unknown"}:
        recommendations.append(
            EstimatorRecommendation(
                id="logistic-regression",
                name="Logistic regression adjustment",
                family="regression",
                summary="Fit a logistic outcome model with treatment and the recommended adjustment covariates.",
                rationale=[
                    "Binary outcomes generally call for a Bernoulli likelihood with a logit link.",
                    "The adjustment set is kept explicit in the model formula.",
                    "This is often the clearest first-pass estimator when the outcome is binary.",
                ],
                supportedWhen=[
                    "Outcome is binary.",
                    "Separation and sparse cells are not severe.",
                ],
                formulaPreview=formula,
                recommended=False,
                priority=94 if outcome_type == "binary" else 60,
                caveats=_common_caveats(
                    has_data,
                    confounder_count,
                    high_dimensional,
                    treatment_type=treatment_type,
                    outcome_type=outcome_type,
                ),
            )
        )

    if treatment_type == "binary":
        weighting_priority = 88 if has_data and not high_dimensional else 72
        aipw_priority = 99 if has_data and not high_dimensional else 68
        matching_priority = 82 if has_data and confounder_count <= 6 and not high_dimensional else 55

        recommendations.append(
            EstimatorRecommendation(
                id="propensity-weighting",
                name="Propensity score weighting",
                family="weighting",
                summary="Model the treatment assignment from the adjustment covariates and weight the outcome comparison.",
                rationale=[
                    "Binary treatment makes inverse-probability weighting available.",
                    "Useful when you want a design-style adjustment rather than relying only on outcome regression.",
                    "Best used when overlap looks reasonable.",
                ],
                supportedWhen=[
                    "Treatment is binary.",
                    "Observed support overlap is not too thin.",
                ],
                formulaPreview=formula,
                recommended=False,
                priority=weighting_priority,
                caveats=[
                    *([] if has_data else ["Most useful after data are uploaded so overlap can be previewed."]),
                    *([] if not high_dimensional else ["High-dimensional covariate sets can destabilize the propensity model."]),
                ],
            )
        )
        recommendations.append(
            EstimatorRecommendation(
                id="matching",
                name="Matching",
                family="matching",
                summary="Match treated and control units on the recommended adjustment covariates before comparing outcomes.",
                rationale=[
                    "Provides a concrete design-stage interpretation of the adjustment set.",
                    "Often easiest to defend when the matched covariate space is not too large.",
                ],
                supportedWhen=[
                    "Treatment is binary.",
                    "The effective confounder dimension is still manageable.",
                ],
                formulaPreview=formula,
                recommended=False,
                priority=matching_priority,
                caveats=[
                    *([] if confounder_count <= 6 else ["Matching becomes harder to tune and justify when many covariates must be balanced."]),
                    *([] if has_data else ["Most useful after data are uploaded so balance can be inspected."]),
                ],
            )
        )
        recommendations.append(
            EstimatorRecommendation(
                id="aipw",
                name="Doubly robust / AIPW",
                family="doubly_robust",
                summary="Combine a treatment model and an outcome model built on the same adjustment covariates.",
                rationale=[
                    "Binary treatment makes AIPW a natural doubly robust option.",
                    "Attractive when you want protection against one nuisance model being misspecified.",
                ],
                supportedWhen=[
                    "Treatment is binary.",
                    "Sample size is adequate for fitting both nuisance models.",
                ],
                formulaPreview=formula,
                recommended=False,
                priority=aipw_priority,
                caveats=[
                    *([] if has_data else ["Most useful after data are uploaded so nuisance models and overlap can be checked."]),
                    *([] if not high_dimensional else ["High-dimensional nuisance models may require regularization beyond this first implementation."]),
                ],
            )
        )

    recommendations.append(
        EstimatorRecommendation(
            id="dowhy-pipeline",
            name="DoWhy pipeline",
            family="library_template",
            summary="Generate a causal-workflow template that mirrors the DAG and recommended adjustment set.",
            rationale=[
                "Useful when you want a causality-oriented Python workflow with the estimand made explicit.",
                "Keeps the graph-side reasoning and the estimation code aligned.",
            ],
            supportedWhen=["Python workflow is preferred."],
            formulaPreview=formula,
            recommended=False,
            priority=50,
            caveats=[],
        )
    )

    default_estimator_id = _default_estimator_id(
        recommendations,
        has_data=has_data,
        treatment_type=treatment_type,
        outcome_type=outcome_type,
        high_dimensional=high_dimensional,
    )
    recommendations = [
        recommendation.model_copy(update={"recommended": recommendation.id == default_estimator_id})
        for recommendation in recommendations
    ]
    return sorted(recommendations, key=lambda item: item.priority, reverse=True)


def _common_caveats(
    has_data: bool,
    confounder_count: int,
    high_dimensional: bool,
    *,
    treatment_type: VariableType,
    outcome_type: VariableType,
) -> list[str]:
    caveats: list[str] = []
    if not has_data:
        caveats.append("Recommendation is structural; no dataset has been uploaded yet.")
    if treatment_type == "unknown" or outcome_type == "unknown":
        caveats.append("Treatment or outcome type is still unknown, so this is a provisional default recommendation.")
    if confounder_count >= 6:
        caveats.append("Many adjustment covariates are being conditioned on, which can increase estimation complexity.")
    if high_dimensional:
        caveats.append("A high-dimensional setting may require regularization or more careful nuisance-model tuning.")
    return caveats


def _default_estimator_id(
    recommendations: list[EstimatorRecommendation],
    *,
    has_data: bool,
    treatment_type: VariableType,
    outcome_type: VariableType,
    high_dimensional: bool,
) -> str:
    available = {recommendation.id for recommendation in recommendations}

    if has_data and treatment_type == "binary" and not high_dimensional and "aipw" in available:
        return "aipw"
    if outcome_type == "binary" and "logistic-regression" in available:
        return "logistic-regression"
    if outcome_type == "continuous" and "linear-regression" in available:
        return "linear-regression"
    if "linear-regression" in available:
        return "linear-regression"
    if "logistic-regression" in available:
        return "logistic-regression"
    return max(recommendations, key=lambda item: item.priority).id
