import { useEffect, useRef } from "react";

import { analyzeGraph, fetchTemplates } from "./api/client";
import { BuilderSidebar } from "./components/BuilderSidebar";
import { CanvasWorkspace } from "./components/CanvasWorkspace";
import { ExplainPanel } from "./components/ExplainPanel";
import { ResultsPanel } from "./components/ResultsPanel";
import { TopBar } from "./components/TopBar";
import { fallbackTemplates } from "./lib/fallbackTemplates";
import { useWorkbenchStore } from "./store/useWorkbenchStore";

export default function App() {
  const graph = useWorkbenchStore((state) => state.graph);
  const dataContext = useWorkbenchStore((state) => state.dataContext);
  const analysis = useWorkbenchStore((state) => state.analysis);
  const uploadedDataset = useWorkbenchStore((state) => state.uploadedDataset);
  const isAnalyzing = useWorkbenchStore((state) => state.isAnalyzing);
  const apiError = useWorkbenchStore((state) => state.apiError);
  const setAnalysis = useWorkbenchStore((state) => state.setAnalysis);
  const setTemplates = useWorkbenchStore((state) => state.setTemplates);
  const setIsAnalyzing = useWorkbenchStore((state) => state.setIsAnalyzing);
  const setApiError = useWorkbenchStore((state) => state.setApiError);
  const graphShellRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    fetchTemplates()
      .then((templates) => setTemplates(templates))
      .catch(() => setTemplates(fallbackTemplates));
  }, [setTemplates]);

  useEffect(() => {
    const controller = new AbortController();
    const timeout = window.setTimeout(async () => {
      try {
        setIsAnalyzing(true);
        setApiError(null);
        const result = await analyzeGraph({ graph, dataContext, dataset: uploadedDataset });
        if (!controller.signal.aborted) {
          setAnalysis(result);
        }
      } catch (error) {
        if (!controller.signal.aborted) {
          setAnalysis(null);
          setApiError(error instanceof Error ? error.message : "Backend request failed.");
        }
      } finally {
        if (!controller.signal.aborted) {
          setIsAnalyzing(false);
        }
      }
    }, 350);

    return () => {
      controller.abort();
      window.clearTimeout(timeout);
    };
  }, [dataContext, graph, uploadedDataset, setAnalysis, setApiError, setIsAnalyzing]);

  return (
    <div className="app-shell">
      <TopBar graph={graph} analysis={analysis} graphShellRef={graphShellRef} isAnalyzing={isAnalyzing} apiError={apiError} />

      <main className="workspace">
        <BuilderSidebar />
        <section className="canvas-panel">
          <CanvasWorkspace graph={graph} analysis={analysis} graphShellRef={graphShellRef} />
        </section>
        <ResultsPanel analysis={analysis} />
      </main>

      <ExplainPanel analysis={analysis} />
    </div>
  );
}
