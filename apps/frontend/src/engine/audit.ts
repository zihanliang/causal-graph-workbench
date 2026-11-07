import type {
  AssumptionAudit,
  AssumptionEdit,
  AssumptionSeverity,
  EffectComparison,
  EffectSummary,
  ImpliedIndependenceTest,
  LoadBearingAssumption,
  SensitivityBenchmark,
  SensitivitySummary,
  VariableTiming,
} from "@causal-graph-workbench/shared";

import {
  createAdjustmentProblem,
  existsValidSet,
  isValidAdjustmentSet,
  listMinimalSeparators,
  listMinimalSets,
  type AdjustmentProblem,
} from "./adjustment";
import { completeRows, expandColumn, takeRows } from "./data/design";
import type { DataTable } from "./data/table";
import {
  CI_MULTIPLIER,
  fitEffect,
  shiftStandardError,
  toEffectEstimate,
  type EffectContext,
  type EffectFit,
  type FitOutcome,
} from "./effect";
import { Dag, sortedSet } from "./graph";
import { enumeratePaths, pathStatus } from "./paths";
import { computeEValue, startRobustness } from "./sensitivity";
import { holmAdjust, testConditionalIndependence, type TestVariable } from "./stats/independence";

const GRAPH_BUDGET_MS = 4000;
export const TEST_BUDGET_MS = 8000;
const ESTIMATE_BUDGET_MS = 8000;
export const SLICE_MS = 16;
const MAX_TEST_ROWS = 20_000;
const MIN_TEST_ROWS = 30;
const MAX_TEST_LEVELS = 30;
const MAX_OTHER_MINIMAL_SETS = 4;
export const CONFLICT_LEVEL = 0.05;

/** A shift smaller than this many standard errors of the current estimate is treated as small. */
const MOVES_ESTIMATE_SE = 0.5;
/** A flipped conclusion only counts when the estimate moved by at least this many standard errors. */
const FLIP_MIN_SE = 0.25;

export interface AuditInput {
  dag: Dag;
  treatment: string;
  outcome: string;
  baseline: string[];
  minimalSets: string[][];
  /** A set the user asked about that turned out not to be valid, shown only for comparison. */
  invalidChosenSet: string[] | null;
  timing: Map<string, VariableTiming>;
  /** Null when there is no data, or treatment or outcome has no column. */
  effectContext: EffectContext | null;
  effectUnavailableReason: string | null;
  /** Variables that have a usable column. */
  boundNodes: Set<string>;
  hasData: boolean;
}

export interface AuditSnapshot {
  audit: AssumptionAudit;
  effect: EffectSummary | null;
  sensitivity: SensitivitySummary | null;
}

/** Baseline variables, then before treatment, then after. Treatment sits between; the outcome comes after treatment. */
function tierOf(node: string, input: Pick<AuditInput, "treatment" | "outcome" | "timing">): number | null {
  if (node === input.treatment) {
    return 2;
  }
  if (node === input.outcome) {
    return 3;
  }
  const timing = input.timing.get(node);
  return timing === "baseline" ? 0 : timing === "before" ? 1 : timing === "after" ? 3 : null;
}

export function timingAllows(
  source: string,
  target: string,
  input: Pick<AuditInput, "treatment" | "outcome" | "timing">,
): boolean {
  if (source === input.outcome && target === input.treatment) {
    return false;
  }
  const from = tierOf(source, input);
  const to = tierOf(target, input);
  return from === null || to === null || from <= to;
}

export interface SingleArrowError {
  edit: AssumptionEdit;
  source: string;
  target: string;
}

function alteredGraph(dag: Dag, { edit, source, target }: SingleArrowError): Dag {
  const unobserved = dag.nodes.filter((node) => !dag.isObserved(node));
  const edges = dag.edges().filter(([from, to]) => edit === "add" || !(from === source && to === target));
  if (edit === "add") {
    edges.push([source, target]);
  } else if (edit === "reverse") {
    edges.push([target, source]);
  }
  return new Dag(dag.nodes, edges, unobserved);
}

