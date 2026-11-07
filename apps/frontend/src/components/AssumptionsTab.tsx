import type {
  AnalysisResult,
  AssumptionSeverity,
  EValueSummary,
  GraphSpec,
  ImpliedIndependenceTest,
  LoadBearingAssumption,
  RobustnessSummary,
} from "@causal-graph-workbench/shared";

import { arrowLabel, repairSummary, shiftSummary } from "../lib/format";
import { useWorkbenchStore } from "../store/useWorkbenchStore";
import { COMPARE_LABEL, COMPARE_UNMEASURED_LABEL, useCompareWith } from "./CompareTab";
import { SensitivityChart } from "./SensitivityChart";
import { Disclosure } from "./ui";

const SECTIONS: { severity: AssumptionSeverity; title: string; subtitle: string; open: boolean }[] = [
  {
    severity: "changes_conclusion",
    title: "Would change your conclusion",
    subtitle: "If one of these is wrong, the direction of the effect or whether it is distinguishable from zero changes.",
    open: true,
  },
  {
    severity: "no_valid_set",
    title: "Would leave no valid analysis",
    subtitle: "If one of these is wrong, adjusting for measured variables cannot give the effect at all.",
    open: true,
  },
  {
    severity: "moves_estimate",
    title: "Would move the estimate",
    subtitle: "The conclusion holds, but the size of the effect changes by more than noise.",
    open: true,
  },
  {
    severity: "small_shift",
    title: "Would barely matter here",
    subtitle: "The set would no longer be valid in theory, but in this data the estimate hardly moves.",
    open: false,
  },
  {
    severity: "not_estimated",
    title: "Your set depends on these",
    subtitle: "Add data, with columns for these variables, to see how much each one would move the estimate.",
    open: true,
  },
];

export function AssumptionsTab({ analysis, graph }: { analysis: AnalysisResult | null; graph: GraphSpec }) {
  const setActiveTab = useWorkbenchStore((state) => state.setActiveTab);
  const setOpenStep = useWorkbenchStore((state) => state.setOpenStep);

  if (!analysis) {
    return <p className="empty">This appears as soon as the graph has been processed.</p>;
  }
  if (analysis.baselineSet === null) {
    return (
      <p className="empty">
        No valid adjustment set exists for this graph, so there is no result yet whose assumptions could be checked.{" "}
        <button
          type="button"
          className="link-button"
          onClick={() => {
            setOpenStep("paths");
            setActiveTab("steps");
          }}
        >
          See which paths stay open
        </button>
      </p>
    );
  }

  const audit = analysis.audit;
  const isChecking = audit === null || audit.status === "running";
  const assumptions = audit?.assumptions ?? [];
  const testById = new Map((audit?.tests ?? []).map((test) => [test.id, test]));
  const harmlessConflicts = (audit?.conflictsWithoutConsequence ?? []).map((id) => testById.get(id)!).filter(Boolean);
  const conflictCount = (audit?.tests ?? []).filter((test) => test.conflict).length;
  const timingIsSet = graph.nodes.some((node) => node.timing);

  return (
    <div className="stack">
      <div className="audit-summary">
        <p>
          {audit
            ? `Of ${audit.editsChecked} ways your graph could be wrong by one arrow, ${assumptions.length} would stop this set from being valid.`
            : "Checking which arrows this set depends on…"}
          {audit?.editsRuledOutByTiming ? ` The timing you set rules out ${audit.editsRuledOutByTiming} more.` : ""}
        </p>
        {isChecking && audit ? <p className="hint">Still checking…</p> : null}
        {!audit?.editsRuledOutByTiming && !timingIsSet && assumptions.length ? (
          <p className="hint">Under Graph, say when each variable is fixed. That removes errors that would run backwards in time.</p>
        ) : null}
        {audit?.truncated ? <p className="hint">This graph is very large, so the checks stopped at their time limit. The errors most relevant to your set were checked first.</p> : null}
        {audit?.tests.length ? (
          <p className="hint">
            {audit.tests.length} independence{audit.tests.length === 1 ? "" : "s"} your graph implies {audit.tests.length === 1 ? "was" : "were"} checked against the data.{" "}
            {conflictCount
              ? `The data contradicts ${conflictCount} of them.`
              : "The data contradicts none of them, which does not show the graph is right: real arrows can be too weak to detect, especially in small samples."}
            {audit.testSampleSize ? ` Tests used a random sample of ${audit.testSampleSize.toLocaleString("en-US")} rows.` : ""}
          </p>
        ) : null}
      </div>

      {SECTIONS.map(({ severity, title, subtitle, open }) => {
        const items = assumptions.filter((item) => item.severity === severity);
        if (!items.length) {
          return null;
        }
        return (
          <Disclosure key={severity} title={title} count={items.length} defaultOpen={open}>
            <p className="hint">{subtitle}</p>
            <div className="item-list">
              {items.map((item) => (
                <AssumptionItem key={item.id} assumption={item} />
              ))}
            </div>
          </Disclosure>
        );
      })}

      {!isChecking && !assumptions.length ? <p>No single-arrow error would invalidate this set. Errors involving more than one arrow are not checked.</p> : null}

      <UnmeasuredSection analysis={analysis} graph={graph} />

      {harmlessConflicts.length ? (
        <Disclosure title="Data conflicts that do not affect this result" count={harmlessConflicts.length}>
          <p className="hint">
            The data disagrees with these parts of your graph, but no arrow between them would change which variables to adjust for. They can still be worth a look, and they can also be harmless, such as
            two indicators for the same category.
          </p>
          <div className="stack-tight">
            {harmlessConflicts.map((test) => (
              <TestRow key={test.id} test={test} />
            ))}
          </div>
        </Disclosure>
      ) : null}

      <Disclosure title="What every analysis assumes" count={analysis.assumptions.length}>
        <dl className="definition-list">
          {[...analysis.assumptions]
            .sort((left, right) => Number(right.category === "identification") - Number(left.category === "identification"))
            .map((item) => (
              <div key={item.id}>
                <dt>
                  {item.title}
                  <span className="pill">{item.level}</span>
                </dt>
                <dd>{item.description}</dd>
              </div>
            ))}
        </dl>
      </Disclosure>
    </div>
  );
}

