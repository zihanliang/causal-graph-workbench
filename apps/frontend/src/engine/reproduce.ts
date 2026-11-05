import type { AnalysisResult, GraphSpec } from "@causal-graph-workbench/shared";

import { CI_MULTIPLIER, PROPENSITY_CEILING, PROPENSITY_FLOOR } from "./effect";
import { sortedSet } from "./graph";

/**
 * One script that recomputes every number in a finished analysis from the data file, and checks them against
 * the numbers the app showed. tools/verification/verify_generated_code.py runs it, so change it with that script.
 */

/** A Python literal. JSON strings are valid Python strings, so only the other constants need translating. */
function python(value: unknown): string {
  if (value === null || value === undefined) {
    return "None";
  }
  if (value === true) {
    return "True";
  }
  if (value === false) {
    return "False";
  }
  if (Array.isArray(value)) {
    return `[${value.map(python).join(", ")}]`;
  }
  if (typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .map(([key, item]) => `${JSON.stringify(key)}: ${python(item)}`)
      .join(", ")}}`;
  }
  return JSON.stringify(value);
}

function rows(items: unknown[][]): string {
  return items.length ? `[\n${items.map((item) => `    (${item.map(python).join(", ")}),`).join("\n")}\n]` : "[]";
}

/** Null until the analysis has finished, because a script from a partial result could not check itself. */
export function buildReproducibleScript(graph: GraphSpec, analysis: AnalysisResult): string | null {
  const { reproduction, effect, audit, sensitivity, baselineSet } = analysis;
  const estimate = effect?.estimate;
  if (!reproduction || !estimate || !audit || !sensitivity || baselineSet === null) {
    return null;
  }
  if (effect.status !== "complete" || audit.status !== "complete" || sensitivity.status !== "complete") {
    return null;
  }

  const notMeasured = graph.nodes.filter((node) => node.observed === false || !(node.id in reproduction.columnOf)).map((node) => node.id);
  const otherSets = effect.comparisons
    .filter((row) => row.kind !== "baseline" && row.estimate)
    .map((row) => [row.label, row.variables, row.isValid, row.estimate!.estimate]);
  const arrowErrors = audit.assumptions
    .filter((item) => item.alternativeEstimate && item.repair && item.baselineOnSameRows !== null)
    .map((item) => [
      item.edit === "add" ? `${item.source} -> ${item.target}` : item.edit === "reverse" ? `${item.target} -> ${item.source}` : `no ${item.source} -> ${item.target}`,
      item.repair,
      sortedSet([...baselineSet, ...item.repair!]),
      item.baselineOnSameRows,
      item.alternativeEstimate!.estimate,
      item.alternativeEstimate!.ciLow,
      item.alternativeEstimate!.ciHigh,
    ]);
  const tests = audit.tests.map((test) => [test.left, test.right, test.given, test.pValue, test.adjustedPValue]);
  const { robustness, evalue } = sensitivity;

  const settings = [
    `DATA_FILE = ${python(reproduction.filename)}`,
    `DELIMITER = ${python(reproduction.delimiter)}`,
    `ARROWS = ${python(graph.edges.map((edge) => [edge.source, edge.target]))}`,
    `NOT_MEASURED = ${python(notMeasured)}`,
    `TREATMENT = ${python(graph.treatmentId)}`,
    `OUTCOME = ${python(graph.outcomeId)}`,
    `COLUMNS = ${python(reproduction.columnOf)}`,
    `TYPES = ${python(reproduction.typeOf)}`,
    `ESTIMAND = ${python(reproduction.estimand)}`,
    `ADJUST_FOR = ${python(baselineSet)}`,
    "",
    "# Other choices of adjustment set: label, variables, valid under the graph, estimate the app showed.",
    `OTHER_SETS = ${rows(otherSets)}`,
    "",
    "# Single-arrow errors that would invalidate the set: the error, a set valid under it, the rows to use,",
    "# then what the app showed for the current set on those rows and for the new set with its interval.",
    `ARROW_ERRORS = ${rows(arrowErrors)}`,
    "",
    "# Independences the graph implies: two variables, given these, then the p-value and its Holm-adjusted value.",
    `INDEPENDENCES = ${rows(tests)}`,
    "",
    "# What the app showed for the estimate, and for how strong something unmeasured would have to be.",
    `EXPECTED = ${python({
      estimate: estimate.estimate,
      ci_low: estimate.ciLow,
      ci_high: estimate.ciHigh,
      rows: estimate.rowsUsed,
      robustness: robustness
        ? {
            value: robustness.value,
            value_for_interval: robustness.valueForInterval,
            benchmarks: Object.fromEntries(robustness.benchmarks.map((item) => [item.variable, [item.treatmentShare, item.outcomeShare, item.shareOfEstimate]])),
          }
        : null,
      evalue: evalue ? { point: evalue.point, interval: evalue.interval } : null,
    })}`,
  ].join("\n");

  return `${HEADER(reproduction.filename.replace(/["\\\n]/g, ""))}\n${settings}\n${BODY}`;
}

const HEADER = (filename: string) =>
  String.raw`#!/usr/bin/env python3
"""
Recomputes every number in this analysis from ${filename}, and checks them against what the app showed.

Put this next to the data file and run:  python reproduce_analysis.py
It needs numpy, scipy and statsmodels. With networkx it also checks the adjustment set against the graph.

Everything specific to this analysis is in the settings below. The rest is the method, written out in full so
it can be read and changed. The graph is an assumption: this script reproduces what follows from it, and cannot
show that it is true.
"""

import csv
import re
import sys
from functools import lru_cache

import numpy as np
import statsmodels.api as sm
from scipy import stats

# ---------------------------------------------------------------------------
# This analysis
# ---------------------------------------------------------------------------
`;

const BODY = String.raw`
# Numbers within this of what the app showed count as the same.
TOLERANCE = 1e-4
Z_95 = ${CI_MULTIPLIER}
PROPENSITY_FLOOR = ${PROPENSITY_FLOOR}
PROPENSITY_CEILING = ${PROPENSITY_CEILING}

# ---------------------------------------------------------------------------
# Reading the file the way the app does
# ---------------------------------------------------------------------------

MISSING = {"", "na", "n/a", "#n/a", "#n/a n/a", "#na", "<na>", "nan", "-nan", "-1.#ind", "-1.#qnan", "1.#ind", "1.#qnan", "null", "none", "missing", "."}
TRUE_WORDS = {"1", "true", "yes", "y", "treated"}
FALSE_WORDS = {"0", "false", "no", "n", "control"}
NUMBER = re.compile(r"^[+-]?(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?$")



def read_table():
    """Blank lines are skipped. A short row is padded, a long one cut, and a repeated header numbered, as in the app."""
    with open(DATA_FILE, encoding="utf-8-sig", newline="") as file:
        rows = [row for row in csv.reader(file, delimiter=DELIMITER) if any(cell.strip() for cell in row)]
    headers, seen = [], set()
    for index, raw in enumerate(rows[0]):
        base = raw.strip() or f"column_{index + 1}"
        name, suffix = base, 2
        while name in seen:
            name, suffix = f"{base}_{suffix}", suffix + 1
        seen.add(name)
        headers.append(name)
    return {header: [(row[i].strip() if i < len(row) else "") for row in rows[1:]] for i, header in enumerate(headers)}


table = read_table()


def is_missing(value):
    return value.strip().lower() in MISSING


@lru_cache(maxsize=None)
def read_number(column):
    return np.array([float(v) if not is_missing(v) and NUMBER.match(v) else np.nan for v in table[column]])


@lru_cache(maxsize=None)
def read_two_values(column):
    values = sorted({v.lower() for v in table[column] if not is_missing(v)})
    if set(values) == {"0", "1"}:
        high, low = "1", "0"
    else:
        high = next((v for v in values if v in TRUE_WORDS), None)
        low = next((v for v in values if v in FALSE_WORDS), None)
        if high is None or low is None:
            high, low = values[1], values[0]
    return np.array([np.nan if is_missing(v) else 1.0 if v.lower() == high else 0.0 if v.lower() == low else np.nan for v in table[column]])


def read_endpoint(variable):
    return read_two_values(COLUMNS[variable]) if TYPES[variable] == "binary" else read_number(COLUMNS[variable])


@lru_cache(maxsize=None)
def terms_of(variable):
    """A variable as numeric columns: itself, a 0/1 flag, or one flag per category except the first."""
    column = COLUMNS[variable]
    kind = TYPES[variable]
    if kind == "binary":
        return [read_two_values(column)]
    if kind == "categorical":
        values = table[column]
        levels = sorted({v for v in values if not is_missing(v)})
        return [np.array([np.nan if is_missing(v) else float(v == level) for v in values]) for level in levels[1:]]
    return [read_number(column)]


def orthonormal(columns):
    """Gram-Schmidt. A column the earlier ones can already express is dropped. Returns the vectors and what was kept."""
    vectors, kept = [], []
    for index, column in enumerate(columns):
        size = np.sqrt(column @ column)
        residual = column.astype(float).copy()
        for _ in range(2):
            for vector in vectors:
                residual -= (residual @ vector) * vector
        remaining = np.sqrt(residual @ residual)
        if size > 0 and remaining > 1e-9 * size:
            vectors.append(residual / remaining)
            kept.append(index)
    return vectors, kept


def full_rank(columns):
    return [columns[i] for i in orthonormal(columns)[1]]


# ---------------------------------------------------------------------------
# The estimate
# ---------------------------------------------------------------------------


def logistic_predictions(y, columns, every_row):
    design = np.column_stack(columns)
    fit = sm.Logit(y, design).fit(disp=0, method="newton", maxiter=200)
    return fit.predict(every_row)


def predict_in_arm(y, columns, in_arm, binary):
    """An outcome model fitted only on one treatment group, then predicted for everyone."""
    arm_columns = [column[in_arm] for column in columns]
    kept = orthonormal(arm_columns)[1]
    arm_design = np.column_stack([arm_columns[i] for i in kept])
    every_row = np.column_stack([columns[i] for i in kept])
    if binary:
        return sm.Logit(y[in_arm], arm_design).fit(disp=0, method="newton", maxiter=200).predict(every_row)
    return every_row @ np.linalg.lstsq(arm_design, y[in_arm], rcond=None)[0]


def aipw(t, y, columns):
    """Doubly robust. Also returns what the omitted-variable bound and a risk ratio need."""
    n = len(t)
    outcome_binary = TYPES[OUTCOME] == "binary"
    kept = full_rank(columns)
    fitted = logistic_predictions(t, kept, np.column_stack(kept))
    if ESTIMAND == "att":
        # The ATT weights controls by e / (1 - e), which is harmless near 0, so only the ceiling applies.
        e = np.minimum(PROPENSITY_CEILING, fitted)
    else:
        e = np.clip(fitted, PROPENSITY_FLOOR, PROPENSITY_CEILING)
    mu1 = predict_in_arm(y, columns, t == 1, outcome_binary)
    mu0 = predict_in_arm(y, columns, t == 0, outcome_binary)

    if ESTIMAND == "att":
        share = t.mean()
        score = (t * (y - mu0) - (1 - t) * e * (y - mu0) / (1 - e)) / share
        estimate = score.mean()
        influence = score - t / share * estimate
        treated_mean = (t * y / share).mean()
        control_mean = treated_mean - estimate
        treated_influence = t / share * (y - treated_mean)
        control_influence = treated_influence - influence
        weight_gain = t / (share * share * (1 - e))
        weight = (t - (1 - t) * e / (1 - e)) / share
    else:
        treated_score = mu1 + t * (y - mu1) / e
        control_score = mu0 + (1 - t) * (y - mu0) / (1 - e)
        estimate = (treated_score - control_score).mean()
        influence = treated_score - control_score - estimate
        treated_mean, control_mean = treated_score.mean(), control_score.mean()
        treated_influence, control_influence = treated_score - treated_mean, control_score - control_mean
        weight_gain = 1 / e + 1 / (1 - e)
        weight = t / e - (1 - t) / (1 - e)

    standard_error = influence.std(ddof=1) / np.sqrt(n)
    sigma_elements = (y - t * mu1 - (1 - t) * mu0) ** 2
    nu_elements = 2 * weight_gain - weight * weight
    return {
        "method": "aipw", "estimate": estimate, "se": standard_error, "rows": n, "influence": influence,
        "sigma2": sigma_elements.mean(), "nu2": nu_elements.mean(), "sigma_elements": sigma_elements, "nu_elements": nu_elements,
        "treated_mean": treated_mean, "control_mean": control_mean,
        "treated_influence": treated_influence, "control_influence": control_influence,
    }


def regression(t, y, columns):
    """Linear or logistic, with HC1 robust standard errors."""
    all_columns = [columns[0], t, *columns[1:]]
    kept = orthonormal(all_columns)[1]
    design = np.column_stack([all_columns[i] for i in kept])
    position = kept.index(1)
    if TYPES[OUTCOME] == "binary":
        fit = sm.Logit(y, design).fit(disp=0, cov_type="HC1", method="newton", maxiter=200)
        method = "logistic"
    else:
        fit = sm.OLS(y, design).fit(cov_type="HC1")
        method = "ols"
    return {"method": method, "estimate": fit.params[position], "se": fit.bse[position], "rows": len(t)}


def fit_effect(adjust, also_complete=()):
    """The effect, adjusting for these variables, on rows where they and also_complete are all present."""
    t, y = read_endpoint(TREATMENT), read_endpoint(OUTCOME)
    covariates = [term for variable in adjust for term in terms_of(variable)]
    extra = [term for variable in also_complete for term in terms_of(variable)]
    keep = ~np.isnan(np.column_stack([t, y, *covariates, *extra])).any(axis=1)
    t, y = t[keep], y[keep]
    columns = [np.ones(len(t)), *[term[keep] for term in covariates]]
    fit = aipw(t, y, columns) if TYPES[TREATMENT] == "binary" else regression(t, y, columns)
    fit.update(t=t, y=y, keep=keep, low=fit["estimate"] - Z_95 * fit["se"], high=fit["estimate"] + Z_95 * fit["se"])
    return fit


# ---------------------------------------------------------------------------
# How strong would something unmeasured have to be?
# ---------------------------------------------------------------------------


def robustness_value(f):
    return 2 / (1 + np.sqrt(1 + 4 / (f * f))) if f > 0 else 0.0


def bound_strength(treatment_share, outcome_share):
    treatment_share = min(treatment_share, 0.999)
    return np.sqrt(outcome_share * treatment_share / (1 - treatment_share))


def robustness_aipw(fit, adjust):
    """Chernozhukov, Cinelli, Newey, Sharma and Syrgkanis (2022)."""
    sigma2, nu2, theta = fit["sigma2"], fit["nu2"], fit["estimate"]
    scale = np.sqrt(sigma2 * nu2)
    n = fit["rows"]
    direction = 1.0 if theta >= 0 else -1.0
    scale_influence = (sigma2 * (fit["nu_elements"] - nu2) + nu2 * (fit["sigma_elements"] - sigma2)) / (2 * scale)

    def interval_end(share):
        strength = share / np.sqrt(1 - share)
        contribution = direction * fit["influence"] - strength * scale_influence
        return direction * theta - strength * scale - Z_95 * contribution.std(ddof=1) / np.sqrt(n)

    if interval_end(0.0) <= 0:
        value_for_interval = 0.0
    elif interval_end(0.9999) > 0:
        value_for_interval = 0.9999
    else:
        low, high = 0.0, 0.9999
        for _ in range(60):
            middle = (low + high) / 2
            low, high = (middle, high) if interval_end(middle) > 0 else (low, middle)
        value_for_interval = (low + high) / 2

    benchmarks = {}
    for variable in adjust:
        short = fit_effect([other for other in adjust if other != variable], also_complete=adjust)
        treatment_share = float(np.clip((nu2 - short["nu2"]) / short["nu2"], 0, 1))
        outcome_share = float(np.clip((short["sigma2"] - sigma2) / sigma2, 0, 1))
        benchmarks[variable] = (treatment_share, outcome_share, bound_strength(treatment_share, outcome_share) * scale / abs(theta))
    return {"value": robustness_value(abs(theta) / scale), "value_for_interval": value_for_interval, "benchmarks": benchmarks}


def residual_sum(columns, target):
    design = np.column_stack(full_rank(columns))
    residuals = target - design @ np.linalg.lstsq(design, target, rcond=None)[0]
    return residuals @ residuals


def robustness_linear(fit, adjust):
    """Cinelli and Hazlett (2020), on a linear regression, as in the R package sensemakr. A binary outcome gives a linear probability model."""
    keep, t, y = fit["keep"], fit["t"], fit["y"]
    intercept = np.ones(len(t))
    terms = {variable: [term[keep] for term in terms_of(variable)] for variable in adjust}
    every_term = [term for variable in adjust for term in terms[variable]]
    columns = full_rank([intercept, t, *every_term])
    design = np.column_stack(columns)
    coefficients = np.linalg.lstsq(design, y, rcond=None)[0]
    estimate = coefficients[1]
    dof = len(t) - len(columns)
    outcome_sum = residual_sum(columns, y)
    treatment_sum = residual_sum([intercept, *every_term], t)
    standard_error = np.sqrt(outcome_sum / dof / treatment_sum)
    f = abs(estimate / standard_error) / np.sqrt(dof)
    critical = stats.t.ppf(0.975, dof - 1) / np.sqrt(dof - 1)
    gap = f - critical
    if gap <= 0:
        value_for_interval = 0.0
    elif f > 1 / critical:
        value_for_interval = (f * f - critical * critical) / (1 + f * f)
    else:
        value_for_interval = robustness_value(gap)

    benchmarks = {}
    for variable in adjust:
        others = [term for other in adjust if other != variable for term in terms[other]]
        treatment_before = residual_sum([intercept, *others], t)
        outcome_before = residual_sum([intercept, t, *others], y)
        r2_treatment = float(np.clip((treatment_before - treatment_sum) / treatment_before, 0, 0.999999))
        r2_outcome = float(np.clip((outcome_before - outcome_sum) / outcome_before, 0, 0.999999))
        treatment_share = float(np.clip(r2_treatment / (1 - r2_treatment), 0, 1))
        gain = r2_treatment**2 / (1 - r2_treatment) ** 2
        outcome_share = 1.0 if gain >= 1 else float(np.clip((1 + np.sqrt(gain)) ** 2 / (1 - gain) * r2_outcome / (1 - r2_outcome), 0, 1))
        benchmarks[variable] = (treatment_share, outcome_share, bound_strength(treatment_share, outcome_share) * standard_error * np.sqrt(dof) / abs(estimate))
    return {"value": robustness_value(f), "value_for_interval": value_for_interval, "benchmarks": benchmarks}


def e_value_of(risk_ratio):
    away = 1 / risk_ratio if risk_ratio < 1 else risk_ratio
    return away + np.sqrt(away * (away - 1))


def e_values(risk_ratio, low, high):
    """VanderWeele and Ding (2017), as in the R package EValue."""
    nearer = low if risk_ratio >= 1 else high
    return {"point": e_value_of(risk_ratio), "interval": 1.0 if low <= 1 <= high else e_value_of(nearer)}


def evalue_for(fit):
    t, y, estimate, se = fit["t"], fit["y"], fit["estimate"], fit["se"]
    if fit["method"] == "aipw":
        if TYPES[OUTCOME] == "binary":
            log_ratio = np.log(fit["treated_mean"] / fit["control_mean"])
            influence = fit["treated_influence"] / fit["treated_mean"] - fit["control_influence"] / fit["control_mean"]
            half = Z_95 * influence.std(ddof=1) / np.sqrt(len(y))
            return e_values(np.exp(log_ratio), np.exp(log_ratio - half), np.exp(log_ratio + half))
        difference, difference_se = estimate / y.std(ddof=1), se / y.std(ddof=1)
    elif fit["method"] == "ols":
        # Per one SD of treatment, because a one-unit E-value would change with the units.
        scale = t.std(ddof=1) / y.std(ddof=1)
        difference, difference_se = estimate * scale, se * scale
    else:
        power = t.std(ddof=1) if y.mean() < 0.15 else t.std(ddof=1) / 2
        return e_values(np.exp(estimate * power), np.exp(fit["low"] * power), np.exp(fit["high"] * power))
    return e_values(np.exp(0.91 * difference), np.exp(0.91 * difference - 1.78 * difference_se), np.exp(0.91 * difference + 1.78 * difference_se))


# ---------------------------------------------------------------------------
# Do the data contradict what the graph implies?
# ---------------------------------------------------------------------------


def test_terms(variable):
    """Each as (values, is it numeric), so numeric ones can also be tested in nonlinear forms."""
    return [(term, TYPES[variable] not in ("binary", "categorical")) for term in terms_of(variable)]


def standardize(values):
    sd = values.std()
    return (values - values.mean()) / sd if sd > 0 else None


def conditioning_basis(condition, n):
    """Terms for the conditioning set, most important first, cut so a small file is not overfitted."""
    limit = max(2, n // 8)
    scaled = []
    main = [np.ones(n)]
    for values, is_numeric in condition:
        if not is_numeric:
            main.append(values)
        else:
            z = standardize(values)
            if z is not None:
                scaled.append(z)
                main.append(z)
    tiers = [
        main,
        [form for z in scaled for form in (z * z, z * z * z)],
        [form for z in scaled for form in (np.tanh(2 * z), (z > 0).astype(float))],
        [scaled[i] * scaled[j] for i in range(len(scaled)) for j in range(i + 1, len(scaled))],
    ]
    basis = []
    for tier in tiers:
        if len(basis) + len(tier) > limit and basis:
            break
        basis.extend(tier)
    return basis


def sample_rows(rows, size):
    """The app's repeatable shuffle, so a very large file tests the same rows."""
    shuffled = list(rows)
    state = 20261104
    for i in range(len(shuffled) - 1, 0, -1):
        state = (state * 1664525 + 1013904223) & 0xFFFFFFFF
        j = state % (i + 1)
        shuffled[i], shuffled[j] = shuffled[j], shuffled[i]
    return np.array(sorted(shuffled[:size]))


def independence_p(left, right, given):
    """The generalised covariance measure (Shah and Peters, 2020) on a flexible basis, Bonferroni across forms."""
    a, b = test_terms(left), test_terms(right)
    condition = [item for variable in given for item in test_terms(variable)]
    every = np.column_stack([item[0] for item in [*a, *b, *condition]])
    rows = np.flatnonzero(~np.isnan(every).any(axis=1))
    if len(rows) > 20000:
        rows = sample_rows(rows, 20000)
    n = len(rows)
    take = lambda items: [(values[rows], is_numeric) for values, is_numeric in items]
    a, b, condition = take(a), take(b), take(condition)
    vectors = orthonormal(conditioning_basis(condition, n))[0]

    def residual(values):
        remaining = values.copy()
        for vector in vectors:
            remaining -= (remaining @ vector) * vector
        return remaining

    forms = []
    for values, is_numeric in a:
        if not is_numeric:
            forms.append(values)
        else:
            z = standardize(values)
            if z is not None:
                forms.extend([z, z * z - 1, (z > 0).astype(float)])
    left_forms = [residual(form) for form in forms]
    right_forms = [residual(values) for values, _ in b]
    smallest, pairs = 1.0, 0
    for x in left_forms:
        for y in right_forms:
            product = x * y
            sd = product.std(ddof=1)
            p = 2 * stats.norm.sf(np.sqrt(n) * abs(product.mean()) / sd) if sd > 0 else 1.0
            smallest = min(smallest, p)
            pairs += 1
    return min(1.0, smallest * max(pairs, 1))


def holm(p_values):
    order = np.argsort(p_values, kind="stable")
    adjusted = [0.0] * len(p_values)
    running = 0.0
    for rank, index in enumerate(order):
        running = max(running, min(1.0, (len(p_values) - rank) * p_values[index]))
        adjusted[index] = running
    return adjusted


# ---------------------------------------------------------------------------
# Is the adjustment set valid under the graph?
# ---------------------------------------------------------------------------


def check_graph():
    try:
        import networkx as nx
    except ImportError:
        print("  Install networkx to also check the adjustment set against the graph.")
        return
    graph = nx.DiGraph()
    graph.add_nodes_from([TREATMENT, OUTCOME, *ADJUST_FOR])
    graph.add_edges_from(ARROWS)
    downstream = nx.descendants(graph, TREATMENT)
    backdoor = graph.copy()
    backdoor.remove_edges_from(list(graph.out_edges(TREATMENT)))
    separated = getattr(nx, "is_d_separator", None) or nx.d_separated
    valid = not (set(ADJUST_FOR) & downstream) and separated(backdoor, {TREATMENT}, {OUTCOME}, set(ADJUST_FOR))
    print(f"  {ADJUST_FOR or 'No variables'} {'meets' if valid else 'does NOT meet'} the backdoor criterion for {TREATMENT} -> {OUTCOME} under this graph.")
    if not valid:
        sys.exit("The adjustment set is not valid under this graph.")


# ---------------------------------------------------------------------------
# Run it, and compare with what the app showed
# ---------------------------------------------------------------------------

compared = []


def compare(label, value, expected):
    compared.append((label, float(value), float(expected)))


def main():
    is_odds_ratio = TYPES[TREATMENT] != "binary" and TYPES[OUTCOME] == "binary"
    def shown(value):
        value = np.exp(value) if is_odds_ratio else value
        return f"{value:.3f}" if value == 0 or 0.001 <= abs(value) < 1e7 else f"{value:.3g}"


    print("The graph")
    check_graph()
    if NOT_MEASURED:
        print(f"  Not measured: {', '.join(NOT_MEASURED)}")

    fit = fit_effect(ADJUST_FOR)
    print("\nThe estimate")
    print(f"  {shown(fit['estimate'])} (95% CI {shown(fit['low'])} to {shown(fit['high'])}), on {fit['rows']} rows")
    compare("estimate", fit["estimate"], EXPECTED["estimate"])
    compare("interval, low", fit["low"], EXPECTED["ci_low"])
    compare("interval, high", fit["high"], EXPECTED["ci_high"])
    compare("rows used", fit["rows"], EXPECTED["rows"])

    if OTHER_SETS:
        print("\nThe same data, adjusted differently")
        for label, variables, valid, expected in OTHER_SETS:
            other = fit_effect(variables)
            print(f"  {label} {variables}: {shown(other['estimate'])}{'' if valid else '  (not valid under the graph)'}")
            compare(f"{label} {variables}", other["estimate"], expected)

    if ARROW_ERRORS:
        print("\nIf one arrow were wrong")
        for label, valid_set, rows_from, expected_before, expected_after, expected_low, expected_high in ARROW_ERRORS:
            before = fit_effect(ADJUST_FOR, also_complete=rows_from)
            after = fit_effect(valid_set, also_complete=rows_from)
            print(f"  {label}: {shown(before['estimate'])} would become {shown(after['estimate'])} (95% CI {shown(after['low'])} to {shown(after['high'])}), adjusting for {valid_set}")
            compare(f"{label}, current set on the same rows", before["estimate"], expected_before)
            compare(f"{label}, estimate", after["estimate"], expected_after)
            compare(f"{label}, interval low", after["low"], expected_low)
            compare(f"{label}, interval high", after["high"], expected_high)

    if INDEPENDENCES:
        print("\nWhat the graph implies, tested against the data")
        raw = [independence_p(left, right, given) for left, right, given, _, _ in INDEPENDENCES]
        for (left, right, given, expected_p, expected_adjusted), p, adjusted in zip(INDEPENDENCES, raw, holm(raw)):
            given_text = f" given {', '.join(given)}" if given else ""
            print(f"  {left} and {right}{given_text}: adjusted p = {adjusted:.3f}{'  (the data disagrees)' if adjusted < 0.05 else ''}")
            compare(f"{left}, {right}: p", p, expected_p)
            compare(f"{left}, {right}: adjusted p", adjusted, expected_adjusted)

    print("\nHow strong would something unmeasured have to be?")
    if EXPECTED["robustness"]:
        robust = robustness_aipw(fit, ADJUST_FOR) if fit["method"] == "aipw" else robustness_linear(fit, ADJUST_FOR)
        print(f"  Robustness value: {robust['value']:.1%} to explain away the effect, {robust['value_for_interval']:.1%} for its interval to include no effect")
        compare("robustness value", robust["value"], EXPECTED["robustness"]["value"])
        compare("robustness value for the interval", robust["value_for_interval"], EXPECTED["robustness"]["value_for_interval"])
        for variable, (treatment_share, outcome_share, share) in robust["benchmarks"].items():
            print(f"  As strong as {variable}: about {share:.1%} of the estimate")
            expected = EXPECTED["robustness"]["benchmarks"][variable]
            compare(f"benchmark {variable}, treatment", treatment_share, expected[0])
            compare(f"benchmark {variable}, outcome", outcome_share, expected[1])
            compare(f"benchmark {variable}, share of estimate", share, expected[2])
    if EXPECTED["evalue"]:
        evalue = evalue_for(fit)
        print(f"  E-value: {evalue['point']:.2f} for the estimate, {evalue['interval']:.2f} for its interval")
        compare("E-value", evalue["point"], EXPECTED["evalue"]["point"])
        compare("E-value for the interval", evalue["interval"], EXPECTED["evalue"]["interval"])

    gaps = [abs(value - expected) for _, value, expected in compared]
    wrong = [item for item in compared if abs(item[1] - item[2]) > TOLERANCE]
    print("\nAgainst what the app showed")
    if wrong:
        for label, value, expected in wrong:
            print(f"  DIFFERENT  {label}: {value:.6g} here, {expected:.6g} in the app")
        sys.exit(f"{len(wrong)} of {len(compared)} numbers differ. Has the data file changed?")
    print(f"  All {len(compared)} numbers match (largest difference {max(gaps):.1e}).")


if __name__ == "__main__":
    main()
`;
