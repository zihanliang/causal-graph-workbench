import type {
  AnalysisResult,
  DataContext,
  ExplainableSelection,
  GraphTemplate,
  UploadedDataset,
} from "@causal-graph-workbench/shared";
import { create } from "zustand";

import { createNode, createNodeId, graphToEdgeListText, makeEdgeId, parseEdgeListText } from "../lib/edgeList";
import { fallbackTemplates } from "../lib/fallbackTemplates";
import { layoutGraph } from "../lib/layout";
import type { ProjectSnapshot } from "../lib/projectSnapshot";

export type PanelTab = "summary" | "paths" | "estimate" | "checks";

export interface WorkbenchStore {
  graph: GraphTemplate["graph"];
  dataContext: DataContext;
  templates: GraphTemplate[];
  analysis: AnalysisResult | null;
  uploadedDataset: UploadedDataset | null;
  activeTab: PanelTab;
  textDraft: string;
  parseError: string | null;
  isAnalyzing: boolean;
  apiError: string | null;
  selectedExplainable: ExplainableSelection | null;
  highlightedPathId: string | null;
  setTemplates: (templates: GraphTemplate[]) => void;
  applyTemplate: (templateId: string) => void;
  setTextDraft: (value: string) => void;
  importFromText: () => void;
  addNode: (label: string) => void;
  renameNode: (nodeId: string, nextLabel: string) => void;
  updateNodePosition: (nodeId: string, x: number, y: number) => void;
  connectNodes: (source: string, target: string) => void;
  removeNode: (nodeId: string) => void;
  removeEdge: (edgeId: string) => void;
  relayoutGraph: () => void;
  clearGraph: () => void;
  setUploadedDataset: (dataset: UploadedDataset | null) => void;
  setTreatment: (nodeId: string | null) => void;
  setOutcome: (nodeId: string | null) => void;
  setDataContext: (partial: Partial<DataContext>) => void;
  setAnalysis: (analysis: AnalysisResult | null) => void;
  setIsAnalyzing: (value: boolean) => void;
  setApiError: (value: string | null) => void;
  setActiveTab: (tab: PanelTab) => void;
  setSelectedExplainable: (selection: ExplainableSelection | null) => void;
  setHighlightedPathId: (pathId: string | null) => void;
  hydrateProject: (snapshot: ProjectSnapshot) => void;
}

const initialTemplate = fallbackTemplates[0].graph;

