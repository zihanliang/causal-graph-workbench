import type { AnalysisResult, GraphSpec } from "@causal-graph-workbench/shared";
import type { RefObject } from "react";

import { GraphCanvas } from "./GraphCanvas";
import { getExplainableDisplayLabel, getExplainableKindLabel } from "../lib/explainableLabel";
import { useWorkbenchStore } from "../store/useWorkbenchStore";

interface CanvasWorkspaceProps {
  graph: GraphSpec;
  analysis: AnalysisResult | null;
  graphShellRef: RefObject<HTMLDivElement>;
}

export function CanvasWorkspace({ graph, analysis, graphShellRef }: CanvasWorkspaceProps) {
  const highlightedPathId = useWorkbenchStore((state) => state.highlightedPathId);
  const selectedExplainable = useWorkbenchStore((state) => state.selectedExplainable);

  const highlightedPath = analysis?.paths.find((path) => path.id === highlightedPathId) ?? null;
  const selectedLabel = getExplainableDisplayLabel(analysis, selectedExplainable);

  return (
    <section className="canvas-workbench">
      <header className="canvas-workbench__header">
        <div>
          <p className="eyebrow">Canvas</p>
          <h2>Build and inspect the DAG</h2>
          <p className="canvas-workbench__subtitle">
            Drag variables, connect arrows, and use the right panel to understand adjustment logic without losing the
            graph context.
          </p>
        </div>

        <div className="canvas-workbench__summary">
          <span className="legend-chip legend-chip--treatment">T</span>
          <span className="legend-chip legend-chip--outcome">Y</span>
          <span className="legend-chip legend-chip--confounder">Confounder</span>
          <span className="legend-chip legend-chip--collider">Collider</span>
          <span className="legend-chip legend-chip--forbidden">Mediator / descendant</span>
        </div>
      </header>

      <div className="canvas-workbench__stage">
        <GraphCanvas graph={graph} analysis={analysis} graphShellRef={graphShellRef} />

        <div className="canvas-overlay canvas-overlay--bottom">
          {!graph.nodes.length ? (
            <div className="canvas-empty-state">
              <span className="eyebrow">Empty graph</span>
              <strong>Start with an example, a template, or a pasted edge list.</strong>
              <p>The same graph state drives validation, path analysis, adjustment guidance, and code generation.</p>
            </div>
          ) : highlightedPath ? (
            <div className="path-focus-banner">
              <span className="eyebrow">Path focus</span>
              <strong>{highlightedPath.pathString}</strong>
              <p>{highlightedPath.defaultEvaluation.reason}</p>
            </div>
          ) : selectedExplainable ? (
            <div className="selection-banner">
              <span className="eyebrow">{getExplainableKindLabel(selectedExplainable)}</span>
              <strong>{selectedLabel}</strong>
              <p>Open the explanation drawer below for the short structural explanation.</p>
            </div>
          ) : (
            <div className="canvas-tip">Hover a path or click a node to inspect the exact part of the graph you are reasoning about.</div>
          )}
        </div>
      </div>
    </section>
  );
}
