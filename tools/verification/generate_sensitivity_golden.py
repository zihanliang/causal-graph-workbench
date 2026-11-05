"""Generate reference results for the engine's sensitivity analysis.

Every expected value comes from the published reference implementation of the method, with no code shared
with the TypeScript engine:

- AIPW: DoubleML, given the same outcome and propensity predictions, so any difference is in the bound.
  One value is deliberately not taken from it as reported: see `interval_value` below.
- Linear regression and linear probability models: the R package sensemakr.
- E-values: the R package EValue.

The output is checked in, so `npm test` needs none of this. To refresh it:

    pip install -r tools/verification/requirements.txt doubleml
    Rscript -e 'install.packages(c("sensemakr", "EValue"))'
    python tools/verification/generate_sensitivity_golden.py
"""

from __future__ import annotations

import json
import subprocess
import tempfile
from pathlib import Path

import doubleml as dml
import numpy as np
import pandas as pd
import statsmodels.api as sm
from doubleml.utils import gain_statistics
from scipy import stats
from scipy.optimize import brentq
from sklearn.linear_model import LinearRegression, LogisticRegression

OUTPUT = Path(__file__).resolve().parents[2] / "apps/frontend/src/engine/__fixtures__/sensitivity.json"
SEED = 20261105
Z_95 = 1.959964
RARE_OUTCOME_PREVALENCE = 0.15


def design_matrix(frame: pd.DataFrame, covariates: list[str]) -> pd.DataFrame:
    design = pd.DataFrame({"const": np.ones(len(frame))}, index=frame.index)
    for column in covariates:
        if pd.api.types.is_numeric_dtype(frame[column]):
            design[column] = frame[column].astype(float)
        else:
            for level in sorted(frame[column].astype(str).unique())[1:]:
                design[f"{column}={level}"] = (frame[column].astype(str) == level).astype(float)
    return design


# ---------------------------------------------------------------------------
# AIPW: predictions from statsmodels, the bound from DoubleML.
# ---------------------------------------------------------------------------


def aipw_predictions(frame, treatment, outcome, covariates, estimand, binary_outcome):
    t = frame[treatment].astype(float).to_numpy()
    y = frame[outcome].astype(float).to_numpy()
    design = design_matrix(frame, covariates)
    fitted = sm.Logit(t, design).fit(disp=0).predict(design).to_numpy()
    scores = np.clip(fitted, 0.0, 0.99) if estimand == "att" else np.clip(fitted, 0.01, 0.99)

    def arm(value):
        rows = t == value
        model = sm.Logit if binary_outcome else sm.OLS
        fit = model(y[rows], design[rows]).fit(disp=0) if binary_outcome else model(y[rows], design[rows]).fit()
        return fit.predict(design).to_numpy()

    return {"ml_g0": arm(0), "ml_g1": arm(1), "ml_m": scores}


def doubleml_fit(frame, treatment, outcome, covariates, estimand, binary_outcome):
    predictions = aipw_predictions(frame, treatment, outcome, covariates, estimand, binary_outcome)
    # DoubleML insists on at least one covariate column, but with external predictions it never fits on them.
    data_frame = frame[[treatment, outcome]].astype(float).copy()
    data_frame["__placeholder"] = np.arange(len(frame), dtype=float)
    data = dml.DoubleMLData(data_frame, y_col=outcome, d_cols=treatment, x_cols=["__placeholder"])
    model = dml.DoubleMLIRM(
        data,
        ml_g=LinearRegression(),
        ml_m=LogisticRegression(),
        n_folds=2,
        n_rep=1,
        score="ATTE" if estimand == "att" else "ATE",
        normalize_ipw=False,
        ps_processor_config=dml.utils.PSProcessorConfig(clipping_threshold=1e-12),
    )
    model.fit(external_predictions={treatment: {name: values.reshape(-1, 1) for name, values in predictions.items()}})
    return model


