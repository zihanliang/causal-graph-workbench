"""Does the stress test surface meaningful assumptions on REAL data with an experimental benchmark?"""
import warnings

import networkx as nx
import numpy as np
import pandas as pd
import statsmodels.api as sm
from causaldata import cps_mixtape, nsw_mixtape
from scipy import stats

from stress_core import backdoor_valid, holm, missing_edge_basis, o_set, perturbations

warnings.filterwarnings("ignore")

nsw = nsw_mixtape.load_pandas().data
cps = cps_mixtape.load_pandas().data
BENCH = nsw[nsw.treat == 1].re78.mean() - nsw[nsw.treat == 0].re78.mean()
ctrl_exp = nsw[nsw.treat == 0]
bench_se = np.sqrt(nsw[nsw.treat == 1].re78.var() / 185 + ctrl_exp.re78.var() / 260)
df = pd.concat([nsw[nsw.treat == 1], cps], ignore_index=True).drop(columns=["data_id"]).astype(float)
df[["re74", "re75", "re78"]] = df[["re74", "re75", "re78"]]
COV = ["age", "educ", "black", "hisp", "marr", "nodegree", "re74", "re75"]
TIER = {"age": 0, "black": 0, "hisp": 0, "educ": 1, "marr": 1, "nodegree": 1, "re74": 2, "re75": 3, "treat": 4, "re78": 5}
print(f"n={len(df)} treated={int(df.treat.sum())} | experimental benchmark ATT = {BENCH:,.0f} (SE {bench_se:,.0f})")


def design(S):
    X = pd.DataFrame({"const": np.ones(len(df))})
    for c in S:
        X[c] = df[c] / 1000.0 if c.startswith("re") else df[c]
    return X


def ols_adj(S):
    X = design(S)
    X["treat"] = df.treat
    m = sm.OLS(df.re78, X).fit(cov_type="HC1")
    return m.params["treat"], m.bse["treat"], m


def dr_att(S, trim=0.9):
    """Doubly robust ATT with influence-function SE; drop units with extreme propensity."""
    X = design(S)
    e = sm.Logit(df.treat, X).fit(disp=0, maxiter=200).predict(X).values
    keep = e <= trim
    t, y = df.treat.values[keep], df.re78.values[keep]
    Xk, ek = X.values[keep], e[keep]
    beta = np.linalg.lstsq(Xk[t == 0], y[t == 0], rcond=None)[0]
    m0 = Xk @ beta
    n1 = t.sum()
    psi = (t * (y - m0) - (1 - t) * ek / (1 - ek) * (y - m0)) / (n1 / len(t))
    est = psi.mean()
    se = np.sqrt(((psi - t / (n1 / len(t)) * est) ** 2).mean() / len(t))
    return est, se, int((~keep).sum())


def fmt(est, se):
    return f"{est:>8,.0f}  CI[{est-1.96*se:>8,.0f}, {est+1.96*se:>8,.0f}]"


def analyst_dag(omit_from_treat=("re74",)):
    G = nx.DiGraph()
    G.add_nodes_from(TIER)
    G.add_edges_from([("age", "educ"), ("black", "educ"), ("hisp", "educ"), ("educ", "nodegree"), ("age", "marr")])
    for c in ["age", "educ", "black", "hisp", "marr", "nodegree"]:
        G.add_edge(c, "re74")
        G.add_edge(c, "re75")
    G.add_edge("re74", "re75")
    for c in COV:
        G.add_edge(c, "re78")
        if c not in omit_from_treat:
            G.add_edge(c, "treat")
    G.add_edge("treat", "re78")
    return G


def allow(u, v):
    if v in ("age", "black", "hisp") or u == "re78":
        return False
    return TIER[u] <= TIER[v]


def local_test(a, b, cond):
    """Test a ⟂ b | cond, regressing the later variable."""
    target = df[b]
    X = design(cond)
    x = df[a] / 1000.0 if a.startswith("re") else df[a]
    X1 = X.copy()
    X1["__a"] = x
    if set(target.unique()) <= {0.0, 1.0}:
        try:
            m1 = sm.Logit(target, X1).fit(disp=0, maxiter=200)
            m0 = sm.Logit(target, X).fit(disp=0, maxiter=200)
            lr = 2 * (m1.llf - m0.llf)
            p = stats.chi2.sf(lr, 1)
        except Exception:
            m = sm.OLS(target, X1).fit(cov_type="HC1")
            p = m.pvalues["__a"]
    else:
        m = sm.OLS(target, X1).fit(cov_type="HC1")
        p = m.pvalues["__a"]
    r1 = sm.OLS(x, X).fit().resid
    r2 = sm.OLS(target, X).fit().resid
    return p, float(np.corrcoef(r1, r2)[0, 1])


def nearest_valid(G2, base):
    best = None
    pool = [c for c in COV if c not in nx.descendants(G2, "treat")]
    from itertools import combinations as comb

    for k in range(len(pool) + 1):
        for s in comb(pool, k):
            s = set(s)
            if backdoor_valid(G2, "treat", "re78", s):
                d = len(s ^ base)
                if best is None or d < best[0] or (d == best[0] and len(s) < len(best[1])):
                    best = (d, s)
    return best[1] if best else None


