import type {
  AnalysisRequest,
  ComparisonAnswer,
  EffectEstimate,
  GraphComparison,
  GraphSpec,
  GraphVersion,
  GraphVersionResult,
  SharedAdjustmentSet,
} from "@causal-graph-workbench/shared";

import { createAdjustmentProblem, isValidAdjustmentSet, listMinimalSets, type AdjustmentProblem } from "./adjustment";
import { cachedFit, impliedIndependencies, runTest, SLICE_MS, TEST_BUDGET_MS, toIndependenceTests, type RawTest, type TestSpec } from "./audit";
import { profileDataset } from "./data/diagnostics";
import { toEffectEstimate, type EffectContext } from "./effect";
import { Dag, isDSeparated, sortedSet } from "./graph";
import { summarizeNodeRoles } from "./roles";
import { chooseSets, effectSetup, unmatchedVariables } from "./setup";
import { validateGraph } from "./validation";

/** Each graph's sets go into the search for a shared one, and a graph can have very many. */
const MINIMAL_SETS_PER_GRAPH = 16;
/** With this few candidates every subset can be tried, so a shared set is not missed. */
const MAX_VARIABLES_TRIED_EXHAUSTIVELY = 12;
const SHARED_SET_BUDGET_MS = 300;
const MAX_CHANGES_NAMED = 4;

export interface Prepared {
  result: GraphVersionResult;
  /** Null when the graph cannot be analysed. */
  problem: AdjustmentProblem | null;
  dag: Dag | null;
  minimalSets: string[][];
  baseline: string[] | null;
  effectContext: EffectContext | null;
  rowCount: number;
  /** What this graph claims about the variables with a column, tested against the data. */
  testSpecs: TestSpec[];
  /** What it claims about every measured variable, used to say which graphs the checks cannot separate. */
  claims: TestSpec[];
}

/** How a graph differs from the first one, in plain words. */
export function describeChange(first: GraphSpec, graph: GraphSpec): string {
  const key = (source: string, target: string) => `${source}\u0000${target}`;
  const firstArrows = new Set(first.edges.map((edge) => key(edge.source, edge.target)));
  const arrows = new Set(graph.edges.map((edge) => key(edge.source, edge.target)));
  const added = graph.edges.filter((edge) => !firstArrows.has(key(edge.source, edge.target)));
  const removed = first.edges.filter((edge) => !arrows.has(key(edge.source, edge.target)));
  const reversed = removed.filter((edge) => arrows.has(key(edge.target, edge.source)));
  const isReversal = (source: string, target: string) => reversed.some((edge) => edge.source === target && edge.target === source);

  const firstNodes = new Set(first.nodes.map((node) => node.id));
  const newUnmeasured = graph.nodes.filter((node) => !firstNodes.has(node.id) && node.observed === false).map((node) => node.id);
  const connected = new Set(graph.edges.flatMap((edge) => [edge.source, edge.target]));
  const newLoose = graph.nodes.filter((node) => !firstNodes.has(node.id) && !connected.has(node.id)).map((node) => node.id);

  const parts = [
    ...reversed.map((edge) => `${edge.source} → ${edge.target} reversed`),
    ...added.filter((edge) => !isReversal(edge.source, edge.target)).map((edge) => `+ ${edge.source} → ${edge.target}`),
    ...removed.filter((edge) => !arrows.has(key(edge.target, edge.source))).map((edge) => `− ${edge.source} → ${edge.target}`),
    ...newLoose.map((node) => `+ ${node}`),
  ];
  if (!parts.length) {
    return "Same arrows as the first graph";
  }
  const named = parts.slice(0, MAX_CHANGES_NAMED).join(", ");
  const more = parts.length > MAX_CHANGES_NAMED ? ` and ${parts.length - MAX_CHANGES_NAMED} more` : "";
  const unmeasured = newUnmeasured.length ? `; ${newUnmeasured.join(", ")} not measured` : "";
  return `${named}${more}${unmeasured}`;
}

/** Reading a file's columns is the slow part, and it depends only on which variables a graph has. */
export type ProfileCache = Map<string, ReturnType<typeof profileDataset>>;

