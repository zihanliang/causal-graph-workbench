"""Run every code template the app generates, on data where the true effect is known.

Reading a template cannot catch silently wrong statistics: the previous weighting template ran
cleanly while ignoring its weights. So this script executes each one and compares the result with
the truth built into the simulated data, including on messy files (words instead of 0/1, missing
values, categorical covariates, column names with spaces).

Usage (from the repository root, after `npm install`):
    python tools/verification/verify_generated_code.py

DoWhy and R templates are checked when dowhy / Rscript are available, and reported as skipped
otherwise. The script exits non-zero if any executed template fails.
"""

from __future__ import annotations

import json
import shutil
import subprocess
import sys
import tempfile
from dataclasses import dataclass, field
from pathlib import Path

import numpy as np
import pandas as pd

ROOT = Path(__file__).resolve().parents[2]
RESULT_MARKER = "__RESULT__"
N = 20_000
# Single nearest-neighbour matching is noisy: over repeated samples of the scenarios below its SD is
# about 0.029 around the true value. Allow 3.5 SD so a real bias fails but sampling noise does not.
MATCHING_TOLERANCE = 0.1
REPRODUCTION_TOLERANCE = 1e-5


# ---------------------------------------------------------------------------
# Scenarios: simulated files with a known answer.
# ---------------------------------------------------------------------------


@dataclass
class Expectation:
    """`value` is what a snippet should recover, within `tolerance`."""

    variable: str
    value: float
    tolerance: float
    label: str


@dataclass
class Scenario:
    name: str
    edges: list[tuple[str, str]]
    treatment: str
    outcome: str
    frame: pd.DataFrame
    expectations: dict[str, list[Expectation]]
    bindings: dict[str, str] = field(default_factory=dict)
    data_context: dict = field(default_factory=dict)
    upload: bool = True
    filename: str = "study.csv"
    expected_snippets: set[str] | None = None
    # Evidence that the data are confounded, so a method ignoring adjustment would be caught.
    crude: float | None = None
    truth_for_crude: float | None = None


def logistic(x):
    return 1 / (1 + np.exp(-x))


CONFOUNDING_EDGES = [("Z", "X"), ("Z", "Y"), ("X", "Y")]
ALL_BINARY = {"python-statsmodels", "python-dowhy", "r-template", "python-weighting", "python-matching", "python-aipw"}
REGRESSION_ONLY = {"python-statsmodels", "python-dowhy", "r-template"}


def crude_difference(frame, treatment, outcome):
    return float(frame[frame[treatment] == 1][outcome].mean() - frame[frame[treatment] == 0][outcome].mean())


def homogeneous_scenario(rng) -> Scenario:
    z = rng.normal(size=N)
    x = rng.binomial(1, logistic(1.2 * z))
    y = 0.8 * z + 2.0 * x + rng.normal(size=N)
    frame = pd.DataFrame({"X": x, "Y": y, "Z": z})
    tight = 0.06
    return Scenario(
        name="continuous outcome, constant effect of 2",
        edges=CONFOUNDING_EDGES,
        treatment="X",
        outcome="Y",
        frame=frame,
        expected_snippets=ALL_BINARY,
        crude=crude_difference(frame, "X", "Y"),
        truth_for_crude=2.0,
        expectations={
            "python-statsmodels": [Expectation("effect", 2.0, tight, "OLS coefficient")],
            "python-weighting": [Expectation("ate", 2.0, tight, "IPW ATE")],
            "python-matching": [Expectation("att", 2.0, MATCHING_TOLERANCE, "matched ATT")],
            "python-aipw": [Expectation("effect", 2.0, tight, "AIPW ATE")],
            "python-dowhy": [Expectation("estimate.value", 2.0, tight, "DoWhy estimate")],
            "r-template": [Expectation("treatment_coefficient", 2.0, tight, "lm coefficient")],
        },
    )


