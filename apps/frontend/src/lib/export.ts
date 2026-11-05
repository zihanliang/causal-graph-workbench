import type { AnalysisResult, DataContext, GraphSpec } from "@causal-graph-workbench/shared";
import { toPng } from "html-to-image";

import { arrowLabel, effectSummary, repairSummary, roleCaption, shiftSummary } from "./format";
import { buildMethodsText } from "./methods";
import { isProjectSnapshot, type ProjectSnapshot } from "./projectSnapshot";

export function downloadJsonFile(filename: string, payload: unknown): void {
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
  downloadBlob(filename, blob);
}

export function downloadMarkdownReport(
  filename: string,
  graph: GraphSpec,
  analysis: AnalysisResult | null,
  dataContext?: DataContext,
): void {
  const markdown = buildMarkdownReport(graph, analysis, dataContext);
  const blob = new Blob([markdown], { type: "text/markdown;charset=utf-8" });
  downloadBlob(filename, blob);
}

export async function downloadGraphPng(filename: string, element: HTMLElement): Promise<void> {
  const dataUrl = await toPng(element, {
    cacheBust: true,
    backgroundColor: "#ffffff",
    pixelRatio: 2,
    // The picture is of the graph, not of the controls for working on it.
    filter: (node) => !(node as HTMLElement).classList?.contains("react-flow__controls") && !(node as HTMLElement).classList?.contains("react-flow__handle"),
  });
  const anchor = document.createElement("a");
  anchor.href = dataUrl;
  anchor.download = filename;
  anchor.click();
}

export function downloadTextFile(filename: string, content: string): void {
  downloadBlob(filename, new Blob([content], { type: "text/plain" }));
}

export function downloadGraphSvg(filename: string, graph: GraphSpec, analysis: AnalysisResult | null): void {
  const svgContent = buildGraphSvg(graph, analysis);
  const blob = new Blob([svgContent], { type: "image/svg+xml;charset=utf-8" });
  downloadBlob(filename, blob);
}

export function openAnalysisPdf(graph: GraphSpec, analysis: AnalysisResult | null, dataContext?: DataContext): void {
  if (!document.body) {
    throw new Error("Document body is not ready for printable export.");
  }

  const existingFrame = document.getElementById("printable-report-frame");
  existingFrame?.remove();

  const frame = document.createElement("iframe");
  frame.id = "printable-report-frame";
  frame.setAttribute("aria-hidden", "true");
  frame.style.position = "fixed";
  frame.style.right = "0";
  frame.style.bottom = "0";
  frame.style.width = "0";
  frame.style.height = "0";
  frame.style.border = "0";
  frame.style.opacity = "0";
  frame.style.pointerEvents = "none";

  let fallbackCleanupTimer = 0;
  const cleanup = () => {
    window.clearTimeout(fallbackCleanupTimer);
    frame.remove();
  };

  const printReport = () => {
    const printWindow = frame.contentWindow;
    if (!printWindow) {
      cleanup();
      throw new Error("Printable report could not be opened.");
    }

    printWindow.onafterprint = cleanup;
    printWindow.focus();
    printWindow.print();
  };

  fallbackCleanupTimer = window.setTimeout(cleanup, 60_000);

  frame.addEventListener(
    "load",
    () => {
      window.setTimeout(printReport, 80);
    },
    { once: true },
  );

  document.body.appendChild(frame);
  frame.srcdoc = buildPrintableReportHtml(graph, analysis, dataContext);
}

export async function readProjectSnapshot(file: File): Promise<ProjectSnapshot> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      try {
        resolve(parseProjectSnapshotText(String(reader.result)));
      } catch (error) {
        reject(error);
      }
    };
    reader.onerror = reject;
    reader.readAsText(file);
  });
}

export function parseProjectSnapshotText(text: string): ProjectSnapshot {
  const parsed = JSON.parse(text) as unknown;
  if (!isProjectSnapshot(parsed)) {
    throw new Error("The selected JSON file is not a valid Causal Graph Workbench project snapshot.");
  }
  return parsed;
}

