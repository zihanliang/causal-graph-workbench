import type { AdjustmentSetSummary, AnalysisResult, DataDiagnostics, PathEvaluation, VariableType } from "@causal-graph-workbench/shared";
import { useEffect, useMemo, useState } from "react";

import { CollapsibleSection } from "./CollapsibleSection";
import { SectionCard } from "./SectionCard";
import { useWorkbenchStore, type PanelTab } from "../store/useWorkbenchStore";

interface ResultsPanelProps {
  analysis: AnalysisResult | null;
}

const TABS: { id: PanelTab; label: string }[] = [
  { id: "summary", label: "Summary" },
  { id: "paths", label: "Paths" },
  { id: "estimate", label: "Estimate" },
  { id: "checks", label: "Checks" },
];

export function ResultsPanel({ analysis }: ResultsPanelProps) {
  const activeTab = useWorkbenchStore((state) => state.activeTab);
  const setActiveTab = useWorkbenchStore((state) => state.setActiveTab);

  return (
    <aside className="results-panel">
      <SectionCard
        title="Analysis"
        actions={
          analysis ? (
            <span className="status-pill status-pill--success">
              {analysis.adjustmentSets.filter((item) => item.isMinimal).length} minimal set
              {analysis.adjustmentSets.filter((item) => item.isMinimal).length === 1 ? "" : "s"}
            </span>
          ) : (
            <span className="status-pill">waiting</span>
          )
        }
        className="results-panel__hero"
      >
        <p className="help-text">
          Start with Summary. Move to Paths when you need to inspect a specific backdoor route, then use Estimate to
          copy code and Checks to review assumptions and data diagnostics.
        </p>
      </SectionCard>

      <div className="tabs">
        {TABS.map((tab) => (
          <button
            key={tab.id}
            type="button"
            className={tab.id === activeTab ? "tab tab--active" : "tab"}
            onClick={() => setActiveTab(tab.id)}
          >
            {tab.label}
          </button>
        ))}
      </div>

      <div className="results-panel__body">
        {activeTab === "summary" ? <SummaryTab analysis={analysis} /> : null}
        {activeTab === "paths" ? <PathsTab analysis={analysis} /> : null}
        {activeTab === "estimate" ? <EstimateTab analysis={analysis} /> : null}
        {activeTab === "checks" ? <ChecksTab analysis={analysis} /> : null}
      </div>
    </aside>
  );
}

