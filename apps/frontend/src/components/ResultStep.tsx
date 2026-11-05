import type { AnalysisResult, EffectEstimate, GraphSpec } from "@causal-graph-workbench/shared";
import { useState } from "react";

import { effectInterval, effectValue, joinNames, shortList } from "../lib/format";
import { useWorkbenchStore, type PanelTab } from "../store/useWorkbenchStore";
import { AssumptionsTab } from "./AssumptionsTab";
import { CodeTab } from "./CodeTab";
import { DetailsTab } from "./DetailsTab";
import { SetsTab } from "./SetsTab";
import { Disclosure, IssueList } from "./ui";

const MAX_NAMES_IN_TITLE = 6;

const TABS: { id: PanelTab; label: string }[] = [
  { id: "assumptions", label: "What it rests on" },
  { id: "sets", label: "Other choices" },
  { id: "code", label: "Write-up" },
  { id: "details", label: "Details" },
];

export function ResultStep({ analysis, graph }: { analysis: AnalysisResult | null; graph: GraphSpec }) {
  const activeTab = useWorkbenchStore((state) => state.activeTab);
  const setActiveTab = useWorkbenchStore((state) => state.setActiveTab);
  const [snippetId, setSnippetId] = useState<string | null>(null);

  const showSnippet = (id: string) => {
    setSnippetId(id);
    setActiveTab("code");
  };
  const canShowTabs = Boolean(analysis?.validation.canAnalyze);

  return (
    <>
      <ResultHeader analysis={analysis} onShowSnippet={showSnippet} />

      {canShowTabs ? (
        <>
          <div className="tabs" role="tablist" aria-label="About this result">
            {TABS.map((tab) => (
              <button key={tab.id} type="button" role="tab" className="tab" aria-selected={tab.id === activeTab} onClick={() => setActiveTab(tab.id)}>
                {tab.label}
                {tab.id === "assumptions" && analysis?.audit?.assumptions.length ? <span className="tab__count">{analysis.audit.assumptions.length}</span> : null}
              </button>
            ))}
          </div>

          <div className="panel__body" role="tabpanel">
            {activeTab === "assumptions" ? <AssumptionsTab analysis={analysis} graph={graph} /> : null}
            {activeTab === "sets" ? <SetsTab analysis={analysis} /> : null}
            {activeTab === "code" ? <CodeTab analysis={analysis} snippetId={snippetId} onSelectSnippet={setSnippetId} /> : null}
            {activeTab === "details" ? <DetailsTab analysis={analysis} /> : null}
          </div>
        </>
      ) : null}
    </>
  );
}

/** The answer, always in view whichever tab of evidence is open. */
function ResultHeader({ analysis, onShowSnippet }: { analysis: AnalysisResult | null; onShowSnippet: (id: string) => void }) {
  const setStep = useWorkbenchStore((state) => state.setStep);
  const setDataContext = useWorkbenchStore((state) => state.setDataContext);
  const dataContext = useWorkbenchStore((state) => state.dataContext);

  if (!analysis) {
    return (
      <header className="panel__head">
        <h1>Your result</h1>
        <p>Working it out…</p>
      </header>
    );
  }

  if (!analysis.validation.canAnalyze) {
    return (
      <header className="panel__head">
        <h1>Your graph needs attention first</h1>
        <IssueList issues={analysis.validation.issues.filter((issue) => issue.severity === "error")} />
        <div className="button-row">
          <button type="button" className="btn btn--primary" onClick={() => setStep("graph")}>
            Back to the graph
          </button>
        </div>
      </header>
    );
  }

  const set = analysis.baselineSet;
  const diagnostics = analysis.dataDiagnostics;
  // Variables the file cannot supply count as unmeasured, so say so when that is what decided the answer.
  const unmatched = diagnostics ? diagnostics.variableBindings.filter((binding) => !binding.matched && binding.note !== "Marked as not measured.").map((binding) => binding.nodeId) : [];
  const nothingMatched = Boolean(diagnostics) && !diagnostics!.variableBindings.some((binding) => binding.matched);
  if (nothingMatched) {
    return (
      <header className="panel__head">
        <h1>This file does not match your graph</h1>
        <p>None of its columns could be matched to your variables, so nothing can be estimated from it.</p>
        <div className="button-row">
          <button type="button" className="btn btn--primary" onClick={() => setStep("data")}>
            Check the file and its columns
          </button>
        </div>
      </header>
    );
  }
  const measuredForbidden = analysis.forbiddenVariables.map((item) => item.nodeId);
  const isOwnChoice = Boolean(dataContext.chosenSet && set && set.join() === [...dataContext.chosenSet].sort().join() && set.join() !== analysis.recommendedAdjustmentSet.join());
  const estimate = analysis.effect?.estimate ?? null;
  const warnings = analysis.validation.issues.filter((issue) => issue.severity === "warning");

  return (
    <header className="panel__head panel__head--result">
      <h1>
        {set === null
          ? "No measured variables can remove the bias"
          : set.length > MAX_NAMES_IN_TITLE
            ? `Adjust for these ${set.length} variables`
            : set.length
              ? `Adjust for ${joinNames(set)}`
              : "No adjustment needed"}
      </h1>
      {set && set.length > MAX_NAMES_IN_TITLE ? <p className="hint">{set.join(", ")}</p> : null}
      <p>
        {set === null && unmatched.length ? (
          <>
            {joinNames(unmatched)} {unmatched.length === 1 ? "has" : "have"} no column in this file, so {unmatched.length === 1 ? "it counts" : "they count"} as unmeasured.{" "}
            <button type="button" className="link-button" onClick={() => setStep("data")}>
              Match columns
            </button>{" "}
          </>
        ) : null}
        {set === null
          ? "With the variables you have, every choice leaves a backdoor path open, so the effect cannot be estimated by adjusting."
          : set.length
            ? measuredForbidden.length
              ? `Do not adjust for ${shortList(measuredForbidden)}.`
              : "If your graph is right, this set blocks every backdoor path."
            : "This graph has no open backdoor path, so the effect can be estimated without adjusting for any variable."}
        {isOwnChoice ? (
          <>
            {" "}
            This is the set you chose.{" "}
            <button type="button" className="link-button" onClick={() => setDataContext({ chosenSet: null })}>
              Use the recommended one
            </button>
          </>
        ) : null}
      </p>

      {set !== null ? <EffectLine analysis={analysis} estimate={estimate} onShowSnippet={onShowSnippet} /> : null}
      {warnings.length ? <IssueList issues={warnings} /> : null}
    </header>
  );
}