/**
 * Every way the graph could be wrong by one arrow. Errors touching treatment or the current set come
 * first, so that if the time budget runs out on a very large graph, the most relevant were checked.
 */
export function listSingleArrowErrors(
  input: Pick<AuditInput, "dag" | "treatment" | "outcome" | "timing"> & { baseline: string[] },
): { errors: SingleArrowError[]; ruledOutByTiming: number } {
  const { dag, treatment, outcome } = input;
  const errors: SingleArrowError[] = [];
  let ruledOutByTiming = 0;

  for (const [source, target] of dag.edges()) {
    errors.push({ edit: "remove", source, target });
    if (source === treatment && target === outcome) {
      continue;
    }
    if (alteredGraph(dag, { edit: "reverse", source, target }).isAcyclic()) {
      if (timingAllows(target, source, input)) {
        errors.push({ edit: "reverse", source, target });
      } else {
        ruledOutByTiming += 1;
      }
    }
  }
  for (const source of dag.nodes) {
    for (const target of dag.nodes) {
      if (source === target || dag.hasEdge(source, target) || dag.hasEdge(target, source)) {
        continue;
      }
      if ((source === outcome && target === treatment) || dag.descendants(target).has(source)) {
        continue;
      }
      if (timingAllows(source, target, input)) {
        errors.push({ edit: "add", source, target });
      } else {
        ruledOutByTiming += 1;
      }
    }
  }

  const important = new Set([treatment, ...input.baseline]);
  const rank = (error: SingleArrowError) => (important.has(error.source) || important.has(error.target) ? 0 : 1);
  errors.sort((left, right) => rank(left) - rank(right));
  return { errors, ruledOutByTiming };
}

/** The valid set that changes the current one least, or null when no measured set is valid. */
export function nearestValidSet(problem: AdjustmentProblem, baseline: string[]): string[] | null {
  if (!existsValidSet(problem)) {
    return null;
  }
  const base = baseline.filter((node) => problem.allowed.has(node));
  const others = [...problem.allowed].filter((node) => !base.includes(node));
  const candidates: string[][] = [base];
  for (const node of base) {
    candidates.push(base.filter((other) => other !== node));
  }
  for (const node of others) {
    candidates.push([...base, node]);
  }
  for (const set of listMinimalSets(problem, 64).sets) {
    candidates.push(set, [...new Set([...base, ...set])]);
  }

  const original = new Set(baseline);
  let best: { set: string[]; distance: number } | null = null;
  for (const candidate of candidates) {
    if (!isValidAdjustmentSet(problem, candidate)) {
      continue;
    }
    const distance = symmetricDifferenceSize(candidate, original);
    if (
      !best ||
      distance < best.distance ||
      (distance === best.distance && candidate.length < best.set.length) ||
      (distance === best.distance && candidate.length === best.set.length && candidate.join() < best.set.join())
    ) {
      best = { set: sortedSet(candidate), distance };
    }
  }
  // Rare: the fix needs several changes that neither a single step nor a minimal set reaches.
  return best ? best.set : (listMinimalSets(problem, 1).sets[0] ?? null);
}

function symmetricDifferenceSize(candidate: string[], original: Set<string>): number {
  const members = new Set(candidate);
  let count = 0;
  for (const node of members) {
    if (!original.has(node)) {
      count += 1;
    }
  }
  for (const node of original) {
    if (!members.has(node)) {
      count += 1;
    }
  }
  return count;
}

function firstOpenBackdoorPath(problem: AdjustmentProblem, conditioning: string[]): string | null {
  const members = new Set(conditioning);
  const { paths } = enumeratePaths(problem.dag, problem.treatment, problem.outcome, 200);
  return (
    paths.find((path) => path.category === "backdoor" && pathStatus(problem.dag, path.nodes, members).isOpen)?.pathString ?? null
  );
}

