/**
 * Simulation check of the audit on data with a known truth, run through the same `analyze` the app uses.
 * Reports what the panel would tell a user in each situation, and fails if a claim the app relies on stops
 * holding. Run with: npx vite-node tools/verification/verify_calibration.ts [runs per scenario]
 */
import { analyze } from "../../apps/frontend/src/engine/analyze";
import { inferVariableType, isMissing, parseDataset } from "../../apps/frontend/src/engine/data/table";
import { fitEffect, type EffectContext, type EffectFit } from "../../apps/frontend/src/engine/effect";
import { startRobustness } from "../../apps/frontend/src/engine/sensitivity";
import { fitOls } from "../../apps/frontend/src/engine/stats/ols";
import type { AnalysisResult, DataContext, GraphSpec } from "../../packages/shared/src/index";

const RUNS = Number(process.argv[process.argv.length - 1]) || 200;

function createRandom(seed: number) {
  let state = seed >>> 0;
  const uniform = () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const normal = () => Math.sqrt(-2 * Math.log(uniform() || 1e-300)) * Math.cos(2 * Math.PI * uniform());
  return { uniform, normal };
}

type Random = ReturnType<typeof createRandom>;
const NAMES = Array.from({ length: 10 }, (_, index) => `V${index}`);
const FORMS = [(x: number) => x, (x: number) => Math.tanh(2 * x), (x: number) => x * x - 1, (x: number) => (x > 0 ? 1 : -1)];

interface Edge {
  from: number;
  to: number;
  weight: number;
  form: number;
}

function randomStructure(random: Random, [low, high]: [number, number], nonlinear: boolean) {
  for (;;) {
    const edges: Edge[] = [];
    for (let from = 0; from < 10; from += 1) {
      for (let to = from + 1; to < 10; to += 1) {
        if (random.uniform() < 0.3) {
          edges.push({
            from,
            to,
            weight: (low + random.uniform() * (high - low)) * (random.uniform() < 0.5 ? -1 : 1),
            form: nonlinear ? Math.floor(random.uniform() * 4) : 0,
          });
        }
      }
    }
    const reach = (start: number) => {
      const seen = new Set<number>();
      const stack = [start];
      while (stack.length) {
        const node = stack.pop()!;
        for (const edge of edges) {
          if (edge.from === node && !seen.has(edge.to)) {
            seen.add(edge.to);
            stack.push(edge.to);
          }
        }
      }
      return seen;
    };
    const pairs: [number, number][] = [];
    for (let t = 3; t < 7; t += 1) {
      for (const y of reach(t)) {
        pairs.push([t, y]);
      }
    }
    if (pairs.length) {
      const [t, y] = pairs[Math.floor(random.uniform() * pairs.length)];
      return { edges, t, y };
    }
  }
}

function simulate(edges: Edge[], rows: number, random: Random, latent?: { targets: number[]; strength: number }) {
  const data = NAMES.map(() => new Float64Array(rows));
  for (let row = 0; row < rows; row += 1) {
    const u = latent ? random.normal() : 0;
    for (let node = 0; node < 10; node += 1) {
      let value = random.normal();
      for (const edge of edges) {
        if (edge.to === node) {
          value += edge.weight * FORMS[edge.form](data[edge.from][row]);
        }
      }
      if (latent?.targets.includes(node)) {
        value += latent.strength * u;
      }
      data[node][row] = value;
    }
  }
  return data;
}

function toCsv(data: Float64Array[]): string {
  const lines = [NAMES.join(",")];
  for (let row = 0; row < data[0].length; row += 1) {
    lines.push(data.map((column) => column[row].toFixed(5)).join(","));
  }
  return lines.join("\n");
}

function toGraph(edges: Pick<Edge, "from" | "to">[], t: number, y: number): GraphSpec {
  return {
    nodes: NAMES.map((id) => ({ id, label: id, x: 0, y: 0 })),
    edges: edges.map(({ from, to }) => ({ id: `${NAMES[from]}->${NAMES[to]}`, source: NAMES[from], target: NAMES[to] })),
    treatmentId: NAMES[t],
    outcomeId: NAMES[y],
  };
}

