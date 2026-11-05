import type {
  AdjustmentSetSummary,
  CautionVariable,
  ForbiddenVariable,
  NodeRoleSummary,
} from "@causal-graph-workbench/shared";

import { Dag, isDSeparated, sortedSet } from "./graph";
import { pathStatus, type RawPath } from "./paths";
import { findMediators } from "./roles";

export const MAX_MINIMAL_SETS = 256;
export const MAX_VALID_SETS = 128;

export interface AdjustmentProblem {
  dag: Dag;
  /** The DAG with arrows out of treatment removed; backdoor validity is d-separation here. */
  backdoor: Dag;
  treatment: string;
  outcome: string;
  /** Observed variables that are not descendants of treatment. */
  allowed: Set<string>;
}

export interface SetListing {
  sets: string[][];
  truncated: boolean;
}

export function createAdjustmentProblem(dag: Dag, treatment: string, outcome: string): AdjustmentProblem {
  const descendants = dag.descendants(treatment);
  return {
    dag,
    backdoor: dag.withoutOutgoingEdges(treatment),
    treatment,
    outcome,
    allowed: new Set(
      dag.nodes.filter(
        (node) => node !== treatment && node !== outcome && !descendants.has(node) && dag.isObserved(node),
      ),
    ),
  };
}

export function isValidAdjustmentSet(problem: AdjustmentProblem, candidate: Iterable<string>): boolean {
  const set = [...candidate];
  if (set.some((node) => !problem.allowed.has(node))) {
    return false;
  }
  return isDSeparated(problem.backdoor, [problem.treatment], [problem.outcome], set);
}

/**
 * Whether a valid set exists with include ⊆ Z ⊆ allowed. If any separator exists in that range then
 * the ancestors of {treatment, outcome} ∪ include, restricted to the range, also separate
 * (van der Zander, Liśkiewicz & Textor, 2019), so one d-separation test decides the question.
 */
export function existsValidSet(
  problem: AdjustmentProblem,
  include: Iterable<string> = [],
  allowed: Set<string> = problem.allowed,
): boolean {
  const required = [...include];
  if (required.some((node) => !allowed.has(node))) {
    return false;
  }
  const closure = problem.backdoor.ancestorClosure([problem.treatment, problem.outcome, ...required]);
  const candidate = [...closure].filter((node) => allowed.has(node));
  return isDSeparated(problem.backdoor, [problem.treatment], [problem.outcome], candidate);
}

/** Lists every minimal valid adjustment set. */
export function listMinimalSets(problem: AdjustmentProblem, limit: number = MAX_MINIMAL_SETS): SetListing {
  return listMinimalSeparators(problem.backdoor, problem.treatment, problem.outcome, problem.allowed, limit);
}

/**
 * Lists every minimal set within `allowed` that d-separates two variables, with polynomial delay per
 * set (Takata, 2010).
 *
 * A minimal d-separator contains only ancestors of the endpoints, so this works on the moral graph of
 * those ancestors, where a minimal separator is exactly the neighbourhood of the first variable's
 * component. The search branches on whether each boundary node joins that component.
 */
export function listMinimalSeparators(dag: Dag, first: string, second: string, allowed: Set<string>, limit: number): SetListing {
  const graph = moralAncestralGraph(dag, [first, second]);
  const neighborsOf = (node: string) => graph.get(node) ?? new Set<string>();
  const sets: string[][] = [];
  let truncated = false;

  const boundary = (side: Set<string>): Set<string> => {
    const result = new Set<string>();
    for (const member of side) {
      for (const neighbor of neighborsOf(member)) {
        if (!side.has(neighbor)) {
          result.add(neighbor);
        }
      }
    }
    return result;
  };

  const secondComponent = (blocked: Set<string>): Set<string> => {
    const seen = new Set<string>();
    const stack = [second];
    while (stack.length) {
      const current = stack.pop()!;
      if (seen.has(current) || blocked.has(current)) {
        continue;
      }
      seen.add(current);
      stack.push(...neighborsOf(current));
    }
    return seen;
  };

  // Grows `side` with every node that cannot be in any compatible separator; null when none exists.
  const close = (start: Set<string>, excluded: Set<string>): Set<string> | null => {
    const side = new Set(start);
    for (;;) {
      const around = boundary(side);
      let forced = [...around].filter((node) => !allowed.has(node));
      if (!forced.length) {
        const reachable = secondComponent(new Set([...side, ...around]));
        forced = [...around].filter((node) => ![...neighborsOf(node)].some((neighbor) => reachable.has(neighbor)));
      }
      if (!forced.length) {
        return side;
      }
      for (const node of forced) {
        if (node === second || excluded.has(node)) {
          return null;
        }
        side.add(node);
      }
    }
  };

  const visit = (start: Set<string>, excluded: Set<string>): void => {
    if (truncated) {
      return;
    }
    const side = close(start, excluded);
    if (!side) {
      return;
    }
    const around = [...boundary(side)].sort();
    const branch = around.find((node) => !excluded.has(node));
    if (branch === undefined) {
      if (sets.length >= limit) {
        truncated = true;
        return;
      }
      sets.push(around);
      return;
    }
    visit(new Set([...side, branch]), excluded);
    visit(side, new Set([...excluded, branch]));
  };

  visit(new Set([first]), new Set());
  return { sets: sortSets(sets), truncated };
}

