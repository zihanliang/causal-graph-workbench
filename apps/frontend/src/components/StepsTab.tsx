import type { AnalysisResult, GraphSpec } from "@causal-graph-workbench/shared";
import { useEffect, type PropsWithChildren } from "react";

import { effectValue, formatNumber, joinNames, shortList } from "../lib/format";
import { useWorkbenchStore, type ResultStepId } from "../store/useWorkbenchStore";
import { OverlapSummary, BalanceTable } from "./DataChecks";
import { EstimatorDetails } from "./EstimatorDetails";
import { PathList } from "./PathList";
import { SameDataComparison, SetChoices } from "./SetChoices";
import { Disclosure, Icon, IssueList } from "./ui";

function count(value: number, one: string, many: string): string {
  return `${value.toLocaleString("en-US")} ${value === 1 ? one : many}`;
}

function questionSummary(graph: GraphSpec, analysis: AnalysisResult): string {
  return `Effect of ${graph.treatmentId} on ${graph.outcomeId}. ${count(analysis.graphStats.nodeCount, "variable", "variables")}, ${count(analysis.graphStats.edgeCount, "arrow", "arrows")}.`;
}

function pathsSummary(analysis: AnalysisResult): string {
  const { limits, graphStats, paths } = analysis;
  if (!paths.length) {
    return "No path joins treatment and outcome.";
  }
  const atLeast = limits.pathsTruncated ? "At least " : "";
  const carrying = graphStats.directedPathCount;
  const open = graphStats.openBackdoorPathCount;
  return `${atLeast}${count(paths.length, "path", "paths")}. ${carrying === 0 ? "None carries" : carrying === 1 ? "1 carries" : `${carrying} carry`} the effect, and ${
    open === 0 ? "no backdoor path is" : open === 1 ? "1 backdoor path is" : `${limits.pathsTruncated ? "at least " : ""}${open} backdoor paths are`
  } open before adjusting.`;
}

function setSummary(analysis: AnalysisResult): string {
  const set = analysis.baselineSet;
  const open = analysis.graphStats.openBackdoorPathCount;
  if (set === null) {
    return "No measured variables close every backdoor path.";
  }
  if (!set.length) {
    return "Nothing to adjust for, because no backdoor path is open.";
  }
  const leaveOut = analysis.forbiddenVariables.map((item) => item.nodeId);
  const closes = open === 0 ? "No backdoor path needed closing, but this is the set you chose." : analysis.limits.pathsTruncated ? `${set.length === 1 ? "closes" : "close"} every backdoor path.` : `${set.length === 1 ? "closes" : "close"} ${open === 1 ? "it" : open === 2 ? "both" : `all ${open}`}.`;
  return `${shortList(set)} ${closes}${leaveOut.length ? ` Leave out ${shortList(leaveOut)}.` : ""}`;
}

function dataSummary(analysis: AnalysisResult): string {
  const diagnostics = analysis.dataDiagnostics;
  if (!diagnostics?.hasData) {
    return "No file yet, so nothing has been estimated.";
  }
  const estimate = analysis.effect?.estimate;
  const parts = [estimate ? `${estimate.rowsUsed.toLocaleString("en-US")} of ${count(diagnostics.rowCount, "row", "rows")}.` : `${count(diagnostics.rowCount, "row", "rows")}.`];
  const balance = diagnostics.treatmentBalance;
  if (balance?.available && balance.treatedCount != null && balance.controlCount != null) {
    parts.push(`${balance.treatedCount.toLocaleString("en-US")} treated, ${balance.controlCount.toLocaleString("en-US")} control.`);
    const measured = balance.metrics.filter((metric) => metric.standardizedDifference != null);
    if (measured.length) {
      const widest = measured.reduce((best, metric) => (Math.abs(metric.standardizedDifference!) > Math.abs(best.standardizedDifference!) ? metric : best));
      parts.push(`${widest.columnName} differs ${measured.length > 1 ? "most " : ""}between the groups (${Math.abs(widest.standardizedDifference!).toFixed(3)} SD).`);
    }
  }
  return parts.join(" ");
}

function estimateSummary(graph: GraphSpec, analysis: AnalysisResult): string {
  if (analysis.baselineSet === null) {
    return "Not estimated, because no valid set exists.";
  }
  if (!analysis.dataDiagnostics?.hasData) {
    return "Add your data to estimate the effect.";
  }
  const estimate = analysis.effect?.estimate;
  if (!estimate) {
    return analysis.effect?.unavailableReason ?? "Estimating the effect…";
  }
  const value = effectValue(estimate);
  const crude = analysis.effect?.comparisons.find((row) => row.kind === "none")?.estimate;
  const unadjusted = crude ? ` With no adjustment it was ${effectValue(crude)}.` : "";
  const means = estimate.potentialMeans;
  if (means) {
    const treated = formatNumber(means.treated);
    const control = formatNumber(means.control);
    return estimate.estimand === "att"
      ? `Among those who took ${graph.treatmentId}, ${treated}. Had they not, ${control}. The difference is ${value}.${unadjusted}`
      : `If everyone took ${graph.treatmentId}, ${treated}. If no one did, ${control}. The difference is ${value}.${unadjusted}`;
  }
  return `${value}. ${estimate.description}${unadjusted}`;
}