function totalEffect(edges: Edge[], t: number, y: number): number {
  const total = new Float64Array(10);
  total[t] = 1;
  for (let node = t + 1; node < 10; node += 1) {
    for (const edge of edges) {
      if (edge.to === node) {
        total[node] += edge.weight * total[edge.from];
      }
    }
  }
  return total[y];
}

function run(graph: GraphSpec, csv: string, dataContext?: DataContext): AnalysisResult {
  return analyze({ graph, dataContext, dataset: { filename: "sim.csv", content: csv } });
}

const median = (values: number[]) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)] ?? Number.NaN;
const percent = (values: boolean[]) => (100 * values.filter(Boolean).length) / Math.max(values.length, 1);

interface Row {
  scenario: string;
  falseAlarm: number;
  detected: number;
  ranked: number;
  before: number;
  after: number;
  cases: number;
}

/** One omitted arrow that really breaks the set, across random graphs. */
function omissionScenario(scenario: string, rows: number, weights: [number, number], nonlinear: boolean, seed: number): Row {
  const random = createRandom(seed);
  const falseAlarms: boolean[] = [];
  const detected: boolean[] = [];
  const rankedFirst: boolean[] = [];
  const errorBefore: number[] = [];
  const errorAfter: number[] = [];

  for (let index = 0; index < RUNS; index += 1) {
    const { edges, t, y } = randomStructure(random, weights, nonlinear);
    const data = simulate(edges, rows, random);
    const csv = toCsv(data);
    const correct = run(toGraph(edges, t, y), csv);
    falseAlarms.push(correct.audit!.tests.some((test) => test.conflict));

    const truth = nonlinear ? null : totalEffect(edges, t, y);
    const omitted = [...edges].sort(() => random.uniform() - 0.5);
    for (const candidate of omitted) {
      const drawn = edges.filter((edge) => edge !== candidate);
      const result = run(toGraph(drawn, t, y), csv);
      const id = `add:${NAMES[candidate.from]}:${NAMES[candidate.to]}`;
      const entry = result.audit?.assumptions.find((item) => item.id === id);
      if (!entry) {
        continue; // Leaving this arrow out does not invalidate the set, so it is not what is being tested.
      }
      detected.push(entry.dataCheck === "conflict");
      const conflicts = result.audit!.assumptions.filter((item) => item.dataCheck === "conflict");
      rankedFirst.push(conflicts[0]?.id === id);
      if (truth !== null && entry.alternativeEstimate && result.effect?.estimate) {
        errorBefore.push(Math.abs(result.effect.estimate.estimate - truth));
        errorAfter.push(Math.abs(entry.alternativeEstimate.estimate - truth));
      }
      break;
    }
  }
  return {
    scenario,
    falseAlarm: percent(falseAlarms),
    detected: percent(detected),
    ranked: percent(rankedFirst),
    before: median(errorBefore),
    after: median(errorAfter),
    cases: detected.length,
  };
}

const failures: string[] = [];
function expectBetween(label: string, value: number, low: number, high: number) {
  const ok = value >= low && value <= high;
  if (!ok) {
    failures.push(`${label}: ${value.toFixed(3)} is outside ${low} to ${high}`);
  }
  return `${value.toFixed(1)}${ok ? "" : " !!"}`;
}

console.log(`\nOne harmful arrow left out of the graph (${RUNS} random graphs per row)`);
console.log("scenario                           false alarm  detected  first among conflicts  median |error| before -> after  cases");
const scenarios: [string, number, [number, number], boolean, [number, number], [number, number]][] = [
  ["strong edges, n=2000", 2000, [0.2, 0.8], false, [0, 15], [90, 100]],
  ["medium edges, n=500", 500, [0.1, 0.3], false, [0, 15], [55, 100]],
  ["weak edges, n=200", 200, [0.05, 0.15], false, [0, 15], [0, 25]],
  ["nonlinear, strong, n=2000", 2000, [0.2, 0.8], true, [0, 20], [75, 100]],
  ["nonlinear, medium, n=500", 500, [0.1, 0.3], true, [0, 15], [35, 100]],
];
scenarios.forEach(([name, rows, weights, nonlinear, alarmBand, detectedBand], index) => {
  const row = omissionScenario(name, rows, weights, nonlinear, 1000 + index);
  console.log(
    `${name.padEnd(34)} ${expectBetween(`${name} false alarm`, row.falseAlarm, ...alarmBand).padStart(10)}% ${expectBetween(`${name} detected`, row.detected, ...detectedBand).padStart(8)}% ${row.ranked.toFixed(1).padStart(20)}% ${row.before.toFixed(3).padStart(12)} -> ${row.after.toFixed(3).padEnd(14)} ${row.cases}`,
  );
});