/** Lists valid sets with polynomial delay by branching on each variable and pruning dead branches. */
export function listValidSets(problem: AdjustmentProblem, limit: number = MAX_VALID_SETS): SetListing {
  const sets: string[][] = [];
  let truncated = false;

  const visit = (included: string[], undecided: string[], allowed: Set<string>): void => {
    if (truncated || !existsValidSet(problem, included, allowed)) {
      return;
    }
    if (!undecided.length) {
      if (sets.length >= limit) {
        truncated = true;
        return;
      }
      sets.push(sortedSet(included));
      return;
    }
    const [next, ...rest] = undecided;
    const withoutNext = new Set(allowed);
    withoutNext.delete(next);
    visit(included, rest, withoutNext);
    visit([...included, next], rest, allowed);
  };

  visit([], sortedSet(problem.allowed), problem.allowed);
  return { sets: sortSets(sets), truncated };
}

function moralAncestralGraph(dag: Dag, roots: string[]): Map<string, Set<string>> {
  const members = dag.ancestorClosure(roots);
  const graph = new Map<string, Set<string>>([...members].map((node) => [node, new Set<string>()]));
  const connect = (a: string, b: string) => {
    graph.get(a)!.add(b);
    graph.get(b)!.add(a);
  };
  for (const node of members) {
    const parents = [...dag.parents(node)];
    parents.forEach((parent, index) => {
      connect(parent, node);
      for (const other of parents.slice(index + 1)) {
        connect(parent, other);
      }
    });
  }
  return graph;
}

function sortSets(sets: string[][]): string[][] {
  return sets.sort((a, b) => a.length - b.length || a.join("\u0000").localeCompare(b.join("\u0000")));
}

function rolesLookup(roles: NodeRoleSummary[]): Map<string, Set<string>> {
  return new Map(roles.map((item) => [item.nodeId, new Set<string>(item.roles)]));
}

/**
 * Chooses among minimal sets, which are all valid: smallest first, then fewest colliders, then fewest
 * non-confounders. Returns null only when no valid set exists, so an empty array always means that
 * the empty set is itself valid.
 */
export function chooseRecommendedSet(minimalSets: string[][], roles: NodeRoleSummary[]): string[] | null {
  if (!minimalSets.length) {
    return null;
  }
  const lookup = rolesLookup(roles);
  const score = (set: string[]): [number, number, number, string] => [
    set.length,
    set.filter((node) => lookup.get(node)?.has("collider")).length,
    set.filter((node) => !lookup.get(node)?.has("confounder")).length,
    set.join("\u0000"),
  ];
  return [...minimalSets].sort((left, right) => {
    const [a, b] = [score(left), score(right)];
    return a[0] - b[0] || a[1] - b[1] || a[2] - b[2] || a[3].localeCompare(b[3]);
  })[0];
}

/** Variables that belong in no valid set: anything downstream of treatment, or that opens an unclosable path. */
export function findForbiddenVariables(problem: AdjustmentProblem, roles: NodeRoleSummary[]): ForbiddenVariable[] {
  const { dag, treatment, outcome } = problem;
  const mediators = findMediators(dag, treatment, outcome);
  const descendants = dag.descendants(treatment);
  const anyValidSet = existsValidSet(problem);
  const forbidden: ForbiddenVariable[] = [];

  for (const { nodeId, roles: nodeRoles } of roles) {
    const reasons: string[] = [];
    if (mediators.has(nodeId)) {
      reasons.push("Acts as a mediator on a directed treatment-to-outcome path.");
    }
    if (descendants.has(nodeId)) {
      reasons.push("Is downstream of treatment and should not be used for total-effect adjustment.");
      if (nodeRoles.includes("collider")) {
        reasons.push("Also acts as a collider on at least one treatment-outcome path.");
      }
    } else if (anyValidSet && dag.isObserved(nodeId) && !existsValidSet(problem, [nodeId])) {
      reasons.push(
        "No valid adjustment set can include it: conditioning on it opens a path that the observed variables cannot close.",
      );
    }
    if (reasons.length) {
      forbidden.push({ nodeId, reasons });
    }
  }
  return forbidden;
}