function SummaryTab({ analysis }: ResultsPanelProps) {
  const setSelectedExplainable = useWorkbenchStore((state) => state.setSelectedExplainable);

  if (!analysis) {
    return <EmptyState message="Analysis will appear here once the graph is sent to the backend." />;
  }

  const errors = analysis.validation.issues.filter((issue) => issue.severity === "error");
  const warnings = analysis.validation.issues.filter((issue) => issue.severity === "warning");
  const hasAdjustmentSets = analysis.adjustmentSets.length > 0;
  const minimalSets = analysis.adjustmentSets.filter((item) => item.isMinimal);
  const nonMinimalSets = analysis.adjustmentSets.filter((item) => !item.isMinimal);
  const recommendedEstimator = analysis.estimatorRecommendations.find((item) => item.recommended) ?? analysis.estimatorRecommendations[0] ?? null;

  return (
    <div className="stack">
      <SectionCard title="Read This First" actions={<span className="status-pill status-pill--success">default path</span>}>
        <div className="summary-grid">
          <div className="summary-stat">
            <span>Status</span>
            <strong>{errors.length ? `${errors.length} blocking` : warnings.length ? `${warnings.length} warning${warnings.length === 1 ? "" : "s"}` : "Ready"}</strong>
          </div>
          <div className="summary-stat">
            <span>Recommended set</span>
            <strong>{hasAdjustmentSets ? formatSet(analysis.recommendedAdjustmentSet) : "No valid set"}</strong>
          </div>
          <div className="summary-stat">
            <span>Forbidden variables</span>
            <strong>{analysis.forbiddenVariables.length}</strong>
          </div>
          <div className="summary-stat">
            <span>Suggested estimator</span>
            <strong>{hasAdjustmentSets ? recommendedEstimator?.name ?? "n/a" : "withheld"}</strong>
          </div>
        </div>
        <p className="help-text">
          {hasAdjustmentSets
            ? "If the graph matches your intended causal story, start from the recommended set below, then open Estimate to copy code. Use Paths only when you need to inspect exactly why a route is open or blocked."
            : "No admissible observed adjustment set was identified under backdoor logic. Review the structural alerts, inspect the open paths, and avoid treating the empty set as a recommendation."}
        </p>
      </SectionCard>

      <CollapsibleSection
        title="Current Structural Alerts"
        subtitle="Keep this list short and actionable before you move on to code."
        badge={<span className="status-pill">{errors.length + warnings.length}</span>}
        defaultOpen={Boolean(errors.length || warnings.length)}
      >
        <div className="stack">
          <IssueList issues={errors} emptyLabel="No blocking errors." />
          <IssueList issues={warnings} emptyLabel="No warnings." />
        </div>
      </CollapsibleSection>

      <CollapsibleSection
        title="Minimal Valid Sets"
        subtitle="These are the smallest structurally valid adjustment sets under the current DAG."
        badge={<span className="status-pill">{minimalSets.length}</span>}
      >
        <div className="stack">
          {minimalSets.length ? (
            minimalSets.map((adjustmentSet) => (
              <AdjustmentSetCard
                key={adjustmentSet.id}
                adjustmentSet={adjustmentSet}
                onSelect={() => setSelectedExplainable({ kind: "adjustment", id: adjustmentSet.id })}
              />
            ))
          ) : (
            <p className="empty-state">No minimal valid sets are available for the current graph.</p>
          )}
        </div>
      </CollapsibleSection>

      <CollapsibleSection
        title="Forbidden Variables"
        subtitle="These should not enter the default total-effect adjustment recommendation."
        badge={<span className="status-pill">{analysis.forbiddenVariables.length}</span>}
        defaultOpen={false}
      >
        <div className="stack">
          {analysis.forbiddenVariables.length ? (
            analysis.forbiddenVariables.map((item) => (
              <article key={item.nodeId} className="forbidden-card">
                <strong>{item.nodeId}</strong>
                <p>{item.reasons.join(" ")}</p>
              </article>
            ))
          ) : (
            <p className="help-text">No forbidden variables were identified under the current graph.</p>
          )}
        </div>
      </CollapsibleSection>

      <details className="inline-details">
        <summary>
          Larger valid sets <span>{nonMinimalSets.length}</span>
        </summary>
        <div className="stack">
          <p className="help-text">Most users do not need these. The minimal sets above are the main structural recommendation.</p>
          {nonMinimalSets.length ? (
            nonMinimalSets.map((adjustmentSet) => (
              <AdjustmentSetCard
                key={adjustmentSet.id}
                adjustmentSet={adjustmentSet}
                onSelect={() => setSelectedExplainable({ kind: "adjustment", id: adjustmentSet.id })}
              />
            ))
          ) : (
            <p className="empty-state">No additional valid supersets beyond the minimal sets.</p>
          )}
        </div>
      </details>
    </div>
  );
}

