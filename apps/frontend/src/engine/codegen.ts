import type { CodeSnippet, Estimand, VariableType } from "@causal-graph-workbench/shared";

import type { BinaryCoding } from "./data/diagnostics";
import { CI_MULTIPLIER } from "./effect";

/**
 * Generated code is run against data with a known true effect by
 * tools/verification/verify_generated_code.py, so change these templates together with that script.
 */

export interface CodegenOptions {
  treatmentColumn: string;
  outcomeColumn: string;
  covariateColumns: string[];
  treatmentType: VariableType;
  outcomeType: VariableType;
  /** Present when the file writes this binary variable as words rather than 0/1. */
  treatmentCoding?: BinaryCoding | null;
  outcomeCoding?: BinaryCoding | null;
  filename?: string | null;
  estimand?: Estimand;
}

/** Written out with case variants, because the app ignores case when it recognises these markers. */
const NA_VALUES = [
  "",
  "na",
  "NA",
  "Na",
  "n/a",
  "N/A",
  "nan",
  "NaN",
  "NAN",
  "Nan",
  "null",
  "NULL",
  "Null",
  "none",
  "None",
  "NONE",
  "missing",
  "Missing",
  "MISSING",
  ".",
];

export function generateCodeSnippets(options: CodegenOptions): CodeSnippet[] {
  if (options.outcomeType === "categorical") {
    return [];
  }
  const outcomeIsBinary = options.outcomeType === "binary";
  const regressionEstimator = outcomeIsBinary ? "logistic-regression" : "linear-regression";

  const snippets: CodeSnippet[] = [
    {
      id: "python-statsmodels",
      label: "Python / statsmodels",
      language: "python",
      estimatorId: regressionEstimator,
      content: pythonStatsmodels(options),
    },
    {
      id: "python-dowhy",
      label: "Python / DoWhy",
      language: "python",
      estimatorId: "dowhy-pipeline",
      content: pythonDowhy(options),
    },
    {
      id: "r-template",
      label: "R / lm-glm",
      language: "r",
      estimatorId: regressionEstimator,
      content: rTemplate(options),
    },
  ];

  if (options.treatmentType === "binary") {
    snippets.push(
      {
        id: "python-weighting",
        label: "Python / weighting",
        language: "python",
        estimatorId: "propensity-weighting",
        content: pythonWeighting(options),
      },
      {
        id: "python-matching",
        label: "Python / matching",
        language: "python",
        estimatorId: "matching",
        content: pythonMatching(options),
      },
      {
        id: "python-aipw",
        label: "Python / AIPW",
        language: "python",
        estimatorId: "aipw",
        content: pythonAipw(options),
      },
    );
  }
  return snippets;
}

function lines(...parts: (string | false | null | undefined)[]): string {
  return `${parts.filter((part) => part !== false && part !== null && part !== undefined).join("\n")}\n`;
}

function pythonString(value: string): string {
  return JSON.stringify(value);
}

function pythonRecode(variable: string, label: string, coding: BinaryCoding | null | undefined): string[] {
  if (!coding) {
    return [];
  }
  return [
    // JSON-escaped, because a cell can hold a line break, which in a comment would start a line of code.
    `# ${label} is recoded to 0/1. Assumed coding: ${pythonString(coding.high)} = 1, ${pythonString(coding.low)} = 0. Swap these if that is wrong.`,
    `df[${variable}] = df[${variable}].astype(str).str.strip().str.lower().map({${pythonString(coding.high)}: 1, ${pythonString(coding.low)}: 0})`,
    "",
  ];
}

function pythonSetup(options: CodegenOptions, imports: string[]): string[] {
  const { treatmentColumn, outcomeColumn, covariateColumns, treatmentCoding, outcomeCoding, filename } = options;
  return [
    ...imports,
    "",
    "# Load the data table used for estimation.",
    `df = pd.read_csv(${pythonString(filename || "your_data.csv")}, na_values=${JSON.stringify(NA_VALUES)})`,
    "",
    "# Bind dataset columns so the estimation code matches the graph.",
    `treatment_col = ${pythonString(treatmentColumn)}`,
    `outcome_col = ${pythonString(outcomeColumn)}`,
    `adjustment_covariates = ${JSON.stringify(covariateColumns)}`,
    "",
    ...pythonRecode("treatment_col", "Treatment", treatmentCoding),
    ...pythonRecode("outcome_col", "Outcome", outcomeCoding),
    "# Keep complete cases for the variables this model uses.",
    "n_total = len(df)",
    "df = df.dropna(subset=[treatment_col, outcome_col, *adjustment_covariates]).copy()",
    'print(f"Using {len(df)} of {n_total} rows with complete data.")',
    "",
  ];
}

