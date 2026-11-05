"""Generate reference results for the browser engine's tests.

Every expected value here comes from an implementation that shares no code with the
TypeScript engine: brute-force enumeration on top of networkx for graph logic, and
statsmodels / pandas for statistics. The output is checked in so `npm test` runs
without Python; rerun this script to refresh it against current library versions.

Usage: python tools/verification/generate_golden.py
"""

from __future__ import annotations

import io
import json
from itertools import chain, combinations
from pathlib import Path

import networkx as nx
import numpy as np
import pandas as pd
import statsmodels.api as sm
from scipy import stats

OUTPUT = Path(__file__).resolve().parents[2] / "apps/frontend/src/engine/__fixtures__/golden.json"

SEED = 20261104
EXTREME_LOW = 0.05
EXTREME_HIGH = 0.95


# ---------------------------------------------------------------------------
# Graph reference: brute force over every subset of the allowed variables.
# ---------------------------------------------------------------------------


def backdoor_graph(dag: nx.DiGraph, treatment: str) -> nx.DiGraph:
    graph = dag.copy()
    graph.remove_edges_from(list(dag.out_edges(treatment)))
    return graph


def all_subsets(items):
    items = sorted(items)
    return chain.from_iterable(combinations(items, size) for size in range(len(items) + 1))


def random_case(rng: np.random.Generator, node_count: int, edge_probability: float, unobserved_probability: float):
    names = [f"V{index}" for index in range(node_count)]
    order = rng.permutation(node_count)
    dag = nx.DiGraph()
    dag.add_nodes_from(names)
    for left in range(node_count):
        for right in range(left + 1, node_count):
            if rng.random() < edge_probability:
                dag.add_edge(names[order[left]], names[order[right]])
    treatment, outcome = rng.choice(names, size=2, replace=False).tolist()
    unobserved = sorted(
        name for name in names if name not in (treatment, outcome) and rng.random() < unobserved_probability
    )
    return dag, treatment, outcome, unobserved


def simple_paths(dag: nx.DiGraph, treatment: str, outcome: str):
    return list(nx.all_simple_paths(dag.to_undirected(), treatment, outcome))


def is_collider_on(dag, previous_node, node, next_node) -> bool:
    return dag.has_edge(previous_node, node) and dag.has_edge(next_node, node)


def path_category(dag, path) -> str:
    if all(dag.has_edge(a, b) for a, b in zip(path, path[1:])):
        return "directed_causal"
    if dag.has_edge(path[1], path[0]):
        return "backdoor"
    return "noncausal"


def expected_roles(dag: nx.DiGraph, treatment: str, outcome: str, paths) -> dict[str, list[str]]:
    without_treatment = dag.copy()
    without_treatment.remove_node(treatment)
    colliders = {
        node
        for path in paths
        for previous_node, node, next_node in zip(path, path[1:], path[2:])
        if is_collider_on(dag, previous_node, node, next_node)
    }
    descendants_t = nx.descendants(dag, treatment)
    ancestors_t = nx.ancestors(dag, treatment)
    ancestors_y = nx.ancestors(dag, outcome)
    ancestors_y_without_t = nx.ancestors(without_treatment, outcome) if outcome in without_treatment else set()

    roles: dict[str, list[str]] = {}
    for node in sorted(dag.nodes):
        if node in (treatment, outcome):
            continue
        tags = []
        if node in ancestors_t:
            tags.append("ancestor_of_treatment")
        if node in ancestors_y:
            tags.append("ancestor_of_outcome")
        if node in descendants_t:
            tags.append("descendant_of_treatment")
        if node in descendants_t and node in ancestors_y:
            tags.append("mediator")
        if node in colliders:
            tags.append("collider")
        if node in ancestors_t and node in ancestors_y_without_t:
            tags.append("confounder")
        if node in ancestors_t and nx.is_d_separator(without_treatment, {node}, {outcome}, set()):
            tags.append("instrument_like")
        roles[node] = sorted(tags)
    return roles


