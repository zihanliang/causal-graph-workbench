import type { GraphTemplate } from "@causal-graph-workbench/shared";

export const fallbackTemplates: GraphTemplate[] = [
  {
    id: "simple-confounding",
    name: "Simple confounding",
    description: "One confounder affects both treatment and outcome.",
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
  },
  {
    id: "mediation",
    name: "Mediation example",
    description: "A mediator lies between treatment and outcome.",
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
  },
  {
    id: "collider-bias",
    name: "Collider bias",
    description: "A collider blocks the path until conditioned on.",
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
  },
  {
    id: "selection-bias-shape",
    name: "Selection bias example",
    description: "Selection-like collider shape. Backdoor logic only.",
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
  },
];
