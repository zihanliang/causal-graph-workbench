import type {
  AnalysisResult,
  AssumptionEdit,
  DataContext,
  ExplainableSelection,
  GraphSpec,
  GraphTemplate,
  GraphVersion,
  PairState,
  UncertainPair,
  UploadedDataset,
  VariableTiming,
} from "@causal-graph-workbench/shared";
import { create } from "zustand";

import { applyPairStates } from "../engine/pairStates";
import type { Draft } from "../lib/draftGraph";
import { createNode, createNodeId, graphToEdgeListText, makeEdgeId, parseEdgeListText } from "../lib/edgeList";
import { graphTemplates } from "../lib/graphTemplates";
import {
  applyChange,
  currentVersions,
  firstVersion,
  MAX_GRAPH_VERSIONS,
  MAX_UNCERTAIN_PAIRS,
  nextVersionIdentity,
  renameInGraph,
  samePair,
  structuralKey,
  type GraphChange,
} from "../lib/graphVersions";
import { layoutGraph } from "../lib/layout";
import type { ProjectSnapshot } from "../lib/projectSnapshot";
import { TOUR_STOPS } from "../lib/tour";

export type AppView = "start" | "draft" | "workspace";
export type WorkStep = "graph" | "data" | "result";
export type PanelTab = "steps" | "assumptions" | "compare" | "code";
/** The steps of "How it was worked out" that open. The last one leads to another tab instead. */
export type ResultStepId = "question" | "paths" | "set" | "data" | "estimate";

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
  /** The graph that is open. Every edit goes here, and its entry in `versions` catches up when another is opened. */
  graph: GraphTemplate["graph"];
  /** Every graph being compared, including the open one. */
  versions: GraphVersion[];
  activeVersionId: string;
  /** Arrows the user is not sure of. Every combination is tried on the open graph. */
  uncertainPairs: UncertainPair[];
  /** The graph as it was first drafted from time order, until something else starts. */
  draftKey: string | null;
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
  openStep: ResultStepId | null;
  hoveredStep: ResultStepId | null;
  /** Where the walkthrough of the worked example has got to, or null outside it. */
  tourStop: number | null;
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
  /** Keeps a copy of the open graph with this change, or a plain copy without one. Returns its id, or null at the limit. */
  addVersion: (change?: GraphChange) => string | null;
  /** Opens a new copy of the open graph to edit. */
  tryAnotherGraph: () => void;
  selectVersion: (versionId: string) => void;
  removeVersion: (versionId: string) => void;
  addUncertainPair: (first: string, second: string) => void;
  removeUncertainPair: (pair: UncertainPair) => void;
  /** Keeps one combination of unsure arrows as a graph to compare. Returns its id, or null at the limit. */
  keepCombination: (states: PairState[]) => string | null;
  startFromDraft: (draft: Draft, dataset: UploadedDataset) => void;
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
  setOpenStep: (step: ResultStepId | null) => void;
  setHoveredStep: (step: ResultStepId | null) => void;
  goToTourStop: (stop: number) => void;
  endTour: () => void;
  hydrateProject: (snapshot: ProjectSnapshot) => void;
}

/** A draft says only what time order allows, and assumes more than it appears to. Once edited, it says what its author says. */
export const selectIsDraft = (state: WorkbenchStore): boolean => state.draftKey !== null && state.draftKey === structuralKey(state.graph);

/** What the canvas should show for the step in focus, if the steps are what is on screen. */
export const selectStepFocus = (state: WorkbenchStore): ResultStepId | null =>
  state.step === "result" && state.activeTab === "steps" ? (state.hoveredStep ?? state.openStep) : null;

/** An arrow being considered: one under the pointer, or the one the walkthrough is talking about. */
export const selectPreviewArrow = (state: WorkbenchStore): ArrowPreview | null =>
  state.previewArrow ?? (state.tourStop !== null ? (TOUR_STOPS[state.tourStop]?.preview ?? null) : null);

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

