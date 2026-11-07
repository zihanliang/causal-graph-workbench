import type { AnalysisRequest, GraphSpec, GraphVersion } from "@causal-graph-workbench/shared";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { analyze } from "../engine/analyze";
import { exampleProjects } from "../lib/exampleProjects";
import { applyChange, firstVersion, MAX_GRAPH_VERSIONS } from "../lib/graphVersions";
import { TOUR_STOPS } from "../lib/tour";
import { selectPreviewArrow, selectStepFocus, useWorkbenchStore, type PanelTab } from "../store/useWorkbenchStore";
import { ResultStep } from "./ResultStep";
import { StepPanel } from "./StepPanel";

const example = exampleProjects.find((item) => item.id === "training-program")!;
const content = readFileSync(resolve(__dirname, "../../public/demo-data/training-program-study.csv"), "utf-8");
const dataset = { filename: "training-program-study.csv", content };
const withFile: AnalysisRequest = { graph: example.graph, dataContext: example.dataContext, dataset };
const missingArrow = { edit: "add", source: "education", target: "training" } as const;

function open(request: AnalysisRequest, tab: PanelTab = "steps") {
  const analysis = analyze(request);
  useWorkbenchStore.setState({
    graph: request.graph,
    ...(request.versions ? { versions: request.versions, activeVersionId: request.activeVersionId ?? request.versions[0].id } : firstVersion(request.graph)),
    dataContext: request.dataContext ?? {},
    uploadedDataset: request.dataset ?? null,
    analysis,
    activeTab: tab,
    step: "result",
  });
  return { analysis, ...render(<ResultStep analysis={analysis} graph={request.graph} />) };
}

const stepToggle = (title: string) =>
  [...document.querySelectorAll<HTMLButtonElement>(".work-step__toggle")].find((button) => button.querySelector("strong")!.textContent === title)!;
const step = (title: string) => stepToggle(title).textContent ?? "";

beforeEach(() => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  useWorkbenchStore.setState({ openStep: null, hoveredStep: null, tourStop: null, previewArrow: null, selectedExplainable: null, dataContext: {} });
});

afterEach(cleanup);