def graph_case(rng, node_count, edge_probability, unobserved_probability, *, include_all_valid: bool) -> dict:
    dag, treatment, outcome, unobserved = random_case(rng, node_count, edge_probability, unobserved_probability)
    backdoor = backdoor_graph(dag, treatment)
    allowed = sorted(set(dag.nodes) - nx.descendants(dag, treatment) - {treatment, outcome} - set(unobserved))

    valid = [
        subset
        for subset in all_subsets(allowed)
        if nx.is_d_separator(backdoor, {treatment}, {outcome}, set(subset))
    ]
    valid_sets = [set(subset) for subset in valid]
    minimal = [subset for subset in valid if not any(other < set(subset) for other in valid_sets)]

    # Whether each allowed variable can appear in, or is needed by, a valid set.
    containable = sorted(node for node in allowed if any(node in subset for subset in valid_sets))
    required = sorted(node for node in allowed if valid_sets and all(node in subset for subset in valid_sets))

    paths = simple_paths(dag, treatment, outcome)
    categories = [path_category(dag, path) for path in paths]
    open_backdoor = sum(
        1
        for path, category in zip(paths, categories)
        if category == "backdoor"
        and not any(is_collider_on(dag, a, b, c) for a, b, c in zip(path, path[1:], path[2:]))
    )

    case = {
        "nodes": sorted(dag.nodes),
        "edges": sorted([list(edge) for edge in dag.edges]),
        "treatment": treatment,
        "outcome": outcome,
        "unobserved": unobserved,
        "minimalSets": [list(subset) for subset in minimal],
        "containable": containable,
        "required": required,
        "hasValidSet": bool(valid),
        "pathCount": len(paths),
        "directedPathCount": categories.count("directed_causal"),
        "openBackdoorPathCount": open_backdoor,
        "roles": expected_roles(dag, treatment, outcome, paths),
    }
    if include_all_valid:
        case["validSets"] = [list(subset) for subset in valid]
    return case


def graph_cases(rng) -> list[dict]:
    cases = []
    for _ in range(160):
        cases.append(
            graph_case(
                rng,
                int(rng.integers(3, 9)),
                float(rng.uniform(0.15, 0.6)),
                float(rng.choice([0.0, 0.0, 0.2])),
                include_all_valid=True,
            )
        )
    for _ in range(30):
        cases.append(
            graph_case(
                rng,
                int(rng.integers(9, 12)),
                float(rng.uniform(0.15, 0.4)),
                float(rng.choice([0.0, 0.15])),
                include_all_valid=False,
            )
        )
    return cases


def dseparation_cases(rng) -> list[dict]:
    cases = []
    for _ in range(40):
        node_count = int(rng.integers(4, 10))
        dag, _, _, _ = random_case(rng, node_count, float(rng.uniform(0.15, 0.55)), 0.0)
        names = sorted(dag.nodes)
        queries = []
        for _ in range(25):
            left, right = rng.choice(names, size=2, replace=False).tolist()
            others = [name for name in names if name not in (left, right)]
            size = int(rng.integers(0, min(4, len(others)) + 1))
            conditioning = sorted(rng.choice(others, size=size, replace=False).tolist()) if size else []
            queries.append(
                {
                    "left": left,
                    "right": right,
                    "given": conditioning,
                    "separated": bool(nx.is_d_separator(dag, {left}, {right}, set(conditioning))),
                }
            )
        cases.append({"nodes": names, "edges": sorted([list(edge) for edge in dag.edges]), "queries": queries})
    return cases


# ---------------------------------------------------------------------------
# Logistic regression reference: statsmodels.
# ---------------------------------------------------------------------------


def rounded(values, digits: int = 10) -> list[float]:
    return [round(float(value), digits) for value in values]


