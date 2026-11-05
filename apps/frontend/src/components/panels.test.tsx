import type { AnalysisRequest, GraphSpec } from "@causal-graph-workbench/shared";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { analyze } from "../engine/analyze";
import { useWorkbenchStore, type PanelTab } from "../store/useWorkbenchStore";
import { DataStep } from "./DataStep";
import { GraphStep } from "./GraphStep";
import { ResultStep } from "./ResultStep";
import { StartScreen } from "./StartScreen";
import { StepPanel } from "./StepPanel";

function graph(edges: [string, string][], treatment = "X", outcome = "Y"): GraphSpec {
  const ids = [...new Set(edges.flat())];
  return {
    nodes: ids.map((id) => ({ id, label: id, x: 0, y: 0 })),
    edges: edges.map(([source, target]) => ({ id: `${source}->${target}`, source, target })),
    treatmentId: treatment,
    outcomeId: outcome,
  };
}

function showResult(request: AnalysisRequest, tab: PanelTab = "assumptions") {
  const analysis = analyze(request);
  useWorkbenchStore.setState({ graph: request.graph, analysis, activeTab: tab });
  render(<ResultStep analysis={analysis} graph={request.graph} />);
  return analysis;
}

function headline(): string {
  return screen.getByRole("heading", { level: 1 }).textContent ?? "";
}

function section(title: string) {
  return within(screen.getByRole("button", { name: new RegExp(title) }).closest("section")!);
}

beforeEach(() => {
  // Tell React that the test environment supports wrapped updates.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  useWorkbenchStore.setState({ activeTab: "assumptions", uploadedDataset: null, dataContext: {}, previewArrow: null, graphTextOpen: false });
});

afterEach(cleanup);

