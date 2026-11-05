import { cholesky, independentColumns, invertFromCholesky, solveWithCholesky } from "./linalg";

/**
 * Logistic regression by Newton-Raphson, checked against statsmodels in `stats.test.ts`.
 *
 * Columns are standardized internally so that badly scaled covariates (income next to a rate) stay
 * numerically stable; results are transformed back to the original scale.
 */

export interface LogisticInput {
  /** Design columns, each with one value per row. The first must be the intercept. */
  columns: Float64Array[];
  y: Float64Array;
  maxIterations?: number;
}

export interface LogisticFit {
  /** Coefficients on the original scale, one per retained column. */
  params: number[];
  standardErrors: number[];
  logLikelihood: number;
  fitted: Float64Array;
  converged: boolean;
  iterations: number;
  /** Indexes of input columns removed because they were collinear with earlier ones. */
  droppedColumns: number[];
  /** Fitted probabilities pile up at exactly 0 or 1, so some units can only ever be in one group. */
  separationSuspected: boolean;
  /** Input indexes of the retained columns, in the order of `params`. */
  keptColumns: number[];
  /** Sandwich standard errors, matching statsmodels `cov_type="HC1"`, which applies no small-sample factor to Logit. */
  robustStandardErrors: () => number[];
  /** Per-row contribution to a retained coefficient: its mean is 0 and its variance / n is the HC0 variance. */
  coefficientInfluence: (inputColumn: number) => Float64Array;
}

const CONVERGENCE_TOLERANCE = 1e-10;
const SATURATED_LINEAR_PREDICTOR = 20;

function mean(values: Float64Array): number {
  let total = 0;
  for (let i = 0; i < values.length; i += 1) {
    total += values[i];
  }
  return total / values.length;
}

function standardDeviation(values: Float64Array, center: number): number {
  let total = 0;
  for (let i = 0; i < values.length; i += 1) {
    const difference = values[i] - center;
    total += difference * difference;
  }
  return Math.sqrt(total / values.length);
}

function logLikelihoodAt(columns: Float64Array[], y: Float64Array, beta: number[]): number {
  let total = 0;
  for (let row = 0; row < y.length; row += 1) {
    let eta = 0;
    for (let j = 0; j < columns.length; j += 1) {
      eta += columns[j][row] * beta[j];
    }
    // log(p) = -log(1 + exp(-eta)); written so that large |eta| does not overflow.
    total += y[row] === 1 ? -Math.log1p(Math.exp(-eta)) : -Math.log1p(Math.exp(eta));
  }
  return total;
}

