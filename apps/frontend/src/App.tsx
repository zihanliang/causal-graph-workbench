import type { GraphSpec } from "@causal-graph-workbench/shared";
import { useEffect, useMemo, useRef } from "react";

import { CanvasWorkspace } from "./components/CanvasWorkspace";
import { StartScreen } from "./components/StartScreen";
import { StepPanel } from "./components/StepPanel";
import { TopBar } from "./components/TopBar";
import { analyzeGraph } from "./engine/client";
import { useWorkbenchStore } from "./store/useWorkbenchStore";

const ANALYSIS_DELAY_MS = 120;

/** Everything analysis depends on. Moving a node on the canvas does not change it. */
function structuralKey(graph: GraphSpec): string {
  return JSON.stringify({
    nodes: graph.nodes.map((node) => [node.id, node.observed !== false, node.timing ?? null]),
    edges: graph.edges.map((edge) => [edge.source, edge.target]),
    treatment: graph.treatmentId,
    outcome: graph.outcomeId,
  });
}

export default function App() {
  const view = useWorkbenchStore((state) => state.view);
  const graph = useWorkbenchStore((state) => state.graph);
  const dataContext = useWorkbenchStore((state) => state.dataContext);
  const analysis = useWorkbenchStore((state) => state.analysis);
  const uploadedDataset = useWorkbenchStore((state) => state.uploadedDataset);
  const isAnalyzing = useWorkbenchStore((state) => state.isAnalyzing);
  const analysisError = useWorkbenchStore((state) => state.analysisError);
  const setAnalysis = useWorkbenchStore((state) => state.setAnalysis);
  const setIsAnalyzing = useWorkbenchStore((state) => state.setIsAnalyzing);
  const setAnalysisError = useWorkbenchStore((state) => state.setAnalysisError);
  const graphShellRef = useRef<HTMLDivElement>(null);
  const analysisKey = useMemo(() => structuralKey(graph), [graph]);

  useEffect(() => {
    let isStale = false;
    const timeout = window.setTimeout(async () => {
      try {
        setIsAnalyzing(true);
        setAnalysisError(null);
        const latestGraph = useWorkbenchStore.getState().graph;
        const result = await analyzeGraph({ graph: latestGraph, dataContext, dataset: uploadedDataset }, (progress) => {
          if (!isStale) {
            setAnalysis(progress);
          }
        });
        if (!isStale) {
          setAnalysis(result);
        }
      } catch (error) {
        if (!isStale) {
          setAnalysis(null);
          setAnalysisError(error instanceof Error ? error.message : "The analysis could not be completed.");
        }
      } finally {
        if (!isStale) {
          setIsAnalyzing(false);
        }
      }
    }, ANALYSIS_DELAY_MS);

    return () => {
      isStale = true;
      window.clearTimeout(timeout);
    };
  }, [analysisKey, dataContext, uploadedDataset, setAnalysis, setAnalysisError, setIsAnalyzing]);

  return (
    <div className="app-shell">
      <TopBar graph={graph} analysis={analysis} graphShellRef={graphShellRef} isAnalyzing={isAnalyzing} analysisError={analysisError} />

      {view === "start" ? (
        <StartScreen />
      ) : (
        <main className="workspace">
          <CanvasWorkspace graph={graph} analysis={analysis} graphShellRef={graphShellRef} />
          <StepPanel analysis={analysis} graph={graph} />
        </main>
      )}
    </div>
  );
}
