import type { AnalysisResult, GraphComparison, GraphVersionResult } from "@causal-graph-workbench/shared";

import { effectSummary, formatSet, joinNames } from "../lib/format";
import { MAX_GRAPH_VERSIONS, shortName, type GraphChange } from "../lib/graphVersions";
import { useWorkbenchStore } from "../store/useWorkbenchStore";
import { Icon, Notice } from "./ui";
import { UncertainArrows } from "./UncertainArrows";

/** Keeps a copy of the open graph with this change, and shows the comparison. The open graph itself is left alone. */
export function useCompareWith(): (change: GraphChange) => void {
  const addVersion = useWorkbenchStore((state) => state.addVersion);
  const setActiveTab = useWorkbenchStore((state) => state.setActiveTab);
  return (change) => {
    addVersion(change);
    setActiveTab("compare");
  };
}

export const COMPARE_LABEL: Record<"add" | "remove" | "reverse", string> = {
  add: "Compare with this arrow",
  remove: "Compare without this arrow",
  reverse: "Compare with it reversed",
};

export const COMPARE_UNMEASURED_LABEL = "Or something unmeasured behind both";

export function CompareTab({ analysis }: { analysis: AnalysisResult | null }) {
  const versionCount = useWorkbenchStore((state) => state.versions.length);
  const tryAnotherGraph = useWorkbenchStore((state) => state.tryAnotherGraph);
  const comparison = analysis?.comparison ?? null;

  if (versionCount < 2) {
    return <OneGraph analysis={analysis} />;
  }
  if (!comparison || comparison.graphs.length !== versionCount) {
    return <p className="empty">Comparing your graphs…</p>;
  }

  return (
    <div className="stack">
      <Summary comparison={comparison} analysis={analysis!} />

      {comparison.answers.map((answer) => (
        <section key={answer.graphIds.join()} className="answer">
          <header className="answer__head">
            <strong>{answer.adjustmentSet === null ? "No estimate" : answer.estimate ? effectSummary(answer.estimate) : "Not estimated"}</strong>
            <span>{answer.adjustmentSet === null ? "No measured set is valid" : answer.adjustmentSet.length ? `Adjust for ${answer.adjustmentSet.join(", ")}` : "No adjustment needed"}</span>
          </header>
          {answer.graphIds.map((id) => (
            <GraphRow key={id} graph={comparison.graphs.find((item) => item.id === id)!} comparison={comparison} analysis={analysis!} />
          ))}
        </section>
      ))}

      {comparison.graphs.some((graph) => graph.problem) ? (
        <section className="answer">
          <header className="answer__head">
            <strong>Cannot be analysed yet</strong>
          </header>
          {comparison.graphs
            .filter((graph) => graph.problem)
            .map((graph) => (
              <GraphRow key={graph.id} graph={graph} comparison={comparison} analysis={analysis!} />
            ))}
        </section>
      ) : null}

      <section className="group">
        <h2>What the data can and cannot say</h2>
        {comparison.sameClaims.map((group) => (
          <SameClaims key={group.join()} group={group} comparison={comparison} />
        ))}
        <p className="hint">
          The data can rule a graph out, but it cannot show that one is right. A graph with more arrows claims less, so it is harder to contradict. That is why these graphs are not ranked. Something
          unmeasured behind treatment and outcome leaves no trace in any of these checks.
        </p>
      </section>

      {versionCount < MAX_GRAPH_VERSIONS ? (
        <div>
          <button type="button" className="btn" onClick={tryAnotherGraph}>
            Try another graph
          </button>
        </div>
      ) : (
        <Notice>You can compare up to {MAX_GRAPH_VERSIONS} graphs. Remove one to try another.</Notice>
      )}

      <UncertainArrows analysis={analysis} />
    </div>
  );
}

function names(ids: string[], comparison: GraphComparison): string {
  return joinNames(ids.map((id) => shortName(comparison.graphs.find((graph) => graph.id === id)?.name ?? id)));
}

/** The one thing to take away from the comparison. */
function Summary({ comparison, analysis }: { comparison: GraphComparison; analysis: AnalysisResult }) {
  const setDataContext = useWorkbenchStore((state) => state.setDataContext);
  const { answers, sharedSet, graphs, shownId } = comparison;
  const usable = graphs.filter((graph) => !graph.problem).length;

  if (answers.length === 1 && usable >= 2) {
    const [answer] = answers;
    return (
      <div className="callout">
        <strong>{usable === graphs.length ? `All ${usable} graphs give the same answer` : `The ${usable} graphs that can be analysed give the same answer`}</strong>
        <p>{answer.adjustmentSet === null ? "None of them leaves a valid set of measured variables." : `They all lead to adjusting for ${formatSet(answer.adjustmentSet)}, so choosing between them does not change the result.`}</p>
      </div>
    );
  }
  if (sharedSet) {
    const isShown = shownId !== null && sharedSet.validIn.includes(shownId);
    const isCurrent = analysis.baselineSet?.join() === sharedSet.variables.join();
    return (
      <div className="callout">
        <strong>
          {sharedSet.notValidIn.length
            ? `One set is valid under ${sharedSet.validIn.length} of your ${usable} graphs (${names(sharedSet.validIn, comparison)})`
            : `One set is valid under all ${sharedSet.validIn.length} graphs`}
        </strong>
        <p>
          {formatSet(sharedSet.variables)}
          {sharedSet.estimate ? ` gives ${effectSummary(sharedSet.estimate)}` : ""}. You do not have to choose between {sharedSet.notValidIn.length ? "those graphs" : "them"} to use it, but it holds only if one of them is right.
          {sharedSet.notValidIn.length ? ` It is not valid under ${names(sharedSet.notValidIn, comparison)}.` : ""}
        </p>
        {isShown && !isCurrent ? (
          <div>
            <button type="button" className="btn" onClick={() => setDataContext({ chosenSet: sharedSet.variables })}>
              Use this set
            </button>
          </div>
        ) : null}
      </div>
    );
  }
  return (
    <div className="callout">
      <strong>Your {usable} graphs give {answers.length} different answers</strong>
      <p>No set was found that is valid across those answers, so the result depends on which graph you believe.</p>
    </div>
  );
}

