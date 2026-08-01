# Concestor

An interactive visualizer for the tree of life. Search two or more species, see the
minimal subtree connecting them through their common ancestors, drill into the fossil
record along any branch, laid out against deep time.

*Concestor* is Dawkins' term for a common ancestor — the node where two lineages meet
looking backward.

## Status

Design phase. No application code yet.

## Documents

- **[architecture.md](docs/architecture.md)** — data model, storage, backend, rendering,
  and the four core interactions end to end.
- **[ingest.md](docs/ingest.md)** — six-phase build pipeline with validation gates.
- **[data-sources.md](docs/data-sources.md)** — verified facts and corrections for every
  upstream dataset. Read this first; several widely-repeated figures are wrong.

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