def interval_value(model, predictions, frame, treatment, outcome, estimand) -> tuple[float, float]:
    """
    The share at which the 95% interval reaches zero, and the bootstrap's check of its standard error.

    DoubleML 0.11.4 reports this with `psi_lower = scaled_psi - strength * psi_max_bias`, but its
    `scaled_psi` is psi / mean(psi_deriv), which for AIPW has the opposite sign to the estimate's influence
    function. That is the variance of theta + strength * S, not theta - strength * S. This function first
    reproduces its reported number with that sign, to show this is the only difference, then uses the sign
    a bootstrap of theta - strength * S supports.
    """
    elements = model.framework.sensitivity_elements
    scale = float(np.squeeze(elements["max_bias"]))
    psi_scale = np.squeeze(elements["psi_max_bias"])
    psi_as_reported = np.squeeze(model.framework.scaled_psi)
    theta = float(np.squeeze(model.coef))
    count = len(psi_scale)
    direction = 1.0 if theta >= 0 else -1.0

    def solve(lower_end) -> float:
        if lower_end(0.0) <= 0:
            return 0.0
        return brentq(lower_end, 0.0, 0.9999) if lower_end(0.9999) < 0 else 0.9999

    def as_reported(share):
        strength = share / np.sqrt(1 - share)
        # The upper bound for a negative estimate adds the two terms, as DoubleML does.
        psi = psi_as_reported - direction * strength * psi_scale
        return direction * theta - strength * scale - Z_95 * np.sqrt(np.mean(psi**2) / count)

    reported = float(np.squeeze(model.sensitivity_params["rva"]))
    assert abs(solve(as_reported) - reported) < 1e-3, f"could not reproduce DoubleML's rva: {solve(as_reported)} vs {reported}"

    influence = -psi_as_reported

    def corrected(share):
        strength = share / np.sqrt(1 - share)
        psi = direction * influence - strength * psi_scale
        return direction * theta - strength * scale - Z_95 * np.std(psi, ddof=1) / np.sqrt(count)

    t = frame[treatment].astype(float).to_numpy()
    y = frame[outcome].astype(float).to_numpy()
    mu1, mu0, e = predictions["ml_g1"], predictions["ml_g0"], predictions["ml_m"]

    def statistic(rows, strength):
        tt, yy, m1, m0, ee = t[rows], y[rows], mu1[rows], mu0[rows], e[rows]
        if estimand == "att":
            share = tt.mean()
            estimate = ((tt * (yy - m0) - (1 - tt) * ee / (1 - ee) * (yy - m0)) / share).mean()
            gain = tt / (share * share * (1 - ee))
            weight = (tt - (1 - tt) * ee / (1 - ee)) / share
        else:
            estimate = (m1 - m0 + tt * (yy - m1) / ee - (1 - tt) * (yy - m0) / (1 - ee)).mean()
            gain = 1 / ee + 1 / (1 - ee)
            weight = tt / ee - (1 - tt) / (1 - ee)
        sigma2 = ((yy - tt * m1 - (1 - tt) * m0) ** 2).mean()
        nu2 = (2 * gain - weight * weight).mean()
        return direction * estimate - strength * np.sqrt(sigma2 * nu2)

    # The bootstrap holds the fitted models fixed, as the formula does.
    check_share = 0.3
    check_strength = check_share / np.sqrt(1 - check_share)
    rng = np.random.default_rng(SEED)
    draws = [statistic(rng.integers(0, count, count), check_strength) for _ in range(2000)]
    bootstrap_sd = float(np.std(draws, ddof=1))
    formula_sd = float(np.std(direction * influence - check_strength * psi_scale, ddof=1) / np.sqrt(count))
    as_reported_sd = float(np.std(direction * psi_as_reported * direction - direction * check_strength * psi_scale, ddof=1) / np.sqrt(count))
    assert abs(formula_sd / bootstrap_sd - 1) < 0.1, f"formula SD {formula_sd} vs bootstrap {bootstrap_sd}"
    print(f"    SD at share 0.3: bootstrap {bootstrap_sd:.4f}, corrected sign {formula_sd:.4f}, as reported {as_reported_sd:.4f}")
    return solve(corrected), reported


def aipw_case(name, frame, *, treatment, outcome, covariates, estimand):
    binary_outcome = set(frame[outcome].unique()) <= {0, 1}
    model = doubleml_fit(frame, treatment, outcome, covariates, estimand, binary_outcome)
    # Level 0.975 is one-sided in DoubleML, so this is the two-sided 95% interval the app reports.
    model.sensitivity_analysis(cf_y=0.03, cf_d=0.03, rho=1.0, level=0.975, null_hypothesis=0.0)
    params = model.sensitivity_params
    sigma2 = float(np.squeeze(model.sensitivity_elements["sigma2"]))
    nu2 = float(np.squeeze(model.sensitivity_elements["nu2"]))
    predictions = aipw_predictions(frame, treatment, outcome, covariates, estimand, binary_outcome)
    value_for_interval, reported_value = interval_value(model, predictions, frame, treatment, outcome, estimand)

    benchmarks = {}
    for variable in covariates:
        short = doubleml_fit(frame, treatment, outcome, [c for c in covariates if c != variable], estimand, binary_outcome)
        gains = gain_statistics(dml_long=model, dml_short=short)
        benchmarks[variable] = {"treatmentShare": float(np.squeeze(gains["cf_d"])), "outcomeShare": float(np.squeeze(gains["cf_y"]))}

    return {
        "name": name,
        "kind": "aipw",
        "csv": frame.to_csv(index=False),
        "treatment": treatment,
        "outcome": outcome,
        "covariates": covariates,
        "estimand": estimand,
        "expected": {
            "estimate": float(np.squeeze(model.coef)),
            "sigma2": sigma2,
            "nu2": nu2,
            "value": float(np.squeeze(params["rv"])),
            "valueForInterval": value_for_interval,
            "doubleMLValueForInterval": reported_value,
            "benchmarks": benchmarks,
        },
    }


