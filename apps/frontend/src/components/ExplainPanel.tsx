import type { AnalysisResult } from "@causal-graph-workbench/shared";

import { getExplainableDisplayLabel, getExplainableKindLabel } from "../lib/explainableLabel";
import { useWorkbenchStore } from "../store/useWorkbenchStore";

interface ExplainPanelProps {
  analysis: AnalysisResult | null;
}

export function ExplainPanel({ analysis }: ExplainPanelProps) {
  const selectedExplainable = useWorkbenchStore((state) => state.selectedExplainable);
  const setSelectedExplainable = useWorkbenchStore((state) => state.setSelectedExplainable);

  const isOpen = Boolean(analysis && selectedExplainable);
  const selectedLabel = getExplainableDisplayLabel(analysis, selectedExplainable);

  return (
    <section className={isOpen ? "explain-drawer explain-drawer--open" : "explain-drawer"}>
      <header className="explain-drawer__header">
        <div>
          <p className="eyebrow">Explain Panel</p>
          <h2>{getExplainableKindLabel(selectedExplainable)}</h2>
        </div>
        <div className="pill-row">
          {selectedLabel ? <span className="status-pill">{selectedLabel}</span> : null}
          <button type="button" className="button--ghost" onClick={() => setSelectedExplainable(null)}>
            Close
          </button>
        </div>
      </header>

      <div className="explain-drawer__body">{renderExplainBody(analysis, selectedExplainable)}</div>
    </section>
  );
}

function renderExplainBody(
  analysis: AnalysisResult | null,
  selectedExplainable: ReturnType<typeof useWorkbenchStore.getState>["selectedExplainable"],
) {
  if (!analysis || !selectedExplainable) {
    return (
      <p className="help-text">
        Click a node, path, adjustment set, or estimator anywhere in the workbench to open a short, operational
        explanation here.
      </p>
    );
  }

  if (selectedExplainable.kind === "node") {
    const role = analysis.nodeRoles.find((item) => item.nodeId === selectedExplainable.id);
    return (
      <div className="explain-body">
        <div className="explain-summary">
          <strong>{selectedExplainable.id}</strong>
          <p>{role?.summary ?? "No role summary available."}</p>
        </div>
        <ul className="explain-list">
          {(role?.evidence ?? []).map((item) => (
            <li key={item}>{item}</li>
          ))}
        </ul>
      </div>
    );
  }

  if (selectedExplainable.kind === "path") {
    const path = analysis.paths.find((item) => item.id === selectedExplainable.id);
    if (!path) {
      return null;
    }
    const recommendedEvaluation = path.adjustmentEvaluations.find(
      (evaluation) =>
        JSON.stringify([...evaluation.conditioningSet].sort()) === JSON.stringify([...analysis.recommendedAdjustmentSet].sort()),
    );
    return (
      <div className="explain-body">
        <div className="explain-summary">
          <strong>{path.pathString}</strong>
          <p>{path.explanation}</p>
        </div>
        <div className="explain-grid">
          <div className="explain-column">
            <h3>Default</h3>
            <p>
              <strong>{path.defaultEvaluation.status}</strong>: {path.defaultEvaluation.reason}
            </p>
            <ul className="explain-list">
              {path.defaultEvaluation.steps.map((step, index) => (
                <li key={`${step.nodeId}-${step.effect}-${index}`}>{step.explanation}</li>
              ))}
            </ul>
          </div>
          {recommendedEvaluation ? (
            <div className="explain-column">
              <h3>Recommended Set</h3>
              <p>
                <strong>{recommendedEvaluation.status}</strong>: {recommendedEvaluation.reason}
              </p>
              <ul className="explain-list">
                {recommendedEvaluation.steps.map((step, index) => (
                  <li key={`${step.nodeId}-${step.effect}-${index}`}>{step.explanation}</li>
                ))}
              </ul>
            </div>
          ) : null}
        </div>
      </div>
    );
  }

  if (selectedExplainable.kind === "adjustment") {
    const adjustmentSet = analysis.adjustmentSets.find((item) => item.id === selectedExplainable.id);
    if (!adjustmentSet) {
      return null;
    }
    return (
      <div className="explain-body">
        <div className="explain-summary">
          <strong>{adjustmentSet.variables.length ? `{${adjustmentSet.variables.join(", ")}}` : "{}"}</strong>
          <p>{adjustmentSet.explanation}</p>
        </div>
        <div className="pill-row">
          <span className={adjustmentSet.isValid ? "pill pill--blocked" : "pill pill--open"}>
            {adjustmentSet.isValid ? "structurally valid" : "invalid"}
          </span>
          <span className="pill">{adjustmentSet.practicalRating}</span>
        </div>
        {adjustmentSet.practicalConcerns.length ? (
          <ul className="explain-list">
            {adjustmentSet.practicalConcerns.map((concern) => (
              <li key={concern}>{concern}</li>
            ))}
          </ul>
        ) : null}
      </div>
    );
  }

  const estimator = analysis.estimatorRecommendations.find((item) => item.id === selectedExplainable.id);
  return (
    <div className="explain-body">
      <div className="explain-summary">
        <strong>{estimator?.name}</strong>
        <p>{estimator?.summary}</p>
      </div>
      <ul className="explain-list">
        {(estimator?.rationale ?? []).map((item) => (
          <li key={item}>{item}</li>
        ))}
      </ul>
      {estimator?.caveats?.length ? (
        <ul className="explain-list">
          {estimator.caveats.map((item) => (
            <li key={item}>{item}</li>
          ))}
        </ul>
      ) : null}
      <div className="code-preview-inline">{estimator?.formulaPreview}</div>
    </div>
  );
}
