import { dot, invertUpperTriangular, orthonormalize } from "./linalg";

/** Ordinary least squares with HC1 standard errors, checked against statsmodels in `stats.test.ts`. */
export interface OlsFit {
  /** Coefficients for the retained columns, on the original scale. */
  params: number[];
  /** Input indexes of the retained columns, in the order of `params`. */
  keptColumns: number[];
  droppedColumns: number[];
  residuals: Float64Array;
  /** Matches statsmodels `cov_type="HC1"`. */
  robustStandardErrors: () => number[];
  /** Per-row contribution to a retained coefficient: its mean is 0 and its variance / n is the HC0 variance. */
  coefficientInfluence: (inputColumn: number) => Float64Array;
}

export function fitOls(columns: Float64Array[], y: Float64Array): OlsFit {
  const rowCount = y.length;
  // Scaling each column to unit length keeps badly scaled covariates numerically stable.
  const norms = columns.map((column) => Math.sqrt(dot(column, column)) || 1);
  const scaled = columns.map((column, index) => Float64Array.from(column, (value) => value / norms[index]));
  const { q, kept, r } = orthonormalize(scaled);
  const rInverse = invertUpperTriangular(r);
  const size = kept.length;

  const qty = q.map((vector) => dot(vector, y));
  const scaledParams = rInverse.map((row) => row.reduce((total, value, index) => total + value * qty[index], 0));
  const params = scaledParams.map((value, position) => value / norms[kept[position]]);

  const residuals = Float64Array.from(y);
  q.forEach((vector, position) => {
    for (let i = 0; i < rowCount; i += 1) {
      residuals[i] -= vector[i] * qty[position];
    }
  });

  // Coefficient j is a weighted sum of y, with row weights (X'X)^-1 X'_i = R^-1 Q'_i.
  const rowWeight = (row: number, target: number): number => {
    let total = 0;
    for (let k = target; k < size; k += 1) {
      total += rInverse[target][k] * q[k][row];
    }
    return total / norms[kept[target]];
  };

  return {
    params,
    keptColumns: kept,
    droppedColumns: columns.map((_, index) => index).filter((index) => !kept.includes(index)),
    residuals,
    robustStandardErrors: () => {
      const correction = rowCount / (rowCount - size);
      return kept.map((_, target) => {
        let total = 0;
        for (let row = 0; row < rowCount; row += 1) {
          const contribution = rowWeight(row, target) * residuals[row];
          total += contribution * contribution;
        }
        return Math.sqrt(correction * total);
      });
    },
    coefficientInfluence: (inputColumn) => {
      const target = kept.indexOf(inputColumn);
      const influence = new Float64Array(rowCount);
      for (let row = 0; row < rowCount; row += 1) {
        influence[row] = rowCount * rowWeight(row, target) * residuals[row];
      }
      return influence;
    },
  };
}
