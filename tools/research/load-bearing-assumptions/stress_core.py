"""Minimal prototype of the 'load-bearing assumption' stress test. Independent of the repo's engine."""
from __future__ import annotations

from itertools import combinations

import networkx as nx
import numpy as np


def backdoor_valid(G: nx.DiGraph, T: str, Y: str, Z) -> bool:
    Z = set(Z)
    if Z & nx.descendants(G, T) or T in Z or Y in Z:
        return False
    H = G.copy()
    H.remove_edges_from(list(G.out_edges(T)))
    return nx.is_d_separator(H, {T}, {Y}, Z)


def o_set(G: nx.DiGraph, T: str, Y: str) -> set[str]:
    """Henckel et al. optimal adjustment set: pa(cn) minus forb."""
    if not nx.has_path(G, T, Y):
        cn = {Y}
    else:
        cn = (nx.descendants(G, T) & nx.ancestors(G, Y)) | {Y}
    forb = {T} | cn
    for c in cn:
        forb |= nx.descendants(G, c)
    pa = set()
    for c in cn:
        pa |= set(G.predecessors(c))
    return pa - forb


def minimal_set(G: nx.DiGraph, T: str, Y: str) -> set[str] | None:
    """A minimal backdoor set (what the current product style of 'small set' recommends)."""
    H = G.copy()
    H.remove_edges_from(list(G.out_edges(T)))
    allowed = set(G.nodes) - nx.descendants(G, T) - {T, Y}
    return nx.find_minimal_d_separator(H, {T}, {Y}, restricted=allowed)


def smallest_valid_sets(G, T, Y, candidates):
    """Exact: all minimum-cardinality valid sets (brute force for small graphs)."""
    for k in range(len(candidates) + 1):
        hits = [set(c) for c in combinations(sorted(candidates), k) if backdoor_valid(G, T, Y, c)]
        if hits:
            return hits
    return []


def perturbations(G: nx.DiGraph, allow=None):
    """All single-edge errors that keep the graph a DAG. Yields (kind, u, v, G2)."""
    allow = allow or (lambda u, v: True)
    nodes = list(G.nodes)
    for u, v in list(G.edges):
        H = G.copy()
        H.remove_edge(u, v)
        yield ("remove", u, v, H)
        if allow(v, u):
            H2 = H.copy()
            H2.add_edge(v, u)
            if nx.is_directed_acyclic_graph(H2):
                yield ("reverse", u, v, H2)
    for u in nodes:
        for v in nodes:
            if u == v or G.has_edge(u, v) or G.has_edge(v, u) or not allow(u, v):
                continue
            H = G.copy()
            H.add_edge(u, v)
            if nx.is_directed_acyclic_graph(H):
                yield ("add", u, v, H)


def missing_edge_basis(G: nx.DiGraph):
    """dagitty's 'missing.edge' basis: for each nonadjacent pair, u ⟂ v | pa(u) ∪ pa(v)."""
    out = []
    order = {n: i for i, n in enumerate(nx.topological_sort(G))}
    for u, v in combinations(G.nodes, 2):
        if G.has_edge(u, v) or G.has_edge(v, u):
            continue
        a, b = (u, v) if order[u] < order[v] else (v, u)
        cond = (set(G.predecessors(a)) | set(G.predecessors(b))) - {a, b}
        # Only pairs where neither is a descendant conditioned on: guaranteed by parents-only conditioning on a DAG.
        out.append((a, b, sorted(cond)))
    return out


def holm(pvals):
    p = np.asarray(pvals, float)
    if p.size == 0:
        return p
    order = np.argsort(p)
    adj = np.empty_like(p)
    running = 0.0
    m = len(p)
    for rank, idx in enumerate(order):
        running = max(running, min(1.0, (m - rank) * p[idx]))
        adj[idx] = running
    return adj