function checkPill(graph: GraphVersionResult, comparison: GraphComparison, analysis: AnalysisResult) {
  if (graph.problem) {
    return null;
  }
  if (graph.checks === null) {
    const label = !analysis.dataDiagnostics?.hasData ? "No data to check against" : comparison.status === "running" && !graph.unavailableReason ? "Checking…" : "Not checked";
    return <span className="graph-row__check">{label}</span>;
  }
  if (!graph.checks.length) {
    return <span className="graph-row__check">{graph.checksTruncated ? "Not checked in time" : "Claims nothing to test"}</span>;
  }
  const contradicted = graph.checks.filter((check) => check.conflict).length;
  const label = `${contradicted} of ${graph.checks.length}${graph.checksTruncated ? " checked so far" : ""} contradicted`;
  return contradicted ? <span className="pill pill--warning">{label}</span> : <span className="graph-row__check">{label}</span>;
}

function GraphRow({ graph, comparison, analysis }: { graph: GraphVersionResult; comparison: GraphComparison; analysis: AnalysisResult }) {
  const selectVersion = useWorkbenchStore((state) => state.selectVersion);
  const removeVersion = useWorkbenchStore((state) => state.removeVersion);
  const isShown = comparison.shownId === graph.id;
  const contradicted = graph.checks?.filter((check) => check.conflict) ?? [];
  const named = contradicted.slice(0, 2);

  return (
    <article className="graph-row">
      <div className="graph-row__main">
        <div className="graph-row__who">
          <strong>{graph.name}</strong>
          <span>{graph.changeFromFirst ?? "The first graph"}</span>
        </div>
        <div className="graph-row__what">
          {checkPill(graph, comparison, analysis)}
          {graph.timingConflict ? <span className="pill pill--warning">Against your timing</span> : null}
          {isShown ? (
            <span className="pill pill--ink">Showing</span>
          ) : (
            <button type="button" className="btn btn--text" aria-label={`Show ${graph.name}`} onClick={() => selectVersion(graph.id)}>
              Show
            </button>
          )}
          <button type="button" className="icon-button" aria-label={`Remove ${graph.name}`} onClick={() => removeVersion(graph.id)}>
            <Icon name="close" />
          </button>
        </div>
      </div>
      {graph.problem ? <p className="hint">{graph.problem}</p> : null}
      {graph.timingConflict ? <p className="hint">{graph.timingConflict}</p> : null}
      {named.map((check) => (
        <p key={check.id} className="hint">
          {check.left} and {check.right} are still related{check.given.length ? ` given ${check.given.join(", ")}` : ""}.
        </p>
      ))}
      {contradicted.length > named.length ? <p className="hint">And {contradicted.length - named.length} more.</p> : null}
      {graph.checksTruncated ? <p className="hint">There are too many checks to finish in time for a file this size, so some were not run.</p> : null}
    </article>
  );
}

function SameClaims({ group, comparison }: { group: string[]; comparison: GraphComparison }) {
  const answerOf = (id: string) => comparison.answers.findIndex((answer) => answer.graphIds.includes(id));
  const differ = new Set(group.map(answerOf)).size > 1;
  return (
    <p>
      <strong>{names(group, comparison)}</strong> imply the same independences, so the checks here cannot separate them.
      {differ ? " Their answers differ, so only what you know about the study can decide between them." : ""}
    </p>
  );
}

/** Before there is anything to compare: what this is for, and where to start. */
function OneGraph({ analysis }: { analysis: AnalysisResult | null }) {
  const tryAnotherGraph = useWorkbenchStore((state) => state.tryAnotherGraph);
  const compareWith = useCompareWith();
  const suggestions = (analysis?.audit?.assumptions ?? []).filter((item) => item.edit === "add" && item.dataCheck === "conflict").slice(0, 3);

  return (
    <div className="stack">
      <section className="group">
        <h2>Not sure your graph is right?</h2>
        <p>Keep it, and try another. Each graph gets its own adjustment set, estimate and data check, on the same file, so you can see whether the difference between them changes your answer.</p>
        <div>
          <button type="button" className="btn" onClick={tryAnotherGraph}>
            Try another graph
          </button>
        </div>
      </section>
      <UncertainArrows analysis={analysis} />
      {suggestions.length ? (
        <section className="group">
          <h2>Where the data disagrees with this graph</h2>
          <p className="hint">Either an arrow is missing, or something unmeasured affects both variables. The data cannot say which, so you can compare both.</p>
          <div className="item-list">
            {suggestions.map((item) => (
              <article key={item.id} className="item">
                <h3>
                  {item.source} → {item.target}
                </h3>
                <div className="button-row">
                  <button type="button" className="btn" onClick={() => compareWith({ edit: "add", source: item.source, target: item.target })}>
                    {COMPARE_LABEL.add}
                  </button>
                  <button type="button" className="btn btn--text" onClick={() => compareWith({ edit: "unmeasured", source: item.source, target: item.target })}>
                    {COMPARE_UNMEASURED_LABEL}
                  </button>
                </div>
              </article>
            ))}
          </div>
        </section>
      ) : null}
    </div>
  );
}
