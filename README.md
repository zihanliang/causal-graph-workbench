# Causal Graph Workbench

Most causal analyses rest on arrows nobody tested. Draw the causal graph you believe, add your data, and see which variables to
adjust for, the estimated effect, and which assumptions your conclusion actually depends on.

Everything runs in your browser. There is no server, so a CSV you open here is never uploaded.

The tool does not verify the DAG is true. It only reasons conditionally on the DAG provided by the user.

## What you get

**The estimate.** A doubly robust effect with a 95% confidence interval, computed in the browser. The generated script reproduces
the same number from your file.

**The arrows it depends on.** The app checks every way your graph could be wrong by one arrow. For each error that would stop your
adjustment set from being valid, it shows what would change, ranked by how far the estimate would move:

> **education → training** · data disagrees
>
> You assume education has no direct effect on training. If it does, this backdoor path stays open:
> training ← education → earnings_after. To stay valid you would need to also adjust for education.
>
> The estimate would go from 4.630 to 2.882 (95% CI 2.470 to 3.293).

That example is built in: **Training program: one arrow is wrong** is simulated data where the true effect is 2.8.

**How the answer was reached.** Six steps, each saying its result in a line and opening for the detail: the question, the paths, what to
adjust for, the data, the estimate and the check. The graph shows what each step is about. The built-in example walks through them from
the start, rather than opening on the finished result.

**What the same data says under other choices.** No adjustment gives 4.88 there, and adjusting for everything measured gives 0.27.
You can test the set you actually used and see whether it is valid, and if not, why.

**What to do when you are not sure of the graph.** Keep several graphs side by side, up to six, and compare them on the same file. Each
gets its own adjustment set, estimate and data check. Graphs that lead to the same set are grouped as one answer, and where one set is
valid under graphs that would otherwise disagree, the page says so, because then you do not have to choose between them first. In that
example, adding education → training and adding something unmeasured behind both give the same 2.882, and adjusting for age, education
and prior_earnings is valid with or without the arrow. Graphs are never ranked, for the reason below.

You can also mark up to four pairs of variables as not sure. Every combination of an arrow one way, the other way, or none is tried on the
graph on show, leaving out those that run backwards in time or form a cycle. The page says how many answers they lead to and which pair the
answer depends on, and any combination can be kept as a graph to compare.

**A way in without a graph.** Start from a data file and say when each column was fixed, relative to treatment. The first graph says only what
time order allows: anything earlier may affect anything later. So the data has nothing to contradict, and everything measured before treatment
is adjusted for. Remove the arrows you are sure do not exist, and the data can start checking you. A column whose timing you do not know is
tried both ways.

**How strong something unmeasured would have to be.** No test can see a confounder you did not measure, so the app says what it would
take: in that example, something would have to explain 37.8% of what the adjustment leaves unexplained in both treatment and outcome to
explain away the effect. A chart places the variables you did measure on the same scale, and the E-value is alongside.

**A methods section, and a script.** The Write-up tab drafts the methods text from what was actually done, with its references, and leaves
the reasons you believe the graph for you to add. One Python script recomputes every number on the page from your file and checks them
against what the page showed, so a reviewer can run it and see.

**Also:** path-by-path explanations of what is open and blocked, variable roles, every minimal adjustment set, balance and overlap
checks on the variables you adjust for, code for statsmodels, DoWhy, R, weighting, matching and AIPW, and exports to Markdown, PDF, SVG
and PNG.

## What it cannot tell you

