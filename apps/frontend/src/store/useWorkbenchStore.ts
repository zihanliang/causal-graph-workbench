import type {
  AnalysisResult,
  AssumptionEdit,
  DataContext,
  ExplainableSelection,
  GraphSpec,
  GraphTemplate,
  UploadedDataset,
  VariableTiming,
} from "@causal-graph-workbench/shared";
import { create } from "zustand";

import { createNode, createNodeId, graphToEdgeListText, makeEdgeId, parseEdgeListText } from "../lib/edgeList";
import { graphTemplates } from "../lib/graphTemplates";
import { layoutGraph } from "../lib/layout";
import type { ProjectSnapshot } from "../lib/projectSnapshot";

export type AppView = "start" | "workspace";
export type WorkStep = "graph" | "data" | "result";
export type PanelTab = "assumptions" | "sets" | "code" | "details";

/** An arrow the user is considering, shown on the canvas without changing the graph. */
export interface ArrowPreview {
  edit: AssumptionEdit;
  source: string;
  target: string;
}

export interface WorkbenchStore {
  view: AppView;
  step: WorkStep;
  /** True after leaving the workspace, so the start screen can offer a way back to it. */
  canResume: boolean;
  /** Bumped by "Auto layout", so the canvas re-fits even though the same variables are on it. */
  layoutVersion: number;
  graphTextOpen: boolean;
  graph: GraphTemplate["graph"];
  dataContext: DataContext;
  templates: GraphTemplate[];
  analysis: AnalysisResult | null;
  uploadedDataset: UploadedDataset | null;
  activeTab: PanelTab;
  textDraft: string;
  parseError: string | null;
  isAnalyzing: boolean;
  analysisError: string | null;
  selectedExplainable: ExplainableSelection | null;
  highlightedPathId: string | null;
  previewArrow: ArrowPreview | null;
  setView: (view: AppView) => void;
  setStep: (step: WorkStep) => void;
  setGraphTextOpen: (open: boolean) => void;
  applyTemplate: (templateId: string) => void;
  setTextDraft: (value: string) => void;
  importFromText: () => void;
  addNode: (label: string) => void;
  renameNode: (nodeId: string, nextLabel: string) => void;
  updateNodePosition: (nodeId: string, x: number, y: number) => void;
  connectNodes: (source: string, target: string) => void;
  removeNode: (nodeId: string) => void;
  removeEdge: (edgeId: string) => void;
  applyArrowEdit: (arrow: ArrowPreview) => void;
  setNodeObserved: (nodeId: string, observed: boolean) => void;
  setNodeTiming: (nodeId: string, timing: VariableTiming | null) => void;
  setColumnBinding: (nodeId: string, column: string) => void;
  addColumnsAsVariables: (columns: string[]) => void;
  relayoutGraph: () => void;
  clearGraph: () => void;
  setUploadedDataset: (dataset: UploadedDataset | null) => void;
  setTreatment: (nodeId: string | null) => void;
  setOutcome: (nodeId: string | null) => void;
  setDataContext: (partial: Partial<DataContext>) => void;
  setAnalysis: (analysis: AnalysisResult | null) => void;
  setIsAnalyzing: (value: boolean) => void;
  setAnalysisError: (value: string | null) => void;
  setActiveTab: (tab: PanelTab) => void;
  setSelectedExplainable: (selection: ExplainableSelection | null) => void;
  setHighlightedPathId: (pathId: string | null) => void;
  setPreviewArrow: (arrow: ArrowPreview | null) => void;
  hydrateProject: (snapshot: ProjectSnapshot) => void;
}

const initialTemplate = graphTemplates[0].graph;

/** A place for a new variable that does not sit on top of one already on the canvas. */
function nextFreeSpot(graph: GraphSpec): [number, number] {
  const COLUMNS = 3;
  for (let slot = 0; ; slot += 1) {
    const x = 100 + (slot % COLUMNS) * 220;
    const y = 100 + Math.floor(slot / COLUMNS) * 120;
    if (!graph.nodes.some((node) => Math.abs(node.x - x) < 160 && Math.abs(node.y - y) < 80)) {
      return [x, y];
    }
  }
}

/** A chosen set and estimand belong to one question, so a new graph starts without them. */
const FRESH_CHOICES = { columnBindings: {}, chosenSet: null, estimand: "ate" } as const;

