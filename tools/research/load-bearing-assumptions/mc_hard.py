"""Try to break the stress test: weak edges, small n, nonlinear SEMs, latent confounders, several wrong edges."""
import sys
import time

import networkx as nx
import numpy as np
from scipy import stats

from stress_core import backdoor_valid, holm, minimal_set, missing_edge_basis, perturbations

SEED = 77
rng = np.random.default_rng(SEED)
N_NODES = 10
EDGE_P = 0.3
N_SIM = int(sys.argv[1]) if len(sys.argv) > 1 else 200
NAMES = [f"V{i}" for i in range(N_NODES)]
FUNCS = {
    "linear": lambda x: x,
    "tanh": lambda x: np.tanh(2 * x),
    "square": lambda x: x**2 - 1,
    "thresh": lambda x: (x > 0).astype(float) * 2 - 1,
}


def make(w_lo, w_hi, nonlinear):
    while True:
        G = nx.DiGraph()
        G.add_nodes_from(NAMES)
        for i in range(N_NODES):
            for j in range(i + 1, N_NODES):
                if rng.random() < EDGE_P:
                    f = "linear" if not nonlinear else rng.choice(list(FUNCS))
                    G.add_edge(NAMES[i], NAMES[j], w=rng.uniform(w_lo, w_hi) * rng.choice([-1, 1]), f=f)
        pairs = [(NAMES[a], NAMES[b]) for a in range(3, 7) for b in range(a + 1, N_NODES) if nx.has_path(G, NAMES[a], NAMES[b])]
        if pairs:
            T, Y = pairs[rng.integers(len(pairs))]
            return G, T, Y


def simulate(G, n, eps=None, do=None, latent=None):
    """Structural simulation in topological order. `latent`: dict node -> extra additive term."""
    eps = rng.normal(size=(n, N_NODES)) if eps is None else eps
    X = np.zeros((n, N_NODES))
    for j, name in enumerate(NAMES):
        val = eps[:, j].copy()
        for p in G.predecessors(name):
            e = G[p][name]
            val = val + e["w"] * FUNCS[e["f"]](X[:, NAMES.index(p)])
        if latent is not None and name in latent:
            val = val + latent[name]
        if do is not None and name == do[0]:
            val = val + do[1]
        X[:, j] = val
    return X, eps


def true_effect(G, T, Y, latent_builder=None):
    n = 200000
    eps = rng.normal(size=(n, N_NODES))
    lat = latent_builder(n) if latent_builder else None
    X0, _ = simulate(G, n, eps=eps, latent=lat)
    X1, _ = simulate(G, n, eps=eps, do=(T, 1.0), latent=lat)
    return float((X1[:, NAMES.index(Y)] - X0[:, NAMES.index(Y)]).mean())


def ols(data, T, Y, S):
    idx = [NAMES.index(T)] + [NAMES.index(s) for s in sorted(S)]
    n = data.shape[0]
    X = np.column_stack([np.ones(n), data[:, idx]])
    y = data[:, NAMES.index(Y)]
    beta, *_ = np.linalg.lstsq(X, y, rcond=None)
    resid = y - X @ beta
    s2 = resid @ resid / (n - X.shape[1])
    return beta[1], np.sqrt(s2 * np.linalg.inv(X.T @ X)[1, 1])


def pcorr_p(data, a, b, cond):
    n = data.shape[0]
    idx = [NAMES.index(c) for c in cond]
    X = np.column_stack([np.ones(n)] + ([data[:, idx]] if idx else []))
    r1 = data[:, NAMES.index(a)] - X @ np.linalg.lstsq(X, data[:, NAMES.index(a)], rcond=None)[0]
    r2 = data[:, NAMES.index(b)] - X @ np.linalg.lstsq(X, data[:, NAMES.index(b)], rcond=None)[0]
    r = np.corrcoef(r1, r2)[0, 1]
    dof = n - len(idx) - 2
    return 2 * stats.t.sf(abs(r * np.sqrt(dof / (1 - r * r))), dof), r


def flagged_pairs(U, data):
    basis = missing_edge_basis(U)
    pr = [pcorr_p(data, a, b, c) for a, b, c in basis]
    adj = holm([p for p, _ in pr]) if pr else []
    return {frozenset((a, b)) for (a, b, _), p in zip(basis, adj) if p < 0.05}, len(basis)


def priority_list(U, s, T, Y, data):
    flagged, nb = flagged_pairs(U, data)
    est, se = ols(data, T, Y, s)
    scored = []
    n_break = 0
    for kind, a, b, H in perturbations(U):
        if backdoor_valid(H, T, Y, s):
            continue
        n_break += 1
        if kind != "add" or frozenset((a, b)) not in flagged:
            continue
        s2 = minimal_set(H, T, Y)
        if s2 is None or not backdoor_valid(H, T, Y, s2):
            continue
        scored.append((abs(ols(data, T, Y, s2)[0] - est), a, b, ols(data, T, Y, s2)[0]))
    scored.sort(reverse=True)
    return est, se, scored, flagged, n_break, nb