const PYTHON_MODEL_TERMS = [
  "# Build a formula from the exact recommended adjustment covariates.",
  // {col!r} quotes the name properly. A formula is evaluated as code, so a stray quote in a column name must not end the string.
  "terms = [f'Q({col!r})' for col in [treatment_col, *adjustment_covariates]]",
  "formula = f'Q({outcome_col!r}) ~ ' + \" + \".join(terms)",
  "",
];

const PYTHON_PROPENSITY = [
  "# Model treatment from the adjustment covariates.",
  "propensity_rhs = \" + \".join(f'Q({col!r})' for col in adjustment_covariates) or \"1\"",
  "ps_model = smf.logit(f'Q({treatment_col!r}) ~ {propensity_rhs}', data=df).fit(disp=0)",
  'df["propensity_score"] = ps_model.predict(df)',
  'print(df.groupby(treatment_col)["propensity_score"].describe())',
  "",
];

function pythonStatsmodels(options: CodegenOptions): string {
  const hasScalarEffect = options.treatmentType !== "categorical";
  const outcomeIsBinary = options.outcomeType === "binary";
  const canStandardize = outcomeIsBinary && options.treatmentType === "binary";

  return lines(
    ...pythonSetup(options, ["import numpy as np", "import pandas as pd", "import statsmodels.formula.api as smf"]),
    ...PYTHON_MODEL_TERMS,
    outcomeIsBinary
      ? "# Fit the adjusted logistic model with robust standard errors."
      : "# Fit the adjusted linear model with robust standard errors.",
    outcomeIsBinary
      ? 'result = smf.logit(formula=formula, data=df).fit(disp=0, cov_type="HC1")'
      : 'result = smf.ols(formula=formula, data=df).fit(cov_type="HC1")',
    "",
    ...(hasScalarEffect
      ? [
          "effect_term = f'Q({treatment_col!r})'",
          "effect = result.params[effect_term]",
          "ci_low, ci_high = result.conf_int().loc[effect_term]",
          ...(outcomeIsBinary
            ? [
                "# This is a conditional odds ratio, which is not the same thing as a risk difference.",
                'print(f"Odds ratio for {treatment_col}: {np.exp(effect):.4g} (95% CI {np.exp(ci_low):.4g} to {np.exp(ci_high):.4g})")',
              ]
            : ['print(f"Effect of {treatment_col} on {outcome_col}: {effect:.4g} (95% CI {ci_low:.4g} to {ci_high:.4g})")']),
          "",
        ]
      : []),
    ...(canStandardize
      ? [
          "# Standardized risk difference: predict for everyone as treated, then as untreated.",
          "risk_difference = (",
          "    result.predict(df.assign(**{treatment_col: 1})) - result.predict(df.assign(**{treatment_col: 0}))",
          ").mean()",
          'print(f"Standardized risk difference: {risk_difference:.4g}")',
          "",
        ]
      : []),
    "print(result.summary())",
  );
}

function pythonDowhy(options: CodegenOptions): string {
  return lines(
    ...pythonSetup(options, ["import pandas as pd", "from dowhy import CausalModel"]),
    "# Mirror the backdoor setup in a DoWhy model.",
    "model = CausalModel(",
    "    data=df,",
    "    treatment=treatment_col,",
    "    outcome=outcome_col,",
    "    common_causes=adjustment_covariates,",
    ")",
    "",
    "identified_estimand = model.identify_effect(proceed_when_unidentifiable=True)",
    options.outcomeType === "binary"
      ? "# Linear regression on a binary outcome estimates a risk difference (linear probability model)."
      : null,
    "estimate = model.estimate_effect(",
    "    identified_estimand,",
    '    method_name="backdoor.linear_regression",',
    "    confidence_intervals=True,",
    ")",
    "",
    "print(identified_estimand)",
    "print(estimate)",
  );
}

