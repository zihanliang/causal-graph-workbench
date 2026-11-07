import type { AdjustmentSetSummary, AnalysisResult, EffectComparison } from "@causal-graph-workbench/shared";
import { useState } from "react";

import { effectSummary, formatSet } from "../lib/format";
import { useWorkbenchStore } from "../store/useWorkbenchStore";
import { Disclosure } from "./ui";

function useSetChoice(analysis: AnalysisResult) {
  const setDataContext = useWorkbenchStore((state) => state.setDataContext);
  const recommended = analysis.recommendedAdjustmentSet.join();
  return (variables: string[]) => setDataContext({ chosenSet: variables.join() === recommended ? null : variables });
}

/** What the same file gives under other choices of set, including the mistakes people commonly make. */
export function SameDataComparison({ analysis }: { analysis: AnalysisResult }) {
  const useSet = useSetChoice(analysis);
  const comparisons = analysis.effect?.comparisons ?? [];
  const baseline = analysis.baselineSet?.join() ?? "";
  if (!comparisons.length) {
    return null;
  }
  return (
    <section className="group">
      <h2>The same data, adjusted differently</h2>
      <p className="hint">Only valid sets estimate the causal effect if your graph is right. Invalid ones show the size of the mistake.</p>
      <div className="item-list">
        {comparisons.map((row) => (
          <ComparisonRow
            key={row.id}
            row={row}
            isCurrent={row.variables.join() === baseline}
            onUse={row.isValid && row.variables.join() !== baseline ? () => useSet(row.variables) : null}
          />
        ))}
      </div>
    </section>
  );
}

/** Which sets the graph allows, which variables to leave out, and a way to test the set someone already used. */
export function SetChoices({ analysis }: { analysis: AnalysisResult }) {
  const dataContext = useWorkbenchStore((state) => state.dataContext);
  const setDataContext = useWorkbenchStore((state) => state.setDataContext);
  const setSelectedExplainable = useWorkbenchStore((state) => state.setSelectedExplainable);
  const [draft, setDraft] = useState<string[]>(dataContext.chosenSet ?? []);
  const useSet = useSetChoice(analysis);

  const baseline = analysis.baselineSet?.join() ?? "";
  const minimal = analysis.adjustmentSets.filter((item) => item.isMinimal);
  const larger = analysis.adjustmentSets.filter((item) => !item.isMinimal);
  const measured = (analysis.dataDiagnostics?.variableBindings ?? [])
    .filter((binding) => binding.matched)
    .map((binding) => binding.nodeId)
    .filter((node) => analysis.nodeRoles.some((role) => role.nodeId === node));
  const showSet = (item: AdjustmentSetSummary) => setSelectedExplainable({ kind: "adjustment", id: item.id });

  return (
    <div className="stack">
      <Disclosure title="Smallest valid sets" count={minimal.length} defaultOpen>
        {minimal.length ? (
          <div className="item-list">
            {minimal.map((item) => (
              <SetRow key={item.id} item={item} isCurrent={item.variables.join() === baseline} onExplain={() => showSet(item)} onUse={() => useSet(item.variables)} />
            ))}
          </div>
        ) : (
          <p className="hint">No valid set exists for this graph.</p>
        )}
      </Disclosure>

      {larger.length ? (
        <Disclosure title="Larger valid sets" count={larger.length}>
          <p className="hint">Most people do not need these.{analysis.limits.adjustmentSetsTruncated ? " Only some of them are listed for this graph." : ""}</p>
          <div className="item-list">
            {larger.map((item) => (
              <SetRow key={item.id} item={item} isCurrent={item.variables.join() === baseline} onExplain={() => showSet(item)} onUse={() => useSet(item.variables)} />
            ))}
          </div>
        </Disclosure>
      ) : null}

      {analysis.forbiddenVariables.length ? (
        <Disclosure title="Variables not to adjust for" count={analysis.forbiddenVariables.length}>
          <p className="hint">These appear in no valid set, so adjusting for them biases the total effect.</p>
          <dl className="definition-list">
            {analysis.forbiddenVariables.map((item) => (
              <div key={item.nodeId}>
                <dt>{item.nodeId}</dt>
                <dd>{item.reasons.join(" ")}</dd>
              </div>
            ))}
          </dl>
        </Disclosure>
      ) : null}

      {analysis.cautionVariables.length ? (
        <Disclosure title="Variables to use with care" count={analysis.cautionVariables.length} defaultOpen>
          <p className="hint">These can be part of a valid set, but only together with the right companions.</p>
          <dl className="definition-list">
            {analysis.cautionVariables.map((item) => (
              <div key={item.nodeId}>
                <dt>
                  {item.nodeId}
                  {item.required ? <span className="pill">required</span> : null}
                </dt>
                <dd>{item.reasons.join(" ")}</dd>
              </div>
            ))}
          </dl>
        </Disclosure>
      ) : null}

      {measured.length ? (
        <Disclosure title="Test the set you used">
          <p className="hint">Tick the variables you adjusted for. If the set is valid it becomes your current set; if not, you will see why.</p>
          <div className="set-picker">
            {measured.map((node) => (
              <label key={node} className="check">
                <input type="checkbox" checked={draft.includes(node)} onChange={(event) => setDraft(event.target.checked ? [...draft, node] : draft.filter((item) => item !== node))} />
                <span>{node}</span>
              </label>
            ))}
          </div>
          <div className="button-row">
            <button type="button" className="btn" onClick={() => setDataContext({ chosenSet: draft })}>
              Test this set
            </button>
            {dataContext.chosenSet ? (
              <button
                type="button"
                className="btn btn--text"
                onClick={() => {
                  setDraft([]);
                  setDataContext({ chosenSet: null });
                }}
              >
                Back to the recommended set
              </button>
            ) : null}
          </div>
        </Disclosure>
      ) : null}
    </div>
  );
}