describe("the answer at the top of the result", () => {
  const butterfly: [string, string][] = [
    ["U1", "X"],
    ["U1", "M"],
    ["U2", "M"],
    ["U2", "Y"],
    ["M", "X"],
    ["M", "Y"],
    ["X", "Y"],
  ];

  test("butterfly graph names the valid set, and the required collider is explained", () => {
    showResult({ graph: graph(butterfly) }, "sets");
    expect(headline()).toBe("Adjust for M and U1");
    expect(screen.getAllByText("{M, U1}").length).toBeGreaterThan(0);
    expect(screen.getByText("Variables to use with care")).toBeTruthy();
    expect(screen.getByText("required")).toBeTruthy();
    expect(screen.getByText(/Every valid adjustment set must include M/)).toBeTruthy();
  });

  test("an empty recommendation reads as no adjustment needed", () => {
    showResult({ graph: graph([["Z", "X"], ["X", "Y"]]) }, "sets");
    expect(headline()).toBe("No adjustment needed");
    expect(screen.getByText(/no open backdoor path/)).toBeTruthy();
    expect(screen.queryByText("Variables to use with care")).toBeNull();
  });

  test("no valid set is not presented as an empty recommendation", () => {
    const spec = graph([["U", "X"], ["U", "Y"]]);
    spec.nodes = spec.nodes.map((node) => (node.id === "U" ? { ...node, observed: false } : node));
    showResult({ graph: spec });
    expect(headline()).toBe("No measured variables can remove the bias");
    expect(screen.queryByText("No adjustment needed")).toBeNull();
  });

  test("a graph that cannot be analysed says so and leads back to it", () => {
    const spec = graph([["X", "Y"]]);
    spec.treatmentId = null;
    showResult({ graph: spec });
    expect(headline()).toBe("Your graph needs attention first");
    expect(screen.queryByRole("tablist")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Back to the graph" }));
    expect(useWorkbenchStore.getState().step).toBe("graph");
  });
});

describe("details and code", () => {
  const overlapFile = (extra = "") => {
    const rows = Array.from({ length: 200 }, (_, index) => {
      const treated = index % 2;
      return `${treated},${index / 10},${(treated ? 0.8 : 0.2) + (index % 10) / 100}${extra ? `,${index}` : ""}`;
    });
    return [`X,Y,Z${extra}`, ...rows].join("\n");
  };

  test("propensity overlap and balance are shown for the recommended covariates only", () => {
    showResult(
      { graph: graph([["Z", "X"], ["Z", "Y"], ["X", "Y"]]), dataset: { filename: "s.csv", content: overlapFile(",unrelated") } },
      "details",
    );
    expect(screen.getByText("Treated propensity")).toBeTruthy();
    expect(screen.getByText("Common support")).toBeTruthy();
    const balance = section("Are the groups comparable");
    expect(balance.getByText("Z")).toBeTruthy();
    expect(balance.queryByText("unrelated")).toBeNull();
    expect(balance.queryByText("Y")).toBeNull();
  });

  test("the estimator shows the overlap caveat when the data checks flagged a problem", () => {
    const analysis = showResult({ graph: graph([["Z", "X"], ["Z", "Y"], ["X", "Y"]]), dataset: { filename: "s.csv", content: overlapFile() } }, "code");
    expect(analysis.dataDiagnostics!.overlapDiagnostics!.warnings.length).toBeGreaterThan(0);
    fireEvent.click(screen.getByRole("button", { name: /Suggested estimator/ }));
    expect(screen.getByText(/overlap check flagged problems/)).toBeTruthy();
    expect(screen.getByText("Treatment type")).toBeTruthy();
  });

  test("paths can be filtered, and hovering one highlights it on the graph", () => {
    const analysis = showResult({ graph: graph([["Z", "X"], ["Z", "Y"], ["X", "Y"]]) }, "details");
    const backdoor = analysis.paths.find((path) => path.category === "backdoor")!;
    const causal = analysis.paths.find((path) => path.category === "directed_causal")!;
    fireEvent.click(screen.getByRole("button", { name: "Causal" }));
    expect(screen.queryByText(backdoor.pathString)).toBeNull();
    fireEvent.mouseEnter(screen.getByText(causal.pathString).closest("button")!);
    expect(useWorkbenchStore.getState().highlightedPathId).toBe(causal.id);
    fireEvent.click(screen.getByText(causal.pathString).closest("button")!);
    expect(useWorkbenchStore.getState().selectedExplainable).toEqual({ kind: "path", id: causal.id });
  });
});

/** Numbers that are easy to reason about: Z and W both drive X and Y, and the graph leaves out W -> X. */
function knownFile(rows = 800): string {
  let state = 11;
  const random = () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 4294967296;
  };
  const normal = () => Math.sqrt(-2 * Math.log(random() || 1e-12)) * Math.cos(2 * Math.PI * random());
  const lines = ["X,Y,Z,W,M"];
  for (let row = 0; row < rows; row += 1) {
    const z = normal();
    const w = normal();
    const x = random() < 1 / (1 + Math.exp(-(0.8 * z + 1.2 * w))) ? 1 : 0;
    const m = x + normal();
    lines.push([x, (m + 0.7 * z + 1.1 * w + normal()).toFixed(4), z.toFixed(4), w.toFixed(4), m.toFixed(4)].join(","));
  }
  return lines.join("\n");
}

const drawnEdges: [string, string][] = [
  ["Z", "X"],
  ["Z", "Y"],
  ["W", "Y"],
  ["X", "M"],
  ["M", "Y"],
  ["X", "Y"],
];

