import type { AnalysisResult, GraphNode, RoleType, VariableTiming } from "@causal-graph-workbench/shared";
import { useEffect, useRef, useState } from "react";

import { roleCaption } from "../lib/format";
import { selectIsDraft, useWorkbenchStore } from "../store/useWorkbenchStore";
import { MAX_UNCERTAIN_PAIRS, samePair } from "../lib/graphVersions";
import { Disclosure, Icon, IssueList, Notice } from "./ui";

const TIMING_OPTIONS: { value: VariableTiming | ""; label: string }[] = [
  { value: "", label: "Timing not set" },
  { value: "baseline", label: "Fixed at baseline" },
  { value: "before", label: "Before treatment" },
  { value: "after", label: "After treatment" },
];

const STILL_DRAWING = new Set(["isolated_node", "treatment_outcome_unreachable", "no_directed_path"]);

export function GraphStep({ analysis }: { analysis: AnalysisResult | null }) {
  const graph = useWorkbenchStore((state) => state.graph);
  const textDraft = useWorkbenchStore((state) => state.textDraft);
  const parseError = useWorkbenchStore((state) => state.parseError);
  const graphTextOpen = useWorkbenchStore((state) => state.graphTextOpen);
  const selectedExplainable = useWorkbenchStore((state) => state.selectedExplainable);
  const setTreatment = useWorkbenchStore((state) => state.setTreatment);
  const setOutcome = useWorkbenchStore((state) => state.setOutcome);
  const addNode = useWorkbenchStore((state) => state.addNode);
  const renameNode = useWorkbenchStore((state) => state.renameNode);
  const removeNode = useWorkbenchStore((state) => state.removeNode);
  const removeEdge = useWorkbenchStore((state) => state.removeEdge);
  const connectNodes = useWorkbenchStore((state) => state.connectNodes);
  const setNodeObserved = useWorkbenchStore((state) => state.setNodeObserved);
  const setNodeTiming = useWorkbenchStore((state) => state.setNodeTiming);
  const setTextDraft = useWorkbenchStore((state) => state.setTextDraft);
  const importFromText = useWorkbenchStore((state) => state.importFromText);
  const setSelectedExplainable = useWorkbenchStore((state) => state.setSelectedExplainable);
  const setStep = useWorkbenchStore((state) => state.setStep);
  const isTouring = useWorkbenchStore((state) => state.tourStop !== null);
  const versions = useWorkbenchStore((state) => state.versions);
  const activeVersionId = useWorkbenchStore((state) => state.activeVersionId);
  const isDraft = useWorkbenchStore(selectIsDraft);
  const uncertainPairs = useWorkbenchStore((state) => state.uncertainPairs);
  const addUncertainPair = useWorkbenchStore((state) => state.addUncertainPair);
  const removeUncertainPair = useWorkbenchStore((state) => state.removeUncertainPair);

  const [newName, setNewName] = useState("");
  // One variable's settings at a time, so a long list still fits on the screen.
  const [openVariable, setOpenVariable] = useState<string | null>(null);
  const [edgeSource, setEdgeSource] = useState("");
  const [edgeTarget, setEdgeTarget] = useState("");

  useEffect(() => {
    if (edgeSource && !graph.nodes.some((node) => node.id === edgeSource)) {
      setEdgeSource("");
    }
    if (edgeTarget && !graph.nodes.some((node) => node.id === edgeTarget)) {
      setEdgeTarget("");
    }
  }, [edgeSource, edgeTarget, graph.nodes]);

  // Clicking a variable on the graph opens the same row in the list.
  useEffect(() => {
    if (selectedExplainable?.kind === "node") {
      setOpenVariable(selectedExplainable.id);
    }
  }, [selectedExplainable]);

  const roles = new Map(analysis?.nodeRoles.map((item) => [item.nodeId, item.roles]) ?? []);
  // Nothing here should read as a mistake while the person is still drawing: the question above
  // already asks for the treatment and outcome, and every variable is disconnected at first.
  const issues = (analysis?.validation.issues ?? []).filter(
    (issue) =>
      issue.severity !== "info" &&
      issue.code !== "missing_treatment" &&
      issue.code !== "missing_outcome" &&
      (graph.edges.length > 0 || !STILL_DRAWING.has(issue.code)),
  );
  const nodes = graph.nodes.slice().sort((left, right) => left.id.localeCompare(right.id));
  const canConnect =
    Boolean(edgeSource && edgeTarget) && edgeSource !== edgeTarget && !graph.edges.some((edge) => edge.source === edgeSource && edge.target === edgeTarget);

  const submitNewVariable = () => {
    if (newName.trim()) {
      addNode(newName);
      setNewName("");
    }
  };

  return (
    <>
      <header className="panel__head">
        <h1>Draw your graph</h1>
        <p>Add what you think matters, then draw an arrow for each direct cause.</p>
        {versions.length > 1 ? (
          <p className="hint">
            You are editing {versions.find((version) => version.id === activeVersionId)?.name}. Your other graphs stay as they were. The question, and whether and when each variable is measured, are the same in all of them.
          </p>
        ) : null}
        {isDraft ? (
          <Notice>
            <strong>This first graph says only what time order allows:</strong> anything earlier may affect anything later, so the data has nothing to contradict, and every variable measured before treatment is adjusted for. That goes wrong if
            something unmeasured affects both treatment and outcome, or if an earlier variable is itself an effect of two unmeasured causes. Remove the arrows you are sure do not exist, and the data can start checking you.{" "}
            <button type="button" className="link-button" onClick={() => setStep("result")}>
              See the result
            </button>
          </Notice>
        ) : null}
      </header>

      <div className="panel__body">
        {graph.nodes.length >= 2 ? (
          <section className="group">
            <h2>Which effect do you want to know?</h2>
            <div className="question">
              <label className="field">
                <span>Treatment</span>
                <select value={graph.treatmentId ?? ""} onChange={(event) => setTreatment(event.target.value || null)}>
                  <option value="">Choose…</option>
                  {graph.nodes.map((node) => (
                    <option key={node.id} value={node.id}>
                      {node.label}
                    </option>
                  ))}
                </select>
              </label>
              <span className="question__arrow" aria-hidden="true" />
              <label className="field">
                <span>Outcome</span>
                <select value={graph.outcomeId ?? ""} onChange={(event) => setOutcome(event.target.value || null)}>
                  <option value="">Choose…</option>
                  {graph.nodes.map((node) => (
                    <option key={node.id} value={node.id}>
                      {node.label}
                    </option>
                  ))}
                </select>
              </label>
            </div>
            <IssueList issues={issues} />
          </section>
        ) : null}

        <section className="group">
          <h2>Variables</h2>
          {graph.nodes.some((node) => node.id !== graph.treatmentId && node.id !== graph.outcomeId) ? (
            <p className="hint">Open a variable to say whether you measured it, and when it is fixed.</p>
          ) : null}
          <form
            className="inline-form"
            onSubmit={(event) => {
              event.preventDefault();
              submitNewVariable();
            }}
          >
            <input aria-label="New variable name" value={newName} onChange={(event) => setNewName(event.target.value)} placeholder="Add a variable" />
            <button type="submit" className="btn" disabled={!newName.trim()}>
              Add
            </button>
          </form>

          {nodes.length ? (
            <ul className="var-list">
              {nodes.map((node) => (
                <VariableRow
                  key={node.id}
                  node={node}
                  caption={roleCaption(node.id, node.observed !== false, graph, roles.get(node.id) ?? ([] as RoleType[]))}
                  isEndpoint={graph.treatmentId === node.id || graph.outcomeId === node.id}
                  isOpen={openVariable === node.id}
                  onToggle={() => {
                    const opening = openVariable !== node.id;
                    setOpenVariable(opening ? node.id : null);
                    setSelectedExplainable(opening ? { kind: "node", id: node.id } : null);
                  }}
                  onRename={(value) => renameNode(node.id, value)}
                  onRemove={() => removeNode(node.id)}
                  onObservedChange={(observed) => setNodeObserved(node.id, observed)}
                  onTimingChange={(timing) => setNodeTiming(node.id, timing)}
                />
              ))}
            </ul>
          ) : null}
        </section>

        <Disclosure title="Arrows" count={graph.edges.length} key={`arrows-${graph.edges.length === 0}`}>
          <div className="connect">
            <select aria-label="Arrow from" value={edgeSource} onChange={(event) => setEdgeSource(event.target.value)}>
              <option value="">From…</option>
              {graph.nodes.map((node) => (
                <option key={node.id} value={node.id}>
                  {node.label}
                </option>
              ))}
            </select>
            <select aria-label="Arrow to" value={edgeTarget} onChange={(event) => setEdgeTarget(event.target.value)}>
              <option value="">To…</option>
              {graph.nodes.map((node) => (
                <option key={node.id} value={node.id}>
                  {node.label}
                </option>
              ))}
            </select>
            <button
              type="button"
              className="btn"
              disabled={!canConnect}
              onClick={() => {
                connectNodes(edgeSource, edgeTarget);
                setEdgeSource("");
                setEdgeTarget("");
              }}
            >
              Add arrow
            </button>
          </div>
          {graph.edges.length ? (
            <ul className="arrow-list">
              {graph.edges
                .slice()
                .sort((left, right) => left.source.localeCompare(right.source) || left.target.localeCompare(right.target))
                .map((edge) => {
                  const pair = { first: edge.source, second: edge.target };
                  const isUnsure = uncertainPairs.some((item) => samePair(item, pair));
                  const isQuestion = samePair(pair, { first: graph.treatmentId ?? "", second: graph.outcomeId ?? "" });
                  return (
                    <li key={edge.id}>
                      <span>
                        {edge.source} → {edge.target}
                      </span>
                      {isQuestion ? null : (
                        <label className="check arrow-list__unsure">
                          <input
                            type="checkbox"
                            aria-label={`Not sure about ${edge.source} to ${edge.target}`}
                            checked={isUnsure}
                            disabled={!isUnsure && uncertainPairs.length >= MAX_UNCERTAIN_PAIRS}
                            onChange={(event) => (event.target.checked ? addUncertainPair(edge.source, edge.target) : removeUncertainPair(pair))}
                          />
                          <span>Not sure</span>
                        </label>
                      )}
                      <button type="button" className="icon-button" aria-label={`Remove arrow ${edge.source} to ${edge.target}`} onClick={() => removeEdge(edge.id)}>
                        <Icon name="close" />
                      </button>
                    </li>
                  );
                })}
            </ul>
          ) : null}
        </Disclosure>

        <Disclosure title="Edit as text" defaultOpen={graphTextOpen} key={`text-${graphTextOpen}`}>
          <p className="hint">
            One arrow per line, such as <code>Z -&gt; X</code>. Mark a variable you did not measure with <code>U [unobserved]</code>.
          </p>
          <textarea aria-label="Graph as text" value={textDraft} rows={7} spellCheck={false} placeholder={"Z -> X\nZ -> Y\nX -> Y"} onChange={(event) => setTextDraft(event.target.value)} />
          {parseError ? <p className="field-error">{parseError}</p> : null}
          <button type="button" className="btn" disabled={Boolean(parseError)} onClick={importFromText}>
            Apply to graph
          </button>
        </Disclosure>
      </div>

      {isTouring ? null : (
        <footer className="panel__foot">
          <button type="button" className="btn btn--primary" onClick={() => setStep("data")}>
            Next: add your data
          </button>
          <button type="button" className="btn btn--text" onClick={() => setStep("result")}>
            Skip to the result
          </button>
        </footer>
      )}
    </>
  );
}

