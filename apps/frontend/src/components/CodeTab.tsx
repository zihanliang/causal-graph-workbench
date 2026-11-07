import type { AnalysisResult, CodeSnippet } from "@causal-graph-workbench/shared";
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
  const graph = useWorkbenchStore((state) => state.graph);
  const hasOtherGraphs = useWorkbenchStore((state) => state.versions.length > 1);
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
    ? [{ id: WHOLE_ANALYSIS, label: hasOtherGraphs ? "Everything for this graph (Python)" : "Everything on this page (Python)", language: "python", estimatorId: "", content: wholeAnalysis }, ...analysis.codeSnippets]
    : analysis.codeSnippets;
  const shownId = analysis.effect?.estimate?.snippetId;
  const selected = snippets.find((snippet) => snippet.id === snippetId) ?? snippets[0] ?? null;
  const bindings = analysis.dataDiagnostics?.hasData ? analysis.dataDiagnostics.variableBindings : [];

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
            <p className="hint">
              Recomputes every number {hasOtherGraphs ? "for this graph" : "here"} from your file and checks them against what this page shows. Run it next to {analysis.reproduction?.filename}.
              {hasOtherGraphs ? " Show another graph to get its script." : ""}
            </p>
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
          {/* Focusable, so that someone on a keyboard can scroll it too. */}
          <pre className="code-block" tabIndex={0} aria-label={`Code: ${selected.label}`}>
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