def logistic_case(name: str, frame: pd.DataFrame, target: str) -> dict:
    exog = sm.add_constant(frame.drop(columns=[target]), has_constant="add").astype(float)
    result = sm.Logit(frame[target].astype(float), exog).fit(disp=0, maxiter=200)
    robust = sm.Logit(frame[target].astype(float), exog).fit(disp=0, maxiter=200, cov_type="HC1")
    return {
        "name": name,
        "columns": list(exog.columns),
        "X": [rounded(row, 8) for row in exog.to_numpy()],
        "y": [int(value) for value in frame[target]],
        "params": rounded(result.params),
        "bse": rounded(result.bse),
        "robustBse": rounded(robust.bse),
        "logLikelihood": round(float(result.llf), 8),
    }


def logistic_cases(rng) -> list[dict]:
    n = 240
    z1 = rng.normal(size=n)
    z2 = rng.normal(size=n)
    base = pd.DataFrame({"z1": z1, "z2": z2, "t": rng.binomial(1, 1 / (1 + np.exp(-(0.4 + 0.9 * z1 - 0.7 * z2))))})

    scaled = pd.DataFrame(
        {
            "income": rng.normal(60000, 22000, size=n),
            "rate": rng.normal(0.02, 0.004, size=n),
        }
    )
    scaled["t"] = rng.binomial(1, 1 / (1 + np.exp(-(-1 + (scaled.income - 60000) / 30000 + (scaled.rate - 0.02) / 0.01))))

    site = rng.choice(["a", "b", "c"], size=n)
    dummies = pd.DataFrame(
        {
            "z": z1,
            "site_b": (site == "b").astype(float),
            "site_c": (site == "c").astype(float),
        }
    )
    dummies["t"] = rng.binomial(1, 1 / (1 + np.exp(-(0.2 + z1 + dummies.site_b - 0.8 * dummies.site_c))))

    rare = pd.DataFrame({"z": z1})
    rare["t"] = rng.binomial(1, 1 / (1 + np.exp(-(-3.0 + 0.6 * z1))))

    return [
        logistic_case("two continuous covariates", base, "t"),
        logistic_case("badly scaled covariates", scaled, "t"),
        logistic_case("dummy-coded category", dummies, "t"),
        logistic_case("rare treatment", rare, "t"),
    ]


# ---------------------------------------------------------------------------
# Diagnostics reference: the same CSV analysed with pandas and statsmodels.
# ---------------------------------------------------------------------------


def smd(treated: pd.Series, control: pd.Series) -> float:
    return abs(treated.mean() - control.mean()) / np.sqrt((treated.var(ddof=1) + control.var(ddof=1)) / 2)


def diagnostics_case(name, frame, *, treatment, outcome, covariates, treated_label, control_label, extra_edges=None):
    buffer = io.StringIO()
    frame.to_csv(buffer, index=False)

    working = frame[[treatment, *covariates]].dropna().copy()
    is_treated = working[treatment].astype(str).str.lower() == str(treated_label).lower()
    is_control = working[treatment].astype(str).str.lower() == str(control_label).lower()
    t = is_treated.astype(float)

    terms = pd.DataFrame(index=working.index)
    balance: dict[str, float] = {}
    for column in covariates:
        series = working[column]
        if pd.api.types.is_numeric_dtype(series):
            terms[column] = series.astype(float)
        else:
            for level in sorted(series.astype(str).unique())[1:]:
                terms[f"{column}={level}"] = (series.astype(str) == level).astype(float)

    for column in covariates:
        complete = frame[[treatment, column]].dropna()
        treated = complete[complete[treatment].astype(str).str.lower() == str(treated_label).lower()][column]
        control = complete[complete[treatment].astype(str).str.lower() == str(control_label).lower()][column]
        if pd.api.types.is_numeric_dtype(complete[column]):
            balance[column] = round(float(smd(treated, control)), 8)
        else:
            for level in sorted(complete[column].astype(str).unique()):
                balance[f"{column}={level}"] = round(
                    float(smd((treated.astype(str) == level).astype(float), (control.astype(str) == level).astype(float))),
                    8,
                )

    expected: dict = {"balance": balance, "rowsUsed": int(len(working))}
    if covariates:
        exog = sm.add_constant(terms, has_constant="add")
        fit = sm.Logit(t, exog).fit(disp=0, maxiter=200, warn_convergence=False)
        ps = fit.predict(exog)
        treated_ps, control_ps = ps[is_treated], ps[is_control]
        low = max(treated_ps.min(), control_ps.min())
        high = min(treated_ps.max(), control_ps.max())
        expected["propensity"] = {
            "treatedRange": rounded([treated_ps.min(), treated_ps.max()], 6),
            "controlRange": rounded([control_ps.min(), control_ps.max()], 6),
            "treatedOutsideSupport": round(float(((treated_ps < low) | (treated_ps > high)).mean()), 8),
            "controlOutsideSupport": round(float(((control_ps < low) | (control_ps > high)).mean()), 8),
            "extremeShare": round(float(((ps < EXTREME_LOW) | (ps > EXTREME_HIGH)).mean()), 8),
        }
    else:
        expected["propensity"] = None

    edges = [[column, treatment] for column in covariates]
    edges += [[column, outcome] for column in covariates]
    edges += [[treatment, outcome]] + (extra_edges or [])
    return {
        "name": name,
        "csv": buffer.getvalue(),
        "treatment": treatment,
        "outcome": outcome,
        "edges": edges,
        "covariates": covariates,
        "expected": expected,
    }


