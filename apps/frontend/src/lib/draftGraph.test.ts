import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, test } from "vitest";

import { analyze } from "../engine/analyze";
import { Dag } from "../engine/graph";
import { impliedIndependencies } from "../engine/audit";
import { buildDraft, looksUnusable, type DraftColumn } from "./draftGraph";

const content = readFileSync(resolve(__dirname, "../../public/demo-data/training-program-study.csv"), "utf-8");
const dataset = { filename: "training-program-study.csv", content };
const TRUE_EFFECT = 2.8;
const columns: DraftColumn[] = [
  { name: "age", role: "before" },
  { name: "education", role: "before" },
  { name: "prior_earnings", role: "before" },
  { name: "skills_after", role: "after" },
  { name: "promoted", role: "after" },
];
const draft = buildDraft(columns, "training", "earnings_after");
const request = { graph: draft.graph, dataset, dataContext: { columnBindings: draft.columnBindings } };

describe("a first graph from time order", () => {
  test("claims nothing the data could contradict", () => {
    const dag = Dag.fromSpec(draft.graph);
    const { specs } = impliedIndependencies(dag, new Set(dag.nodes));
    expect(specs).toEqual([]);
    expect(dag.isAcyclic()).toBe(true);
    expect(analyze(request).audit!.tests).toEqual([]);
  });

  test("adjusts for what came before treatment, and not for what came after", () => {
    const analysis = analyze(request);
    expect(analysis.baselineSet).toEqual(["age", "education", "prior_earnings"]);
    expect(analysis.forbiddenVariables.map((item) => item.nodeId).sort()).toEqual(["promoted", "skills_after"]);
  });

  test("gets the example's true effect where the drawn graph does not, because every cause is measured", () => {
    const estimate = analyze(request).effect!.estimate!;
    expect(estimate.estimate).toBeCloseTo(2.882, 2);
    expect(estimate.ciLow).toBeLessThan(TRUE_EFFECT);
    expect(estimate.ciHigh).toBeGreaterThan(TRUE_EFFECT);
  });

  test("rests on no single arrow, because no arrow it has is doing the claiming", () => {
    expect(analyze(request).audit!.assumptions).toEqual([]);
  });

  test("uses the timing that was given, and marks only the arrows that bear on the question as ordinary", () => {
    const timing = Object.fromEntries(draft.graph.nodes.map((node) => [node.id, node.timing ?? null]));
    expect(timing).toMatchObject({ age: "before", education: "before", prior_earnings: "before", skills_after: "after", promoted: "after", training: null, earnings_after: null });
    const faint = draft.graph.edges.filter((edge) => edge.background).map((edge) => edge.id);
    expect(faint).toContain("age->education");
    expect(faint).toContain("age->promoted");
    expect(faint).toContain("skills_after->promoted");
    expect(faint).not.toContain("age->training");
    expect(faint).not.toContain("training->earnings_after");
    expect(faint).not.toContain("training->skills_after");
  });

  test("leaves out what it was told to, and makes do with nothing else", () => {
    const small = buildDraft([{ name: "age", role: "leave" }], "training", "earnings_after");
    expect(small.graph.nodes.map((node) => node.id).sort()).toEqual(["earnings_after", "training"]);
    expect(small.graph.edges.map((edge) => edge.id)).toEqual(["training->earnings_after"]);
    expect(analyze({ graph: small.graph, dataset }).baselineSet).toEqual([]);
  });

  test("a column with an awkward name gets a usable variable, still matched to that column", () => {
    const file = { content: ["my treat,risk (%),2nd score", ...Array.from({ length: 60 }, (_, i) => `${i % 2},${(i * 7) % 11},${(i * 3) % 13}`)].join("\n") };
    const awkward = buildDraft([{ name: "2nd score", role: "before" }], "my treat", "risk (%)");
    const ids = awkward.graph.nodes.map((node) => node.id);
    expect(ids).toEqual(expect.arrayContaining(["my_treat", "risk_", "V_2nd_score"]));
    const analysis = analyze({ graph: awkward.graph, dataset: file, dataContext: { columnBindings: awkward.columnBindings } });
    expect(analysis.dataDiagnostics!.variableBindings.every((binding) => binding.matched)).toBe(true);
    expect(analysis.baselineSet).toEqual(["V_2nd_score"]);
    expect(analysis.effect!.estimate).not.toBeNull();
  });

  test("a column of unknown timing is marked as unsure against treatment, and both possibilities are tried", () => {
    const unsure = buildDraft([{ name: "age", role: "before" }, { name: "education", role: "before" }, { name: "prior_earnings", role: "unsure" }, { name: "skills_after", role: "after" }, { name: "promoted", role: "after" }], "training", "earnings_after");
    expect(unsure.uncertainPairs).toEqual([{ first: "prior_earnings", second: "training" }]);
    expect(unsure.graph.nodes.find((node) => node.id === "prior_earnings")!.timing).toBeUndefined();
    const scan = analyze({ graph: unsure.graph, dataset, dataContext: { columnBindings: unsure.columnBindings }, uncertainPairs: unsure.uncertainPairs }).scan!;
    expect(scan.answers.length).toBeGreaterThan(1);
    expect(scan.pairEffects[0].changesAnswer).toBe(true);
  });

  test.each([0, 1, 3, 7, 8, 15, 30])("no variable lands on another, with %i earlier columns", (count) => {
    const names = Array.from({ length: count }, (_, i) => `C${i}`);
    const later = Array.from({ length: Math.ceil(count / 3) }, (_, i) => `L${i}`);
    const { graph } = buildDraft([...names.map((name) => ({ name, role: "before" as const })), ...later.map((name) => ({ name, role: "after" as const }))], "T", "Y");
    graph.nodes.forEach((node, index) =>
      graph.nodes.slice(index + 1).forEach((other) => {
        expect(Math.abs(node.x - other.x) >= 150 || Math.abs(node.y - other.y) >= 70, `${node.id} and ${other.id}`).toBe(true);
      }),
    );
  });

  test("many columns stay fast enough to use", () => {
    const names = Array.from({ length: 25 }, (_, i) => `C${i}`);
    const rows = Array.from({ length: 2000 }, (_, row) => [row % 2, (row * 7) % 11, ...names.map((_, i) => (row * (i + 3)) % 17)].join(","));
    const big = buildDraft(names.map((name) => ({ name, role: "before" })), "T", "Y");
    const started = performance.now();
    const analysis = analyze({ graph: big.graph, dataset: { content: ["T,Y," + names.join(","), ...rows].join("\n") }, dataContext: { columnBindings: big.columnBindings } });
    expect(performance.now() - started).toBeLessThan(30000);
    expect(analysis.baselineSet).toHaveLength(25);
    expect(analysis.audit!.status).toBe("complete");
  }, 60000);
});

describe("columns that cannot be causes", () => {
  test.each([
    ["an identifier in words", ["S1", "S2", "S3", "S4"], "student", true],
    ["numbers called an id", ["1", "2", "3", "4"], "student_id", true],
    ["a bare id", ["7", "8", "9", "10"], "ID", true],
    ["a constant", ["5", "5", "5", "5"], "batch", true],
    ["all empty", ["", "", "", ""], "notes", true],
    ["measurements that all differ", ["1.2", "3.4", "2.2", "9"], "income", false],
    ["ordinary categories", ["a", "b", "a", "b"], "group", false],
    ["a word ending in id", ["1", "2", "3", "4"], "humid", false],
  ])("%s", (_, values, name, expected) => {
    expect(looksUnusable(values, name)).toBe(expected);
  });
});