def scenario(name, n, w=(0.2, 0.8), nonlinear=False, k_omit=1):
    cor_any, cor_prio, det, in_prio, top, eb, ea, better, worse, plen, nbreak, covers = [], [], [], [], [], [], [], [], [], [], [], []
    for _ in range(N_SIM):
        G, T, Y = make(*w, nonlinear)
        data, _ = simulate(G, n)
        # correct DAG false alarms
        s = minimal_set(G, T, Y)
        if s is not None:
            est, se, scored, fl, nb_, nb = priority_list(G, s, T, Y, data)
            cor_any.append(bool(fl))
            cor_prio.append(len(scored))
        # omit k edges, require the resulting set to be harmful
        tau = true_effect(G, T, Y)
        edges = list(G.edges)
        for _try in range(40):
            if len(edges) < k_omit:
                break
            pick = [edges[i] for i in rng.choice(len(edges), k_omit, replace=False)]
            U = G.copy()
            U.remove_edges_from(pick)
            s = minimal_set(U, T, Y)
            if s is None or backdoor_valid(G, T, Y, s):
                continue
            est, se, scored, fl, nb_, nb = priority_list(U, s, T, Y, data)
            pairs = {frozenset(p) for p in pick}
            det.append(len(pairs & fl) / len(pairs))
            hit = pairs & {frozenset((a, b)) for _, a, b, _e in scored}
            in_prio.append(len(hit) / len(pairs))
            top.append(bool(scored) and frozenset((scored[0][1], scored[0][2])) in pairs)
            after = scored[0][3] if scored else est
            eb.append(abs(est - tau))
            ea.append(abs(after - tau))
            better.append(abs(after - tau) < abs(est - tau))
            worse.append(abs(after - tau) > abs(est - tau))
            plen.append(len(scored))
            nbreak.append(nb_)
            covers.append(abs(est - tau) <= 1.96 * se)
            break
    print(
        f"{name:42s} | correct DAG: any-reject {np.mean(cor_any)*100:5.1f}%, priority items {np.mean(cor_prio):4.2f} "
        f"| wrong DAG (m={len(det)}): pair detected {np.mean(det)*100:5.1f}%, in priority {np.mean(in_prio)*100:5.1f}%, #1 correct {np.mean(top)*100:5.1f}%, "
        f"list len {np.mean(plen):.1f} | median|err| {np.median(eb):.3f}→{np.median(ea):.3f}, better {np.mean(better)*100:4.0f}% worse {np.mean(worse)*100:4.0f}%"
    )


def latent_scenario(name, n, w=(0.2, 0.8), strength=0.6, targets="TY"):
    """All observed edges right. A latent U is missing from the user's DAG."""
    any_prio, sus, eb, ea, better, worse, prio_len, cov = [], [], [], [], [], [], [], []
    for _ in range(N_SIM):
        G, T, Y = make(*w, False)
        if targets == "TY":
            tg = [T, Y]
        else:
            others = [v for v in NAMES if v not in (T, Y)]
            tg = [T, others[rng.integers(len(others))]]

        def builder(m, tg=tg):
            u = rng.normal(size=m)
            return {t: strength * u for t in tg}

        tau = true_effect(G, T, Y, latent_builder=builder)
        data, _ = simulate(G, n, latent=builder(n))
        s = minimal_set(G, T, Y)
        if s is None:
            continue
        est, se, scored, fl, nb_, nb = priority_list(G, s, T, Y, data)
        any_prio.append(bool(scored))
        sus.append(bool(fl))
        after = scored[0][3] if scored else est
        eb.append(abs(est - tau))
        ea.append(abs(after - tau))
        better.append(abs(after - tau) < abs(est - tau))
        worse.append(abs(after - tau) > abs(est - tau))
        prio_len.append(len(scored))
        cov.append(abs(est - tau) <= 1.96 * se)
    print(
        f"{name:42s} | any data rejection {np.mean(sus)*100:5.1f}% | priority list non-empty {np.mean(any_prio)*100:5.1f}% | median|err| {np.median(eb):.3f}→{np.median(ea):.3f}, "
        f"better {np.mean(better)*100:4.0f}% worse {np.mean(worse)*100:4.0f}% | baseline CI covers truth {np.mean(cov)*100:.0f}%"
    )


if __name__ == "__main__":
    t0 = time.time()
    print(f"N_SIM={N_SIM} per scenario, seed={SEED}\n")
    print("--- user's DAG wrong by omitted observed edge(s) that invalidate the chosen set ---")
    scenario("A. ideal: strong, n=2000", 2000)
    scenario("B. medium edges (.1-.3), n=2000", 2000, w=(0.1, 0.3))
    scenario("C. medium edges (.1-.3), n=500", 500, w=(0.1, 0.3))
    scenario("D. weak edges (.05-.15), n=500", 500, w=(0.05, 0.15))
    scenario("E. weak edges (.05-.15), n=200", 200, w=(0.05, 0.15))
    scenario("F. nonlinear SEM, strong, n=2000", 2000, nonlinear=True)
    scenario("G. nonlinear SEM, medium, n=500", 500, w=(0.1, 0.3), nonlinear=True)
    scenario("H. two omitted edges, strong, n=2000", 2000, k_omit=2)
    scenario("I. three omitted edges, medium, n=1000", 1000, w=(0.1, 0.3), k_omit=3)
    print("\n--- observed edges right, but a LATENT confounder is missing ---")
    latent_scenario("J. U→T, U→Y only (classic), n=2000", 2000, targets="TY")
    latent_scenario("K. U→T, U→another node, n=2000", 2000, targets="TO")
    print(f"\n{time.time()-t0:.0f}s")