# ---------------------------------------------------------------------------
# R: sensemakr and EValue, called once per case.
# ---------------------------------------------------------------------------


def r_number(value) -> str:
    return repr(float(value))


def run_r(program: str) -> dict[str, float]:
    completed = subprocess.run(["Rscript", "--vanilla", "-e", program], capture_output=True, text=True, timeout=300)
    if completed.returncode != 0:
        raise RuntimeError(completed.stderr)
    values = {}
    for line in completed.stdout.splitlines():
        if line.startswith("@@"):
            key, value = line[2:].split("=", 1)
            values[key] = float(value)
    return values


LIB = 'for (lib in strsplit(Sys.getenv("R_LIBS_USER"), ":")[[1]]) .libPaths(c(lib, .libPaths()));'


def r_evalue(call: str) -> dict[str, float]:
    """evalues.* returns a two-row table. The interval's E-value sits under whichever limit is nearer the null."""
    program = f"""{LIB}
suppressMessages(library(EValue))
result <- suppressMessages(suppressWarnings({call}))
cat(sprintf("@@riskRatio=%.15g\\n", result[1, "point"]))
cat(sprintf("@@riskRatioLow=%.15g\\n", result[1, "lower"]))
cat(sprintf("@@riskRatioHigh=%.15g\\n", result[1, "upper"]))
cat(sprintf("@@point=%.15g\\n", result[2, "point"]))
interval <- result[2, c("lower", "upper")]
cat(sprintf("@@interval=%.15g\\n", interval[!is.na(interval)][1]))
"""
    return run_r(program)


def sensemakr_values(path, outcome, treatment, covariates, frame) -> dict:
    terms = " + ".join([treatment, *covariates])
    benchmark_lines = []
    groups = []
    for index, variable in enumerate(covariates):
        if pd.api.types.is_numeric_dtype(frame[variable]):
            coefficients = [variable]
        else:
            levels = sorted(frame[variable].astype(str).unique())[1:]
            coefficients = [f"{variable}{level}" for level in levels]
        groups.append((index, variable))
        names = ", ".join(f'"{name}"' for name in coefficients)
        benchmark_lines.append(
            f"""bound <- ovb_bounds(fit, treatment = "{treatment}", benchmark_covariates = list(b{index} = c({names})), kd = 1, ky = 1, alpha = 0.05)
cat(sprintf("@@b{index}_treatment=%.15g\\n", bound$r2dz.x[1]))
cat(sprintf("@@b{index}_outcome=%.15g\\n", bound$r2yz.dx[1]))
cat(sprintf("@@b{index}_adjusted=%.15g\\n", bound$adjusted_estimate[1]))
"""
        )
    program = f"""{LIB}
suppressMessages(library(sensemakr))
df <- read.csv("{path}")
fit <- lm({outcome} ~ {terms}, data = df)
est <- coef(fit)[["{treatment}"]]
se <- summary(fit)$coefficients["{treatment}", "Std. Error"]
cat(sprintf("@@estimate=%.15g\\n", est))
cat(sprintf("@@se=%.15g\\n", se))
cat(sprintf("@@dof=%.15g\\n", fit$df.residual))
cat(sprintf("@@value=%.15g\\n", robustness_value(fit, covariates = "{treatment}", q = 1, alpha = 1)))
cat(sprintf("@@valueForInterval=%.15g\\n", robustness_value(fit, covariates = "{treatment}", q = 1, alpha = 0.05)))
{"".join(benchmark_lines)}
"""
    raw = run_r(program)
    benchmarks = {}
    for index, variable in groups:
        benchmarks[variable] = {
            "treatmentShare": raw[f"b{index}_treatment"],
            "outcomeShare": raw[f"b{index}_outcome"],
            "adjustedEstimate": raw[f"b{index}_adjusted"],
        }
    return {
        "estimate": raw["estimate"],
        "standardError": raw["se"],
        "dof": raw["dof"],
        "value": raw["value"],
        "valueForInterval": raw["valueForInterval"],
        "benchmarks": benchmarks,
    }


