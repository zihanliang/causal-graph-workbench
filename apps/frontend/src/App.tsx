import type { AnalysisResult, GraphComparison } from "@causal-graph-workbench/shared";
import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";

import { CanvasWorkspace } from "./components/CanvasWorkspace";
import { DraftScreen } from "./components/DraftScreen";
import { PanelResizer, readPanelWidth } from "./components/PanelResizer";
import { StartScreen } from "./components/StartScreen";
import { StepPanel } from "./components/StepPanel";
import { TopBar } from "./components/TopBar";
import { analyzeGraph } from "./engine/client";
import { currentVersions, structuralKey } from "./lib/graphVersions";
import { useWorkbenchStore } from "./store/useWorkbenchStore";

const ANALYSIS_DELAY_MS = 120;

export default function App() {
  const view = useWorkbenchStore((state) => state.view);
  const graph = useWorkbenchStore((state) => state.graph);
  const versions = useWorkbenchStore((state) => state.versions);
  const activeVersionId = useWorkbenchStore((state) => state.activeVersionId);
  const uncertainPairs = useWorkbenchStore((state) => state.uncertainPairs);
  const dataContext = useWorkbenchStore((state) => state.dataContext);
  const analysis = useWorkbenchStore((state) => state.analysis);
  const uploadedDataset = useWorkbenchStore((state) => state.uploadedDataset);
  const isAnalyzing = useWorkbenchStore((state) => state.isAnalyzing);
  const analysisError = useWorkbenchStore((state) => state.analysisError);
  const setAnalysis = useWorkbenchStore((state) => state.setAnalysis);
  const setIsAnalyzing = useWorkbenchStore((state) => state.setIsAnalyzing);
  const setAnalysisError = useWorkbenchStore((state) => state.setAnalysisError);
  const graphShellRef = useRef<HTMLDivElement>(null);
  const workspaceRef = useRef<HTMLElement>(null);
  const lastComparison = useRef<{ key: string; comparison: GraphComparison } | null>(null);
  const [panelWidth, setPanelWidth] = useState<number | null>(readPanelWidth);
  const analysisKey = useMemo(
    () =>
      JSON.stringify([
        structuralKey(graph),
        activeVersionId,
        versions.filter((version) => version.id !== activeVersionId).map((version) => [version.id, structuralKey(version.graph)]),
        uncertainPairs,
      ]),
    [graph, versions, activeVersionId, uncertainPairs],
  );

  // A comparison does not depend on which graph is open, so showing another need not take it off the page while the
  // new graph's own analysis runs. Anything else that changes it changes this key, and then it is worked out again.
  const comparisonKey = useMemo(
    () => JSON.stringify([versions.map((version) => [version.id, version.id === activeVersionId ? structuralKey(graph) : structuralKey(version.graph)]), dataContext, uploadedDataset?.filename, uploadedDataset?.content.length]),
    [versions, activeVersionId, graph, dataContext, uploadedDataset],
  );
  const keepComparison = useMemo(
    () =>
      (result: AnalysisResult): AnalysisResult => {
        if (result.comparison) {
          lastComparison.current = { key: comparisonKey, comparison: result.comparison };
          return result;
        }
        const kept = lastComparison.current;
        return kept?.key === comparisonKey ? { ...result, comparison: { ...kept.comparison, shownId: activeVersionId } } : result;
      },
    [comparisonKey, activeVersionId],
  );

  useEffect(() => {
    let isStale = false;
    const timeout = window.setTimeout(async () => {
      try {
        setIsAnalyzing(true);
        setAnalysisError(null);
        const latest = useWorkbenchStore.getState();
        const allVersions = currentVersions(latest);
        const result = await analyzeGraph(
          {
            graph: latest.graph,
            dataContext,
            dataset: uploadedDataset,
            ...(allVersions.length > 1 ? { versions: allVersions, activeVersionId: latest.activeVersionId } : {}),
            ...(latest.uncertainPairs.length ? { uncertainPairs: latest.uncertainPairs } : {}),
          },
          (progress) => {
            if (!isStale) {
              setAnalysis(keepComparison(progress));
            }
          },
        );
        if (!isStale) {
          setAnalysis(keepComparison(result));
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
  }, [analysisKey, dataContext, uploadedDataset, keepComparison, setAnalysis, setAnalysisError, setIsAnalyzing]);

  return (
    <div className="app-shell">
      <TopBar graph={graph} analysis={analysis} graphShellRef={graphShellRef} isAnalyzing={isAnalyzing} analysisError={analysisError} />

      {view === "start" ? (
        <StartScreen />
      ) : view === "draft" ? (
        <DraftScreen />
      ) : (
        <main className="workspace" ref={workspaceRef} style={panelWidth === null ? undefined : ({ "--panel-width": `min(${panelWidth}px, calc(100vw - 436px))` } as CSSProperties)}>
          <CanvasWorkspace graph={graph} analysis={analysis} graphShellRef={graphShellRef} />
          <PanelResizer workspaceRef={workspaceRef} width={panelWidth} onChange={setPanelWidth} />
          <StepPanel analysis={analysis} graph={graph} />
        </main>
      )}
    </div>
  );
}