def diagnostics_cases(rng) -> list[dict]:
    n = 400
    age = rng.normal(45, 12, size=n)
    risk = rng.normal(size=n)
    site = rng.choice(["north", "south", "west"], size=n, p=[0.5, 0.3, 0.2])
    p = 1 / (1 + np.exp(-(-0.3 + 0.03 * (age - 45) + 0.8 * risk + 0.6 * (site == "south"))))
    treated = rng.binomial(1, p)
    outcome = 2 * treated + 0.5 * risk + 0.02 * age + rng.normal(size=n)
    mixed = pd.DataFrame(
        {
            "arm": np.where(treated == 1, "treated", "control"),
            "score": np.round(outcome, 4),
            "age": np.round(age, 3),
            "risk": np.round(risk, 4),
            "site": site,
        }
    )
    mixed.loc[rng.choice(n, size=12, replace=False), "risk"] = np.nan

    randomized = pd.DataFrame(
        {
            "t": rng.binomial(1, 0.5, size=120),
            "y": np.round(rng.normal(size=120), 4),
        }
    )

    # Near-perfect separation with two outliers: a min/max range check reports 0.7 overlap here.
    treated_part = [(1, i % 5, round(0.8 + i * 0.001, 3)) for i in range(100)]
    control_part = [(0, i % 5, round(0.2 + i * 0.001, 3)) for i in range(100)]
    separated = pd.DataFrame(treated_part + control_part + [(1, 0, 0.0), (0, 0, 1.0)], columns=["t", "y", "z"])

    return [
        diagnostics_case(
            "strings, missing values and a categorical covariate",
            mixed,
            treatment="arm",
            outcome="score",
            covariates=["age", "risk", "site"],
            treated_label="treated",
            control_label="control",
        ),
        diagnostics_case(
            "no covariates to adjust for",
            randomized,
            treatment="t",
            outcome="y",
            covariates=[],
            treated_label=1,
            control_label=0,
        ),
        diagnostics_case(
            "near-perfect separation with two outliers",
            separated,
            treatment="t",
            outcome="y",
            covariates=["z"],
            treated_label=1,
            control_label=0,
        ),
    ]


# ---------------------------------------------------------------------------
# Linear regression with HC1 standard errors: statsmodels.
# ---------------------------------------------------------------------------


def ols_case(name: str, frame: pd.DataFrame, target: str) -> dict:
    exog = sm.add_constant(frame.drop(columns=[target]), has_constant="add").astype(float)
    result = sm.OLS(frame[target].astype(float), exog).fit(cov_type="HC1")
    return {
        "name": name,
        "columns": list(exog.columns),
        "X": [rounded(row, 8) for row in exog.to_numpy()],
        "y": rounded(frame[target], 8),
        "params": rounded(result.params),
        "robustBse": rounded(result.bse),
    }