// A confounder nobody measured must not be presented as something an arrow can fix.
{
  const random = createRandom(2000);
  let improved = 0;
  let worsened = 0;
  let offered = 0;
  let covered = 0;
  let cases = 0;
  for (let index = 0; index < RUNS; index += 1) {
    const { edges, t, y } = randomStructure(random, [0.2, 0.8], false);
    const data = simulate(edges, 2000, random, { targets: [t, y], strength: 0.6 });
    const result = run(toGraph(edges, t, y), toCsv(data));
    const truth = totalEffect(edges, t, y);
    const estimate = result.effect?.estimate;
    if (!estimate) {
      continue;
    }
    cases += 1;
    covered += Number(estimate.ciLow <= truth && truth <= estimate.ciHigh);
    const top = result.audit!.assumptions.find((item) => item.dataCheck === "conflict" && item.alternativeEstimate);
    if (top) {
      offered += 1;
      const before = Math.abs(estimate.estimate - truth);
      const after = Math.abs(top.alternativeEstimate!.estimate - truth);
      improved += Number(after < before - 0.02);
      worsened += Number(after > before + 0.02);
    }
  }
  console.log(`\nUnmeasured confounder of treatment and outcome (n=2000, ${cases} graphs)`);
  console.log(`  the current estimate's interval covers the truth: ${((100 * covered) / cases).toFixed(1)}%. The bias is real and nothing here removes it.`);
  console.log(`  a conflict-flagged fix was on offer in ${((100 * offered) / cases).toFixed(1)}% of graphs: it helped ${improved}, hurt ${worsened}, others no real change.`);
  if (improved > offered * 0.5) {
    failures.push("Fixes appear to remove unmeasured confounding, which they cannot do. Something is wrong with this check.");
  }
}

function coverage(label: string, seed: number, simulateRow: (random: Random) => string, header: string, spec: string, truth: number, context: DataContext = {}) {
  const random = createRandom(seed);
  const pairs = spec.split(",").map((edge) => edge.trim().split("->").map((part) => part.trim()) as [string, string]);
  const ids = [...new Set(pairs.flat())];
  const graph: GraphSpec = {
    nodes: ids.map((id) => ({ id, label: id, x: 0, y: 0 })),
    edges: pairs.map(([source, target]) => ({ id: `${source}->${target}`, source, target })),
    treatmentId: "X",
    outcomeId: "Y",
  };
  let covered = 0;
  const estimates: number[] = [];
  for (let index = 0; index < RUNS; index += 1) {
    const lines = [header];
    for (let row = 0; row < 1000; row += 1) {
      lines.push(simulateRow(random));
    }
    const estimate = run(graph, lines.join("\n"), context).effect!.estimate!;
    covered += Number(estimate.ciLow <= truth && truth <= estimate.ciHigh);
    estimates.push(estimate.estimate);
  }
  const rate = (100 * covered) / RUNS;
  const mean = estimates.reduce((total, value) => total + value, 0) / RUNS;
  console.log(`  ${label.padEnd(46)} ${expectBetween(`${label} coverage`, rate, 88, 99).padStart(6)}%   mean estimate ${mean.toFixed(3)} (truth ${truth})`);
}

