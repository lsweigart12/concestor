# concestor-build

The offline build pipeline. Consumes the sources pinned in
[docs/data-sources.md](../docs/data-sources.md) and produces the immutable
artifact set described in [docs/architecture.md](../docs/architecture.md),
following the phases in [docs/ingest.md](../docs/ingest.md).

```bash
uv sync
uv run concestor-build snapshot    # phase 0 — pin and checksum sources
uv run concestor-build topology    # phase 1 — parse the OTT Newick
uv run concestor-build dates       # phase 2 — the decision gate
uv run concestor-build render      # throwaway walking-skeleton renderer
uv run pytest
```

Every change must pass all four checks:

```bash
uv run ruff format src tests && uv run ruff check src tests && uv run ty check && uv run pytest
```

The project is fully annotated and `ty check` runs clean. Conventions and the
two bugs that motivated the content tests are in [../CLAUDE.md](../CLAUDE.md).

Phases are resumable and write to `build/`. `snapshot` skips any download whose
recorded SHA-256 still matches, and resumes partial transfers by range request.

## Why Python for the build, and why that says nothing about the server

**The build pipeline is Python 3.14.** The phylogenetics ecosystem is there
when we need it (ete4, dendropy), Duke et al.'s own `interpolate_newick.py` is
Python + ete4 + numpy so the fallback pipeline would be a port rather than a
rewrite, and the work is overwhelmingly one-pass array manipulation over
files — which is numpy's home ground, not a place where a systems language
earns its keep.

The performance worry was misplaced. Parsing 31 MB of Newick into 2.7M
preorder-indexed nodes takes **0.9 s**, because the hot loop is driven by a
numpy-located array of delimiter offsets rather than a per-character Python
loop, and the sequential sweeps run over Python lists rather than numpy
scalars. The slowest thing in phase 0 is a 66-second wait on PBDB's server.
Nothing here is CPU-bound enough to justify giving up the ecosystem.

3.14 specifically: this is a new project with no legacy constraints, and the
release is current.

**This does not constrain the serving binary.** Architecture §4 proposes Go or
Rust for that, and the two components share only files — `topology.bin`,
`meta.bin`, `concestor.db`. There is no shared runtime, no FFI, no
serialisation contract beyond "flat arrays of documented dtype". Decide it
independently, on the merits of mmap ergonomics and deployment, whenever the
read API gets written.

## Layout

| Module | Role |
|---|---|
| `newick.py` | Preorder-indexing Newick parser and the derived topology arrays |
| `snapshot.py` | Phase 0 |
| `topology.py` | Phase 1 |
| `dates.py` | Phase 2, the decision gate |
| `oracle.py` | Validates our topology against the live Open Tree API |
| `gbif_checklist.py` | PBDB→GBIF `nubKey` export, sharded around the offset cap |
| `provenance.py` | Fetching with checksums; writes `snapshot/manifest.json` |
| `gates.py` | Named assertions; a failed blocking gate refuses to write output |
| `typing_.py` | Array and JSON type aliases; the dtypes are load-bearing |
| `render.py` | The throwaway renderer. Not the real UI |

`snapshot/manifest.json` is git-tracked even though the ~1.4 GB it describes is
not, so the repo always records exactly what a build was made from.

## Gates

Every phase collects gates rather than raising on the first failure, so a run
reports every problem at once and then refuses to write its output. `require`
gates block; `observe` gates are recorded but never fail a build. Results land
in `build/phase{N}_gates.json`.

The numbers in `topology.py` are measured, not estimated. A mismatch means a
real parse bug — except where it means the gate is measuring the wrong thing,
which is what happened to mean depth: `data-sources.md` says *root-to-tip*
depth (41.32 over tips), and scoring it over all nodes gives 41.67.