export function fitLogistic({ columns, y, maxIterations = 50 }: LogisticInput): LogisticFit {
  const rowCount = y.length;
  const means = columns.map((column, index) => (index === 0 ? 0 : mean(column)));
  const scales = columns.map((column, index) => {
    if (index === 0) {
      return 1;
    }
    const sd = standardDeviation(column, means[index]);
    return sd > 0 ? sd : 1;
  });
  const standardized = columns.map((column, index) => {
    if (index === 0) {
      return column;
    }
    const scaled = new Float64Array(rowCount);
    for (let row = 0; row < rowCount; row += 1) {
      scaled[row] = (column[row] - means[index]) / scales[index];
    }
    return scaled;
  });

  const kept = independentColumns(standardized);
  const droppedColumns = columns.map((_, index) => index).filter((index) => !kept.includes(index));
  const design = kept.map((index) => standardized[index]);
  const parameterCount = design.length;

  let beta = new Array<number>(parameterCount).fill(0);
  let logLikelihood = logLikelihoodAt(design, y, beta);
  let converged = false;
  let iterations = 0;
  let hessianFactor: number[][] | null = null;

  const assemble = (at: number[]) => {
    const gradient = new Array<number>(parameterCount).fill(0);
    const hessian = Array.from({ length: parameterCount }, () => new Array<number>(parameterCount).fill(0));
    for (let row = 0; row < rowCount; row += 1) {
      let eta = 0;
      for (let j = 0; j < parameterCount; j += 1) {
        eta += design[j][row] * at[j];
      }
      const probability = 1 / (1 + Math.exp(-eta));
      const weight = probability * (1 - probability);
      const residual = y[row] - probability;
      for (let j = 0; j < parameterCount; j += 1) {
        const value = design[j][row];
        gradient[j] += value * residual;
        for (let k = 0; k <= j; k += 1) {
          hessian[j][k] += weight * value * design[k][row];
        }
      }
    }
    for (let j = 0; j < parameterCount; j += 1) {
      for (let k = j + 1; k < parameterCount; k += 1) {
        hessian[j][k] = hessian[k][j];
      }
    }
    return { gradient, hessian };
  };

  for (iterations = 1; iterations <= maxIterations; iterations += 1) {
    const { gradient, hessian } = assemble(beta);
    hessianFactor = cholesky(hessian);
    if (!hessianFactor) {
      break;
    }
    const direction = solveWithCholesky(hessianFactor, gradient);

    let stepSize = 1;
    let candidate = beta.map((value, index) => value + direction[index]);
    let candidateLikelihood = logLikelihoodAt(design, y, candidate);
    while (candidateLikelihood < logLikelihood - 1e-12 && stepSize > 1 / 1024) {
      stepSize /= 2;
      candidate = beta.map((value, index) => value + stepSize * direction[index]);
      candidateLikelihood = logLikelihoodAt(design, y, candidate);
    }

    const largestChange = Math.max(...direction.map((value) => Math.abs(value * stepSize)));
    beta = candidate;
    logLikelihood = candidateLikelihood;
    if (largestChange < CONVERGENCE_TOLERANCE) {
      converged = true;
      break;
    }
  }

  const fitted = new Float64Array(rowCount);
  let saturatedRows = 0;
  for (let row = 0; row < rowCount; row += 1) {
    let eta = 0;
    for (let j = 0; j < parameterCount; j += 1) {
      eta += design[j][row] * beta[j];
    }
    if (Math.abs(eta) >= SATURATED_LINEAR_PREDICTOR) {
      saturatedRows += 1;
    }
    fitted[row] = 1 / (1 + Math.exp(-eta));
  }

  const finalHessian = cholesky(assemble(beta).hessian);
  const covariance = finalHessian ? invertFromCholesky(finalHessian) : null;
  const { params, standardErrors, jacobian } = toOriginalScale(beta, covariance, kept, means, scales);

  // Row weights on the scale of the original coefficients: J * inverse(H) * x_i * (y_i - p_i).
  const rowWeights = (row: number, target: number): number => {
    if (!covariance) {
      return Number.NaN;
    }
    let total = 0;
    for (let k = 0; k < parameterCount; k += 1) {
      let inner = 0;
      for (let j = 0; j < parameterCount; j += 1) {
        inner += covariance[k][j] * design[j][row];
      }
      total += jacobian[target][k] * inner;
    }
    return total * (y[row] - fitted[row]);
  };

  return {
    params,
    standardErrors,
    logLikelihood,
    fitted,
    converged,
    iterations: Math.min(iterations, maxIterations),
    droppedColumns,
    separationSuspected: !converged || saturatedRows > 0,
    keptColumns: kept,
    robustStandardErrors: () =>
      params.map((_, target) => {
        let total = 0;
        for (let row = 0; row < rowCount; row += 1) {
          const weight = rowWeights(row, target);
          total += weight * weight;
        }
        return Math.sqrt(total);
      }),
    coefficientInfluence: (inputColumn) => {
      const target = kept.indexOf(inputColumn);
      const influence = new Float64Array(rowCount);
      for (let row = 0; row < rowCount; row += 1) {
        influence[row] = rowCount * rowWeights(row, target);
      }
      return influence;
    },
  };
}

/** beta_j = b_j / s_j and beta_0 = b_0 - sum(b_j * m_j / s_j); covariances follow from the same map. */
function toOriginalScale(
  beta: number[],
  covariance: number[][] | null,
  kept: number[],
  means: number[],
  scales: number[],
): { params: number[]; standardErrors: number[]; jacobian: number[][] } {
  const size = beta.length;
  const jacobian = Array.from({ length: size }, () => new Array<number>(size).fill(0));
  kept.forEach((original, position) => {
    jacobian[position][position] = 1 / scales[original];
    if (position > 0) {
      jacobian[0][position] = -means[original] / scales[original];
    }
  });
  jacobian[0][0] = 1;

  const params = jacobian.map((row) => row.reduce((total, value, index) => total + value * beta[index], 0));
  if (!covariance) {
    return { params, standardErrors: new Array<number>(size).fill(Number.NaN), jacobian };
  }
  const standardErrors = jacobian.map((row) => {
    let variance = 0;
    for (let j = 0; j < size; j += 1) {
      for (let k = 0; k < size; k += 1) {
        variance += row[j] * covariance[j][k] * row[k];
      }
    }
    return Math.sqrt(variance);
  });
  return { params, standardErrors, jacobian };
}