These limits come from testing the app on simulated data where the truth is known (see [How results are checked](#how-results-are-checked)):

- **Something unmeasured that affects both treatment and outcome is invisible to every test here.** In simulation, the estimate's
  interval never contained the truth in this situation. The app can still flag a conflict there, and following that suggestion made
  the estimate worse in 51 of 55 cases and better in none. So it never changes your graph by itself, and a conflict always means
  either a missing arrow or something unmeasured.
- **No conflict does not mean the graph is right.** A harmful missing arrow is detected 100% of the time with strong effects and 2,000
  rows, about 70% with medium effects and 500 rows, and under 10% with weak effects and 200 rows. There is no "passed" state.
- **Only single-arrow errors are checked.** Graphs that are wrong in several places at once can behave differently. To look at those,
  draw them and compare them.
- **The data can rule a graph out, but it cannot pick one.** Graphs can imply exactly the same independences and still give different
  answers. In that example, once education → training is added, also reversing prior_earnings → training passes every check and gives 2.03,
  whose interval misses the true effect, and only the timing of the variables shows it is wrong. A graph with every arrow claims nothing testable, so it can never be contradicted,
  right or wrong. So the page says which graphs the checks cannot separate, and never which is best.
- **A first graph from time order is a starting point, not a safe default.** In simulation it recovered the effect when every confounder was
  measured, covering it 94% to 95% of the time. With a strong unmeasured confounder, or a variable measured before treatment that is an effect of
  two strong unmeasured causes, its interval almost never contained the truth, and no check flagged it. The page says so before the graph is built.
- **How strong is a measure, not a verdict.** The robustness value and E-value say how strong something unmeasured would have to be, not
  whether it exists, and they consider one confounder at a time. Comparing it with a measured variable is a guide to size, not a limit: in
  simulation the true bias of a variable that strong ran from about 0.7 to 1.4 times the figure shown.
- **Not covered:** causal discovery (the app never proposes arrows from the data), instrumental variables, frontdoor identification, mediation decomposition, selection diagrams,
  transportability, and time-varying treatments.

The graph is your assumption, and every result here is conditional on it.

## Run it locally

```bash
npm install
npm run dev
```

Then open `http://127.0.0.1:5173` and choose **See a worked example**.

To use your own data, choose **Draw my own graph** and work through the three steps at the top of the page:

1. **Graph:** add variables, draw an arrow for each direct cause, and pick the treatment and outcome. Open a variable to mark it as not
   measured, or to say when it is fixed: that rules out arrows that would run backwards in time, and leaves fewer assumptions to defend.
   If you edit the graph as text, write `U [unobserved]` for a variable you did not measure.
2. **Data:** add a CSV and match its columns to your variables. This step is optional.
3. **Result:** the variables to adjust for and the estimated effect, with four tabs behind them: what the result rests on, other choices of
   variables, the code that reproduces it, and the details.

## How a result is reached

The adjustment set is the recommended one, or one you choose. An estimate needs a treatment and outcome with columns in your file, and:

| Treatment | Outcome | Estimate |
| --- | --- | --- |
| Two values | Numeric or two values | AIPW: ATE or ATT, the latter chosen next to the result |
| Numeric | Numeric | Linear regression coefficient, with robust standard errors |
| Numeric | Two values | Logistic regression odds ratio, with robust standard errors |

Each single-arrow error that breaks the set is then rated, comparing the two sets on the same rows:

- **Would change your conclusion:** the sign flips or the interval starts or stops including zero, with a shift of at least 0.25 standard errors.
- **Would leave no valid analysis:** no measured set of variables would work.
- **Would move the estimate:** a shift of at least 0.5 standard errors, and larger than noise by a paired test.
- **Would barely matter here:** anything smaller.

Separately, each independence your graph implies among measured variables is tested on the data, with a generalised covariance measure on
a flexible basis and Holm's correction. Files over 20,000 rows are sampled for these tests. A conflict that no arrow would act on is listed
apart, because it does not affect this result.

How strong something unmeasured would have to be depends on the estimate:

| Estimate | Robustness value and benchmarks | E-value |
| --- | --- | --- |
| AIPW | The bound of Chernozhukov et al. (2022), on the estimate shown | On the risk ratio for a two-value outcome. For a numeric one, an approximate conversion from the standardized difference |
| Linear regression | Cinelli and Hazlett (2020), with their classical standard error | Per one SD of treatment, from the standardized difference |
| Logistic regression | Cinelli and Hazlett (2020) on a linear probability model with the same variables, because the bound does not apply to an odds ratio. The page says so | Per one SD of treatment, reading the odds ratio as a risk ratio if the outcome is under 15%, and its square root otherwise |

## Project structure

```text
apps/frontend/
  public/            Demo CSVs and sample project
  src/
    engine/          Analysis engine
      adjustment.ts  Adjustment sets
      audit.ts       Which assumptions the result depends on
      effect.ts      Effect estimates
      sensitivity.ts How strong something unmeasured would have to be
      reproduce.ts   The script that recomputes the whole analysis
      stats/         Regression and independence tests
      worker.ts      Runs the engine off the main thread, and drops a run a newer one replaces
    components/      Start screen, the canvas, and one panel for each step
    lib/             Edge-list parser, export, examples, layout
    store/           Zustand state
packages/shared/     TypeScript types for the analysis request and result
tools/verification/  Checks the engine against independent reference implementations
tools/research/      The prototypes and findings behind the assumptions check
```

## How results are checked

`npm test` runs the engine against reference results checked into the repository, which share no code with it:

- Adjustment sets, d-separation, variable roles, path counts and single-arrow errors, against brute-force enumeration on networkx
- Regression, propensity overlap, balance, and AIPW estimates, against statsmodels and pandas
- The robustness value and its benchmarks against DoubleML, given the same fitted models, and the R package sensemakr; E-values against the
  R package EValue

Three further checks need Python. Install what they use, then run them:

```bash
python3 -m pip install -r tools/verification/requirements.txt causaldata dowhy
```

Run every generated script on data with a known effect, including messy files, and confirm each script reproduces the app's number. This
also runs the script for the whole analysis on every scenario, and checks that it notices a changed data file:

```bash
npm run verify:code
```

Run the real engine on LaLonde's job-training data, where a randomized experiment gives the answer: +$1,794, against a naive -$8,498.
Omitting `black` or `re75` from an analyst's graph is what moves the estimate, the data flags both, and correcting them cuts the distance
from the benchmark from $1,570 and $1,250 to $523:

```bash
npm run verify:lalonde
```

Measure what the panel claims across simulated studies, about 4 minutes. The current results are below:

```bash
npm run verify:calibration
```

| 200 simulated graphs per row | False alarm, correct graph | Harmful missing arrow detected | Median error, before and after the fix |
| --- | --- | --- | --- |
| Strong effects, n=2000 | 6.5% | 100% | 0.118 to 0.015 |
| Medium effects, n=500 | 4.0% | 69% | 0.034 to 0.029 |
| Weak effects, n=200 | 6.0% | 7.6% | 0.052 to 0.042 |
| Nonlinear, strong, n=2000 | 9.5% | 83% | not measured |
| Nonlinear, medium, n=500 | 4.5% | 50% | not measured |

95% confidence intervals contained the truth 93% to 97.5% of the time across the estimators, and a shift between two valid sets was called
larger than noise 6% of the time, against a target of 5%.

It also puts a known confounder in simulated files. With no true effect, the confounder was at least as strong as the robustness value in
94% to 100% of files, which is the claim the page makes. A confounder built to be as strong as a measured variable had a median true bias of
0.98 to 1.00 times that variable's figure, from 0.66 to 1.40 between the 5th and 95th percentiles, which is why the page says "about".

To rebuild the reference results or the demo file, run `npm run verify:golden` or `python3 tools/verification/generate_demo_data.py`.
`npm run verify:sensitivity` rebuilds the sensitivity references, and needs DoubleML and the R packages sensemakr and EValue.

One reference is corrected rather than copied. DoubleML 0.11.4 gives the standard error of its bound the wrong sign relative to the estimate's
influence function, which changes the robustness value for the interval. The generator reproduces DoubleML's number with that sign, to show
it is the only difference, and checks the corrected standard error against a bootstrap, which it matches and DoubleML's does not.
The `Verify` GitHub Actions workflow runs these checks on every pull request.

## How the engine stays fast

Validity checks use d-separation in linear time, so they never depend on how many paths a graph has. Minimal adjustment sets are listed with
polynomial delay per set (Takata, 2010; van der Zander, Liśkiewicz & Textor, 2019). Listings for display are capped: when a graph has too many
paths or valid sets to show, or an audit reaches its time limit, the app says so.

The graph result appears first, and estimates fill in as they finish, on a worker that drops a run as soon as a newer one replaces it. Fits and
tests are cached per file, so editing the graph only computes what changed.

## Deployment

The app is a static site. The GitHub Pages workflow builds it on every push to `main`. Set the repository variable `VITE_BASE_PATH` if it is
not served from `/causal-graph-workbench/`.