describe("how it was worked out", () => {
  test("opens on the steps, each saying its result in a line, in this example's real numbers", () => {
    open(withFile);
    expect(screen.getByRole("tab", { name: "How it was worked out" }).getAttribute("aria-selected")).toBe("true");
    expect(step("The question")).toContain("Effect of training on earnings_after. 7 variables, 13 arrows.");
    expect(step("Paths")).toContain("14 paths. 2 carry the effect, and 6 backdoor paths are open before adjusting.");
    expect(step("What to adjust for")).toContain("age and prior_earnings close all 6. Leave out promoted and skills_after.");
    expect(step("The data")).toContain("2,000 of 2,000 rows. 928 treated, 1,072 control. age differs most between the groups (0.339 SD).");
    expect(step("The estimate")).toContain("If everyone took training, 25.64. If no one did, 21.01. The difference is 4.630. With no adjustment it was 4.876.");
    expect(step("The check")).toContain("1 of 24 one-arrow errors would matter. The data contradicts 1 of 8 implied independences.");
  });

  test("the four questions are the tabs, and nothing was left behind in the old ones", () => {
    open(withFile);
    expect(screen.getAllByRole("tab").map((tab) => tab.textContent)).toEqual(["How it was worked out", "How sure can you be1", "Compare graphs", "Write-up"]);
  });

  test("one step opens at a time, and each holds the detail that used to be scattered", () => {
    open(withFile);
    fireEvent.click(stepToggle("Paths"));
    expect(screen.getByRole("button", { name: "Backdoor" })).toBeTruthy();
    fireEvent.click(stepToggle("What to adjust for"));
    expect(screen.queryByRole("button", { name: "Backdoor" })).toBeNull();
    expect(screen.getByRole("button", { name: /Smallest valid sets/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: /Test the set you used/ })).toBeTruthy();
    fireEvent.click(stepToggle("The data"));
    expect(screen.getByRole("button", { name: /Are the groups comparable/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: /Do the groups overlap/ })).toBeTruthy();
    fireEvent.click(stepToggle("The estimate"));
    expect(screen.getByRole("button", { name: /Suggested estimator/ })).toBeTruthy();
    expect(screen.getByText("The same data, adjusted differently")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /Suggested estimator/ }));
    expect(screen.getByRole("button", { name: "Why this one" })).toBeTruthy();
  });

  test("the last step leads to what the result rests on", () => {
    open(withFile);
    fireEvent.click(stepToggle("The check"));
    expect(useWorkbenchStore.getState().activeTab).toBe("assumptions");
  });

  test("the graph follows the step that is open, or under the pointer", () => {
    open(withFile);
    const focus = () => selectStepFocus(useWorkbenchStore.getState());
    expect(focus()).toBeNull();
    fireEvent.click(stepToggle("Paths"));
    expect(focus()).toBe("paths");
    fireEvent.mouseEnter(stepToggle("What to adjust for").closest("li")!);
    expect(focus()).toBe("set");
    fireEvent.mouseLeave(stepToggle("What to adjust for").closest("li")!);
    expect(focus()).toBe("paths");
    act(() => useWorkbenchStore.getState().setActiveTab("code"));
    expect(focus()).toBeNull();
  });

  test("without data each step says so, and leads to adding it", () => {
    open({ graph: example.graph });
    expect(step("The data")).toContain("No file yet, so nothing has been estimated.");
    expect(step("The estimate")).toContain("Add your data to estimate the effect.");
    expect(step("The check")).toContain("1 of 24 one-arrow errors would matter.");
    expect(step("The check")).not.toContain("independence");
    fireEvent.click(stepToggle("The data"));
    fireEvent.click(within(stepToggle("The data").closest("li")!).getByRole("button", { name: "Add your data" }));
    expect(useWorkbenchStore.getState().step).toBe("data");
  });

  test("with no valid set the steps say why there is nothing further", () => {
    const spec = applyChange(example.graph, { edit: "unmeasured", source: "training", target: "earnings_after" });
    open({ graph: spec, dataset });
    expect(step("What to adjust for")).toContain("No measured variables close every backdoor path.");
    expect(step("The estimate")).toContain("Not estimated, because no valid set exists.");
    expect(step("The check")).toContain("There is no result to check yet.");
  });

  test("a graph with nothing to adjust for says so plainly", () => {
    const simple: GraphSpec = {
      nodes: ["X", "Y"].map((id) => ({ id, label: id, x: 0, y: 0 })),
      edges: [{ id: "X->Y", source: "X", target: "Y" }],
      treatmentId: "X",
      outcomeId: "Y",
    };
    open({ graph: simple });
    expect(step("Paths")).toContain("1 path. 1 carries the effect, and no backdoor path is open before adjusting.");
    expect(step("What to adjust for")).toContain("Nothing to adjust for, because no backdoor path is open.");
  });

  test("the effect among the treated is described as that", () => {
    open({ ...withFile, dataContext: { ...example.dataContext, estimand: "att" } });
    expect(step("The estimate")).toMatch(/Among those who took training, [\d.]+\. Had they not, [\d.]+\. The difference is [\d.]+\./);
  });

  test("a numeric treatment has no potential outcomes to quote", () => {
    const file = ["X,Y,Z", ...Array.from({ length: 80 }, (_, index) => `${index % 9},${(index % 9) * 2 + (index % 7)},${index % 5}`)].join("\n");
    const spec: GraphSpec = {
      nodes: ["X", "Y", "Z"].map((id) => ({ id, label: id, x: 0, y: 0 })),
      edges: [
        { id: "Z->X", source: "Z", target: "X" },
        { id: "Z->Y", source: "Z", target: "Y" },
        { id: "X->Y", source: "X", target: "Y" },
      ],
      treatmentId: "X",
      outcomeId: "Y",
    };
    open({ graph: spec, dataset: { content: file } });
    expect(step("The estimate")).toMatch(/Change in outcome per one-unit increase/);
    expect(step("The data")).not.toContain("treated,");
  });
});