def ols_cases(rng) -> list[dict]:
    n = 240
    z1, z2 = rng.normal(size=n), rng.normal(size=n)
    heteroskedastic = pd.DataFrame({"z1": z1, "z2": z2})
    heteroskedastic["y"] = 1 + 2 * z1 - z2 + rng.normal(size=n) * (0.5 + np.abs(z1))
    scaled = pd.DataFrame({"income": rng.normal(60000, 22000, size=n), "rate": rng.normal(0.02, 0.004, size=n)})
    scaled["y"] = 3 + scaled.income / 10000 + 80 * scaled.rate + rng.normal(size=n)
    return [ols_case("heteroskedastic errors", heteroskedastic, "y"), ols_case("badly scaled covariates", scaled, "y")]


# ---------------------------------------------------------------------------
# Conditional independence tests: the method validated in tools/research/load-bearing-assumptions.
# ---------------------------------------------------------------------------


def gcm_basis(columns: list[np.ndarray], n: int) -> np.ndarray:
    z = [(c - c.mean()) / c.std() for c in columns]
    parts = [np.ones(n)]
    parts += z
    parts += [v**2 for v in z] + [v**3 for v in z]
    parts += [np.tanh(2 * v) for v in z] + [(v > 0).astype(float) for v in z]
    parts += [a * b for a, b in combinations(z, 2)]
    return np.column_stack(parts)


def gcm_p(a: np.ndarray, b: np.ndarray, condition: list[np.ndarray]) -> tuple[float, float]:
    n = len(a)
    basis = gcm_basis(condition, n)

    def residual(target):
        return target - basis @ np.linalg.lstsq(basis, target, rcond=None)[0]

    standardized = (a - a.mean()) / a.std()
    rb = residual(b)
    p_values = []
    for transform in (standardized, standardized**2 - 1, (standardized > 0).astype(float)):
        product = residual(transform) * rb
        statistic = np.sqrt(n) * product.mean() / product.std(ddof=1)
        p_values.append(2 * stats.norm.sf(abs(statistic)))
    return min(1.0, min(p_values) * 3), float(np.corrcoef(residual(standardized), rb)[0, 1])


def gcm_cases(rng) -> list[dict]:
    n = 200
    c1, c2 = rng.normal(size=n), rng.normal(size=n)
    conditional = np.round(c1 + 0.5 * c2 + rng.normal(size=n), 6)
    cases = {
        "independent given the condition": (
            np.round(c1 + rng.normal(size=n), 6),
            np.round(0.5 * c1 + c2 + rng.normal(size=n), 6),
            [np.round(c1, 6), np.round(c2, 6)],
        ),
        "linearly dependent": (np.round(c1, 6), np.round(0.6 * c1 + rng.normal(size=n), 6), [np.round(c2, 6)]),
        "nonlinearly dependent": (np.round(c1, 6), np.round(c1**2 - 1 + 0.4 * rng.normal(size=n), 6), [np.round(c2, 6)]),
        "no conditioning": (np.round(c2, 6), conditional, []),
    }
    results = []
    for name, (a, b, condition) in cases.items():
        p_value, correlation = gcm_p(a, b, condition)
        results.append(
            {
                "name": name,
                "a": a.tolist(),
                "b": b.tolist(),
                "condition": [column.tolist() for column in condition],
                "pValue": float(p_value),
                "correlation": round(correlation, 10),
            }
        )
    return results


# ---------------------------------------------------------------------------
# Effect estimates: AIPW and regression written out directly with statsmodels.
# ---------------------------------------------------------------------------


def design_matrix(frame: pd.DataFrame, covariates: list[str]) -> pd.DataFrame:
    design = pd.DataFrame({"const": np.ones(len(frame))}, index=frame.index)
    for column in covariates:
        if pd.api.types.is_numeric_dtype(frame[column]):
            design[column] = frame[column].astype(float)
        else:
            for level in sorted(frame[column].astype(str).unique())[1:]:
                design[f"{column}={level}"] = (frame[column].astype(str) == level).astype(float)
    return design


