# Load-bearing assumptions: research prototypes

Python prototypes behind the feature that shows which arrows in a DAG an analysis actually depends on. The app does not use this
code: its implementation is `apps/frontend/src/engine/audit.ts`. This records what was tested before committing to the design, and
what those tests ruled out. `tools/verification/verify_calibration.ts` and `verify_lalonde.py` measure the same things on the real engine.

```bash
python3 -m pip install -r tools/verification/requirements.txt causaldata
cd tools/research/load-bearing-assumptions
python3 lalonde_spike.py    # real data with an experimental benchmark
python3 mc_spike.py 300     # random DAGs, ideal conditions
python3 mc_hard.py 200      # weak edges, small samples, nonlinearity, latent confounders
python3 mc_flex.py 200      # linear vs flexible conditional-independence tests
```

## What was found (November 2026)

On LaLonde (experimental benchmark +$1,794, crude comparison -$8,498), an analyst's DAG omitted one arrow into treatment at a
time. Omitting `black` or `re75` moved the estimate most, was strongly contradicted by the data, and correcting it cut the
distance from the benchmark from $1,570 and $1,250 to $523. Three other omissions were statistically significant but moved the
estimate by less than $103. Some rejections carried no meaning at all, such as `black ⟂ hisp` for mutually exclusive dummies.

Random DAGs (10 nodes, 200 runs per scenario):

| Scenario | False alarm when DAG is right | Harmful missing edge detected |
| --- | --- | --- |
| Strong edges, n=2000 | 4.5% | 100% |
| Medium edges, n=500 | 6.0% | 80% |
| Weak edges, n=200 | 4.5% | 3.7% |
| Nonlinear, linear test | 68% | 75% |
| Nonlinear, flexible test | 6% | 91% |

With a latent confounder of treatment and outcome, suggested fixes never helped: 0% improved the estimate and 25% made it worse.

## What this means for the design

- Rank by how much the estimate moves, not by p-value.
- Use the flexible test (`mc_flex.py`), not linear partial correlation.
- Never apply a suggested edit automatically. A conflict means either a missing arrow or an unmeasured common cause.
- Show no "passed" state. With weak edges and small samples, silence says little.
- Report sensitivity to unmeasured confounding separately, because these tests cannot see it.
- Do not sell the O-set as more robust: it breaks on 8.4% of omitted edges, against 10.6% for a minimal set.

These are simulations and one hand-written DAG, written with knowledge of the LaLonde literature. They show the mechanism works
under stated conditions, not that real users want it.
