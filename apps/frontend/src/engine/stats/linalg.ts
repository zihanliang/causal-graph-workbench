const COLLINEARITY_TOLERANCE = 1e-9;

export function dot(left: Float64Array, right: Float64Array): number {
  let total = 0;
  for (let i = 0; i < left.length; i += 1) {
    total += left[i] * right[i];
  }
  return total;
}

export interface Orthonormalized {
  /** Orthonormal vectors spanning the retained columns. */
  q: Float64Array[];
  /** Input indexes of the retained columns. */
  kept: number[];
  /** Upper triangular factor over the retained columns: column_kept[j] = sum(q[i] * r[i][j]). */
  r: number[][];
}

/**
 * Modified Gram-Schmidt with one round of re-orthogonalization. A column is kept only if it adds
 * something the columns before it cannot express, so collinear inputs drop out instead of breaking
 * the fit.
 */
export function orthonormalize(columns: Float64Array[]): Orthonormalized {
  const q: Float64Array[] = [];
  const kept: number[] = [];
  const rColumns: number[][] = [];

  columns.forEach((column, index) => {
    const originalNorm = Math.sqrt(dot(column, column));
    const residual = Float64Array.from(column);
    const coefficients = new Array<number>(q.length).fill(0);
    for (let pass = 0; pass < 2; pass += 1) {
      q.forEach((vector, position) => {
        const projection = dot(residual, vector);
        coefficients[position] += projection;
        for (let i = 0; i < residual.length; i += 1) {
          residual[i] -= projection * vector[i];
        }
      });
    }
    const norm = Math.sqrt(dot(residual, residual));
    if (originalNorm > 0 && norm > COLLINEARITY_TOLERANCE * originalNorm) {
      for (let i = 0; i < residual.length; i += 1) {
        residual[i] /= norm;
      }
      q.push(residual);
      kept.push(index);
      rColumns.push([...coefficients, norm]);
    }
  });

  const size = kept.length;
  const r = Array.from({ length: size }, () => new Array<number>(size).fill(0));
  rColumns.forEach((values, column) => {
    values.forEach((value, row) => {
      r[row][column] = value;
    });
  });
  return { q, kept, r };
}

/** The part of `target` that the orthonormal vectors cannot explain. */
export function residualize(target: Float64Array, q: Float64Array[]): Float64Array {
  const residual = Float64Array.from(target);
  for (const vector of q) {
    const projection = dot(residual, vector);
    for (let i = 0; i < residual.length; i += 1) {
      residual[i] -= projection * vector[i];
    }
  }
  return residual;
}

export function independentColumns(columns: Float64Array[]): number[] {
  return orthonormalize(columns).kept;
}

/** Inverse of an upper triangular matrix. */
export function invertUpperTriangular(matrix: number[][]): number[][] {
  const size = matrix.length;
  const inverse = Array.from({ length: size }, () => new Array<number>(size).fill(0));
  for (let column = 0; column < size; column += 1) {
    inverse[column][column] = 1 / matrix[column][column];
    for (let row = column - 1; row >= 0; row -= 1) {
      let sum = 0;
      for (let k = row + 1; k <= column; k += 1) {
        sum += matrix[row][k] * inverse[k][column];
      }
      inverse[row][column] = -sum / matrix[row][row];
    }
  }
  return inverse;
}

/** Cholesky factor of a symmetric positive definite matrix, or null when it is not. */
export function cholesky(matrix: number[][]): number[][] | null {
  const size = matrix.length;
  const lower = Array.from({ length: size }, () => new Array<number>(size).fill(0));
  for (let i = 0; i < size; i += 1) {
    for (let j = 0; j <= i; j += 1) {
      let sum = matrix[i][j];
      for (let k = 0; k < j; k += 1) {
        sum -= lower[i][k] * lower[j][k];
      }
      if (i === j) {
        if (!(sum > 0) || !Number.isFinite(sum)) {
          return null;
        }
        lower[i][i] = Math.sqrt(sum);
      } else {
        lower[i][j] = sum / lower[j][j];
      }
    }
  }
  return lower;
}

export function solveWithCholesky(lower: number[][], right: number[]): number[] {
  const size = lower.length;
  const forward = new Array<number>(size);
  for (let i = 0; i < size; i += 1) {
    let sum = right[i];
    for (let k = 0; k < i; k += 1) {
      sum -= lower[i][k] * forward[k];
    }
    forward[i] = sum / lower[i][i];
  }
  const solution = new Array<number>(size);
  for (let i = size - 1; i >= 0; i -= 1) {
    let sum = forward[i];
    for (let k = i + 1; k < size; k += 1) {
      sum -= lower[k][i] * solution[k];
    }
    solution[i] = sum / lower[i][i];
  }
  return solution;
}

export function invertFromCholesky(lower: number[][]): number[][] {
  const size = lower.length;
  const columns: number[][] = [];
  for (let column = 0; column < size; column += 1) {
    const unit = new Array<number>(size).fill(0);
    unit[column] = 1;
    columns.push(solveWithCholesky(lower, unit));
  }
  return columns;
}