export function prepare(version: GraphVersion, first: GraphSpec | null, request: AnalysisRequest, profiles: ProfileCache): Prepared {
  const { graph } = version;
  const dataContext = request.dataContext ?? {};
  const validation = validateGraph(graph);
  const result: GraphVersionResult = {
    id: version.id,
    name: version.name,
    changeFromFirst: first ? describeChange(first, graph) : null,
    problem: null,
    adjustmentSet: null,
    estimate: null,
    unavailableReason: null,
    checks: null,
    checksTruncated: false,
    timingConflict: validation.issues.find((issue) => issue.code === "timing_conflict")?.message ?? null,
  };
  const empty = { problem: null, dag: null, minimalSets: [], baseline: null, effectContext: null, rowCount: 0, testSpecs: [], claims: [] };

  if (!validation.canAnalyze) {
    result.problem = validation.issues.find((issue) => issue.severity === "error")?.message ?? "This graph cannot be analysed.";
    return { result, ...empty };
  }

  const profileKey = JSON.stringify([graph.treatmentId, graph.outcomeId, graph.nodes.map((node) => [node.id, node.observed !== false])]);
  const profiled = request.dataset ? (profiles.get(profileKey) ?? profileDataset(graph, request.dataset, dataContext.columnBindings ?? {})) : null;
  if (profiled) {
    profiles.set(profileKey, profiled);
  }
  const diagnostics = profiled?.diagnostics ?? null;
  const table = profiled?.table ?? null;
  const dag = Dag.fromSpec(graph, unmatchedVariables(graph, diagnostics));
  const problem = createAdjustmentProblem(dag, graph.treatmentId!, graph.outcomeId!);
  const minimal = listMinimalSets(problem);
  const { baseline } = chooseSets(graph, problem, minimal.sets, summarizeNodeRoles(dag, graph.treatmentId!, graph.outcomeId!), dataContext);
  const { boundNodes, unavailable, effectContext } = effectSetup(graph, dataContext, diagnostics, table);

  result.adjustmentSet = baseline;
  result.unavailableReason = unavailable;
  return {
    result,
    problem,
    dag,
    minimalSets: minimal.sets,
    baseline,
    effectContext,
    rowCount: table?.rowCount ?? 0,
    testSpecs: effectContext ? impliedIndependencies(dag, boundNodes).specs : [],
    claims: impliedIndependencies(dag, new Set(dag.nodes.filter((node) => dag.isObserved(node)))).specs,
  };
}

export function estimateFor(item: Prepared, variables: string[]): { estimate: EffectEstimate | null; reason: string | null } {
  if (!item.effectContext) {
    return { estimate: null, reason: null };
  }
  const outcome = cachedFit(item.effectContext, sortedSet(variables), []);
  return outcome.ok ? { estimate: toEffectEstimate(outcome.fit, item.rowCount), reason: null } : { estimate: null, reason: outcome.reason };
}

export function answersFrom(items: Prepared[]): ComparisonAnswer[] {
  const groups = new Map<string, ComparisonAnswer>();
  for (const { result } of items) {
    if (result.problem) {
      continue;
    }
    const key = result.adjustmentSet === null ? "none" : `set:${result.adjustmentSet.join("\u0000")}`;
    const group = groups.get(key);
    if (group) {
      group.graphIds.push(result.id);
      group.estimate ??= result.estimate;
    } else {
      groups.set(key, { adjustmentSet: result.adjustmentSet, estimate: result.estimate, graphIds: [result.id] });
    }
  }
  // In the order the graphs were made, so that the list does not suggest one answer outranks another.
  const answers = [...groups.values()];
  return [...answers.filter((item) => item.adjustmentSet !== null), ...answers.filter((item) => item.adjustmentSet === null)];
}

/** Every subset of these variables, smallest first. */
function subsetsBySize(variables: string[]): string[][] {
  const masks = Array.from({ length: 1 << variables.length }, (_, mask) => mask);
  const size = (mask: number) => {
    let count = 0;
    for (let rest = mask; rest; rest &= rest - 1) {
      count += 1;
    }
    return count;
  };
  return masks.sort((left, right) => size(left) - size(right) || left - right).map((mask) => variables.filter((_, index) => mask & (1 << index)));
}

/**
 * The set valid under the most graphs, if it is valid under graphs that would otherwise lead to different answers, and
 * under more of them than any set that does not.
 * With a dozen variables or fewer every subset is tried. Beyond that, sets are drawn from what the graphs themselves
 * suggest, so a shared set can exist and not be found.
 */