print("\n=== Reference specs ===")
crude = df[df.treat == 1].re78.mean() - df[df.treat == 0].re78.mean()
print(f"crude                     : {crude:>8,.0f}")
for name, S in [("demographics only", ["age", "educ", "black", "hisp", "marr", "nodegree"]), ("demog + re75", COV[:6] + ["re75"]), ("demog + re74", COV[:6] + ["re74"]), ("all 8 (= O-set)", COV)]:
    b, se, _ = ols_adj(S)
    d, dse, dropped = dr_att(S)
    print(f"{name:26s}: OLS {fmt(b,se)} | DR-ATT {fmt(d,dse)} (dropped {dropped})")

print("\n=== Case study: analyst believes selection depends on re75 but not re74 ===")
G = analyst_dag(("re74",))
S0 = set(nx.ancestors(G, "treat")) & set(G.predecessors("treat"))
print("smallest valid set contains re74?", "re74" in S0, "| valid:", backdoor_valid(G, "treat", "re78", S0), "| set:", sorted(S0))
print("O-set:", sorted(o_set(G, "treat", "re78")))
base_est, base_se, _ = dr_att(sorted(S0))
print("baseline DR-ATT:", fmt(base_est, base_se), f"| distance from benchmark = {abs(base_est-BENCH):,.0f}")

tests = missing_edge_basis(G)
ps, rs = [], []
for a, b, cond in tests:
    p, r = local_test(a, b, cond)
    ps.append(p)
    rs.append(r)
adj = holm(ps)
print(f"\nTestable implications: {len(tests)} | rejected after Holm: {(adj<0.05).sum()}")
for (a, b, cond), p, r in sorted(zip(tests, adj, rs), key=lambda z: z[1]):
    print(f"  {a} ⟂ {b} | {{{len(cond)} vars}}: partial r={r:+.3f}, Holm p={p:.2g}")

for label, baseline in [("smallest", S0), ("O-set", o_set(G, "treat", "re78"))]:
    rows = []
    cands = list(perturbations(G, allow))
    for kind, u, v, G2 in cands:
        if not backdoor_valid(G2, "treat", "re78", baseline):
            S1 = nearest_valid(G2, baseline)
            rows.append((kind, u, v, S1))
    print(f"\n[{label} baseline] single-edge errors considered: {len(cands)} | break the set: {len(rows)}")
    if label == "smallest":
        be, bse, _ = dr_att(sorted(baseline))
        out = []
        for kind, u, v, S1 in rows:
            if S1 is None:
                out.append((kind, u, v, None, None, None))
                continue
            e, se, _ = dr_att(sorted(S1))
            flagged = next((pp for (a, b, c), pp in zip(tests, adj) if {a, b} == {u, v}), None)
            out.append((kind, u, v, sorted(S1 ^ baseline), e, se, flagged))
        for row in sorted(out, key=lambda r: -abs(r[4] - be) if r[4] is not None else 0):
            kind, u, v, diff, e, se, flagged = row
            flag = f"data flags it (Holm p={flagged:.1g})" if flagged is not None and flagged < 0.05 else "data silent"
            print(f"   {kind:7s} {u:>8s}→{v:<8s} change set {diff}: {fmt(e,se)} Δ={e-be:+,.0f} | {flag}")

print("\n=== Systematic: every analyst who omits ONE c→treat edge ===")
print(f"{'omitted':9s} {'n broke':>7s} {'c→treat ranked':>14s} {'test p':>10s} {'r':>7s} {'baseline':>9s} {'after fix':>9s} {'|err| before':>12s} {'|err| after':>11s}")
for c in COV:
    Gc = analyst_dag((c,))
    Sc = set(Gc.predecessors("treat"))
    if not backdoor_valid(Gc, "treat", "re78", Sc):
        print(c, "invalid baseline")
        continue
    be, bse, _ = dr_att(sorted(Sc))
    tests_c = missing_edge_basis(Gc)
    pr = [local_test(a, b, co) for a, b, co in tests_c]
    adj_c = holm([x[0] for x in pr])
    rows = []
    for kind, u, v, G2 in perturbations(Gc, allow):
        if backdoor_valid(G2, "treat", "re78", Sc):
            continue
        S1 = nearest_valid(G2, Sc)
        if S1 is None:
            continue
        e, se, _ = dr_att(sorted(S1))
        rows.append((abs(e - be), kind, u, v, e))
    rows.sort(reverse=True)
    rank = next((i + 1 for i, r in enumerate(rows) if r[1] == "add" and r[2] == c and r[3] == "treat"), None)
    idx = next((i for i, (a, b, _) in enumerate(tests_c) if {a, b} == {c, "treat"}), None)
    fix = dict(((r[2], r[3]), r[4]) for r in rows).get((c, "treat"))
    print(
        f"{c:9s} {len(rows):7d} {str(rank)+'/'+str(len(rows)):>14s} {adj_c[idx]:10.2g} {pr[idx][1]:+7.3f} {be:9,.0f} {fix:9,.0f} {abs(be-BENCH):12,.0f} {abs(fix-BENCH):11,.0f}"
    )

print("\n=== Sensitivity to unmeasured confounding (Cinelli & Hazlett robustness value, O-set OLS) ===")
b, se, m = ols_adj(COV)
t = b / se
dof = m.df_resid
f = abs(t) / np.sqrt(dof)
rv = 0.5 * (np.sqrt(f**4 + 4 * f**2) - f**2)
print(f"coef {b:,.0f}, t={t:.2f}, partial R²={t**2/(t**2+dof):.4f}, RV={rv:.3f}")