export function buildMarkdownReport(graph: GraphSpec, analysis: AnalysisResult | null, dataContext?: DataContext): string {
  const lines: string[] = [
    "# Causal Graph Workbench Report",
    "",
    "This report summarizes structural reasoning for the user-provided DAG.",
    "",
    "> The tool does not verify the DAG is true. It only reasons conditionally on the DAG provided by the user.",
    "",
    "## Graph Summary",
    `- Nodes: ${graph.nodes.length}`,
    `- Edges: ${graph.edges.length}`,
    `- Treatment: ${graph.treatmentId ?? "not selected"}`,
    `- Outcome: ${graph.outcomeId ?? "not selected"}`,
    `- Data available: ${dataContext?.hasData ? "yes" : "no"}`,
    "",
    "## Edge List",
  ];

  if (graph.edges.length) {
    lines.push(...graph.edges.map((edge) => `- ${edge.source} -> ${edge.target}`));
  } else {
    lines.push("- No edges defined.");
  }

  if (!analysis) {
    lines.push("", "## Analysis", "- No analysis result available.");
    return lines.join("\n");
  }

  lines.push(
    "",
    "## Validation",
    ...analysis.validation.issues.map((issue) => `- [${issue.severity}] ${issue.code}: ${issue.message}`),
    "",
    "## Structural Summary",
    `- Directed paths: ${analysis.graphStats.directedPathCount}`,
    `- Open backdoor paths by default: ${analysis.limits.pathsTruncated ? "at least " : ""}${analysis.graphStats.openBackdoorPathCount}`,
    `- Recommended adjustment set: ${formatRecommendedSet(analysis)}`,
  );

  lines.push(...buildResultLines(analysis));

  lines.push("", "## Path Highlights");
  if (analysis.paths.length) {
    for (const path of analysis.paths) {
      lines.push(
        `- ${path.pathString} [${path.category}] [${path.defaultEvaluation.status}]: ${path.explanation}`,
      );
    }
  } else {
    lines.push("- No treatment-outcome paths were enumerated.");
  }

  lines.push("", "## Adjustment Sets");
  if (analysis.adjustmentSets.length) {
    for (const adjustmentSet of analysis.adjustmentSets) {
      lines.push(
        `- ${formatSet(adjustmentSet.variables)} | structural=${adjustmentSet.isValid ? "valid" : "invalid"} | practical=${adjustmentSet.practicalRating}: ${adjustmentSet.explanation}`,
      );
    }
  } else {
    lines.push("- No valid observed adjustment sets were identified under backdoor adjustment.");
  }

  lines.push("", "## Forbidden Variables");
  if (analysis.forbiddenVariables.length) {
    for (const forbidden of analysis.forbiddenVariables) {
      lines.push(`- ${forbidden.nodeId}: ${forbidden.reasons.join(" ")}`);
    }
  } else {
    lines.push("- None identified.");
  }

  if (analysis.cautionVariables.length) {
    lines.push("", "## Variables To Use With Care");
    for (const caution of analysis.cautionVariables) {
      lines.push(`- ${caution.nodeId}${caution.required ? " (required)" : ""}: ${caution.reasons.join(" ")}`);
    }
  }

  lines.push("", "## Assumptions");
  for (const assumption of analysis.assumptions) {
    lines.push(`- ${assumption.title}: ${assumption.description}`);
  }

  lines.push("", "## Estimator Recommendations");
  if (analysis.estimatorRecommendations.length) {
    for (const estimator of analysis.estimatorRecommendations) {
      lines.push(
        `- ${estimator.name} | recommended=${estimator.recommended ? "yes" : "no"} | priority=${estimator.priority} | ${estimator.formulaPreview}`,
      );
      if (estimator.caveats.length) {
        lines.push(...estimator.caveats.map((caveat) => `  - Caveat: ${caveat}`));
      }
    }
  } else {
    lines.push("- No estimator recommendation was emitted because no valid backdoor adjustment set was found.");
  }

  if (analysis.dataDiagnostics?.hasData) {
    lines.push(
      "",
      "## Data Diagnostics",
      `- Dataset: ${analysis.dataDiagnostics.datasetName ?? "uploaded.csv"}`,
      `- Rows: ${analysis.dataDiagnostics.rowCount}`,
      `- Columns: ${analysis.dataDiagnostics.columnCount}`,
      ...analysis.dataDiagnostics.warnings.map((warning) => `- Warning: ${warning}`),
    );
    lines.push("", "### Variable Bindings");
    lines.push(
      ...analysis.dataDiagnostics.variableBindings.map(
        (binding) => `- ${binding.nodeId} -> ${binding.columnName ?? "unmatched"} (${binding.matchType})`,
      ),
    );
    lines.push(...buildCovariateCheckLines(analysis));
  }

  const primarySnippet = analysis.codeSnippets[0];
  if (primarySnippet) {
    lines.push("", `## Code Template: ${primarySnippet.label}`, "```" + primarySnippet.language, primarySnippet.content, "```");
  } else if (!analysis.adjustmentSets.length) {
    lines.push("", "## Code Template", "- No code template is emitted when no valid backdoor adjustment set is available.");
  }

  lines.push(...methodsLines(graph, analysis));
  return lines.join("\n");
}

