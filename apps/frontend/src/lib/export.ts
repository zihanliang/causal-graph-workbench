import type { AnalysisResult, DataContext, GraphSpec } from "@causal-workbench/shared";
import { toPng } from "html-to-image";

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
    backgroundColor: "#f6f1e5",
    pixelRatio: 2,
  });
  const anchor = document.createElement("a");
  anchor.href = dataUrl;
  anchor.download = filename;
  anchor.click();
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
    `- Open backdoor paths by default: ${analysis.graphStats.openBackdoorPathCount}`,
    `- Recommended adjustment set: ${analysis.adjustmentSets.length ? formatSet(analysis.recommendedAdjustmentSet) : "none identified via backdoor adjustment"}`,
  );

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
  }

  const primarySnippet = analysis.codeSnippets[0];
  if (primarySnippet) {
    lines.push("", `## Code Template: ${primarySnippet.label}`, "```" + primarySnippet.language, primarySnippet.content, "```");
  } else if (!analysis.adjustmentSets.length) {
    lines.push("", "## Code Template", "- No code template is emitted when no valid backdoor adjustment set is available.");
  }

  return lines.join("\n");
}

function buildPrintableReportHtml(graph: GraphSpec, analysis: AnalysisResult | null, dataContext?: DataContext): string {
  const sections: string[] = [];
  sections.push(
    `<section class="hero">` +
      `<p class="eyebrow">Causal Graph Workbench</p>` +
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
    sections.push(
      `<section><h2>Adjustment Recommendation</h2>` +
        `<p><strong>Recommended set:</strong> ${escapeHtml(analysis.adjustmentSets.length ? formatSet(analysis.recommendedAdjustmentSet) : "none identified via backdoor adjustment")}</p>` +
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
      body {
        margin: 0;
        font-family: "IBM Plex Sans", "Avenir Next", sans-serif;
        color: #2e2515;
        background: #f8f3e8;
      }
      main {
        max-width: 980px;
        margin: 0 auto;
        padding: 32px 24px 48px;
      }
      section {
        background: #fffaf0;
        border: 1px solid rgba(143, 111, 60, 0.24);
        border-radius: 24px;
        padding: 20px 22px;
        margin-bottom: 18px;
      }
      .hero {
        background: linear-gradient(135deg, rgba(255,250,240,0.96), rgba(244,234,211,0.88));
      }
      .eyebrow {
        margin: 0 0 8px;
        text-transform: uppercase;
        letter-spacing: 0.18em;
        font-size: 12px;
        color: #a54d28;
      }
      h1, h2 {
        font-family: "Fraunces", "Georgia", serif;
        margin: 0 0 12px;
      }
      h1 { font-size: 34px; line-height: 1; }
      h2 { font-size: 22px; }
      .lede, .muted, p, li { line-height: 1.6; }
      .muted { color: #6e5f43; }
      .notice {
        padding: 12px 14px;
        border-radius: 16px;
        background: rgba(240, 161, 62, 0.12);
        border: 1px solid rgba(240, 161, 62, 0.22);
      }
      .grid {
        display: grid;
        grid-template-columns: repeat(3, minmax(0, 1fr));
        gap: 12px;
      }
      .card {
        padding: 14px;
        border-radius: 16px;
        background: rgba(248, 243, 232, 0.82);
        border: 1px solid rgba(143, 111, 60, 0.18);
      }
      .card span {
        display: block;
        font-size: 12px;
        color: #6e5f43;
        text-transform: uppercase;
        letter-spacing: 0.08em;
      }
      .card strong {
        display: block;
        margin-top: 4px;
        font-size: 20px;
      }
      .table { display: grid; gap: 8px; }
      .row {
        display: grid;
        grid-template-columns: minmax(90px, 120px) 90px 90px 120px minmax(0, 1fr);
        gap: 10px;
        padding: 10px 12px;
        border-radius: 14px;
        border: 1px solid rgba(143, 111, 60, 0.18);
        background: rgba(248, 243, 232, 0.7);
      }
      .row.header {
        font-weight: 700;
        background: rgba(244, 233, 209, 0.9);
      }
      code, pre {
        font-family: "JetBrains Mono", "SFMono-Regular", monospace;
      }
      pre {
        overflow: auto;
        padding: 14px;
        background: #2b2419;
        color: #f8efe0;
        border-radius: 18px;
      }
      .badge {
        display: inline-block;
        margin-left: 6px;
        padding: 2px 8px;
        border-radius: 999px;
        background: rgba(29,106,87,0.14);
        border: 1px solid rgba(29,106,87,0.24);
        font-size: 12px;
      }
      @media print {
        body { background: white; }
        main { max-width: none; padding: 0; }
        section { break-inside: avoid; border-color: #ddd; box-shadow: none; }
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

function buildGraphSvg(graph: GraphSpec, analysis: AnalysisResult | null): string {
  const width = Math.max(860, ...graph.nodes.map((node) => node.x + 160));
  const height = Math.max(520, ...graph.nodes.map((node) => node.y + 140));
  const nodeIndex = new Map(graph.nodes.map((node) => [node.id, node]));
  const roleLookup = new Map(analysis?.nodeRoles.map((node) => [node.nodeId, node.roles]) ?? []);
  const lines = [
    `<?xml version="1.0" encoding="UTF-8"?>`,
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">`,
    `<defs>`,
    `<linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">`,
    `<stop offset="0%" stop-color="#fbf7ef" />`,
    `<stop offset="100%" stop-color="#efe6d4" />`,
    `</linearGradient>`,
    `<marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">`,
    `<path d="M 0 0 L 10 5 L 0 10 z" fill="#8f6f3c" />`,
    `</marker>`,
    `</defs>`,
    `<rect width="100%" height="100%" fill="url(#bg)" />`,
  ];

  for (const edge of graph.edges) {
    const source = nodeIndex.get(edge.source);
    const target = nodeIndex.get(edge.target);
    if (!source || !target) {
      continue;
    }
    lines.push(
      `<line x1="${source.x + 56}" y1="${source.y + 26}" x2="${target.x + 6}" y2="${target.y + 26}" stroke="#8f6f3c" stroke-width="2.4" marker-end="url(#arrow)" />`,
    );
  }

  for (const node of graph.nodes) {
    const roleColor = svgNodeColors(node.id, graph, roleLookup.get(node.id) ?? []);
    lines.push(
      `<rect x="${node.x - 12}" y="${node.y - 8}" rx="16" ry="16" width="116" height="56" fill="${roleColor.fill}" stroke="${roleColor.stroke}" stroke-width="2.2" />`,
    );
    lines.push(
      `<text x="${node.x + 46}" y="${node.y + 22}" text-anchor="middle" dominant-baseline="middle" font-family="'IBM Plex Sans', sans-serif" font-size="18" font-weight="700" fill="${roleColor.text}">${escapeHtml(node.label)}</text>`,
    );
  }

  lines.push(`</svg>`);
  return lines.join("");
}

function svgNodeColors(nodeId: string, graph: GraphSpec, roles: string[]) {
  if (nodeId === graph.treatmentId) {
    return { fill: "#d86f42", stroke: "#8f6f3c", text: "#fffdf7" };
  }
  if (nodeId === graph.outcomeId) {
    return { fill: "#1d6a57", stroke: "#8f6f3c", text: "#fffdf7" };
  }
  if (roles.includes("confounder")) {
    return { fill: "#f4d49c", stroke: "#8f6f3c", text: "#2e2515" };
  }
  if (roles.includes("collider")) {
    return { fill: "#d8e5f3", stroke: "#8f6f3c", text: "#2e2515" };
  }
  if (roles.includes("mediator") || roles.includes("descendant_of_treatment")) {
    return { fill: "#efd2cb", stroke: "#8f6f3c", text: "#2e2515" };
  }
  return { fill: "#fffaf0", stroke: "#8f6f3c", text: "#2e2515" };
}

function formatSet(values: string[]) {
  return values.length ? `{${values.join(", ")}}` : "{}";
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
