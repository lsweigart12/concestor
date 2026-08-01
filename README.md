# Concestor

An interactive visualizer for the tree of life. Search two or more species, see the
minimal subtree connecting them through their common ancestors, drill into the fossil
record along any branch, laid out against deep time.

*Concestor* is Dawkins' term for a common ancestor — the node where two lineages meet
looking backward.

## Status

Build pipeline phases 0–2 are implemented and green, plus a throwaway renderer
that proves the premise end to end. Phases 3–5 are not started.

**One decision is open.** Phase 2 did not accept the Duke et al. dated tree: the
ages are excellent — root age within 0.008% of the expected 4247 Ma, zero
monotonicity violations, every literature spot check in range — but clade
compatibility measured 99.6036% against a 99.9% threshold, with 947 nodes
genuinely contradicted. The recommendation is to accept anyway and restate the
criterion; the 4–6 week fallback is documented and deliberately not started.
See **[phase2-decision.md](docs/phase2-decision.md)**.

## Documents

- **[handoff.md](docs/handoff.md)** — current state, how to reproduce it, and what
  the design docs got wrong. Start here.
- **[phase2-decision.md](docs/phase2-decision.md)** — the open decision, with the
  evidence behind it.
- **[architecture.md](docs/architecture.md)** — data model, storage, backend, rendering,
  and the four core interactions end to end.
- **[ingest.md](docs/ingest.md)** — six-phase build pipeline with validation gates.
- **[data-sources.md](docs/data-sources.md)** — verified facts and corrections for every
  upstream dataset. Read this first; several widely-repeated figures are wrong.
- **[pipeline/README.md](pipeline/README.md)** — running and working on the build.

## Verified in the build

Every structural figure in `data-sources.md` reproduced exactly from the real
files: 2,385,875 tips, 339,807 internal nodes, max root-to-tip depth 111, mean
41.32, max branching factor 12,964, 83,305 unary nodes, 9,839 broken taxa,
297,070 forwards. The parse also agrees with the live Open Tree API on
**200 of 200** random induced subtrees.

## Shape of it

Static dataset, so everything is baked at build time and the runtime is read-only and
stateless: memory-mapped topology arrays plus a read-only SQLite file, both inside the
container image, behind a CDN.

The whole thing rests on one primitive — `path(node) → [root, …, node]`. Induced
subtrees are the union of ancestor paths with degree-2 nodes suppressed, which makes
lowest-common-ancestor queries, incremental reflow, and the branch drill-down all fall
out of the same computation. Mean path length is 41; the client can own the topology
outright after first paint.

## Data

| | |
|---|---|
| Topology | Open Tree of Life synthesis **v16.1** — 2,385,875 tips, CC0 |
| Dates | Duke et al. 2026 fully-dated tree — OTT-keyed, CC-BY |
| Fossils | Paleobiology Database — 523,112 taxa, ~2.0M occurrences |
| Silhouettes | PhyloPic — 12,863 images, mixed CC licenses |
| Timescale | ICS chronostratigraphic chart v2026/06, CC-BY |
