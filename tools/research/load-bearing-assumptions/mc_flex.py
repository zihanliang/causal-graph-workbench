"""Can a flexible conditional-independence test fix the nonlinear false-alarm problem?"""
import sys
from itertools import combinations

import numpy as np
from scipy import stats

import mc_hard as M
from stress_core import backdoor_valid, holm, minimal_set, missing_edge_basis

N_SIM = int(sys.argv[1]) if len(sys.argv) > 1 else 200


def basis(data, cond):
    n = data.shape[0]
    cols = [np.ones(n)]
    Z = [(data[:, M.NAMES.index(c)] - data[:, M.NAMES.index(c)].mean()) / data[:, M.NAMES.index(c)].std() for c in cond]
    for z in Z:
        cols += [z, z**2, z**3, np.tanh(2 * z), (z > 0).astype(float)]
    for a, b in combinations(Z, 2):
        cols.append(a * b)
    return np.column_stack(cols)


def resid(y, X):
    return y - X @ np.linalg.lstsq(X, y, rcond=None)[0]


def gcm(ra, rb):
    R = ra * rb
    s = R.std(ddof=1)
    if s == 0:
        return 1.0
    return 2 * stats.norm.sf(abs(np.sqrt(len(R)) * R.mean() / s))


def flex_p(data, a, b, cond):
    X = basis(data, cond)
    A = data[:, M.NAMES.index(a)]
    A = (A - A.mean()) / A.std()
    rb = resid(data[:, M.NAMES.index(b)], X)
    ps = [gcm(resid(t, X), rb) for t in (A, A**2 - 1, (A > 0).astype(float))]
    return min(1.0, min(ps) * len(ps))


def lin_p(data, a, b, cond):
    return M.pcorr_p(data, a, b, cond)[0]


def flagged(U, data, fn):
    bs = missing_edge_basis(U)
    ps = [fn(data, a, b, c) for a, b, c in bs]
    adj = holm(ps) if ps else []
    return {frozenset((a, b)) for (a, b, _), p in zip(bs, adj) if p < 0.05}


def run(name, n, w, nonlinear):
    res = {k: dict(fa=[], det=[]) for k in ("linear", "flexible")}
    for _ in range(N_SIM):
        G, T, Y = M.make(*w, nonlinear)
        data, _ = M.simulate(G, n)
        for k, fn in (("linear", lin_p), ("flexible", flex_p)):
            res[k]["fa"].append(bool(flagged(G, data, fn)))
        edges = list(G.edges)
        for _t in range(40):
            u, v = edges[M.rng.integers(len(edges))]
            U = G.copy()
            U.remove_edge(u, v)
            s = minimal_set(U, T, Y)
            if s is None or backdoor_valid(G, T, Y, s):
                continue
            for k, fn in (("linear", lin_p), ("flexible", flex_p)):
                res[k]["det"].append(frozenset((u, v)) in flagged(U, data, fn))
            break
    for k in res:
        print(f"{name:34s} {k:9s}: correct-DAG any-reject {np.mean(res[k]['fa'])*100:5.1f}% | harmful omitted edge detected {np.mean(res[k]['det'])*100:5.1f}% (m={len(res[k]['det'])})")


run("linear SEM, strong, n=2000", 2000, (0.2, 0.8), False)
run("nonlinear SEM, strong, n=2000", 2000, (0.2, 0.8), True)
run("nonlinear SEM, medium, n=2000", 2000, (0.1, 0.3), True)
run("nonlinear SEM, medium, n=500", 500, (0.1, 0.3), True)
