# Concestor

An interactive tree-of-life visualiser. Pick species, see the minimal subtree
connecting them through their common ancestors, drill into the fossil record
along any branch, laid out against deep time.

Built for curious people interested in evolution, not for evolutionary
biologists. Identifying an MRCA, drawing the tree well, and showing useful
silhouettes come first; the time axis and the fossil layer support them.

## Where things are

```
docs/          the specification and design references
pipeline/      the offline build pipeline (Python) — see pipeline/README.md
server/        the read API (Go) — mmaps the arrays, opens the DB read-only
web/           the UI (React + xyflow v12). The signature interaction lives here
snapshot/      pinned upstream sources. Gitignored except manifest.json
build/         derived artifacts. Gitignored
```

The three halves share only *files*. `server/` reads the pipeline's `.npy`
output directly and `web/` talks to `server/` over `/v1`. There is no shared
runtime, no FFI, no code generation between them.

## Language choices

- **Pipeline: Python 3.14**, managed with `uv`. Fully annotated; `ty check` must
  pass clean. Use the dtype aliases in `concestor_build/typing_.py` rather than
  bare `np.ndarray` — the dtypes are load-bearing (`parent` being `u32` is what
  makes it 10.9 MB, not 21.8). `Any` is allowed only for decoded JSON.
- **Server: Go**, in `server/`. Static binary, mmap, read-only SQLite. Reads the
  pipeline's `.npy` files directly — there is no `topology.bin`.
- **Frontend: React 19 + TypeScript + `@xyflow/react` v12**, in `web/`. Layout is
  our own — **no dagre, ELK, or d3-hierarchy**, because a graph-layout engine
  assigns `x` by depth and here `x` is time.

## Building and testing

```bash
cd web && npm install && npm run format:check && npm run lint && npm run build && npm test
cd server && go test ./...
cd pipeline && uv run ruff format src tests && uv run ruff check src tests && uv run ty check && uv run pytest
scripts/check.sh          # everything CI runs, plus the dataset tests it can't
```

```bash
cd pipeline
uv sync
uv run concestor-build snapshot   # phase 0, then: topology, dates, resolve,
                                  # fossils, images, timescale, vernaculars,
                                  # search, package
```

### Conventions that block a merge

- **`web/` is formatted by Prettier and linted by oxlint** (not typescript-eslint,
  which refuses to load on TS 7). `web/prettier.config.js` is all Prettier
  defaults; `web/.oxlintrc.json` is deliberately small because `tsconfig.json`
  already runs `strict`, `noUnusedLocals`, and `noUncheckedIndexedAccess`.
- **`web` has two vitest projects, decided by filename.** `node` is pure modules
  with no DOM. `dom` boots jsdom and collects `*.test.tsx` and `*.dom.test.ts`
  (a module test that needs `localStorage`, `matchMedia`, or `window`).
  `vitest.config.ts` is the rule; `src/test/setup-dom.ts` is the harness. Stub the
  `api` method you exercise (`vi.spyOn(api, "search")`), not the transport. Timer
  advances must be wrapped in `act`.
- **Pipeline: all four of `ruff format`, `ruff check`, `ty check`, `pytest` must
  pass.** Use the versions pinned in the dev dependency group.

### Gates

Each build phase collects **gates** rather than raising on the first failure, so a
run reports every problem at once and then refuses to write its output. `require`
blocks the build; `observe` is recorded but never fails it. Results land in
`build/phase{N}_gates.json`. Expected values are measured, so a mismatch usually
means a real bug — but check what the gate measures before changing either side.

## Gotchas that will cost you

- **Read `docs/data-sources.md` before touching the pipeline.** It records the
  upstream corrections that are not obvious: the synthesis snapshot is frozen at
  2016, OTT id forwarding is silent, `is_suppressed_from_synth` is unreliable,
  treePL emits a confident dated tree from a branch-length-free topology, the
  Open Tree API has no rate limiting, and GBIF caps paging at offset 100,000.
- **Do not apply a lint or type fix without reading the surrounding code.** Two
  real bugs came from exactly that (renaming `rank` to `_rank` left the column it
  fed permanently `NULL`; every gate still passed). When a lint fix touches a name
  that flows into output, check the output.
- **The three age arrays stay separate.** `age_ma` (what may be shown; NaN where
  nothing may be), `age_tier` (how it renders), `age_layout` (where to draw;
  finite everywhere). Merging them puts a confident number on a node that has none.
- **`web/src/tree/induced.ts` and its Go equivalent are both ports of
  `render.py`'s `induced_subtree`,** each pinned to the Python reference by a test
  on the real baked arrays. Change the suppression rule in all three places; the
  tests tell you which one you missed.
- **`go test` in a worktree silently skips most of the suite** because it can't
  find `build/`. Use `scripts/check.sh`. See `docs/ci.md`.

## Commits and releases

Commits carry a [Conventional Commits](https://www.conventionalcommits.org) type
and nothing else changes. The subject is a sentence in this project's voice —
`feat: Make the card say what a thing is, and let the reader walk from it` —
because `subject-case` is off in `commitlint.config.cjs`. Merging to `main` cuts
a release and the version comes from the type prefix. The type→bump mapping lives
in `release.config.cjs`'s `releaseRules` — read it there, don't restate it.

## The design docs

They are the spec, and their figures are verified against live data. Read them
rather than re-researching.

| Doc | Contents |
|---|---|
| [architecture.md](docs/architecture.md) | Data model, storage, serving, rendering, age tiers, fossils, witnesses |
| [design-reference.md](docs/design-reference.md) | Visual and interaction language. Authoritative for anything the user sees |
| [data-sources.md](docs/data-sources.md) | Verified upstream facts and corrections. Read before the pipeline |
| [ingest.md](docs/ingest.md) | The build phases and their gates |
| [ci.md](docs/ci.md) | What CI checks, what green does not mean, the release rules, worktrees |
| [deployment.md](docs/deployment.md) | Where it runs (Cloudflare; the Go binary in a Container) |
| [name-ranking.md](docs/name-ranking.md) | Ordering a taxon's names, and which taxon a query means |
| [fossil-grafts.md](docs/fossil-grafts.md) | Drawing a fossil in the tree at its own date |
| [image-store.md](docs/image-store.md) | How drawings are identified, stored, ranked, served |
| [biolum-gpu.md](docs/biolum-gpu.md) | The bioluminescent mode on WebGL2 |
| [analytics.md](docs/analytics.md) | Reading readership, and why the instruments disagree |
| [sidebar.md](docs/sidebar.md) | The selected-taxa sidebar |

## Current state

All six phases are implemented, the server is built, and the UI works end to end.
Every phase is green and `concestor-build package` succeeds. `/v1/about` serves
the live build manifest — it is the source of truth for the current artifact set,
not any figure written into these docs.
