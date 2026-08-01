# Concestor

An interactive visualizer for the tree of life. Search two or more species, see the
minimal subtree connecting them through their common ancestors, drill into the fossil
record along any branch, laid out against deep time.

*Concestor* is Dawkins' term for a common ancestor — the node where two lineages meet
looking backward.

## Status

Build pipeline phases 0–2 are implemented and green, plus a throwaway renderer
that proves the premise end to end. Phase 3 is measured and designed but not
built; phases 4–6, the serving binary and the real UI are not started.

**This is for curious people interested in evolution, not for evolutionary
biologists.** Identifying an MRCA, drawing the tree well, and showing useful
silhouettes are the priorities; the time axis and the fossil layer are secondary.
That reorders the phases as numbered — see [handoff.md](docs/handoff.md) §1.

Two decisions are settled. The Duke et al. dated tree is **accepted** despite
missing its gate by 0.30 points, because the ages are excellent and the shortfall
is a criterion that assumed an impossible node-for-node identity. Fossil
resolution will use a **GBIF point lookup** rather than the bulk export that
appeared to be blocked, with the offline backbone map kept as a free second
method.

## Documents

- **[handoff.md](docs/handoff.md)** — current state, priorities, decisions taken,
  and what the design docs got wrong. Start here.
- **[design-reference.md](docs/design-reference.md)** — the product's visual and
  interaction language. Authoritative for anything the user sees.
- **[management.md](docs/management.md)** — the standing brief for whoever owns and
  runs the project.
- **[phase2-decision.md](docs/phase2-decision.md)** — the dating decision and its evidence.
- **[phase3-pbdb-path.md](docs/phase3-pbdb-path.md)** — how fossils resolve to the tree, measured.
- **[architecture.md](docs/architecture.md)** — data model, storage, backend, rendering,
  and the four core interactions end to end.
- **[ingest.md](docs/ingest.md)** — six-phase build pipeline with validation gates.
- **[data-sources.md](docs/data-sources.md)** — verified facts and corrections for every
  upstream dataset. Read this first; several widely-repeated figures are wrong.
- **[pipeline/README.md](pipeline/README.md)** — running and working on the build.

## What it looks like

A dark instrument where the graph is the only light source, operated from a `⌘K`
command palette. Phosphor persistence — a trace flares as it is drawn, then decays
to a dim persistent line. The signature interaction is adding a species: the draw
originates at the **MRCA** and extends outward, because the point is to show where
the new lineage joins. See [design-reference.md](docs/design-reference.md).

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