function share(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

/** What the arrow checks cannot see, and how strong it would have to be to matter. */
function UnmeasuredSection({ analysis, graph }: { analysis: AnalysisResult; graph: GraphSpec }) {
  const setStep = useWorkbenchStore((state) => state.setStep);
  const { sensitivity, effect } = analysis;
  const treatment = graph.treatmentId;
  const outcome = graph.outcomeId;
  const robustness = sensitivity?.robustness ?? null;
  const evalue = sensitivity?.evalue ?? null;
  const hasEstimate = Boolean(effect?.estimate);

  return (
    <section className="group unmeasured">
      <h2>What if something unmeasured affects both?</h2>
      <p>
        <strong>What these checks cannot see.</strong> Something unmeasured that affects both {treatment} and {outcome} leaves no trace in any test here, and neither does an error involving several
        arrows at once. This estimate holds only if neither is present, so ask what could be missing from your graph.
      </p>

      {robustness ? (
        <RobustnessReading robustness={robustness} treatment={treatment} outcome={outcome} />
      ) : !hasEstimate ? (
        <p className="hint">
          <button type="button" className="link-button" onClick={() => setStep("data")}>
            Add your data
          </button>{" "}
          to see how strong it would have to be.
        </p>
      ) : sensitivity?.status === "running" ? (
        <p className="hint">Working out how strong it would have to be…</p>
      ) : null}

      {evalue ? (
        <Disclosure title={`E-value: ${evalue.point.toFixed(2)}`}>
          <EValueReading evalue={evalue} treatment={treatment} />
        </Disclosure>
      ) : null}
    </section>
  );
}

function RobustnessReading({ robustness, treatment, outcome }: { robustness: RobustnessSummary; treatment: string | null; outcome: string | null }) {
  const strongest = robustness.benchmarks[0] ?? null;
  return (
    <>
      <p className="item__lead">
        To explain away the effect, it would have to explain {share(robustness.value)} of what your adjustment leaves unexplained in both {treatment} and {outcome}.{" "}
        {robustness.valueForInterval > 0 ? `For its interval to include no effect, ${share(robustness.valueForInterval)}.` : "Its interval already includes no effect."}
      </p>
      <SensitivityChart robustness={robustness} />
      {strongest ? (
        <>
          <p>
            {strongest.shareOfEstimate >= 1
              ? `Something as strong as ${strongest.variable} could explain away the whole estimate.`
              : `Something as strong as ${strongest.variable}, the strongest variable you adjusted for, could account for about ${share(strongest.shareOfEstimate)} of the estimate.`}{" "}
            Whether something that strong could be missing is a judgement only you can make.
          </p>
          <Disclosure title="All the variables you adjusted for" count={robustness.benchmarks.length}>
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Something as strong as</th>
                    <th className="n">Could account for about</th>
                  </tr>
                </thead>
                <tbody>
                  {robustness.benchmarks.map((benchmark) => (
                    <tr key={benchmark.variable}>
                      <td>{benchmark.variable}</td>
                      <td className="n">{benchmark.shareOfEstimate >= 1 ? "All of the estimate" : share(benchmark.shareOfEstimate)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="hint">This is a guide to size rather than a limit: in simulation, the true bias of a variable that strong was usually within about 40% of this figure.</p>
            {!robustness.benchmarksComplete ? <p className="hint">This file is very large, so the comparison stopped at its time limit and some variables are missing.</p> : null}
          </Disclosure>
        </>
      ) : null}
      {robustness.basis === "linear_probability" ? <p className="hint">Measured on a linear probability model with the same variables, because this bound does not apply to an odds ratio directly.</p> : null}
    </>
  );
}

const EVALUE_BASIS: Record<EValueSummary["basis"], string | null> = {
  risk_ratio: null,
  standardized_difference: "This converts a standardized difference to an approximate risk ratio, so treat it as a rough figure.",
  odds_ratio_rare: "The outcome is rare here, so the odds ratio is read as a risk ratio.",
  odds_ratio_common: "The outcome is common here, so the risk ratio is approximated by the square root of the odds ratio.",
};

function EValueReading({ evalue, treatment }: { evalue: EValueSummary; treatment: string | null }) {
  return (
    <>
      <p>
        Something unmeasured would need a risk ratio of at least {evalue.point.toFixed(2)} with both {treatment} and the outcome to explain away the estimate, beyond what your adjustment already
        accounts for. For the end of the interval nearer no effect, {evalue.interval.toFixed(2)}
        {evalue.interval === 1 ? ", because the interval already includes no effect" : ""}.
      </p>
      <p className="hint">
        {evalue.contrast === "one_sd_of_treatment" ? `For a one standard deviation increase in ${treatment}. ` : ""}
        {EVALUE_BASIS[evalue.basis]}
      </p>
    </>
  );
}

function TestRow({ test }: { test: ImpliedIndependenceTest }) {
  return (
    <p className="test-row">
      <strong>
        {test.left} and {test.right}
      </strong>{" "}
      are still related{test.given.length ? ` given ${test.given.join(", ")}` : ""} (r = {test.correlation.toFixed(3)}, adjusted p = {test.adjustedPValue < 0.001 ? "< 0.001" : test.adjustedPValue.toFixed(3)}).
    </p>
  );
}

const DATA_PILL: Record<LoadBearingAssumption["dataCheck"], { label: string; className: string } | null> = {
  conflict: { label: "Data disagrees", className: "pill pill--warning" },
  no_conflict: { label: "Data cannot rule this out", className: "pill" },
  not_testable: null,
};

function AssumptionItem({ assumption }: { assumption: LoadBearingAssumption }) {
  const setPreviewArrow = useWorkbenchStore((state) => state.setPreviewArrow);
  const compareWith = useCompareWith();
  const { edit, source, target } = assumption;
  const pill = DATA_PILL[assumption.dataCheck];
  const shift = shiftSummary(assumption);

  return (
    <article className="item" onMouseEnter={() => setPreviewArrow({ edit, source, target })} onMouseLeave={() => setPreviewArrow(null)}>
      <header>
        <h3>{arrowLabel(assumption)}</h3>
        {pill ? <span className={pill.className}>{pill.label}</span> : null}
      </header>
      {shift ? <p className="item__lead">{shift}</p> : null}
      <p>
        {assumption.statement} {assumption.consequence} {repairSummary(assumption)}
      </p>
      <p className="hint">{assumption.dataCheckNote}</p>
      <div className="button-row">
        <button
          type="button"
          className="btn"
          onClick={() => {
            setPreviewArrow(null);
            compareWith({ edit, source, target });
          }}
        >
          {COMPARE_LABEL[edit]}
        </button>
        {edit === "add" && assumption.dataCheck === "conflict" ? (
          <button
            type="button"
            className="btn btn--text"
            onClick={() => {
              setPreviewArrow(null);
              compareWith({ edit: "unmeasured", source, target });
            }}
          >
            {COMPARE_UNMEASURED_LABEL}
          </button>
        ) : null}
      </div>
    </article>
  );
}
