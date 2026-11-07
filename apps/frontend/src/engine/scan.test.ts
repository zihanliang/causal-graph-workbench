import type { AnalysisRequest, GraphSpec, UncertainPair } from "@causal-graph-workbench/shared";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, test } from "vitest";

import { exampleProjects } from "../lib/exampleProjects";
import { analyze, analyzeInStages } from "./analyze";
import { combineUpdates, mergeUpdate, type AnalysisUpdate } from "./mergeUpdate";
import { applyPairStates, currentPairState } from "./pairStates";
import { usablePairs } from "./scan";

const example = exampleProjects.find((item) => item.id === "training-program")!;
const content = readFileSync(resolve(__dirname, "../../public/demo-data/training-program-study.csv"), "utf-8");
const dataset = { filename: "training-program-study.csv", content };
const withoutTiming: GraphSpec = { ...example.graph, nodes: example.graph.nodes.map(({ timing: _timing, ...node }) => node) };

const scanOf = (graph: GraphSpec, uncertainPairs: UncertainPair[], extra: Partial<AnalysisRequest> = {}) => analyze({ graph, dataset, uncertainPairs, ...extra }).scan!;
const educationTraining = { first: "education", second: "training" };
const priorTraining = { first: "prior_earnings", second: "training" };

describe("trying every combination of unsure arrows", () => {
  test("the timing that was set rules out arrows that would run backwards, and says how many", () => {
    const scan = scanOf(example.graph, [educationTraining, priorTraining]);
    expect(scan.status).toBe("complete");
    expect(scan.combinations).toBe(9);
    expect(scan.ruledOutByTiming).toBe(5);
    expect(scan.ruledOutByCycle).toBe(0);
    expect(scan.analysed).toBe(4);
  });

  test("without timing, more combinations stay in, and those that form a cycle are left out", () => {
    const scan = scanOf(withoutTiming, [educationTraining, priorTraining]);
    expect(scan.ruledOutByTiming).toBe(0);
    expect(scan.ruledOutByCycle).toBeGreaterThan(0);
    expect(scan.analysed + scan.ruledOutByCycle).toBe(9);
  });

  test("each answer's figure is what that graph gives when it is opened", () => {
    const scan = scanOf(withoutTiming, [educationTraining, priorTraining]);
    for (const answer of scan.answers) {
      const opened = analyze({ graph: applyPairStates(withoutTiming, answer.example), dataset });
      expect(opened.baselineSet).toEqual(answer.adjustmentSet);
      expect(opened.effect?.estimate?.estimate).toBe(answer.estimate?.estimate);
    }
  });

  test("the combinations of an answer add up, and every combination is in one answer", () => {
    const scan = scanOf(withoutTiming, [educationTraining, priorTraining]);
    expect(scan.answers.reduce((total, answer) => total + answer.combinations, 0)).toBe(scan.analysed);
    expect(new Set(scan.answers.map((answer) => JSON.stringify(answer.adjustmentSet))).size).toBe(scan.answers.length);
  });

  test("says which pair the answer depends on", () => {
    const scan = scanOf(example.graph, [educationTraining, { first: "education", second: "promoted" }]);
    expect(scan.pairEffects).toEqual([
      { ...educationTraining, changesAnswer: true },
      { first: "education", second: "promoted", changesAnswer: false },
    ]);
  });

  test("the example for an answer stays closest to the graph on show", () => {
    const scan = scanOf(example.graph, [educationTraining, { first: "education", second: "promoted" }]);
    const shown = scan.answers.find((answer) => answer.adjustmentSet?.join() === "age,prior_earnings")!;
    const adding = scan.answers.find((answer) => answer.adjustmentSet?.join() === "age,education,prior_earnings")!;
    expect(adding.exampleChange).toBe("+ education → training");
    expect(adding.estimate!.estimate).toBeCloseTo(2.882, 2);
    expect(adding.contradicted).toBe(0);
    // The graph on show is contradicted by the data, so an equally close one that is not would be preferred. Here there is none.
    expect(shown.contradicted).toBe(shown.checked);
  });

  test("reports a set valid under the combinations that disagree", () => {
    const scan = scanOf(example.graph, [educationTraining]);
    expect(scan.sharedSet).toMatchObject({ variables: ["age", "education", "prior_earnings"], validIn: 2 });
    expect(scan.sharedSet!.estimate!.estimate).toBeCloseTo(2.882, 2);
  });

  test("a chosen estimand reaches every combination", () => {
    const scan = scanOf(example.graph, [educationTraining], { dataContext: { estimand: "att" } });
    expect(scan.answers.every((answer) => answer.estimate!.estimand === "att")).toBe(true);
  });

  test("without data it still compares sets, and has no checks to report", () => {
    const scan = analyze({ graph: example.graph, uncertainPairs: [educationTraining] }).scan!;
    expect(scan.answers.map((answer) => answer.adjustmentSet)).toEqual([["age", "prior_earnings"], ["age", "education", "prior_earnings"]]);
    expect(scan.answers.every((answer) => answer.estimate === null && answer.checked === 0)).toBe(true);
    expect(scan.status).toBe("complete");
  });

  test("something unmeasured can leave no valid set, which is an answer too", () => {
    const hidden: GraphSpec = {
      nodes: ["U", "X", "Y"].map((id) => ({ id, label: id, x: 0, y: 0, observed: id !== "U" })),
      edges: [
        { id: "X->Y", source: "X", target: "Y" },
        { id: "U->Y", source: "U", target: "Y" },
      ],
      treatmentId: "X",
      outcomeId: "Y",
    };
    const scan = analyze({ graph: hidden, uncertainPairs: [{ first: "U", second: "X" }] }).scan!;
    expect(scan.answers.map((answer) => answer.adjustmentSet)).toEqual([[], null]);
    expect(scan.pairEffects[0].changesAnswer).toBe(true);
  });

  test("the question itself cannot be marked, nor a pair that names a variable the graph lacks", () => {
    expect(usablePairs(example.graph, [{ first: "training", second: "earnings_after" }, { first: "earnings_after", second: "training" }, { first: "gone", second: "age" }, { first: "age", second: "age" }])).toEqual([]);
    expect(analyze({ graph: example.graph, uncertainPairs: [{ first: "training", second: "earnings_after" }] }).scan).toBeNull();
  });

  test("runs at the largest size allowed", () => {
    const pairs = [educationTraining, priorTraining, { first: "age", second: "education" }, { first: "skills_after", second: "promoted" }];
    const scan = scanOf(withoutTiming, pairs);
    expect(scan.combinations).toBe(81);
    expect(scan.status).toBe("complete");
    expect(scan.truncated).toBe(false);
    expect(scan.analysed + scan.ruledOutByCycle + scan.ruledOutByTiming).toBe(81);
  });
});

