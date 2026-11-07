import type { AnalysisRequest, GraphSpec, PairState, ScanAnswer, UncertainPair, UncertaintyScan, VariableTiming } from "@causal-graph-workbench/shared";

import { runTest, SLICE_MS, timingAllows, toIndependenceTests, type RawTest, type TestSpec } from "./audit";
import { answersFrom, describeChange, estimateFor, findSharedSet, prepare, type Prepared, type ProfileCache } from "./compare";
import { Dag } from "./graph";
import { applyPairStates, currentPairState } from "./pairStates";

const SCAN_BUDGET_MS = 20000;
const STATES: PairState["state"][] = ["first_to_second", "second_to_first", "none"];

interface Combination {
  states: PairState[];
  /** How many pairs differ from the graph on show. */
  changes: number;
  graph: GraphSpec;
}

/** Pairs this graph can say something about. Whether treatment affects outcome is what is being estimated, so it cannot be one. */
export function usablePairs(graph: GraphSpec, pairs: UncertainPair[]): UncertainPair[] {
  const known = new Set(graph.nodes.map((node) => node.id));
  const isEndpoints = ({ first, second }: UncertainPair) => (first === graph.treatmentId && second === graph.outcomeId) || (first === graph.outcomeId && second === graph.treatmentId);
  return pairs.filter((pair) => known.has(pair.first) && known.has(pair.second) && pair.first !== pair.second && !isEndpoints(pair));
}

function everyCombination(graph: GraphSpec, pairs: UncertainPair[]): Combination[] {
  let partial: PairState[][] = [[]];
  for (const pair of pairs) {
    partial = partial.flatMap((states) => STATES.map((state) => [...states, { ...pair, state }]));
  }
  const now = new Map(pairs.map((pair) => [`${pair.first}\u0000${pair.second}`, currentPairState(graph, pair.first, pair.second)]));
  return partial
    .map((states) => ({
      states,
      changes: states.filter(({ first, second, state }) => now.get(`${first}\u0000${second}`) !== state).length,
      graph: applyPairStates(graph, states),
    }))
    .sort((left, right) => left.changes - right.changes);
}

const answerKey = (set: string[] | null) => (set === null ? "none" : `set:${set.join("\u0000")}`);

/**
 * Tries every combination of the arrows someone is unsure of, on the same file, and says how many different answers
 * they lead to. Unlike the graphs in a comparison, these are too many to read one by one, so they are summarised by
 * answer. Combinations that would run backwards in time or form a cycle are left out, and counted.
 */
export function* scanUncertainArrows(request: AnalysisRequest): Generator<UncertaintyScan, void, void> {
  const { graph } = request;
  const pairs = usablePairs(graph, request.uncertainPairs ?? []);
  if (!pairs.length || !graph.treatmentId || !graph.outcomeId) {
    return;
  }

  const timing = new Map(graph.nodes.filter((node) => node.timing).map((node) => [node.id, node.timing as VariableTiming]));
  const timingInput = { treatment: graph.treatmentId, outcome: graph.outcomeId, timing };
  const unmeasured = graph.nodes.filter((node) => node.observed === false).map((node) => node.id);
  const combinations = everyCombination(graph, pairs);

  let ruledOutByTiming = 0;
  let ruledOutByCycle = 0;
  const candidates = combinations.filter(({ states, graph: changed }) => {
    const backwards = states.some(({ first, second, state }) => state !== "none" && !(state === "first_to_second" ? timingAllows(first, second, timingInput) : timingAllows(second, first, timingInput)));
    if (backwards) {
      ruledOutByTiming += 1;
      return false;
    }
    if (!Dag.fromSpec(changed, unmeasured).isAcyclic()) {
      ruledOutByCycle += 1;
      return false;
    }
    return true;
  });

  const started = performance.now();
  let sliceStart = started;
  const sliceIsOver = () => performance.now() - sliceStart >= SLICE_MS;
  const outOfTime = () => performance.now() - started > SCAN_BUDGET_MS;

  const profiles: ProfileCache = new Map();
  const done: { combination: Combination; item: Prepared }[] = [];
  let truncated = false;
  let checksTruncated = false;
  let sharedSet: UncertaintyScan["sharedSet"] = null;

  const snapshot = (status: UncertaintyScan["status"]): UncertaintyScan => {
    const items = done.map(({ item }) => item);
    const answers: ScanAnswer[] = answersFrom(items).map((answer) => {
      const members = done.filter(({ item }) => answer.graphIds.includes(item.result.id));
      const checked = members.filter(({ item }) => item.result.checks !== null);
      const isContradicted = ({ item }: (typeof members)[number]) => Boolean(item.result.checks?.some((check) => check.conflict));
      // The list is ordered by how much each combination changes, so the first the data does not contradict is the closest.
      const example = members.find((member) => !isContradicted(member)) ?? members[0];
      return {
        adjustmentSet: answer.adjustmentSet,
        estimate: answer.estimate,
        combinations: members.length,
        checked: checked.length,
        contradicted: checked.filter(isContradicted).length,
        example: example.combination.states,
        exampleChange: example.combination.changes ? describeChange(graph, example.combination.graph) : null,
      };
    });
    const answerOf = new Map(done.map(({ combination, item }) => [combination.states.map((pair) => pair.state).join(), answerKey(item.result.adjustmentSet)]));
    const pairEffects = pairs.map((pair, index) => {
      const answersWhenOthersMatch = new Map<string, Set<string>>();
      for (const [states, answer] of answerOf) {
        const others = states.split(",").filter((_, position) => position !== index).join();
        answersWhenOthersMatch.set(others, (answersWhenOthersMatch.get(others) ?? new Set()).add(answer));
      }
      return { ...pair, changesAnswer: [...answersWhenOthersMatch.values()].some((answers) => answers.size > 1) };
    });
    return { status, pairs, combinations: combinations.length, analysed: done.length, ruledOutByTiming, ruledOutByCycle, answers, pairEffects, sharedSet, truncated, checksTruncated };
  };

  // Sets and estimates first, because they are the answer. Most combinations share a set, and so a fit.
  for (const [index, combination] of candidates.entries()) {
    if (outOfTime()) {
      truncated = true;
      break;
    }
    const item = prepare({ id: `combination-${index}`, name: `Combination ${index + 1}`, graph: combination.graph }, null, request, profiles);
    if (item.problem && item.baseline !== null) {
      const { estimate, reason } = estimateFor(item, item.baseline);
      item.result.estimate = estimate;
      item.result.unavailableReason ??= reason;
    }
    done.push({ combination, item });
    if (sliceIsOver()) {
      yield snapshot("running");
      sliceStart = performance.now();
    }
  }
  const shared = findSharedSet(done.map(({ item }) => item));
  sharedSet = shared ? { variables: shared.variables, validIn: shared.validIn.length, estimate: shared.estimate } : null;
  yield snapshot("running");
  sliceStart = performance.now();

  // Then the data checks, which many combinations also share.
  for (const { item } of done) {
    if (!item.effectContext) {
      continue;
    }
    const raw: { spec: TestSpec; result: RawTest }[] = [];
    let finished = true;
    for (const spec of item.testSpecs) {
      if (outOfTime()) {
        checksTruncated = true;
        finished = false;
        break;
      }
      const result = runTest(spec, item.effectContext);
      if (result) {
        raw.push({ spec, result });
      }
      if (sliceIsOver()) {
        yield snapshot("running");
        sliceStart = performance.now();
      }
    }
    if (!finished) {
      break;
    }
    item.result.checks = toIndependenceTests(raw);
  }
  yield snapshot("complete");
}