/** Colliders that can still be adjusted for, as long as the path they open is closed by another variable. */
export function findCautionVariables(
  problem: AdjustmentProblem,
  roles: NodeRoleSummary[],
  forbidden: ForbiddenVariable[],
): CautionVariable[] {
  if (!existsValidSet(problem)) {
    return [];
  }
  const excluded = new Set(forbidden.map((item) => item.nodeId));
  const cautions: CautionVariable[] = [];
  for (const { nodeId, roles: nodeRoles } of roles) {
    if (excluded.has(nodeId) || !problem.allowed.has(nodeId) || !nodeRoles.includes("collider")) {
      continue;
    }
    const withoutNode = new Set(problem.allowed);
    withoutNode.delete(nodeId);
    const required = !existsValidSet(problem, [], withoutNode);
    const aloneIsEnough = isValidAdjustmentSet(problem, [nodeId]);
    const reasons = [
      required
        ? `Every valid adjustment set must include ${nodeId}, because it also carries confounding.`
        : `${nodeId} is not needed for validity unless another set you prefer depends on it.`,
    ];
    if (!aloneIsEnough) {
      reasons.push(
        `${nodeId} is a collider on at least one path, so adjusting for it opens that path. Use it only together with variables that close it again.`,
      );
    }
    cautions.push({ nodeId, reasons, required });
  }
  return cautions;
}

export function summarizeAdjustmentSets(
  problem: AdjustmentProblem,
  paths: RawPath[],
  validSets: string[][],
  minimalSets: string[][],
  recommended: string[] | null,
  roles: NodeRoleSummary[],
  pathsTruncated: boolean,
): AdjustmentSetSummary[] {
  const { dag } = problem;
  const keyOf = (set: string[]) => set.join("\u0000");
  const minimalKeys = new Set(minimalSets.map(keyOf));
  const recommendedKey = recommended ? keyOf(recommended) : null;
  const lookup = rolesLookup(roles);
  const backdoorCount = paths.filter((path) => path.category === "backdoor").length;

  return sortSets([...validSets]).map((variables, index) => {
    const conditioning = new Set(variables);
    const blockedPathIds: string[] = [];
    const openedPathIds: string[] = [];
    const concerns: string[] = [];

    paths.forEach((path, pathIndex) => {
      const id = `path-${pathIndex + 1}`;
      const { isOpen, openedBy } = pathStatus(dag, path.nodes, conditioning);
      if (path.category === "backdoor" && !isOpen) {
        blockedPathIds.push(id);
      }
      if (openedBy.length) {
        openedPathIds.push(id);
        concerns.push(`${id} contains collider structure activated by conditioning on ${openedBy.join(", ")}.`);
      }
    });

    const isMinimal = minimalKeys.has(keyOf(variables));
    const isRecommended = keyOf(variables) === recommendedKey;
    const instrumentMembers = variables.filter((node) => lookup.get(node)?.has("instrument_like"));

    if (!isMinimal) {
      concerns.unshift("A smaller valid set exists, so this set includes variables that are not needed to block backdoor paths.");
    }
    for (const node of instrumentMembers) {
      concerns.push(
        `${node} affects the outcome only through treatment. Adjusting for it can reduce precision and amplify any remaining bias.`,
      );
    }

    const needlessRisk = !isMinimal && (instrumentMembers.length > 0 || openedPathIds.length > 0);
    return {
      id: `adj-${index + 1}`,
      variables,
      isValid: true,
      isMinimal,
      isRecommended,
      practicalRating: isRecommended ? "recommended" : needlessRisk ? "avoid" : "acceptable",
      explanation: explainSet(variables, blockedPathIds.length, backdoorCount, isMinimal, concerns, pathsTruncated),
      blockedPathIds,
      openedPathIds,
      practicalConcerns: concerns,
    };
  });
}

function explainSet(
  variables: string[],
  blocked: number,
  total: number,
  isMinimal: boolean,
  concerns: string[],
  pathsTruncated: boolean,
): string {
  const base = variables.length
    ? `Adjusting for {${variables.join(", ")}} blocks ${
        pathsTruncated ? "every backdoor path" : `${blocked} of ${total} backdoor paths`
      } under the backdoor criterion.`
    : "No open backdoor paths remain after using the empty adjustment set.";
  const minimal = isMinimal ? " It is minimal." : " It is structurally valid but not minimal.";
  const practical = concerns.length ? ` Practical concerns: ${concerns.join(" ")}` : "";
  return `${base}${minimal}${practical}`;
}
