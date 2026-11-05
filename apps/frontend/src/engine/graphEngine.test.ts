import { describe, expect, test } from "vitest";

import {
  chooseRecommendedSet,
  createAdjustmentProblem,
  existsValidSet,
  findForbiddenVariables,
  listMinimalSets,
  listValidSets,
} from "./adjustment";
import golden from "./__fixtures__/golden.json";
import { Dag, isDSeparated } from "./graph";
import { countDirectedPaths, enumeratePaths, pathStatus } from "./paths";
import { summarizeNodeRoles } from "./roles";

interface GraphCase {
  nodes: string[];
  edges: [string, string][];
  treatment: string;
  outcome: string;
  unobserved: string[];
  minimalSets: string[][];
  validSets?: string[][];
  containable: string[];
  required: string[];
  hasValidSet: boolean;
  pathCount: number;
  directedPathCount: number;
  openBackdoorPathCount: number;
  roles: Record<string, string[]>;
}

const graphCases = golden.graphCases as unknown as GraphCase[];

function normalize(sets: string[][]): string[] {
  return sets.map((set) => [...set].sort().join(",")).sort();
}

describe("graph engine against networkx brute force", () => {
  test("d-separation agrees on every query", () => {
    let checked = 0;
    for (const item of golden.dSeparationCases) {
      const dag = new Dag(item.nodes, item.edges as [string, string][]);
      for (const query of item.queries) {
        expect(isDSeparated(dag, [query.left], [query.right], query.given), JSON.stringify({ edges: item.edges, query })).toBe(
          query.separated,
        );
        checked += 1;
      }
    }
    expect(checked).toBe(1000);
  });

  test.each(graphCases.map((item, index) => [index, item] as const))("case %i: minimal sets", (_, item) => {
    const problem = createAdjustmentProblem(new Dag(item.nodes, item.edges, item.unobserved), item.treatment, item.outcome);
    const listing = listMinimalSets(problem);
    expect(listing.truncated).toBe(false);
    expect(normalize(listing.sets), JSON.stringify(item.edges)).toEqual(normalize(item.minimalSets));
  });

  test("lists exactly the valid sets", () => {
    let compared = 0;
    for (const item of graphCases) {
      if (!item.validSets) {
        continue;
      }
      const problem = createAdjustmentProblem(new Dag(item.nodes, item.edges, item.unobserved), item.treatment, item.outcome);
      const listing = listValidSets(problem, 100_000);
      expect(normalize(listing.sets), JSON.stringify(item.edges)).toEqual(normalize(item.validSets));
      compared += 1;
    }
    expect(compared).toBe(160);
  });

  test("existence checks match which variables can appear in, and are needed by, a valid set", () => {
    for (const item of graphCases) {
      const problem = createAdjustmentProblem(new Dag(item.nodes, item.edges, item.unobserved), item.treatment, item.outcome);
      expect(existsValidSet(problem)).toBe(item.hasValidSet);
      const containable = [...problem.allowed].filter((node) => existsValidSet(problem, [node])).sort();
      expect(containable, JSON.stringify(item.edges)).toEqual(item.containable);
      const required = [...problem.allowed]
        .filter((node) => {
          const without = new Set(problem.allowed);
          without.delete(node);
          return item.hasValidSet && !existsValidSet(problem, [], without);
        })
        .sort();
      expect(required, JSON.stringify(item.edges)).toEqual(item.required);
    }
  });

  test("node roles agree, including the exact collider check", () => {
    for (const item of graphCases) {
      const dag = new Dag(item.nodes, item.edges, item.unobserved);
      const roles = Object.fromEntries(
        summarizeNodeRoles(dag, item.treatment, item.outcome).map((role) => [role.nodeId, [...role.roles].sort()]),
      );
      expect(roles, JSON.stringify({ edges: item.edges, t: item.treatment, y: item.outcome })).toEqual(item.roles);
    }
  });

  test("path enumeration agrees on counts and categories", () => {
    for (const item of graphCases) {
      const dag = new Dag(item.nodes, item.edges, item.unobserved);
      const { paths, truncated } = enumeratePaths(dag, item.treatment, item.outcome, 1_000_000);
      expect(truncated).toBe(false);
      expect(paths.length).toBe(item.pathCount);
      expect(new Set(paths.map((path) => path.nodes.join(">"))).size).toBe(item.pathCount);
      expect(paths.filter((path) => path.category === "directed_causal").length).toBe(item.directedPathCount);
      expect(countDirectedPaths(dag, item.treatment, item.outcome)).toBe(item.directedPathCount);
      const open = paths.filter((path) => path.category === "backdoor" && pathStatus(dag, path.nodes, new Set()).isOpen);
      expect(open.length).toBe(item.openBackdoorPathCount);
    }
  });

  test("path-level reasoning and graph-level d-separation always reach the same verdict", () => {
    for (const item of graphCases) {
      if (!item.validSets) {
        continue;
      }
      const dag = new Dag(item.nodes, item.edges, item.unobserved);
      const { paths } = enumeratePaths(dag, item.treatment, item.outcome, 1_000_000);
      const backdoorPaths = paths.filter((path) => path.category === "backdoor");
      const problem = createAdjustmentProblem(dag, item.treatment, item.outcome);
      const candidates = [...problem.allowed].sort();
      const validKeys = new Set(normalize(item.validSets));
      for (let mask = 0; mask < 2 ** candidates.length; mask += 1) {
        const set = candidates.filter((_, bit) => mask & (1 << bit));
        const blocksAll = backdoorPaths.every((path) => !pathStatus(dag, path.nodes, new Set(set)).isOpen);
        expect(blocksAll, JSON.stringify({ edges: item.edges, set })).toBe(validKeys.has(set.join(",")));
      }
    }
  });

  test("forbidden variables are exactly those outside every valid set", () => {
    for (const item of graphCases) {
      if (!item.hasValidSet) {
        continue;
      }
      const dag = new Dag(item.nodes, item.edges, item.unobserved);
      const problem = createAdjustmentProblem(dag, item.treatment, item.outcome);
      const roles = summarizeNodeRoles(dag, item.treatment, item.outcome);
      const forbidden = new Set(findForbiddenVariables(problem, roles).map((entry) => entry.nodeId));
      for (const node of problem.allowed) {
        expect(forbidden.has(node), `${node} in ${JSON.stringify(item.edges)}`).toBe(!item.containable.includes(node));
      }
      for (const node of dag.descendants(item.treatment)) {
        if (node !== item.outcome) {
          expect(forbidden.has(node)).toBe(true);
        }
      }
    }
  });

  test("a recommendation exists whenever a valid set exists, and it is always valid", () => {
    for (const item of graphCases) {
      const dag = new Dag(item.nodes, item.edges, item.unobserved);
      const roles = summarizeNodeRoles(dag, item.treatment, item.outcome);
      const recommended = chooseRecommendedSet(item.minimalSets, roles);
      if (item.hasValidSet) {
        expect(recommended).not.toBeNull();
        expect(normalize(item.minimalSets)).toContain([...recommended!].sort().join(","));
      } else {
        expect(recommended).toBeNull();
      }
    }
  });
});