def heterogeneous_scenario(rng) -> Scenario:
    z = rng.normal(size=N)
    x = rng.binomial(1, logistic(1.2 * z))
    tau = 1.0 + 2.0 * (z > 0)
    y = 0.5 * z + tau * x + rng.normal(size=N)
    frame = pd.DataFrame({"X": x, "Y": y, "Z": z})
    ate, att = float(tau.mean()), float(tau[x == 1].mean())
    return Scenario(
        name=f"effect varies by Z, so ATE={ate:.3f} and ATT={att:.3f} differ",
        edges=CONFOUNDING_EDGES,
        treatment="X",
        outcome="Y",
        frame=frame,
        expected_snippets=ALL_BINARY,
        expectations={
            "python-weighting": [Expectation("ate", ate, 0.08, "IPW targets the ATE")],
            "python-aipw": [Expectation("effect", ate, 0.08, "AIPW targets the ATE")],
            "python-matching": [Expectation("att", att, MATCHING_TOLERANCE, "matching targets the ATT")],
        },
    )


def att_scenario(rng) -> Scenario:
    z = rng.normal(size=N)
    x = rng.binomial(1, logistic(1.2 * z))
    tau = 1.0 + 2.0 * (z > 0)
    y = 0.5 * z + tau * x + rng.normal(size=N)
    frame = pd.DataFrame({"X": x, "Y": y, "Z": z})
    att = float(tau[x == 1].mean())
    return Scenario(
        name=f"asking for the ATT, true value {att:.3f}",
        edges=CONFOUNDING_EDGES,
        treatment="X",
        outcome="Y",
        frame=frame,
        data_context={"estimand": "att"},
        expected_snippets=ALL_BINARY,
        expectations={"python-aipw": [Expectation("effect", att, 0.08, "AIPW targets the ATT")]},
    )


def chosen_set_scenario(rng) -> Scenario:
    z = rng.normal(size=N)
    w = rng.normal(size=N)
    x = rng.binomial(1, logistic(1.2 * z))
    y = 2.0 * x + 0.8 * z + 0.9 * w + rng.normal(size=N)
    frame = pd.DataFrame({"X": x, "Y": y, "Z": z, "W": w})
    return Scenario(
        name="choosing a larger valid set than the recommended one",
        edges=[("Z", "X"), ("Z", "Y"), ("W", "Y"), ("X", "Y")],
        treatment="X",
        outcome="Y",
        frame=frame,
        data_context={"chosenSet": ["W", "Z"]},
        expected_snippets=ALL_BINARY,
        expectations={"python-aipw": [Expectation("effect", 2.0, 0.06, "AIPW with the chosen set")]},
    )


def binary_outcome_continuous_treatment_scenario(rng) -> Scenario:
    z = rng.normal(size=N)
    x = 0.7 * z + rng.normal(size=N)
    y = rng.binomial(1, logistic(0.6 * x + 0.8 * z))
    frame = pd.DataFrame({"X": x, "Y": y, "Z": z})
    return Scenario(
        name="numeric treatment and binary outcome, true log odds ratio 0.6",
        edges=CONFOUNDING_EDGES,
        treatment="X",
        outcome="Y",
        frame=frame,
        expected_snippets=REGRESSION_ONLY,
        expectations={"python-statsmodels": [Expectation("effect", 0.6, 0.06, "log odds ratio")]},
    )


def binary_outcome_scenario(rng) -> Scenario:
    z = rng.normal(size=N)
    x = rng.binomial(1, logistic(1.2 * z))
    p1, p0 = logistic(-0.5 + 1.0 + 1.5 * z), logistic(-0.5 + 1.5 * z)
    y = rng.binomial(1, np.where(x == 1, p1, p0))
    frame = pd.DataFrame({"X": x, "Y": y, "Z": z})
    risk_difference = float((p1 - p0).mean())
    return Scenario(
        name=f"binary outcome, true risk difference {risk_difference:.3f}",
        edges=CONFOUNDING_EDGES,
        treatment="X",
        outcome="Y",
        frame=frame,
        expected_snippets=ALL_BINARY,
        crude=crude_difference(frame, "X", "Y"),
        truth_for_crude=risk_difference,
        expectations={
            "python-statsmodels": [
                Expectation("effect", 1.0, 0.08, "conditional log odds ratio"),
                Expectation("risk_difference", risk_difference, 0.02, "standardized risk difference"),
            ],
            "python-weighting": [Expectation("ate", risk_difference, 0.02, "IPW must use its weights")],
            "python-aipw": [Expectation("effect", risk_difference, 0.02, "AIPW risk difference")],
            "r-template": [Expectation("treatment_coefficient", 1.0, 0.08, "glm log odds ratio")],
        },
    )


