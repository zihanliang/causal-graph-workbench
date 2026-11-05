"""Monte Carlo: when the user's DAG is wrong by one edge, does the stress test find it? When right, does it stay quiet?"""
import sys
import time

import networkx as nx
import numpy as np
from scipy import stats

from stress_core import backdoor_valid, holm, minimal_set, missing_edge_basis, o_set, perturbations

SEED = 20261104
rng = np.random.default_rng(SEED)
N_NODES = 10
EDGE_P = 0.3
N_OBS = 2000
N_SIM = int(sys.argv[1]) if len(sys.argv) > 1 else 300


def sim_graph():
    while True:
        names = [f"V{i}" for i in range(N_NODES)]
        B = np.zeros((N_NODES, N_NODES))
        G = nx.DiGraph()
        G.add_nodes_from(names)
        for i in range(N_NODES):
            for j in range(i + 1, N_NODES):
                if rng.random() < EDGE_P:
                    w = rng.uniform(0.2, 0.8) * rng.choice([-1, 1])
                    B[j, i] = w
                    G.add_edge(names[i], names[j], w=w)
        cands = [(names[a], names[b]) for a in range(3, 7) for b in range(a + 1, N_NODES) if nx.has_path(G, names[a], names[b])]
        if not cands:
            continue
        T, Y = cands[rng.integers(len(cands))]
        return G, B, names, T, Y


def gen_data(B):
    eps = rng.normal(size=(N_OBS, N_NODES))
    return np.linalg.solve(np.eye(N_NODES) - B, eps.T).T  # X = (I-B)^{-1} eps


def true_effect(B, names, T, Y):
    M = np.linalg.inv(np.eye(N_NODES) - B)
    return M[names.index(Y), names.index(T)]


def ols_coef(data, names, T, Y, S):
    idx = [names.index(T)] + [names.index(s) for s in sorted(S)]
    X = np.column_stack([np.ones(N_OBS), data[:, idx]])
    y = data[:, names.index(Y)]
    beta, *_ = np.linalg.lstsq(X, y, rcond=None)
    resid = y - X @ beta
    s2 = resid @ resid / (N_OBS - X.shape[1])
    se = np.sqrt(s2 * np.linalg.inv(X.T @ X)[1, 1])
    return beta[1], se


def pcorr_p(data, names, a, b, cond):
    idx = [names.index(c) for c in cond]
    X = np.column_stack([np.ones(N_OBS)] + ([data[:, idx]] if idx else []))
    r1 = data[:, names.index(a)] - X @ np.linalg.lstsq(X, data[:, names.index(a)], rcond=None)[0]
    r2 = data[:, names.index(b)] - X @ np.linalg.lstsq(X, data[:, names.index(b)], rcond=None)[0]
    r = np.corrcoef(r1, r2)[0, 1]
    dof = N_OBS - len(idx) - 2
    t = r * np.sqrt(dof / (1 - r * r))
    return 2 * stats.t.sf(abs(t), dof), r


def run_user_dag(user_G, data, names, T, Y, baseline):
    """Return: list of breaking edits (u,v,kind), set of data-contradicted unordered pairs, baseline est."""
    breaks = []
    total = 0
    for kind, u, v, H in perturbations(user_G):
        total += 1
        if not backdoor_valid(H, T, Y, baseline):
            breaks.append((kind, u, v, H))
    basis = missing_edge_basis(user_G)
    pr = [pcorr_p(data, names, a, b, c) for a, b, c in basis]
    adj = holm([p for p, _ in pr])
    flagged = {frozenset((a, b)) for (a, b, _), p in zip(basis, adj) if p < 0.05}
    return breaks, flagged, total, len(basis)


def valid_or_none(G, S, T, Y):
    return S is not None and backdoor_valid(G, T, Y, S)


