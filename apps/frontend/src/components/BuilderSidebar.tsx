import type { ChangeEvent, MouseEvent } from "react";
import { useEffect, useMemo, useRef, useState } from "react";

import { CollapsibleSection } from "./CollapsibleSection";
import { SectionCard } from "./SectionCard";
import { buildExampleProjectSnapshot, exampleProjects } from "../lib/exampleProjects";
import { useWorkbenchStore } from "../store/useWorkbenchStore";

type BuilderPageId = "start" | "graph" | "data";

const BUILDER_PAGES: { id: BuilderPageId; label: string; title: string; subtitle: string }[] = [
  {
    id: "start",
    label: "Start",
    title: "Load or sketch the DAG",
    subtitle: "Begin from an example, a preset template, or a pasted edge list.",
  },
  {
    id: "graph",
    label: "Graph",
    title: "Choose treatment and outcome",
    subtitle: "Edit variables and edges, then make the causal question explicit.",
  },
  {
    id: "data",
    label: "Data",
    title: "Optional data context",
    subtitle: "Attach a CSV only if you want cautious diagnostics and code binding.",
  },
];

export function BuilderSidebar() {
  const graph = useWorkbenchStore((state) => state.graph);
  const templates = useWorkbenchStore((state) => state.templates);
  const textDraft = useWorkbenchStore((state) => state.textDraft);
  const parseError = useWorkbenchStore((state) => state.parseError);
  const dataContext = useWorkbenchStore((state) => state.dataContext);
  const analysis = useWorkbenchStore((state) => state.analysis);
  const uploadedDataset = useWorkbenchStore((state) => state.uploadedDataset);
  const selectedExplainable = useWorkbenchStore((state) => state.selectedExplainable);
  const applyTemplate = useWorkbenchStore((state) => state.applyTemplate);
  const hydrateProject = useWorkbenchStore((state) => state.hydrateProject);
  const setTextDraft = useWorkbenchStore((state) => state.setTextDraft);
  const importFromText = useWorkbenchStore((state) => state.importFromText);
  const addNode = useWorkbenchStore((state) => state.addNode);
  const renameNode = useWorkbenchStore((state) => state.renameNode);
  const connectNodes = useWorkbenchStore((state) => state.connectNodes);
  const removeNode = useWorkbenchStore((state) => state.removeNode);
  const removeEdge = useWorkbenchStore((state) => state.removeEdge);
  const relayoutGraph = useWorkbenchStore((state) => state.relayoutGraph);
  const clearGraph = useWorkbenchStore((state) => state.clearGraph);
  const setUploadedDataset = useWorkbenchStore((state) => state.setUploadedDataset);
  const setTreatment = useWorkbenchStore((state) => state.setTreatment);
  const setOutcome = useWorkbenchStore((state) => state.setOutcome);
  const setDataContext = useWorkbenchStore((state) => state.setDataContext);
  const setSelectedExplainable = useWorkbenchStore((state) => state.setSelectedExplainable);

  const [newNodeLabel, setNewNodeLabel] = useState("");
  const [selectedTemplateId, setSelectedTemplateId] = useState(templates[0]?.id ?? "");
  const [edgeSource, setEdgeSource] = useState("");
  const [edgeTarget, setEdgeTarget] = useState("");
  const [loadingExampleId, setLoadingExampleId] = useState<string | null>(null);
  const [exampleError, setExampleError] = useState<string | null>(null);
  const [activePage, setActivePage] = useState<BuilderPageId>("start");
  const dataFileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!templates.find((template) => template.id === selectedTemplateId)) {
      setSelectedTemplateId(templates[0]?.id ?? "");
    }
  }, [selectedTemplateId, templates]);

  useEffect(() => {
    if (edgeSource && !graph.nodes.find((node) => node.id === edgeSource)) {
      setEdgeSource("");
    }
    if (edgeTarget && !graph.nodes.find((node) => node.id === edgeTarget)) {
      setEdgeTarget("");
    }
  }, [edgeSource, edgeTarget, graph.nodes]);

  const roleLookup = useMemo(
    () => new Map(analysis?.nodeRoles.map((item) => [item.nodeId, item.roles]) ?? []),
    [analysis?.nodeRoles],
  );

  const selectedTemplate = templates.find((template) => template.id === selectedTemplateId) ?? templates[0];

  const handleTemplateChange = (event: ChangeEvent<HTMLSelectElement>) => {
    const templateId = event.target.value;
    setSelectedTemplateId(templateId);
    applyTemplate(templateId);
  };

  const canConnectEdge =
    Boolean(edgeSource && edgeTarget) &&
    edgeSource !== edgeTarget &&
    !graph.edges.some((edge) => edge.source === edgeSource && edge.target === edgeTarget);

  const pageIndex = BUILDER_PAGES.findIndex((page) => page.id === activePage);
  const activePageMeta = BUILDER_PAGES[pageIndex] ?? BUILDER_PAGES[0];
  const goToPage = (direction: -1 | 1) => {
    const nextIndex = Math.max(0, Math.min(BUILDER_PAGES.length - 1, pageIndex + direction));
    setActivePage(BUILDER_PAGES[nextIndex].id);
  };

  return (
    <aside className="builder-sidebar">
      <SectionCard
        title="Builder"
        actions={<span className="status-pill status-pill--success">step {pageIndex + 1} / {BUILDER_PAGES.length}</span>}
        className="builder-sidebar__shell"
      >
        <p className="help-text">
          Keep the build flow tight: load or sketch the DAG, move to Graph to set the question, then add data only if
          you need diagnostics or column binding.
        </p>

        <div className="tabs tabs--builder">
          {BUILDER_PAGES.map((page) => (
            <button
              key={page.id}
              type="button"
              className={page.id === activePage ? "tab tab--active" : "tab"}
              onClick={() => setActivePage(page.id)}
            >
              {page.label}
            </button>
          ))}
        </div>

        <div className="builder-sidebar__page-heading">
          <div>
            <span className="eyebrow">Builder page</span>
            <strong>{activePageMeta.title}</strong>
          </div>
          <p>{activePageMeta.subtitle}</p>
        </div>

        <div className="builder-sidebar__page-body">
          {activePage === "start" ? (
            <div className="builder-section">
              <div className="workflow-steps">
                <span>1. Start from an example, template, or edge list.</span>
                <span>2. Move to Graph and pick treatment and outcome.</span>
                <span>3. Use the right panel only after the structural question is explicit.</span>
              </div>

              <div className="builder-group">
                <div className="builder-group__header">
                  <strong>Examples</strong>
                  <span className="help-text">Fastest way to understand the workflow end to end.</span>
                </div>
                <div className="example-grid example-grid--compact">
                  {exampleProjects.map((example) => (
                    <button
                      key={example.id}
                      type="button"
                      className="example-button"
                      disabled={loadingExampleId === example.id}
                      onClick={async () => {
                        try {
                          setExampleError(null);
                          setLoadingExampleId(example.id);
                          const snapshot = await buildExampleProjectSnapshot(example);
                          hydrateProject(snapshot);
                        } catch (error) {
                          setExampleError(error instanceof Error ? error.message : "Failed to load example project.");
                        } finally {
                          setLoadingExampleId(null);
                        }
                      }}
                    >
                      <strong>{loadingExampleId === example.id ? "Loading…" : example.name}</strong>
                      <span>{example.description}</span>
                    </button>
                  ))}
                </div>
                {exampleError ? <p className="inline-error">{exampleError}</p> : null}
              </div>

              <div className="builder-group">
                <div className="builder-group__header">
                  <strong>Template</strong>
                  <span className="help-text">{selectedTemplate?.description}</span>
                </div>
                <label className="field">
                  <span>Preset DAG</span>
                  <select value={selectedTemplateId} onChange={handleTemplateChange}>
                    {templates.map((template) => (
                      <option key={template.id} value={template.id}>
                        {template.name}
                      </option>
                    ))}
                  </select>
                </label>
              </div>

              <div className="builder-group">
                <div className="builder-group__header">
                  <strong>Paste edges</strong>
                  <span className="help-text">Use one arrow per line, such as `Z -&gt; X`.</span>
                </div>
                <textarea
                  value={textDraft}
                  onChange={(event) => setTextDraft(event.target.value)}
                  placeholder={"Z -> X\nZ -> Y\nX -> Y"}
                  rows={8}
                />
                <div className="builder-inline-actions">
                  <button type="button" disabled={Boolean(parseError)} onClick={importFromText}>
                    Apply edge list
                  </button>
                  <span className={parseError ? "inline-error" : "help-text"}>
                    {parseError ?? "Parser feedback updates as you type."}
                  </span>
                </div>
              </div>
            </div>
          ) : null}

          {activePage === "graph" ? (
            <div className="builder-section">
              <div className="builder-group builder-group--compact">
                <div className="builder-group__header">
                  <strong>Treatment and outcome</strong>
                  <span className="help-text">The workbench never guesses these from layout.</span>
                </div>
                <div className="split-fields">
                  <label className="field">
                    <span>Treatment</span>
                    <select value={graph.treatmentId ?? ""} onChange={(event) => setTreatment(event.target.value || null)}>
                      <option value="">Select treatment</option>
                      {graph.nodes.map((node) => (
                        <option key={node.id} value={node.id}>
                          {node.label}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="field">
                    <span>Outcome</span>
                    <select value={graph.outcomeId ?? ""} onChange={(event) => setOutcome(event.target.value || null)}>
                      <option value="">Select outcome</option>
                      {graph.nodes.map((node) => (
                        <option key={node.id} value={node.id}>
                          {node.label}
                        </option>
                      ))}
                    </select>
                  </label>
                </div>
              </div>

              <div className="builder-group builder-group--compact">
                <div className="builder-group__header">
                  <strong>Quick edits</strong>
                  <span className="help-text">Add variables here. Draw arrows on the canvas, or open advanced edge controls if needed.</span>
                </div>
                <div className="editor-grid">
                  <div className="editor-panel">
                    <span className="editor-panel__label">Add variable</span>
                    <div className="inline-form">
                      <input
                        value={newNodeLabel}
                        onChange={(event) => setNewNodeLabel(event.target.value)}
                        placeholder="New node label"
                      />
                      <button
                        type="button"
                        onClick={() => {
                          if (!newNodeLabel.trim()) {
                            return;
                          }
                          addNode(newNodeLabel);
                          setNewNodeLabel("");
                        }}
                      >
                        Add
                      </button>
                    </div>
                  </div>
                </div>

                <div className="button-row">
                  <button type="button" className="button--ghost" onClick={relayoutGraph}>
                    Auto layout
                  </button>
                  <button type="button" className="button--ghost button--danger" onClick={clearGraph}>
                    Clear graph
                  </button>
                </div>
              </div>

              <div className="builder-group">
                <div className="builder-group__header">
                  <strong>Variables</strong>
                  <span className="help-text">Click a row to explain that variable’s structural role.</span>
                </div>
                <div className="node-list">
                  {graph.nodes.length ? (
                    graph.nodes
                      .slice()
                      .sort((left, right) => left.id.localeCompare(right.id))
                      .map((node) => (
                        <NodeRow
                          key={node.id}
                          nodeId={node.id}
                          isSelected={selectedExplainable?.kind === "node" && selectedExplainable.id === node.id}
                          isTreatment={graph.treatmentId === node.id}
                          isOutcome={graph.outcomeId === node.id}
                          roles={roleLookup.get(node.id) ?? []}
                          onSelect={() => setSelectedExplainable({ kind: "node", id: node.id })}
                          onDelete={() => removeNode(node.id)}
                          onRename={(value) => renameNode(node.id, value)}
                        />
                      ))
                  ) : (
                    <p className="empty-state">No variables yet. Load an example, paste edges, or add one above.</p>
                  )}
                </div>
              </div>

              <details className="inline-details">
                <summary>
                  Advanced edge controls <span>{graph.edges.length}</span>
                </summary>
                <div className="stack">
                  <p className="help-text">Tip: on the canvas, drag from a node handle to create an arrow. Use the controls below if you prefer forms.</p>
                  <div className="editor-panel">
                    <span className="editor-panel__label">Connect edge</span>
                    <div className="connect-grid">
                      <select value={edgeSource} onChange={(event) => setEdgeSource(event.target.value)}>
                        <option value="">Source</option>
                        {graph.nodes.map((node) => (
                          <option key={node.id} value={node.id}>
                            {node.label}
                          </option>
                        ))}
                      </select>
                      <select value={edgeTarget} onChange={(event) => setEdgeTarget(event.target.value)}>
                        <option value="">Target</option>
                        {graph.nodes.map((node) => (
                          <option key={node.id} value={node.id}>
                            {node.label}
                          </option>
                        ))}
                      </select>
                      <button
                        type="button"
                        disabled={!canConnectEdge}
                        onClick={() => {
                          if (!canConnectEdge) {
                            return;
                          }
                          connectNodes(edgeSource, edgeTarget);
                          setEdgeSource("");
                          setEdgeTarget("");
                        }}
                      >
                        Create edge
                      </button>
                    </div>
                  </div>

                  <div className="edge-list">
                    {graph.edges.length ? (
                      graph.edges
                        .slice()
                        .sort((left, right) => left.source.localeCompare(right.source) || left.target.localeCompare(right.target))
                        .map((edge) => (
                          <article key={edge.id} className="edge-row">
                            <strong>{edge.source}</strong>
                            <span>→</span>
                            <strong>{edge.target}</strong>
                            <button type="button" className="button--ghost edge-row__remove" onClick={() => removeEdge(edge.id)}>
                              Remove
                            </button>
                          </article>
                        ))
                    ) : (
                      <p className="empty-state">No edges in the current graph.</p>
                    )}
                  </div>
                </div>
              </details>
            </div>
          ) : null}

          {activePage === "data" ? (
            <div className="builder-section">
              <div className="builder-inline-actions">
                <button type="button" onClick={() => dataFileInputRef.current?.click()}>
                  Upload CSV
                </button>
                {uploadedDataset ? (
                  <button type="button" className="button--ghost" onClick={() => setUploadedDataset(null)}>
                    Clear CSV
                  </button>
                ) : null}
              </div>

              <input
                ref={dataFileInputRef}
                type="file"
                accept=".csv,text/csv"
                hidden
                onChange={async (event) => {
                  const file = event.target.files?.[0];
                  if (!file) {
                    return;
                  }
                  const content = await file.text();
                  setUploadedDataset({ filename: file.name, content });
                  event.currentTarget.value = "";
                }}
              />

              {uploadedDataset ? (
                <div className="dataset-summary">
                  <strong>{uploadedDataset.filename ?? "uploaded.csv"}</strong>
                  <p>
                    {analysis?.dataDiagnostics
                      ? `${analysis.dataDiagnostics.rowCount} rows, ${analysis.dataDiagnostics.columnCount} columns. Open Checks for detailed diagnostics.`
                      : "Dataset uploaded and queued for analysis."}
                  </p>
                </div>
              ) : (
                <p className="help-text">Adding data does not validate the DAG. It only unlocks cautious diagnostics and code binding.</p>
              )}

              <CollapsibleSection
                title="Estimator context"
                subtitle="Optional overrides if you want to guide the estimator recommendation."
                badge={<span className="status-pill">optional</span>}
                defaultOpen={false}
                className="builder-sidebar__nested-card"
              >
                <div className="stack">
                  <div className="split-fields">
                    <label className="field">
                      <span>Treatment type</span>
                      <select
                        value={dataContext.treatmentType}
                        onChange={(event) => setDataContext({ treatmentType: event.target.value as typeof dataContext.treatmentType })}
                      >
                        <option value="binary">binary</option>
                        <option value="continuous">continuous</option>
                        <option value="categorical">categorical</option>
                        <option value="unknown">unknown</option>
                      </select>
                    </label>
                    <label className="field">
                      <span>Outcome type</span>
                      <select
                        value={dataContext.outcomeType}
                        onChange={(event) => setDataContext({ outcomeType: event.target.value as typeof dataContext.outcomeType })}
                      >
                        <option value="continuous">continuous</option>
                        <option value="binary">binary</option>
                        <option value="categorical">categorical</option>
                        <option value="unknown">unknown</option>
                      </select>
                    </label>
                  </div>

                  <label className="field field--checkbox">
                    <input
                      type="checkbox"
                      checked={Boolean(dataContext.highDimensional)}
                      onChange={(event) => setDataContext({ highDimensional: event.target.checked })}
                    />
                    <span>Potentially high-dimensional confounder set</span>
                  </label>
                </div>
              </CollapsibleSection>
            </div>
          ) : null}
        </div>

        <div className="builder-sidebar__footer">
          <span className="help-text">
            Page {pageIndex + 1} of {BUILDER_PAGES.length}
          </span>
          <div className="button-row">
            <button type="button" className="button--ghost" disabled={pageIndex === 0} onClick={() => goToPage(-1)}>
              Previous
            </button>
            <button type="button" disabled={pageIndex === BUILDER_PAGES.length - 1} onClick={() => goToPage(1)}>
              Next
            </button>
          </div>
        </div>
      </SectionCard>
    </aside>
  );
}

function NodeRow({
  nodeId,
  roles,
  isSelected,
  isTreatment,
  isOutcome,
  onRename,
  onDelete,
  onSelect,
}: {
  nodeId: string;
  roles: string[];
  isSelected: boolean;
  isTreatment: boolean;
  isOutcome: boolean;
  onRename: (value: string) => void;
  onDelete: () => void;
  onSelect: () => void;
}) {
  const [draftName, setDraftName] = useState(nodeId);

  useEffect(() => {
    setDraftName(nodeId);
  }, [nodeId]);

  const stopRowClick = (event: MouseEvent<HTMLElement>) => {
    event.stopPropagation();
  };

  return (
    <article className={isSelected ? "node-row node-row--selected" : "node-row"} onClick={onSelect}>
      <div className="node-row__main">
        <input
          value={draftName}
          onClick={stopRowClick}
          onChange={(event) => setDraftName(event.target.value)}
          onBlur={() => {
            if (draftName.trim() && draftName !== nodeId) {
              onRename(draftName);
            }
          }}
          className="node-row__input"
        />
        <div className="pill-row">
          {isTreatment ? <span className="pill pill--treatment">treatment</span> : null}
          {isOutcome ? <span className="pill pill--outcome">outcome</span> : null}
          {roles.map((role) => (
            <span key={role} className={`pill pill--role-${role}`}>
              {role.replaceAll("_", " ")}
            </span>
          ))}
        </div>
      </div>

      <div className="node-row__actions">
        <button
          type="button"
          className="button--ghost icon-button icon-button--danger"
          onClick={(event) => {
            stopRowClick(event);
            onDelete();
          }}
        >
          Remove
        </button>
      </div>
    </article>
  );
}