def linear_case(name, frame, *, treatment, outcome, covariates, workdir: Path):
    path = workdir / f"{abs(hash(name))}.csv"
    frame.to_csv(path, index=False)
    binary_outcome = set(frame[outcome].unique()) <= {0, 1}
    expected = sensemakr_values(path, outcome, treatment, covariates, frame)

    design = design_matrix(frame, covariates)
    design.insert(1, treatment, frame[treatment].astype(float))
    y = frame[outcome].astype(float)
    sd_treatment = float(frame[treatment].astype(float).std(ddof=1))
    if binary_outcome:
        fit = sm.Logit(y, design).fit(disp=0, cov_type="HC1")
        low = float(fit.params[treatment] - Z_95 * fit.bse[treatment]) * sd_treatment
        high = float(fit.params[treatment] + Z_95 * fit.bse[treatment]) * sd_treatment
        point = float(fit.params[treatment]) * sd_treatment
        rare = "TRUE" if float(y.mean()) < RARE_OUTCOME_PREVALENCE else "FALSE"
        evalue = r_evalue(f"evalues.OR(est = {r_number(np.exp(point))}, lo = {r_number(np.exp(low))}, hi = {r_number(np.exp(high))}, rare = {rare})")
        evalue["rare"] = rare == "TRUE"
    else:
        fit = sm.OLS(y, design).fit(cov_type="HC1")
        evalue = r_evalue(
            f"evalues.OLS(est = {r_number(fit.params[treatment])}, se = {r_number(fit.bse[treatment])}, "
            f"sd = {r_number(y.std(ddof=1))}, delta = {r_number(sd_treatment)})"
        )
    expected["evalue"] = evalue
    return {
        "name": name,
        "kind": "linear",
        "csv": frame.to_csv(index=False),
        "treatment": treatment,
        "outcome": outcome,
        "covariates": covariates,
        "estimand": "ate",
        "expected": expected,
    }


def aipw_evalue(frame, treatment, outcome, covariates, estimand) -> dict[str, float]:
    """The E-value of an AIPW estimate, through EValue's own conversions."""
    predictions = aipw_predictions(frame, treatment, outcome, covariates, estimand, set(frame[outcome].unique()) <= {0, 1})
    t = frame[treatment].astype(float).to_numpy()
    y = frame[outcome].astype(float).to_numpy()
    mu1, mu0, e = predictions["ml_g1"], predictions["ml_g0"], predictions["ml_m"]
    n = len(y)
    if estimand == "att":
        share = t.mean()
        score = (t * (y - mu0) - (1 - t) * e / (1 - e) * (y - mu0)) / share
        estimate = score.mean()
        influence = score - t / share * estimate
        p1 = y[t == 1].mean()
        p0 = p1 - estimate
        psi1 = t / share * (y - p1)
        psi0 = psi1 - influence
    else:
        a1 = mu1 + t * (y - mu1) / e
        a0 = mu0 + (1 - t) * (y - mu0) / (1 - e)
        estimate = float((a1 - a0).mean())
        influence = (a1 - a0) - estimate
        p1, p0 = a1.mean(), a0.mean()
        psi1, psi0 = a1 - p1, a0 - p0
    standard_error = float(np.std(influence, ddof=1) / np.sqrt(n))
    if set(np.unique(y)) <= {0.0, 1.0}:
        log_rr = float(np.log(p1 / p0))
        log_se = float(np.std(psi1 / p1 - psi0 / p0, ddof=1) / np.sqrt(n))
        return r_evalue(
            f"evalues.RR(est = {r_number(np.exp(log_rr))}, lo = {r_number(np.exp(log_rr - Z_95 * log_se))}, hi = {r_number(np.exp(log_rr + Z_95 * log_se))})"
        )
    return r_evalue(f"evalues.OLS(est = {r_number(estimate)}, se = {r_number(standard_error)}, sd = {r_number(np.std(y, ddof=1))}, delta = 1)")


# ---------------------------------------------------------------------------
# The cases.
# ---------------------------------------------------------------------------


