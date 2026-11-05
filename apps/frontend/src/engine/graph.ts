import type { GraphSpec } from "@causal-graph-workbench/shared";

/** Immutable directed graph. Reachability results are cached per instance. */
export class Dag {
  readonly nodes: string[];
  private readonly parentsOf = new Map<string, Set<string>>();
  private readonly childrenOf = new Map<string, Set<string>>();
  private readonly unobserved: Set<string>;
  private readonly descendantCache = new Map<string, Set<string>>();
  private readonly ancestorCache = new Map<string, Set<string>>();

  constructor(nodes: Iterable<string>, edges: Iterable<readonly [string, string]>, unobserved: Iterable<string> = []) {
    this.nodes = Array.from(new Set(nodes));
    this.unobserved = new Set(unobserved);
    for (const node of this.nodes) {
      this.parentsOf.set(node, new Set());
      this.childrenOf.set(node, new Set());
    }
    for (const [source, target] of edges) {
      if (!this.parentsOf.has(source) || !this.parentsOf.has(target)) {
        continue;
      }
      this.childrenOf.get(source)!.add(target);
      this.parentsOf.get(target)!.add(source);
    }
  }

  /** `alsoUnmeasured` adds variables that are measured in principle but have no column in the file. */
  static fromSpec(graph: GraphSpec, alsoUnmeasured: Iterable<string> = []): Dag {
    return new Dag(
      graph.nodes.map((node) => node.id),
      graph.edges.map((edge) => [edge.source, edge.target] as const),
      [...graph.nodes.filter((node) => node.observed === false).map((node) => node.id), ...alsoUnmeasured],
    );
  }

  has(node: string): boolean {
    return this.parentsOf.has(node);
  }

  isObserved(node: string): boolean {
    return !this.unobserved.has(node);
  }

  parents(node: string): Set<string> {
    return this.parentsOf.get(node) ?? new Set();
  }

  children(node: string): Set<string> {
    return this.childrenOf.get(node) ?? new Set();
  }

  hasEdge(source: string, target: string): boolean {
    return this.children(source).has(target);
  }

  /** Neighbours ignoring edge direction. */
  neighbors(node: string): Set<string> {
    return new Set([...this.parents(node), ...this.children(node)]);
  }

  edges(): [string, string][] {
    const result: [string, string][] = [];
    for (const source of this.nodes) {
      for (const target of this.children(source)) {
        result.push([source, target]);
      }
    }
    return result;
  }

  /** Strict descendants: the node itself is excluded unless it lies on a cycle. */
  descendants(node: string): Set<string> {
    let cached = this.descendantCache.get(node);
    if (!cached) {
      cached = reach(node, (current) => this.children(current));
      this.descendantCache.set(node, cached);
    }
    return cached;
  }

  /** Strict ancestors: the node itself is excluded unless it lies on a cycle. */
  ancestors(node: string): Set<string> {
    let cached = this.ancestorCache.get(node);
    if (!cached) {
      cached = reach(node, (current) => this.parents(current));
      this.ancestorCache.set(node, cached);
    }
    return cached;
  }

  /** Every node in `roots` together with all of their ancestors. */
  ancestorClosure(roots: Iterable<string>): Set<string> {
    const closure = new Set<string>();
    const stack = [...roots];
    while (stack.length) {
      const current = stack.pop()!;
      if (closure.has(current) || !this.has(current)) {
        continue;
      }
      closure.add(current);
      stack.push(...this.parents(current));
    }
    return closure;
  }

  isAcyclic(): boolean {
    return this.topologicalOrder() !== null;
  }

  /** Kahn's algorithm. Returns null when the graph has a cycle. */
  topologicalOrder(): string[] | null {
    const remaining = new Map(this.nodes.map((node) => [node, this.parents(node).size]));
    const ready = this.nodes.filter((node) => remaining.get(node) === 0);
    const order: string[] = [];
    while (ready.length) {
      const current = ready.pop()!;
      order.push(current);
      for (const child of this.children(current)) {
        const count = remaining.get(child)! - 1;
        remaining.set(child, count);
        if (count === 0) {
          ready.push(child);
        }
      }
    }
    return order.length === this.nodes.length ? order : null;
  }

  withoutOutgoingEdges(node: string): Dag {
    return new Dag(
      this.nodes,
      this.edges().filter(([source]) => source !== node),
      this.unobserved,
    );
  }

  withoutNode(node: string): Dag {
    return new Dag(
      this.nodes.filter((other) => other !== node),
      this.edges().filter(([source, target]) => source !== node && target !== node),
      this.unobserved,
    );
  }
}

function reach(start: string, next: (node: string) => Iterable<string>): Set<string> {
  const seen = new Set<string>();
  const stack = [...next(start)];
  while (stack.length) {
    const current = stack.pop()!;
    if (seen.has(current)) {
      continue;
    }
    seen.add(current);
    stack.push(...next(current));
  }
  return seen;
}

/**
 * d-separation by the reachable-trail algorithm (Koller & Friedman, Alg. 3.1), which runs in
 * linear time, so validity checks stay fast regardless of how many paths the graph contains.
 */
export function isDSeparated(dag: Dag, left: Iterable<string>, right: Iterable<string>, given: Iterable<string>): boolean {
  const conditioned = new Set(given);
  const targets = new Set(right);
  const activatesColliders = dag.ancestorClosure(conditioned);

  const visited = new Set<string>();
  const stack: [string, "up" | "down"][] = [];
  for (const node of left) {
    stack.push([node, "up"]);
  }

  while (stack.length) {
    const [node, direction] = stack.pop()!;
    const key = `${direction}|${node}`;
    if (visited.has(key)) {
      continue;
    }
    visited.add(key);

    if (!conditioned.has(node) && targets.has(node)) {
      return false;
    }

    if (direction === "up") {
      if (!conditioned.has(node)) {
        for (const parent of dag.parents(node)) {
          stack.push([parent, "up"]);
        }
        for (const child of dag.children(node)) {
          stack.push([child, "down"]);
        }
      }
    } else {
      if (!conditioned.has(node)) {
        for (const child of dag.children(node)) {
          stack.push([child, "down"]);
        }
      }
      if (activatesColliders.has(node)) {
        for (const parent of dag.parents(node)) {
          stack.push([parent, "up"]);
        }
      }
    }
  }
  return true;
}

export function sortedSet(values: Iterable<string>): string[] {
  return Array.from(new Set(values)).sort();
}