def messy_frame(rng, *, binary_outcome: bool):
    """Words for treatment, a categorical confounder, assorted missing tokens, and awkward headers."""
    z = rng.normal(size=N)
    site = rng.choice(["north", "south", "west"], size=N, p=[0.5, 0.3, 0.2])
    site_effect = np.select([site == "south", site == "west"], [0.8, -0.8], default=0.0)
    x = rng.binomial(1, logistic(0.9 * z + site_effect))
    if binary_outcome:
        p1 = logistic(-0.5 + 1.0 + 1.0 * z + site_effect)
        p0 = logistic(-0.5 + 1.0 * z + site_effect)
        y = rng.binomial(1, np.where(x == 1, p1, p0))
        truth = float((p1 - p0).mean())
        outcome_column = np.where(y == 1, "yes", "no").astype(object)
    else:
        y = 1.5 * x + 0.7 * z + site_effect + rng.normal(size=N)
        truth = 1.5
        outcome_column = np.round(y, 5).astype(object)

    risk = np.round(z, 5).astype(object)
    rows = rng.permutation(N)
    risk[rows[:200]] = "NA"
    risk[rows[200:300]] = "missing"
    site_column = site.astype(object)
    site_column[rows[300:400]] = ""
    frame = pd.DataFrame(
        {
            "arm": np.where(x == 1, "treated", "control"),
            "final outcome": outcome_column,
            "baseline risk (z)": risk,
            "site": site_column,
        }
    )
    return frame, truth


MESSY_EDGES = [("Z", "X"), ("Z", "Y"), ("S", "X"), ("S", "Y"), ("X", "Y")]
MESSY_BINDINGS = {"X": "arm", "Y": "final outcome", "Z": "baseline risk (z)", "S": "site"}


def messy_continuous_scenario(rng) -> Scenario:
    frame, truth = messy_frame(rng, binary_outcome=False)
    return Scenario(
        name="messy file with a continuous outcome",
        edges=MESSY_EDGES,
        treatment="X",
        outcome="Y",
        frame=frame,
        bindings=MESSY_BINDINGS,
        expected_snippets=ALL_BINARY,
        expectations={
            "python-statsmodels": [Expectation("effect", truth, 0.08, "OLS coefficient")],
            "python-weighting": [Expectation("ate", truth, 0.08, "IPW ATE")],
            "python-matching": [Expectation("att", truth, MATCHING_TOLERANCE, "matched ATT")],
            "python-aipw": [Expectation("effect", truth, 0.08, "AIPW ATE")],
            "python-dowhy": [Expectation("estimate.value", truth, 0.08, "DoWhy estimate")],
            "r-template": [Expectation("treatment_coefficient", truth, 0.08, "lm coefficient")],
        },
    )


def messy_binary_scenario(rng) -> Scenario:
    frame, truth = messy_frame(rng, binary_outcome=True)
    return Scenario(
        name=f"messy file with yes/no outcome, true risk difference {truth:.3f}",
        edges=MESSY_EDGES,
        treatment="X",
        outcome="Y",
        frame=frame,
        bindings=MESSY_BINDINGS,
        expected_snippets=ALL_BINARY,
        expectations={
            "python-statsmodels": [
                Expectation("effect", 1.0, 0.1, "conditional log odds ratio"),
                Expectation("risk_difference", truth, 0.02, "standardized risk difference"),
            ],
            "python-weighting": [Expectation("ate", truth, 0.025, "IPW risk difference")],
            "python-aipw": [Expectation("effect", truth, 0.025, "AIPW risk difference")],
            "r-template": [Expectation("treatment_coefficient", 1.0, 0.1, "glm log odds ratio")],
        },
    )


def randomized_scenario(rng) -> Scenario:
    x = rng.binomial(1, 0.5, size=N)
    y = 1.0 * x + rng.normal(size=N)
    frame = pd.DataFrame({"X": x, "Y": y})
    return Scenario(
        name="randomized treatment, empty adjustment set",
        edges=[("X", "Y")],
        treatment="X",
        outcome="Y",
        frame=frame,
        expected_snippets=ALL_BINARY,
        expectations={
            "python-statsmodels": [Expectation("effect", 1.0, 0.06, "OLS coefficient")],
            "python-weighting": [Expectation("ate", 1.0, 0.06, "IPW ATE")],
            "python-matching": [Expectation("att", 1.0, 0.06, "crude contrast")],
            "python-aipw": [Expectation("effect", 1.0, 0.06, "AIPW ATE")],
            "python-dowhy": [Expectation("estimate.value", 1.0, 0.06, "DoWhy estimate")],
            "r-template": [Expectation("treatment_coefficient", 1.0, 0.06, "lm coefficient")],
        },
    )


