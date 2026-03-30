import type { AnalysisResult, GraphSpec } from "@causal-graph-workbench/shared";
import { useEffect, useMemo, useRef, useState, type RefObject } from "react";

import {
  downloadGraphPng,
  downloadGraphSvg,
  downloadJsonFile,
  downloadMarkdownReport,
  openAnalysisPdf,
  readProjectSnapshot,
} from "../lib/export";
import { buildProjectSnapshot, useWorkbenchStore } from "../store/useWorkbenchStore";

interface TopBarProps {
  graph: GraphSpec;
  analysis: AnalysisResult | null;
  graphShellRef: RefObject<HTMLDivElement>;
  isAnalyzing: boolean;
  apiError: string | null;
}

export function TopBar({ graph, analysis, graphShellRef, isAnalyzing, apiError }: TopBarProps) {
  const dataContext = useWorkbenchStore((state) => state.dataContext);
  const hydrateProject = useWorkbenchStore((state) => state.hydrateProject);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const exportMenuRef = useRef<HTMLDivElement>(null);
  const [isExportOpen, setIsExportOpen] = useState(false);
  const [actionState, setActionState] = useState<{ tone: "success" | "warning" | "error"; message: string } | null>(null);

  useEffect(() => {
    if (!isExportOpen) {
      return;
    }

    const handlePointerDown = (event: PointerEvent) => {
      if (!exportMenuRef.current?.contains(event.target as Node)) {
        setIsExportOpen(false);
      }
    };

    document.addEventListener("pointerdown", handlePointerDown);
    return () => document.removeEventListener("pointerdown", handlePointerDown);
  }, [isExportOpen]);

  const errorCount = analysis?.validation.issues.filter((issue) => issue.severity === "error").length ?? 0;
  const warningCount = analysis?.validation.issues.filter((issue) => issue.severity === "warning").length ?? 0;
  const minimalSetCount = analysis?.adjustmentSets.filter((item) => item.isMinimal).length ?? 0;
  const hasNoValidAdjustmentSet = Boolean(analysis && analysis.adjustmentSets.length === 0);

  const feedback = apiError
    ? { tone: "error" as const, message: apiError }
    : actionState ?? {
        tone: "success" as const,
        message: isAnalyzing ? "Refreshing analysis…" : "Edit the graph and inspect the structured result.",
      };

  const graphSummary = useMemo(() => {
    const pair = graph.treatmentId && graph.outcomeId ? `${graph.treatmentId} → ${graph.outcomeId}` : "Select treatment and outcome";
    const dataLabel = dataContext.hasData ? dataContext.datasetName ?? "Data attached" : "No data";

    return [
      isAnalyzing ? "Analyzing" : "Synced",
      pair,
      dataLabel,
      errorCount ? `${errorCount} blocking error${errorCount === 1 ? "" : "s"}` : warningCount ? `${warningCount} warning${warningCount === 1 ? "" : "s"}` : "Structurally clear",
      minimalSetCount
        ? `${minimalSetCount} minimal set${minimalSetCount === 1 ? "" : "s"}`
        : hasNoValidAdjustmentSet
          ? "No valid set"
          : "Waiting for analysis",
    ];
  }, [dataContext.datasetName, dataContext.hasData, errorCount, graph.outcomeId, graph.treatmentId, hasNoValidAdjustmentSet, isAnalyzing, minimalSetCount, warningCount]);

  const exportActions = [
    {
      label: "Markdown report",
      run: async () => {
        downloadMarkdownReport("causal-graph-workbench-report.md", graph, analysis, dataContext);
        setActionState({ tone: "success", message: "Markdown report exported." });
      },
    },
    {
      label: "Printable PDF",
      run: async () => {
        openAnalysisPdf(graph, analysis, dataContext);
        setActionState({ tone: "warning", message: "Print dialog opened. Choose Save as PDF in the browser print dialog." });
      },
    },
    {
      label: "Graph SVG",
      run: async () => {
        downloadGraphSvg("causal-graph-workbench.svg", graph, analysis);
        setActionState({ tone: "success", message: "Graph exported as SVG." });
      },
    },
    {
      label: "Graph PNG",
      run: async () => {
        if (!graphShellRef.current) {
          throw new Error("Graph canvas is not ready for PNG export.");
        }
        await downloadGraphPng("causal-graph-workbench.png", graphShellRef.current);
        setActionState({ tone: "success", message: "Graph exported as PNG." });
      },
    },
  ];

  return (
    <header className="topbar">
      <div className="topbar__main">
        <div>
          <p className="eyebrow">Causal Graph Workbench</p>
          <h1>Rule-based DAG workbench for backdoor adjustment</h1>
          <p className="topbar__subtitle">
            Build a user-specified DAG, choose treatment and outcome, inspect path logic and adjustment guidance, and
            export code templates.
          </p>
        </div>

        <div className="topbar__meta">
          {graphSummary.map((item) => (
            <span
              key={item}
              className={
                item === graphSummary[0] && isAnalyzing
                  ? "status-pill status-pill--warning"
                  : item.includes("blocking error")
                    ? "status-pill status-pill--error"
                    : item.includes("warning")
                      ? "status-pill status-pill--warning"
                      : item === graphSummary[4] && minimalSetCount
                        ? "status-pill status-pill--success"
                        : "status-pill"
              }
            >
              {item}
            </span>
          ))}
        </div>

        <p className="topbar__trust">
          The workbench does not verify that the DAG is true. It reasons conditionally on the graph you provide and keeps
          assumptions explicit.
        </p>
      </div>

      <div className="topbar__actions">
        <div className="topbar__button-row">
          <button type="button" onClick={() => fileInputRef.current?.click()}>
            Open
          </button>
          <button
            type="button"
            onClick={() => {
              downloadJsonFile("causal-graph-workbench-project.json", buildProjectSnapshot());
              setActionState({ tone: "success", message: "Project snapshot saved." });
            }}
          >
            Save
          </button>
          <div className="menu-shell" ref={exportMenuRef}>
            <button type="button" onClick={() => setIsExportOpen((value) => !value)} aria-expanded={isExportOpen}>
              Export
            </button>
            {isExportOpen ? (
              <div className="action-menu">
                {exportActions.map((action) => (
                  <button
                    key={action.label}
                    type="button"
                    className="action-menu__item"
                    onClick={() => {
                      setIsExportOpen(false);
                      void action.run().catch((error) =>
                        setActionState({
                          tone: "error",
                          message: error instanceof Error ? error.message : `Failed to export ${action.label.toLowerCase()}.`,
                        }),
                      );
                    }}
                  >
                    {action.label}
                  </button>
                ))}
              </div>
            ) : null}
          </div>
        </div>

        <div className={`topbar__feedback topbar__feedback--${feedback.tone}`}>
          <strong>{feedback.tone === "error" ? "Action failed" : "Workspace status"}</strong>
          <span>{feedback.message}</span>
        </div>
      </div>

      <input
        ref={fileInputRef}
        type="file"
        accept="application/json"
        hidden
        onChange={async (event) => {
          const file = event.target.files?.[0];
          if (!file) {
            return;
          }
          try {
            const snapshot = await readProjectSnapshot(file);
            hydrateProject(snapshot);
            setActionState({ tone: "success", message: `Loaded ${file.name}.` });
          } catch (error) {
            setActionState({
              tone: "error",
              message: error instanceof Error ? error.message : "Failed to load the selected project snapshot.",
            });
          } finally {
            event.currentTarget.value = "";
          }
        }}
      />
    </header>
  );
}
