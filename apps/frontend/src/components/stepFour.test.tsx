import type { AnalysisRequest } from "@causal-graph-workbench/shared";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { analyze } from "../engine/analyze";
import { exampleProjects } from "../lib/exampleProjects";
import { firstVersion, MAX_UNCERTAIN_PAIRS, structuralKey } from "../lib/graphVersions";
import { buildProjectSnapshot, selectIsDraft, useWorkbenchStore } from "../store/useWorkbenchStore";
import { parseProjectSnapshotText } from "../lib/export";
import { DraftScreen } from "./DraftScreen";
import { GraphStep } from "./GraphStep";
import { ResultStep } from "./ResultStep";
import { StartScreen } from "./StartScreen";

const example = exampleProjects.find((item) => item.id === "training-program")!;
const content = readFileSync(resolve(__dirname, "../../public/demo-data/training-program-study.csv"), "utf-8");
const dataset = { filename: "training-program-study.csv", content };
const state = () => useWorkbenchStore.getState();

function openCompare(extra: Partial<AnalysisRequest> = {}) {
  const request: AnalysisRequest = { graph: example.graph, dataContext: example.dataContext, dataset, ...extra };
  const analysis = analyze(request);
  useWorkbenchStore.setState({
    graph: request.graph,
    ...firstVersion(request.graph),
    uncertainPairs: request.uncertainPairs ?? [],
    dataContext: request.dataContext ?? {},
    uploadedDataset: request.dataset ?? null,
    analysis,
    activeTab: "compare",
    step: "result",
    tourStop: null,
    draftKey: null,
  });
  return render(<ResultStep analysis={analysis} graph={request.graph} />);
}

function pick(first: string, second: string) {
  fireEvent.change(screen.getByLabelText("Not sure between"), { target: { value: first } });
  fireEvent.change(screen.getByLabelText("And"), { target: { value: second } });
}