function PathsTab({ analysis }: ResultsPanelProps) {
  const setHighlightedPathId = useWorkbenchStore((state) => state.setHighlightedPathId);
  const setSelectedExplainable = useWorkbenchStore((state) => state.setSelectedExplainable);
  const [filter, setFilter] = useState<"all" | "backdoor" | "directed" | "collider">("all");

  if (!analysis) {
    return <EmptyState message="Path analysis appears after a successful backend response." />;
  }

  const recommendedKey = JSON.stringify([...analysis.recommendedAdjustmentSet].sort());
  const filteredPaths = analysis.paths.filter((path) => {
    if (filter === "all") {
      return true;
    }
    if (filter === "backdoor") {
      return path.category === "backdoor";
    }
    if (filter === "directed") {
      return path.category === "directed_causal";
    }
    return path.involvesCollider;
  });

  return (
    <div className="stack">
      <SectionCard
        title="Path View"
        actions={
          <span className="status-pill">
            {filteredPaths.length}/{analysis.paths.length} shown
          </span>
        }
      >
        <p className="help-text">
          Hover any path card to light up the relevant subgraph on the canvas. Open the explanation drawer when you
          need the step-by-step d-separation logic.
        </p>
        <div className="chip-row">
          <FilterChip label="All" active={filter === "all"} onClick={() => setFilter("all")} />
          <FilterChip label="Backdoor" active={filter === "backdoor"} onClick={() => setFilter("backdoor")} />
          <FilterChip label="Directed" active={filter === "directed"} onClick={() => setFilter("directed")} />
          <FilterChip label="Collider-involving" active={filter === "collider"} onClick={() => setFilter("collider")} />
        </div>
      </SectionCard>

      <div className="stack">
        {filteredPaths.map((path) => {
          const recommendedEvaluation = path.adjustmentEvaluations.find(
            (evaluation) => JSON.stringify([...evaluation.conditioningSet].sort()) === recommendedKey,
          );
          return (
            <article
              key={path.id}
              className="path-card"
              onMouseEnter={() => setHighlightedPathId(path.id)}
              onMouseLeave={() => setHighlightedPathId(null)}
              onClick={() => setSelectedExplainable({ kind: "path", id: path.id })}
            >
              <div className="path-card__header">
                <strong>{path.pathString}</strong>
                <div className="pill-row">
                  <span className={`pill pill--${path.category}`}>{path.category.replaceAll("_", " ")}</span>
                  {path.involvesCollider ? <span className="pill pill--collider">collider involving</span> : null}
                  <span className={`pill pill--${path.defaultEvaluation.status}`}>{path.defaultEvaluation.status}</span>
                </div>
              </div>
              <p>{path.explanation}</p>
              <PathReason label="Current graph" evaluation={path.defaultEvaluation} />
              {recommendedEvaluation ? <PathReason label="Recommended set" evaluation={recommendedEvaluation} /> : null}
            </article>
          );
        })}
      </div>
    </div>
  );
}