def continuous_treatment_scenario(rng) -> Scenario:
    z = rng.normal(size=N)
    x = 0.7 * z + rng.normal(size=N)
    y = 0.5 * x + 1.0 * z + rng.normal(size=N)
    frame = pd.DataFrame({"X": x, "Y": y, "Z": z})
    return Scenario(
        name="continuous treatment, regression templates only",
        edges=CONFOUNDING_EDGES,
        treatment="X",
        outcome="Y",
        frame=frame,
        expected_snippets=REGRESSION_ONLY,
        expectations={
            "python-statsmodels": [Expectation("effect", 0.5, 0.04, "OLS coefficient")],
            "python-dowhy": [Expectation("estimate.value", 0.5, 0.04, "DoWhy estimate")],
            "r-template": [Expectation("treatment_coefficient", 0.5, 0.04, "lm coefficient")],
        },
    )


def graph_only_scenario(rng) -> Scenario:
    z = rng.normal(size=N)
    x = rng.binomial(1, logistic(z))
    y = 1.0 * x + z + rng.normal(size=N)
    frame = pd.DataFrame({"X": x, "Y": y, "Z": z})
    return Scenario(
        name="no file uploaded, placeholder file name and declared types",
        edges=CONFOUNDING_EDGES,
        treatment="X",
        outcome="Y",
        frame=frame,
        upload=False,
        filename="your_data.csv",
        data_context={"treatmentType": "binary", "outcomeType": "continuous"},
        expected_snippets=ALL_BINARY,
        expectations={
            "python-statsmodels": [Expectation("effect", 1.0, 0.06, "OLS coefficient")],
            "python-aipw": [Expectation("effect", 1.0, 0.06, "AIPW ATE")],
            "r-template": [Expectation("treatment_coefficient", 1.0, 0.06, "lm coefficient")],
        },
    )


# ---------------------------------------------------------------------------
# Execution.
# ---------------------------------------------------------------------------


def worked_example_scenario() -> Scenario:
    """The example the start screen opens, with its own file, so the script a first-time user gets is checked too."""
    frame = pd.read_csv(ROOT / "apps/frontend/public/demo-data/training-program-study.csv")
    return Scenario(
        name="the worked example",
        edges=[
            ("age", "prior_earnings"),
            ("education", "prior_earnings"),
            ("age", "training"),
            ("prior_earnings", "training"),
            ("age", "earnings_after"),
            ("education", "earnings_after"),
            ("prior_earnings", "earnings_after"),
            ("training", "skills_after"),
            ("education", "skills_after"),
            ("skills_after", "earnings_after"),
            ("training", "earnings_after"),
            ("training", "promoted"),
            ("earnings_after", "promoted"),
        ],
        treatment="training",
        outcome="earnings_after",
        frame=frame,
        expectations={},
        filename="training-program-study.csv",
    )


def request_for(scenario: Scenario) -> dict:
    nodes = sorted({node for edge in scenario.edges for node in edge})
    context = {
        "hasData": scenario.upload,
        "treatmentType": "unknown",
        "outcomeType": "unknown",
        "columnBindings": scenario.bindings,
        **scenario.data_context,
    }
    return {
        "graph": {
            "nodes": [{"id": node, "label": node, "x": 0, "y": 0} for node in nodes],
            "edges": [{"id": f"{a}->{b}", "source": a, "target": b} for a, b in scenario.edges],
            "treatmentId": scenario.treatment,
            "outcomeId": scenario.outcome,
        },
        "dataContext": context,
        "dataset": {"filename": scenario.filename, "content": scenario.frame.to_csv(index=False)} if scenario.upload else None,
    }


def export_snippets(requests: list[dict], workdir: Path) -> list[dict]:
    input_path, output_path = workdir / "requests.json", workdir / "results.json"
    input_path.write_text(json.dumps(requests), encoding="utf-8")
    subprocess.run(
        ["npx", "vite-node", "tools/verification/export_snippets.ts", str(input_path), str(output_path)],
        cwd=ROOT,
        check=True,
        capture_output=True,
        text=True,
    )
    return json.loads(output_path.read_text(encoding="utf-8"))


