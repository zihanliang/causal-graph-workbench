import type { NodeRoleSummary, RoleType } from "@causal-graph-workbench/shared";

import { Dag, isDSeparated } from "./graph";

/** Nodes on a directed treatment-to-outcome path, excluding both endpoints. */
export function findMediators(dag: Dag, treatment: string, outcome: string): Set<string> {
  const ancestors = dag.ancestors(outcome);
  return new Set([...dag.descendants(treatment)].filter((node) => ancestors.has(node)));
}

/**
 * Whether `node` is a collider on some simple treatment-outcome path.
 *
 * Such a path exists exactly when two distinct parents of `node` reach the treatment and the outcome
 * along vertex-disjoint routes that avoid `node`. That is a unit-capacity max-flow question, so the
 * answer stays exact on graphs where listing every path would be infeasible.
 */
export function isColliderOnTreatmentOutcomePath(dag: Dag, node: string, treatment: string, outcome: string): boolean {
  const parents = [...dag.parents(node)];
  if (parents.length < 2) {
    return false;
  }

  const others = dag.nodes.filter((other) => other !== node);
  const index = new Map(others.map((other, position) => [other, position]));
  const inNode = (name: string) => 2 * index.get(name)!;
  const outNode = (name: string) => 2 * index.get(name)! + 1;
  const source = 2 * others.length;
  const sink = source + 1;

  const flow = new UnitFlow(sink + 1);
  for (const other of others) {
    flow.addEdge(inNode(other), outNode(other));
  }
  for (const [from, to] of dag.edges()) {
    if (from === node || to === node) {
      continue;
    }
    flow.addEdge(outNode(from), inNode(to));
    flow.addEdge(outNode(to), inNode(from));
  }
  // Each endpoint has unit capacity and both must drain to the sink for a flow of two,
  // so neither route can pass through an endpoint on its way to the other.
  for (const parent of parents) {
    flow.addEdge(source, inNode(parent));
  }
  flow.addEdge(outNode(treatment), sink);
  flow.addEdge(outNode(outcome), sink);
  return flow.hasFlowOfTwo(source, sink);
}

class UnitFlow {
  private readonly adjacency: number[][];
  private readonly targets: number[] = [];
  private readonly capacities: number[] = [];

  constructor(size: number) {
    this.adjacency = Array.from({ length: size }, () => []);
  }

  addEdge(from: number, to: number): void {
    this.adjacency[from].push(this.targets.length);
    this.targets.push(to);
    this.capacities.push(1);
    this.adjacency[to].push(this.targets.length);
    this.targets.push(from);
    this.capacities.push(0);
  }

  hasFlowOfTwo(source: number, sink: number): boolean {
    return this.augment(source, sink) && this.augment(source, sink);
  }

  private augment(source: number, sink: number): boolean {
    const arrivedBy = new Array<number>(this.adjacency.length).fill(-1);
    const seen = new Array<boolean>(this.adjacency.length).fill(false);
    seen[source] = true;
    const queue = [source];
    for (let head = 0; head < queue.length; head += 1) {
      const current = queue[head];
      for (const edge of this.adjacency[current]) {
        const next = this.targets[edge];
        if (!seen[next] && this.capacities[edge] > 0) {
          seen[next] = true;
          arrivedBy[next] = edge;
          queue.push(next);
        }
      }
    }
    if (!seen[sink]) {
      return false;
    }
    for (let current = sink; current !== source; ) {
      const edge = arrivedBy[current];
      this.capacities[edge] -= 1;
      this.capacities[edge ^ 1] += 1;
      current = this.targets[edge ^ 1];
    }
    return true;
  }
}

export function summarizeNodeRoles(dag: Dag, treatment: string, outcome: string): NodeRoleSummary[] {
  const ancestorsOfTreatment = dag.ancestors(treatment);
  const ancestorsOfOutcome = dag.ancestors(outcome);
  const descendantsOfTreatment = dag.descendants(treatment);
  const mediators = findMediators(dag, treatment, outcome);
  const withoutTreatment = dag.withoutNode(treatment);
  const ancestorsOfOutcomeAvoidingTreatment = withoutTreatment.ancestors(outcome);

  return [...dag.nodes]
    .sort()
    .filter((node) => node !== treatment && node !== outcome)
    .map((node) => {
      const roles: RoleType[] = [];
      const evidence: string[] = [];

      if (!dag.isObserved(node)) {
        evidence.push(`${node} is marked unobserved, so it cannot be adjusted for directly.`);
      }
      if (ancestorsOfTreatment.has(node)) {
        roles.push("ancestor_of_treatment");
        evidence.push(`${node} is an ancestor of ${treatment}.`);
      }
      if (ancestorsOfOutcome.has(node)) {
        roles.push("ancestor_of_outcome");
        evidence.push(`${node} is an ancestor of ${outcome}.`);
      }
      if (descendantsOfTreatment.has(node)) {
        roles.push("descendant_of_treatment");
        evidence.push(`${node} is a descendant of ${treatment}.`);
      }
      if (mediators.has(node)) {
        roles.push("mediator");
        evidence.push(`${node} lies on at least one directed path from ${treatment} to ${outcome}.`);
      }
      if (isColliderOnTreatmentOutcomePath(dag, node, treatment, outcome)) {
        roles.push("collider");
        evidence.push(`${node} acts as a collider on at least one treatment-outcome path.`);
      }
      if (ancestorsOfTreatment.has(node) && ancestorsOfOutcomeAvoidingTreatment.has(node)) {
        roles.push("confounder");
        evidence.push(
          `${node} causes ${treatment} and also reaches ${outcome} along a directed path that avoids ${treatment}.`,
        );
      }
      if (ancestorsOfTreatment.has(node) && isDSeparated(withoutTreatment, [node], [outcome], [])) {
        roles.push("instrument_like");
        evidence.push(`Once ${treatment} is removed from the graph, nothing connects ${node} to ${outcome}.`);
      }
      if (!roles.length) {
        evidence.push(`${node} does not play a highlighted role relative to (${treatment}, ${outcome}).`);
      }

      return { nodeId: node, roles, summary: roleSummary(node, roles), evidence };
    });
}

function roleSummary(node: string, roles: RoleType[]): string {
  if (roles.includes("confounder") && roles.includes("collider")) {
    return `${node} is a confounder on one path and a collider on another, so it usually needs a companion variable.`;
  }
  if (roles.includes("confounder")) {
    return `${node} behaves like a confounder relative to the selected treatment and outcome.`;
  }
  if (roles.includes("mediator")) {
    return `${node} sits on a directed treatment-to-outcome path and acts as a mediator.`;
  }
  if (roles.includes("instrument_like")) {
    return `${node} affects the outcome only through treatment, so adjusting for it does not reduce confounding.`;
  }
  if (roles.includes("collider")) {
    return `${node} is a collider on at least one relevant path and should be handled carefully.`;
  }
  if (roles.includes("descendant_of_treatment")) {
    return `${node} is downstream of treatment and is generally not recommended for total-effect adjustment.`;
  }
  if (roles.includes("ancestor_of_treatment") || roles.includes("ancestor_of_outcome")) {
    return `${node} is structurally upstream of the selected treatment/outcome pair.`;
  }
  return `${node} has no highlighted role in the current analysis.`;
}
