from __future__ import annotations

from apps.backend.app.models.schemas import CodeSnippet, DataContext, VariableType


def generate_code_snippets(
    treatment: str,
    outcome: str,
    covariates: list[str],
    data_context: DataContext,
    *,
    treatment_type: VariableType,
    outcome_type: VariableType,
    column_bindings: dict[str, str] | None = None,
) -> list[CodeSnippet]:
    column_bindings = column_bindings or {}
    treatment_col = column_bindings.get(treatment, treatment)
    outcome_col = column_bindings.get(outcome, outcome)
    covariate_cols = [column_bindings.get(node, node) for node in covariates]

    outcome_is_binary = outcome_type == "binary"
    treatment_is_binary = treatment_type == "binary"

    snippets: list[CodeSnippet] = [
        CodeSnippet(
            id="python-statsmodels",
            label="Python / statsmodels",
            language="python",
            estimatorId="logistic-regression" if outcome_is_binary else "linear-regression",
            content=_python_statsmodels(treatment_col, outcome_col, covariate_cols, outcome_is_binary),
        ),
        CodeSnippet(
            id="python-dowhy",
            label="Python / DoWhy",
            language="python",
            estimatorId="dowhy-pipeline",
            content=_python_dowhy(treatment_col, outcome_col, covariate_cols),
        ),
        CodeSnippet(
            id="r-template",
            label="R / lm-glm",
            language="r",
            estimatorId="logistic-regression" if outcome_is_binary else "linear-regression",
            content=_r_template(treatment_col, outcome_col, covariate_cols, outcome_is_binary),
        ),
    ]

    if treatment_is_binary:
        snippets.extend(
            [
                CodeSnippet(
                    id="python-weighting",
                    label="Python / weighting",
                    language="python",
                    estimatorId="propensity-weighting",
                    content=_python_weighting(treatment_col, outcome_col, covariate_cols, outcome_is_binary),
                ),
                CodeSnippet(
                    id="python-matching",
                    label="Python / matching",
                    language="python",
                    estimatorId="matching",
                    content=_python_matching(treatment_col, outcome_col, covariate_cols),
                ),
                CodeSnippet(
                    id="python-aipw",
                    label="Python / AIPW",
                    language="python",
                    estimatorId="aipw",
                    content=_python_aipw(treatment_col, outcome_col, covariate_cols, outcome_is_binary),
                ),
            ]
        )

    return snippets


def _python_statsmodels(
    treatment_col: str,
    outcome_col: str,
    covariate_cols: list[str],
    outcome_is_binary: bool,
) -> str:
    model_call = "smf.logit" if outcome_is_binary else "smf.ols"
    summary_call = "result.summary()" if outcome_is_binary else "result.summary2()"
    return f"""import pandas as pd
import statsmodels.formula.api as smf

# Load the data table used for estimation.
df = pd.read_csv("your_data.csv")

# Bind dataset columns so the estimation code matches the graph.
treatment_col = "{treatment_col}"
outcome_col = "{outcome_col}"
adjustment_covariates = {covariate_cols!r}

# Build a formula that uses the exact recommended adjustment covariates.
rhs_terms = [f'Q("{{treatment_col}}")'] + [f'Q("{{col}}")' for col in adjustment_covariates]
formula = f'Q("{{outcome_col}}") ~ ' + " + ".join(rhs_terms)

# Fit the adjusted model and print the model summary.
model = {model_call}(formula=formula, data=df)
result = model.fit()
print(result.params)
print({summary_call})
"""


def _python_dowhy(
    treatment_col: str,
    outcome_col: str,
    covariate_cols: list[str],
) -> str:
    return f"""import pandas as pd
from dowhy import CausalModel

# Load the observational dataset.
df = pd.read_csv("your_data.csv")

# Bind dataset columns so the DoWhy setup matches the graph.
treatment_col = "{treatment_col}"
outcome_col = "{outcome_col}"
adjustment_covariates = {covariate_cols!r}

# Mirror the backdoor setup in a DoWhy model.
model = CausalModel(
    data=df,
    treatment=treatment_col,
    outcome=outcome_col,
    common_causes=adjustment_covariates,
)

identified_estimand = model.identify_effect()
estimate = model.estimate_effect(
    identified_estimand,
    method_name="backdoor.linear_regression",
)

print(identified_estimand)
print(estimate)
"""


def _r_template(
    treatment_col: str,
    outcome_col: str,
    covariate_cols: list[str],
    outcome_is_binary: bool,
) -> str:
    fit_call = 'glm(formula, data = df, family = binomial(link = "logit"))' if outcome_is_binary else "lm(formula, data = df)"
    return f"""df <- read.csv("your_data.csv")

# Bind dataset columns so the model matches the graph.
treatment_col <- "{treatment_col}"
outcome_col <- "{outcome_col}"
adjustment_covariates <- c({", ".join(repr(col) for col in covariate_cols)})

# Build the model formula with the exact recommended covariates.
rhs_terms <- c(sprintf("`%s`", treatment_col), sprintf("`%s`", adjustment_covariates))
formula_text <- paste(sprintf("`%s`", outcome_col), "~", paste(rhs_terms, collapse = " + "))
formula <- as.formula(formula_text)

# Fit the model and print the summary.
fit <- {fit_call}
print(coef(fit))
summary(fit)
"""


