import type { AnalysisResult, GraphSpec } from "@causal-graph-workbench/shared";
import { describe, expect, test } from "vitest";

import { analyze, analyzeInStages } from "./analyze";
import { mergeUpdate } from "./mergeUpdate";
import { buildReproducibleScript } from "./reproduce";

/** Whether the script's numbers match the app is checked by running it: see tools/verification/verify_generated_code.py. */
function graph(edges: [string, string][], treatment = "X", outcome = "Y"): GraphSpec {
  const ids = [...new Set(edges.flat())];
  return {
    nodes: ids.map((id) => ({ id, label: id, x: 0, y: 0 })),
    edges: edges.map(([source, target]) => ({ id: `${source}->${target}`, source, target })),
    treatmentId: treatment,
    outcomeId: outcome,
  };
}

function file(header: string, rows = 200): string {
  const lines = [header];
  for (let index = 0; index < rows; index += 1) {
    const z = Math.sin(index * 1.7);
    const x = z + Math.cos(index * 2.3) > 0 ? 1 : 0;
    lines.push(`${x},${(x + z + Math.sin(index * 5.1)).toFixed(4)},${z.toFixed(4)}`);
  }
  return lines.join("\n");
}

const edges: [string, string][] = [
  ["Z", "X"],
  ["Z", "Y"],
  ["X", "Y"],
];

describe("the script for the whole analysis", () => {
  const request = { graph: graph(edges), dataset: { filename: "study.csv", content: file("X,Y,Z") } };
  const analysis = analyze(request);
  const script = buildReproducibleScript(request.graph, analysis)!;

  test("holds this analysis's settings and the numbers to check against", () => {
    expect(script).toContain('DATA_FILE = "study.csv"');
    expect(script).toContain('TREATMENT = "X"');
    expect(script).toContain('ADJUST_FOR = ["Z"]');
    expect(script).toContain(JSON.stringify(analysis.effect!.estimate!.estimate));
    expect(script).toContain(JSON.stringify(analysis.sensitivity!.robustness!.value));
  });

  test("does not exist until the analysis has finished, so it cannot check itself against a partial result", () => {
    let result: AnalysisResult | null = null;
    const partial: (string | null)[] = [];
    for (const stage of analyzeInStages(request)) {
      result = "structure" in stage ? stage.structure : mergeUpdate(result!, stage.update);
      partial.push(buildReproducibleScript(request.graph, result));
    }
    expect(partial[0]).toBeNull();
    expect(partial.slice(0, -1).every((item) => item === null)).toBe(true);
    expect(partial[partial.length - 1]).not.toBeNull();
  });

  test("needs a file and an estimate", () => {
    const withoutData = { graph: graph(edges) };
    expect(buildReproducibleScript(withoutData.graph, analyze(withoutData))).toBeNull();
    const noValidSet = graph([["U", "X"], ["U", "Y"], ["X", "Y"]]);
    noValidSet.nodes = noValidSet.nodes.map((node) => (node.id === "U" ? { ...node, observed: false } : node));
    expect(buildReproducibleScript(noValidSet, analyze({ graph: noValidSet, dataset: { filename: "s.csv", content: "X,Y\n1,2\n0,1\n1,3\n0,2\n" } }))).toBeNull();
  });

  test("a file or column name cannot break out of its string", () => {
    const hostile = 'a"""\nimport os; os.system("x")\n"""';
    const strange = analyze({
      graph: graph(edges),
      dataContext: { columnBindings: { Z: 'z"; import os #' } },
      dataset: { filename: hostile, content: file('X,Y,"z""; import os #"') },
    });
    const output = buildReproducibleScript(graph(edges), strange)!;
    expect(output).not.toContain("\nimport os; os.system");
    expect(output).toContain(JSON.stringify(hostile));
    expect(output).toContain(JSON.stringify('z"; import os #'));
    expect(output.split("\n").filter((line) => /^import os/.test(line))).toEqual([]);
  });
});