/** The estimate and what it rests on, in the same order as the app. */
function buildResultLines(analysis: AnalysisResult): string[] {
  const lines: string[] = [];
  const estimate = analysis.effect?.estimate;
  if (estimate) {
    lines.push(
      "",
      "## Estimated Effect",
      `- ${estimate.description}`,
      `- Estimate: ${effectSummary(estimate)}`,
      `- Adjusting for: ${formatSet(estimate.adjustmentSet)}`,
      `- Rows used: ${estimate.rowsUsed} (${estimate.rowsDropped} dropped for missing values)`,
      ...estimate.warnings.map((warning) => `- Warning: ${warning}`),
    );
    const others = analysis.effect!.comparisons.filter((row) => row.kind !== "baseline" && row.estimate);
    if (others.length) {
      lines.push("", "### The same data with other adjustment sets");
      for (const row of others) {
        lines.push(`- ${row.label} ${formatSet(row.variables)}: ${effectSummary(row.estimate!)}${row.isValid ? "" : ` (not valid: ${row.invalidReason})`}`);
      }
    }
  } else if (analysis.effect?.unavailableReason) {
    lines.push("", "## Estimated Effect", `- Not available: ${analysis.effect.unavailableReason}`);
  }

  const audit = analysis.audit;
  if (audit) {
    lines.push(
      "",
      "## What This Result Depends On",
      `Of ${audit.editsChecked} ways the graph could be wrong by one arrow, ${audit.assumptions.length} would stop ${formatSet(audit.baselineSet)} from being valid.`,
    );
    if (audit.tests.length) {
      const conflicts = audit.tests.filter((test) => test.conflict).length;
      lines.push(
        `${audit.tests.length} independencies implied by the graph were checked against the data, and ${conflicts} conflict. Finding no conflict does not show the graph is right.`,
      );
    }
    lines.push("");
    for (const item of audit.assumptions) {
      const shift = shiftSummary(item);
      lines.push(
        `- **${arrowLabel(item)}**: ${item.statement} ${item.consequence} ${repairSummary(item)}${shift ? ` ${shift}` : ""} ${item.dataCheckNote}`,
      );
    }
    lines.push(
      "",
      "These checks cannot see something unmeasured that affects both treatment and outcome, or errors involving several arrows at once.",
    );
  }
  const unmeasured = unmeasuredLines(analysis);
  if (unmeasured.length) {
    lines.push("", "## Something Unmeasured", ...unmeasured);
  }
  return lines;
}

/** What the report says about unmeasured confounding, in the same words as the page. */
function unmeasuredLines(analysis: AnalysisResult): string[] {
  const { robustness, evalue } = analysis.sensitivity ?? { robustness: null, evalue: null };
  const lines: string[] = [];
  if (robustness) {
    const percent = (value: number) => `${(value * 100).toFixed(1)}%`;
    lines.push(
      `To explain away the effect, something unmeasured would have to explain ${percent(robustness.value)} of what the adjustment leaves unexplained in both treatment and outcome. ${
        robustness.valueForInterval > 0 ? `For its interval to include no effect, ${percent(robustness.valueForInterval)}.` : "Its interval already includes no effect."
      }`,
    );
    if (robustness.basis === "linear_probability") {
      lines.push("Measured on a linear probability model with the same variables, because this bound does not apply to an odds ratio directly.");
    }
    for (const benchmark of robustness.benchmarks) {
      lines.push(`- Something as strong as ${benchmark.variable}: about ${benchmark.shareOfEstimate >= 1 ? "all" : percent(benchmark.shareOfEstimate)} of the estimate.`);
    }
  }
  if (evalue) {
    lines.push(`E-value: ${evalue.point.toFixed(2)} for the estimate, ${evalue.interval.toFixed(2)} for the end of the interval nearer no effect.`);
  }
  return lines;
}