function explain(
  error: SingleArrowError,
  problem: AdjustmentProblem,
  baseline: string[],
): { statement: string; consequence: string } {
  const { edit, source, target } = error;
  const statement =
    edit === "add"
      ? `You assume ${source} has no direct effect on ${target}.`
      : edit === "remove"
        ? `You assume ${source} directly affects ${target}.`
        : `You assume ${source} affects ${target}, not the other way round.`;
  const lead = edit === "add" ? "If it does" : edit === "remove" ? "If it does not" : "If the arrow runs the other way";

  const downstream = baseline.filter((node) => problem.dag.descendants(problem.treatment).has(node));
  if (downstream.length) {
    return {
      statement,
      consequence: `${lead}, ${downstream.join(" and ")} would be affected by treatment, so ${
        downstream.length === 1 ? "it" : "they"
      } should not be adjusted for.`,
    };
  }
  const open = firstOpenBackdoorPath(problem, baseline);
  return {
    statement,
    consequence: open
      ? `${lead}, this backdoor path stays open: ${open}.`
      : `${lead}, the current set no longer blocks every backdoor path.`,
  };
}

export interface TestSpec {
  left: string;
  right: string;
  given: string[];
}

/** The independencies the graph implies among measured variables, one for each pair without an arrow. */
export function impliedIndependencies(
  dag: Dag,
  boundNodes: Set<string>,
): { specs: TestSpec[]; untestablePairs: number } {
  const order = dag.topologicalOrder() ?? dag.nodes;
  const position = new Map(order.map((node, index) => [node, index]));
  const measured = order.filter((node) => boundNodes.has(node));
  const specs: TestSpec[] = [];
  let untestablePairs = 0;

  measured.forEach((left, index) => {
    for (const right of measured.slice(index + 1)) {
      if (dag.hasEdge(left, right) || dag.hasEdge(right, left)) {
        continue;
      }
      // With every parent measured, the two variables' parents always separate them.
      const parents = sortedSet([...dag.parents(left), ...dag.parents(right)]);
      if (parents.every((node) => boundNodes.has(node))) {
        specs.push({ left, right, given: parents });
        continue;
      }
      const allowed = new Set([...boundNodes].filter((node) => node !== left && node !== right));
      const separator = listMinimalSeparators(dag, left, right, allowed, 1).sets[0];
      if (separator) {
        specs.push({ left, right, given: separator });
      } else {
        untestablePairs += 1;
      }
    }
  });
  specs.sort((a, b) => position.get(a.left)! - position.get(b.left)!);
  return { specs, untestablePairs };
}

function testVariables(node: string, context: EffectContext): TestVariable[] | null {
  const bound = context.columnOf(node);
  if (!bound) {
    return null;
  }
  const expanded = expandColumn(bound.column, bound.type, context.table);
  if (expanded.levelCount > MAX_TEST_LEVELS) {
    return null;
  }
  if (bound.type === "categorical") {
    return expanded.terms.slice(1).map((term) => ({ kind: "flag" as const, values: term.values }));
  }
  return [{ kind: bound.type === "binary" ? ("flag" as const) : ("numeric" as const), values: expanded.terms[0].values }];
}

/** A repeatable random sample, so results do not change between runs. */
function sampleRows(rows: number[], size: number): number[] {
  const shuffled = [...rows];
  let state = 20261104;
  for (let i = shuffled.length - 1; i > 0; i -= 1) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    const j = state % (i + 1);
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  return shuffled.slice(0, size).sort((a, b) => a - b);
}

export interface RawTest {
  pValue: number;
  correlation: number;
  rowsUsed: number;
  sampled: boolean;
}

const pairKey = (spec: TestSpec) => sortedSet([spec.left, spec.right]).join("|");

/** With Holm's adjustment across exactly these tests. */
export function toIndependenceTests(raw: { spec: TestSpec; result: RawTest }[]): ImpliedIndependenceTest[] {
  const adjusted = holmAdjust(raw.map((item) => item.result.pValue));
  return raw.map(({ spec, result }, index) => ({
    id: `test:${pairKey(spec)}`,
    left: spec.left,
    right: spec.right,
    given: spec.given,
    pValue: result.pValue,
    adjustedPValue: adjusted[index],
    conflict: adjusted[index] < CONFLICT_LEVEL,
    correlation: result.correlation,
    rowsUsed: result.rowsUsed,
  }));
}