res = {
    "correct": {"small": [], "o": []},
    "harmful": {"small": [], "o": []},
}
fragility = {"small": [], "o": []}
harm_rate = {"small": [], "o": []}
false_rej = []
start = time.time()
sims = 0
while sims < N_SIM:
    G, B, names, T, Y = sim_graph()
    data = gen_data(B)
    tau = true_effect(B, names, T, Y)
    sims += 1

    # A. User's DAG is exactly right: how noisy is the tool?
    for key, base in (("small", minimal_set(G, T, Y)), ("o", o_set(G, T, Y))):
        if base is None:
            continue
        breaks, flagged, total, nb = run_user_dag(G, data, names, T, Y, base)
        fragility[key].append(len(breaks) / max(total, 1))
        hit = [b for b in breaks if frozenset((b[1], b[2])) in flagged and b[0] == "add"]
        res["correct"][key].append(dict(n_rej=len(flagged), n_test=nb, priority=len(hit), n_break=len(breaks), total=total))

    # B. User omitted one true edge. Which omissions break the recommended set?
    edges = list(G.edges)
    for key, chooser in (("small", minimal_set), ("o", o_set)):
        harmful = []
        for u, v in edges:
            U = G.copy()
            U.remove_edge(u, v)
            s = chooser(U, T, Y)
            if s is None or not backdoor_valid(U, T, Y, s):
                continue
            if not backdoor_valid(G, T, Y, s):
                harmful.append((u, v, s, U))
        harm_rate[key].append(len(harmful) / max(len(edges), 1))
        if not harmful:
            continue
        u, v, s, U = harmful[rng.integers(len(harmful))]
        est, se = ols_coef(data, names, T, Y, s)
        breaks, flagged, total, nb = run_user_dag(U, data, names, T, Y, s)
        # 'true edit' is the omitted edge, adding it
        in_breaks = any(k == "add" and a == u and b == v for k, a, b, _ in breaks)
        pair = frozenset((u, v))
        data_flag = pair in flagged
        priority = [b for b in breaks if b[0] == "add" and frozenset((b[1], b[2])) in flagged]
        # best fix: apply edit that is top-ranked among data-flagged breaking candidates by |Δ estimate|
        scored = []
        for k, a, b, H in priority:
            s2 = chooser(H, T, Y)
            if s2 is None or not backdoor_valid(H, T, Y, s2):
                continue
            e2, _ = ols_coef(data, names, T, Y, s2)
            scored.append((abs(e2 - est), a, b, e2))
        scored.sort(reverse=True)
        top_hit = bool(scored) and frozenset((scored[0][1], scored[0][2])) == pair
        any_hit = any(frozenset((a, b)) == pair for _, a, b, _ in scored)
        fixed_est = scored[0][3] if scored else est
        res["harmful"][key].append(
            dict(
                in_breaks=in_breaks,
                data_flag=data_flag,
                n_break=len(breaks),
                total=total,
                n_priority=len(priority),
                n_flag=len(flagged),
                top_hit=top_hit,
                any_hit=any_hit,
                err_before=abs(est - tau),
                err_after=abs(fixed_est - tau),
                true_sig=abs(est - tau) > 1.96 * se,
                changed=bool(scored),
            )
        )

print(f"{sims} simulated graphs, n={N_OBS}, {N_NODES} nodes, p={EDGE_P}, {time.time()-start:.0f}s\n")
print("=== How fragile is each recommendation style? ===")
for key, name in (("small", "minimal set (current product style)"), ("o", "O-set (Henckel)")):
    print(f"{name:38s}: omitting ONE true edge invalidates the set for {np.mean(harm_rate[key])*100:5.1f}% of edges | "
          f"share of all single-edge errors that break it {np.mean(fragility[key])*100:5.1f}%")

print("\n=== User's DAG is CORRECT (false alarms) ===")
for key in ("small", "o"):
    rows = res["correct"][key]
    print(f"[{key}] tests per DAG={np.mean([r['n_test'] for r in rows]):.1f}, DAGs with ≥1 Holm rejection={np.mean([r['n_rej']>0 for r in rows])*100:.1f}%, "
          f"breaking edits per DAG={np.mean([r['n_break'] for r in rows]):.1f}/{np.mean([r['total'] for r in rows]):.0f}, "
          f"'priority' items (breaking AND data-flagged)={np.mean([r['priority'] for r in rows]):.3f}")

print("\n=== User's DAG omits one edge that truly breaks the set ===")
for key in ("small", "o"):
    rows = res["harmful"][key]
    if not rows:
        continue
    get = lambda k: np.array([r[k] for r in rows], float)
    print(f"[{key}] cases={len(rows)}")
    print(f"   the true edge is in the graph-only 'breaking' list: {get('in_breaks').mean()*100:.1f}% (list length mean {get('n_break').mean():.1f} of {get('total').mean():.0f})")
    print(f"   the data flags that exact pair (Holm)             : {get('data_flag').mean()*100:.1f}%")
    print(f"   priority list (breaking ∩ data-flagged) length    : mean {get('n_priority').mean():.2f}, median {np.median(get('n_priority')):.0f}")
    print(f"   true edge ranked #1 in priority list              : {get('top_hit').mean()*100:.1f}% | present anywhere: {get('any_hit').mean()*100:.1f}%")
    print(f"   mean |error| before → after applying top item     : {get('err_before').mean():.3f} → {get('err_after').mean():.3f}; median {np.median(get('err_before')):.3f} → {np.median(get('err_after')):.3f}")
    print(f"   cases where the baseline CI actually misses truth : {get('true_sig').mean()*100:.1f}%")
    print(f"   top item made error smaller                       : {(get('err_after')<get('err_before')).mean()*100:.1f}%, larger: {(get('err_after')>get('err_before')).mean()*100:.1f}%, unchanged: {(get('err_after')==get('err_before')).mean()*100:.1f}%")