describe("what the result rests on", () => {
  test("names the arrow, what it would change, and what the data says", () => {
    showResult({ graph: graph(drawnEdges), dataset: { filename: "k.csv", content: knownFile() } });
    expect(screen.getAllByText("W → X").length).toBeGreaterThan(0);
    expect(screen.getByText("Data disagrees")).toBeTruthy();
    expect(screen.getByText(/To stay valid you would need to also adjust for W/)).toBeTruthy();
    expect(screen.getAllByText(/The estimate would go from/).length).toBeGreaterThan(0);
  });

  test("always says what the checks cannot see, and never claims the graph passed", () => {
    showResult({ graph: graph(drawnEdges), dataset: { filename: "k.csv", content: knownFile() } });
    expect(screen.getByText(/What these checks cannot see/)).toBeTruthy();
    const text = (document.body.textContent ?? "").toLowerCase();
    expect(text).not.toMatch(/\b(passed|confirmed|verified|validated)\b/);
  });

  test("hovering previews the arrow without changing the graph, and only the button changes it", () => {
    const spec = graph(drawnEdges);
    showResult({ graph: spec, dataset: { filename: "k.csv", content: knownFile() } });
    const card = screen.getAllByText("W → X")[0].closest("article")!;

    fireEvent.mouseEnter(card);
    expect(useWorkbenchStore.getState().previewArrow).toEqual({ edit: "add", source: "W", target: "X" });
    expect(useWorkbenchStore.getState().graph.edges).toHaveLength(spec.edges.length);
    fireEvent.mouseLeave(card);
    expect(useWorkbenchStore.getState().previewArrow).toBeNull();

    fireEvent.click(within(card).getByRole("button", { name: "Add this arrow" }));
    expect(useWorkbenchStore.getState().graph.edges.map((edge) => edge.id)).toContain("W->X");
  });

  test("without data it lists the assumptions and says data would add to them", () => {
    showResult({ graph: graph(drawnEdges) });
    expect(screen.getByText("Your set depends on these")).toBeTruthy();
    expect(screen.queryByText(/The estimate would go from/)).toBeNull();
  });

  test("a graph with no valid set explains why there is nothing to check", () => {
    const spec = graph([["U", "X"], ["U", "Y"], ["X", "Y"]]);
    spec.nodes = spec.nodes.map((node) => (node.id === "U" ? { ...node, observed: false } : node));
    showResult({ graph: spec });
    expect(screen.getByText(/No valid adjustment set exists/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "See which paths stay open" }));
    expect(useWorkbenchStore.getState().activeTab).toBe("details");
  });
});