console.log(`\nDoes "95% CI" mean 95%? (n=1000, ${RUNS} simulated files each)`);
const logistic = (x: number) => 1 / (1 + Math.exp(-x));
coverage(
  "AIPW ATE, continuous outcome",
  3000,
  (r) => {
    const z = r.normal();
    const x = r.uniform() < logistic(z) ? 1 : 0;
    return `${x},${(2 * x + 0.8 * z + r.normal()).toFixed(5)},${z.toFixed(5)}`;
  },
  "X,Y,Z",
  "Z -> X, Z -> Y, X -> Y",
  2,
);
coverage(
  "AIPW ATT, effect varies with Z",
  3001,
  (r) => {
    const z = Math.abs(r.normal()) * (r.uniform() < 0.5 ? -1 : 1);
    const x = r.uniform() < (z > 0 ? 0.75 : 0.25) ? 1 : 0;
    return `${x},${((z > 0 ? 3 : 1) * x + 0.5 * z + r.normal()).toFixed(5)},${z.toFixed(5)}`;
  },
  "X,Y,Z",
  "Z -> X, Z -> Y, X -> Y",
  0.75 * 3 + 0.25 * 1,
  { estimand: "att" },
);
coverage(
  "linear regression, numeric treatment",
  3002,
  (r) => {
    const z = r.normal();
    const x = 0.7 * z + r.normal();
    return `${x.toFixed(5)},${(0.5 * x + z + r.normal() * (0.5 + Math.abs(z))).toFixed(5)},${z.toFixed(5)}`;
  },
  "X,Y,Z",
  "Z -> X, Z -> Y, X -> Y",
  0.5,
);
coverage(
  "logistic regression, log odds ratio",
  3003,
  (r) => {
    const z = r.normal();
    const x = 0.7 * z + r.normal();
    return `${x.toFixed(5)},${r.uniform() < logistic(0.6 * x + 0.8 * z) ? 1 : 0},${z.toFixed(5)}`;
  },
  "X,Y,Z",
  "Z -> X, Z -> Y, X -> Y",
  0.6,
);

// When both sets are valid, a shift is pure noise, so "moved by more than noise" should be rare.
{
  const random = createRandom(4000);
  let exceeded = 0;
  let cases = 0;
  const spec = "Z -> X, Z -> Y, V -> Y, X -> Y";
  const pairs = spec.split(",").map((edge) => edge.trim().split("->").map((part) => part.trim()) as [string, string]);
  const ids = [...new Set(pairs.flat())];
  const graph: GraphSpec = {
    nodes: ids.map((id) => ({ id, label: id, x: 0, y: 0 })),
    edges: pairs.map(([source, target]) => ({ id: `${source}->${target}`, source, target })),
    treatmentId: "X",
    outcomeId: "Y",
  };
  for (let index = 0; index < RUNS; index += 1) {
    const lines = ["X,Y,Z,V"];
    for (let row = 0; row < 1000; row += 1) {
      const z = random.normal();
      const v = random.normal();
      const x = random.uniform() < logistic(z) ? 1 : 0;
      lines.push(`${x},${(2 * x + 0.8 * z + 0.9 * v + random.normal()).toFixed(5)},${z.toFixed(5)},${v.toFixed(5)}`);
    }
    const entry = run(graph, lines.join("\n")).audit!.assumptions.find((item) => item.id === "add:V:X");
    if (entry?.shift !== null && entry?.shift !== undefined && entry.shiftStandardError) {
      cases += 1;
      exceeded += Number(Math.abs(entry.shift) > 1.96 * entry.shiftStandardError);
    }
  }
  const rate = (100 * exceeded) / cases;
  console.log(`\nA shift between two valid sets is noise. Share called larger than noise (should be near 5%):`);
  console.log(`  ${expectBetween("noise-level shifts", rate, 1, 11)}%  across ${cases} files`);
}