function EstimateTab({ analysis }: ResultsPanelProps) {
  const setSelectedExplainable = useWorkbenchStore((state) => state.setSelectedExplainable);
  const graph = useWorkbenchStore((state) => state.graph);
  const dataContext = useWorkbenchStore((state) => state.dataContext);
  const [selectedSnippetId, setSelectedSnippetId] = useState<string | null>(null);
  const [copiedSnippetId, setCopiedSnippetId] = useState<string | null>(null);

  useEffect(() => {
    setSelectedSnippetId(analysis?.codeSnippets[0]?.id ?? null);
  }, [analysis]);

  const selectedSnippet = useMemo(
    () => analysis?.codeSnippets.find((snippet) => snippet.id === selectedSnippetId) ?? analysis?.codeSnippets[0] ?? null,
    [analysis, selectedSnippetId],
  );

  if (!analysis) {
    return <EmptyState message="Estimator recommendations and generated code appear after analysis." />;
  }

  const effectiveTreatmentType = resolveVariableType(graph.treatmentId, dataContext.treatmentType ?? "unknown", analysis.dataDiagnostics);
  const effectiveOutcomeType = resolveVariableType(graph.outcomeId, dataContext.outcomeType ?? "unknown", analysis.dataDiagnostics);
  const hasAdjustmentSets = analysis.adjustmentSets.length > 0;
  const recommendedEstimator = analysis.estimatorRecommendations.find((item) => item.recommended) ?? analysis.estimatorRecommendations[0] ?? null;
  const hasData = Boolean(analysis.dataDiagnostics?.hasData || dataContext.hasData);
  const isProvisionalRecommendation = effectiveTreatmentType === "unknown" || effectiveOutcomeType === "unknown";

  if (!hasAdjustmentSets) {
    return (
      <div className="stack">
        <SectionCard title="Estimator Availability" actions={<span className="status-pill status-pill--warning">withheld</span>}>
          <p className="help-text">
            No valid observed adjustment set was found under backdoor adjustment, so the workbench is not emitting estimation
            templates for this graph.
          </p>
          <ul className="mini-step-list">
            <li>Review `Summary` and `Checks` for the structural warning.</li>
            <li>Use `Paths` to inspect which backdoor path remains open and why.</li>
            <li>Revise the DAG or observed variable set before copying estimation code.</li>
          </ul>
        </SectionCard>
      </div>
    );
  }

  return (
    <div className="stack">
      <SectionCard
        title="Recommended Estimator"
        actions={
          recommendedEstimator ? (
            <span className={isProvisionalRecommendation ? "status-pill status-pill--warning" : "status-pill status-pill--success"}>
              {isProvisionalRecommendation ? "provisional default" : recommendedEstimator.name}
            </span>
          ) : null
        }
      >
        <div className="summary-grid">
          <div className="summary-stat">
            <span>Treatment type</span>
            <strong>{formatVariableType(effectiveTreatmentType)}</strong>
          </div>
          <div className="summary-stat">
            <span>Outcome type</span>
            <strong>{formatVariableType(effectiveOutcomeType)}</strong>
          </div>
          <div className="summary-stat">
            <span>Data status</span>
            <strong>{hasData ? "available" : "structural only"}</strong>
          </div>
          <div className="summary-stat">
            <span>Adjustment size</span>
            <strong>{analysis.recommendedAdjustmentSet.length}</strong>
          </div>
        </div>
        {recommendedEstimator ? (
          <div className="recommended-callout recommended-callout--compact">
            <strong>{recommendedEstimator.name}</strong>
            <p>{recommendedEstimator.summary}</p>
            {isProvisionalRecommendation ? (
              <p className="help-text">
                Treatment or outcome type is still unspecified, so this is a cautious starting point rather than a final recommendation.
                Set types in Data or upload a CSV to refine it.
              </p>
            ) : null}
            <div className="button-row">
              <button type="button" onClick={() => setSelectedExplainable({ kind: "estimator", id: recommendedEstimator.id })}>
                Explain estimator
              </button>
              <div className="code-preview-inline">{recommendedEstimator.formulaPreview}</div>
            </div>
          </div>
        ) : null}
      </SectionCard>

      <CollapsibleSection
        title="Generated Code"
        subtitle="Templates stay aligned with the exact recommended adjustment set."
        badge={<span className="status-pill">{analysis.codeSnippets.length}</span>}
      >
        <p className="help-text">The tabs below already cover the main code variants, so the UI stays focused on copying a working template quickly.</p>
        <div className="snippet-switcher">
          {analysis.codeSnippets.map((snippet) => (
            <button
              key={snippet.id}
              type="button"
              className={snippet.id === selectedSnippet?.id ? "chip chip--active" : "chip"}
              onClick={() => setSelectedSnippetId(snippet.id)}
            >
              {snippet.label}
            </button>
          ))}
        </div>

        {selectedSnippet ? (
          <>
            <div className="code-toolbar">
              <strong>{selectedSnippet.label}</strong>
              <button
                type="button"
                onClick={async () => {
                  await copyText(selectedSnippet.content);
                  setCopiedSnippetId(selectedSnippet.id);
                  window.setTimeout(() => setCopiedSnippetId((current) => (current === selectedSnippet.id ? null : current)), 1200);
                }}
              >
                {copiedSnippetId === selectedSnippet.id ? "Copied" : "Copy code"}
              </button>
            </div>
            <pre className="code-block">
              <code>{selectedSnippet.content}</code>
            </pre>
          </>
        ) : null}

        {analysis.dataDiagnostics?.hasData ? (
          <details className="inline-details">
            <summary>
              Matched columns <span>{analysis.dataDiagnostics.variableBindings.filter((binding) => binding.matched).length}</span>
            </summary>
            <div className="binding-list">
              {analysis.dataDiagnostics.variableBindings.map((binding) => (
                <article key={binding.nodeId} className="binding-row">
                  <strong>{binding.nodeId}</strong>
                  <span>{binding.columnName ?? "unmatched"}</span>
                  <span className={binding.matched ? "status-pill status-pill--success" : "status-pill status-pill--warning"}>
                    {binding.matchType}
                  </span>
                </article>
              ))}
            </div>
          </details>
        ) : null}
      </CollapsibleSection>
    </div>
  );
}