function pythonWeighting(options: CodegenOptions): string {
  return lines(
    ...pythonSetup(options, ["import numpy as np", "import pandas as pd", "import statsmodels.formula.api as smf"]),
    ...PYTHON_PROPENSITY,
    "# Inverse-probability weights for the average treatment effect (ATE).",
    "# Scores are clipped to 0.01-0.99 so that a few extreme units cannot dominate the result.",
    'ps = df["propensity_score"].clip(0.01, 0.99)',
    'df["ipw"] = np.where(df[treatment_col] == 1, 1 / ps, 1 / (1 - ps))',
    "",
    options.outcomeType === "binary"
      ? "# The weighted difference in means is the ATE, here as a risk difference."
      : "# The weighted difference in means is the ATE.",
    "# Robust standard errors ignore that the weights are estimated, which is usually conservative.",
    "effect_formula = f'Q({outcome_col!r}) ~ Q({treatment_col!r})'",
    'effect_model = smf.wls(effect_formula, data=df, weights=df["ipw"]).fit(cov_type="HC1")',
    "effect_term = f'Q({treatment_col!r})'",
    "ate = effect_model.params[effect_term]",
    "ci_low, ci_high = effect_model.conf_int().loc[effect_term]",
    'print(f"IPW ATE: {ate:.4g} (95% CI {ci_low:.4g} to {ci_high:.4g})")',
  );
}

function pythonMatching(options: CodegenOptions): string {
  return lines(
    ...pythonSetup(options, [
      "import numpy as np",
      "import pandas as pd",
      "import statsmodels.formula.api as smf",
      "from sklearn.neighbors import NearestNeighbors",
    ]),
    "treated = df[df[treatment_col] == 1]",
    "control = df[df[treatment_col] == 0]",
    "",
    "# This estimates the effect on the treated (ATT), not the average effect in the whole sample (ATE).",
    "# It matches with replacement, and reports no standard error because a naive one would be wrong here.",
    "# For matching standard errors, use a dedicated package such as MatchIt in R.",
    "if adjustment_covariates:",
    ...PYTHON_PROPENSITY.map((line) => (line ? `    ${line}` : line)),
    "    treated = df[df[treatment_col] == 1]",
    "    control = df[df[treatment_col] == 0]",
    '    matcher = NearestNeighbors(n_neighbors=1).fit(control[["propensity_score"]])',
    '    match_index = matcher.kneighbors(treated[["propensity_score"]], return_distance=False).ravel()',
    "    matched_control = control.iloc[match_index]",
    "    att = (treated[outcome_col].to_numpy() - matched_control[outcome_col].to_numpy()).mean()",
    "",
    "    # Check balance: standardized mean differences should move toward 0 after matching.",
    "    covariates = pd.get_dummies(df[adjustment_covariates], dtype=float)",
    "    pooled_sd = np.sqrt((covariates.loc[treated.index].var() + covariates.loc[control.index].var()) / 2)",
    "    before = (covariates.loc[treated.index].mean() - covariates.loc[control.index].mean()) / pooled_sd",
    "    after = (covariates.loc[treated.index].mean() - covariates.loc[matched_control.index].mean()) / pooled_sd",
    '    print(pd.DataFrame({"smd_before": before, "smd_after": after}).round(3))',
    "else:",
    "    # With an empty adjustment set, there is nothing to match on, so this is the crude contrast.",
    "    att = treated[outcome_col].mean() - control[outcome_col].mean()",
    "",
    'print(f"Matched ATT: {att:.4g}")',
  );
}