// What the app says about something unmeasured: a confounder weaker than the robustness value in both
// treatment and outcome cannot bring the estimate to zero, and the bound holds for a confounder of a given
// strength. Here the "unmeasured" variable U is in the file, so its true strength and true bias can be measured.
{
  const contextOf = (csv: string): EffectContext => {
    const table = parseDataset({ content: csv });
    const bound = (column: string) => ({ column, type: inferVariableType(table.columns.get(column)!.filter((value) => !isMissing(value))) });
    return { table, treatment: bound("X"), outcome: bound("Y"), estimand: "ate", columnOf: (node) => (table.columns.has(node) ? bound(node) : null) };
  };
  const fitOf = (context: EffectContext, set: string[]): EffectFit | null => {
    const outcome = fitEffect(context, set, [], { detail: true });
    return outcome.ok ? outcome.fit : null;
  };
  const columnOf = (context: EffectContext, name: string) => Float64Array.from(context.table.columns.get(name)!, Number);
  const residualSum = (columns: Float64Array[], target: Float64Array) => {
    const { residuals } = fitOls(columns, target);
    return residuals.reduce((total, value) => total + value * value, 0);
  };

  /** U's real strength over the current set {Z}, on the same scale as the bound. */
  const strengthOverShort = (context: EffectContext, short: EffectFit, long: EffectFit) => {
    if (short.bound && long.bound) {
      return {
        outcomeShare: Math.max(0, (short.bound.sigma2 - long.bound.sigma2) / short.bound.sigma2),
        treatmentShare: Math.max(0, 1 - short.bound.nu2 / long.bound.nu2),
      };
    }
    const intercept = new Float64Array(context.table.rowCount).fill(1);
    const [x, y, z, u] = ["X", "Y", "Z", "U"].map((name) => columnOf(context, name));
    const outcomeShort = residualSum([intercept, x, z], y);
    const treatmentShort = residualSum([intercept, z], x);
    return {
      outcomeShare: (outcomeShort - residualSum([intercept, x, z, u], y)) / outcomeShort,
      treatmentShare: (treatmentShort - residualSum([intercept, z, u], x)) / treatmentShort,
    };
  };

  type Simulator = (random: Random, strength: number) => string;
  const scenarios: { label: string; simulate: Simulator }[] = [
    {
      label: "two-value treatment, numeric outcome",
      simulate: (random, b) => {
        const [z, u] = [random.normal(), random.normal()];
        const x = random.uniform() < logistic(0.7 * z + b * u) ? 1 : 0;
        return `${x},${(0.6 * z + b * u + random.normal()).toFixed(5)},${z.toFixed(5)},${u.toFixed(5)}`;
      },
    },
    {
      label: "two-value treatment, two-value outcome",
      simulate: (random, b) => {
        const [z, u] = [random.normal(), random.normal()];
        const x = random.uniform() < logistic(0.7 * z + b * u) ? 1 : 0;
        const y = random.uniform() < logistic(0.6 * z + 1.5 * b * u) ? 1 : 0;
        return `${x},${y},${z.toFixed(5)},${u.toFixed(5)}`;
      },
    },
    {
      label: "two-value treatment, nonlinear confounder",
      simulate: (random, b) => {
        const [z, u] = [random.normal(), random.normal()];
        const x = random.uniform() < logistic(0.7 * z + b * Math.tanh(2 * u)) ? 1 : 0;
        return `${x},${(0.6 * z + b * Math.tanh(2 * u) + random.normal()).toFixed(5)},${z.toFixed(5)},${u.toFixed(5)}`;
      },
    },
    {
      label: "numeric treatment, numeric outcome",
      simulate: (random, b) => {
        const [z, u] = [random.normal(), random.normal()];
        const x = 0.7 * z + b * u + random.normal();
        return `${x.toFixed(5)},${(0.6 * z + b * u + random.normal()).toFixed(5)},${z.toFixed(5)},${u.toFixed(5)}`;
      },
    },
  ];

  const quantile = (values: number[], share: number) => [...values].sort((a, b) => a - b)[Math.floor((values.length - 1) * share)] ?? Number.NaN;

  console.log("\nSomething unmeasured, with no true effect, so all of the estimate is bias from U.");
  console.log("True bias / the bound for U's true strength, and how often U is at least as strong as the robustness value:");
  console.log("scenario                                 median  95th pct  U at least the value");
  let seed = 5000;
  for (const { label, simulate } of scenarios) {
    const random = createRandom((seed += 1));
    const ratios: number[] = [];
    const strongEnough: boolean[] = [];
    for (let index = 0; index < RUNS; index += 1) {
      const strength = 0.4 + random.uniform() * 0.8;
      const csv = ["X,Y,Z,U", ...Array.from({ length: 1000 }, () => simulate(random, strength))].join("\n");
      const context = contextOf(csv);
      const short = fitOf(context, ["Z"]);
      const long = fitOf(context, ["Z", "U"]);
      const start = short && startRobustness(short, context, ["Z"]);
      if (!short || !long || !start) {
        continue;
      }
      const { treatmentShare, outcomeShare } = strengthOverShort(context, short, long);
      const scale = Math.abs(short.estimate) / Math.sqrt(start.summary.ratio);
      ratios.push(Math.abs(short.estimate - long.estimate) / (scale * Math.sqrt((outcomeShare * treatmentShare) / (1 - treatmentShare))));
      // With no true effect, a U weaker than the value in both respects could not have produced this estimate.
      strongEnough.push(Math.max(treatmentShare, outcomeShare) >= start.summary.value);
    }
    // For a linear regression the bound is an identity, so the ratio is exactly 1 up to rounding. For AIPW it is
    // a bound in the population, so a single file can overshoot a little. A linear model cannot measure the
    // strength of a nonlinear U at all (its share can come out as 0), so that row checks only the value.
    const nonlinear = label.includes("nonlinear");
    const typical = nonlinear ? "-" : expectBetween(`${label}: median bias / bound`, quantile(ratios, 0.5), 0.3, 1.02);
    const high = nonlinear ? "-" : expectBetween(`${label}: 95th percentile bias / bound`, quantile(ratios, 0.95), 0.3, 1.35);
    const value = expectBetween(`${label}: U stronger than the robustness value`, percent(strongEnough), 90, 100);
    console.log(`${label.padEnd(40)} ${typical.padStart(6)} ${high.padStart(9)} ${value.padStart(20)}%`);
  }

  // A confounder built to be exactly as strong as a measured one: how good a guide is that variable's benchmark?
  console.log("\nU built to be as strong as the measured Z. Its true bias / what Z's benchmark says:");
  console.log("scenario                                 median  5th pct  95th pct");
  for (const [label, simulate] of [
    [
      "two-value treatment, numeric outcome",
      (random: Random) => {
        const [z, u] = [random.normal(), random.normal()];
        const x = random.uniform() < logistic(0.8 * z + 0.8 * u) ? 1 : 0;
        return `${x},${(1 + 0.3 * x + 0.8 * z + 0.8 * u + random.normal()).toFixed(5)},${z.toFixed(5)},${u.toFixed(5)}`;
      },
    ],
    [
      "numeric treatment, numeric outcome",
      (random: Random) => {
        const [z, u] = [random.normal(), random.normal()];
        const x = 0.8 * z + 0.8 * u + random.normal();
        return `${x.toFixed(5)},${(0.3 * x + 0.8 * z + 0.8 * u + random.normal()).toFixed(5)},${z.toFixed(5)},${u.toFixed(5)}`;
      },
    ],
  ] as [string, (random: Random) => string][]) {
    const random = createRandom((seed += 1));
    const ratios: number[] = [];
    for (let index = 0; index < RUNS; index += 1) {
      const csv = ["X,Y,Z,U", ...Array.from({ length: 1000 }, () => simulate(random))].join("\n");
      const context = contextOf(csv);
      const full = fitOf(context, ["Z"]);
      const long = fitOf(context, ["Z", "U"]);
      const without = fitOf(context, []);
      const benchmark = full && without && startRobustness(full, context, ["Z"])?.benchmark("Z", without);
      if (full && long && benchmark) {
        ratios.push(Math.abs(full.estimate - long.estimate) / (benchmark.shareOfEstimate * Math.abs(full.estimate)));
      }
    }
    // Centred on 1: the benchmark is a good guide to the size of the bias, but not an upper limit on it.
    expectBetween(`${label}: median bias / benchmark`, quantile(ratios, 0.5), 0.8, 1.2);
    console.log(`  ${label.padEnd(38)} ${quantile(ratios, 0.5).toFixed(2).padStart(6)} ${quantile(ratios, 0.05).toFixed(2).padStart(8)} ${quantile(ratios, 0.95).toFixed(2).padStart(9)}`);
  }
}

if (failures.length) {
  console.log(`\nFAILED:\n  ${failures.join("\n  ")}`);
  process.exit(1);
}
console.log("\nAll calibration checks are within their bands.");
