import type { GraphChange } from "./graphVersions";

export interface TourStop {
  title: string;
  body: string;
  step: "graph" | "data" | "result";
  tab?: "steps" | "assumptions" | "compare";
  /** An arrow shown on the canvas without changing the graph. */
  preview?: { edit: "add"; source: string; target: string };
  /** A second graph to compare with the first, made when this stop is reached. */
  adds?: GraphChange;
}

const MISSING_ARROW = { edit: "add", source: "education", target: "training" } as const;

/** The worked example, built up in the order someone would do it. The figures are checked against the engine in a test. */
export const TOUR_STOPS: TourStop[] = [
  {
    title: "Start with the question",
    body: "A study of 2,000 workers asks whether a training program raises later earnings. So training is the treatment and earnings_after is the outcome, chosen at the top of this panel.",
    step: "graph",
  },
  {
    title: "Draw what you believe",
    body: "Each arrow says one variable directly affects another. This graph is the researcher's belief, drawn from what they know about the study. Nothing has checked it yet.",
    step: "graph",
  },
  {
    title: "Add the data",
    body: "The file has one row per worker. Each column is matched to a variable by name, and you can change a match by hand.",
    step: "data",
  },
  {
    title: "See how the answer is reached",
    body: "The answer stays at the top. Below it, each step shows how it was worked out. Open one, and the graph shows what that step is about.",
    step: "result",
    tab: "steps",
  },
  {
    title: "See what it rests on",
    body: "The graph left out education → training, and the data disagrees with that. If the arrow is real, the estimate goes from 4.630 to 2.882. The true effect in this simulated study is 2.8.",
    step: "result",
    tab: "assumptions",
    preview: MISSING_ARROW,
  },
  {
    title: "Not sure which graph is right?",
    body: "Keep both, and compare them. Here one set of variables is valid under both graphs, so you do not have to choose between them first.",
    step: "result",
    tab: "compare",
    adds: MISSING_ARROW,
  },
];
