import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, test } from "vitest";

import { analyze } from "../engine/analyze";
import { exampleProjects } from "./exampleProjects";
import { applyChange } from "./graphVersions";
import { TOUR_STOPS } from "./tour";

const TRUE_EFFECT = 2.8;

describe("training program example", () => {
  const example = exampleProjects.find((item) => item.id === "training-program")!;
  const content = readFileSync(resolve(__dirname, "../../public/demo-data/training-program-study.csv"), "utf-8");
  const result = analyze({
    graph: example.graph,
    dataContext: example.dataContext,
    dataset: { filename: example.datasetFilename, content },
  });
  const estimate = result.effect!.estimate!;
  const top = result.audit!.assumptions[0];

  test("every variable finds its column", () => {
    expect(result.dataDiagnostics!.variableBindings.every((binding) => binding.matched)).toBe(true);
  });

  test("the graph as drawn gives an estimate that misses the true effect", () => {
    expect(result.baselineSet).toEqual(["age", "prior_earnings"]);
    expect(estimate.ciLow).toBeGreaterThan(TRUE_EFFECT);
  });

  test("the audit puts the missing arrow first, and the data backs it up", () => {
    expect(top.id).toBe("add:education:training");
    expect(top.dataCheck).toBe("conflict");
    expect(top.repair).toEqual(["age", "education", "prior_earnings"]);
  });

  test("fixing that arrow recovers the true effect", () => {
    const fixed = top.alternativeEstimate!;
    expect(fixed.ciLow).toBeLessThan(TRUE_EFFECT);
    expect(fixed.ciHigh).toBeGreaterThan(TRUE_EFFECT);
  });

  test("the figures quoted on the start screen are the ones the example really gives", () => {
    const startScreen = readFileSync(resolve(__dirname, "../components/StartScreen.tsx"), "utf-8");
    expect(startScreen).toContain(`from ${estimate.estimate.toFixed(3)} to ${top.alternativeEstimate!.estimate.toFixed(3)}`);
    expect(startScreen).toContain(`The true effect in`);
    expect(startScreen).toContain(`is ${TRUE_EFFECT}.`);
  });

  test("the figures quoted in the walkthrough are the ones the example really gives", () => {
    const quoted = TOUR_STOPS.map((stop) => stop.body).join(" ");
    expect(quoted).toContain(`from ${estimate.estimate.toFixed(3)} to ${top.alternativeEstimate!.estimate.toFixed(3)}`);
    expect(quoted).toContain(`is ${TRUE_EFFECT}.`);
    expect(quoted).toContain(`${result.dataDiagnostics!.rowCount.toLocaleString("en-US")} workers`);
  });

  test("what the walkthrough says about comparing is true of this example", () => {
    const last = TOUR_STOPS[TOUR_STOPS.length - 1];
    const second = applyChange(example.graph, last.adds!);
    const comparison = analyze({
      graph: example.graph,
      dataContext: example.dataContext,
      dataset: { filename: example.datasetFilename, content },
      versions: [
        { id: "a", name: "Graph A", graph: example.graph },
        { id: "b", name: "Graph B", graph: second },
      ],
      activeVersionId: "a",
    }).comparison!;
    expect(last.body).toMatch(/valid under both/);
    expect(comparison.sharedSet!.validIn).toEqual(["a", "b"]);
    expect(comparison.sharedSet!.notValidIn).toEqual([]);
  });

  test("no arrow on the drawing, nor the missing one it is about, runs behind another variable", () => {
    const at = new Map(example.graph.nodes.map((node) => [node.id, node]));
    const box = { width: 130, height: 48 };
    const arrows: [string, string][] = [...example.graph.edges.map((edge): [string, string] => [edge.source, edge.target]), ["education", "training"]];
    for (const [source, target] of arrows) {
      const from = at.get(source)!;
      const to = at.get(target)!;
      for (const node of example.graph.nodes) {
        if (node.id === source || node.id === target) {
          continue;
        }
        // Walk along the line between the two centres, looking for the box of any other variable.
        for (let step = 0; step <= 200; step += 1) {
          const x = from.x + ((to.x - from.x) * step) / 200;
          const y = from.y + ((to.y - from.y) * step) / 200;
          const inside = x > node.x - box.width / 2 && x < node.x + box.width / 2 && y > node.y - box.height / 2 && y < node.y + box.height / 2;
          expect(inside, `${source} -> ${target} runs behind ${node.id}`).toBe(false);
        }
      }
    }
  });

  test("common mistakes are visibly wrong: no adjustment, and adjusting for everything", () => {
    const none = result.effect!.comparisons.find((item) => item.kind === "none")!;
    const all = result.effect!.comparisons.find((item) => item.kind === "all")!;
    expect(none.isValid).toBe(false);
    expect(none.estimate!.ciLow).toBeGreaterThan(TRUE_EFFECT);
    expect(all.isValid).toBe(false);
    expect(all.invalidReason).toMatch(/downstream of treatment/);
    expect(all.estimate!.ciHigh).toBeLessThan(TRUE_EFFECT);
  });
});
