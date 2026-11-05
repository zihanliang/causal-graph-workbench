import type { AnalysisResult, GraphSpec } from "@causal-graph-workbench/shared";
import { useEffect, useRef, useState, type RefObject } from "react";

import {
  downloadGraphPng,
  downloadGraphSvg,
  downloadJsonFile,
  downloadMarkdownReport,
  downloadTextFile,
  openAnalysisPdf,
  readProjectSnapshot,
} from "../lib/export";
import { buildReproducibleScript } from "../engine/reproduce";
import { publicAssetPath } from "../lib/urls";
import { buildProjectSnapshot, useWorkbenchStore, type WorkStep } from "../store/useWorkbenchStore";
import { Icon } from "./ui";

interface TopBarProps {
  graph: GraphSpec;
  analysis: AnalysisResult | null;
  graphShellRef: RefObject<HTMLDivElement>;
  isAnalyzing: boolean;
  analysisError: string | null;
}

const STEPS: { id: WorkStep; label: string }[] = [
  { id: "graph", label: "Graph" },
  { id: "data", label: "Data" },
  { id: "result", label: "Result" },
];

export function TopBar({ graph, analysis, graphShellRef, isAnalyzing, analysisError }: TopBarProps) {
  const view = useWorkbenchStore((state) => state.view);
  const step = useWorkbenchStore((state) => state.step);
  const setStep = useWorkbenchStore((state) => state.setStep);
  const setView = useWorkbenchStore((state) => state.setView);
  const dataContext = useWorkbenchStore((state) => state.dataContext);
  const uploadedDataset = useWorkbenchStore((state) => state.uploadedDataset);
  const hydrateProject = useWorkbenchStore((state) => state.hydrateProject);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const exportMenuRef = useRef<HTMLDivElement>(null);
  const [isExportOpen, setIsExportOpen] = useState(false);
  const [message, setMessage] = useState<{ tone: "success" | "error"; text: string } | null>(null);

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

  useEffect(() => {
    if (message?.tone !== "success") {
      return;
    }
    const timer = window.setTimeout(() => setMessage(null), 3500);
    return () => window.clearTimeout(timer);
  }, [message]);

  const isDone = (id: WorkStep) =>
    id === "graph" ? Boolean(analysis?.validation.canAnalyze) : id === "data" ? Boolean(uploadedDataset) : false;

  const exportActions = [
    {
      label: "Report (Markdown)",
      run: async () => {
        downloadMarkdownReport("causal-graph-workbench-report.md", graph, analysis, dataContext);
        setMessage({ tone: "success", text: "Report saved as Markdown." });
      },
    },
    {
      label: "Report (PDF)",
      run: async () => {
        openAnalysisPdf(graph, analysis, dataContext);
        setMessage({ tone: "success", text: "Choose Save as PDF in the print dialog." });
      },
    },
    {
      label: "Script (Python)",
      run: async () => {
        const script = analysis ? buildReproducibleScript(graph, analysis) : null;
        if (!script) {
          throw new Error("The script needs a finished estimate. Add your data, and wait for the checks to finish.");
        }
        downloadTextFile("reproduce_analysis.py", script);
        setMessage({ tone: "success", text: "Script saved. Run it next to your data file." });
      },
    },
    {
      label: "Graph (SVG)",
      run: async () => {
        downloadGraphSvg("causal-graph-workbench.svg", graph, analysis);
        setMessage({ tone: "success", text: "Graph saved as SVG." });
      },
    },
    {
      label: "Graph (PNG)",
      run: async () => {
        if (!graphShellRef.current) {
          throw new Error("Open the graph first, then export it as PNG.");
        }
        await downloadGraphPng("causal-graph-workbench.png", graphShellRef.current);
        setMessage({ tone: "success", text: "Graph saved as PNG." });
      },
    },
  ];

  const shownMessage = analysisError ? { tone: "error" as const, text: analysisError } : message;

  return (
    <header className="topbar">
      <button type="button" className="brand" onClick={() => setView("start")} aria-label="Causal Graph Workbench, back to start">
        <img src={publicAssetPath("logo.png")} alt="" width={26} height={26} />
        <span>Causal Graph Workbench</span>
      </button>

      {view === "workspace" ? (
        <nav className="steps" aria-label="Steps">
          {STEPS.map((item, index) => (
            <span key={item.id} className="steps__item">
              {index > 0 ? <Icon name="chevronRight" /> : null}
              <button type="button" className="step" aria-current={item.id === step ? "step" : undefined} onClick={() => setStep(item.id)}>
                {isDone(item.id) ? <Icon name="check" /> : null}
                {item.label}
              </button>
            </span>
          ))}
        </nav>
      ) : (
        <span />
      )}

      <div className="topbar__actions">
        {isAnalyzing ? <span className="topbar__status">Working…</span> : null}
        <button type="button" className="btn btn--quiet" onClick={() => fileInputRef.current?.click()}>
          Open
        </button>
        {view === "workspace" ? (
          <>
            <button
              type="button"
              className="btn btn--quiet"
              onClick={() => {
                downloadJsonFile("causal-graph-workbench-project.json", buildProjectSnapshot());
                setMessage({ tone: "success", text: "Project saved." });
              }}
            >
              Save
            </button>
            <div className="menu-anchor" ref={exportMenuRef}>
              <button type="button" className="btn btn--quiet" onClick={() => setIsExportOpen((value) => !value)} aria-expanded={isExportOpen}>
                Export
              </button>
              {isExportOpen ? (
                <div className="menu" role="menu">
                  {exportActions.map((action) => (
                    <button
                      key={action.label}
                      type="button"
                      role="menuitem"
                      className="menu__item"
                      onClick={() => {
                        setIsExportOpen(false);
                        void action.run().catch((error) =>
                          setMessage({
                            tone: "error",
                            text: error instanceof Error ? error.message : `Could not export ${action.label}.`,
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
          </>
        ) : null}
      </div>

      <input
        ref={fileInputRef}
        type="file"
        accept="application/json"
        hidden
        aria-label="Open a saved project"
        onChange={async (event) => {
          // currentTarget is cleared once the handler awaits, so keep a reference.
          const input = event.currentTarget;
          const file = input.files?.[0];
          if (!file) {
            return;
          }
          try {
            const snapshot = await readProjectSnapshot(file);
            hydrateProject(snapshot);
            setMessage({ tone: "success", text: `Opened ${file.name}.` });
          } catch (error) {
            setMessage({ tone: "error", text: error instanceof Error ? error.message : "That file could not be opened." });
          } finally {
            input.value = "";
          }
        }}
      />

      {shownMessage ? (
        <div className={`toast toast--${shownMessage.tone}`} role={shownMessage.tone === "error" ? "alert" : "status"}>
          <span>{shownMessage.text}</span>
          {shownMessage === message ? (
            <button type="button" className="icon-button" aria-label="Dismiss" onClick={() => setMessage(null)}>
              <Icon name="close" />
            </button>
          ) : null}
        </div>
      ) : null}
    </header>
  );
}