def reference_aipw(frame: pd.DataFrame, treatment, outcome, covariates, *, estimand: str, binary_outcome: bool) -> dict:
    t = frame[treatment].astype(float).to_numpy()
    y = frame[outcome].astype(float).to_numpy()
    design = design_matrix(frame, covariates)
    fitted = sm.Logit(t, design).fit(disp=0).predict(design)
    ps = np.clip(fitted, 0.0, 0.99) if estimand == "att" else np.clip(fitted, 0.01, 0.99)

    def predict_for_arm(arm: int):
        rows = t == arm
        if binary_outcome:
            return sm.Logit(y[rows], design[rows]).fit(disp=0).predict(design).to_numpy()
        return sm.OLS(y[rows], design[rows]).fit().predict(design).to_numpy()

    mu1, mu0 = predict_for_arm(1), predict_for_arm(0)
    n = len(t)
    if estimand == "att":
        share = t.mean()
        score = (t * (y - mu0) - (1 - t) * ps / (1 - ps) * (y - mu0)) / share
        estimate = score.mean()
        influence = score - t / share * estimate
    else:
        influence = mu1 - mu0 + t * (y - mu1) / ps - (1 - t) * (y - mu0) / (1 - ps)
        estimate = influence.mean()
    return {"estimate": float(estimate), "standardError": float(influence.std(ddof=1) / np.sqrt(n)), "rowsUsed": n}


def effect_case(name, frame, *, treatment, outcome, covariates, estimand="ate", kind="aipw", prepared=None):
    buffer = io.StringIO()
    frame.to_csv(buffer, index=False)
    working = (prepared if prepared is not None else frame)[[treatment, outcome, *covariates]].dropna()
    if kind == "aipw":
        expected = reference_aipw(
            working,
            treatment,
            outcome,
            covariates,
            estimand=estimand,
            binary_outcome=set(working[outcome].unique()) <= {0, 1},
        )
    else:
        design = design_matrix(working, covariates)
        design.insert(1, treatment, working[treatment].astype(float))
        model = sm.Logit if kind == "logistic" else sm.OLS
        fit = (
            model(working[outcome].astype(float), design).fit(disp=0, cov_type="HC1")
            if kind == "logistic"
            else model(working[outcome].astype(float), design).fit(cov_type="HC1")
        )
        expected = {
            "estimate": float(fit.params[treatment]),
            "standardError": float(fit.bse[treatment]),
            "rowsUsed": int(len(working)),
        }
    return {
        "name": name,
        "csv": buffer.getvalue(),
        "treatment": treatment,
        "outcome": outcome,
        "covariates": covariates,
        "estimand": estimand,
        "method": kind,
        "expected": expected,
    }