function VariableRow({
  node,
  caption,
  isEndpoint,
  isOpen,
  onToggle,
  onRename,
  onRemove,
  onObservedChange,
  onTimingChange,
}: {
  node: GraphNode;
  caption: string | null;
  isEndpoint: boolean;
  isOpen: boolean;
  onToggle: () => void;
  onRename: (value: string) => void;
  onRemove: () => void;
  onObservedChange: (observed: boolean) => void;
  onTimingChange: (timing: VariableTiming | null) => void;
}) {
  const [draftName, setDraftName] = useState(node.id);
  const isCancelling = useRef(false);
  useEffect(() => setDraftName(node.id), [node.id]);

  return (
    <li className={isOpen ? "var var--open" : "var"} onClick={onToggle}>
      <div className="var__main">
        <button
          type="button"
          className="icon-button"
          aria-expanded={isOpen}
          aria-label={`About ${node.id}`}
          onClick={(event) => {
            event.stopPropagation();
            onToggle();
          }}
        >
          <Icon name={isOpen ? "chevronDown" : "chevronRight"} />
        </button>
        <input
          className="var__name"
          aria-label={`Name of ${node.id}`}
          value={draftName}
          onClick={(event) => event.stopPropagation()}
          onChange={(event) => setDraftName(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.currentTarget.blur();
            } else if (event.key === "Escape") {
              isCancelling.current = true;
              event.currentTarget.blur();
            }
          }}
          onBlur={() => {
            if (!isCancelling.current && draftName.trim() && draftName !== node.id) {
              onRename(draftName);
            }
            isCancelling.current = false;
            // An empty box, or one that cleans up to the same name, goes back to showing the real name.
            setDraftName(node.id);
          }}
        />
        {caption ? <span className="var__role">{caption}</span> : null}
        <button
          type="button"
          className="icon-button"
          aria-label={`Remove ${node.id}`}
          onClick={(event) => {
            event.stopPropagation();
            onRemove();
          }}
        >
          <Icon name="close" />
        </button>
      </div>
      {isOpen && !isEndpoint ? (
        <div className="var__settings" onClick={(event) => event.stopPropagation()}>
          <label className="check">
            <input type="checkbox" checked={node.observed !== false} onChange={(event) => onObservedChange(event.target.checked)} />
            <span>Measured</span>
          </label>
          <select aria-label={`When ${node.id} is fixed`} value={node.timing ?? ""} onChange={(event) => onTimingChange((event.target.value || null) as VariableTiming | null)}>
            {TIMING_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </div>
      ) : null}
    </li>
  );
}
