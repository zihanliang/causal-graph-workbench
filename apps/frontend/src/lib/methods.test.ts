import type { AnalysisRequest, GraphSpec } from "@causal-graph-workbench/shared";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, test } from "vitest";

import { analyze } from "../engine/analyze";
import { exampleProjects } from "./exampleProjects";
import { buildMarkdownReport } from "./export";
import { effectInterval, effectValue } from "./format";
import { applyChange } from "./graphVersions";
import { buildMethodsText, methodsAsText } from "./methods";

const example = exampleProjects.find((item) => item.id === "training-program")!;
const content = readFileSync(resolve(__dirname, "../../public/demo-data/training-program-study.csv"), "utf-8");

function run(extra: Partial<AnalysisRequest> = {}) {
  const request: AnalysisRequest = {
    graph: example.graph,
    dataContext: example.dataContext,
    dataset: { filename: example.datasetFilename, content },
    ...extra,
  };
  return { graph: request.graph, analysis: analyze(request) };
}

function simple(edges: [string, string][], treatment = "X", outcome = "Y"): GraphSpec {
  const ids = [...new Set(edges.flat())];
  return {
    nodes: ids.map((id) => ({ id, label: id, x: 0, y: 0 })),
    edges: edges.map(([source, target]) => ({ id: `${source}->${target}`, source, target })),
    treatmentId: treatment,
    outcomeId: outcome,
  };
}

describe("methods text for the worked example", () => {
  const { graph, analysis } = run();
  const methods = buildMethodsText(graph, analysis);
  const text = methodsAsText(methods);
  const estimate = analysis.effect!.estimate!;

  test("reports the numbers of this result, not numbers from anywhere else", () => {
    expect(text).toContain(`${effectValue(estimate)} (95% CI ${effectInterval(estimate)})`);
    expect(text).toContain(`${estimate.rowsUsed.toLocaleString("en-US")} of`);
    expect(text).toContain(`${(analysis.sensitivity!.robustness!.value * 100).toFixed(1)}%`);
    expect(text).toContain(analysis.sensitivity!.evalue!.point.toFixed(2));
    expect(text).toContain(`${analysis.audit!.editsChecked} possible errors`);
  });

  test("names the variables adjusted for, the ones avoided, and the arrow that matters most", () => {
    expect(text).toContain("age and prior_earnings together satisfy the backdoor criterion");
    expect(text).toContain("We did not adjust for promoted and skills_after");
    expect(text).toContain("education → training");
  });

  test("leaves the reasons for believing the graph to the author", () => {
    expect(text).toMatch(/\[Explain here why you believe this graph, especially that education has no direct effect on training\.\]/);
  });

  test("never claims the graph was shown to be right", () => {
    expect(text.toLowerCase()).not.toMatch(/\b(verified|confirmed|validated|proved|proven|passed)\b/);
  });

  test("states the data conflict plainly, with what it might mean", () => {
    expect(text).toMatch(/rejected at the 5% level \(education and training given age and prior_earnings\)/);
    expect(text).toContain("either a missing arrow or something unmeasured");
  });

  test("cites every source it mentions, and only those", () => {
    const expected: [RegExp, RegExp][] = [
      [/Pearl, 2009/, /^Pearl, J\./],
      [/Robins et al\., 1994/, /^Robins, J\. M\./],
      [/Shah & Peters, 2020/, /^Shah, R\. D\./],
      [/Holm, 1979/, /^Holm, S\./],
      [/Cinelli & Hazlett, 2020/, /^Cinelli, C\./],
      [/Chernozhukov et al\. \(2022\)/, /^Chernozhukov, V\./],
      [/VanderWeele & Ding, 2017/, /^VanderWeele, T\. J\./],
    ];
    const body = methods.paragraphs.join(" ");
    for (const [inText, inList] of expected) {
      expect(body).toMatch(inText);
      expect(methods.references.some((reference) => inList.test(reference))).toBe(true);
    }
    expect(methods.references).toHaveLength(expected.length);
    expect(body).not.toContain("MacKinnon");
  });

  test("is in the reports too", () => {
    const report = buildMarkdownReport(graph, analysis, example.dataContext);
    expect(report).toContain("## Methods Text");
    expect(report).toContain("## Something Unmeasured");
    expect(report).toContain("Cinelli, C., & Hazlett, C. (2020)");
  });
});