describe("the estimate", () => {
  const withData = () => ({ graph: graph(drawnEdges), dataset: { filename: "k.csv", content: knownFile() } });
  const scriptPicker = () => screen.getByLabelText<HTMLSelectElement>("Choose a script");
  const pickedScript = () => scriptPicker().selectedOptions[0].textContent;

  test("shows the number, and the same data under other choices", () => {
    showResult(withData(), "sets");
    expect(document.querySelector(".effect__figure strong")!.textContent).toMatch(/^\d/);
    expect(screen.getByText("No adjustment")).toBeTruthy();
    expect(screen.getByText("Everything measured")).toBeTruthy();
    expect(screen.getByText(/M is downstream of treatment/)).toBeTruthy();
  });

  test("the write-up starts on the script for the whole analysis, and keeps what the user picks", () => {
    showResult(withData(), "code");
    expect(pickedScript()).toBe("Everything on this page (Python)");
    expect(document.querySelector(".code-block")!.textContent).toContain("Against what the app showed");

    const other = [...scriptPicker().options].find((option) => option.textContent?.startsWith("R / lm-glm"))!;
    fireEvent.change(scriptPicker(), { target: { value: other.value } });
    expect(pickedScript()).toMatch(/^R \/ lm-glm/);

    fireEvent.click(screen.getByRole("button", { name: "Reproduce it with Python / AIPW" }));
    expect(pickedScript()).toMatch(/^Python \/ AIPW/);
  });

  test("the reproduce link opens the code from any tab", () => {
    showResult(withData());
    fireEvent.click(screen.getByRole("button", { name: "Reproduce it with Python / AIPW" }));
    expect(useWorkbenchStore.getState().activeTab).toBe("code");
  });

  test("choosing the ATT is stored, for a binary treatment", () => {
    showResult(withData());
    fireEvent.click(screen.getByRole("button", { name: "Those treated (ATT)" }));
    expect(useWorkbenchStore.getState().dataContext.estimand).toBe("att");
  });

  test("testing a set records exactly the variables ticked", () => {
    showResult(withData(), "sets");
    fireEvent.click(screen.getByRole("button", { name: /Test the set you used/ }));
    fireEvent.click(screen.getByLabelText("W"));
    fireEvent.click(screen.getByLabelText("M"));
    fireEvent.click(screen.getByRole("button", { name: "Test this set" }));
    expect(useWorkbenchStore.getState().dataContext.chosenSet).toEqual(["W", "M"]);
  });

  test("a chosen valid set takes over the answer, which says so and offers the way back", () => {
    const request = withData();
    const chosen = { chosenSet: ["W", "Z"] };
    const analysis = analyze({ ...request, dataContext: chosen });
    expect(analysis.recommendedAdjustmentSet).toEqual(["Z"]);
    useWorkbenchStore.setState({ graph: request.graph, analysis, dataContext: chosen });
    render(<ResultStep analysis={analysis} graph={request.graph} />);

    expect(headline()).toBe("Adjust for W and Z");
    expect(screen.getByText(/This is the set you chose/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Use the recommended one" }));
    expect(useWorkbenchStore.getState().dataContext.chosenSet).toBeNull();
  });

  test("the recommended set does not announce itself as a choice", () => {
    showResult(withData());
    expect(headline()).toBe("Adjust for Z");
    expect(screen.queryByText(/This is the set you chose/)).toBeNull();
  });

  test("without data it says how to get an estimate, and leads to the data step", () => {
    showResult({ graph: graph(drawnEdges) });
    expect(screen.getByText(/to estimate the effect/)).toBeTruthy();
    fireEvent.click(screen.getAllByRole("button", { name: "Add your data" })[0]);
    expect(useWorkbenchStore.getState().step).toBe("data");
  });
});

describe("something unmeasured", () => {
  const withData = () => ({ graph: graph(drawnEdges), dataset: { filename: "k.csv", content: knownFile() } });

  test("says how strong it would have to be, and how that compares with what was measured", () => {
    const analysis = showResult(withData());
    const { robustness } = analysis.sensitivity!;
    expect(screen.getByText(new RegExp(`it would have to explain ${(robustness!.value * 100).toFixed(1)}%`))).toBeTruthy();
    expect(screen.getByText(new RegExp(`Something as strong as ${robustness!.benchmarks[0].variable}`))).toBeTruthy();
    expect(screen.getByRole("img", { name: /how strong something unmeasured would have to be/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: /E-value/ })).toBeTruthy();
  });

  test("a measured variable on the chart can be read by keyboard and pointer alike", () => {
    const analysis = showResult(withData());
    const strongest = analysis.sensitivity!.robustness!.benchmarks[0].variable;
    const mark = screen.getByRole("button", { name: new RegExp(`^${strongest}: about`) });
    fireEvent.focus(mark);
    expect(document.querySelector(".chart__tooltip")!.textContent).toContain(strongest);
    fireEvent.blur(mark);
    expect(document.querySelector(".chart__tooltip")).toBeNull();
  });

  test("it is a guide, so the page says about rather than at most", () => {
    showResult(withData());
    const text = (document.body.textContent ?? "").toLowerCase();
    expect(text).toContain("could account for about");
    expect(text).not.toMatch(/at most|guarantee|cannot explain/);
  });

  test("without data it says data would show how strong, and still says what cannot be seen", () => {
    showResult({ graph: graph(drawnEdges) });
    expect(screen.getByText(/What these checks cannot see/)).toBeTruthy();
    expect(screen.getByText(/to see how strong it would have to be/)).toBeTruthy();
    expect(screen.queryByRole("img", { name: /how strong/ })).toBeNull();
  });
});

describe("one task at a time", () => {
  test("each step shows only its own question", () => {
    const spec = graph([["Z", "X"], ["X", "Y"]]);
    const analysis = analyze({ graph: spec });
    useWorkbenchStore.setState({ graph: spec, analysis, step: "graph" });
    const { rerender } = render(<StepPanel analysis={analysis} graph={spec} />);
    expect(headline()).toBe("Draw your graph");
    expect(screen.queryByRole("tablist")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Next: add your data" }));
    rerender(<StepPanel analysis={analysis} graph={spec} />);
    expect(headline()).toBe("Add your data");

    fireEvent.click(screen.getByRole("button", { name: "See the result" }));
    rerender(<StepPanel analysis={analysis} graph={spec} />);
    expect(headline()).toBe("No adjustment needed");
    expect(screen.getByRole("tablist")).toBeTruthy();
  });

  test("the start screen leads to a blank graph, or to the text form when asked", () => {
    useWorkbenchStore.setState({ graph: graph([["X", "Y"]]), view: "start" });
    render(<StartScreen />);
    fireEvent.click(screen.getByRole("button", { name: /Type a graph as text/ }));
    const state = useWorkbenchStore.getState();
    expect(state.view).toBe("workspace");
    expect(state.step).toBe("graph");
    expect(state.graphTextOpen).toBe(true);
    expect(state.graph.nodes).toHaveLength(0);
  });

  test("the start screen offers the way back once there is a graph to return to", () => {
    useWorkbenchStore.setState({ view: "workspace", canResume: false });
    useWorkbenchStore.getState().setView("start");
    render(<StartScreen />);
    fireEvent.click(screen.getByRole("button", { name: /Back to my graph/ }));
    expect(useWorkbenchStore.getState().view).toBe("workspace");
  });
});

describe("the graph step", () => {
  beforeEach(() => {
    useWorkbenchStore.setState({ graph: graph([["Z", "X"], ["X", "Y"]]), analysis: null, uploadedDataset: null, dataContext: {} });
  });

  test("timing and measured can be set for covariates, but not for treatment or outcome", () => {
    render(<GraphStep analysis={null} />);
    expect(screen.queryByLabelText("When Z is fixed")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "About X" }));
    expect(screen.queryByLabelText("When X is fixed")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "About Z" }));
    fireEvent.change(screen.getByLabelText("When Z is fixed"), { target: { value: "baseline" } });
    expect(useWorkbenchStore.getState().graph.nodes.find((node) => node.id === "Z")!.timing).toBe("baseline");
    fireEvent.click(screen.getByLabelText("Measured"));
    expect(useWorkbenchStore.getState().graph.nodes.find((node) => node.id === "Z")!.observed).toBe(false);
  });

  test("selecting a variable on the graph opens its settings, which stay open while they are changed", () => {
    render(<GraphStep analysis={null} />);
    act(() => useWorkbenchStore.getState().setSelectedExplainable({ kind: "node", id: "Z" }));
    fireEvent.click(screen.getByLabelText("Measured"));
    expect(screen.getByLabelText("When Z is fixed")).toBeTruthy();
  });

  test("the effect question waits for two variables, and nothing reads as an error while drawing", () => {
    const empty = { nodes: [], edges: [], treatmentId: null, outcomeId: null };
    useWorkbenchStore.setState({ graph: empty });
    const { rerender } = render(<GraphStep analysis={analyze({ graph: empty })} />);
    expect(screen.queryByText("Which effect do you want to know?")).toBeNull();

    const unfinished = { ...graph([["A", "B"]]), edges: [], treatmentId: null, outcomeId: null };
    useWorkbenchStore.setState({ graph: unfinished });
    rerender(<GraphStep analysis={analyze({ graph: unfinished })} />);
    expect(screen.getByText("Which effect do you want to know?")).toBeTruthy();
    expect(document.querySelector(".notice")).toBeNull();
  });

  test("new variables do not land on top of each other", () => {
    useWorkbenchStore.setState({ graph: { nodes: [], edges: [], treatmentId: null, outcomeId: null } });
    for (const name of ["a", "b", "c", "d"]) {
      useWorkbenchStore.getState().addNode(name);
    }
    const { nodes } = useWorkbenchStore.getState().graph;
    expect(new Set(nodes.map((node) => `${node.x},${node.y}`)).size).toBe(4);
    nodes.forEach((node, index) =>
      nodes.slice(index + 1).forEach((other) => {
        expect(Math.abs(node.x - other.x) >= 160 || Math.abs(node.y - other.y) >= 80).toBe(true);
      }),
    );
  });

  test("variables and arrows can be added from the panel", () => {
    render(<GraphStep analysis={null} />);
    fireEvent.change(screen.getByLabelText("New variable name"), { target: { value: "W" } });
    fireEvent.click(screen.getByRole("button", { name: "Add" }));
    expect(useWorkbenchStore.getState().graph.nodes.map((node) => node.id)).toContain("W");

    fireEvent.click(screen.getByRole("button", { name: /Arrows/ }));
    fireEvent.change(screen.getByLabelText("Arrow from"), { target: { value: "W" } });
    fireEvent.change(screen.getByLabelText("Arrow to"), { target: { value: "Y" } });
    fireEvent.click(screen.getByRole("button", { name: "Add arrow" }));
    expect(useWorkbenchStore.getState().graph.edges.map((edge) => edge.id)).toContain("W->Y");
  });

  test("a graph can be edited as text", () => {
    render(<GraphStep analysis={null} />);
    fireEvent.click(screen.getByRole("button", { name: /Edit as text/ }));
    fireEvent.change(screen.getByLabelText("Graph as text"), { target: { value: "A -> B" } });
    fireEvent.click(screen.getByRole("button", { name: "Apply to graph" }));
    expect(useWorkbenchStore.getState().graph.edges.map((edge) => edge.id)).toEqual(["A->B"]);
  });
});

