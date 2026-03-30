import type { DataContext, GraphSpec, UploadedDataset } from "@causal-workbench/shared";

import { publicAssetPath } from "./urls";

export interface ExampleProject {
  id: string;
  name: string;
  description: string;
  graph: GraphSpec;
  dataContext: DataContext;
  datasetUrl?: string;
  datasetFilename?: string;
  badge?: string;
}

export const exampleProjects: ExampleProject[] = [
  {
    id: "simple-confounding-demo",
    name: "Simple confounding + demo CSV",
    description: "Loads a basic confounding DAG with a demo dataset and column bindings so the data-enhanced flow is immediately usable.",
    badge: "data-enhanced",
    graph: {
      nodes: [
        { id: "Z", label: "Z", x: 120, y: 80 },
        { id: "X", label: "X", x: 320, y: 60 },
        { id: "Y", label: "Y", x: 520, y: 220 },
      ],
      edges: [
        { id: "Z->X", source: "Z", target: "X" },
        { id: "Z->Y", source: "Z", target: "Y" },
        { id: "X->Y", source: "X", target: "Y" },
      ],
      treatmentId: "X",
      outcomeId: "Y",
    },
    dataContext: {
      hasData: true,
      treatmentType: "unknown",
      outcomeType: "unknown",
      datasetName: "simple-confounding-study.csv",
      highDimensional: false,
      columnBindings: {
        X: "treatment_status",
        Y: "outcome_score",
        Z: "baseline_risk",
      },
    },
    datasetUrl: publicAssetPath("demo-data/simple-confounding-study.csv"),
    datasetFilename: "simple-confounding-study.csv",
  },
  {
    id: "simple-confounding",
    name: "Simple confounding",
    description: "One confounder affects both treatment and outcome.",
    badge: "graph-only",
    graph: {
      nodes: [
        { id: "Z", label: "Z", x: 120, y: 80 },
        { id: "X", label: "X", x: 320, y: 60 },
        { id: "Y", label: "Y", x: 520, y: 220 },
      ],
      edges: [
        { id: "Z->X", source: "Z", target: "X" },
        { id: "Z->Y", source: "Z", target: "Y" },
        { id: "X->Y", source: "X", target: "Y" },
      ],
      treatmentId: "X",
      outcomeId: "Y",
    },
    dataContext: {
      hasData: false,
      treatmentType: "unknown",
      outcomeType: "unknown",
      datasetName: null,
      highDimensional: false,
      columnBindings: {},
    },
  },
  {
    id: "mediation",
    name: "Mediation",
    description: "A mediator sits on the directed path from treatment to outcome.",
    badge: "graph-only",
    graph: {
      nodes: [
        { id: "X", label: "X", x: 120, y: 140 },
        { id: "M", label: "M", x: 320, y: 140 },
        { id: "Y", label: "Y", x: 520, y: 140 },
        { id: "Z", label: "Z", x: 320, y: 20 },
      ],
      edges: [
        { id: "X->M", source: "X", target: "M" },
        { id: "M->Y", source: "M", target: "Y" },
        { id: "X->Y", source: "X", target: "Y" },
        { id: "Z->X", source: "Z", target: "X" },
        { id: "Z->Y", source: "Z", target: "Y" },
      ],
      treatmentId: "X",
      outcomeId: "Y",
    },
    dataContext: {
      hasData: false,
      treatmentType: "unknown",
      outcomeType: "unknown",
      datasetName: null,
      highDimensional: false,
      columnBindings: {},
    },
  },
  {
    id: "collider-bias",
    name: "Collider bias",
    description: "Conditioning on the collider changes the noncausal path status.",
    badge: "graph-only",
    graph: {
      nodes: [
        { id: "X", label: "X", x: 120, y: 180 },
        { id: "C", label: "C", x: 320, y: 100 },
        { id: "Y", label: "Y", x: 520, y: 180 },
        { id: "U", label: "U", x: 320, y: 260 },
      ],
      edges: [
        { id: "X->C", source: "X", target: "C" },
        { id: "U->C", source: "U", target: "C" },
        { id: "U->Y", source: "U", target: "Y" },
      ],
      treatmentId: "X",
      outcomeId: "Y",
    },
    dataContext: {
      hasData: false,
      treatmentType: "unknown",
      outcomeType: "unknown",
      datasetName: null,
      highDimensional: false,
      columnBindings: {},
    },
  },
  {
    id: "selection-bias-example",
    name: "Selection bias example",
    description: "Selection-like collider structure for backdoor reasoning only.",
    badge: "graph-only",
    graph: {
      nodes: [
        { id: "X", label: "X", x: 120, y: 180 },
        { id: "S", label: "S", x: 320, y: 100 },
        { id: "Y", label: "Y", x: 520, y: 180 },
        { id: "U", label: "U", x: 320, y: 260 },
      ],
      edges: [
        { id: "X->S", source: "X", target: "S" },
        { id: "Y->S", source: "Y", target: "S" },
        { id: "U->X", source: "U", target: "X" },
        { id: "U->Y", source: "U", target: "Y" },
      ],
      treatmentId: "X",
      outcomeId: "Y",
    },
    dataContext: {
      hasData: false,
      treatmentType: "unknown",
      outcomeType: "unknown",
      datasetName: null,
      highDimensional: false,
      columnBindings: {},
    },
  },
];

export async function buildExampleProjectSnapshot(example: ExampleProject) {
  const uploadedDataset = example.datasetUrl
    ? await fetchExampleDataset(example.datasetUrl, example.datasetFilename)
    : null;

  return {
    version: "0.2.0",
    savedAt: new Date().toISOString(),
    graph: example.graph,
    dataContext: example.dataContext,
    uploadedDataset,
  };
}

async function fetchExampleDataset(url: string, filename?: string): Promise<UploadedDataset> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to load demo dataset from ${url}.`);
  }
  return {
    filename: filename ?? "demo.csv",
    content: await response.text(),
  };
}
