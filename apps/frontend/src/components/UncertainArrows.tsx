import type { AnalysisResult, ScanAnswer, UncertaintyScan } from "@causal-graph-workbench/shared";
import { useState } from "react";

import { effectSummary, formatSet, joinNames } from "../lib/format";
import { MAX_GRAPH_VERSIONS, MAX_UNCERTAIN_PAIRS, samePair } from "../lib/graphVersions";
import { useWorkbenchStore } from "../store/useWorkbenchStore";
import { Icon } from "./ui";

/** Enough to see the range without the list taking over. The closest to the graph on show come first. */
const ANSWERS_SHOWN = 6;

/** Marks pairs of variables as not settled, and shows what every combination of them leads to. */
export function UncertainArrows({ analysis }: { analysis: AnalysisResult | null }) {
  const graph = useWorkbenchStore((state) => state.graph);
  const pairs = useWorkbenchStore((state) => state.uncertainPairs);
  const addUncertainPair = useWorkbenchStore((state) => state.addUncertainPair);
  const removeUncertainPair = useWorkbenchStore((state) => state.removeUncertainPair);
  const [first, setFirst] = useState("");
  const [second, setSecond] = useState("");

  const isQuestion = samePair({ first, second }, { first: graph.treatmentId ?? "", second: graph.outcomeId ?? "" });
  const isListed = pairs.some((pair) => samePair(pair, { first, second }));
  const canAdd = Boolean(first && second) && first !== second && !isQuestion && !isListed && pairs.length < MAX_UNCERTAIN_PAIRS;
  const shownPairs = pairs.filter((pair) => graph.nodes.some((node) => node.id === pair.first) && graph.nodes.some((node) => node.id === pair.second));
  const scan = analysis?.scan ?? null;

  return (
    <section className="group">
      <h2>Not sure about particular arrows?</h2>
      <p className="hint">
        Mark up to {MAX_UNCERTAIN_PAIRS} pairs of variables. Every combination is tried on the graph on show: an arrow one way, the other way, or none. The timing you set rules out arrows that would run backwards.
      </p>

      {shownPairs.length ? (
        <ul className="unsure-list" aria-label="Pairs marked as not sure">
          {shownPairs.map((pair) => (
            <li key={`${pair.first}|${pair.second}`}>
              <span>
                {pair.first} and {pair.second}
              </span>
              <button type="button" className="icon-button" aria-label={`Stop marking ${pair.first} and ${pair.second} as not sure`} onClick={() => removeUncertainPair(pair)}>
                <Icon name="close" />
              </button>
            </li>
          ))}
        </ul>
      ) : null}

      {pairs.length < MAX_UNCERTAIN_PAIRS ? (
        <div className="connect">
          <select aria-label="Not sure between" value={first} onChange={(event) => setFirst(event.target.value)}>
            <option value="">Between…</option>
            {graph.nodes.map((node) => (
              <option key={node.id} value={node.id}>
                {node.label}
              </option>
            ))}
          </select>
          <select aria-label="And" value={second} onChange={(event) => setSecond(event.target.value)}>
            <option value="">and…</option>
            {graph.nodes.map((node) => (
              <option key={node.id} value={node.id}>
                {node.label}
              </option>
            ))}
          </select>
          <button
            type="button"
            className="btn"
            disabled={!canAdd}
            onClick={() => {
              addUncertainPair(first, second);
              setFirst("");
              setSecond("");
            }}
          >
            Mark as not sure
          </button>
        </div>
      ) : null}
      {isQuestion ? <p className="hint">Whether treatment affects outcome is what is being estimated, so it cannot be marked.</p> : null}

      {shownPairs.length ? scan ? <ScanResult scan={scan} /> : <p className="empty">Trying every combination…</p> : null}
    </section>
  );
}