const testCache = new WeakMap<DataTable, Map<string, RawTest | null>>();
const fitCache = new WeakMap<DataTable, Map<string, FitOutcome>>();
const MAX_CACHED_FITS = 64;

export function runTest(spec: TestSpec, context: EffectContext): RawTest | null {
  const key = [spec.left, spec.right, ...spec.given]
    .map((node) => {
      const bound = context.columnOf(node);
      return `${bound?.column}:${bound?.type}`;
    })
    .join("|");
  let cache = testCache.get(context.table);
  if (!cache) {
    cache = new Map();
    testCache.set(context.table, cache);
  }
  if (cache.has(key)) {
    return cache.get(key)!;
  }

  const left = testVariables(spec.left, context);
  const right = testVariables(spec.right, context);
  const given = spec.given.map((node) => testVariables(node, context));
  let result: RawTest | null = null;
  if (left && right && given.every(Boolean)) {
    const condition = given.flat() as TestVariable[];
    const all = [...left, ...right, ...condition].map((variable) => variable.values);
    let rows = completeRows(all, context.table.rowCount);
    const sampled = rows.length > MAX_TEST_ROWS;
    if (sampled) {
      rows = sampleRows(rows, MAX_TEST_ROWS);
    }
    if (rows.length >= MIN_TEST_ROWS) {
      const take = (variable: TestVariable): TestVariable => ({ kind: variable.kind, values: takeRows(variable.values, rows) });
      const outcome = testConditionalIndependence(left.map(take), right.map(take), condition.map(take), rows.length);
      result = { ...outcome, sampled };
    }
  }
  cache.set(key, result);
  return result;
}

export function cachedFit(context: EffectContext, set: string[], complete: string[]): FitOutcome {
  const key = [
    context.treatment.column,
    context.treatment.type,
    context.outcome.column,
    context.outcome.type,
    context.estimand,
    set.map((node) => `${node}=${context.columnOf(node)?.column}`).join(","),
    complete.map((node) => context.columnOf(node)?.column).join(","),
  ].join("|");
  let cache = fitCache.get(context.table);
  if (!cache) {
    cache = new Map();
    fitCache.set(context.table, cache);
  }
  const existing = cache.get(key);
  if (existing) {
    return existing;
  }
  const outcome = fitEffect(context, set, complete);
  if (cache.size >= MAX_CACHED_FITS) {
    cache.delete(cache.keys().next().value as string);
  }
  cache.set(key, outcome);
  return outcome;
}

type Verdict = "positive" | "negative" | "inconclusive";

function verdictOf(fit: EffectFit): Verdict {
  const low = fit.estimate - CI_MULTIPLIER * fit.standardError;
  const high = fit.estimate + CI_MULTIPLIER * fit.standardError;
  return low > 0 ? "positive" : high < 0 ? "negative" : "inconclusive";
}

function classifyShift(baseline: EffectFit, alternative: EffectFit, shift: number, seShift: number): AssumptionSeverity {
  const standardErrors = baseline.standardError > 0 ? Math.abs(shift) / baseline.standardError : 0;
  if (verdictOf(baseline) !== verdictOf(alternative) && standardErrors >= FLIP_MIN_SE) {
    return "changes_conclusion";
  }
  // The paired standard error keeps sampling noise from looking like a real change.
  return standardErrors >= MOVES_ESTIMATE_SE && Math.abs(shift) > CI_MULTIPLIER * seShift ? "moves_estimate" : "small_shift";
}

const SEVERITY_ORDER: AssumptionSeverity[] = ["changes_conclusion", "no_valid_set", "moves_estimate", "small_shift", "not_estimated"];

function sortAssumptions(assumptions: LoadBearingAssumption[]): LoadBearingAssumption[] {
  const size = (item: LoadBearingAssumption) => Math.abs(item.shift ?? 0);
  return [...assumptions].sort(
    (left, right) =>
      SEVERITY_ORDER.indexOf(left.severity) - SEVERITY_ORDER.indexOf(right.severity) ||
      size(right) - size(left) ||
      Number(right.dataCheck === "conflict") - Number(left.dataCheck === "conflict") ||
      left.id.localeCompare(right.id),
  );
}

