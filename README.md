# Concestor

Everything alive is related. Name a few species and Concestor draws the smallest
tree that connects them — every common ancestor on the way and nothing else — laid
out against real geological time, and puts beside each split the closest fossil the
rock record has to it.

*Concestor* is Dawkins' term for a common ancestor — the node where two lineages meet
looking backward.

It is built for curious people interested in evolution, not for evolutionary
biologists. Identifying a common ancestor, drawing the tree well, and showing a
useful silhouette for each clade come first; the time axis and the fossil layer
support them.

---

## Quick start

Requires [uv](https://docs.astral.sh/uv/), Go 1.26+, and Node 20+.

Build the dataset. Phases run in order, are individually resumable, and together
download and bake the artifact set into `build/` — a long, one-time job:

```bash
cd pipeline
uv sync
for phase in snapshot topology dates resolve fossils images timescale vernaculars search package; do
  uv run concestor-build "$phase" || break
done
```

Each phase prints its own gate report, so running them one at a time is the
better way to work. [pipeline/README.md](pipeline/README.md) covers the options.

With `build/` populated, start the app:

```bash
scripts/dev.sh
```

Vite serves the frontend with hot reload, by default at <http://localhost:5173>,
backed by a read API the script starts on a private port and proxies `/v1` to.
Set `PORT` to change it. It refuses to start if the baked artifacts are absent
rather than serving an empty canvas that looks like a bug.

To see the bundle that actually ships, use `scripts/serve.sh`: one Go process
serving the read API on `/v1` and the built frontend on `/`, by default at
<http://localhost:8080>. It rebuilds `web/dist` whenever a source file,
`package.json` or the vite config is newer than the bundle, so what it serves is
what the source says.

---

## How it works

Concestor serves a static dataset, so everything is computed at build time and the
runtime is read-only and stateless: memory-mapped topology arrays plus a read-only
SQLite database, both baked into the container image.

The whole system rests on one primitive — `path(node) → [root, …, node]`. An
induced subtree is the union of ancestor paths with degree-2 nodes suppressed,
which makes lowest-common-ancestor queries, incremental reflow, and branch
drill-down all fall out of the same computation. Mean path length is 41 nodes, so
the client can own the working topology outright after first paint.

Three components share only *files*. There is no shared runtime, no FFI, and no
code generation between them.

| Component | Language | Role |
|---|---|---|
| [`pipeline/`](pipeline/) | Python 3.14 (`uv`) | Offline build. Consumes pinned upstream sources, emits the immutable artifact set |
| [`server/`](server/) | Go | Read API. Memory-maps the pipeline's `.npy` output, opens SQLite read-only |
| [`web/`](web/) | React 19 + TypeScript + `@xyflow/react` v12 | The UI. Layout is our own — no dagre, ELK, or d3-hierarchy, because a graph-layout engine assigns `x` by depth and here `x` is time |

```
docs/          specification and design documents
pipeline/      the offline build pipeline
server/        the read API
web/           the frontend
scripts/       dev.sh and serve.sh — the two launch configurations — and check.sh
snapshot/      pinned upstream sources (gitignored except manifest.json)
build/         derived artifacts (gitignored)
```

`web/src/tree/induced.ts` and its Go counterpart are both ports of `render.py`'s
`induced_subtree`. Each is pinned to the Python reference by a test built from the
real baked arrays — change the suppression rule in one place and those tests will
tell you which of the other two you missed.

---

## API

The server exposes a small read-only JSON API under `/v1`.

| Endpoint | Description |
|---|---|
| `GET /v1/about` | Build manifest, artifact provenance, and per-phase gate summaries |
| `GET /v1/search?q=&limit=` | Full-text search over scientific names and vernaculars |
| `GET /v1/path/{key}` | Root-to-node ancestor path |
| `GET /v1/paths?keys=` | Batched ancestor paths for an induced subtree |
| `GET /v1/node/{key}` | Node detail — names, ages, silhouette, children |
| `GET /v1/segment/{upper}/{lower}` | The branch between two nodes, with its fossil record |
| `GET /v1/timescale` | ICS chronostratigraphic chart |
| `GET /v1/silhouette/{file}` | PhyloPic silhouette, with attribution headers |

Run it directly with `go run . -build ../build`; `-addr`, `-web`, and
`-silhouettes` control the listen address and asset paths.

---

## Development

```bash
# pipeline — all four must pass
cd pipeline
uv run ruff format src tests && uv run ruff check src tests && uv run ty check && uv run pytest

# server
cd server && go test ./...

# web
cd web && npm install && npm run build && npm test

# all of the above, plus the tests that need a built dataset
scripts/check.sh
```

Commits follow [Conventional Commits](https://www.conventionalcommits.org) —
the type prefix and nothing more, so `feat: Make the card say what a thing is,
and let the reader walk from it` is a valid subject. Merging to `main` cuts a
release automatically: the version comes from those prefixes, the notes from
the commits, and neither is written by hand.

CI runs the same checks on every pull request, on a clean checkout — which
means no `build/`, which means **most of the Go suite and a fifth of the
pipeline's skip themselves and both still report success**. The split is
measured in [docs/ci.md](docs/ci.md) §2 and written down only there.
`scripts/check.sh`
finds a build, sets `CONCESTOR_REQUIRE_BUILD=1` so a skip becomes a failure,
and is the run to trust before merging anything that reads the artifacts.
[docs/ci.md](docs/ci.md) covers that and the Cloudflare deployment path.

The pipeline is fully annotated and `ty check` must run clean. Use the dtype
aliases in `concestor_build/typing_.py` rather than bare `np.ndarray` — the dtypes
are load-bearing.

Each build phase collects **gates** rather than raising on the first failure, so a
run reports every problem at once and then refuses to write its output. `require`
blocks the build; `observe` is recorded but never fails it. Results land in
`build/phase{N}_gates.json`. Expected values are measured rather than estimated, so
a mismatch usually indicates a real bug — but check what the gate measures before
changing either side of it.

Conventions, the reasoning behind them, and the specific mistakes that motivated
the content tests are in [CLAUDE.md](CLAUDE.md).

### Build phases

| Phase | Command | Output |
|---|---|---|
| 0 | `snapshot` | Pin and checksum upstream sources |
| 1 | `topology` | Parse the Open Tree Newick into preorder-indexed arrays |
| 2 | `dates` | Validate and attach the dated tree |
| 3 | `resolve` | Cross-reference OTT, PBDB, GBIF, and Wikidata identifiers |
| 4 | `fossils` | Attach PBDB taxa to branches, rewrite the layout ages |
| 5a / 5b | `images` / `timescale` | PhyloPic mirror and node resolution; ICS chart |
| 6 | `vernaculars` | Common names from Wikidata |
| — | `search` | FTS index over names and vernaculars |
| — | `package` | Gate the artifact set as a whole and write `build/manifest.json` |

Phases are resumable: `dates` does not re-run `topology`, and `snapshot` skips any
download whose recorded SHA-256 still matches.

---

## Data

| Source | Detail | Licence |
|---|---|---|
| Topology | Open Tree of Life synthesis **v16.1** — 2,385,875 tips | CC0 |
| Dates | Duke et al. 2026 fully-dated tree, OTT-keyed | CC-BY |
| Fossils | Paleobiology Database — 523,112 taxa, ~2.0M occurrences | Mixed |
| Silhouettes | PhyloPic — 12,863 images | Mixed CC |
| Timescale | ICS chronostratigraphic chart v2026/06 | CC-BY |

Attribution is carried through the pipeline and served with each silhouette:
PhyloPic's creator and uploader fields differ half the time, so both are stored.

Ages are deliberately kept honest. Three age arrays ship separately — `age_ma`
(what may be shown, `NaN` where nothing may be), `age_tier` (how), and
`age_layout` (where to draw, finite everywhere) — so that a node whose date is
merely structural renders without a number rather than with a confident one.
Fossil bounds render as a range and never as a point.

---

## Documentation

The documents in [`docs/`](docs/) are the specification. Their figures were
verified against live APIs and data files, and several widely-repeated public
numbers are wrong in ways these documents record — read them rather than
re-researching.

| Document | Contents |
|---|---|
| [handoff.md](docs/handoff.md) | Current state, priorities, and decisions taken. Start here |
| [design-reference.md](docs/design-reference.md) | Visual and interaction language. Authoritative for anything the user sees |
| [architecture.md](docs/architecture.md) | Data model, storage, backend, rendering |
| [data-sources.md](docs/data-sources.md) | Verified facts and corrections for every upstream dataset |
| [ingest.md](docs/ingest.md) | The build phases and their validation gates |
| [phase2-decision.md](docs/phase2-decision.md) | The dating decision, with the evidence |
| [phase3-pbdb-path.md](docs/phase3-pbdb-path.md) | How fossils resolve to the tree, measured |
| [serving-binary.md](docs/serving-binary.md) | Why the read API is Go, and what it serves |
| [management.md](docs/management.md) | The standing brief for whoever owns the project |
| [worktrees.md](docs/worktrees.md) | Running from a parallel git worktree |

---

## Contributing

Issues and pull requests are welcome — [CONTRIBUTING.md](CONTRIBUTING.md) covers
the checks, the commit convention, and the two habits that will otherwise waste
your time. Security reports go through
[private vulnerability reporting](https://github.com/lsweigart12/concestor/security/advisories/new)
rather than an issue; [SECURITY.md](SECURITY.md) describes what the attack
surface actually is, which is smaller than the repository's size suggests.

---

## Licence

**The software is [Apache 2.0](LICENSE).** That covers the build pipeline, the
read API, the frontend, the design documents, and the mascot artwork in
`brand/`.

**It does not cover the data.** The scientific sources the pipeline downloads,
the artifact set it bakes into `build/`, and the silhouette mirror each carry
their own upstream terms. [NOTICE](NOTICE) sets them out in full, source by
source. Anyone redistributing a built dataset — as a release artifact, a
container image, or a hosted service — is redistributing that upstream data and
is bound by those terms rather than by the Apache licence.

Three of them will decide what you can do with this:

- **Attribution is required** for the dated tree (Duke et al. 2026, CC-BY 4.0)
  and the ICS timescale (CC-BY 4.0), and per-image for much of PhyloPic.
- **5.8% of the silhouette corpus is NonCommercial.** The pipeline applies no
  NonCommercial filter, deliberately, because this project is not commercial.
  **Any commercial use must filter them out first** — and that includes
  advertising or sponsorship on an otherwise free hosted instance. The
  `license_url` column carries everything needed, and NOTICE measures what
  filtering costs.
- **TimeTree is excluded outright.** Its terms prohibit redistributing its data
  or transformations of it. No TimeTree-derived age appears anywhere in this
  project, and none may be added.