export const useWorkbenchStore = create<WorkbenchStore>((set, get) => ({
  graph: initialTemplate,
  dataContext: {
    hasData: false,
    treatmentType: "unknown",
    outcomeType: "unknown",
    datasetName: null,
    highDimensional: false,
    columnBindings: {},
  },
  templates: fallbackTemplates,
  analysis: null,
  uploadedDataset: null,
  activeTab: "summary",
  textDraft: graphToEdgeListText(initialTemplate),
  parseError: null,
  isAnalyzing: false,
  apiError: null,
  selectedExplainable: null,
  highlightedPathId: null,
  setTemplates: (templates) => set({ templates: templates.length ? templates : fallbackTemplates }),
  applyTemplate: (templateId) => {
    const template = get().templates.find((item) => item.id === templateId) ?? fallbackTemplates[0];
    set({
      graph: layoutGraph(template.graph),
      textDraft: graphToEdgeListText(template.graph),
      parseError: null,
      analysis: null,
      apiError: null,
      uploadedDataset: null,
      dataContext: {
        ...get().dataContext,
        hasData: false,
        datasetName: null,
        columnBindings: {},
      },
      selectedExplainable: null,
      highlightedPathId: null,
      activeTab: "summary",
    });
  },
  setTextDraft: (value) => {
    let parseError: string | null = null;
    try {
      parseEdgeListText(value, get().graph);
    } catch (error) {
      parseError = error instanceof Error ? error.message : "Failed to parse edge list.";
    }
    set({ textDraft: value, parseError });
  },
  importFromText: () => {
    try {
      const parsed = parseEdgeListText(get().textDraft, get().graph);
      const nextGraph = {
        ...parsed.graph,
        treatmentId: parsed.graph.nodes.some((node) => node.id === get().graph.treatmentId) ? get().graph.treatmentId : null,
        outcomeId: parsed.graph.nodes.some((node) => node.id === get().graph.outcomeId) ? get().graph.outcomeId : null,
      };
      set({
        graph: nextGraph,
        textDraft: graphToEdgeListText(nextGraph),
        parseError: null,
      });
    } catch (error) {
      set({ parseError: error instanceof Error ? error.message : "Failed to parse edge list." });
    }
  },
  addNode: (label) => {
    const used = new Set(get().graph.nodes.map((node) => node.id));
    const nodeId = createNodeId(label, used);
    const nextGraph = {
      ...get().graph,
      nodes: [...get().graph.nodes, createNode(nodeId, 160 + get().graph.nodes.length * 24, 120 + get().graph.nodes.length * 24)],
    };
    set({ graph: nextGraph, textDraft: graphToEdgeListText(nextGraph) });
  },
  renameNode: (nodeId, nextLabel) => {
    const normalizedLabel = nextLabel.trim();
    if (!normalizedLabel) {
      return;
    }
    const selectedExplainable = get().selectedExplainable;
    const otherIds = new Set(get().graph.nodes.filter((node) => node.id !== nodeId).map((node) => node.id));
    const nextId = createNodeId(normalizedLabel, otherIds);
    const nextGraph = {
      ...get().graph,
      nodes: get().graph.nodes.map((node) =>
        node.id === nodeId ? { ...node, id: nextId, label: nextId } : node,
      ),
      edges: get().graph.edges.map((edge) => {
        const source = edge.source === nodeId ? nextId : edge.source;
        const target = edge.target === nodeId ? nextId : edge.target;
        return {
          ...edge,
          source,
          target,
          id: makeEdgeId(source, target),
        };
      }),
      treatmentId: get().graph.treatmentId === nodeId ? nextId : get().graph.treatmentId,
      outcomeId: get().graph.outcomeId === nodeId ? nextId : get().graph.outcomeId,
    };
    set({
      graph: nextGraph,
      textDraft: graphToEdgeListText(nextGraph),
      selectedExplainable:
        selectedExplainable?.kind === "node" && selectedExplainable.id === nodeId
          ? { kind: "node", id: nextId }
          : selectedExplainable,
    });
  },
  updateNodePosition: (nodeId, x, y) => {
    const nextGraph = {
      ...get().graph,
      nodes: get().graph.nodes.map((node) => (node.id === nodeId ? { ...node, x, y } : node)),
    };
    set({ graph: nextGraph });
  },
  connectNodes: (source, target) => {
    if (source === target) {
      return;
    }
    const edgeId = makeEdgeId(source, target);
    if (get().graph.edges.some((edge) => edge.id === edgeId)) {
      return;
    }
    const nextGraph = {
      ...get().graph,
      edges: [...get().graph.edges, { id: edgeId, source, target }],
    };
    set({ graph: nextGraph, textDraft: graphToEdgeListText(nextGraph) });
  },
  removeNode: (nodeId) => {
    const nextGraph = {
      ...get().graph,
      nodes: get().graph.nodes.filter((node) => node.id !== nodeId),
      edges: get().graph.edges.filter((edge) => edge.source !== nodeId && edge.target !== nodeId),
      treatmentId: get().graph.treatmentId === nodeId ? null : get().graph.treatmentId,
      outcomeId: get().graph.outcomeId === nodeId ? null : get().graph.outcomeId,
    };
    set({
      graph: nextGraph,
      textDraft: graphToEdgeListText(nextGraph),
      selectedExplainable: get().selectedExplainable?.id === nodeId ? null : get().selectedExplainable,
    });
  },
  removeEdge: (edgeId) => {
    const nextGraph = {
      ...get().graph,
      edges: get().graph.edges.filter((edge) => edge.id !== edgeId),
    };
    set({ graph: nextGraph, textDraft: graphToEdgeListText(nextGraph) });
  },
  relayoutGraph: () => {
    const nextGraph = layoutGraph({
      ...get().graph,
      nodes: get().graph.nodes.map((node) => ({ ...node, x: 0, y: 0 })),
    });
    set({ graph: nextGraph, textDraft: graphToEdgeListText(nextGraph) });
  },
  clearGraph: () =>
    set({
      graph: { nodes: [], edges: [], treatmentId: null, outcomeId: null },
      analysis: null,
      apiError: null,
      activeTab: "summary",
      uploadedDataset: null,
      dataContext: {
        ...get().dataContext,
        hasData: false,
        datasetName: null,
        columnBindings: {},
      },
      textDraft: "",
      parseError: null,
      selectedExplainable: null,
      highlightedPathId: null,
    }),
  setUploadedDataset: (dataset) =>
    set({
      uploadedDataset: dataset,
      dataContext: {
        ...get().dataContext,
        hasData: Boolean(dataset),
        datasetName: dataset?.filename ?? null,
      },
    }),
  setTreatment: (nodeId) => set({ graph: { ...get().graph, treatmentId: nodeId } }),
  setOutcome: (nodeId) => set({ graph: { ...get().graph, outcomeId: nodeId } }),
  setDataContext: (partial) => set({ dataContext: { ...get().dataContext, ...partial } }),
  setAnalysis: (analysis) => set({ analysis }),
  setIsAnalyzing: (value) => set({ isAnalyzing: value }),
  setApiError: (value) => set({ apiError: value }),
  setActiveTab: (tab) => set({ activeTab: tab }),
  setSelectedExplainable: (selection) => set({ selectedExplainable: selection }),
  setHighlightedPathId: (pathId) => set({ highlightedPathId: pathId }),
  hydrateProject: (snapshot) =>
    set({
      graph: layoutGraph(snapshot.graph),
      dataContext: snapshot.dataContext,
      uploadedDataset: snapshot.uploadedDataset,
      analysis: null,
      apiError: null,
      activeTab: "summary",
      textDraft: graphToEdgeListText(snapshot.graph),
      parseError: null,
      selectedExplainable: null,
      highlightedPathId: null,
    }),
}));

export function buildProjectSnapshot(): ProjectSnapshot {
  const { graph, dataContext, uploadedDataset } = useWorkbenchStore.getState();
  return {
    version: "0.2.0",
    savedAt: new Date().toISOString(),
    graph,
    dataContext,
    uploadedDataset,
  };
}