function invalidReason(problem: AdjustmentProblem, variables: string[]): string | null {
  if (isValidAdjustmentSet(problem, variables)) {
    return null;
  }
  const downstream = variables.filter((node) => problem.dag.descendants(problem.treatment).has(node));
  if (downstream.length) {
    return `${downstream.join(" and ")} ${downstream.length === 1 ? "is" : "are"} downstream of treatment.`;
  }
  const open = firstOpenBackdoorPath(problem, variables);
  return open ? `This backdoor path stays open: ${open}.` : "It does not block every backdoor path.";
}

function buildComparisons(input: AuditInput, problem: AdjustmentProblem, context: EffectContext): EffectComparison[] {
  const others = input.minimalSets.filter((set) => set.join() !== input.baseline.join()).slice(0, MAX_OTHER_MINIMAL_SETS);
  const everything = sortedSet(
    [...input.boundNodes].filter((node) => node !== input.treatment && node !== input.outcome),
  );
  const wanted: Pick<EffectComparison, "label" | "kind" | "variables">[] = [
    { label: "Current set", kind: "baseline", variables: input.baseline },
    ...others.map((variables) => ({ label: "Another minimal set", kind: "minimal" as const, variables })),
    ...(input.invalidChosenSet ? [{ label: "The set you tried", kind: "custom" as const, variables: input.invalidChosenSet }] : []),
    { label: "No adjustment", kind: "none", variables: [] },
    { label: "Everything measured", kind: "all", variables: everything },
  ];

  const seen = new Set<string>();
  return wanted
    .filter(({ variables }) => {
      const key = sortedSet(variables).join();
      if (seen.has(key)) {
        return false;
      }
      seen.add(key);
      return true;
    })
    .map(({ label, kind, variables }, index) => {
      const outcome = cachedFit(context, sortedSet(variables), []);
      const reason = invalidReason(problem, variables);
      return {
        id: `comparison-${index + 1}`,
        label,
        kind,
        variables: sortedSet(variables),
        isValid: reason === null,
        invalidReason: reason,
        estimate: outcome.ok ? toEffectEstimate(outcome.fit, context.table.rowCount) : null,
        unavailableReason: outcome.ok ? null : outcome.reason,
      };
    });
}

/**
 * Runs in slices and yields whenever one has used up its time, so that a worker can publish progress
 * and notice a newer request between slices. The last value yielded is the complete audit.
 */