beforeEach(() => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(cleanup);

describe("marking arrows as not sure", () => {
  test("is offered before there is a second graph", () => {
    openCompare();
    expect(screen.getByText("Not sure about particular arrows?")).toBeTruthy();
  });

  test("a pair can be marked, and the same pair cannot be marked twice, in either order", () => {
    openCompare();
    pick("education", "training");
    fireEvent.click(screen.getByRole("button", { name: "Mark as not sure" }));
    expect(state().uncertainPairs).toEqual([{ first: "education", second: "training" }]);
    pick("training", "education");
    expect(screen.getByRole<HTMLButtonElement>("button", { name: "Mark as not sure" }).disabled).toBe(true);
  });

  test("the question itself cannot be marked, and it says why", () => {
    openCompare();
    pick("training", "earnings_after");
    expect(screen.getByRole<HTMLButtonElement>("button", { name: "Mark as not sure" }).disabled).toBe(true);
    expect(screen.getByText(/what is being estimated/)).toBeTruthy();
  });

  test("the store refuses what the page would not offer", () => {
    openCompare();
    act(() => {
      state().addUncertainPair("age", "age");
      state().addUncertainPair("earnings_after", "training");
    });
    expect(state().uncertainPairs).toEqual([]);
  });

  test("stops at the limit", () => {
    openCompare({ uncertainPairs: [] });
    act(() => {
      for (const [first, second] of [["age", "education"], ["age", "training"], ["education", "training"], ["age", "promoted"], ["education", "promoted"]]) {
        state().addUncertainPair(first, second);
      }
    });
    expect(state().uncertainPairs).toHaveLength(MAX_UNCERTAIN_PAIRS);
  });

  test("says what every combination leads to, and which pair the answer depends on", () => {
    openCompare({ uncertainPairs: [{ first: "education", second: "training" }, { first: "education", second: "promoted" }] });
    const callout = document.querySelector(".group .callout")!.textContent!;
    expect(callout).toMatch(/\d+ combinations give 2 different answers/);
    expect(callout).toContain("would run backwards in time");
    expect(callout).toContain("The answer depends on education and training.");
    expect(callout).toContain("Taken alone, education and promoted does not change it.");
    expect(callout).toContain("{age, education, prior_earnings} is valid under");
  });

  test("never names a best combination", () => {
    openCompare({ uncertainPairs: [{ first: "education", second: "training" }] });
    expect((document.body.textContent ?? "").toLowerCase()).not.toMatch(/\b(best|most likely|passed|confirmed|verified|validated)\b/);
  });

  test("a long list of answers starts short, and can be opened", () => {
    const pairs = [{ first: "education", second: "training" }, { first: "prior_earnings", second: "training" }, { first: "age", second: "training" }, { first: "age", second: "education" }];
    const withoutTiming = { ...example.graph, nodes: example.graph.nodes.map(({ timing: _timing, ...node }) => node) };
    openCompare({ graph: withoutTiming, uncertainPairs: pairs });
    const total = state().analysis!.scan!.answers.length;
    expect(total).toBeGreaterThan(6);
    const shown = () => document.querySelectorAll(".group .answer").length;
    expect(shown()).toBe(6);
    fireEvent.click(screen.getByRole("button", { name: `Show all ${total} answers` }));
    expect(shown()).toBe(total);
  });

  test("a combination can be kept as a graph to compare, and the graph on show stays", () => {
    openCompare({ uncertainPairs: [{ first: "education", second: "training" }] });
    const before = state().graph;
    fireEvent.click(screen.getByRole("button", { name: "Keep as a graph" }));
    expect(state().versions).toHaveLength(2);
    expect(state().versions[1].graph.edges.map((edge) => edge.id)).toContain("education->training");
    expect(state().graph).toBe(before);
    expect(state().keepCombination([{ first: "education", second: "training", state: "first_to_second" }])).toBe("graph-b");
    expect(state().versions).toHaveLength(2);
  });

  test("while it is working it says so", () => {
    openCompare();
    act(() => state().addUncertainPair("education", "training"));
    cleanup();
    render(<ResultStep analysis={state().analysis} graph={state().graph} />);
    expect(screen.getByText("Trying every combination…")).toBeTruthy();
  });

  test("a mark can be taken back", () => {
    openCompare({ uncertainPairs: [{ first: "education", second: "training" }] });
    fireEvent.click(screen.getByRole("button", { name: "Stop marking education and training as not sure" }));
    expect(state().uncertainPairs).toEqual([]);
  });

  test("an arrow can be marked from its row on the graph step, though not the arrow being estimated", () => {
    useWorkbenchStore.setState({ graph: example.graph, ...firstVersion(example.graph), uncertainPairs: [], analysis: null, draftKey: null, tourStop: null, dataContext: {} });
    render(<GraphStep analysis={null} />);
    fireEvent.click(screen.getByRole("button", { name: /^Arrows/ }));
    fireEvent.click(screen.getByLabelText("Not sure about age to training"));
    expect(state().uncertainPairs).toEqual([{ first: "age", second: "training" }]);
    expect(screen.queryByLabelText("Not sure about training to earnings_after")).toBeNull();
    fireEvent.click(screen.getByLabelText("Not sure about age to training"));
    expect(state().uncertainPairs).toEqual([]);
  });

  test("a new name and a removed variable reach the marks", () => {
    useWorkbenchStore.setState({ graph: example.graph, ...firstVersion(example.graph), uncertainPairs: [{ first: "age", second: "education" }, { first: "age", second: "training" }] });
    state().renameNode("age", "years");
    expect(state().uncertainPairs).toEqual([{ first: "years", second: "education" }, { first: "years", second: "training" }]);
    state().removeNode("education");
    expect(state().uncertainPairs).toEqual([{ first: "years", second: "training" }]);
  });

  test("marks are saved with a project, and a file cannot bring more than the page allows", () => {
    useWorkbenchStore.setState({ graph: example.graph, ...firstVersion(example.graph), uncertainPairs: [{ first: "age", second: "education" }] });
    const saved = buildProjectSnapshot();
    expect(saved.uncertainPairs).toEqual([{ first: "age", second: "education" }]);
    state().clearGraph();
    expect(state().uncertainPairs).toEqual([]);
    const many = Array.from({ length: 30 }, (_, index) => ({ first: "age", second: `V${index}` }));
    state().hydrateProject(parseProjectSnapshotText(JSON.stringify({ ...saved, uncertainPairs: [...many, many[0], { first: "age", second: "age" }] })));
    expect(state().uncertainPairs).toHaveLength(MAX_UNCERTAIN_PAIRS);
    expect(() => parseProjectSnapshotText(JSON.stringify({ ...saved, uncertainPairs: [{ first: 1 }] }))).toThrow(/could not be opened/);
  });
});

describe("starting from a data file", () => {
  async function chooseFile(name: string, text: string) {
    const input = document.querySelector<HTMLInputElement>('input[type="file"]')!;
    Object.defineProperty(input, "files", { configurable: true, value: [{ name, text: async () => text }] });
    await act(async () => {
      fireEvent.change(input);
      await new Promise((done) => setTimeout(done, 30));
    });
  }
  const file = "student_id,tutoring,final_score,income,hours,batch\nS1,1,50,20,3,7\nS2,0,40,30,2,7\nS3,1,55,25,4,7\nS4,0,45,35,1,7\n";

  test("the start screen leads there", () => {
    render(<StartScreen />);
    fireEvent.click(screen.getByRole("button", { name: /Start from a data file/ }));
    expect(state().view).toBe("draft");
  });

  test("asks for nothing it cannot use yet, and will not build without the question", async () => {
    render(<DraftScreen />);
    expect(screen.queryByText("Which effect do you want to know?")).toBeNull();
    expect(screen.getByRole<HTMLButtonElement>("button", { name: "Build a first graph" }).disabled).toBe(true);
    await chooseFile("s.csv", file);
    expect(screen.getByText("Which effect do you want to know?")).toBeTruthy();
    expect(screen.getByRole<HTMLButtonElement>("button", { name: "Build a first graph" }).disabled).toBe(true);
  });

  test("suggests leaving out what identifies rows or never changes", async () => {
    render(<DraftScreen />);
    await chooseFile("s.csv", file);
    expect(screen.getByLabelText<HTMLSelectElement>("When student_id was fixed").value).toBe("leave");
    expect(screen.getByLabelText<HTMLSelectElement>("When batch was fixed").value).toBe("leave");
    expect(screen.getByLabelText<HTMLSelectElement>("When income was fixed").value).toBe("before");
  });

  test("says what this kind of graph assumes, before it is built", async () => {
    render(<DraftScreen />);
    await chooseFile("s.csv", file);
    expect(screen.getByText(/adjusts for everything measured before treatment/)).toBeTruthy();
    expect(screen.getByText(/two unmeasured causes/)).toBeTruthy();
  });

  test("builds the graph from the answers, with the file and its columns in place", async () => {
    render(<DraftScreen />);
    await chooseFile("s.csv", file);
    const [treatment, outcome] = [screen.getByLabelText("Treatment"), screen.getByLabelText("Outcome")];
    fireEvent.change(treatment, { target: { value: "tutoring" } });
    fireEvent.change(outcome, { target: { value: "final_score" } });
    expect(screen.queryByLabelText("When tutoring was fixed")).toBeNull();
    fireEvent.change(screen.getByLabelText("When hours was fixed"), { target: { value: "after" } });
    fireEvent.click(screen.getByRole("button", { name: "Build a first graph" }));
    const built = state();
    expect(built.view).toBe("workspace");
    expect(built.step).toBe("graph");
    expect(selectIsDraft(built)).toBe(true);
    expect(built.graph.treatmentId).toBe("tutoring");
    expect(built.graph.nodes.map((node) => node.id).sort()).toEqual(["final_score", "hours", "income", "tutoring"]);
    expect(built.uploadedDataset?.filename).toBe("s.csv");
    expect(built.dataContext.columnBindings).toMatchObject({ income: "income", hours: "hours" });
    expect(built.versions).toHaveLength(1);
  });

  const asDraft = () => useWorkbenchStore.setState({ graph: example.graph, ...firstVersion(example.graph), draftKey: structuralKey(example.graph), analysis: null, tourStop: null });

  test("the graph step says what the draft assumes, until the graph is edited, when it stops being true", () => {
    asDraft();
    render(<GraphStep analysis={null} />);
    expect(screen.getByText(/This first graph says only what time order allows/)).toBeTruthy();
    act(() => state().removeEdge(example.graph.edges[0].id));
    expect(screen.queryByText(/This first graph says only what time order allows/)).toBeNull();
    expect(selectIsDraft(state())).toBe(false);
  });

  test("moving a variable does not count as editing it", () => {
    asDraft();
    state().updateNodePosition("age", 5, 5);
    expect(selectIsDraft(state())).toBe(true);
  });

  test("the mark goes when another project starts", () => {
    asDraft();
    state().applyTemplate(state().templates[0].id);
    expect(state().draftKey).toBeNull();
  });

  test("the answer says it came from a draft", () => {
    openCompare();
    cleanup();
    useWorkbenchStore.setState({ draftKey: structuralKey(example.graph) });
    render(<ResultStep analysis={state().analysis} graph={state().graph} />);
    expect(screen.getByText(/From a first graph that says only what time order allows/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "What that assumes" }));
    expect(state().step).toBe("graph");
    useWorkbenchStore.setState({ draftKey: null });
  });

  test("the answer says when it depends on arrows marked as not sure", () => {
    openCompare({ uncertainPairs: [{ first: "education", second: "training" }] });
    const line = screen.getByText(/depends on arrows you marked as not sure/).textContent!;
    expect(line).toContain("gives 2 answers");
    fireEvent.click(screen.getByRole("button", { name: "See them" }));
    expect(state().activeTab).toBe("compare");
  });

  test("but not when they make no difference", () => {
    openCompare({ uncertainPairs: [{ first: "education", second: "promoted" }] });
    expect(screen.queryByText(/depends on arrows you marked as not sure/)).toBeNull();
  });

  test("limits how many columns can be not sure", async () => {
    const wide = `T,Y,a,b,c,d,e\n${Array.from({ length: 8 }, (_, i) => `${i % 2},${i},${i % 3},${i % 4},${i % 5},${i % 6},${i % 7}`).join("\n")}\n`;
    render(<DraftScreen />);
    await chooseFile("w.csv", wide);
    fireEvent.change(screen.getByLabelText("Treatment"), { target: { value: "T" } });
    fireEvent.change(screen.getByLabelText("Outcome"), { target: { value: "Y" } });
    for (const name of ["a", "b", "c", "d", "e"]) {
      fireEvent.change(screen.getByLabelText(`When ${name} was fixed`), { target: { value: "unsure" } });
    }
    expect(screen.getByText(/Mark at most 4 columns/)).toBeTruthy();
    expect(screen.getByRole<HTMLButtonElement>("button", { name: "Build a first graph" }).disabled).toBe(true);
    fireEvent.change(screen.getByLabelText("When e was fixed"), { target: { value: "before" } });
    fireEvent.click(screen.getByRole("button", { name: "Build a first graph" }));
    expect(state().uncertainPairs).toHaveLength(4);
  });

  test("a project reopened keeps its graph but not the draft note, because it has been saved as a graph", () => {
    asDraft();
    state().hydrateProject(buildProjectSnapshot());
    expect(state().draftKey).toBeNull();
  });
});
