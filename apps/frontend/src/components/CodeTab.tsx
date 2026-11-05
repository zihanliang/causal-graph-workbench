import type { AnalysisResult, CodeSnippet, DataDiagnostics, VariableType } from "@causal-graph-workbench/shared";
import { useMemo, useState } from "react";

import { buildReproducibleScript } from "../engine/reproduce";
import { buildMethodsText, methodsAsText } from "../lib/methods";
import { useWorkbenchStore } from "../store/useWorkbenchStore";
import { Disclosure, Icon } from "./ui";

const WHOLE_ANALYSIS = "whole-analysis";

interface CodeTabProps {
  analysis: AnalysisResult | null;
  snippetId: string | null;
  onSelectSnippet: (id: string) => void;
}

export function CodeTab({ analysis, snippetId, onSelectSnippet }: CodeTabProps) {
  const setSelectedExplainable = useWorkbenchStore((state) => state.setSelectedExplainable);
  const graph = useWorkbenchStore((state) => state.graph);
  const dataContext = useWorkbenchStore((state) => state.dataContext);
  const [copied, setCopied] = useState<string | null>(null);

  const wholeAnalysis = useMemo(() => (analysis ? buildReproducibleScript(graph, analysis) : null), [analysis, graph]);
  const methods = useMemo(() => (analysis?.validation.canAnalyze ? buildMethodsText(graph, analysis) : null), [analysis, graph]);

  if (!analysis) {
    return <p className="empty">This appears as soon as the graph has been processed.</p>;
  }

  const flagCopied = (key: string) => {
    setCopied(key);
    window.setTimeout(() => setCopied((current) => (current === key ? null : current)), 1200);
  };

  const snippets: CodeSnippet[] = wholeAnalysis
    ? [{ id: WHOLE_ANALYSIS, label: "Everything on this page (Python)", language: "python", estimatorId: "", content: wholeAnalysis }, ...analysis.codeSnippets]
    : analysis.codeSnippets;
  const shownId = analysis.effect?.estimate?.snippetId;
  const selected = snippets.find((snippet) => snippet.id === snippetId) ?? snippets[0] ?? null;
  const recommended = analysis.estimatorRecommendations.find((item) => item.recommended) ?? analysis.estimatorRecommendations[0] ?? null;
  const treatmentType = resolveVariableType(graph.treatmentId, dataContext.treatmentType ?? "unknown", analysis.dataDiagnostics);
  const outcomeType = resolveVariableType(graph.outcomeId, dataContext.outcomeType ?? "unknown", analysis.dataDiagnostics);
  const isProvisional = treatmentType === "unknown" || outcomeType === "unknown";
  const bindings = analysis.dataDiagnostics?.hasData ? analysis.dataDiagnostics.variableBindings : [];
  const hasEstimate = Boolean(analysis.effect?.estimate);

  return (
    <div className="stack">
      {methods ? (
        <section className="group">
          <div className="section-head">
            <h2>Methods text</h2>
            <button
              type="button"
              className="btn"
              onClick={async () => {
                await copyText(methodsAsText(methods));
                flagCopied("methods");
              }}
            >
              {copied === "methods" ? (
                <>
                  <Icon name="check" /> Copied
                </>
              ) : (
                "Copy"
              )}
            </button>
          </div>
          <p className="hint">A draft that says what was done here. The reasons you believe the graph are yours to add, where the brackets are.</p>
          <div className="methods">
            {methods.paragraphs.map((paragraph) => (
              <p key={paragraph}>{paragraph}</p>
            ))}
          </div>
          <Disclosure title="References" count={methods.references.length}>
            <ul className="references">
              {methods.references.map((reference) => (
                <li key={reference}>{reference}</li>
              ))}
            </ul>
          </Disclosure>
        </section>
      ) : null}

      {selected ? (
        <section className="group">
          <h2>Script</h2>
          {wholeAnalysis && selected.id === WHOLE_ANALYSIS ? (
            <p className="hint">Recomputes every number here from your file and checks them against what this page shows. Run it next to {analysis.reproduction?.filename}.</p>
          ) : null}
          <div className="code-toolbar">
            <select aria-label="Choose a script" value={selected.id} onChange={(event) => onSelectSnippet(event.target.value)}>
              {snippets.map((snippet) => (
                <option key={snippet.id} value={snippet.id}>
                  {snippet.label}
                  {snippet.id === shownId ? " (reproduces the estimate above)" : ""}
                </option>
              ))}
            </select>
            <button
              type="button"
              className="btn"
              onClick={async () => {
                await copyText(selected.content);
                flagCopied(selected.id);
              }}
            >
              {copied === selected.id ? (
                <>
                  <Icon name="check" /> Copied
                </>
              ) : (
                "Copy"
              )}
            </button>
          </div>
          <pre className="code-block">
            <code>{selected.content}</code>
          </pre>
          {analysis.effect?.status === "running" || analysis.audit?.status === "running" ? <p className="hint">The script for the whole analysis appears when the checks have finished.</p> : null}
        </section>
      ) : (
        <p className="empty">
          {analysis.baselineSet === null
            ? "With no valid adjustment set, there is no estimation code to write for this graph."
            : "No template fits this outcome. Recode it to a binary or numeric variable first."}
        </p>
      )}

      {recommended ? (
        <Disclosure title={`Suggested estimator: ${recommended.name}`} defaultOpen={!hasEstimate}>
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
      ) : null}

      {bindings.length ? (
        <Disclosure title="Columns this code uses" count={bindings.filter((binding) => binding.matched).length}>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Variable</th>
                  <th>Column</th>
                  <th>Matched by</th>
                </tr>
              </thead>
              <tbody>
                {bindings.map((binding) => (
                  <tr key={binding.nodeId}>
                    <td>{binding.nodeId}</td>
                    <td>{binding.columnName ?? "Not matched"}</td>
                    <td>{binding.matchType}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Disclosure>
      ) : null}
    </div>
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

async function copyText(value: string): Promise<void> {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(value);
    return;
  }
  const textarea = document.createElement("textarea");
  textarea.value = value;
  textarea.setAttribute("readonly", "true");
  textarea.style.position = "absolute";
  textarea.style.left = "-9999px";
  document.body.appendChild(textarea);
  textarea.select();
  document.execCommand("copy");
  document.body.removeChild(textarea);
}
