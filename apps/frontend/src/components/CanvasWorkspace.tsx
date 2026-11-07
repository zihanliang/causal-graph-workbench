import type { AnalysisResult, ExplainableSelection, GraphSpec, PathEvaluation } from "@causal-graph-workbench/shared";
import type { RefObject } from "react";

import { getExplainableDisplayLabel, getExplainableKindLabel } from "../lib/explainableLabel";
import { formatSet, joinNames } from "../lib/format";
import { MAX_GRAPH_VERSIONS, shortName } from "../lib/graphVersions";
import { selectPreviewArrow, selectStepFocus, useWorkbenchStore } from "../store/useWorkbenchStore";
import { GraphCanvas } from "./GraphCanvas";
import { Icon } from "./ui";

interface CanvasWorkspaceProps {
  graph: GraphSpec;
  analysis: AnalysisResult | null;
  graphShellRef: RefObject<HTMLDivElement>;
}

export function CanvasWorkspace({ graph, analysis, graphShellRef }: CanvasWorkspaceProps) {
  const highlightedPathId = useWorkbenchStore((state) => state.highlightedPathId);
  const selectedExplainable = useWorkbenchStore((state) => state.selectedExplainable);
  const previewArrow = useWorkbenchStore(selectPreviewArrow);
  const stepFocus = useWorkbenchStore(selectStepFocus);
  const versions = useWorkbenchStore((state) => state.versions);
  const activeVersionId = useWorkbenchStore((state) => state.activeVersionId);
  const selectVersion = useWorkbenchStore((state) => state.selectVersion);
  const tryAnotherGraph = useWorkbenchStore((state) => state.tryAnotherGraph);
  const relayoutGraph = useWorkbenchStore((state) => state.relayoutGraph);
  const clearGraph = useWorkbenchStore((state) => state.clearGraph);
  const isDrawing = useWorkbenchStore((state) => state.step === "graph");

  const highlightedPath = analysis?.paths.find((path) => path.id === highlightedPathId) ?? null;
  const hasCausalPath = analysis?.paths.some((path) => path.category === "directed_causal");
  const hasUnsureArrows = useWorkbenchStore((state) => state.uncertainPairs.length > 0);
  const hasFaintArrows = graph.edges.some((edge) => edge.background);
  const hasSeveralGraphs = versions.length > 1;
  const differsFromFirst = hasSeveralGraphs && versions[0].id !== activeVersionId;
  const openBackdoor = analysis?.graphStats.openBackdoorPathCount ?? 0;

  return (
    <section className="canvas" aria-label="Causal graph">
      <GraphCanvas graph={graph} analysis={analysis} graphShellRef={graphShellRef} />

      {graph.nodes.length ? (
        <div className="canvas__tools">
          {versions.length < MAX_GRAPH_VERSIONS ? (
            <button type="button" className="btn btn--overlay" onClick={tryAnotherGraph}>
              Try another graph
            </button>
          ) : null}
          <button type="button" className="btn btn--overlay" onClick={relayoutGraph}>
            Tidy layout
          </button>
          {/* Clearing empties every graph and the file, so with several graphs each is removed on purpose instead. */}
          {isDrawing && !hasSeveralGraphs ? (
            <button type="button" className="btn btn--overlay" onClick={clearGraph}>
              Clear
            </button>
          ) : null}
        </div>
      ) : (
        <div className="canvas__empty">
          <strong>Your graph will appear here</strong>
          <p>Add a variable in the panel to begin.</p>
        </div>
      )}

      <div className="canvas__top">
        {hasSeveralGraphs ? (
          <div className="segmented canvas__versions" role="group" aria-label="Graph on show">
            {versions.map((version) => (
              <button key={version.id} type="button" aria-label={version.name} aria-pressed={version.id === activeVersionId} onClick={() => selectVersion(version.id)}>
                {shortName(version.name)}
              </button>
            ))}
          </div>
        ) : null}
        {hasCausalPath ? (
          <p className="canvas__legend">
            <span className="canvas__swatch" aria-hidden="true" />
            Arrows that carry the effect
          </p>
        ) : null}
        {hasUnsureArrows ? (
          <p className="canvas__legend">
            <span className="canvas__swatch canvas__swatch--unsure" aria-hidden="true" />
            Not sure about these
          </p>
        ) : null}
        {hasFaintArrows ? (
          <p className="canvas__legend">
            <span className="canvas__swatch canvas__swatch--faint" aria-hidden="true" />
            Allowed by time order
          </p>
        ) : null}
        {differsFromFirst ? (
          <p className="canvas__legend">
            <span className="canvas__swatch canvas__swatch--what-if" aria-hidden="true" />
            Differs from {versions[0].name}
          </p>
        ) : null}
      </div>

      <div className="canvas__note">
        {selectedExplainable && analysis ? (
          <ExplainCard analysis={analysis} selection={selectedExplainable} />
        ) : previewArrow ? (
          <div className="note">
            <strong>
              {previewArrow.edit === "add"
                ? `If ${previewArrow.source} → ${previewArrow.target} exists`
                : previewArrow.edit === "reverse"
                  ? `If ${previewArrow.target} → ${previewArrow.source}, not the way you drew it`
                  : `If ${previewArrow.source} → ${previewArrow.target} does not exist`}
            </strong>
            <p>Shown for comparison. Your graph has not changed.</p>
          </div>
        ) : highlightedPath ? (
          <div className="note">
            <strong>{highlightedPath.pathString}</strong>
            <p>{highlightedPath.defaultEvaluation.reason}</p>
          </div>
        ) : stepFocus === "paths" ? (
          <div className="note">
            <strong>{openBackdoor === 0 ? "No backdoor path is open before adjusting" : openBackdoor === 1 ? "1 backdoor path is open before adjusting" : `${openBackdoor} backdoor paths are open before adjusting`}</strong>
            <p>{openBackdoor ? "Their arrows are the dark ones. The orange arrows carry the effect." : "The orange arrows carry the effect."}</p>
          </div>
        ) : stepFocus === "set" && analysis?.baselineSet?.length ? (
          <div className="note">
            <strong>Adjusting for {joinNames(analysis.baselineSet)}</strong>
            <p>{analysis.forbiddenVariables.length ? "Those are outlined. Names struck through should not be adjusted for." : "Those are outlined."}</p>
          </div>
        ) : graph.nodes.length >= 2 && !graph.edges.length ? (
          <div className="note">
            <strong>Draw an arrow for each direct cause</strong>
            <p>Drag from the dot on the right of one variable to the dot on the left of another.</p>
          </div>
        ) : null}
      </div>
    </section>
  );
}