function methodsLines(graph: GraphSpec, analysis: AnalysisResult): string[] {
  if (!analysis.validation.canAnalyze) {
    return [];
  }
  const methods = buildMethodsText(graph, analysis);
  return ["", "## Methods Text", "", ...methods.paragraphs.flatMap((paragraph) => [paragraph, ""]), "### References", "", ...methods.references.map((reference) => `- ${reference}`)];
}

function buildCovariateCheckLines(analysis: AnalysisResult): string[] {
  const lines: string[] = [];
  const balance = analysis.dataDiagnostics?.treatmentBalance;
  if (balance?.available) {
    lines.push("", "### Covariate Balance", `- ${balance.note}`);
    for (const metric of balance.metrics) {
      const smd = metric.standardizedDifference === null || metric.standardizedDifference === undefined ? "n/a" : metric.standardizedDifference.toFixed(3);
      lines.push(`- ${metric.columnName}: treated ${metric.treatedValue}, control ${metric.controlValue}, SMD ${smd}${metric.imbalanced ? " (imbalanced)" : ""}`);
    }
  }
  const overlap = analysis.dataDiagnostics?.overlapDiagnostics;
  if (overlap?.available) {
    lines.push("", "### Overlap", `- ${overlap.note}`);
    if (overlap.propensity) {
      const { treatedRange, controlRange, extremeShare, rowsUsed } = overlap.propensity;
      lines.push(
        `- Treated propensity range: ${treatedRange[0].toFixed(3)} to ${treatedRange[1].toFixed(3)}`,
        `- Control propensity range: ${controlRange[0].toFixed(3)} to ${controlRange[1].toFixed(3)}`,
        `- Rows below 0.05 or above 0.95: ${(extremeShare * 100).toFixed(1)}% of ${rowsUsed}`,
      );
    }
    lines.push(...overlap.warnings.map((warning) => `- Warning: ${warning}`));
  }
  return lines;
}