describe("scale", () => {
  function randomDag(size: number, probability: number, seed: number) {
    let state = seed;
    const random = () => {
      state = (state * 1664525 + 1013904223) % 4294967296;
      return state / 4294967296;
    };
    const nodes = Array.from({ length: size }, (_, index) => `V${index}`);
    const edges: [string, string][] = [];
    for (let left = 0; left < size; left += 1) {
      for (let right = left + 1; right < size; right += 1) {
        if (random() < probability) {
          edges.push([nodes[left], nodes[right]]);
        }
      }
    }
    return { nodes, edges };
  }

  test.each([
    [20, 0.25],
    [40, 0.15],
    [80, 0.08],
  ])("%i nodes stays interactive and never blocks on path counts", (size, probability) => {
    const { nodes, edges } = randomDag(size, probability, size);
    const dag = new Dag(nodes, edges);
    const treatment = nodes[Math.floor(size / 2)];
    const outcome = nodes[size - 1];
    const started = performance.now();
    const problem = createAdjustmentProblem(dag, treatment, outcome);
    const minimal = listMinimalSets(problem, 32);
    const valid = listValidSets(problem, 32);
    const { paths } = enumeratePaths(dag, treatment, outcome);
    const roles = summarizeNodeRoles(dag, treatment, outcome);
    const forbidden = findForbiddenVariables(problem, roles);
    const elapsed = performance.now() - started;

    expect(minimal.sets.length).toBeGreaterThan(0);
    expect(valid.sets.length).toBeGreaterThan(0);
    expect(paths.length).toBeLessThanOrEqual(300);
    expect(forbidden.length).toBeGreaterThanOrEqual(0);
    expect(elapsed).toBeLessThan(5000);
  });
});