describe("just after an edit, before the new analysis arrives", () => {
  test("a question with no outcome is not described from the analysis of the graph before it", () => {
    const analysis = analyze(withFile);
    useWorkbenchStore.setState({ ...firstVersion(example.graph), analysis, activeTab: "code", step: "result" });
    const edited = { ...example.graph, outcomeId: null };
    render(<ResultStep analysis={analysis} graph={edited} />);
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("Your result");
    expect(screen.queryByRole("tablist")).toBeNull();
    expect(document.body.textContent).not.toMatch(/\bnull\b/);
  });
});

describe("the write-up", () => {
  test("no longer holds the estimator, which is part of how the answer was reached", () => {
    open(withFile, "code");
    expect(screen.queryByRole("button", { name: /Suggested estimator/ })).toBeNull();
    expect(screen.getByText("Methods text")).toBeTruthy();
  });

  test("says the script covers one graph when there are several", () => {
    const versions: GraphVersion[] = [
      { id: "a", name: "Graph A", graph: example.graph },
      { id: "b", name: "Graph B", graph: applyChange(example.graph, missingArrow) },
    ];
    open({ ...withFile, versions, activeVersionId: "a" }, "code");
    expect(screen.getByLabelText<HTMLSelectElement>("Choose a script").selectedOptions[0].textContent).toBe("Everything for this graph (Python)");
    expect(screen.getByText(/Show another graph to get its script/)).toBeTruthy();
  });
});

