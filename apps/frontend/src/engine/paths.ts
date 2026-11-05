import type { PathAnalysisItem, PathCategory, PathEvaluation, PathEvaluationStep } from "@causal-graph-workbench/shared";

import { Dag, sortedSet } from "./graph";

export const MAX_LISTED_PATHS = 300;
const MAX_SEARCH_STEPS = 400_000;

export interface RawPath {
  nodes: string[];
  category: PathCategory;
  colliders: string[];
  pathString: string;
}

export interface PathEnumeration {
  paths: RawPath[];
  truncated: boolean;
}

function isColliderAt(dag: Dag, previous: string, node: string, next: string): boolean {
  return dag.hasEdge(previous, node) && dag.hasEdge(next, node);
}

export function formatPathString(dag: Dag, nodes: string[]): string {
  const parts = [nodes[0]];
  for (let index = 0; index < nodes.length - 1; index += 1) {
    parts.push(`${dag.hasEdge(nodes[index], nodes[index + 1]) ? "->" : "<-"} ${nodes[index + 1]}`);
  }
  return parts.join(" ");
}

export function pathCategory(dag: Dag, nodes: string[]): PathCategory {
  const isDirected = nodes.slice(0, -1).every((node, index) => dag.hasEdge(node, nodes[index + 1]));
  if (isDirected) {
    return "directed_causal";
  }
  return dag.hasEdge(nodes[1], nodes[0]) ? "backdoor" : "noncausal";
}

function toRawPath(dag: Dag, nodes: string[]): RawPath {
  const colliders: string[] = [];
  for (let index = 1; index < nodes.length - 1; index += 1) {
    if (isColliderAt(dag, nodes[index - 1], nodes[index], nodes[index + 1])) {
      colliders.push(nodes[index]);
    }
  }
  return { nodes, category: pathCategory(dag, nodes), colliders, pathString: formatPathString(dag, nodes) };
}

/**
 * Lists simple treatment-outcome paths, shortest first, within a fixed budget. Dense graphs can have
 * astronomically many paths, so the list is for reading only: validity never depends on it.
 */
export function enumeratePaths(
  dag: Dag,
  treatment: string,
  outcome: string,
  maxPaths: number = MAX_LISTED_PATHS,
): PathEnumeration {
  const paths: RawPath[] = [];
  let steps = 0;
  let truncated = false;

  const search = (trail: string[], onTrail: Set<string>, remainingEdges: number): void => {
    const current = trail[trail.length - 1];
    if (remainingEdges === 0) {
      if (current === outcome) {
        paths.push(toRawPath(dag, [...trail]));
      }
      return;
    }
    if (current === outcome) {
      return;
    }
    for (const next of [...dag.neighbors(current)].sort()) {
      if (onTrail.has(next)) {
        continue;
      }
      if (paths.length >= maxPaths || steps >= MAX_SEARCH_STEPS) {
        truncated = true;
        return;
      }
      steps += 1;
      trail.push(next);
      onTrail.add(next);
      search(trail, onTrail, remainingEdges - 1);
      onTrail.delete(next);
      trail.pop();
    }
  };

  for (let length = 1; length < dag.nodes.length && !truncated; length += 1) {
    search([treatment], new Set([treatment]), length);
  }
  return { paths, truncated };
}

/** Number of directed treatment-to-outcome paths, by dynamic programming over a topological order. */
export function countDirectedPaths(dag: Dag, treatment: string, outcome: string): number {
  const order = dag.topologicalOrder();
  if (!order) {
    return 0;
  }
  const ways = new Map<string, number>([[treatment, 1]]);
  for (const node of order) {
    const here = ways.get(node) ?? 0;
    if (here === 0) {
      continue;
    }
    for (const child of dag.children(node)) {
      ways.set(child, (ways.get(child) ?? 0) + here);
    }
  }
  return treatment === outcome ? 0 : (ways.get(outcome) ?? 0);
}

/** Open/blocked verdict without building explanations, for scoring many sets against many paths. */
export function pathStatus(
  dag: Dag,
  nodes: string[],
  conditioning: Set<string>,
): { isOpen: boolean; openedBy: string[] } {
  let isOpen = true;
  const openedBy: string[] = [];
  for (let index = 1; index < nodes.length - 1; index += 1) {
    const node = nodes[index];
    if (isColliderAt(dag, nodes[index - 1], node, nodes[index + 1])) {
      const witness = conditioning.has(node) ? node : firstConditionedDescendant(dag, node, conditioning);
      if (witness) {
        openedBy.push(witness);
      } else {
        isOpen = false;
      }
    } else if (conditioning.has(node)) {
      isOpen = false;
    }
  }
  return { isOpen, openedBy };
}

