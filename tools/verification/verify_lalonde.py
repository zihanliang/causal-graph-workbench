"""Run the app's engine on real data with an experimental benchmark, and check it against statsmodels.

LaLonde's job-training data pairs people from a randomized experiment (effect on the treated: about
+$1,794) with survey controls, where the naive comparison is about -$8,498. Each analyst below draws a
plausible graph that leaves out one arrow into treatment. This checks three things the app relies on:

1. Its numbers equal an independent statsmodels calculation.
2. Omissions that really move the estimate are the ones the data flags.
3. Correcting those omissions moves the estimate toward the experimental benchmark.

Requires `pip install causaldata`. Usage: python tools/verification/verify_lalonde.py
"""

from __future__ import annotations

import json
import subprocess
import sys
import tempfile
from pathlib import Path

import numpy as np
import pandas as pd
import statsmodels.api as sm
from causaldata import cps_mixtape, nsw_mixtape

ROOT = Path(__file__).resolve().parents[2]
COVARIATES = ["age", "educ", "black", "hisp", "marr", "nodegree", "re74", "re75"]
TIMING = {
    "age": "baseline",
    "black": "baseline",
    "hisp": "baseline",
    "educ": "baseline",
    "marr": "baseline",
    "nodegree": "baseline",
    "re74": "before",
    "re75": "before",
}


def load() -> tuple[pd.DataFrame, float]:
    nsw = nsw_mixtape.load_pandas().data
    cps = cps_mixtape.load_pandas().data
    benchmark = float(nsw[nsw.treat == 1].re78.mean() - nsw[nsw.treat == 0].re78.mean())
    frame = pd.concat([nsw[nsw.treat == 1], cps], ignore_index=True).drop(columns=["data_id"]).astype(float)
    return frame, benchmark


def graph_omitting(variable: str) -> dict:
    edges = [("age", "educ"), ("black", "educ"), ("hisp", "educ"), ("educ", "nodegree"), ("age", "marr")]
    for column in ["age", "educ", "black", "hisp", "marr", "nodegree"]:
        edges += [(column, "re74"), (column, "re75")]
    edges.append(("re74", "re75"))
    for column in COVARIATES:
        edges.append((column, "re78"))
        if column != variable:
            edges.append((column, "treat"))
    edges.append(("treat", "re78"))
    nodes = [*COVARIATES, "treat", "re78"]
    return {
        "nodes": [{"id": node, "label": node, "x": 0, "y": 0, "timing": TIMING.get(node)} for node in nodes],
        "edges": [{"id": f"{a}->{b}", "source": a, "target": b} for a, b in edges],
        "treatmentId": "treat",
        "outcomeId": "re78",
    }


def reference_att(frame: pd.DataFrame, covariates: list[str]) -> tuple[float, float]:
    """Doubly robust ATT written out independently of the engine."""
    design = sm.add_constant(frame[sorted(covariates)])
    t, y = frame.treat.to_numpy(), frame.re78.to_numpy()
    ps = np.clip(sm.Logit(t, design).fit(disp=0, maxiter=200).predict(design).to_numpy(), 0.0, 0.99)
    mu0 = sm.OLS(y[t == 0], design[t == 0]).fit().predict(design).to_numpy()
    share = t.mean()
    score = (t * (y - mu0) - (1 - t) * ps / (1 - ps) * (y - mu0)) / share
    estimate = score.mean()
    influence = score - t / share * estimate
    return float(estimate), float(influence.std(ddof=1) / np.sqrt(len(t)))