def main() -> None:
    rng = np.random.default_rng(SEED)
    n = 400
    z = np.round(rng.normal(size=n), 5)
    w = np.round(rng.normal(size=n), 5)
    site = rng.choice(["east", "north", "west"], size=n, p=[0.5, 0.3, 0.2])
    site_effect = np.select([site == "north", site == "west"], [0.7, -0.6], default=0.0)
    t = rng.binomial(1, 1 / (1 + np.exp(-(0.2 + 0.9 * z - 0.4 * w + site_effect))))

    continuous = pd.DataFrame(
        {"t": t, "y": np.round(0.5 * z + 0.3 * w + site_effect + (1 + (z > 0)) * t + rng.normal(size=n), 5), "z": z, "w": w, "site": site}
    )
    binary = pd.DataFrame(
        {"t": t, "y": rng.binomial(1, 1 / (1 + np.exp(-(-0.4 + 1.0 * t + 0.8 * z + site_effect)))), "z": z, "w": w, "site": site}
    )
    negative = continuous.assign(y=np.round(0.5 * z - 1.5 * t + rng.normal(size=n), 5))
    weak = continuous.assign(y=np.round(0.8 * z + 0.05 * t + rng.normal(size=n), 5))

    dose = np.round(0.7 * z + rng.normal(size=n), 5)
    linear_dose = pd.DataFrame({"dose": dose, "y": np.round(0.5 * dose + z + site_effect + rng.normal(size=n), 5), "z": z, "site": site})
    weak_dose = linear_dose.assign(y=np.round(0.02 * dose + z + rng.normal(size=n), 5))
    negative_dose = linear_dose.assign(y=np.round(-0.6 * dose + z + rng.normal(size=n), 5))
    common_dose = pd.DataFrame({"dose": dose, "y": rng.binomial(1, 1 / (1 + np.exp(-(0.6 * dose + 0.8 * z)))), "z": z, "site": site})
    rare_dose = pd.DataFrame({"dose": dose, "y": rng.binomial(1, 1 / (1 + np.exp(-(-3.2 + 0.7 * dose + 0.5 * z)))), "z": z, "site": site})

    # A strong effect with few rows reaches sensemakr's "extreme" robustness value.
    few = 14
    small_z = np.round(rng.normal(size=few), 5)
    small_dose = np.round(rng.normal(size=few), 5)
    small = pd.DataFrame({"dose": small_dose, "y": np.round(3 * small_dose + 0.2 * small_z + 0.2 * rng.normal(size=few), 5), "z": small_z})

    covariates = ["z", "w", "site"]
    aipw = [
        ("ATE, continuous outcome", continuous, covariates, "ate"),
        ("ATT, continuous outcome", continuous, covariates, "att"),
        ("ATE, binary outcome", binary, covariates, "ate"),
        ("ATT, binary outcome", binary, covariates, "att"),
        ("ATE, negative effect", negative, covariates, "ate"),
        ("ATE, interval includes zero", weak, covariates, "ate"),
        ("ATE, no covariates", continuous, [], "ate"),
    ]
    with tempfile.TemporaryDirectory() as temp:
        workdir = Path(temp)
        cases = []
        for name, frame, covars, estimand in aipw:
            case = aipw_case(name, frame, treatment="t", outcome="y", covariates=covars, estimand=estimand)
            case["expected"]["evalue"] = aipw_evalue(frame, "t", "y", covars, estimand)
            cases.append(case)
            print(f"  {name}: RV {case['expected']['value']:.4f}, interval {case['expected']['valueForInterval']:.4f}")
        linear = [
            ("linear, numeric treatment", linear_dose, ["z", "site"]),
            ("linear, interval includes zero", weak_dose, ["z"]),
            ("linear, negative effect", negative_dose, ["z", "site"]),
            ("linear, no covariates", linear_dose, []),
            ("linear, few rows and a strong effect", small, ["z"]),
            ("linear probability, common outcome", common_dose, ["z", "site"]),
            ("linear probability, rare outcome", rare_dose, ["z"]),
        ]
        for name, frame, covars in linear:
            case = linear_case(name, frame, treatment="dose", outcome="y", covariates=covars, workdir=workdir)
            cases.append(case)
            print(f"  {name}: RV {case['expected']['value']:.4f}, interval {case['expected']['valueForInterval']:.4f}")

    quantiles = [
        {"p": p, "df": df, "value": float(stats.t.ppf(p, df))}
        for p in (0.6, 0.975, 0.995, 0.025)
        for df in (1, 2, 5, 12, 30, 399, 100000)
    ]
    OUTPUT.write_text(json.dumps({"cases": cases, "tQuantiles": quantiles}, indent=1) + "\n", encoding="utf-8")
    print(f"wrote {OUTPUT}")


if __name__ == "__main__":
    main()