function pythonAipw(options: CodegenOptions): string {
  const outcomeIsBinary = options.outcomeType === "binary";
  const isAtt = options.estimand === "att";
  return lines(
    ...pythonSetup(options, ["import numpy as np", "import pandas as pd", "import statsmodels.formula.api as smf"]),
    ...PYTHON_PROPENSITY,
    "# Fit the outcome model, letting the treatment effect vary with the covariates.",
    "outcome_terms = \" + \".join(f'Q({col!r})' for col in adjustment_covariates)",
    "outcome_rhs = f'Q({treatment_col!r}) * ({outcome_terms})' if outcome_terms else f'Q({treatment_col!r})'",
    outcomeIsBinary
      ? "outcome_model = smf.logit(f'Q({outcome_col!r}) ~ {outcome_rhs}', data=df).fit(disp=0)"
      : "outcome_model = smf.ols(f'Q({outcome_col!r}) ~ {outcome_rhs}', data=df).fit()",
    "",
    "# Predict each unit's outcome both as treated and as untreated.",
    "mu1 = outcome_model.predict(df.assign(**{treatment_col: 1}))",
    "mu0 = outcome_model.predict(df.assign(**{treatment_col: 0}))",
    "",
    "# Combine both models. The influence function gives the standard error.",
    isAtt
      ? "# Scores are capped at 0.99. Low scores need no floor here: those controls should get almost no weight."
      : "# Scores are clipped to 0.01-0.99 so that a few extreme units cannot dominate the result.",
    "t = df[treatment_col]",
    "y = df[outcome_col]",
    isAtt ? 'ps = df["propensity_score"].clip(upper=0.99)' : 'ps = df["propensity_score"].clip(0.01, 0.99)',
    ...(isAtt
      ? [
          "treated_share = t.mean()",
          "score = (t * (y - mu0) - (1 - t) * ps / (1 - ps) * (y - mu0)) / treated_share",
          "effect = score.mean()",
          "influence = score - t / treated_share * effect",
        ]
      : ["influence = mu1 - mu0 + t * (y - mu1) / ps - (1 - t) * (y - mu0) / (1 - ps)", "effect = influence.mean()"]),
    "se = influence.std(ddof=1) / np.sqrt(len(df))",
    `ci_low, ci_high = effect - ${CI_MULTIPLIER} * se, effect + ${CI_MULTIPLIER} * se`,
    `print(f"AIPW ${isAtt ? "ATT" : "ATE"}${outcomeIsBinary ? " (risk difference)" : ""}: {effect:.4g} (95% CI {ci_low:.4g} to {ci_high:.4g})")`,
  );
}

function rString(value: string): string {
  return JSON.stringify(value);
}

function rVector(values: string[]): string {
  return values.length ? `c(${values.map(rString).join(", ")})` : "character(0)";
}

function rRecode(variable: string, label: string, coding: BinaryCoding | null | undefined): string[] {
  if (!coding) {
    return [];
  }
  return [
    `# ${label} is recoded to 0/1. Assumed coding: ${rString(coding.high)} = 1, ${rString(coding.low)} = 0. Swap these if that is wrong.`,
    `coded <- tolower(trimws(df[[${variable}]]))`,
    `df[[${variable}]] <- ifelse(coded == ${rString(coding.high)}, 1, ifelse(coded == ${rString(coding.low)}, 0, NA))`,
    "",
  ];
}

function rTemplate(options: CodegenOptions): string {
  const { treatmentColumn, outcomeColumn, covariateColumns, treatmentCoding, outcomeCoding, filename, outcomeType } = options;
  const outcomeIsBinary = outcomeType === "binary";
  return lines(
    `df <- read.csv(${rString(filename || "your_data.csv")}, na.strings = ${rVector(NA_VALUES)}, check.names = FALSE)`,
    "",
    "# Bind dataset columns so the model matches the graph.",
    `treatment_col <- ${rString(treatmentColumn)}`,
    `outcome_col <- ${rString(outcomeColumn)}`,
    `adjustment_covariates <- ${rVector(covariateColumns)}`,
    "",
    ...rRecode("treatment_col", "Treatment", treatmentCoding),
    ...rRecode("outcome_col", "Outcome", outcomeCoding),
    "# Keep complete cases for the variables this model uses.",
    "used_cols <- c(treatment_col, outcome_col, adjustment_covariates)",
    "df <- df[complete.cases(df[, used_cols, drop = FALSE]), , drop = FALSE]",
    "",
    "# Build the model formula with the exact recommended covariates.",
    "# Backticks inside a name are escaped, because a formula is evaluated as code.",
    'quoted <- function(names) sprintf("`%s`", gsub("`", "\\\\`", names, fixed = TRUE))',
    'rhs_terms <- quoted(c(treatment_col, adjustment_covariates))',
    'formula <- as.formula(paste(quoted(outcome_col), "~", paste(rhs_terms, collapse = " + ")))',
    "",
    "# Fit the model. For robust standard errors, see the sandwich and lmtest packages.",
    outcomeIsBinary ? 'fit <- glm(formula, data = df, family = binomial(link = "logit"))' : "fit <- lm(formula, data = df)",
    "estimates <- cbind(estimate = coef(fit), confint.default(fit))",
    outcomeIsBinary ? "# Exponentiate to read these as conditional odds ratios." : null,
    outcomeIsBinary ? "print(exp(estimates))" : "print(estimates)",
    "print(summary(fit))",
  );
}