export function* runAudit(input: AuditInput): Generator<AuditSnapshot, void, void> {
  const { dag, treatment, outcome, baseline, effectContext } = input;
  const problem = createAdjustmentProblem(dag, treatment, outcome);

  const { errors, ruledOutByTiming } = listSingleArrowErrors(input);
  const assumptions: LoadBearingAssumption[] = [];
  const tests: ImpliedIndependenceTest[] = [];
  let conflictsWithoutConsequence: string[] = [];
  let untestablePairs = 0;
  let testSampleSize: number | null = null;
  let truncated = false;
  let editsChecked = 0;
  let effect: EffectSummary | null = input.hasData
    ? { status: "running", estimate: null, unavailableReason: input.effectUnavailableReason, comparisons: [] }
    : null;
  let sensitivity: SensitivitySummary | null = null;

  const snapshot = (status: AssumptionAudit["status"]): AuditSnapshot => ({
    audit: {
      status,
      baselineSet: baseline,
      editsChecked,
      editsRuledOutByTiming: ruledOutByTiming,
      truncated,
      assumptions: sortAssumptions(assumptions),
      tests,
      conflictsWithoutConsequence,
      untestablePairs,
      testSampleSize,
    },
    effect,
    sensitivity,
  });

  let sliceStart = performance.now();
  const sliceIsOver = () => {
    if (performance.now() - sliceStart < SLICE_MS) {
      return false;
    }
    return true;
  };

  // 1. Which single-arrow errors would stop the current set from being valid? Needs no data.
  const graphStart = performance.now();
  for (const error of errors) {
    if (performance.now() - graphStart > GRAPH_BUDGET_MS) {
      truncated = true;
      break;
    }
    editsChecked += 1;
    const altered = createAdjustmentProblem(alteredGraph(dag, error), treatment, outcome);
    if (!isValidAdjustmentSet(altered, baseline)) {
      const repair = nearestValidSet(altered, baseline);
      const members = new Set(baseline);
      const { statement, consequence } = explain(error, altered, baseline);
      assumptions.push({
        id: `${error.edit}:${error.source}:${error.target}`,
        edit: error.edit,
        source: error.source,
        target: error.target,
        statement,
        consequence,
        repair,
        addedToSet: repair ? repair.filter((node) => !members.has(node)) : [],
        removedFromSet: repair ? baseline.filter((node) => !repair.includes(node)) : [],
        dataCheck: "not_testable",
        dataCheckNote: input.hasData
          ? error.edit === "reverse"
            ? "Data of this kind cannot tell which way an arrow points."
            : error.edit === "remove"
              ? "The data check looks for missing arrows, not for arrows that should not be there."
              : "This pair cannot be tested with the measured variables."
          : "Add data to check this against your file.",
        testId: null,
        alternativeEstimate: null,
        baselineOnSameRows: null,
        shift: null,
        shiftStandardError: null,
        severity: repair ? "not_estimated" : "no_valid_set",
      });
    }
    if (sliceIsOver()) {
      yield snapshot("running");
      sliceStart = performance.now();
    }
  }
  yield snapshot(effectContext ? "running" : "complete");
  sliceStart = performance.now();

  if (!effectContext) {
    effect = effect ? { ...effect, status: "complete" } : null;
    yield snapshot("complete");
    return;
  }

  // 2. The estimate itself, and how it compares with other choices of adjustment.
  const baseFit = cachedFit(effectContext, sortedSet(baseline), []);
  effect = {
    status: "running",
    estimate: baseFit.ok ? toEffectEstimate(baseFit.fit, effectContext.table.rowCount) : null,
    unavailableReason: baseFit.ok ? null : baseFit.reason,
    comparisons: [],
  };
  yield snapshot("running");
  effect = { ...effect, status: "complete", comparisons: buildComparisons(input, problem, effectContext) };
  yield snapshot("running");
  sliceStart = performance.now();

  // How strong would something unmeasured have to be? Measured variables give the scale.
  if (baseFit.ok) {
    const covariates = sortedSet(baseline);
    // Fitted again with its per-row values, which are too large to keep on every cached fit.
    const detailed = fitEffect(effectContext, covariates, [], { detail: true });
    const fit = detailed.ok ? detailed.fit : baseFit.fit;
    const robustness = startRobustness(fit, effectContext, covariates);
    const evalue = computeEValue(fit, effectContext);
    sensitivity = { status: "running", robustness: robustness?.summary ?? null, evalue };
    yield snapshot("running");
    sliceStart = performance.now();

    if (robustness) {
      const benchmarks: SensitivityBenchmark[] = [];
      let benchmarksComplete = true;
      const benchmarkStart = performance.now();
      for (const variable of covariates) {
        if (performance.now() - benchmarkStart > ESTIMATE_BUDGET_MS) {
          benchmarksComplete = false;
          break;
        }
        let withoutIt: EffectFit | null = null;
        if (fit.method === "aipw") {
          // On the same rows, so that dropping a variable cannot change the sample.
          const short = cachedFit(effectContext, covariates.filter((node) => node !== variable), covariates);
          withoutIt = short.ok ? short.fit : null;
        }
        const benchmark = robustness.benchmark(variable, withoutIt);
        if (benchmark) {
          benchmarks.push(benchmark);
        }
        if (sliceIsOver()) {
          yield snapshot("running");
          sliceStart = performance.now();
        }
      }
      benchmarks.sort((left, right) => right.shareOfEstimate - left.shareOfEstimate || left.variable.localeCompare(right.variable));
      sensitivity = { status: "complete", robustness: { ...robustness.summary, benchmarks, benchmarksComplete }, evalue };
    } else {
      sensitivity = { status: "complete", robustness: null, evalue };
    }
    yield snapshot("running");
    sliceStart = performance.now();
  }

  // 3. Does the data contradict what the graph implies? Pairs that matter for the current set go first.
  const { specs, untestablePairs: notSeparable } = impliedIndependencies(dag, input.boundNodes);
  untestablePairs = notSeparable;
  const relevant = new Set(
    assumptions.filter((item) => item.edit === "add").map((item) => sortedSet([item.source, item.target]).join("|")),
  );
  const ordered = [...specs].sort((a, b) => Number(relevant.has(pairKey(b))) - Number(relevant.has(pairKey(a))));

  const raw: { spec: TestSpec; result: RawTest }[] = [];
  const testStart = performance.now();
  for (const spec of ordered) {
    if (performance.now() - testStart > TEST_BUDGET_MS) {
      truncated = true;
      break;
    }
    const result = runTest(spec, effectContext);
    if (result) {
      raw.push({ spec, result });
    } else {
      untestablePairs += 1;
    }
    if (sliceIsOver()) {
      yield snapshot("running");
      sliceStart = performance.now();
    }
  }

  tests.length = 0;
  tests.push(...toIndependenceTests(raw));
  raw.forEach(({ result }) => {
    if (result.sampled) {
      testSampleSize = result.rowsUsed;
    }
  });
  const testByPair = new Map(tests.map((test) => [sortedSet([test.left, test.right]).join("|"), test]));
  for (const assumption of assumptions) {
    if (assumption.edit !== "add") {
      continue;
    }
    const test = testByPair.get(sortedSet([assumption.source, assumption.target]).join("|"));
    if (!test) {
      continue;
    }
    assumption.testId = test.id;
    assumption.dataCheck = test.conflict ? "conflict" : "no_conflict";
    const given = test.given.length ? ` given ${test.given.join(", ")}` : "";
    assumption.dataCheckNote = test.conflict
      ? `The data disagrees: ${test.left} and ${test.right} are still related${given}. Either an arrow is missing here, or something unmeasured affects both. Adding the arrow only helps in the first case, and can make the estimate worse in the second.`
      : `No conflict found between ${test.left} and ${test.right}${given}. That does not show the arrow is absent, so defend this on subject-matter grounds.`;
  }
  const consequential = new Set(assumptions.map((item) => item.testId).filter(Boolean));
  conflictsWithoutConsequence = tests.filter((test) => test.conflict && !consequential.has(test.id)).map((test) => test.id);
  yield snapshot("running");
  sliceStart = performance.now();

  // 4. How much would the estimate move if each of those errors were real?
  const estimateStart = performance.now();
  for (const assumption of assumptions) {
    if (!assumption.repair) {
      continue;
    }
    if (performance.now() - estimateStart > ESTIMATE_BUDGET_MS) {
      truncated = true;
      break;
    }
    // Both fits use the same rows, or a change in the sample would look like a change in the estimate.
    const complete = sortedSet([...baseline, ...assumption.repair]);
    const before = cachedFit(effectContext, sortedSet(baseline), complete);
    const after = cachedFit(effectContext, assumption.repair, complete);
    if (before.ok && after.ok) {
      const shift = after.fit.estimate - before.fit.estimate;
      const seShift = shiftStandardError(after.fit, before.fit);
      assumption.alternativeEstimate = toEffectEstimate(after.fit, effectContext.table.rowCount);
      assumption.baselineOnSameRows = before.fit.estimate;
      assumption.shift = shift;
      assumption.shiftStandardError = seShift;
      assumption.severity = classifyShift(before.fit, after.fit, shift, seShift);
    }
    if (sliceIsOver()) {
      yield snapshot("running");
      sliceStart = performance.now();
    }
  }
  yield snapshot("complete");
}
