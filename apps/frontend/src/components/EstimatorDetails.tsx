import type { AnalysisResult, DataDiagnostics, GraphSpec, VariableType } from "@causal-graph-workbench/shared";

import { useWorkbenchStore } from "../store/useWorkbenchStore";
import { Disclosure } from "./ui";

/** Which method was suggested for this data, and why. */
export function EstimatorDetails({ analysis, graph }: { analysis: AnalysisResult; graph: GraphSpec }) {
  const setSelectedExplainable = useWorkbenchStore((state) => state.setSelectedExplainable);
  const dataContext = useWorkbenchStore((state) => state.dataContext);
  const recommended = analysis.estimatorRecommendations.find((item) => item.recommended) ?? analysis.estimatorRecommendations[0] ?? null;
  if (!recommended) {
    return null;
  }
  const treatmentType = resolveVariableType(graph.treatmentId, dataContext.treatmentType ?? "unknown", analysis.dataDiagnostics);
  const outcomeType = resolveVariableType(graph.outcomeId, dataContext.outcomeType ?? "unknown", analysis.dataDiagnostics);
  const isProvisional = treatmentType === "unknown" || outcomeType === "unknown";

  return (
    <Disclosure title={`Suggested estimator: ${recommended.name}`} defaultOpen={!analysis.effect?.estimate}>
      <p>{recommended.summary}</p>
      <dl className="key-values">
        <div>
          <dt>Treatment type</dt>
          <dd>{formatVariableType(treatmentType)}</dd>
        </div>
        <div>
          <dt>Outcome type</dt>
          <dd>{formatVariableType(outcomeType)}</dd>
        </div>
        <div>
          <dt>Data</dt>
          <dd>{analysis.dataDiagnostics?.hasData ? "Added" : "Graph only"}</dd>
        </div>
        <div>
          <dt>Variables adjusted for</dt>
          <dd>{analysis.baselineSet?.length ?? 0}</dd>
        </div>
      </dl>
      {isProvisional ? <p className="hint">Treatment or outcome type is still unknown, so this is a cautious starting point. Add data or set the types under Data to refine it.</p> : null}
      {recommended.caveats.length ? (
        <ul className="plain-list">
          {recommended.caveats.map((caveat) => (
            <li key={caveat}>{caveat}</li>
          ))}
        </ul>
      ) : null}
      <div className="formula">
        <code>{recommended.formulaPreview}</code>
        <button type="button" className="btn btn--text" onClick={() => setSelectedExplainable({ kind: "estimator", id: recommended.id })}>
          Why this one
        </button>
      </div>
    </Disclosure>
  );
}

function resolveVariableType(nodeId: string | null, requested: VariableType, diagnostics: DataDiagnostics | null | undefined): VariableType {
  if (requested !== "unknown" || !nodeId || !diagnostics) {
    return requested;
  }
  const binding = diagnostics.variableBindings.find((item) => item.nodeId === nodeId && item.columnName);
  const profile = diagnostics.columnProfiles.find((item) => item.columnName === binding?.columnName);
  return profile?.inferredType ?? requested;
}

function formatVariableType(type: VariableType): string {
  return type === "unknown" ? "Not known yet" : type[0].toUpperCase() + type.slice(1);
}