function ComparisonRow({ row, isCurrent, onUse }: { row: EffectComparison; isCurrent: boolean; onUse: (() => void) | null }) {
  return (
    <article className="compare">
      <div className="compare__who">
        <strong>{row.label}</strong>
        <span>{formatSet(row.variables)}</span>
      </div>
      <div className="compare__what">
        <span className="compare__value">{row.estimate ? effectSummary(row.estimate) : row.unavailableReason}</span>
        {isCurrent ? <span className="pill pill--ink">Current</span> : null}
        {!row.isValid ? <span className="pill pill--warning">Not valid</span> : null}
        {onUse ? (
          <button type="button" className="btn btn--text" onClick={onUse}>
            Use this set
          </button>
        ) : null}
      </div>
      {row.invalidReason ? <p className="hint">{row.invalidReason}</p> : null}
    </article>
  );
}

function SetRow({ item, isCurrent, onExplain, onUse }: { item: AdjustmentSetSummary; isCurrent: boolean; onExplain: () => void; onUse: () => void }) {
  return (
    <article className="set-row">
      <div>
        <strong>{formatSet(item.variables)}</strong>
        <span className="set-row__meta">
          Blocks {item.blockedPathIds.length} backdoor path{item.blockedPathIds.length === 1 ? "" : "s"}
          {item.openedPathIds.length ? `, activates ${item.openedPathIds.length} collider path${item.openedPathIds.length === 1 ? "" : "s"}` : ""}
          {item.practicalRating === "avoid" ? ". Better avoided" : ""}
          {item.isRecommended ? ". Recommended" : ""}
        </span>
      </div>
      <div className="set-row__actions">
        {isCurrent ? <span className="pill pill--ink">Current</span> : null}
        <button type="button" className="btn btn--text" onClick={onExplain}>
          Why
        </button>
        {!isCurrent ? (
          <button type="button" className="btn btn--text" onClick={onUse}>
            Use this set
          </button>
        ) : null}
      </div>
    </article>
  );
}
