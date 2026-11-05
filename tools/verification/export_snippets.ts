/**
 * Runs the browser engine on a list of analysis requests and writes out what it generated.
 * Called by verify_generated_code.py: vite-node export_snippets.ts <requests.json> <results.json>
 */
import { readFileSync, writeFileSync } from "node:fs";

import type { AnalysisRequest } from "@causal-graph-workbench/shared";

import { analyze } from "../../apps/frontend/src/engine/analyze";
import { buildReproducibleScript } from "../../apps/frontend/src/engine/reproduce";

const [inputPath, outputPath] = process.argv.slice(-2);
const requests = JSON.parse(readFileSync(inputPath, "utf-8")) as AnalysisRequest[];
const results = requests.map((request) => {
  const result = analyze(request);
  return {
    recommended: result.recommendedAdjustmentSet,
    issues: result.validation.issues.map((issue) => issue.code),
    snippets: result.codeSnippets,
    effect: result.effect?.estimate ?? null,
    effectUnavailable: result.effect?.unavailableReason ?? null,
    audit: result.audit,
    sensitivity: result.sensitivity,
    reproducibleScript: buildReproducibleScript(request.graph, result),
  };
});
writeFileSync(outputPath, JSON.stringify(results));