/** Explains whatever was clicked, next to the graph it is about. */
function ExplainCard({ analysis, selection }: { analysis: AnalysisResult; selection: ExplainableSelection }) {
  const setSelectedExplainable = useWorkbenchStore((state) => state.setSelectedExplainable);
  const body = explainBody(analysis, selection);
  if (!body) {
    return null;
  }
  return (
    <aside className="note note--explain" aria-label="Explanation">
      <header>
        <span>{getExplainableKindLabel(selection)}</span>
        <button type="button" className="icon-button" aria-label="Close explanation" onClick={() => setSelectedExplainable(null)}>
          <Icon name="close" />
        </button>
      </header>
      <strong>{getExplainableDisplayLabel(analysis, selection)}</strong>
      {body}
    </aside>
  );
}

function Evaluation({ label, evaluation }: { label: string; evaluation: PathEvaluation }) {
  return (
    <>
      <p>
        <b>
          {label}, {evaluation.status}.
        </b>{" "}
        {evaluation.reason}
      </p>
      {evaluation.steps.length > 1 ? (
        <ul>
          {evaluation.steps.map((step, index) => (
            <li key={`${step.nodeId}-${step.effect}-${index}`}>{step.explanation}</li>
          ))}
        </ul>
      ) : null}
    </>
  );
}

function explainBody(analysis: AnalysisResult, selection: ExplainableSelection) {
  if (selection.kind === "node") {
    const role = analysis.nodeRoles.find((item) => item.nodeId === selection.id);
    if (!role) {
      return <p>This is the variable you selected as treatment or outcome.</p>;
    }
    return (
      <>
        <p>{role.summary}</p>
        <ul>
          {role.evidence.map((item) => (
            <li key={item}>{item}</li>
          ))}
        </ul>
      </>
    );
  }

  if (selection.kind === "path") {
    const path = analysis.paths.find((item) => item.id === selection.id);
    if (!path) {
      return null;
    }
    const baseline = analysis.baselineSet ? [...analysis.baselineSet].sort().join() : null;
    const adjusted = path.adjustmentEvaluations.find((evaluation) => [...evaluation.conditioningSet].sort().join() === baseline);
    return (
      <>
        <p>{path.explanation}</p>
        <Evaluation label="With no adjustment" evaluation={path.defaultEvaluation} />
        {adjusted ? <Evaluation label={`Adjusting for ${formatSet(adjusted.conditioningSet)}`} evaluation={adjusted} /> : null}
      </>
    );
  }

  if (selection.kind === "adjustment") {
    const adjustmentSet = analysis.adjustmentSets.find((item) => item.id === selection.id);
    if (!adjustmentSet) {
      return null;
    }
    return (
      <>
        <p>{adjustmentSet.explanation}</p>
        {adjustmentSet.practicalConcerns.length ? (
          <ul>
            {adjustmentSet.practicalConcerns.map((concern) => (
              <li key={concern}>{concern}</li>
            ))}
          </ul>
        ) : null}
      </>
    );
  }

  const estimator = analysis.estimatorRecommendations.find((item) => item.id === selection.id);
  if (!estimator) {
    return null;
  }
  return (
    <>
      <p>{estimator.summary}</p>
      <ul>
        {[...estimator.rationale, ...estimator.caveats].map((item) => (
          <li key={item}>{item}</li>
        ))}
      </ul>
      <code>{estimator.formulaPreview}</code>
    </>
  );
}