function checkSummary(analysis: AnalysisResult): string {
  if (analysis.baselineSet === null) {
    return "There is no result to check yet.";
  }
  const { audit } = analysis;
  if (!audit || audit.status === "running") {
    return "Still checking…";
  }
  const arrows = `${audit.assumptions.length} of ${count(audit.editsChecked, "one-arrow error", "one-arrow errors")} would matter.`;
  if (!audit.tests.length) {
    return arrows;
  }
  return `${arrows} The data contradicts ${audit.tests.filter((test) => test.conflict).length} of ${count(audit.tests.length, "implied independence", "implied independences")}.`;
}

function WorkStep({ id, number, title, summary, children }: PropsWithChildren<{ id: ResultStepId; number: number; title: string; summary: string }>) {
  const openStep = useWorkbenchStore((state) => state.openStep);
  const setOpenStep = useWorkbenchStore((state) => state.setOpenStep);
  const setHoveredStep = useWorkbenchStore((state) => state.setHoveredStep);
  const isOpen = openStep === id;
  return (
    <li className={isOpen ? "work-step work-step--open" : "work-step"} onMouseEnter={() => setHoveredStep(id)} onMouseLeave={() => setHoveredStep(null)}>
      <button type="button" className="work-step__toggle" aria-expanded={isOpen} onClick={() => setOpenStep(isOpen ? null : id)}>
        <span className="work-step__number">{number}</span>
        <span className="work-step__text">
          <strong>{title}</strong>
          <span>{summary}</span>
        </span>
        <Icon name={isOpen ? "chevronDown" : "chevronRight"} />
      </button>
      {isOpen ? <div className="work-step__body">{children}</div> : null}
    </li>
  );
}

/** How the answer was reached, one step at a time. Each step says its result in a line, and opens for the detail. */
export function StepsTab({ analysis, graph }: { analysis: AnalysisResult | null; graph: GraphSpec }) {
  const setStep = useWorkbenchStore((state) => state.setStep);
  const setActiveTab = useWorkbenchStore((state) => state.setActiveTab);
  const setHoveredStep = useWorkbenchStore((state) => state.setHoveredStep);

  // The row under the pointer can disappear with its tab, which never reports the pointer leaving.
  useEffect(() => () => setHoveredStep(null), [setHoveredStep]);

  if (!analysis) {
    return <p className="empty">This appears as soon as the graph has been processed.</p>;
  }
  const diagnostics = analysis.dataDiagnostics;
  const balance = diagnostics?.treatmentBalance;
  const overlap = diagnostics?.overlapDiagnostics;
  const notes = analysis.validation.issues.filter((issue) => issue.severity === "info" && issue.code !== "graph_summary");
  const estimate = analysis.effect?.estimate;
  const imbalanced = balance?.metrics.filter((metric) => metric.imbalanced).length ?? 0;

  return (
    <ol className="work-steps">
      <WorkStep id="question" number={1} title="The question" summary={questionSummary(graph, analysis)}>
        <p>
          This is the total effect of {graph.treatmentId} on {graph.outcomeId}: everything it changes, directly and through other variables, if the graph you drew is right.
        </p>
        <IssueList issues={notes} />
        <div>
          <button type="button" className="link-button" onClick={() => setStep("graph")}>
            Change the graph
          </button>
        </div>
      </WorkStep>

      <WorkStep id="paths" number={2} title="Paths" summary={pathsSummary(analysis)}>
        <p className="hint">A backdoor path starts with an arrow into {graph.treatmentId}. If it stays open, part of what it carries looks like an effect but is not one.</p>
        <PathList analysis={analysis} />
      </WorkStep>

      <WorkStep id="set" number={3} title="What to adjust for" summary={setSummary(analysis)}>
        <p className="hint">A valid set closes every backdoor path, leaves the causal paths alone, and opens nothing new.{analysis.baselineSet?.length ? ` This one is ${joinNames(analysis.baselineSet)}.` : ""}</p>
        <SetChoices analysis={analysis} />
      </WorkStep>

      <WorkStep id="data" number={4} title="The data" summary={dataSummary(analysis)}>
        {diagnostics?.hasData ? (
          <div className="stack">
            {balance ? (
              <Disclosure title="Are the groups comparable?" count={imbalanced ? `${imbalanced} imbalanced` : undefined} defaultOpen>
                <BalanceTable balance={balance} />
              </Disclosure>
            ) : null}
            {overlap ? (
              <Disclosure title="Do the groups overlap?" count={overlap.warnings.length ? `${overlap.warnings.length} warning${overlap.warnings.length === 1 ? "" : "s"}` : undefined} defaultOpen={overlap.warnings.length > 0}>
                <OverlapSummary overlap={overlap} rowCount={diagnostics.rowCount} />
              </Disclosure>
            ) : null}
          </div>
        ) : null}
        <div>
          <button type="button" className="link-button" onClick={() => setStep("data")}>
            {diagnostics?.hasData ? "Check the file and its columns" : "Add your data"}
          </button>
        </div>
      </WorkStep>

      <WorkStep id="estimate" number={5} title="The estimate" summary={estimateSummary(graph, analysis)}>
        {estimate ? <p>{estimate.description}</p> : null}
        <div className="stack">
          <EstimatorDetails analysis={analysis} graph={graph} />
          <SameDataComparison analysis={analysis} />
        </div>
      </WorkStep>

      <li className="work-step">
        <button type="button" className="work-step__toggle" onClick={() => setActiveTab("assumptions")}>
          <span className="work-step__number">6</span>
          <span className="work-step__text">
            <strong>The check</strong>
            <span>{checkSummary(analysis)}</span>
          </span>
          <Icon name="chevronRight" />
        </button>
      </li>
    </ol>
  );
}