describe("comparing graphs", () => {
  const second = applyChange(example.graph, missingArrow);
  const third = applyChange(second, { edit: "reverse", source: "prior_earnings", target: "training" });
  const unmeasured = applyChange(example.graph, { edit: "unmeasured", source: "training", target: "earnings_after" });
  const versions: GraphVersion[] = [
    { id: "a", name: "Graph A", graph: example.graph },
    { id: "b", name: "Graph B", graph: second },
    { id: "c", name: "Graph C", graph: third },
    { id: "d", name: "Graph D", graph: unmeasured },
  ];
  const openCompare = (active = "a") => open({ ...withFile, graph: versions.find((item) => item.id === active)!.graph, versions, activeVersionId: active }, "compare");
  const rowOf = (name: string) => within(screen.getByText(name).closest("article")!);

  test("leads with what can be done without choosing", () => {
    openCompare();
    expect(screen.getByText("One set is valid under 2 of your 4 graphs (A and B)")).toBeTruthy();
    expect(screen.getByText(/\{age, education, prior_earnings\} gives 2\.882/)).toBeTruthy();
    expect(screen.getByText(/It is not valid under C and D/)).toBeTruthy();
  });

  test("groups graphs by the answer each one gives, and never names a best one", () => {
    openCompare();
    const answers = [...document.querySelectorAll(".answer")].map((section) => section.querySelector("strong")!.textContent);
    expect(answers[0]).toMatch(/^4\.630/);
    expect(answers[1]).toMatch(/^2\.882/);
    expect(answers[2]).toMatch(/^2\.032/);
    expect(answers[3]).toBe("No estimate");
    expect((document.body.textContent ?? "").toLowerCase()).not.toMatch(/\b(best|most likely|passed|confirmed|verified|validated|correct graph)\b/);
  });

  test("each graph says how it differs, and what the data says about it", () => {
    openCompare();
    expect(rowOf("Graph A").getByText("The first graph")).toBeTruthy();
    expect(rowOf("Graph A").getByText("1 of 8 contradicted")).toBeTruthy();
    expect(rowOf("Graph A").getByText(/education and training are still related given age, prior_earnings/)).toBeTruthy();
    expect(rowOf("Graph B").getByText("+ education → training")).toBeTruthy();
    expect(rowOf("Graph B").getByText("0 of 7 contradicted")).toBeTruthy();
  });

  test("says which graphs the data cannot separate, and that their answers differ", () => {
    openCompare();
    expect(screen.getByText("B and C")).toBeTruthy();
    const line = screen.getByText("B and C").closest("p")!.textContent;
    expect(line).toMatch(/imply the same independences/);
    expect(line).toMatch(/only what you know about the study can decide/);
  });

  test("always says what the data cannot do", () => {
    openCompare();
    expect(screen.getByText(/The data can rule a graph out, but it cannot show that one is right/)).toBeTruthy();
    expect(screen.getByText(/These graphs are not ranked|That is why these graphs are not ranked/)).toBeTruthy();
  });

  test("any graph can be opened or removed from its row", () => {
    openCompare();
    expect(rowOf("Graph A").getByText("Showing")).toBeTruthy();
    fireEvent.click(rowOf("Graph B").getByRole("button", { name: "Show Graph B" }));
    expect(useWorkbenchStore.getState().activeVersionId).toBe("b");
    expect(useWorkbenchStore.getState().graph.edges.map((edge) => edge.id)).toContain("education->training");
    fireEvent.click(rowOf("Graph D").getByRole("button", { name: "Remove Graph D" }));
    expect(useWorkbenchStore.getState().versions.map((version) => version.id)).toEqual(["a", "b", "c"]);
  });

  test("the shared set can be taken up when it is valid for the graph on show", () => {
    openCompare();
    fireEvent.click(screen.getByRole("button", { name: "Use this set" }));
    expect(useWorkbenchStore.getState().dataContext.chosenSet).toEqual(["age", "education", "prior_earnings"]);
  });

  test("it is not offered for a graph it is not valid under", () => {
    openCompare("c");
    expect(screen.queryByRole("button", { name: "Use this set" })).toBeNull();
  });

  test("the answer at the top says which graph it is about", () => {
    openCompare("b");
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("Adjust for age, education and prior_earnings");
    expect(screen.getByText(/Showing Graph B\. Your 4 graphs give 4 answers\./)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Compare them" }));
    expect(useWorkbenchStore.getState().activeTab).toBe("compare");
  });

  test("graphs that agree say so, rather than showing a shared set", () => {
    const agreeing: GraphVersion[] = [
      { id: "a", name: "Graph A", graph: second },
      { id: "b", name: "Graph B", graph: applyChange(second, { edit: "add", source: "education", target: "promoted" }) },
    ];
    open({ ...withFile, graph: second, versions: agreeing, activeVersionId: "a" }, "compare");
    expect(screen.getByText("All 2 graphs give the same answer")).toBeTruthy();
    expect(screen.queryByText(/One set is valid/)).toBeNull();
  });

  test("a graph that cannot be analysed is shown apart, with the reason", () => {
    const withCycle: GraphVersion[] = [
      { id: "a", name: "Graph A", graph: example.graph },
      { id: "b", name: "Graph B", graph: applyChange(example.graph, { edit: "add", source: "training", target: "education" }) },
    ];
    open({ ...withFile, versions: withCycle, activeVersionId: "a" }, "compare");
    expect(screen.getByText("Cannot be analysed yet")).toBeTruthy();
    expect(screen.getByText(/directed cycle/)).toBeTruthy();
  });

  test("while a new graph is being worked out it does not show the old comparison as if complete", () => {
    openCompare();
    act(() => {
      useWorkbenchStore.getState().addVersion({ edit: "add", source: "age", target: "education" });
    });
    cleanup();
    const { analysis } = useWorkbenchStore.getState();
    render(<ResultStep analysis={analysis} graph={example.graph} />);
    expect(screen.getByText("Comparing your graphs…")).toBeTruthy();
  });

  test("at the limit it says so, in place of offering another", () => {
    const many: GraphVersion[] = Array.from({ length: MAX_GRAPH_VERSIONS }, (_, index) => ({ id: `g${index}`, name: `Graph ${"ABCDEF"[index]}`, graph: example.graph }));
    open({ ...withFile, versions: many, activeVersionId: "g0" }, "compare");
    expect(screen.queryByRole("button", { name: "Try another graph" })).toBeNull();
    expect(screen.getByText(/You can compare up to 6 graphs/)).toBeTruthy();
  });
});

describe("before there is a second graph", () => {
  test("says what comparing is for, and offers the conflict the data found as a place to start", () => {
    open(withFile, "compare");
    expect(screen.getByText("Not sure your graph is right?")).toBeTruthy();
    expect(screen.getByText("education → training")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Compare with this arrow" }));
    const state = useWorkbenchStore.getState();
    expect(state.versions).toHaveLength(2);
    expect(state.versions[1].graph.edges.map((edge) => edge.id)).toContain("education->training");
    expect(state.activeVersionId).toBe("graph-a");
  });

  test("offers a blank start without data", () => {
    open({ graph: example.graph }, "compare");
    expect(screen.queryByText("Where the data disagrees with this graph")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Try another graph" }));
    const state = useWorkbenchStore.getState();
    expect(state.versions).toHaveLength(2);
    expect(state.activeVersionId).toBe("graph-b");
    expect(state.step).toBe("graph");
  });
});

describe("the walkthrough of the worked example", () => {
  function startTour() {
    const analysis = analyze(withFile);
    useWorkbenchStore.getState().hydrateProject({ version: "0.3.0", savedAt: "", graph: example.graph, dataContext: example.dataContext, uploadedDataset: dataset });
    useWorkbenchStore.setState({ analysis });
    useWorkbenchStore.getState().goToTourStop(0);
    const graph = useWorkbenchStore.getState().graph;
    return render(<StepPanel analysis={analysis} graph={graph} />);
  }
  const state = () => useWorkbenchStore.getState();
  const next = () => fireEvent.click(screen.getByRole("button", { name: "Next" }));

  test("starts at the question, rather than on the finished result", () => {
    startTour();
    expect(state().step).toBe("graph");
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("Draw your graph");
    expect(screen.getByText("Start with the question")).toBeTruthy();
    expect(screen.getByText(`1 of ${TOUR_STOPS.length}`)).toBeTruthy();
  });

  test("replaces the step's own buttons, so that there is one way forward", () => {
    startTour();
    expect(screen.queryByRole("button", { name: "Next: add your data" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Skip to the result" })).toBeNull();
  });

  test("walks through each step in order, and adds the second graph once", () => {
    startTour();
    next();
    expect(state().step).toBe("graph");
    next();
    expect(state().step).toBe("data");
    next();
    expect(state().step).toBe("result");
    expect(state().activeTab).toBe("steps");
    next();
    expect(state().activeTab).toBe("assumptions");
    expect(selectPreviewArrow(state())).toEqual(missingArrow);
    expect(state().graph.edges.map((edge) => edge.id)).not.toContain("education->training");
    next();
    expect(state().activeTab).toBe("compare");
    expect(state().versions).toHaveLength(2);
    expect(state().activeVersionId).toBe("graph-a");

    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    expect(state().activeTab).toBe("assumptions");
    next();
    expect(state().versions).toHaveLength(2);

    fireEvent.click(screen.getByRole("button", { name: "Finish" }));
    expect(state().tourStop).toBeNull();
    expect(state().step).toBe("result");
    expect(selectPreviewArrow(state())).toBeNull();
  });

  test("can be left at any point, and leaves the example open", () => {
    startTour();
    next();
    fireEvent.click(screen.getByRole("button", { name: "Skip the walkthrough" }));
    expect(state().tourStop).toBeNull();
    expect(state().graph.nodes).toHaveLength(example.graph.nodes.length);
    expect(screen.getByRole("button", { name: "Next: add your data" })).toBeTruthy();
  });

  test("stops once the example is changed, because it quotes this example's figures", () => {
    startTour();
    act(() => useWorkbenchStore.getState().connectNodes("age", "education"));
    expect(state().tourStop).toBeNull();
  });

  test("keeps going when a variable is only moved", () => {
    startTour();
    act(() => useWorkbenchStore.getState().updateNodePosition("age", 11, 22));
    expect(state().tourStop).toBe(0);
  });
});
