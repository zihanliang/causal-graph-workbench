/** Student's t quantile, checked against scipy in `stats.test.ts`. No tabulated coefficients. */

function logGamma(x: number): number {
  // Lanczos approximation (g = 7, n = 9).
  const coefficients = [
    0.99999999999980993, 676.5203681218851, -1259.1392167224028, 771.32342877765313, -176.61502916214059, 12.507343278686905,
    -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7,
  ];
  if (x < 0.5) {
    return Math.log(Math.PI / Math.abs(Math.sin(Math.PI * x))) - logGamma(1 - x);
  }
  const shifted = x - 1;
  let series = coefficients[0];
  for (let i = 1; i < coefficients.length; i += 1) {
    series += coefficients[i] / (shifted + i);
  }
  const t = shifted + 7.5;
  return 0.5 * Math.log(2 * Math.PI) + (shifted + 0.5) * Math.log(t) - t + Math.log(series);
}

/** Continued fraction for the incomplete beta function, by the modified Lentz method. */
function betaContinuedFraction(x: number, a: number, b: number): number {
  const tiny = 1e-300;
  const sum = a + b;
  let c = 1;
  let d = 1 - (sum * x) / (a + 1);
  d = Math.abs(d) < tiny ? tiny : d;
  d = 1 / d;
  let result = d;
  for (let m = 1; m <= 500; m += 1) {
    const doubled = 2 * m;
    let term = (m * (b - m) * x) / ((a + doubled - 1) * (a + doubled));
    d = 1 + term * d;
    d = Math.abs(d) < tiny ? tiny : d;
    c = 1 + term / c;
    c = Math.abs(c) < tiny ? tiny : c;
    d = 1 / d;
    result *= d * c;
    term = (-(a + m) * (sum + m) * x) / ((a + doubled) * (a + doubled + 1));
    d = 1 + term * d;
    d = Math.abs(d) < tiny ? tiny : d;
    c = 1 + term / c;
    c = Math.abs(c) < tiny ? tiny : c;
    d = 1 / d;
    const change = d * c;
    result *= change;
    if (Math.abs(change - 1) < 1e-15) {
      break;
    }
  }
  return result;
}

function regularizedIncompleteBeta(x: number, a: number, b: number): number {
  if (x <= 0) {
    return 0;
  }
  if (x >= 1) {
    return 1;
  }
  const front = Math.exp(logGamma(a + b) - logGamma(a) - logGamma(b) + a * Math.log(x) + b * Math.log(1 - x));
  return x < (a + 1) / (a + b + 2) ? (front * betaContinuedFraction(x, a, b)) / a : 1 - (front * betaContinuedFraction(1 - x, b, a)) / b;
}

function studentTCdf(t: number, df: number): number {
  const tail = 0.5 * regularizedIncompleteBeta(df / (df + t * t), df / 2, 0.5);
  return t >= 0 ? 1 - tail : tail;
}

/** The value below which a share `p` of a t distribution with `df` degrees of freedom lies. */
export function studentTQuantile(p: number, df: number): number {
  if (p === 0.5) {
    return 0;
  }
  if (p < 0.5) {
    return -studentTQuantile(1 - p, df);
  }
  let low = 0;
  let high = 1;
  while (studentTCdf(high, df) < p && high < 1e12) {
    high *= 2;
  }
  for (let i = 0; i < 200 && high - low > 1e-12 * Math.max(1, high); i += 1) {
    const middle = (low + high) / 2;
    if (studentTCdf(middle, df) < p) {
      low = middle;
    } else {
      high = middle;
    }
  }
  return (low + high) / 2;
}