export const useWorkbenchStore = create<WorkbenchStore>((set, get) => ({
  view: "start",
  step: "graph",
  canResume: false,
  layoutVersion: 0,
  graphTextOpen: false,
  setView: (view) => set({ view, canResume: get().canResume || (view === "start" && get().view === "workspace") }),
  setStep: (step) => set({ step }),
  setGraphTextOpen: (graphTextOpen) => set({ graphTextOpen }),
  graph: initialTemplate,
  dataContext: {
    hasData: false,
    treatmentType: "unknown",
    outcomeType: "unknown",
    datasetName: null,
    highDimensional: false,
    columnBindings: {},
  },
  templates: graphTemplates,
  analysis: null,
  uploadedDataset: null,
  activeTab: "assumptions",
  textDraft: graphToEdgeListText(initialTemplate),
  parseError: null,
  isAnalyzing: false,
  analysisError: null,
  selectedExplainable: null,
  highlightedPathId: null,
  previewArrow: null,
  applyTemplate: (templateId) => {
    const template = get().templates.find((item) => item.id === templateId) ?? graphTemplates[0];
    set({
      graph: layoutGraph(template.graph),
      textDraft: graphToEdgeListText(template.graph),
      parseError: null,
      analysis: null,
      analysisError: null,
      uploadedDataset: null,
      dataContext: {
        ...get().dataContext,
        ...FRESH_CHOICES,
        hasData: false,
        datasetName: null,
      },
      selectedExplainable: null,
      highlightedPathId: null,
      previewArrow: null,
      activeTab: "assumptions",
      view: "workspace",
      step: "graph",
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
      nodes: [...get().graph.nodes, createNode(nodeId, ...nextFreeSpot(get().graph))],
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
    const { dataContext } = get();
    const bindings = { ...dataContext.columnBindings };
    if (nodeId in bindings) {
      bindings[nextId] = bindings[nodeId];
      delete bindings[nodeId];
    }
    set({
      graph: nextGraph,
      textDraft: graphToEdgeListText(nextGraph),
      dataContext: {
        ...dataContext,
        columnBindings: bindings,
        chosenSet: dataContext.chosenSet?.map((node) => (node === nodeId ? nextId : node)) ?? null,
      },
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
    const { dataContext } = get();
    const bindings = { ...dataContext.columnBindings };
    delete bindings[nodeId];
    set({
      graph: nextGraph,
      textDraft: graphToEdgeListText(nextGraph),
      dataContext: {
        ...dataContext,
        columnBindings: bindings,
        chosenSet: dataContext.chosenSet?.filter((node) => node !== nodeId) ?? null,
      },
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
  applyArrowEdit: ({ edit, source, target }) => {
    const { graph } = get();
    const without = graph.edges.filter((edge) => !(edge.source === source && edge.target === target));
    const edges =
      edit === "remove"
        ? without
        : edit === "reverse"
          ? [...without, { id: makeEdgeId(target, source), source: target, target: source }]
          : [...graph.edges, { id: makeEdgeId(source, target), source, target }];
    const nextGraph: GraphSpec = { ...graph, edges };
    set({ graph: nextGraph, textDraft: graphToEdgeListText(nextGraph), previewArrow: null });
  },
  setNodeObserved: (nodeId, observed) => {
    const { graph, dataContext } = get();
    const nextGraph = { ...graph, nodes: graph.nodes.map((node) => (node.id === nodeId ? { ...node, observed } : node)) };
    set({
      graph: nextGraph,
      textDraft: graphToEdgeListText(nextGraph),
      dataContext: observed ? dataContext : { ...dataContext, chosenSet: dataContext.chosenSet?.filter((node) => node !== nodeId) ?? null },
    });
  },
  setNodeTiming: (nodeId, timing) => {
    const { graph } = get();
    set({ graph: { ...graph, nodes: graph.nodes.map((node) => (node.id === nodeId ? { ...node, timing } : node)) } });
  },
  setColumnBinding: (nodeId, column) => {
    const { dataContext } = get();
    set({ dataContext: { ...dataContext, columnBindings: { ...dataContext.columnBindings, [nodeId]: column } } });
  },
  addColumnsAsVariables: (columns) => {
    const { graph, dataContext } = get();
    const used = new Set(graph.nodes.map((node) => node.id));
    const bindings = { ...dataContext.columnBindings };
    const added: GraphSpec["nodes"] = [];
    for (const column of columns) {
      const nodeId = createNodeId(column, used);
      used.add(nodeId);
      bindings[nodeId] = column;
      added.push(createNode(nodeId, ...nextFreeSpot({ ...graph, nodes: [...graph.nodes, ...added] })));
    }
    const nextGraph = { ...graph, nodes: [...graph.nodes, ...added] };
    set({ graph: nextGraph, textDraft: graphToEdgeListText(nextGraph), dataContext: { ...dataContext, columnBindings: bindings } });
  },
  relayoutGraph: () => {
    const nextGraph = layoutGraph({
      ...get().graph,
      nodes: get().graph.nodes.map((node) => ({ ...node, x: 0, y: 0 })),
    });
    set({ graph: nextGraph, textDraft: graphToEdgeListText(nextGraph), layoutVersion: get().layoutVersion + 1 });
  },
  clearGraph: () =>
    set({
      graph: { nodes: [], edges: [], treatmentId: null, outcomeId: null },
      analysis: null,
      analysisError: null,
      activeTab: "assumptions",
      uploadedDataset: null,
      dataContext: {
        ...get().dataContext,
        ...FRESH_CHOICES,
        hasData: false,
        datasetName: null,
      },
      textDraft: "",
      parseError: null,
      selectedExplainable: null,
      highlightedPathId: null,
      previewArrow: null,
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
  setAnalysisError: (value) => set({ analysisError: value }),
  setActiveTab: (tab) => set({ activeTab: tab }),
  setSelectedExplainable: (selection) => set({ selectedExplainable: selection }),
  setHighlightedPathId: (pathId) => set({ highlightedPathId: pathId }),
  setPreviewArrow: (arrow) => set({ previewArrow: arrow }),
  hydrateProject: (snapshot) =>
    set({
      graph: layoutGraph(snapshot.graph),
      dataContext: snapshot.dataContext,
      uploadedDataset: snapshot.uploadedDataset,
      analysis: null,
      analysisError: null,
      activeTab: "assumptions",
      view: "workspace",
      step: snapshot.uploadedDataset ? "result" : "graph",
      textDraft: graphToEdgeListText(snapshot.graph),
      parseError: null,
      selectedExplainable: null,
      highlightedPathId: null,
      previewArrow: null,
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