describe("the arrows a pair can have", () => {
  test("setting a state replaces whatever was there, in either direction", () => {
    const graph = applyPairStates(example.graph, [{ ...priorTraining, state: "second_to_first" }]);
    expect(graph.edges.map((edge) => edge.id)).toContain("training->prior_earnings");
    expect(graph.edges.map((edge) => edge.id)).not.toContain("prior_earnings->training");
    expect(currentPairState(graph, "prior_earnings", "training")).toBe("second_to_first");
    expect(currentPairState(applyPairStates(graph, [{ ...priorTraining, state: "none" }]), "prior_earnings", "training")).toBe("none");
  });
});

describe("the scan reaches the page", () => {
  test("nothing is lost when updates are held back between sends", () => {
    const versions = [
      { id: "a", name: "Graph A", graph: example.graph },
      { id: "b", name: "Graph B", graph: applyPairStates(example.graph, [{ ...educationTraining, state: "first_to_second" }]) },
    ];
    let result = null as ReturnType<typeof analyze> | null;
    let held: AnalysisUpdate | null = null;
    for (const stage of analyzeInStages({ graph: example.graph, dataset, versions, activeVersionId: "a", uncertainPairs: [educationTraining] })) {
      if ("structure" in stage) {
        result = stage.structure;
      } else {
        held = combineUpdates(held, stage.update);
      }
    }
    const received = mergeUpdate(result!, held!);
    expect(received.audit!.status).toBe("complete");
    expect(received.comparison!.status).toBe("complete");
    expect(received.scan!.status).toBe("complete");
  });

  test("no pairs, no scan", () => {
    expect(analyze({ graph: example.graph, dataset }).scan).toBeNull();
    expect(analyze({ graph: example.graph, dataset, uncertainPairs: [] }).scan).toBeNull();
  });
});