function firstConditionedDescendant(dag: Dag, node: string, conditioning: Set<string>): string | null {
  return conditionedDescendants(dag, node, conditioning)[0] ?? null;
}

function conditionedDescendants(dag: Dag, node: string, conditioning: Set<string>): string[] {
  return [...conditioning].filter((member) => dag.descendants(node).has(member)).sort();
}

export function evaluatePath(dag: Dag, nodes: string[], conditioning: Set<string>): PathEvaluation {
  const blockedBy: string[] = [];
  const openedBy: string[] = [];
  const steps: PathEvaluationStep[] = [];

  for (let index = 1; index < nodes.length - 1; index += 1) {
    const node = nodes[index];
    const witnesses = conditionedDescendants(dag, node, conditioning);
    if (isColliderAt(dag, nodes[index - 1], node, nodes[index + 1])) {
      if (conditioning.has(node) || witnesses.length) {
        const witness = conditioning.has(node) ? node : witnesses[0];
        openedBy.push(witness);
        steps.push({
          nodeId: node,
          kind: "collider",
          conditionedOnNode: conditioning.has(node),
          conditionedOnDescendant: witnesses.length > 0,
          descendantWitnesses: witnesses,
          effect: "opens_path",
          explanation: `${node} is a collider and is activated by conditioning on ${witness}.`,
        });
      } else {
        blockedBy.push(node);
        steps.push({
          nodeId: node,
          kind: "collider",
          conditionedOnNode: false,
          conditionedOnDescendant: false,
          descendantWitnesses: [],
          effect: "blocks_path",
          explanation: `${node} is a collider and remains unconditioned, so it blocks the path.`,
        });
      }
    } else if (conditioning.has(node)) {
      blockedBy.push(node);
      steps.push({
        nodeId: node,
        kind: "non_collider",
        conditionedOnNode: true,
        conditionedOnDescendant: false,
        descendantWitnesses: [],
        effect: "blocks_path",
        explanation: `${node} is a non-collider in the conditioning set, so it blocks the path.`,
      });
    } else {
      steps.push({
        nodeId: node,
        kind: "non_collider",
        conditionedOnNode: false,
        conditionedOnDescendant: false,
        descendantWitnesses: [],
        effect: "keeps_path_open",
        explanation: `${node} is a non-collider and is not conditioned on, so the path stays open here.`,
      });
    }
  }

  const isOpen = blockedBy.length === 0;
  const stepText = steps.map((step) => step.explanation).join(" ");
  let reason: string;
  if (isOpen) {
    reason = stepText || "No internal nodes block this path.";
  } else {
    const opened = openedBy.length
      ? ` Conditioning also activates collider structure via ${openedBy.join(", ")}, but the path remains blocked overall.`
      : "";
    reason = `${stepText} The path is blocked by ${blockedBy.join(", ")}.${opened}`.trim();
  }

  return {
    conditioningSet: sortedSet(conditioning),
    status: isOpen ? "open" : "blocked",
    isOpen,
    reason,
    blockedBy,
    openedBy,
    steps,
  };
}

function explainPath(path: RawPath, defaultEvaluation: PathEvaluation): string {
  let base: string;
  if (path.category === "directed_causal") {
    base = `${path.pathString} is a directed causal path from treatment to outcome. It represents part of the causal effect rather than a backdoor path.`;
  } else if (path.category === "backdoor") {
    base = `${path.pathString} is a backdoor path because it starts with an arrow into the treatment. By default it is ${defaultEvaluation.status}.`;
  } else {
    base = `${path.pathString} is a noncausal path connecting treatment and outcome. By default it is ${defaultEvaluation.status}.`;
  }
  return path.colliders.length ? `${base} It involves collider structure at ${path.colliders.join(", ")}.` : base;
}

export function materializePaths(dag: Dag, paths: RawPath[], conditioningSets: string[][]): PathAnalysisItem[] {
  return paths.map((path, index) => {
    const defaultEvaluation = evaluatePath(dag, path.nodes, new Set());
    return {
      id: `path-${index + 1}`,
      nodes: path.nodes,
      pathString: path.pathString,
      category: path.category,
      involvesCollider: path.colliders.length > 0,
      colliders: path.colliders,
      defaultEvaluation,
      adjustmentEvaluations: conditioningSets.map((set) => evaluatePath(dag, path.nodes, new Set(set))),
      explanation: explainPath(path, defaultEvaluation),
    };
  });
}
