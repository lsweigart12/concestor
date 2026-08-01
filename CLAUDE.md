# Concestor

An interactive tree-of-life visualiser. Pick species, see the minimal subtree
connecting them through their common ancestors, drill into the fossil record
along any branch, laid out against deep time.

## Read the design docs first

They are the spec, and they contain figures verified against live APIs and data
files on 2026-07-31 — tip counts, file sizes, coverage percentages, response
shapes. **Do not re-research them.** Several widely-repeated public numbers are
wrong and these docs record the corrections.

| Doc | Contents |
|---|---|
| [docs/handoff.md](docs/handoff.md) | Current state, priorities, decisions taken. Start here |
| [docs/design-reference.md](docs/design-reference.md) | Visual and interaction language. Authoritative for anything the user sees |
| [docs/management.md](docs/management.md) | The standing brief for whoever owns the project |
| [docs/data-sources.md](docs/data-sources.md) | Verified facts and corrections. Read this before the architecture doc |
| [docs/architecture.md](docs/architecture.md) | Data model, storage, backend, rendering |
| [docs/ingest.md](docs/ingest.md) | The six build phases and their validation gates |
| [docs/phase2-decision.md](docs/phase2-decision.md) | The dating decision — accepted, with the evidence |
| [docs/phase3-pbdb-path.md](docs/phase3-pbdb-path.md) | How fossils resolve to the tree, measured |

**This product is for curious people interested in evolution, not for evolutionary
biologists.** Identifying an MRCA, drawing the tree well, and showing useful
silhouettes are the priorities; the time axis and the fossil layer are secondary.
That makes `ingest.md`'s numbering a *dependency* order, not a priority order.

## Where things are

```
docs/          the spec
pipeline/      the offline build pipeline (Python) — see pipeline/README.md
snapshot/      pinned upstream sources. Gitignored except manifest.json
build/         derived artifacts. Gitignored
```

## Language choices

**Build pipeline: Python 3.14**, managed with `uv`. The phylogenetics ecosystem
is there when needed, Duke et al.'s own interpolation code is Python + numpy,
and the work is one-pass array manipulation over files. It is fast enough:
2.7M nodes parse in 0.9 s.

**Serving binary: undecided, Go or Rust** per architecture §4. It shares only
*files* with the pipeline — no runtime, no FFI — so decide it independently.

## Working on the pipeline

```bash
cd pipeline
uv sync
uv run concestor-build snapshot   # phase 0
uv run concestor-build topology   # phase 1
uv run concestor-build dates      # phase 2 — the decision gate
uv run concestor-build render     # throwaway renderer
```

### Every change must pass all four

```bash
uv run ruff format src tests
uv run ruff check src tests
uv run ty check
uv run pytest
```

`ruff` and `ty` are pinned in the dev dependency group; use the versions
resolved there rather than a system install.

### Strict typing is required

The project is fully annotated and `ty check` must pass clean. Rules live in
`pipeline/pyproject.toml`.

- **Annotate every function** — ruff's `ANN` rules enforce it. Tests are exempt
  from return annotations only.
- **Use the aliases in `concestor_build/typing_.py`** rather than bare
  `np.ndarray`. The dtypes are load-bearing: `parent` being `u32` is what makes
  it 10.9 MB instead of 21.8, and a signature saying `U32Array` says so.
- **`Any` is allowed only for decoded JSON**, via the `Json` / `JsonDict`
  aliases. A remote payload's shape is the remote service's business.
- **Narrow optionals explicitly.** `ParsedTree.branch_length` is `F64Array |
  None`; phase 2 raises a clear error rather than letting numpy fail obscurely.
  ty caught that one, which is the point.

### Do not apply a lint or type fix without reading the surrounding code

Two real bugs in this repo came from exactly that:

- Renaming `rank` to `_rank` to silence an unused-variable warning left the
  column it fed permanently `NULL`. Every gate still passed. The only symptom
  was the database being 19 MB smaller.
- `is_broken` on `node` was always zero, because broken taxa are *rejected*
  from synthesis and so are not nodes at all. They now live in `broken_taxon`.

Both are now covered by `tests/test_db_contents.py`. When a lint fix touches a
name that flows into output, check the output.

## Gates, and how to treat them

Each phase collects **gates** rather than raising on the first failure, so a run
reports every problem at once and then refuses to write its output. `require`
blocks the build; `observe` is recorded but never fails it. Results land in
`build/phase{N}_gates.json`.

The expected values are **measured, not estimated**. A mismatch usually means a
real bug — but check what the gate is measuring before changing either side.
Mean depth failed at 41.67 against an expected 41.32 because `data-sources.md`
says *root-to-tip* depth, and the gate was averaging over all nodes including
internal ones. The doc was right.

Counting rows is not the same as checking them. Structural gates validate the
shape of the data; add a content gate whenever a column starts carrying
something a downstream consumer depends on.

## Facts that will cost you hours

All detailed in `docs/data-sources.md`:

- `files.opentreeoflife.org/synthesis/current/` is **frozen at 2016**. Pin
  `opentree16.1` explicitly, resolved from the live API's `synth_id`.
- **OTT id forwarding is silent** — 297,070 entries. Always compare the
  returned `ott_id` against what you sent, and chase forwards transitively.
- `taxon_info`'s `is_suppressed_from_synth` field is **wrong**. Don't trust it.
- **Never** point treePL or `ape::chronos` at a branch-length-free topology.
  treePL does not error; it emits a confident dated tree containing zero
  information.
- The Open Tree API has **no rate limiting because nobody implemented it**, and
  it is one `waitress` process behind a small academic project. Pace requests.
  It is a build-time oracle only, never a runtime dependency.
- GBIF caps paging at **offset 100,000**, and the PBDB checklist has 461,889
  records. Shard, then prove coverage by counting distinct keys.

## Current state

Phases 0, 1 and 2 are implemented; 3–5 are not started.

**Phase 2 did not accept the Duke et al. dated tree.** The ages are excellent
but topology congruence measured 99.6036% against a 99.9% threshold. Read
`docs/phase2-decision.md` before doing anything that depends on ages. The
fallback congruification pipeline is **documented but deliberately not
started** — it is 4–6 weeks and probably the wrong call.

`concestor-build dates --provisional` writes ages anyway, tagged
`phase2_accepted: false`, so the walking-skeleton renderer has something to
draw. Those ages must not ship.