function EffectLine({
  analysis,
  estimate,
  onShowSnippet,
}: {
  analysis: AnalysisResult;
  estimate: EffectEstimate | null;
  onShowSnippet: (id: string) => void;
}) {
  const setStep = useWorkbenchStore((state) => state.setStep);
  const setDataContext = useWorkbenchStore((state) => state.setDataContext);
  const { effect } = analysis;

  if (!analysis.dataDiagnostics?.hasData) {
    return (
      <p className="effect__empty">
        <button type="button" className="link-button" onClick={() => setStep("data")}>
          Add your data
        </button>{" "}
        to estimate the effect.
      </p>
    );
  }
  if (!estimate) {
    return (
      <p className="effect__empty">
        {effect?.unavailableReason ?? "Estimating the effect…"}{" "}
        {effect?.unavailableReason && analysis.dataDiagnostics?.warnings.length ? (
          <button type="button" className="link-button" onClick={() => setStep("data")}>
            See what the file check found
          </button>
        ) : null}
      </p>
    );
  }

  const snippet = analysis.codeSnippets.find((item) => item.id === estimate.snippetId);
  return (
    <div className="effect">
      <div className="effect__figure">
        <strong>{effectValue(estimate)}</strong>
        <span>95% CI {effectInterval(estimate)}</span>
        {estimate.method === "aipw" ? (
          <div className="segmented" role="group" aria-label="Effect among whom">
            <button type="button" aria-pressed={estimate.estimand === "ate"} onClick={() => setDataContext({ estimand: "ate" })}>
              Everyone (ATE)
            </button>
            <button type="button" aria-pressed={estimate.estimand === "att"} onClick={() => setDataContext({ estimand: "att" })}>
              Those treated (ATT)
            </button>
          </div>
        ) : null}
      </div>
      <p className="effect__note">
        {effect?.status === "running" ? "Still estimating. " : ""}
        {estimate.description} {estimate.rowsUsed.toLocaleString("en-US")} rows
        {estimate.rowsDropped ? `, ${estimate.rowsDropped.toLocaleString("en-US")} dropped for missing values` : ""}.{" "}
        {snippet ? (
          <button type="button" className="link-button" onClick={() => onShowSnippet(snippet.id)}>
            Reproduce it with {snippet.label}
          </button>
        ) : null}
      </p>
      {estimate.warnings.length ? (
        <Disclosure title="Cautions about this estimate" count={estimate.warnings.length} defaultOpen>
          <ul className="plain-list">
            {estimate.warnings.map((warning) => (
              <li key={warning}>{warning}</li>
            ))}
          </ul>
        </Disclosure>
      ) : null}
    </div>
  );
}
