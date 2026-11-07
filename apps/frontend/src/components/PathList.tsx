import type { AnalysisResult, PathAnalysisItem } from "@causal-graph-workbench/shared";
import { useState } from "react";

import { useWorkbenchStore } from "../store/useWorkbenchStore";

const FILTERS = [
  { id: "all", label: "All" },
  { id: "backdoor", label: "Backdoor" },
  { id: "directed", label: "Causal" },
  { id: "collider", label: "With a collider" },
] as const;

export function PathList({ analysis }: { analysis: AnalysisResult }) {
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
