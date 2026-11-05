import type { AnalysisResult, OverlapDiagnostics, PathAnalysisItem, TreatmentBalanceSummary } from "@causal-graph-workbench/shared";
import { useState } from "react";

import { useWorkbenchStore } from "../store/useWorkbenchStore";
import { Disclosure, IssueList, Notice } from "./ui";

export function DetailsTab({ analysis }: { analysis: AnalysisResult | null }) {
  if (!analysis) {
    return <p className="empty">This appears as soon as the graph has been processed.</p>;
  }
  const balance = analysis.dataDiagnostics?.treatmentBalance;
  const overlap = analysis.dataDiagnostics?.overlapDiagnostics;
  const notes = analysis.validation.issues.filter((issue) => issue.severity === "info");

  return (
    <div className="stack">
      <Disclosure title="Paths from treatment to outcome" count={analysis.paths.length} defaultOpen>
        <PathList analysis={analysis} />
      </Disclosure>

      {balance ? (
        <Disclosure title="Are the groups comparable?" count={balance.metrics.filter((metric) => metric.imbalanced).length ? `${balance.metrics.filter((metric) => metric.imbalanced).length} imbalanced` : undefined} defaultOpen>
          <BalanceTable balance={balance} />
        </Disclosure>
      ) : null}

      {overlap ? (
        <Disclosure title="Do the groups overlap?" count={overlap.warnings.length ? `${overlap.warnings.length} warning${overlap.warnings.length === 1 ? "" : "s"}` : undefined} defaultOpen={overlap.warnings.length > 0}>
          <OverlapSummary overlap={overlap} rowCount={analysis.dataDiagnostics?.rowCount ?? 0} />
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

      {notes.length ? (
        <Disclosure title="Notes on this graph" count={notes.length}>
          <IssueList issues={notes} />
        </Disclosure>
      ) : null}
    </div>
  );
}

const FILTERS = [
  { id: "all", label: "All" },
  { id: "backdoor", label: "Backdoor" },
  { id: "directed", label: "Causal" },
  { id: "collider", label: "With a collider" },
] as const;

function PathList({ analysis }: { analysis: AnalysisResult }) {
  const setHighlightedPathId = useWorkbenchStore((state) => state.setHighlightedPathId);
  const setSelectedExplainable = useWorkbenchStore((state) => state.setSelectedExplainable);
  const [filter, setFilter] = useState<(typeof FILTERS)[number]["id"]>("all");

  const matches = (path: PathAnalysisItem) =>
    filter === "all" ? true : filter === "backdoor" ? path.category === "backdoor" : filter === "directed" ? path.category === "directed_causal" : path.involvesCollider;
  const paths = analysis.paths.filter(matches);
  const baseline = analysis.baselineSet ? [...analysis.baselineSet].sort().join() : null;

  return (
    <>
      <div className="segmented" role="group" aria-label="Filter paths">
        {FILTERS.map((item) => (
          <button key={item.id} type="button" aria-pressed={filter === item.id} onClick={() => setFilter(item.id)}>
            {item.label}
          </button>
        ))}
      </div>
      {analysis.limits.pathsTruncated ? <p className="hint">This graph has too many paths to list, so only the shortest are shown. Adjustment sets do not depend on this list.</p> : null}
      {paths.length ? (
        <ul className="path-list">
          {paths.map((path) => {
            const adjusted = path.adjustmentEvaluations.find((evaluation) => [...evaluation.conditioningSet].sort().join() === baseline);
            const status = adjusted ?? path.defaultEvaluation;
            return (
              <li key={path.id}>
                <button
                  type="button"
                  className="path"
                  onMouseEnter={() => setHighlightedPathId(path.id)}
                  onMouseLeave={() => setHighlightedPathId(null)}
                  onClick={() => setSelectedExplainable({ kind: "path", id: path.id })}
                >
                  <span className="path__route">{path.pathString}</span>
                  <span className="path__status">
                    {path.category === "directed_causal" ? "causal" : path.category === "backdoor" ? "backdoor" : "noncausal"}, {status.status}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      ) : (
        <p className="hint">No paths of this kind.</p>
      )}
    </>
  );
}

function BalanceTable({ balance }: { balance: TreatmentBalanceSummary }) {
  return (
    <>
      <p className="hint">{balance.note}</p>
      {balance.available && balance.treatedLabel ? (
        <p className="hint">
          Read as treated: &quot;{balance.treatedLabel}&quot; ({balance.treatedCount} rows). Read as control: &quot;{balance.controlLabel}&quot; ({balance.controlCount} rows).
        </p>
      ) : null}
      {balance.metrics.length ? (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Covariate</th>
                <th className="n">Treated</th>
                <th className="n">Control</th>
                <th className="n">Std. difference</th>
              </tr>
            </thead>
            <tbody>
              {balance.metrics.map((metric) => (
                <tr key={metric.columnName}>
                  <td>{metric.columnName}</td>
                  <td className="n">{metric.treatedValue}</td>
                  <td className="n">{metric.controlValue}</td>
                  <td className={metric.imbalanced ? "n cell--flag" : "n"}>{metric.standardizedDifference?.toFixed(3) ?? "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
    </>
  );
}

function OverlapSummary({ overlap, rowCount }: { overlap: OverlapDiagnostics; rowCount: number }) {
  const { propensity, warnings, note } = overlap;
  const range = ([low, high]: [number, number]) => `${low.toFixed(3)} to ${high.toFixed(3)}`;
  const share = (value: number) => `${(value * 100).toFixed(1)}%`;
  return (
    <>
      <p className="hint">{note}</p>
      {propensity ? (
        <dl className="key-values">
          <div>
            <dt>Treated propensity</dt>
            <dd>{range(propensity.treatedRange)}</dd>
          </div>
          <div>
            <dt>Control propensity</dt>
            <dd>{range(propensity.controlRange)}</dd>
          </div>
          <div>
            <dt>Common support</dt>
            <dd>{propensity.commonSupport ? range(propensity.commonSupport) : "None"}</dd>
          </div>
          <div>
            <dt>Outside support</dt>
            <dd>
              {share(propensity.treatedOutsideSupport)} treated, {share(propensity.controlOutsideSupport)} control
            </dd>
          </div>
          <div>
            <dt>Below 0.05 or above 0.95</dt>
            <dd>{share(propensity.extremeShare)}</dd>
          </div>
          <div>
            <dt>Rows used</dt>
            <dd>
              {propensity.rowsUsed.toLocaleString("en-US")} of {rowCount.toLocaleString("en-US")}
            </dd>
          </div>
        </dl>
      ) : null}
      {warnings.length ? (
        <div className="stack-tight">
          {warnings.map((warning) => (
            <Notice key={warning} tone="warning">
              {warning}
            </Notice>
          ))}
        </div>
      ) : null}
    </>
  );
}