def effect_cases(rng) -> list[dict]:
    n = 500
    z = np.round(rng.normal(size=n), 5)
    w = np.round(rng.normal(size=n), 5)
    site = rng.choice(["east", "north", "west"], size=n, p=[0.5, 0.3, 0.2])
    site_effect = np.select([site == "north", site == "west"], [0.7, -0.6], default=0.0)
    t = rng.binomial(1, 1 / (1 + np.exp(-(0.2 + 0.9 * z - 0.4 * w + site_effect))))
    tau = 1.0 + 1.0 * (z > 0)
    y_continuous = np.round(0.5 * z + 0.3 * w + site_effect + tau * t + rng.normal(size=n), 5)
    y_binary = rng.binomial(1, 1 / (1 + np.exp(-(-0.4 + 1.0 * t + 0.8 * z + site_effect))))
    continuous = pd.DataFrame({"t": t, "y": y_continuous, "z": z, "w": w, "site": site})
    binary = pd.DataFrame({"t": t, "y": y_binary, "z": z, "w": w, "site": site})

    worded = continuous.copy()
    worded["t"] = np.where(t == 1, "treated", "control")
    worded["z"] = worded["z"].astype(object)
    missing = rng.choice(n, size=25, replace=False)
    worded.loc[missing, "z"] = "NA"
    prepared = continuous.copy()
    prepared.loc[missing, "z"] = np.nan

    dose = np.round(0.7 * z + rng.normal(size=n), 5)
    linear_dose = pd.DataFrame({"dose": dose, "y": np.round(0.5 * dose + z + rng.normal(size=n), 5), "z": z, "site": site})
    logistic_dose = pd.DataFrame(
        {"dose": dose, "y": rng.binomial(1, 1 / (1 + np.exp(-(0.6 * dose + 0.8 * z)))), "z": z, "site": site}
    )

    covariates = ["z", "w", "site"]
    return [
        effect_case("ATE, continuous outcome", continuous, treatment="t", outcome="y", covariates=covariates),
        effect_case("ATT, continuous outcome", continuous, treatment="t", outcome="y", covariates=covariates, estimand="att"),
        effect_case("ATE, binary outcome", binary, treatment="t", outcome="y", covariates=covariates),
        effect_case("ATT, binary outcome", binary, treatment="t", outcome="y", covariates=covariates, estimand="att"),
        effect_case(
            "ATE with worded treatment and missing values",
            worded,
            treatment="t",
            outcome="y",
            covariates=covariates,
            prepared=prepared,
        ),
        effect_case("ATE with no covariates", continuous, treatment="t", outcome="y", covariates=[]),
        effect_case("numeric treatment, continuous outcome", linear_dose, treatment="dose", outcome="y", covariates=["z", "site"], kind="ols"),
        effect_case("numeric treatment, binary outcome", logistic_dose, treatment="dose", outcome="y", covariates=["z", "site"], kind="logistic"),
    ]


# ---------------------------------------------------------------------------
# Load-bearing assumptions: every single-arrow error, checked by brute force.
# ---------------------------------------------------------------------------


TIER = {"baseline": 0, "before": 1, "after": 3}


def tier_of(node, treatment, outcome, timing):
    if node == treatment:
        return 2
    if node == outcome:
        return 3
    return TIER.get(timing.get(node))


def timing_allows(u, v, treatment, outcome, timing) -> bool:
    if u == outcome and v == treatment:
        return False
    tu, tv = tier_of(u, treatment, outcome, timing), tier_of(v, treatment, outcome, timing)
    return tu is None or tv is None or tu <= tv


def single_arrow_errors(dag, treatment, outcome, timing):
    """Yields every candidate error as (kind, source, target, altered graph), and counts those timing rules out."""
    ruled_out = 0
    candidates = []
    for u, v in sorted(dag.edges):
        removed = dag.copy()
        removed.remove_edge(u, v)
        candidates.append(("remove", u, v, removed))
        if (u, v) == (treatment, outcome):
            continue
        reversed_graph = removed.copy()
        reversed_graph.add_edge(v, u)
        if nx.is_directed_acyclic_graph(reversed_graph):
            if timing_allows(v, u, treatment, outcome, timing):
                candidates.append(("reverse", u, v, reversed_graph))
            else:
                ruled_out += 1
    for u in sorted(dag.nodes):
        for v in sorted(dag.nodes):
            if u == v or dag.has_edge(u, v) or dag.has_edge(v, u) or (u, v) == (outcome, treatment):
                continue
            added = dag.copy()
            added.add_edge(u, v)
            if nx.is_directed_acyclic_graph(added):
                if timing_allows(u, v, treatment, outcome, timing):
                    candidates.append(("add", u, v, added))
                else:
                    ruled_out += 1
    return candidates, ruled_out


def backdoor_valid(graph, treatment, outcome, subset, unobserved) -> bool:
    if set(subset) & (nx.descendants(graph, treatment) | {treatment, outcome} | set(unobserved)):
        return False
    return nx.is_d_separator(backdoor_graph(graph, treatment), {treatment}, {outcome}, set(subset))


