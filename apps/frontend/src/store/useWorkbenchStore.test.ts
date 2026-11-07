import { beforeEach, describe, expect, test } from "vitest";

import { parseProjectSnapshotText } from "../lib/export";
import { firstVersion, MAX_GRAPH_VERSIONS } from "../lib/graphVersions";
import { buildProjectSnapshot, useWorkbenchStore } from "./useWorkbenchStore";

describe("workbench store", () => {
  beforeEach(() => {
    const graph = {
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
    };
    useWorkbenchStore.setState({
      graph,
      ...firstVersion(graph),
      tourStop: null,
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
      activeTab: "compare",
    });

    useWorkbenchStore.getState().clearGraph();

    const state = useWorkbenchStore.getState();
    expect(state.graph.nodes).toEqual([]);
    expect(state.analysis).toBeNull();
    expect(state.analysisError).toBeNull();
    expect(state.activeTab).toBe("steps");
  });

  describe("graphs kept side by side", () => {
    const edgeIds = (graph: { edges: { id: string }[] }) => graph.edges.map((edge) => edge.id).sort();
    const state = () => useWorkbenchStore.getState();

    test.each([
      ["add", "X", "Y", ["X->Y", "Z->X", "Z->Y"]],
      ["remove", "Z", "X", ["Z->Y"]],
      ["reverse", "Z", "X", ["X->Z", "Z->Y"]],
    ] as const)("%s %s -> %s makes a copy, and the open graph stays as it was", (edit, source, target, expected) => {
      const before = edgeIds(state().graph);
      useWorkbenchStore.setState({ previewArrow: { edit, source, target } });
      const id = state().addVersion({ edit, source, target })!;
      expect(edgeIds(state().graph)).toEqual(before);
      expect(edgeIds(state().versions.find((version) => version.id === id)!.graph)).toEqual([...expected].sort());
      expect(state().previewArrow).toBeNull();
      expect(state().activeVersionId).toBe("graph-a");
    });

    test("something unmeasured is added as a variable without a column, away from the others", () => {
      const id = state().addVersion({ edit: "unmeasured", source: "X", target: "Y" })!;
      const { graph } = state().versions.find((version) => version.id === id)!;
      const unmeasured = graph.nodes.find((node) => node.id === "U")!;
      expect(unmeasured.observed).toBe(false);
      expect(edgeIds(graph)).toEqual(["U->X", "U->Y", "Z->X", "Z->Y"]);
      for (const node of graph.nodes.filter((item) => item.id !== "U")) {
        expect(Math.abs(node.x - unmeasured.x) >= 160 || Math.abs(node.y - unmeasured.y) >= 80).toBe(true);
      }
    });

    test("the same change twice gives one graph", () => {
      const first = state().addVersion({ edit: "add", source: "X", target: "Y" });
      const second = state().addVersion({ edit: "add", source: "X", target: "Y" });
      expect(second).toBe(first);
      expect(state().versions).toHaveLength(2);
    });

    test("stops at the limit and says so by returning nothing", () => {
      for (let index = 1; index < MAX_GRAPH_VERSIONS; index += 1) {
        expect(state().addVersion()).not.toBeNull();
      }
      expect(state().versions).toHaveLength(MAX_GRAPH_VERSIONS);
      expect(state().versions.map((version) => version.name)).toEqual(["Graph A", "Graph B", "Graph C", "Graph D", "Graph E", "Graph F"]);
      expect(state().addVersion()).toBeNull();
      expect(state().addVersion({ edit: "add", source: "X", target: "Y" })).toBeNull();
    });

    test("trying another graph opens a copy to edit, and edits stay in that copy", () => {
      state().tryAnotherGraph();
      expect(state().activeVersionId).toBe("graph-b");
      expect(state().step).toBe("graph");
      state().connectNodes("X", "Y");
      expect(edgeIds(state().graph)).toContain("X->Y");
      state().selectVersion("graph-a");
      expect(edgeIds(state().graph)).toEqual(["Z->X", "Z->Y"]);
      expect(state().textDraft).not.toContain("X -> Y");
      state().selectVersion("graph-b");
      expect(edgeIds(state().graph)).toContain("X->Y");
      expect(state().textDraft).toContain("X -> Y");
    });

    test("at the limit, trying another graph shows the comparison, which says why", () => {
      for (let index = 1; index < MAX_GRAPH_VERSIONS; index += 1) {
        state().addVersion();
      }
      state().tryAnotherGraph();
      expect(state().activeVersionId).toBe("graph-a");
      expect(state().step).toBe("result");
      expect(state().activeTab).toBe("compare");
    });

    test("an open step stays open when another graph is shown, so the same step can be read across them", () => {
      state().addVersion({ edit: "add", source: "X", target: "Y" });
      state().setOpenStep("set");
      state().selectVersion("graph-b");
      expect(state().openStep).toBe("set");
    });

    test("removing the open graph opens another, and the last graph cannot be removed", () => {
      state().tryAnotherGraph();
      state().connectNodes("X", "Y");
      state().removeVersion("graph-b");
      expect(state().activeVersionId).toBe("graph-a");
      expect(edgeIds(state().graph)).toEqual(["Z->X", "Z->Y"]);
      state().removeVersion("graph-a");
      expect(state().versions).toHaveLength(1);
      expect(state().graph.nodes).toHaveLength(3);
    });

    test("removing another graph keeps unsaved edits to the open one", () => {
      state().addVersion({ edit: "add", source: "X", target: "Y" });
      state().connectNodes("Y", "Z");
      state().removeVersion("graph-b");
      expect(edgeIds(state().graph)).toContain("Y->Z");
    });

    test("the question and what is known about a variable hold in every graph", () => {
      state().tryAnotherGraph();
      state().setTreatment("Z");
      state().setOutcome("X");
      state().setNodeTiming("Y", "after");
      state().setNodeObserved("Y", false);
      state().selectVersion("graph-a");
      expect(state().graph.treatmentId).toBe("Z");
      expect(state().graph.outcomeId).toBe("X");
      const y = state().graph.nodes.find((node) => node.id === "Y")!;
      expect(y.timing).toBe("after");
      expect(y.observed).toBe(false);
    });

    test("a new name reaches every graph, and cannot clash with a variable in any of them", () => {
      state().addVersion({ edit: "unmeasured", source: "X", target: "Y" });
      state().renameNode("Z", "U");
      const names = state().versions.map((version) => version.graph.nodes.map((node) => node.id));
      expect(state().graph.nodes.map((node) => node.id)).toContain("U_2");
      expect(names[1]).toEqual(expect.arrayContaining(["U", "U_2"]));
      expect(edgeIds(state().versions[1].graph)).toContain("U_2->X");
    });

    test("a variable moved in one graph stays put when another is opened", () => {
      state().tryAnotherGraph();
      state().updateNodePosition("Z", 321, 123);
      state().selectVersion("graph-a");
      expect(state().graph.nodes.find((node) => node.id === "Z")).toMatchObject({ x: 321, y: 123 });
    });

    test("a project saves and reopens every graph, on the one that was open", () => {
      state().addVersion({ edit: "add", source: "X", target: "Y" });
      state().tryAnotherGraph();
      state().connectNodes("Y", "Z");
      const saved = JSON.stringify(buildProjectSnapshot());

      state().clearGraph();
      expect(state().versions).toHaveLength(1);

      state().hydrateProject(parseProjectSnapshotText(saved));
      expect(state().versions.map((version) => version.name)).toEqual(["Graph A", "Graph B", "Graph C"]);
      expect(state().activeVersionId).toBe("graph-c");
      expect(edgeIds(state().graph)).toContain("Y->Z");
      expect(edgeIds(state().versions[1].graph)).toContain("X->Y");
    });

    test("a project saved before graphs could be compared still opens, as one graph", () => {
      const { versions: _versions, activeVersionId: _active, ...older } = buildProjectSnapshot();
      state().addVersion({ edit: "add", source: "X", target: "Y" });
      state().hydrateProject(parseProjectSnapshotText(JSON.stringify({ ...older, version: "0.2.0" })));
      expect(state().versions).toHaveLength(1);
      expect(state().activeVersionId).toBe("graph-a");
    });

    test("a project with one graph saves as it always did", () => {
      expect(buildProjectSnapshot().versions).toBeUndefined();
    });

    test("a project file cannot bring more graphs, or repeats of one, than the page would make", () => {
      const graph = state().graph;
      const many = Array.from({ length: 40 }, (_, index) => ({ id: `g${index}`, name: `G${index}`, graph }));
      state().hydrateProject({ ...buildProjectSnapshot(), versions: [many[0], many[0], ...many], activeVersionId: "missing" });
      expect(state().versions).toHaveLength(MAX_GRAPH_VERSIONS);
      expect(new Set(state().versions.map((version) => version.id)).size).toBe(MAX_GRAPH_VERSIONS);
      expect(state().activeVersionId).toBe("g0");
    });

    test("a saved list that is not a list of graphs is refused", () => {
      const broken = { ...buildProjectSnapshot(), versions: [{ id: "a", name: "A" }] };
      expect(() => parseProjectSnapshotText(JSON.stringify(broken))).toThrow(/could not be opened/);
    });

    test("a new example or a cleared graph starts from one graph", () => {
      state().addVersion({ edit: "add", source: "X", target: "Y" });
      state().applyTemplate(state().templates[0].id);
      expect(state().versions).toHaveLength(1);
      expect(state().activeVersionId).toBe("graph-a");
    });
  });
});
