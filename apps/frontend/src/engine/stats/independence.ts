import { dot, orthonormalize, residualize } from "./linalg";

/**
 * Conditional independence test: the generalised covariance measure (Shah & Peters, 2020) on a flexible
 * regression basis. If A and B are independent given C, then whatever C cannot explain of A should be
 * uncorrelated with whatever C cannot explain of B.
 *
 * Linear partial correlation is not enough here. On nonlinear data it reported a conflict for 68% of
 * correct graphs in simulation, against 6% with this basis (see tools/research/load-bearing-assumptions).
 */

export interface TestVariable {
  /** "numeric" variables get nonlinear terms. "flag" variables are 0/1 and enter as they are. */
  kind: "numeric" | "flag";
  values: Float64Array;
}

export interface IndependenceResult {
  pValue: number;
  correlation: number;
  rowsUsed: number;
}

/** erfc(x) for x >= 0, to near machine precision, without any tabulated coefficients. */
function erfc(x: number): number {
  if (x < 2) {
    // erf(x) = 2/sqrt(pi) * exp(-x^2) * sum(2^n x^(2n+1) / (2n+1)!!), every term positive.
    let term = x;
    let sum = x;
    for (let n = 1; n < 200 && term > 1e-17 * sum; n += 1) {
      term *= (2 * x * x) / (2 * n + 1);
      sum += term;
    }
    return 1 - (2 / Math.sqrt(Math.PI)) * Math.exp(-x * x) * sum;
  }
  // Continued fraction: erfc(x) = exp(-x^2)/sqrt(pi) * 1/(x + (1/2)/(x + (2/2)/(x + ...))).
  let fraction = x;
  for (let k = 80; k >= 1; k -= 1) {
    fraction = x + k / 2 / fraction;
  }
  return Math.exp(-x * x) / (Math.sqrt(Math.PI) * fraction);
}

export function normalTwoSidedP(z: number): number {
  return erfc(Math.abs(z) / Math.SQRT2);
}

/** Holm's step-down adjustment, which controls the chance of any false conflict across a set of tests. */
export function holmAdjust(pValues: number[]): number[] {
  const order = pValues.map((_, index) => index).sort((left, right) => pValues[left] - pValues[right]);
  const adjusted = new Array<number>(pValues.length);
  let running = 0;
  order.forEach((index, rank) => {
    running = Math.max(running, Math.min(1, (pValues.length - rank) * pValues[index]));
    adjusted[index] = running;
  });
  return adjusted;
}

function standardize(values: Float64Array): Float64Array | null {
  let total = 0;
  for (let i = 0; i < values.length; i += 1) {
    total += values[i];
  }
  const mean = total / values.length;
  let squares = 0;
  for (let i = 0; i < values.length; i += 1) {
    squares += (values[i] - mean) ** 2;
  }
  const sd = Math.sqrt(squares / values.length);
  if (!(sd > 0)) {
    return null;
  }
  return Float64Array.from(values, (value) => (value - mean) / sd);
}

function mapped(values: Float64Array, transform: (value: number) => number): Float64Array {
  return Float64Array.from(values, transform);
}

/**
 * Regressors for the conditioning set, most important first. The list is cut to `maxColumns`, because
 * with few rows a rich basis would absorb real signal: curvature and interactions go before main effects.
 */
export function conditioningBasis(condition: TestVariable[], rowCount: number, maxColumns: number): Float64Array[] {
  const numeric: Float64Array[] = [];
  const main: Float64Array[] = [new Float64Array(rowCount).fill(1)];
  for (const variable of condition) {
    if (variable.kind === "flag") {
      main.push(variable.values);
    } else {
      const z = standardize(variable.values);
      if (z) {
        numeric.push(z);
        main.push(z);
      }
    }
  }

  const tiers: Float64Array[][] = [
    main,
    numeric.flatMap((z) => [mapped(z, (v) => v * v), mapped(z, (v) => v * v * v)]),
    numeric.flatMap((z) => [mapped(z, (v) => Math.tanh(2 * v)), mapped(z, (v) => (v > 0 ? 1 : 0))]),
    numeric.flatMap((left, index) =>
      numeric.slice(index + 1).map((right) => Float64Array.from(left, (value, row) => value * right[row])),
    ),
  ];

  const basis: Float64Array[] = [];
  for (const tier of tiers) {
    if (basis.length + tier.length > maxColumns && basis.length) {
      break;
    }
    basis.push(...tier);
  }
  return basis;
}

/** A: nonlinear forms too, so a dependence such as B = A^2 is not invisible to a correlation. */
function targetForms(variable: TestVariable): Float64Array[] {
  if (variable.kind === "flag") {
    return [variable.values];
  }
  const z = standardize(variable.values);
  return z ? [z, mapped(z, (v) => v * v - 1), mapped(z, (v) => (v > 0 ? 1 : 0))] : [];
}

function gcmP(left: Float64Array, right: Float64Array): number {
  const count = left.length;
  let total = 0;
  for (let i = 0; i < count; i += 1) {
    total += left[i] * right[i];
  }
  const mean = total / count;
  let squares = 0;
  for (let i = 0; i < count; i += 1) {
    squares += (left[i] * right[i] - mean) ** 2;
  }
  const sd = Math.sqrt(squares / (count - 1));
  return sd > 0 ? normalTwoSidedP((Math.sqrt(count) * mean) / sd) : 1;
}

/**
 * Tests A ⟂ B | C. A categorical variable is passed as one flag per level. Every form of A is paired
 * with every form of B, with a Bonferroni correction across the pairs.
 */
export function testConditionalIndependence(
  a: TestVariable[],
  b: TestVariable[],
  condition: TestVariable[],
  rowCount: number,
): IndependenceResult {
  const maxColumns = Math.max(2, Math.floor(rowCount / 8));
  const { q } = orthonormalize(conditioningBasis(condition, rowCount, maxColumns));

  const leftForms = a.flatMap(targetForms).map((form) => residualize(form, q));
  const rightForms = b.map((variable) => residualize(variable.values, q));
  let smallest = 1;
  let pairs = 0;
  for (const left of leftForms) {
    for (const right of rightForms) {
      smallest = Math.min(smallest, gcmP(left, right));
      pairs += 1;
    }
  }

  let correlation = 0;
  if (leftForms.length && rightForms.length) {
    const left = leftForms[0];
    const right = rightForms[0];
    const denominator = Math.sqrt(dot(left, left) * dot(right, right));
    correlation = denominator > 0 ? dot(left, right) / denominator : 0;
  }
  return { pValue: Math.min(1, smallest * Math.max(pairs, 1)), correlation, rowsUsed: rowCount };
}