def main() -> int:
    frame, benchmark = load()
    print(f"{len(frame)} rows, {int(frame.treat.sum())} treated. Experimental benchmark {benchmark:,.0f}. Naive comparison "
          f"{frame[frame.treat == 1].re78.mean() - frame[frame.treat == 0].re78.mean():,.0f}.\n")

    csv = frame.to_csv(index=False)
    requests = [
        {
            "graph": graph_omitting(variable),
            "dataContext": {"hasData": True, "estimand": "att", "treatmentType": "unknown", "outcomeType": "unknown"},
            "dataset": {"filename": "lalonde.csv", "content": csv},
        }
        for variable in COVARIATES
    ]
    with tempfile.TemporaryDirectory() as temp:
        input_path, output_path = Path(temp) / "requests.json", Path(temp) / "results.json"
        input_path.write_text(json.dumps(requests), encoding="utf-8")
        subprocess.run(
            ["npx", "vite-node", "tools/verification/export_snippets.ts", str(input_path), str(output_path)],
            cwd=ROOT,
            check=True,
            capture_output=True,
            text=True,
        )
        results = json.loads(output_path.read_text(encoding="utf-8"))

    failures: list[str] = []
    print(f"{'left out':10s} {'data':10s} {'rank':>6s} {'drawn':>8s} {'fixed':>8s} {'statsmodels':>12s} {'error before':>13s} {'after':>7s}  severity")
    moved, quiet = [], []
    for variable, result in zip(COVARIATES, results):
        audit = result["audit"]
        entry = next((item for item in audit["assumptions"] if item["id"] == f"add:{variable}:treat"), None)
        if entry is None:
            failures.append(f"leaving out {variable} -> treat was not listed as breaking the set")
            continue
        drawn = result["effect"]["estimate"]
        fixed = entry["alternativeEstimate"]["estimate"]
        expected_drawn, _ = reference_att(frame, [c for c in COVARIATES if c != variable])
        expected_fixed, expected_se = reference_att(frame, COVARIATES)
        for label, actual, expected in [("drawn", drawn, expected_drawn), ("fixed", fixed, expected_fixed)]:
            if abs(actual - expected) > 1e-3:
                failures.append(f"{variable}: {label} estimate {actual:.4f} but statsmodels gives {expected:.4f}")
        if abs(entry["alternativeEstimate"]["standardError"] - expected_se) > 1e-3:
            failures.append(f"{variable}: standard error differs from statsmodels")
        conflicts = [item["id"] for item in audit["assumptions"] if item["dataCheck"] == "conflict"]
        rank = conflicts.index(entry["id"]) + 1 if entry["id"] in conflicts else None
        (moved if abs(fixed - drawn) > 300 else quiet).append((variable, entry, drawn, fixed))
        print(
            f"{variable:10s} {entry['dataCheck']:10s} {str(rank or '-'):>6s} {drawn:8,.0f} {fixed:8,.0f} {expected_fixed:12,.0f} "
            f"{abs(drawn - benchmark):13,.0f} {abs(fixed - benchmark):7,.0f}  {entry['severity']}"
        )

    print(f"\nOmissions that move the estimate by more than $300: {[item[0] for item in moved]}")
    for variable, entry, drawn, fixed in moved:
        if entry["dataCheck"] != "conflict":
            failures.append(f"leaving out {variable} moves the estimate but the data did not flag it")
        if abs(fixed - benchmark) >= abs(drawn - benchmark):
            failures.append(f"correcting {variable} did not move the estimate toward the benchmark")
        if entry["severity"] not in ("changes_conclusion", "moves_estimate"):
            failures.append(f"leaving out {variable} moves the estimate but is rated {entry['severity']}")
    if not moved:
        failures.append("no omission moved the estimate, which contradicts the earlier research result")
    for variable, entry, _, _ in quiet:
        if entry["severity"] in ("changes_conclusion", "moves_estimate") and abs(entry["shift"]) < 0.5 * entry["alternativeEstimate"]["standardError"]:
            failures.append(f"leaving out {variable} barely moves the estimate but is rated {entry['severity']}")

    if failures:
        print("\nFAILED:")
        for failure in failures:
            print(f"  - {failure}")
        return 1
    print("\nAll checks passed: the numbers match statsmodels, and what matters is what the data flags.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
