import { beforeEach, describe, expect, test } from "vitest";

import { parseProjectSnapshotText } from "../lib/export";
import { buildProjectSnapshot, useWorkbenchStore } from "./useWorkbenchStore";

describe("workbench store", () => {
  beforeEach(() => {
    useWorkbenchStore.setState({
      graph: {
        nodes: [
          { id: "Z", label: "Z", x: 0, y: 0 },
          { id: "X", label: "X", x: 100, y: 0 },
          { id: "Y", label: "Y", x: 200, y: 0 },
        ],
        edges: [
          { id: "Z->X", source: "Z", target: "X" },
          { id: "Z->Y", source: "Z", target: "Y" },
        ],
        treatmentId: "X",
        outcomeId: "Y",
      },
      textDraft: "Z -> X\nZ -> Y",
      parseError: null,
      uploadedDataset: null,
      selectedExplainable: null,
      highlightedPathId: null,
      previewArrow: null,
      dataContext: {},
    });
  });

  test("removing a node clears treatment and outcome selection when needed", () => {
    useWorkbenchStore.getState().removeNode("X");
    expect(useWorkbenchStore.getState().graph.treatmentId).toBeNull();

    useWorkbenchStore.getState().removeNode("Y");
    expect(useWorkbenchStore.getState().graph.outcomeId).toBeNull();
  });

  test("importFromText updates the single graph source of truth", () => {
    useWorkbenchStore.setState({ textDraft: "U -> X\nU -> Y\nX -> Y" });
    useWorkbenchStore.getState().importFromText();

    const state = useWorkbenchStore.getState();
    expect(state.graph.nodes.map((node) => node.id).sort()).toEqual(["U", "X", "Y"]);
    expect(state.graph.edges.map((edge) => edge.id).sort()).toEqual(["U->X", "U->Y", "X->Y"]);
    expect(state.parseError).toBeNull();
  });

  test("setTextDraft reports parser errors immediately without mutating the graph", () => {
    const previousNodeIds = useWorkbenchStore.getState().graph.nodes.map((node) => node.id);
    useWorkbenchStore.getState().setTextDraft("X - Y");

    const state = useWorkbenchStore.getState();
    expect(state.parseError).toContain('Unable to parse line: "X - Y"');
    expect(state.graph.nodes.map((node) => node.id)).toEqual(previousNodeIds);
  });

  test("renameNode rewires edges and preserves treatment outcome references", () => {
    useWorkbenchStore.getState().renameNode("X", "Treatment");

    const state = useWorkbenchStore.getState();
    expect(state.graph.nodes.map((node) => node.id).sort()).toEqual(["Treatment", "Y", "Z"]);
    expect(state.graph.edges.map((edge) => edge.id).sort()).toEqual(["Z->Treatment", "Z->Y"]);
    expect(state.graph.treatmentId).toBe("Treatment");
  });

  test("renaming carries the column binding and chosen set along", () => {
    useWorkbenchStore.setState({ dataContext: { columnBindings: { Z: "age" }, chosenSet: ["Z"] } });
    useWorkbenchStore.getState().renameNode("Z", "Age");
    const { dataContext } = useWorkbenchStore.getState();
    expect(dataContext.columnBindings).toEqual({ Age: "age" });
    expect(dataContext.chosenSet).toEqual(["Age"]);
  });

  test("removing a variable drops it from the binding and chosen set", () => {
    useWorkbenchStore.setState({ dataContext: { columnBindings: { Z: "age" }, chosenSet: ["Z"] } });
    useWorkbenchStore.getState().removeNode("Z");
    const { dataContext } = useWorkbenchStore.getState();
    expect(dataContext.columnBindings).toEqual({});
    expect(dataContext.chosenSet).toEqual([]);
  });

  test("marking a variable as not measured shows in the text and leaves the chosen set", () => {
    useWorkbenchStore.setState({ dataContext: { chosenSet: ["Z"] } });
    useWorkbenchStore.getState().setNodeObserved("Z", false);
    const state = useWorkbenchStore.getState();
    expect(state.graph.nodes.find((node) => node.id === "Z")!.observed).toBe(false);
    expect(state.textDraft).toContain("Z [unobserved]");
    expect(state.dataContext.chosenSet).toEqual([]);
  });

  test("timing is stored on the variable", () => {
    useWorkbenchStore.getState().setNodeTiming("Z", "baseline");
    expect(useWorkbenchStore.getState().graph.nodes.find((node) => node.id === "Z")!.timing).toBe("baseline");
  });

  test.each([
    ["add", "Z", "Y", ["Z->X", "Z->Y"]],
    ["add", "X", "Y", ["X->Y", "Z->X", "Z->Y"]],
    ["remove", "Z", "X", ["Z->Y"]],
    ["reverse", "Z", "X", ["X->Z", "Z->Y"]],
  ] as const)("applying %s %s -> %s changes the graph only when asked", (edit, source, target, expected) => {
    useWorkbenchStore.setState({ previewArrow: { edit, source, target } });
    if (edit === "add" && source === "Z") {
      // Already drawn in this fixture, so start from a graph without it.
      useWorkbenchStore.getState().removeEdge("Z->Y");
    }
    const before = useWorkbenchStore.getState().graph.edges.length;
    expect(before).toBeGreaterThan(0);
    useWorkbenchStore.getState().applyArrowEdit({ edit, source, target });
    const state = useWorkbenchStore.getState();
    expect(state.graph.edges.map((edge) => edge.id).sort()).toEqual([...expected].sort());
    expect(state.previewArrow).toBeNull();
  });

  test("unused columns can be added as variables, bound to their original names", () => {
    useWorkbenchStore.getState().addColumnsAsVariables(["baseline risk (%)", "X"]);
    const state = useWorkbenchStore.getState();
    const ids = state.graph.nodes.map((node) => node.id);
    expect(ids).toContain("baseline_risk_");
    expect(ids).toContain("X_2");
    expect(state.dataContext.columnBindings!.baseline_risk_).toBe("baseline risk (%)");
    expect(state.dataContext.columnBindings!.X_2).toBe("X");
  });

  test("a saved project keeps measured flags, timing, bindings, the chosen set and the estimand", () => {
    useWorkbenchStore.getState().setNodeObserved("Z", false);
    useWorkbenchStore.getState().setNodeTiming("X", "before");
    useWorkbenchStore.getState().setColumnBinding("Y", "score");
    useWorkbenchStore.getState().setDataContext({ estimand: "att", chosenSet: ["X"] });
    const saved = JSON.stringify(buildProjectSnapshot());

    useWorkbenchStore.getState().clearGraph();
    useWorkbenchStore.getState().hydrateProject(parseProjectSnapshotText(saved));

    const state = useWorkbenchStore.getState();
    expect(state.graph.nodes.find((node) => node.id === "Z")!.observed).toBe(false);
    expect(state.graph.nodes.find((node) => node.id === "X")!.timing).toBe("before");
    expect(state.dataContext.columnBindings).toEqual({ Y: "score" });
    expect(state.dataContext.estimand).toBe("att");
    expect(state.dataContext.chosenSet).toEqual(["X"]);
    expect(state.textDraft).toContain("Z [unobserved]");
  });

  test("starting a new graph forgets choices that belonged to the old question", () => {
    useWorkbenchStore.getState().setDataContext({ estimand: "att", chosenSet: ["X"], columnBindings: { Y: "score" } });
    useWorkbenchStore.getState().clearGraph();
    const { dataContext } = useWorkbenchStore.getState();
    expect(dataContext.estimand).toBe("ate");
    expect(dataContext.chosenSet).toBeNull();
    expect(dataContext.columnBindings).toEqual({});
  });

  test("clearGraph resets the workspace to a usable empty state", () => {
    useWorkbenchStore.setState({
      analysis: { validation: { canAnalyze: true, issues: [] } } as never,
      analysisError: "stale error",
      activeTab: "details",
    });

    useWorkbenchStore.getState().clearGraph();

    const state = useWorkbenchStore.getState();
    expect(state.graph.nodes).toEqual([]);
    expect(state.analysis).toBeNull();
    expect(state.analysisError).toBeNull();
    expect(state.activeTab).toBe("assumptions");
  });
});