function ScanResult({ scan }: { scan: UncertaintyScan }) {
  const [showAll, setShowAll] = useState(false);
  const shownAnswers = showAll ? scan.answers : scan.answers.slice(0, ANSWERS_SHOWN);
  const left = scan.combinations - scan.analysed;
  const matters = scan.pairEffects.filter((pair) => pair.changesAnswer);
  const settled = scan.pairEffects.filter((pair) => !pair.changesAnswer);
  const names = (list: typeof matters) => joinNames(list.map((pair) => `${pair.first} and ${pair.second}`));
  const isRunning = scan.status === "running";

  return (
    <div className="stack">
      <div className="callout">
        <strong>
          {scan.answers.length === 1
            ? `${scan.analysed === 1 ? "The combination gives" : `All ${scan.analysed} combinations give`} the same answer`
            : `${scan.analysed} combinations give ${scan.answers.length} different answers`}
          {isRunning ? " so far" : ""}
        </strong>
        <p>
          {scan.ruledOutByTiming || scan.ruledOutByCycle
            ? `${left} of ${scan.combinations} were left out: ${[scan.ruledOutByTiming ? `${scan.ruledOutByTiming} would run backwards in time` : "", scan.ruledOutByCycle ? `${scan.ruledOutByCycle} would form a cycle` : ""].filter(Boolean).join(" and ")}. `
            : ""}
          {scan.truncated ? "The rest did not finish within the time limit. " : ""}
          {scan.checksTruncated ? "The data checks stopped at their time limit, so they cover only some combinations. " : ""}
          {matters.length ? `The answer depends on ${names(matters)}. ` : ""}
          {settled.length && scan.answers.length > 1 ? `Taken alone, ${names(settled)} ${settled.length === 1 ? "does" : "do"} not change it. ` : ""}
          {scan.sharedSet ? `${formatSet(scan.sharedSet.variables)} is valid under ${scan.sharedSet.validIn} of them${scan.sharedSet.estimate ? ` and gives ${effectSummary(scan.sharedSet.estimate)}` : ""}.` : ""}
        </p>
      </div>
      {shownAnswers.map((answer) => (
        <ScanAnswerRow key={answer.adjustmentSet?.join() ?? "none"} answer={answer} />
      ))}
      {scan.answers.length > shownAnswers.length ? (
        <div>
          <button type="button" className="btn btn--text" onClick={() => setShowAll(true)}>
            Show all {scan.answers.length} answers
          </button>
        </div>
      ) : null}
    </div>
  );
}

function ScanAnswerRow({ answer }: { answer: ScanAnswer }) {
  const versionCount = useWorkbenchStore((state) => state.versions.length);
  const keepCombination = useWorkbenchStore((state) => state.keepCombination);
  return (
    <section className="answer">
      <header className="answer__head">
        <strong>{answer.adjustmentSet === null ? "No estimate" : answer.estimate ? effectSummary(answer.estimate) : "Not estimated"}</strong>
        <span>{answer.adjustmentSet === null ? "No measured set is valid" : answer.adjustmentSet.length ? `Adjust for ${answer.adjustmentSet.join(", ")}` : "No adjustment needed"}</span>
      </header>
      <article className="graph-row">
        <div className="graph-row__main">
          <div className="graph-row__who">
            <strong>
              {answer.combinations} {answer.combinations === 1 ? "combination" : "combinations"}
            </strong>
            <span>{answer.exampleChange ? `Closest: ${answer.exampleChange}` : "Including the graph on show"}</span>
          </div>
          <div className="graph-row__what">
            {answer.checked ? (
              answer.contradicted ? (
                <span className="pill pill--warning">
                  {answer.contradicted} of {answer.checked} contradicted
                </span>
              ) : (
                <span className="graph-row__check">0 of {answer.checked} contradicted</span>
              )
            ) : null}
            {answer.exampleChange && versionCount < MAX_GRAPH_VERSIONS ? (
              <button type="button" className="btn btn--text" onClick={() => keepCombination(answer.example)}>
                Keep as a graph
              </button>
            ) : null}
          </div>
        </div>
      </article>
    </section>
  );
}