def run_python(snippet: str, expectations: list[Expectation], cwd: Path, *, report_effect: bool = False) -> dict:
    variables = [item.variable for item in expectations] + (["effect", "ci_low", "ci_high"] if report_effect else [])
    reports = ", ".join(f'"{name}": float({name})' for name in dict.fromkeys(variables))
    instrumented = f'{snippet}\nimport json as __json\nprint("{RESULT_MARKER}" + __json.dumps({{{reports}}}))\n'
    path = cwd / "snippet.py"
    path.write_text(instrumented, encoding="utf-8")
    completed = subprocess.run([sys.executable, str(path)], cwd=cwd, capture_output=True, text=True, timeout=600)
    if completed.returncode != 0:
        raise RuntimeError(completed.stderr.strip().splitlines()[-1] if completed.stderr.strip() else "failed")
    line = next(line for line in completed.stdout.splitlines() if line.startswith(RESULT_MARKER))
    return json.loads(line[len(RESULT_MARKER) :])


def run_r(snippet: str, cwd: Path) -> dict:
    instrumented = f'{snippet}\ncat("{RESULT_MARKER}", coef(fit)[[2]], "\\n")\n'
    path = cwd / "snippet.R"
    path.write_text(instrumented, encoding="utf-8")
    completed = subprocess.run(["Rscript", "--vanilla", str(path)], cwd=cwd, capture_output=True, text=True, timeout=600)
    if completed.returncode != 0:
        raise RuntimeError(completed.stderr.strip().splitlines()[-1] if completed.stderr.strip() else "failed")
    line = next(line for line in completed.stdout.splitlines() if line.startswith(RESULT_MARKER))
    return {"treatment_coefficient": float(line.split()[1])}


def run_reproducible_script(script: str, cwd: Path) -> tuple[int, str]:
    """Runs the script the app offers for the whole analysis. It compares itself with what the app showed."""
    path = cwd / "reproduce_analysis.py"
    path.write_text(script, encoding="utf-8")
    completed = subprocess.run([sys.executable, str(path)], cwd=cwd, capture_output=True, text=True, timeout=900)
    return completed.returncode, completed.stdout + completed.stderr


def has_dowhy() -> bool:
    return (
        subprocess.run(
            [sys.executable, "-c", "import dowhy"], capture_output=True, text=True, timeout=300
        ).returncode
        == 0
    )