def _python_weighting(treatment_col: str, outcome_col: str, covariate_cols: list[str], outcome_is_binary: bool) -> str:
    propensity_terms = " + ".join([f'Q("{column}")' for column in covariate_cols]) if covariate_cols else "1"
    outcome_family = ', family=sm.families.Binomial()' if outcome_is_binary else ""
    outcome_model = "smf.glm" if outcome_is_binary else "smf.wls"
    return f"""import numpy as np
import pandas as pd
import statsmodels.api as sm
import statsmodels.formula.api as smf

# Load the observational dataset.
df = pd.read_csv("your_data.csv")

treatment_col = "{treatment_col}"
outcome_col = "{outcome_col}"
adjustment_covariates = {covariate_cols!r}

# Fit a propensity model using the recommended adjustment covariates.
propensity_formula = f'Q("{{treatment_col}}") ~ {propensity_terms}'
ps_model = smf.logit(formula=propensity_formula, data=df).fit()
df["propensity_score"] = ps_model.predict(df)
df["ipw"] = np.where(df[treatment_col] == 1, 1 / df["propensity_score"], 1 / (1 - df["propensity_score"]))

# Fit a weighted outcome model for the treatment effect.
effect_formula = f'Q("{{outcome_col}}") ~ Q("{{treatment_col}}")'
effect_model = {outcome_model}(formula=effect_formula, data=df, weights=df["ipw"]{outcome_family})
effect_result = effect_model.fit()
print(effect_result.summary())
"""


def _python_matching(treatment_col: str, outcome_col: str, covariate_cols: list[str]) -> str:
    return f"""import pandas as pd
from sklearn.linear_model import LogisticRegression
from sklearn.neighbors import NearestNeighbors

# Load the observational dataset.
df = pd.read_csv("your_data.csv")

treatment_col = "{treatment_col}"
outcome_col = "{outcome_col}"
adjustment_covariates = {covariate_cols!r}

# Estimate a propensity score from the exact recommended adjustment covariates.
treated = df[df[treatment_col] == 1].copy()
control = df[df[treatment_col] == 0].copy()

if adjustment_covariates:
    ps_model = LogisticRegression(max_iter=1000)
    ps_model.fit(df[adjustment_covariates], df[treatment_col])
    df["propensity_score"] = ps_model.predict_proba(df[adjustment_covariates])[:, 1]

    # Match treated units to control units on the propensity score.
    treated = df[df[treatment_col] == 1].copy()
    control = df[df[treatment_col] == 0].copy()
    matcher = NearestNeighbors(n_neighbors=1)
    matcher.fit(control[["propensity_score"]])
    match_index = matcher.kneighbors(treated[["propensity_score"]], return_distance=False).ravel()
    matched_control = control.iloc[match_index].reset_index(drop=True)
    ate_match = (treated[outcome_col].reset_index(drop=True) - matched_control[outcome_col]).mean()
else:
    # With an empty adjustment set, matching collapses to the crude treated-control contrast.
    ate_match = treated[outcome_col].mean() - control[outcome_col].mean()

print({{"matched_ate": ate_match}})
"""


def _python_aipw(treatment_col: str, outcome_col: str, covariate_cols: list[str], outcome_is_binary: bool) -> str:
    outcome_model = "smf.logit" if outcome_is_binary else "smf.ols"
    predict_method = "predict"
    covariate_formula_terms = " + ".join([f'Q("{column}")' for column in covariate_cols]) if covariate_cols else "1"
    return f"""import numpy as np
import pandas as pd
import statsmodels.formula.api as smf

# Load the observational dataset.
df = pd.read_csv("your_data.csv")

treatment_col = "{treatment_col}"
outcome_col = "{outcome_col}"
adjustment_covariates = {covariate_cols!r}

# Fit the treatment model.
propensity_formula = f'Q("{{treatment_col}}") ~ {covariate_formula_terms}'
ps_model = smf.logit(formula=propensity_formula, data=df).fit()
df["propensity_score"] = ps_model.predict(df)

# Fit the outcome model with treatment and the same adjustment covariates.
outcome_rhs = [f'Q("{{treatment_col}}")'] + [f'Q("{{col}}")' for col in adjustment_covariates]
outcome_formula = f'Q("{{outcome_col}}") ~ ' + " + ".join(outcome_rhs)
mu_model = {outcome_model}(formula=outcome_formula, data=df).fit()

treated_df = df.copy()
treated_df[treatment_col] = 1
control_df = df.copy()
control_df[treatment_col] = 0
mu1 = mu_model.{predict_method}(treated_df)
mu0 = mu_model.{predict_method}(control_df)

# Compute the AIPW estimate.
treatment = df[treatment_col]
outcome = df[outcome_col]
ps = df["propensity_score"].clip(1e-6, 1 - 1e-6)
aipw = mu1 - mu0 + treatment * (outcome - mu1) / ps - (1 - treatment) * (outcome - mu0) / (1 - ps)
print({{"aipw_ate": float(aipw.mean())}})
"""
