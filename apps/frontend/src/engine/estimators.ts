import type { DataContext, EstimatorRecommendation, VariableType } from "@causal-graph-workbench/shared";

export function modelFormula(
  outcome: string,
  treatment: string,
  covariates: string[],
  bindings: Record<string, string> = {},
): string {
  const rhs = [treatment, ...covariates].map((node) => bindings[node] ?? node).join(" + ");
  return `${bindings[outcome] ?? outcome} ~ ${rhs}`;
}

interface RecommendationOptions {
  treatmentType: VariableType;
  outcomeType: VariableType;
  bindings?: Record<string, string>;
}

export function recommendEstimators(
  treatment: string,
  outcome: string,
  covariates: string[],
  dataContext: DataContext,
  { treatmentType, outcomeType, bindings }: RecommendationOptions,
): EstimatorRecommendation[] {
  if (outcomeType === "categorical") {
    return [];
  }

  const formula = modelFormula(outcome, treatment, covariates, bindings);
  const hasData = Boolean(dataContext.hasData);
  const covariateCount = covariates.length;
  const highDimensional = Boolean(dataContext.highDimensional) || covariateCount >= 8;
  const caveats = commonCaveats(hasData, covariateCount, highDimensional, treatmentType, outcomeType);
  const recommendations: Omit<EstimatorRecommendation, "recommended">[] = [];

  if (outcomeType === "continuous" || outcomeType === "unknown") {
    recommendations.push({
      id: "linear-regression",
      name: "Linear regression adjustment",
      family: "regression",
      summary: "Fit a linear outcome model with treatment and the recommended adjustment covariates.",
      rationale: [
        "Continuous outcomes are naturally aligned with a linear outcome model.",
        "The backdoor adjustment set enters directly and transparently.",
        "This remains a strong default when data are available and the confounder set is moderate.",
      ],
      supportedWhen: ["Outcome is continuous or approximately continuous.", "Model specification can be defended."],
      formulaPreview: formula,
      priority: outcomeType === "continuous" ? 95 : 60,
      caveats,
    });
  }

  if (outcomeType === "binary" || outcomeType === "unknown") {
    recommendations.push({
      id: "logistic-regression",
      name: "Logistic regression adjustment",
      family: "regression",
      summary: "Fit a logistic outcome model with treatment and the recommended adjustment covariates.",
      rationale: [
        "Binary outcomes generally call for a Bernoulli likelihood with a logit link.",
        "The adjustment set is kept explicit in the model formula.",
        "The generated code reports both the conditional odds ratio and a standardized risk difference.",
      ],
      supportedWhen: ["Outcome is binary.", "Separation and sparse cells are not severe."],
      formulaPreview: formula,
      priority: outcomeType === "binary" ? 94 : 60,
      caveats,
    });
  }

  if (treatmentType === "binary") {
    recommendations.push(
      {
        id: "propensity-weighting",
        name: "Propensity score weighting",
        family: "weighting",
        summary:
          "Estimates the average treatment effect (ATE) by modelling treatment from the adjustment covariates and comparing weighted outcomes.",
        rationale: [
          "Binary treatment makes inverse-probability weighting available.",
          "Useful when you want a design-style adjustment rather than relying only on outcome regression.",
          "Best used when overlap looks reasonable.",
        ],
        supportedWhen: ["Treatment is binary.", "Estimated propensities stay away from 0 and 1."],
        formulaPreview: formula,
        priority: hasData && !highDimensional ? 88 : 72,
        caveats: [
          ...(hasData ? [] : ["Most useful after data are uploaded so overlap can be previewed."]),
          ...(highDimensional ? ["High-dimensional covariate sets can destabilize the propensity model."] : []),
        ],
      },
      {
        id: "matching",
        name: "Propensity score matching",
        family: "matching",
        summary:
          "Estimates the average treatment effect on the treated (ATT) by matching each treated unit to its nearest control on the propensity score.",
        rationale: [
          "Provides a concrete design-stage interpretation of the adjustment set.",
          "Often easiest to defend when the matched covariate space is not too large.",
          "Answers a different question from ATE estimators: the effect among those actually treated.",
        ],
        supportedWhen: ["Treatment is binary.", "The effective confounder dimension is still manageable."],
        formulaPreview: formula,
        priority: hasData && covariateCount <= 6 && !highDimensional ? 82 : 55,
        caveats: [
          "The generated code reports a point estimate and balance only. Use a dedicated package such as MatchIt for valid matching standard errors.",
          ...(covariateCount <= 6 ? [] : ["Matching becomes harder to tune and justify when many covariates must be balanced."]),
          ...(hasData ? [] : ["Most useful after data are uploaded so balance can be inspected."]),
        ],
      },
      {
        id: "aipw",
        name: "Doubly robust / AIPW",
        family: "doubly_robust",
        summary:
          "Estimates the ATE with a 95% confidence interval by combining a treatment model and an outcome model built on the same adjustment covariates.",
        rationale: [
          "Binary treatment makes AIPW a natural doubly robust option.",
          "Attractive when you want protection against one nuisance model being misspecified.",
        ],
        supportedWhen: ["Treatment is binary.", "Sample size is adequate for fitting both nuisance models."],
        formulaPreview: formula,
        priority: hasData && !highDimensional ? 99 : 68,
        caveats: [
          ...(hasData ? [] : ["Most useful after data are uploaded so nuisance models and overlap can be checked."]),
          ...(highDimensional ? ["High-dimensional nuisance models may require regularization beyond this first implementation."] : []),
        ],
      },
    );
  }

  recommendations.push({
    id: "dowhy-pipeline",
    name: "DoWhy pipeline",
    family: "library_template",
    summary: "Generate a causal-workflow template that mirrors the DAG and recommended adjustment set.",
    rationale: [
      "Useful when you want a causality-oriented Python workflow with the estimand made explicit.",
      "Keeps the graph-side reasoning and the estimation code aligned.",
    ],
    supportedWhen: ["Python workflow is preferred."],
    formulaPreview: formula,
    priority: 50,
    caveats: [],
  });

  const defaultId = defaultEstimatorId(new Set(recommendations.map((item) => item.id)), hasData, treatmentType, outcomeType);
  return recommendations
    .map((item) => ({ ...item, recommended: item.id === defaultId }))
    .sort((left, right) => right.priority - left.priority);
}

function commonCaveats(
  hasData: boolean,
  covariateCount: number,
  highDimensional: boolean,
  treatmentType: VariableType,
  outcomeType: VariableType,
): string[] {
  const caveats: string[] = [];
  if (!hasData) {
    caveats.push("Recommendation is structural; no dataset has been uploaded yet.");
  }
  if (treatmentType === "unknown" || outcomeType === "unknown") {
    caveats.push("Treatment or outcome type is still unknown, so this is a provisional default recommendation.");
  }
  if (covariateCount >= 6) {
    caveats.push("Many adjustment covariates are being conditioned on, which can increase estimation complexity.");
  }
  if (highDimensional) {
    caveats.push("A high-dimensional setting may require regularization or more careful nuisance-model tuning.");
  }
  return caveats;
}

function defaultEstimatorId(
  available: Set<string>,
  hasData: boolean,
  treatmentType: VariableType,
  outcomeType: VariableType,
): string {
  // The estimate the app shows uses AIPW in this case, so the recommendation has to agree with it.
  if (hasData && treatmentType === "binary" && available.has("aipw")) {
    return "aipw";
  }
  if (outcomeType === "binary" && available.has("logistic-regression")) {
    return "logistic-regression";
  }
  return available.has("linear-regression") ? "linear-regression" : "logistic-regression";
}