def main() -> int:
    rng = np.random.default_rng(20261104)
    scenarios = [
        homogeneous_scenario(rng),
        heterogeneous_scenario(rng),
        binary_outcome_scenario(rng),
        messy_continuous_scenario(rng),
        messy_binary_scenario(rng),
        randomized_scenario(rng),
        continuous_treatment_scenario(rng),
        graph_only_scenario(rng),
        att_scenario(rng),
        chosen_set_scenario(rng),
        binary_outcome_continuous_treatment_scenario(rng),
        worked_example_scenario(),
    ]
    dowhy_available = has_dowhy()
    r_available = shutil.which("Rscript") is not None
    passed = failed = skipped = 0
    failures: list[str] = []

    with tempfile.TemporaryDirectory() as temp:
        workdir = Path(temp)
        results = export_snippets([request_for(scenario) for scenario in scenarios], workdir)

        for index, (scenario, result) in enumerate(zip(scenarios, results)):
            print(f"\n{scenario.name}")
            if scenario.crude is not None:
                print(f"  (crude difference {scenario.crude:.3f}, truth {scenario.truth_for_crude:.3f})")
            if scenario.upload and result.get("effect") is None:
                failed += 1
                failures.append(f"{scenario.name}: no effect estimate ({result.get('effectUnavailable')})")
                print(f"  FAIL  no effect estimate: {result.get('effectUnavailable')}")
            cwd = workdir / f"scenario_{index}"
            cwd.mkdir()
            scenario.frame.to_csv(cwd / scenario.filename, index=False)

            snippets = {item["id"]: item for item in result["snippets"]}
            if scenario.expected_snippets is not None and set(snippets) != scenario.expected_snippets:
                failed += 1
                failures.append(f"{scenario.name}: generated {sorted(snippets)}")
                print(f"  FAIL  generated {sorted(snippets)}")

            script = result.get("reproducibleScript")
            if result.get("effect") is not None:
                if script is None:
                    failed += 1
                    failures.append(f"{scenario.name}: no reproducible script")
                    print("  FAIL  whole analysis: no script was generated")
                else:
                    code, output = run_reproducible_script(script, cwd)
                    summary = next((line.strip() for line in output.splitlines() if "numbers match" in line), None)
                    if code == 0 and summary:
                        print(f"  ok    whole analysis: {summary}")
                        passed += 1
                    else:
                        failed += 1
                        tail = [line for line in output.splitlines() if "DIFFERENT" in line or "Error" in line or "differ" in line][:6]
                        failures.append(f"{scenario.name} / whole analysis: {tail or output[-400:]}")
                        print(f"  FAIL  whole analysis: {tail or output[-400:]}")
                    if index == 0:
                        # The check has to be able to fail: the same script on a changed file must say so.
                        original = (cwd / scenario.filename).read_text(encoding="utf-8")
                        altered = scenario.frame.copy()
                        altered[scenario.outcome] = altered[scenario.outcome] + altered[scenario.treatment] * 0.5
                        altered.to_csv(cwd / scenario.filename, index=False)
                        code, output = run_reproducible_script(script, cwd)
                        (cwd / scenario.filename).write_text(original, encoding="utf-8")
                        if code != 0 and "DIFFERENT" in output:
                            print("  ok    whole analysis: notices when the data file has changed")
                            passed += 1
                        else:
                            failed += 1
                            failures.append(f"{scenario.name} / whole analysis: did not notice a changed file")
                            print("  FAIL  whole analysis: did not notice a changed file")

            for snippet_id, item in sorted(snippets.items()):
                expectations = scenario.expectations.get(snippet_id, [])
                if snippet_id == "python-dowhy" and not dowhy_available:
                    print(f"  skip  {snippet_id}: dowhy is not installed")
                    skipped += 1
                    continue
                if item["language"] == "r" and not r_available:
                    print(f"  skip  {snippet_id}: Rscript is not installed")
                    skipped += 1
                    continue
                shown = result.get("effect")
                reproduces_app = shown is not None and shown["snippetId"] == snippet_id
                try:
                    if item["language"] == "r":
                        values = run_r(item["content"], cwd)
                    else:
                        values = run_python(item["content"], expectations, cwd, report_effect=reproduces_app)
                except Exception as error:  # A template that crashes is a failure, not a reason to stop.
                    failed += 1
                    failures.append(f"{scenario.name} / {snippet_id}: {error}")
                    print(f"  FAIL  {snippet_id}: crashed: {error}")
                    continue

                if reproduces_app:
                    # The script offered as "reproduce this number" has to give exactly the app's number.
                    gaps = [
                        abs(values["effect"] - shown["estimate"]),
                        abs(values["ci_low"] - shown["ciLow"]),
                        abs(values["ci_high"] - shown["ciHigh"]),
                    ]
                    if max(gaps) <= REPRODUCTION_TOLERANCE:
                        print(f"  ok    {snippet_id}: reproduces the app's {shown['estimate']:.6f} (largest gap {max(gaps):.1e})")
                        passed += 1
                    else:
                        failed += 1
                        message = f"script gives {values['effect']:.6f}, app shows {shown['estimate']:.6f} (largest gap {max(gaps):.1e})"
                        failures.append(f"{scenario.name} / {snippet_id}: {message}")
                        print(f"  FAIL  {snippet_id}: {message}")

                if not expectations and not reproduces_app:
                    print(f"  ok    {snippet_id}: ran")
                    passed += 1
                for expectation in expectations:
                    actual = values[expectation.variable]
                    if abs(actual - expectation.value) <= expectation.tolerance:
                        print(f"  ok    {snippet_id}: {expectation.label} {actual:.3f} vs truth {expectation.value:.3f}")
                        passed += 1
                    else:
                        failed += 1
                        message = f"{expectation.label} {actual:.3f} vs truth {expectation.value:.3f}"
                        failures.append(f"{scenario.name} / {snippet_id}: {message}")
                        print(f"  FAIL  {snippet_id}: {message}")

    print(f"\n{passed} checks passed, {failed} failed, {skipped} skipped.")
    for failure in failures:
        print(f"  - {failure}")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