def audit_case(rng, node_count, edge_probability, unobserved_probability, timed: bool):
    while True:
        dag, treatment, outcome, unobserved = random_case(rng, node_count, edge_probability, unobserved_probability)
        allowed = sorted(set(dag.nodes) - nx.descendants(dag, treatment) - {treatment, outcome} - set(unobserved))
        valid = [set(s) for s in all_subsets(allowed) if backdoor_valid(dag, treatment, outcome, s, unobserved)]
        if valid:
            break
    baseline = sorted(min(valid, key=lambda item: (len(item), sorted(item))))
    timing = {}
    if timed:
        for node in dag.nodes:
            if node not in (treatment, outcome) and rng.random() < 0.6:
                timing[node] = str(rng.choice(["baseline", "before", "after"]))

    candidates, ruled_out = single_arrow_errors(dag, treatment, outcome, timing)
    breaking = []
    for kind, source, target, altered in candidates:
        if backdoor_valid(altered, treatment, outcome, baseline, unobserved):
            continue
        choices = sorted(set(altered.nodes) - nx.descendants(altered, treatment) - {treatment, outcome} - set(unobserved))
        distances = [
            len(set(s) ^ set(baseline))
            for s in all_subsets(choices)
            if backdoor_valid(altered, treatment, outcome, s, unobserved)
        ]
        breaking.append({"edit": kind, "source": source, "target": target, "repairDistance": min(distances) if distances else None})
    return {
        "nodes": sorted(dag.nodes),
        "edges": sorted([list(edge) for edge in dag.edges]),
        "treatment": treatment,
        "outcome": outcome,
        "unobserved": unobserved,
        "timing": timing,
        "baseline": baseline,
        "editsChecked": len(candidates),
        "ruledOutByTiming": ruled_out,
        "breaking": breaking,
    }


def audit_cases(rng) -> list[dict]:
    cases = []
    for index in range(70):
        cases.append(
            audit_case(
                rng,
                int(rng.integers(3, 8)),
                float(rng.uniform(0.15, 0.6)),
                float(rng.choice([0.0, 0.0, 0.2])),
                timed=index % 2 == 1,
            )
        )
    return cases


def main() -> None:
    rng = np.random.default_rng(SEED)
    # A separate stream, so that adding cases here never changes the ones generated above.
    later = np.random.default_rng(SEED + 1)
    payload = {
        "generatedBy": "tools/verification/generate_golden.py",
        "libraries": {
            "networkx": nx.__version__,
            "numpy": np.__version__,
            "pandas": pd.__version__,
            "statsmodels": sm.__dict__.get("__version__") or __import__("statsmodels").__version__,
        },
        "thresholds": {"extremeLow": EXTREME_LOW, "extremeHigh": EXTREME_HIGH},
        "graphCases": graph_cases(rng),
        "dSeparationCases": dseparation_cases(rng),
        "logisticCases": logistic_cases(rng),
        "diagnosticsCases": diagnostics_cases(rng),
        "normalTwoSided": [{"z": z, "p": float(2 * stats.norm.sf(z))} for z in [0, 0.1, 0.5, 1, 1.96, 2, 2.5, 3, 4, 5, 6, 8, 10, 15, 25]],
        "olsCases": ols_cases(later),
        "gcmCases": gcm_cases(later),
        "effectCases": effect_cases(later),
        "auditCases": audit_cases(later),
    }
    OUTPUT.parent.mkdir(parents=True, exist_ok=True)
    OUTPUT.write_text(json.dumps(payload, separators=(",", ":")) + "\n", encoding="utf-8")
    print(
        f"Wrote {OUTPUT} ({OUTPUT.stat().st_size / 1024:.0f} KB): "
        f"{len(payload['graphCases'])} graphs, {len(payload['dSeparationCases'])} d-separation sets, "
        f"{len(payload['logisticCases'])} logistic fits, {len(payload['diagnosticsCases'])} diagnostics cases, "
        f"{len(payload['olsCases'])} OLS fits, {len(payload['gcmCases'])} independence tests, "
        f"{len(payload['effectCases'])} effect estimates, {len(payload['auditCases'])} audits"
    )


if __name__ == "__main__":
    main()