function ChecksTab({ analysis }: ResultsPanelProps) {
  if (!analysis) {
    return <EmptyState message="Validation, assumptions, and data diagnostics appear after analysis." />;
  }

  const errors = analysis.validation.issues.filter((issue) => issue.severity === "error");
  const warnings = analysis.validation.issues.filter((issue) => issue.severity === "warning");
  const info = analysis.validation.issues.filter((issue) => issue.severity === "info");
  const identificationAssumptions = analysis.assumptions.filter((item) => item.category === "identification");
  const downstreamAssumptions = analysis.assumptions.filter((item) => item.category !== "identification");

  return (
    <div className="stack">
      <CollapsibleSection
        title="Validation"
        subtitle="The checks below tell you whether the structural readout is safe to trust."
        badge={<span className="status-pill">{errors.length + warnings.length + info.length}</span>}
      >
        <div className="stack">
          <IssueList issues={errors} emptyLabel="No blocking errors." />
          <IssueList issues={warnings} emptyLabel="No warnings." />
          <details className="inline-details">
            <summary>
              Graph info <span>{info.length}</span>
            </summary>
            <IssueList issues={info} emptyLabel="No informational messages." />
          </details>
        </div>
      </CollapsibleSection>

      <CollapsibleSection
        title="Assumptions"
        subtitle="These assumptions explain what the structural recommendation is conditioning on."
        badge={<span className="status-pill">{analysis.assumptions.length}</span>}
      >
        <div className="stack">
          <div className="stack">
            {identificationAssumptions.map((assumption) => (
              <AssumptionCard key={assumption.id} assumption={assumption} />
            ))}
          </div>
          <details className="inline-details">
            <summary>
              Estimation and data assumptions <span>{downstreamAssumptions.length}</span>
            </summary>
            <div className="stack">
              {downstreamAssumptions.map((assumption) => (
                <AssumptionCard key={assumption.id} assumption={assumption} />
              ))}
            </div>
          </details>
        </div>
      </CollapsibleSection>

      <CollapsibleSection
        title="Data Diagnostics"
        subtitle="Descriptive checks only. These do not verify the graph or prove ignorability."
        badge={
          analysis.dataDiagnostics?.hasData ? (
            <span className="status-pill status-pill--success">{analysis.dataDiagnostics.rowCount} rows</span>
          ) : (
            <span className="status-pill">no data</span>
          )
        }
        defaultOpen={Boolean(analysis.dataDiagnostics?.hasData)}
      >
        {analysis.dataDiagnostics?.hasData ? (
          <DataDiagnosticsPanel diagnostics={analysis.dataDiagnostics} />
        ) : (
          <p className="empty-state">Upload a CSV in the Data section to unlock cautious diagnostics and column binding.</p>
        )}
      </CollapsibleSection>
    </div>
  );
}