export function findSharedSet(items: Prepared[]): SharedAdjustmentSet | null {
  const usable = items.filter((item) => item.problem);
  if (usable.length < 2) {
    return null;
  }
  const pool = new Map<string, string[]>();
  const offer = (set: Iterable<string>) => {
    const sorted = sortedSet(set);
    pool.set(sorted.join("\u0000"), sorted);
  };
  const baselines = usable.map((item) => item.baseline).filter((set): set is string[] => set !== null);
  for (const item of usable) {
    item.minimalSets.slice(0, MINIMAL_SETS_PER_GRAPH).forEach(offer);
  }
  baselines.forEach(offer);
  baselines.forEach((left, index) => baselines.slice(index + 1).forEach((right) => offer([...left, ...right])));
  offer(baselines.flat());
  const [firstUsable, ...others] = usable;
  offer([...firstUsable.problem!.allowed].filter((node) => others.every((item) => item.problem!.allowed.has(node))));

  let best: { set: string[]; validIn: Prepared[] } | null = null;
  let mostWithoutJoining = 0;
  const answerOf = (item: Prepared) => (item.baseline === null ? "none" : item.baseline.join("\u0000"));
  const consider = (set: string[]) => {
    const validIn = usable.filter((item) => isValidAdjustmentSet(item.problem!, set));
    // Worth saying only if it joins graphs that would otherwise lead to different answers.
    if (new Set(validIn.map(answerOf)).size < 2) {
      mostWithoutJoining = Math.max(mostWithoutJoining, validIn.length);
      return;
    }
    if (
      !best ||
      validIn.length > best.validIn.length ||
      (validIn.length === best.validIn.length && set.length < best.set.length) ||
      (validIn.length === best.validIn.length && set.length === best.set.length && set.join() < best.set.join())
    ) {
      best = { set, validIn };
    }
  };
  [...pool.values()].forEach(consider);

  const everyVariable = sortedSet(usable.flatMap((item) => [...item.problem!.allowed]));
  if (everyVariable.length <= MAX_VARIABLES_TRIED_EXHAUSTIVELY) {
    const started = performance.now();
    for (const set of subsetsBySize(everyVariable)) {
      if ((best as { validIn: Prepared[] } | null)?.validIn.length === usable.length || performance.now() - started > SHARED_SET_BUDGET_MS) {
        break;
      }
      consider(set);
    }
  }
  best = best as { set: string[]; validIn: Prepared[] } | null;
  // It has to do better than simply taking one side, or singling it out would suggest an advantage it does not have.
  if (!best || best.validIn.length <= mostWithoutJoining) {
    return null;
  }
  const valid = new Set(best.validIn);
  return {
    variables: best.set,
    validIn: best.validIn.map((item) => item.result.id),
    notValidIn: usable.filter((item) => !valid.has(item)).map((item) => item.result.id),
    estimate: estimateFor(best.validIn[0], best.set).estimate,
  };
}

function holdsIn(claims: TestSpec[], other: Dag): boolean {
  return claims.every(
    ({ left, right, given }) => [left, right, ...given].every((node) => other.has(node) && other.isObserved(node)) && isDSeparated(other, [left], [right], given),
  );
}

/**
 * Graphs where each one's claims all hold in the other. With every variable measured this is exactly Markov
 * equivalence: an arrow in one graph only breaks the other's claim about that pair, and a different collider
 * breaks a claim about its two parents. With something unmeasured it means only that these tests cannot tell.
 */
function findSameClaims(items: Prepared[]): string[][] {
  const usable = items.filter((item) => item.dag);
  const groups: Prepared[][] = [];
  for (const item of usable) {
    const group = groups.find(([member]) => holdsIn(item.claims, member.dag!) && holdsIn(member.claims, item.dag!));
    if (group) {
      group.push(item);
    } else {
      groups.push([item]);
    }
  }
  return groups.filter((group) => group.length > 1).map((group) => group.map((item) => item.result.id));
}

/**
 * Each graph's adjustment set, estimate and data check, on the same file. These use the same fits and tests as the
 * analysis of a single graph, so a graph's row here matches what the page shows when that graph is open. Unlike that
 * analysis, a graph with no valid set is still checked against the data.
 */
export function* compareGraphs(request: AnalysisRequest): Generator<GraphComparison, void, void> {
  const versions = request.versions ?? [];
  const first = versions[0].graph;
  const profiles: ProfileCache = new Map();
  const items = versions.map((version, index) => prepare(version, index ? first : null, request, profiles));

  let sharedSet: SharedAdjustmentSet | null = null;
  let sameClaims: string[][] = [];
  const snapshot = (status: GraphComparison["status"]): GraphComparison => ({
    status,
    shownId: request.activeVersionId ?? null,
    graphs: items.map((item) => ({ ...item.result })),
    answers: answersFrom(items),
    sharedSet,
    sameClaims,
  });

  let sliceStart = performance.now();
  const sliceIsOver = () => performance.now() - sliceStart >= SLICE_MS;

  sameClaims = findSameClaims(items);
  yield snapshot("running");
  sliceStart = performance.now();

  for (const item of items) {
    if (item.baseline !== null) {
      const { estimate, reason } = estimateFor(item, item.baseline);
      item.result.estimate = estimate;
      item.result.unavailableReason = item.result.unavailableReason ?? reason;
    }
    if (sliceIsOver()) {
      yield snapshot("running");
      sliceStart = performance.now();
    }
  }
  sharedSet = findSharedSet(items);
  yield snapshot("running");
  sliceStart = performance.now();

  // Each graph gets its share of the time, so that the first ones cannot leave the rest with no check at all.
  const testStart = performance.now();
  const testable = items.filter((item) => item.effectContext);
  for (const [index, item] of testable.entries()) {
    const raw: { spec: TestSpec; result: RawTest }[] = [];
    const deadline = testStart + (TEST_BUDGET_MS * (index + 1)) / testable.length;
    for (const spec of item.testSpecs) {
      if (performance.now() > deadline) {
        item.result.checksTruncated = true;
        break;
      }
      const result = runTest(spec, item.effectContext!);
      if (result) {
        raw.push({ spec, result });
      }
      if (sliceIsOver()) {
        yield snapshot("running");
        sliceStart = performance.now();
      }
    }
    item.result.checks = toIndependenceTests(raw);
  }
  yield snapshot("complete");
}
