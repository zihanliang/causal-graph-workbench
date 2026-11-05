import type { GraphSpec, Issue, Severity, ValidationSummary } from "@causal-graph-workbench/shared";

import { Dag } from "./graph";

const VARIABLE_NAME = /^[\p{L}_][\p{L}\p{N}_]*$/u;
const HARD_BLOCKS = new Set(["empty_graph", "duplicate_node_id", "invalid_variable_name", "duplicate_edge", "dangling_edge"]);

function issue(
  severity: Severity,
  code: string,
  message: string,
  details: { nodeIds?: string[]; edgeIds?: string[] } = {},
): Issue {
  return { severity, code, message, nodeIds: details.nodeIds ?? [], edgeIds: details.edgeIds ?? [], details: [] };
}

function isConnected(dag: Dag, from: string, to: string): boolean {
  const seen = new Set<string>();
  const stack = [from];
  while (stack.length) {
    const current = stack.pop()!;
    if (current === to) {
      return true;
    }
    if (!seen.has(current)) {
      seen.add(current);
      stack.push(...dag.neighbors(current));
    }
  }
  return false;
}

function runsBackwardsInTime(graph: GraphSpec, source: string, target: string): boolean {
  const tier = (id: string): number | null => {
    if (id === graph.treatmentId) {
      return 2;
    }
    if (id === graph.outcomeId) {
      return 3;
    }
    const timing = graph.nodes.find((node) => node.id === id)?.timing;
    return timing === "baseline" ? 0 : timing === "before" ? 1 : timing === "after" ? 3 : null;
  };
  const from = tier(source);
  const to = tier(target);
  return from !== null && to !== null && from > to;
}

export function validateGraph(graph: GraphSpec): ValidationSummary {
  const issues: Issue[] = [];
  const ids = graph.nodes.map((node) => node.id);
  const nodeIds = new Set(ids);

  if (!graph.nodes.length) {
    issues.push(issue("error", "empty_graph", "Graph is empty. Add at least one node."));
  }

  const duplicateNodes = [...new Set(ids.filter((id, index) => ids.indexOf(id) !== index))].sort();
  if (duplicateNodes.length) {
    issues.push(issue("error", "duplicate_node_id", "Duplicate node ids detected.", { nodeIds: duplicateNodes }));
  }

  const invalidNames = [...nodeIds].filter((id) => !VARIABLE_NAME.test(id)).sort();
  if (invalidNames.length) {
    issues.push(
      issue("error", "invalid_variable_name", "Variable names can use letters, numbers and underscores, and cannot start with a number.", {
        nodeIds: invalidNames,
      }),
    );
  }

  const seenEdges = new Set<string>();
  const selfLoops: string[] = [];
  const duplicateEdges: string[] = [];
  const danglingEdges: string[] = [];
  for (const edge of graph.edges) {
    if (edge.source === edge.target) {
      selfLoops.push(edge.id);
    }
    const key = `${edge.source}\u0000${edge.target}`;
    if (seenEdges.has(key)) {
      duplicateEdges.push(edge.id);
    }
    seenEdges.add(key);
    if (!nodeIds.has(edge.source) || !nodeIds.has(edge.target)) {
      danglingEdges.push(edge.id);
    }
  }
  if (selfLoops.length) {
    issues.push(issue("error", "self_loop", "Self-loops are not allowed in a DAG.", { edgeIds: selfLoops }));
  }
  if (duplicateEdges.length) {
    issues.push(issue("error", "duplicate_edge", "Duplicate directed edges detected.", { edgeIds: duplicateEdges }));
  }
  if (danglingEdges.length) {
    issues.push(issue("error", "dangling_edge", "Some edges reference nodes that do not exist.", { edgeIds: danglingEdges }));
  }

  const treatment = graph.treatmentId && nodeIds.has(graph.treatmentId) ? graph.treatmentId : null;
  const outcome = graph.outcomeId && nodeIds.has(graph.outcomeId) ? graph.outcomeId : null;
  if (!treatment) {
    issues.push(issue("error", "missing_treatment", "Select a valid treatment node."));
  }
  if (!outcome) {
    issues.push(issue("error", "missing_outcome", "Select a valid outcome node."));
  }
  if (treatment && treatment === outcome) {
    issues.push(issue("error", "treatment_equals_outcome", "Treatment and outcome must be different variables."));
  }

  if (!issues.some((item) => HARD_BLOCKS.has(item.code))) {
    const dag = Dag.fromSpec(graph);
    if (!dag.isAcyclic()) {
      issues.push(issue("error", "cycle_detected", "The graph contains a directed cycle."));
    }
    const isolated = dag.nodes.filter((node) => dag.neighbors(node).size === 0).sort();
    if (isolated.length) {
      issues.push(issue("warning", "isolated_node", "Isolated or disconnected nodes were detected.", { nodeIds: isolated }));
    }
    if (treatment && outcome && treatment !== outcome) {
      if (!isConnected(dag, treatment, outcome)) {
        issues.push(issue("warning", "treatment_outcome_unreachable", "Treatment and outcome are disconnected in the graph."));
      } else if (!dag.descendants(treatment).has(outcome)) {
        issues.push(issue("warning", "no_directed_path", "No directed causal path from treatment to outcome was found."));
      }
    }
    const backwards = graph.edges.filter((edge) => runsBackwardsInTime(graph, edge.source, edge.target));
    if (backwards.length) {
      issues.push(
        issue(
          "warning",
          "timing_conflict",
          `These arrows point backwards in time, given when you said each variable is fixed: ${backwards
            .map((edge) => `${edge.source} → ${edge.target}`)
            .join(", ")}.`,
          { edgeIds: backwards.map((edge) => edge.id) },
        ),
      );
    }
    issues.push(issue("info", "graph_summary", `${graph.nodes.length} nodes and ${graph.edges.length} edges loaded.`));
  }

  return { canAnalyze: !issues.some((item) => item.severity === "error"), issues };
}