function DataDiagnosticsPanel({ diagnostics }: { diagnostics: NonNullable<AnalysisResult["dataDiagnostics"]> }) {
  return (
    <div className="stack">
      <div className="summary-grid">
        <div className="summary-stat">
          <span>Dataset</span>
          <strong>{diagnostics.datasetName ?? "uploaded.csv"}</strong>
        </div>
        <div className="summary-stat">
          <span>Rows</span>
          <strong>{diagnostics.rowCount}</strong>
        </div>
        <div className="summary-stat">
          <span>Columns</span>
          <strong>{diagnostics.columnCount}</strong>
        </div>
        <div className="summary-stat">
          <span>Warnings</span>
          <strong>{diagnostics.warnings.length}</strong>
        </div>
      </div>

      {diagnostics.warnings.length ? (
        <ul className="mini-step-list">
          {diagnostics.warnings.map((warning) => (
            <li key={warning}>{warning}</li>
          ))}
        </ul>
      ) : null}

      <details className="inline-details">
        <summary>
          Column profiles <span>{diagnostics.columnProfiles.length}</span>
        </summary>
        <div className="comparison-table">
          <div className="comparison-row comparison-row--wide comparison-row--header">
            <span>Column</span>
            <span>Type</span>
            <span>Missing</span>
            <span>Unique</span>
            <span>Example / Bound nodes</span>
          </div>
          {diagnostics.columnProfiles.map((profile) => (
            <div key={profile.columnName} className="comparison-row comparison-row--wide">
              <span>{profile.columnName}</span>
              <span>{profile.inferredType}</span>
              <span>{(profile.missingRate * 100).toFixed(1)}%</span>
              <span>{profile.uniqueCount}</span>
              <span>
                {profile.exampleValues.join(", ") || "no example"} {profile.boundNodeIds.length ? `| ${profile.boundNodeIds.join(", ")}` : ""}
              </span>
            </div>
          ))}
        </div>
      </details>

      <details className="inline-details">
        <summary>
          Missingness summary <span>{diagnostics.missingness.length}</span>
        </summary>
        <div className="comparison-table">
          <div className="comparison-row comparison-row--wide comparison-row--header">
            <span>Column</span>
            <span>Missing</span>
            <span>Count</span>
            <span>Recommendation</span>
            <span>Note</span>
          </div>
          {diagnostics.missingness.map((item) => (
            <div key={item.columnName} className="comparison-row comparison-row--wide">
              <span>{item.columnName}</span>
              <span>{(item.missingRate * 100).toFixed(1)}%</span>
              <span>{item.missingCount}</span>
              <span>
                <RecommendationPill value={item.missingRate >= 0.3 ? "avoid" : item.missingRate > 0 ? "acceptable" : "recommended"} />
              </span>
              <span>
                {item.missingRate >= 0.3
                  ? "High missingness. Consider row handling before estimating."
                  : item.missingRate > 0
                    ? "Some values are missing."
                    : "No missing values observed."}
              </span>
            </div>
          ))}
        </div>
      </details>

      {diagnostics.treatmentBalance ? (
        <details className="inline-details">
          <summary>
            Treatment balance <span>{diagnostics.treatmentBalance.available ? diagnostics.treatmentBalance.metrics.length : 0}</span>
          </summary>
          <p className="help-text">{diagnostics.treatmentBalance.note}</p>
          {diagnostics.treatmentBalance.available ? (
            <div className="comparison-table">
              <div className="comparison-row comparison-row--header">
                <span>Covariate</span>
                <span>Treated</span>
                <span>Control</span>
                <span>SMD</span>
              </div>
              {diagnostics.treatmentBalance.metrics.map((metric) => (
                <div key={metric.columnName} className="comparison-row">
                  <span>{metric.columnName}</span>
                  <span>{metric.treatedValue}</span>
                  <span>{metric.controlValue}</span>
                  <span>{metric.standardizedDifference?.toFixed(3) ?? "n/a"}</span>
                </div>
              ))}
            </div>
          ) : null}
        </details>
      ) : null}

      {diagnostics.overlapDiagnostics ? (
        <details className="inline-details">
          <summary>
            Overlap diagnostics <span>{diagnostics.overlapDiagnostics.metrics.length}</span>
          </summary>
          <p className="help-text">{diagnostics.overlapDiagnostics.note}</p>
          {diagnostics.overlapDiagnostics.metrics.length ? (
            <div className="comparison-table">
              <div className="comparison-row comparison-row--header">
                <span>Covariate</span>
                <span>Score</span>
                <span>Treated range</span>
                <span>Control range</span>
              </div>
              {diagnostics.overlapDiagnostics.metrics.map((metric) => (
                <div key={metric.columnName} className="comparison-row">
                  <span>{metric.columnName}</span>
                  <span>{metric.overlapScore?.toFixed(3) ?? "n/a"}</span>
                  <span>{metric.treatedRange ?? "n/a"}</span>
                  <span>{metric.controlRange ?? "n/a"}</span>
                </div>
              ))}
            </div>
          ) : null}
          {diagnostics.overlapDiagnostics.warnings.length ? (
            <ul className="mini-step-list">
              {diagnostics.overlapDiagnostics.warnings.map((warning) => (
                <li key={warning}>{warning}</li>
              ))}
            </ul>
          ) : null}
        </details>
      ) : null}
    </div>
  );
}