describe("the data step", () => {
  test("columns can be matched by hand, and unused ones added as variables", () => {
    const dataset = { filename: "s.csv", content: "treatment,Y,Z,extra\n1,2,3,4\n0,1,2,3\n" };
    const spec = graph([["Z", "X"], ["X", "Y"]]);
    const analysis = analyze({ graph: spec, dataset });
    useWorkbenchStore.setState({ graph: spec, uploadedDataset: dataset, analysis });
    render(<DataStep analysis={analysis} />);

    fireEvent.change(screen.getByLabelText("X"), { target: { value: "treatment" } });
    expect(useWorkbenchStore.getState().dataContext.columnBindings).toEqual({ X: "treatment" });

    fireEvent.click(screen.getByRole("button", { name: /Add 2 columns as variables/ }));
    const ids = useWorkbenchStore.getState().graph.nodes.map((node) => node.id);
    expect(ids).toEqual(expect.arrayContaining(["treatment", "extra"]));
  });

  test("the input is cleared after a file is read, so choosing the same file again still fires a change", async () => {
    render(<DataStep analysis={null} />);
    const input = document.querySelector<HTMLInputElement>('input[type="file"]')!;
    let cleared = false;
    Object.defineProperty(input, "value", {
      configurable: true,
      get: () => "",
      set: () => {
        cleared = true;
      },
    });

    const file = { name: "study.csv", text: async () => "X,Y\n1,2\n" };
    Object.defineProperty(input, "files", { configurable: true, value: [file] });
    await act(async () => {
      fireEvent.change(input);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(useWorkbenchStore.getState().uploadedDataset).toEqual({ filename: "study.csv", content: "X,Y\n1,2\n" });
    expect(cleared).toBe(true);
  });
});