describe("methods text in other situations", () => {
  test("without data it stops at what the graph implies", () => {
    const graph = simple([["Z", "X"], ["Z", "Y"], ["X", "Y"]]);
    const methods = buildMethodsText(graph, analyze({ graph }));
    const text = methods.paragraphs.join(" ");
    expect(text).toContain("Z satisfies the backdoor criterion");
    expect(text).not.toMatch(/estimated effect|95% CI|E-value|robustness value|reproduces/);
    expect(methods.references).toHaveLength(1);
  });

  test("no valid set is reported as such", () => {
    const graph = simple([["U", "X"], ["U", "Y"], ["X", "Y"]]);
    graph.nodes = graph.nodes.map((node) => (node.id === "U" ? { ...node, observed: false } : node));
    const text = buildMethodsText(graph, analyze({ graph })).paragraphs.join(" ");
    expect(text).toContain("U was not measured");
    expect(text).toContain("no set of measured variables satisfies the backdoor criterion");
    expect(text).toContain("did not estimate the effect");
  });

  test("no adjustment is said in words, not as an empty list", () => {
    const graph = simple([["X", "Y"]]);
    const text = buildMethodsText(graph, analyze({ graph })).paragraphs.join(" ");
    expect(text).toContain("no backdoor path is open");
    expect(text).toContain("we adjusted for nothing");
  });

  test("a numeric treatment reads as a regression with robust standard errors, and cites them", () => {
    const rows = Array.from({ length: 300 }, (_, index) => {
      const z = Math.sin(index);
      const x = z + Math.cos(index * 3);
      return `${x.toFixed(4)},${(0.5 * x + z + Math.sin(index * 7)).toFixed(4)},${z.toFixed(4)}`;
    });
    const graph = simple([["Z", "X"], ["Z", "Y"], ["X", "Y"]]);
    const methods = buildMethodsText(graph, analyze({ graph, dataset: { filename: "d.csv", content: ["X,Y,Z", ...rows].join("\n") } }));
    const text = methods.paragraphs.join(" ");
    expect(text).toContain("by linear regression");
    expect(text).toContain("MacKinnon & White, 1985");
    expect(text).toContain("for a one standard deviation increase in X");
    expect(methods.references.some((reference) => reference.startsWith("MacKinnon"))).toBe(true);
    expect(methods.references.some((reference) => reference.startsWith("Chernozhukov"))).toBe(false);
  });

  test("the ATT is named as the ATT", () => {
    const { graph, analysis } = run({ dataContext: { ...example.dataContext, estimand: "att" } });
    const text = buildMethodsText(graph, analysis).paragraphs.join(" ");
    expect(text).toContain("average treatment effect on the treated");
    expect(text).toContain("capped at 0.99");
  });
});

describe("when graphs were compared", () => {
  const second = applyChange(example.graph, { edit: "add", source: "education", target: "training" });
  const methods = buildMethodsText(
    example.graph,
    run({
      versions: [
        { id: "a", name: "Graph A", graph: example.graph },
        { id: "b", name: "Graph B", graph: second },
      ],
      activeVersionId: "a",
    }).analysis,
  );
  const paragraph = methods.paragraphs.find((item) => item.includes("candidate graphs"))!;

  test("says that it was done, with the range of estimates and the set valid under them", () => {
    expect(paragraph).toContain("repeated the analysis under 2 candidate graphs on the same data");
    expect(paragraph).toContain("2 different adjustment sets, with estimates from 2.882 to 4.630");
    expect(paragraph).toMatch(/Adjusting for age, education and prior_earnings is valid under 2 of them and gives 2\.882/);
    expect(paragraph).toContain("holds only if one of those graphs is correct");
  });

  test("does not let a graph the data did not contradict sound confirmed", () => {
    expect(paragraph).toContain("does not show that the others are correct");
    expect(paragraph.toLowerCase()).not.toMatch(/\b(verified|confirmed|validated|passed)\b/);
  });

  test("does not claim the script covers every graph", () => {
    expect(methods.paragraphs.join(" ")).toContain("reproduces the numbers for the graph described first");
    expect(methods.paragraphs.join(" ")).toContain("It does not cover the other graphs tried.");
    expect(methods.paragraphs.join(" ")).not.toContain("reproduces these numbers");
  });

  test("a single graph has no such paragraph", () => {
    expect(buildMethodsText(example.graph, run().analysis).paragraphs.some((item) => item.includes("candidate graphs"))).toBe(false);
  });
});

describe("when arrows were marked as not sure", () => {
  const methods = buildMethodsText(example.graph, run({ uncertainPairs: [{ first: "education", second: "training" }, { first: "education", second: "promoted" }] }).analysis);
  const paragraph = methods.paragraphs.find((item) => item.includes("each combination"))!;

  test("says what was tried, what it led to, and what the answer depends on", () => {
    expect(paragraph).toContain("We were unsure whether an arrow joins education and training and education and promoted");
    expect(paragraph).toContain("estimates from 2.882 to 4.630");
    expect(paragraph).toContain("The answer depends on education and training.");
    expect(paragraph).toMatch(/Adjusting for age, education and prior_earnings is valid under \d+ of the combinations/);
  });

  test("does not explain away combinations that were not left out", () => {
    const all = buildMethodsText(example.graph, run({ uncertainPairs: [{ first: "age", second: "education" }] }).analysis);
    expect(all.paragraphs.join(" ")).toContain("All 3 combinations were analysed.");
    expect(all.paragraphs.join(" ")).not.toContain("the others would");
  });

  test("does not let any combination sound confirmed, or the script sound complete", () => {
    expect(paragraph.toLowerCase()).not.toMatch(/\b(verified|confirmed|validated|passed)\b/);
    expect(methods.paragraphs.join(" ")).toContain("It does not cover the other graphs tried.");
  });
});

describe("when something measured could explain away the whole estimate", () => {
  const unsure = simple([["Z", "X"], ["Z", "Y"], ["X", "Y"]]);
  const rows = Array.from({ length: 300 }, (_, index) => {
    const z = Math.sin(index * 1.3);
    return `${z + 0.4 * Math.cos(index * 2.1) > 0 ? 1 : 0},${(3 * z + 0.02 * Math.sin(index * 4.7)).toFixed(4)},${z.toFixed(4)}`;
  });
  const text = buildMethodsText(unsure, analyze({ graph: unsure, dataset: { content: ["X,Y,Z", ...rows].join("\n") } })).paragraphs.join(" ");

  test("reads as a sentence, without a figure that means nothing", () => {
    expect(text).not.toMatch(/, ;/);
    expect(text).not.toMatch(/999\.0%|\d{3,}\.\d%/);
  });
});