export function buildPrintableReportHtml(graph: GraphSpec, analysis: AnalysisResult | null, dataContext?: DataContext): string {
  const sections: string[] = [];
  sections.push(
    `<section class="hero">` +
      `<p class="source">Causal Graph Workbench</p>` +
      `<h1>Printable Analysis Report</h1>` +
      `<p class="lede">Rule-based structural reasoning for the user-provided DAG. This report is designed for browser print-to-PDF.</p>` +
      `<div class="notice">The tool does not verify the DAG is true. It only reasons conditionally on the DAG provided by the user.</div>` +
    `</section>`,
  );

  sections.push(
    `<section><h2>Graph Summary</h2><div class="grid">` +
      metricCard("Nodes", String(graph.nodes.length)) +
      metricCard("Edges", String(graph.edges.length)) +
      metricCard("Treatment", escapeHtml(graph.treatmentId ?? "not selected")) +
      metricCard("Outcome", escapeHtml(graph.outcomeId ?? "not selected")) +
      metricCard("Data", dataContext?.hasData ? "available" : "not uploaded") +
    `</div></section>`,
  );

  sections.push(
    `<section><h2>Edge List</h2>${graph.edges.length ? `<ul>${graph.edges.map((edge) => `<li>${escapeHtml(edge.source)} → ${escapeHtml(edge.target)}</li>`).join("")}</ul>` : `<p>No edges defined.</p>`}</section>`,
  );

  if (analysis) {
    sections.push(
      `<section><h2>Validation</h2>${analysis.validation.issues.length ? `<ul>${analysis.validation.issues.map((issue) => `<li><strong>${escapeHtml(issue.severity)}</strong> ${escapeHtml(issue.code)}: ${escapeHtml(issue.message)}</li>`).join("")}</ul>` : `<p>No validation issues reported.</p>`}</section>`,
    );
    const resultLines = buildResultLines(analysis)
      .filter(Boolean)
      .map((line) =>
        line.startsWith("## ")
          ? `<h2>${escapeHtml(line.slice(3))}</h2>`
          : line.startsWith("### ")
            ? `<h3>${escapeHtml(line.slice(4))}</h3>`
            : `<p>${escapeHtml(line.replace(/^- /, "").replaceAll("**", ""))}</p>`,
      );
    if (resultLines.length) {
      sections.push(`<section>${resultLines.join("")}</section>`);
    }
    if (analysis.validation.canAnalyze) {
      const methods = buildMethodsText(graph, analysis);
      sections.push(
        `<section><h2>Methods Text</h2>${methods.paragraphs.map((paragraph) => `<p>${escapeHtml(paragraph)}</p>`).join("")}` +
          `<h3>References</h3><ul>${methods.references.map((reference) => `<li>${escapeHtml(reference)}</li>`).join("")}</ul></section>`,
      );
    }
    sections.push(
      `<section><h2>Adjustment Recommendation</h2>` +
        `<p><strong>Recommended set:</strong> ${escapeHtml(formatRecommendedSet(analysis))}</p>` +
        `${
          analysis.adjustmentSets.length
            ? `<div class="table">${comparisonHeader(["Set", "Validity", "Minimal", "Recommendation", "Notes"])}${analysis.adjustmentSets
                .map((adjustmentSet) =>
                  comparisonRow([
                    escapeHtml(formatSet(adjustmentSet.variables)),
                    adjustmentSet.isValid ? "valid" : "invalid",
                    adjustmentSet.isMinimal ? "yes" : "no",
                    escapeHtml(adjustmentSet.practicalRating),
                    escapeHtml(adjustmentSet.practicalConcerns[0] ?? adjustmentSet.explanation),
                  ]),
                )
                .join("")}</div>`
            : `<p>No valid observed adjustment sets were identified under backdoor adjustment.</p>`
        }` +
      `</section>`,
    );
    sections.push(
      `<section><h2>Estimator Recommendations</h2>${
        analysis.estimatorRecommendations.length
          ? `<ul>${analysis.estimatorRecommendations
              .map(
                (estimator) =>
                  `<li><strong>${escapeHtml(estimator.name)}</strong> (${escapeHtml(estimator.family)})` +
                  `${estimator.recommended ? ` <span class="badge">default</span>` : ""}` +
                  `<br /><span class="muted">${escapeHtml(estimator.summary)}</span>` +
                  `<br /><code>${escapeHtml(estimator.formulaPreview)}</code>` +
                  `${estimator.caveats.length ? `<ul>${estimator.caveats.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ul>` : ""}` +
                  `</li>`,
              )
              .join("")}</ul>`
          : `<p>No estimator recommendation was emitted because no valid backdoor adjustment set was found.</p>`
      }</section>`,
    );
    if (analysis.dataDiagnostics?.hasData) {
      sections.push(
        `<section><h2>Data Diagnostics</h2>` +
          `<p><strong>Dataset:</strong> ${escapeHtml(analysis.dataDiagnostics.datasetName ?? "uploaded.csv")} | ${analysis.dataDiagnostics.rowCount} rows | ${analysis.dataDiagnostics.columnCount} columns</p>` +
          `<div class="table">${comparisonHeader(["Column", "Type", "Missing", "Unique", "Binding"])}${analysis.dataDiagnostics.columnProfiles
            .map((profile) => {
              const bindings = analysis.dataDiagnostics?.variableBindings
                .filter((item) => item.columnName === profile.columnName)
                .map((item) => item.nodeId)
                .join(", ");
              return comparisonRow([
                escapeHtml(profile.columnName),
                escapeHtml(profile.inferredType),
                `${(profile.missingRate * 100).toFixed(1)}%`,
                String(profile.uniqueCount),
                escapeHtml(bindings || "none"),
              ]);
            })
            .join("")}</div>` +
          `${analysis.dataDiagnostics.warnings.length ? `<ul>${analysis.dataDiagnostics.warnings.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ul>` : ""}` +
          `${(() => {
            const checks = buildCovariateCheckLines(analysis)
              .filter((line) => line.startsWith("- "))
              .map((line) => `<li>${escapeHtml(line.slice(2))}</li>`)
              .join("");
            return checks ? `<h3>Balance and overlap</h3><ul>${checks}</ul>` : "";
          })()}` +
        `</section>`,
      );
    }
    const primarySnippet = analysis.codeSnippets[0];
    if (primarySnippet) {
      sections.push(
        `<section><h2>Code Template</h2><p><strong>${escapeHtml(primarySnippet.label)}</strong></p><pre><code>${escapeHtml(primarySnippet.content)}</code></pre></section>`,
      );
    } else if (!analysis.adjustmentSets.length) {
      sections.push(
        `<section><h2>Code Template</h2><p>No code template is emitted when no valid backdoor adjustment set is available.</p></section>`,
      );
    }
  } else {
    sections.push(`<section><h2>Analysis</h2><p>No analysis result available.</p></section>`);
  }

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Causal Analysis Report</title>
    <style>
      :root { color-scheme: light; }
      * { box-sizing: border-box; }
      body { margin: 0; font-family: "IBM Plex Sans", "Helvetica Neue", Arial, sans-serif; font-size: 14px; color: #131416; background: #ffffff; }
      main { max-width: 860px; margin: 0 auto; padding: 32px 24px 48px; }
      section { padding: 20px 0; border-top: 1px solid #e8eaec; }
      section.hero { border-top: 0; padding-top: 0; }
      .source { margin: 0 0 4px; color: #5d5f60; }
      h1, h2, h3 { font-weight: 600; margin: 0 0 10px; }
      h1 { font-size: 24px; }
      h2 { font-size: 16px; }
      h3 { font-size: 14px; }
      .lede, .muted, p, li { line-height: 1.55; }
      .muted { color: #5d5f60; }
      .notice { padding: 10px 12px; border-radius: 6px; background: #f4f6f8; }
      .grid { display: grid; grid-template-columns: repeat(5, minmax(0, 1fr)); gap: 12px; }
      .card span { display: block; color: #5d5f60; font-size: 12px; }
      .card strong { display: block; margin-top: 2px; font-size: 16px; font-weight: 600; overflow-wrap: anywhere; }
      .table { display: grid; }
      .row { display: grid; grid-template-columns: minmax(90px, 140px) 80px 70px 110px minmax(0, 1fr); gap: 10px; padding: 8px 0; border-top: 1px solid #f0f1f2; }
      .row.header { border-top: 0; color: #5d5f60; font-size: 12px; }
      code, pre { font-family: "IBM Plex Mono", Menlo, Consolas, monospace; font-size: 12px; }
      pre { overflow: auto; padding: 12px; background: #f4f6f8; border-radius: 6px; }
      .badge { display: inline-block; margin-left: 6px; padding: 0 6px; border-radius: 4px; background: #ebedee; font-size: 12px; }
      @media print {
        main { max-width: none; padding: 0; }
        section { break-inside: avoid; }
      }
    </style>
  </head>
  <body>
    <main>${sections.join("")}</main>
    <script>
      window.addEventListener("load", () => {
        window.setTimeout(() => window.print(), 120);
      });
    </script>
  </body>
</html>`;
}

function downloadBlob(filename: string, blob: Blob): void {
  const objectUrl = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = objectUrl;
  anchor.download = filename;
  anchor.click();
  window.setTimeout(() => URL.revokeObjectURL(objectUrl), 1000);
}

/** Draws the graph the way the canvas does: straight arrows from box to box, the causal ones in orange. */
export function buildGraphSvg(graph: GraphSpec, analysis: AnalysisResult | null): string {
  const roleLookup = new Map(analysis?.nodeRoles.map((node) => [node.nodeId, node.roles]) ?? []);
  const boxes = new Map(
    graph.nodes.map((node) => {
      const caption = roleCaption(node.id, node.observed !== false, graph, roleLookup.get(node.id) ?? []);
      const width = Math.max(96, Math.max(node.label.length * 8.6, (caption?.length ?? 0) * 6.2) + 28);
      const height = caption ? 48 : 36;
      return [node.id, { node, caption, width, height, cx: node.x + width / 2, cy: node.y + height / 2 }];
    }),
  );

  const causal = new Set<string>();
  for (const path of analysis?.paths ?? []) {
    if (path.category === "directed_causal") {
      path.nodes.slice(0, -1).forEach((source, index) => causal.add(`${source}->${path.nodes[index + 1]}`));
    }
  }

  const all = [...boxes.values()];
  const margin = 40;
  const minX = Math.min(0, ...all.map((box) => box.node.x)) - margin;
  const minY = Math.min(0, ...all.map((box) => box.node.y)) - margin;
  const width = Math.max(0, ...all.map((box) => box.node.x + box.width)) + margin - minX;
  const height = Math.max(0, ...all.map((box) => box.node.y + box.height)) + margin - minY;
  const marker = (id: string, color: string) =>
    `<marker id="${id}" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="8" markerHeight="8" markerUnits="userSpaceOnUse" orient="auto-start-reverse"><path d="M 0 0 L 10 5 L 0 10 z" fill="${color}" /></marker>`;

  const lines = [
    `<?xml version="1.0" encoding="UTF-8"?>`,
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="${minX} ${minY} ${width} ${height}">`,
    `<defs>${marker("arrow", "#8a8f94")}${marker("arrow-causal", "#c2552b")}</defs>`,
    `<rect x="${minX}" y="${minY}" width="${width}" height="${height}" fill="#ffffff" />`,
  ];

  for (const edge of graph.edges) {
    const source = boxes.get(edge.source);
    const target = boxes.get(edge.target);
    if (!source || !target) {
      continue;
    }
    const [x1, y1] = svgBorderPoint(source, target);
    const [x2, y2] = svgBorderPoint(target, source);
    const isCausal = causal.has(`${edge.source}->${edge.target}`);
    lines.push(
      `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="${isCausal ? "#c2552b" : "#8a8f94"}" stroke-width="${isCausal ? 2.25 : 1.5}" marker-end="url(#${isCausal ? "arrow-causal" : "arrow"})" />`,
    );
  }

  const font = `font-family="'IBM Plex Sans', 'Helvetica Neue', Arial, sans-serif" text-anchor="middle"`;
  for (const { node, caption, width: boxWidth, height: boxHeight, cx, cy } of boxes.values()) {
    const isEndpoint = node.id === graph.treatmentId || node.id === graph.outcomeId;
    const isUnmeasured = !isEndpoint && node.observed === false;
    const fill = isEndpoint ? "#131416" : isUnmeasured ? "none" : "#ffffff";
    const stroke = isEndpoint ? "#131416" : isUnmeasured ? "#8a8f94" : "#cdced1";
    lines.push(
      `<rect x="${node.x}" y="${node.y}" rx="8" ry="8" width="${boxWidth}" height="${boxHeight}" fill="${fill}" stroke="${stroke}" stroke-width="1"${isUnmeasured ? ` stroke-dasharray="4 3"` : ""} />`,
    );
    lines.push(
      `<text x="${cx}" y="${caption ? cy - 3 : cy + 5}" ${font} font-size="14" font-weight="600" fill="${isEndpoint ? "#ffffff" : "#131416"}">${escapeHtml(node.label)}</text>`,
    );
    if (caption) {
      lines.push(`<text x="${cx}" y="${cy + 13}" ${font} font-size="11" fill="${isEndpoint ? "#c9cbce" : "#5d5f60"}">${escapeHtml(caption)}</text>`);
    }
  }

  lines.push(`</svg>`);
  return lines.join("");
}

/** Where the line towards `other` leaves `box`, with a little air for the arrowhead. */
function svgBorderPoint(
  box: { cx: number; cy: number; width: number; height: number },
  other: { cx: number; cy: number },
): [number, number] {
  const dx = other.cx - box.cx;
  const dy = other.cy - box.cy;
  if (!dx && !dy) {
    return [box.cx, box.cy];
  }
  const gap = 3;
  const scale = Math.min(dx ? (box.width / 2 + gap) / Math.abs(dx) : Infinity, dy ? (box.height / 2 + gap) / Math.abs(dy) : Infinity);
  return [box.cx + dx * scale, box.cy + dy * scale];
}

function formatSet(values: string[]) {
  return values.length ? `{${values.join(", ")}}` : "{}";
}

function formatRecommendedSet(analysis: AnalysisResult): string {
  if (!analysis.adjustmentSets.length) {
    return "none identified via backdoor adjustment";
  }
  return analysis.recommendedAdjustmentSet.length ? formatSet(analysis.recommendedAdjustmentSet) : "{} (no adjustment needed)";
}

function metricCard(label: string, value: string): string {
  return `<div class="card"><span>${escapeHtml(label)}</span><strong>${escapeHtml(value)}</strong></div>`;
}

function comparisonHeader(columns: string[]): string {
  return `<div class="row header">${columns.map((column) => `<span>${escapeHtml(column)}</span>`).join("")}</div>`;
}

function comparisonRow(columns: string[]): string {
  return `<div class="row">${columns.map((column) => `<span>${column}</span>`).join("")}</div>`;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}