/** What a variable is, and which question is asked, do not depend on which story is being told. */
function acrossVersions(state: WorkbenchStore, change: (graph: GraphSpec) => GraphSpec): { graph: GraphSpec; versions: GraphVersion[] } {
  return { graph: change(state.graph), versions: state.versions.map((version) => ({ ...version, graph: change(version.graph) })) };
}

const updateNode = (graph: GraphSpec, nodeId: string, patch: Partial<GraphSpec["nodes"][number]>): GraphSpec => ({
  ...graph,
  nodes: graph.nodes.map((node) => (node.id === nodeId ? { ...node, ...patch } : node)),
});

/** What belongs to one project, and so goes when another starts. */
const NOTHING_UNSETTLED = { uncertainPairs: [] as UncertainPair[], draftKey: null, tourStop: null };

const NOTHING_HIGHLIGHTED = { selectedExplainable: null, highlightedPathId: null, previewArrow: null, hoveredStep: null } as const;
const NOTHING_IN_FOCUS = { ...NOTHING_HIGHLIGHTED, openStep: null } as const;

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
  ...firstVersion(initialTemplate),
  uncertainPairs: [],
  draftKey: null,
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
  activeTab: "steps",
  textDraft: graphToEdgeListText(initialTemplate),
  parseError: null,
  isAnalyzing: false,
  analysisError: null,
  ...NOTHING_IN_FOCUS,
  tourStop: null,
  applyTemplate: (templateId) => {
    const template = get().templates.find((item) => item.id === templateId) ?? graphTemplates[0];
    const graph = layoutGraph(template.graph);
    set({
      graph,
      ...firstVersion(graph),
      ...NOTHING_UNSETTLED,
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
      ...NOTHING_IN_FOCUS,
      activeTab: "steps",
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
    // Unique in every graph, because the same variable keeps one name in all of them.
    const otherIds = new Set(currentVersions(get()).flatMap((version) => version.graph.nodes.map((node) => node.id)).filter((id) => id !== nodeId));
    const nextId = createNodeId(normalizedLabel, otherIds);
    const renamed = acrossVersions(get(), (graph) => renameInGraph(graph, nodeId, nextId));
    const { dataContext } = get();
    const bindings = { ...dataContext.columnBindings };
    if (nodeId in bindings) {
      bindings[nextId] = bindings[nodeId];
      delete bindings[nodeId];
    }
    set({
      ...renamed,
      textDraft: graphToEdgeListText(renamed.graph),
      uncertainPairs: get().uncertainPairs.map((pair) => ({ first: pair.first === nodeId ? nextId : pair.first, second: pair.second === nodeId ? nextId : pair.second })),
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
  // Everywhere, so that a variable stays put when another graph is opened.
  updateNodePosition: (nodeId, x, y) => set(acrossVersions(get(), (graph) => updateNode(graph, nodeId, { x, y }))),
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
      uncertainPairs: get().uncertainPairs.filter((pair) => pair.first !== nodeId && pair.second !== nodeId),
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
  addVersion: (change) => {
    const state = get();
    const versions = currentVersions(state);
    const graph = change ? applyChange(state.graph, change) : state.graph;
    if (change) {
      const existing = versions.find((version) => structuralKey(version.graph) === structuralKey(graph));
      if (existing) {
        return existing.id;
      }
    }
    if (versions.length >= MAX_GRAPH_VERSIONS) {
      return null;
    }
    const identity = nextVersionIdentity(versions);
    set({ versions: [...versions, { ...identity, graph }], previewArrow: null });
    return identity.id;
  },
  tryAnotherGraph: () => {
    const id = get().addVersion();
    if (id) {
      get().selectVersion(id);
      set({ step: "graph", tourStop: null });
    } else {
      set({ step: "result", activeTab: "compare", tourStop: null });
    }
  },
  selectVersion: (versionId) => {
    const versions = currentVersions(get());
    const target = versions.find((version) => version.id === versionId);
    if (target) {
      // The open step stays open, so that the same step can be read across graphs.
      set({ versions, activeVersionId: versionId, graph: target.graph, textDraft: graphToEdgeListText(target.graph), parseError: null, ...NOTHING_HIGHLIGHTED });
    }
  },
  removeVersion: (versionId) => {
    const versions = currentVersions(get());
    const remaining = versions.filter((version) => version.id !== versionId);
    if (!remaining.length) {
      return;
    }
    if (versionId === get().activeVersionId) {
      set({ versions: remaining, activeVersionId: remaining[0].id, graph: remaining[0].graph, textDraft: graphToEdgeListText(remaining[0].graph), parseError: null, ...NOTHING_HIGHLIGHTED });
    } else {
      set({ versions: remaining });
    }
  },
  addUncertainPair: (first, second) => {
    const { uncertainPairs, graph } = get();
    const isQuestion = (first === graph.treatmentId && second === graph.outcomeId) || (first === graph.outcomeId && second === graph.treatmentId);
    if (first === second || isQuestion || uncertainPairs.length >= MAX_UNCERTAIN_PAIRS || uncertainPairs.some((pair) => samePair(pair, { first, second }))) {
      return;
    }
    set({ uncertainPairs: [...uncertainPairs, { first, second }] });
  },
  removeUncertainPair: (pair) => set({ uncertainPairs: get().uncertainPairs.filter((item) => !samePair(item, pair)) }),
  keepCombination: (states) => {
    const state = get();
    const versions = currentVersions(state);
    const graph = applyPairStates(state.graph, states);
    const existing = versions.find((version) => structuralKey(version.graph) === structuralKey(graph));
    if (existing) {
      return existing.id;
    }
    if (versions.length >= MAX_GRAPH_VERSIONS) {
      return null;
    }
    const identity = nextVersionIdentity(versions);
    set({ versions: [...versions, { ...identity, graph }] });
    return identity.id;
  },
  startFromDraft: ({ graph, columnBindings, uncertainPairs }, dataset) =>
    set({
      graph,
      ...firstVersion(graph),
      ...NOTHING_UNSETTLED,
      uncertainPairs,
      draftKey: structuralKey(graph),
      uploadedDataset: dataset,
      dataContext: { ...FRESH_CHOICES, hasData: true, treatmentType: "unknown", outcomeType: "unknown", datasetName: dataset.filename ?? null, highDimensional: false, columnBindings },
      analysis: null,
      analysisError: null,
      activeTab: "steps",
      view: "workspace",
      step: "graph",
      textDraft: graphToEdgeListText(graph),
      parseError: null,
      ...NOTHING_IN_FOCUS,
    }),
  setNodeObserved: (nodeId, observed) => {
    const { dataContext } = get();
    const changed = acrossVersions(get(), (graph) => updateNode(graph, nodeId, { observed }));
    set({
      ...changed,
      textDraft: graphToEdgeListText(changed.graph),
      dataContext: observed ? dataContext : { ...dataContext, chosenSet: dataContext.chosenSet?.filter((node) => node !== nodeId) ?? null },
    });
  },
  setNodeTiming: (nodeId, timing) => set(acrossVersions(get(), (graph) => updateNode(graph, nodeId, { timing }))),
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
    const placed = new Map(nextGraph.nodes.map((node) => [node.id, node]));
    const versions = get().versions.map((version) => ({
      ...version,
      graph: { ...version.graph, nodes: version.graph.nodes.map((node) => ({ ...node, x: placed.get(node.id)?.x ?? node.x, y: placed.get(node.id)?.y ?? node.y })) },
    }));
    set({ graph: nextGraph, versions, textDraft: graphToEdgeListText(nextGraph), layoutVersion: get().layoutVersion + 1 });
  },
  clearGraph: () => {
    const graph: GraphSpec = { nodes: [], edges: [], treatmentId: null, outcomeId: null };
    set({
      graph,
      ...firstVersion(graph),
      ...NOTHING_UNSETTLED,
      analysis: null,
      analysisError: null,
      activeTab: "steps",
      uploadedDataset: null,
      dataContext: {
        ...get().dataContext,
        ...FRESH_CHOICES,
        hasData: false,
        datasetName: null,
      },
      textDraft: "",
      parseError: null,
      ...NOTHING_IN_FOCUS,
    });
  },
  setUploadedDataset: (dataset) =>
    set({
      uploadedDataset: dataset,
      dataContext: {
        ...get().dataContext,
        hasData: Boolean(dataset),
        datasetName: dataset?.filename ?? null,
      },
    }),
  setTreatment: (nodeId) => set(acrossVersions(get(), (graph) => ({ ...graph, treatmentId: nodeId }))),
  setOutcome: (nodeId) => set(acrossVersions(get(), (graph) => ({ ...graph, outcomeId: nodeId }))),
  setDataContext: (partial) => set({ dataContext: { ...get().dataContext, ...partial } }),
  setAnalysis: (analysis) => set({ analysis }),
  setIsAnalyzing: (value) => set({ isAnalyzing: value }),
  setAnalysisError: (value) => set({ analysisError: value }),
  setActiveTab: (tab) => set({ activeTab: tab }),
  setSelectedExplainable: (selection) => set({ selectedExplainable: selection }),
  setHighlightedPathId: (pathId) => set({ highlightedPathId: pathId }),
  setPreviewArrow: (arrow) => set({ previewArrow: arrow }),
  setOpenStep: (openStep) => set({ openStep }),
  setHoveredStep: (hoveredStep) => set({ hoveredStep }),
  goToTourStop: (stop) => {
    const { step, tab, adds } = TOUR_STOPS[stop];
    if (adds) {
      get().addVersion(adds);
    }
    set({ tourStop: stop, step, ...(tab ? { activeTab: tab } : {}), ...NOTHING_IN_FOCUS });
  },
  endTour: () => set({ tourStop: null }),
  hydrateProject: (snapshot) => {
    // A project file can come from anyone, so it gets no more graphs, or repeats of one, than the page itself would make.
    const saved = snapshot.versions?.filter((version, index, all) => all.findIndex((other) => other.id === version.id) === index).slice(0, MAX_GRAPH_VERSIONS);
    const versions = saved?.length ? saved.map((version) => ({ ...version, graph: layoutGraph(version.graph) })) : null;
    const active = versions?.find((version) => version.id === snapshot.activeVersionId) ?? versions?.[0] ?? null;
    const graph = active ? active.graph : layoutGraph(snapshot.graph);
    set({
      graph,
      ...(versions && active ? { versions, activeVersionId: active.id } : firstVersion(graph)),
      ...NOTHING_UNSETTLED,
      uncertainPairs: (snapshot.uncertainPairs ?? []).filter((pair, index, all) => pair.first !== pair.second && all.findIndex((other) => samePair(other, pair)) === index).slice(0, MAX_UNCERTAIN_PAIRS),
      dataContext: snapshot.dataContext,
      uploadedDataset: snapshot.uploadedDataset,
      analysis: null,
      analysisError: null,
      activeTab: "steps",
      view: "workspace",
      step: snapshot.uploadedDataset ? "result" : "graph",
      textDraft: graphToEdgeListText(graph),
      parseError: null,
      ...NOTHING_IN_FOCUS,
    });
  },
}));

export function buildProjectSnapshot(): ProjectSnapshot {
  const state = useWorkbenchStore.getState();
  const versions = currentVersions(state);
  return {
    version: "0.3.0",
    savedAt: new Date().toISOString(),
    graph: state.graph,
    dataContext: state.dataContext,
    uploadedDataset: state.uploadedDataset,
    ...(versions.length > 1 ? { versions, activeVersionId: state.activeVersionId } : {}),
    ...(state.uncertainPairs.length ? { uncertainPairs: state.uncertainPairs } : {}),
  };
}