function IssueList({
  issues,
  emptyLabel,
}: {
  issues: AnalysisResult["validation"]["issues"];
  emptyLabel: string;
}) {
  if (!issues.length) {
    return <p className="empty-state">{emptyLabel}</p>;
  }

  return (
    <div className="issue-list">
      {issues.map((issue) => (
        <article key={`${issue.code}-${issue.message}`} className={`issue issue--${issue.severity}`}>
          <header>
            <span>{issue.severity}</span>
            <strong>{issue.code.replaceAll("_", " ")}</strong>
          </header>
          <p>{issue.message}</p>
        </article>
      ))}
    </div>
  );
}

function FilterChip({ label, active, onClick }: { label: string; active: boolean; onClick: () => void }) {
  return (
    <button type="button" className={active ? "chip chip--active" : "chip"} onClick={onClick}>
      {label}
    </button>
  );
}

function AssumptionCard({ assumption }: { assumption: NonNullable<AnalysisResult["assumptions"]>[number] }) {
  return (
    <article className={`assumption-card assumption-card--${assumption.level}`}>
      <header>
        <strong>{assumption.title}</strong>
        <span>{assumption.level}</span>
      </header>
      <p>{assumption.description}</p>
    </article>
  );
}

function PathReason({ label, evaluation }: { label: string; evaluation: PathEvaluation }) {
  return (
    <div className="path-reason">
      <div className="path-reason__header">
        <strong>{label}</strong>
        <span className={`pill pill--${evaluation.status}`}>{evaluation.status}</span>
      </div>
      <p>{evaluation.reason}</p>
      {evaluation.steps.length ? (
        <ul className="mini-step-list">
          {evaluation.steps.map((step, index) => (
            <li key={`${step.nodeId}-${step.effect}-${index}`}>{step.explanation}</li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

function RecommendationPill({ value }: { value: "recommended" | "acceptable" | "avoid" }) {
  return <span className={value === "recommended" ? "pill pill--blocked" : value === "avoid" ? "pill pill--open" : "pill"}>{value}</span>;
}

function AdjustmentSetCard({
  adjustmentSet,
  onSelect,
}: {
  adjustmentSet: AdjustmentSetSummary;
  onSelect: () => void;
}) {
  return (
    <article
      className={adjustmentSet.isRecommended ? "adjustment-card adjustment-card--recommended" : "adjustment-card"}
      onClick={onSelect}
    >
      <header>
        <strong>{formatSet(adjustmentSet.variables)}</strong>
        <div className="pill-row">
          <span className={adjustmentSet.isMinimal ? "pill pill--blocked" : "pill"}>{adjustmentSet.isMinimal ? "minimal" : "valid superset"}</span>
          <span className={adjustmentSet.practicalRating === "recommended" ? "pill pill--blocked" : "pill"}>{adjustmentSet.practicalRating}</span>
        </div>
      </header>
      <p>{adjustmentSet.explanation}</p>
      <small>
        Blocks {adjustmentSet.blockedPathIds.length} backdoor path{adjustmentSet.blockedPathIds.length === 1 ? "" : "s"}
        {adjustmentSet.openedPathIds.length ? `; opens ${adjustmentSet.openedPathIds.length} collider-sensitive path(s)` : ""}.
      </small>
      {adjustmentSet.practicalConcerns.length ? (
        <ul className="mini-step-list">
          {adjustmentSet.practicalConcerns.map((concern) => (
            <li key={concern}>{concern}</li>
          ))}
        </ul>
      ) : null}
    </article>
  );
}

function formatSet(values: string[]) {
  return values.length ? `{${values.join(", ")}}` : "{}";
}

function EmptyState({ message }: { message: string }) {
  return <p className="empty-state">{message}</p>;
}

function resolveVariableType(
  nodeId: string | null,
  requestedType: VariableType,
  diagnostics: DataDiagnostics | null | undefined,
): VariableType {
  if (requestedType !== "unknown" || !nodeId || !diagnostics) {
    return requestedType;
  }

  const binding = diagnostics.variableBindings.find((item) => item.nodeId === nodeId && item.columnName);
  if (!binding?.columnName) {
    return requestedType;
  }

  const profile = diagnostics.columnProfiles.find((item) => item.columnName === binding.columnName);
  return profile?.inferredType ?? requestedType;
}

function formatVariableType(variableType: VariableType): string {
  return variableType === "unknown" ? "not specified" : variableType;
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
