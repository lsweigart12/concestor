# Concestor — architecture

A web app for exploring the tree of life: pick species, see the minimal subtree that
connects them through their common ancestors, drill into the fossil record along any
branch, all laid out against deep time.

This document covers the data model, storage, backend, and rendering. It assumes the
findings in [data-sources.md](data-sources.md). The ingest pipeline is specified in
[ingest.md](ingest.md).

---

## 1. Shape of the system

**Everything is baked at build time. The runtime is read-only and stateless.**

The dataset is static — a fixed release of a synthetic tree, a fixed taxonomy snapshot,
a fixed fossil database export. Nothing a user does writes to it. There is no database to
operate, no cache to invalidate, no write path to make consistent. A rebuild produces a
new immutable artifact set, ships as a new container image, and deploys atomically.

```
  BUILD (offline, ~hours, on a release cadence)
      OTT synth v16.1, OTT taxonomy 3.7.3, Duke et al. dates,
      PBDB snapshot, PhyloPic mirror, ICS chart.ttl
        → resolve (xref) → normalize → emit artifacts
        → topology/*.npy (mmap'd), concestor.db (SQLite RO), silhouettes/

  RUNTIME
      read API (single static Go binary) · stateless · N replicas · no DB
        → client: SVG chronogram, owns topology after first paint
```

The Open Tree live API appears nowhere in the runtime. It is a build-time validation
oracle only (§9).

---

## 2. The load-bearing idea: everything is ancestor paths

Interactions 1 and 2 need one primitive:

> **`path(node) → [root, …, node]`** — the ancestor chain, root-first.

Mean length 41, max 111 (see data-sources). About 450 bytes on the wire.

Given a selected set `L`, fetch `path(l)` for each `l ∈ L`. Then:

```
marked   = ⋃ path(l)                                       # every node on any path
rendered = { v ∈ marked : v ∈ L  or  v has ≥2 children in marked }
edges    = each rendered node → its nearest rendered ancestor
```

That is the induced subtree with degree-2 nodes suppressed. It is `O(|L| × depth)` —
sub-millisecond in the browser, no server round trip.

- **Interaction 1 is a special case.** The LCA of two leaves is the last common element
  of their two paths. No separate MRCA endpoint.
- **Interaction 2 reflows smoothly.** Adding an Nth node fetches one path (~450 bytes)
  and re-runs the same computation. The client owns the topology, so the new layout is
  available in the same frame as the click.
- **Interaction 3's content falls out of the same structure.** A rendered edge `u → v`
  is a **segment** carrying the ordered list of suppressed intermediate nodes between its
  endpoints — the "notable intermediate entries", already computed, already ordered,
  already carrying ages. Drilling in renders data you already have, plus a fossil query.

`path()` is the only topology primitive the API exposes; everything else is set
operations on its output.

---

## 3. Data model

### 3.1 Node identity

The synthetic tree has two kinds of node. Named ones carry an OTT id (`ott770315`).
Unnamed internal nodes carry a synthesized label (`mrcaott83926ott3607676`) and have no
OTT id. Both appear constantly in induced subtrees — they are the divergence points.

OTT id **cannot** be the primary key. The model uses a **dense internal index** (`idx`,
a `u32` assigned by preorder traversal) as the primary key, and carries OTT id as an
indexed, nullable secondary attribute.

Preorder-assigned `idx` gives:

- `parent[idx] < idx` always, so the parent array delta-encodes to almost nothing.
- Subtree containment is an interval test: `v` is under `u` iff `in[u] ≤ in[v] < out[u]`.
- **Tip ordering is inherent.** Sorting selected leaves by `idx` gives a stable canonical
  vertical order; adding a leaf inserts it in place and never permutes the others, which
  is what makes reflow animate rather than reshuffle.

OTT ids are **not stable**: `forwards.tsv` carries 297,070 retirements in this release,
and the live API follows them silently. The resolution layer (§5) chases forwards
transitively at build time and records every hop.

### 3.2 Core arrays — `build/topology/*.npy`

Hot-path data lives in flat typed arrays, memory-mapped by the API process. No SQL on the
path lookup. There is no `topology.bin`/`meta.bin`: a `.npy` file is a 128-byte ASCII
header followed by the raw little-endian array, so phase 1's output already *is* this
format and `server/internal/npy` mmaps it directly. The dtypes are load-bearing.

| Array | Type | Bytes/elem |
|---|---|---:|
| `parent` | u32 | 4 |
| `depth` | u8 | 1 |
| `subtree_out` | u32 | 4 |
| `tip_count` | u32 | 4 |
| `age_ma` | f32 | 4 |
| `age_tier` | u8 | 1 |
| `age_layout` | f32 | 4 |

For 2,725,682 nodes. `path()` is a ~41-step walk through a mmap'd `u32` array —
nanoseconds, no allocation, no query planner. `subtree_in` is `idx` itself, so it is not
stored. Phase 2's `age_layout` and `age_tier` are also kept under `_phase2` names so
phase 4's rewrite can be diffed against them and re-run without compounding its output
(§3.5). Thirteen files ship; `build/manifest.json` lists every one with its byte count,
and eleven are mmap'd at startup. `flags` is not an array — it is a `TEXT` column on
`node`.

### 3.3 `concestor.db` — SQLite, read-only

Everything not on the hot path. Opened `mode=ro&immutable=1`.

```sql
-- names, ranks, and the ott_id ↔ idx map
CREATE TABLE node (
  idx          INTEGER PRIMARY KEY,   -- matches array index
  ott_id       INTEGER,               -- NULL for mrca* nodes
  node_key     TEXT NOT NULL,         -- 'ott770315' | 'mrcaott83926ott3607676'
  name         TEXT,
  rank_id      INTEGER,               -- dictionary-encoded
  phylopic_id  TEXT,
  source       INTEGER NOT NULL       -- 0=taxonomy-only, 1=phylogeny-supported
);
CREATE UNIQUE INDEX node_ott ON node(ott_id) WHERE ott_id IS NOT NULL;
```

There is no `is_broken` column: a non-monophyletic taxon is *rejected* from synthesis
(`num_taxa_rejected: 9839`), so none of the 9,839 is a node and the flag would be
permanently zero. They live in **`broken_taxon`** (9,839 rows) carrying the substituted
MRCA, its resolved `idx`, the attachment points, and the intruding taxa, so the UI can
explain the substitution rather than silently answer a different question.

```sql
-- one row per *name*; content='', node_fts.rowid is a search_name.id, never node.idx
CREATE VIRTUAL TABLE node_fts USING fts5(
  sci, abbr, syn, vern, broken,
  content='', tokenize='unicode61 remove_diacritics 2'
);
```

Five FTS columns as built: `abbr` (the *T. rex* form), `syn` (synonyms), `vern` (common
names, phase 6), and `broken` (the 9,839 rejected taxa, which otherwise have no
`node.name` and are unsearchable).

**Six corpora in five columns.** `search_name.kind = 5` is the name PBDB uses for a
taxon the tree holds as a node, and it shares the `syn` column: the *weight* it wants is
a synonym's, but the *caption* is a different claim and `kind` is what carries that
(`matched_on: "fossil-name"`). Without it, refusing those rows from the fossil list
leaves 847 taxa with no name that finds them — see fossil-grafts.md §9.

```sql
-- fossil taxa, attached to the tree rather than placed in it
CREATE TABLE fossil (
  pbdb_taxon_no   INTEGER PRIMARY KEY, -- unique; parent_no/accepted_no/GBIF sourceId ref it
  pbdb_orig_no    INTEGER NOT NULL,    -- NOT unique; kept as ordinary column
  accepted_no     INTEGER NOT NULL,
  name            TEXT NOT NULL,
  rank            TEXT,
  attach_idx      INTEGER NOT NULL,   -- deepest in-synth ancestor. see §3.4
  attach_method   INTEGER NOT NULL,   -- provenance of that attachment
  fea, fla, lea, lla  REAL,           -- the two appearance brackets
  lla_identified  REAL,               -- youngest end an *identified* member reaches
  young_end_occs  INTEGER NOT NULL,   -- occurrences sitting at it
  lla_drawn       REAL,               -- where it may be drawn. see §7
  n_occs          INTEGER NOT NULL,   -- notability signal
  is_extant       INTEGER             -- nullable: 1.7% genuinely unknown
);
CREATE INDEX fossil_attach ON fossil(attach_idx, n_occs DESC);

-- the resolution layer, §5
CREATE TABLE xref (
  source        TEXT NOT NULL,        -- 'pbdb'|'gbif'|'ncbi'|'phylopic'|…
  source_id     TEXT NOT NULL,
  idx           INTEGER,              -- NULL = deliberately unresolved
  method        TEXT NOT NULL,
  confidence    REAL NOT NULL,
  candidates    TEXT,                 -- JSON array when ambiguous
  PRIMARY KEY (source, source_id)
);

CREATE TABLE silhouette (
  phylopic_id TEXT PRIMARY KEY,
  license_url TEXT NOT NULL,
  attribution TEXT,                   -- original creator
  contributor TEXT,                   -- uploader; differs ~50% of the time
  commercial_ok INTEGER NOT NULL
);
```

The database is ~1.9 GB. `concestor-build package` reports the current artifact size
every build — treat it as a reading, not a constant. It fits in a container image;
`deployment.md` sizes it against a real machine.

### 3.4 Fossils attach to segments; they are not placed in the tree

Only 0.5% of OTT taxa flagged `extinct` appear in the synthetic tree at all. Fossils are
a parallel corpus with no topology of its own.

At build time each PBDB taxon gets an **attachment point**: the deepest node in the
synthetic tree that is an ancestor-or-self of it, computed by walking PBDB's own
`parent_no` classification upward until a taxon resolves to an in-synth OTT node.
*Tyrannosaurus* attaches to itself; *Triceratops* attaches to its nearest in-synth
ancestor (Dinosauria).

The claim is weak and honest: *"this taxon belongs somewhere below node X, and existed
between these dates."* Not *"this taxon is the sister of that one."* The UI must not imply
more.

Segment query is an index scan on `attach_idx`, ordered by `n_occs DESC`. `n_occs` is the
notability ranking — a genus with 400 occurrences is one people have heard of; a genus
with 1 is a single paper.

### 3.5 Age provenance is a first-class field

Only 6.7% of the tree's tips are phylogenetically placed; the rest come from taxonomy
alone. Any dating is overwhelmingly interpolating ages onto taxonomy-derived structure, so
`age_tier` is stored per node and rendered visually — a date shown without that context
misleads.

**Four tiers.** `measured`, `interpolated` and `structural` all answer "when did these
lineages part", from a chronogram of **extant** species. An extinct taxon never joins the
chronogram, so it is `structural` by construction, not by measurement.

| Tier | Meaning | Rendering |
|---|---|---|
| **measured** | matched a published chronogram node | solid, age label shown |
| **interpolated** | between two measured nodes | lighter, age shown with a range |
| **structural** | taxonomy-only region, or extinct taxon | dashed spine, no numeric age; position ordinal |
| **occurrence** | fossil appearance interval attached at the node | range mark spanning the interval; **never a point** |

`occurrence` answers a different and weaker question than the first three: when the taxon
is observed in the rock. It is written by **phase 4** (the `fossil` table does not exist
until then), lives in the **`occurrence` table** rather than in `age_ma`, and renders as a
range — no midpoint is computed anywhere. A stratigraphic range is an observation, not an
estimate of divergence; keeping it out of `age_ma` is what stops a confident divergence
number appearing on a dashed node.

**Three age arrays ship and must stay separate:**

- `age_ma` — what may be shown; NaN where nothing may be.
- `age_tier` — how it renders.
- `age_layout` — where to draw; finite everywhere.

Merging `age_ma` and `age_layout` to save space would put a confident number on every
dashed node, the exact failure this split prevents. Phase 4 rewrites `age_layout` with the
fossil brackets (so *T. rex* draws at 66.0 Ma, not 25.9), while `age_ma` stays untouched.

---

## 4. Backend

**One static Go binary over mmap'd arrays plus read-only SQLite.** The `.npy` arrays are
mmap'd at startup; `concestor.db` is opened `immutable=1`. Both are baked into the
container image. mmap ergonomics and mature read-only SQLite decided Go over Rust.

- **No database server.** Nothing to provision, back up, fail over, or migrate.
- **Stateless replicas.** Scale horizontally by adding containers.
- **Atomic releases.** A rebuild is a new image tag; rollback is a previous tag.
- **Version pinning is structural**: the artifact set and the code that reads it ship
  together, so v16.1 dates can never be served against a v15.1 topology.

The deployable payload is ~2.2 GB — the artifact set, ~156 MB of mirrored silhouettes the
server resolves and serves itself, and the ~10 MB binary. Large for a container, fine for
one that deploys on a release cadence. `deployment.md` §1 has the RSS it actually needs
(≈361 MB after startup).

### Endpoints

| Route | Returns |
|---|---|
| `GET /v1/path/{key}` | ancestor chain: idx, key, name, rank, age, tier, tip_count, phylopic |
| `GET /v1/search?q=` | typeahead candidates (one FTS5 query; a zero-match query costs a second, on a corrected spelling). `&under={key}` fences both catalogues to one clade — two comparisons per candidate, since containment is the preorder interval |
| `GET /v1/children/{key}` | the named taxa one drill-down step below a clade, largest subtree first — the scoped palette's empty state. Unnamed `mrcaott…` children are stepped through to their named descendants |
| `GET /v1/segment/{upper}/{lower}` | intermediates + ranked fossils with brackets |
| `GET /v1/node/{key}` | detail panel: synonyms, sources, xref provenance, attribution |
| `GET /v1/timescale` | ICS intervals, ~40 KB, `immutable` |
| `GET /v1/random-pool/{build_id}` | the two pools a random pick draws from — bare id lists (13,918 nodes, 1,935 fossils, 114 KB); two full scans run once per process, warmed in the background at startup |
| `GET /v1/about` | what is running; also the frontend boot probe and warm-up |

**Caching.** All responses are ETag'd by build id. The ETag is `<build_id>-<code_id>`:
`store.computeBuildID` hashes only the on-disk artifacts, so an ETag keyed on the dataset
alone would let a code change to a response shape go unrevalidated. `/v1/about` publishes
`build_id` (dataset) and `commit` (code) separately.

Most endpoints are `public, max-age=3600, s-maxage=31536000` — a year for the edge, an
hour for the browser. The data is immutable within a build; a deploy is a new Worker
version and Workers Cache (enabled in `web/wrangler.jsonc`) is keyed by version, so the
edge starts empty and can be trusted with the year. Two special cases:

- **`/v1/random-pool/{build_id}`** serves the two *pools* (pure functions of the build) so
  the client draws; there is no `no-store` JSON on `/v1`. The build id is in the path
  because a node index means nothing across builds; a mismatched id is refused
  `404 + no-store` rather than answered from the current pool. Scans are warmed in a
  background goroutine at startup. Exclusion of already-drawn taxa happens client-side
  before the choice.
- **`/v1/about`** is short-lived: `max-age=60, must-revalidate` — an hour is too long to
  answer "what is running" wrongly. `must-revalidate` makes it reach the container on every
  boot, so it doubles as the boot probe and warm-up; asking it first wakes a sleeping
  container. (There is no `/healthz` probe: nothing routes a non-`/v1/*` path to the
  container, and it was answered `200 text/html` by the SPA shell.)

### Search ranking

FTS5 over names plus synonyms, ranked by: exact match, then `tip_count` descending, then
has-silhouette, then has-measured-age. Ranking ambiguous prefixes by subtree size is what
surfaces Canidae before *Cania*.

**Vernacular names** are ingest **phase 6**, from Wikidata (not GBIF: `topology.py` never
parses `sourceinfo` and the snapshotted `simple.txt.gz` carries no vernaculars). Ordering
is in [name-ranking.md](name-ranking.md).

**A misspelled query is corrected, and the correction is shown, never performed.** Only
when the query answers with nothing does `store.Suggest` run: it looks the words up in a
phonetic index built by the search phase, ranks candidates sharing a key by Damerau
distance, and re-runs the unchanged search on the result. `corrected` rides on the
response beside `query`. It does not reach names the corpus lacks (`hard maple`, a real
name for *Acer saccharum* not carried by phase 6, is refused by the key, not a threshold).

### Rejected data structures

Postgres, `sql.js-httpvfs`, and a graph database were all considered and rejected: nothing
here needs a query planner or transactions, FTS5 over 2.4M names through HTTP range
requests is slow and unpredictable, and a parent-pointer array is the correct structure
for a tree at four bytes per node.

### Progressive client-side topology

`parent.npy` delta-encodes extremely well (preorder numbering guarantees
`parent[i] < i`), varint-encoding to roughly 3–4 MB, ~2 MB Brotli. Fetched in the
background after first paint; once resident, the client computes paths locally and stops
calling `/path`. This is a **progressive enhancement**, never blocking first paint.

---

## 5. Identifier resolution

**All resolution happens at build time. The runtime never matches names.** The `xref`
table is an artifact, reviewed like code.

### Methods, in strict precedence order (as shipped in `fossil_attach_method`)

| Method | Source | Confidence |
|---|---|---|
| `manual` | curated TSV in the repo | 1.00 |
| `ott_sourceinfo` | OTT's own `sourceinfo` column (resolves ids only) | 0.99 |
| `gbif_pbdb_chain` | PBDB `taxon_no` → GBIF legacy `taxonID` → `nubKey` → OTT | 0.90 |
| `gbif_backbone_provenance` | offline half of the same chain (`simple.txt.gz` cols 8, 10) | 0.85 |
| `phylopic_resolve` | PhyloPic `/resolve/opentreeoflife.org/taxonomy/{ott}` | 0.98 |
| `name_exact` | exact string, **unique** candidate only | 0.70 |
| — | ambiguous or unmatched → `idx = NULL`, candidates recorded | 0.00 |

The build follows **ingest.md's ordering** and **this document's confidences**; the
namespaces are disjoint, so PhyloPic and PBDB never compete. `ott_sourceinfo` is
**many-to-one** (*Amanita muscaria* carries six NCBI ids), so the table holds a list.

The PBDB chain is what makes fossils work, at ~48.2% end-to-end yield. **There is no fuzzy
method.** `name_exact` requires exactly one candidate; a name yielding two goes to review
with its candidates recorded, because 16% of PBDB genus names hit multiple GBIF keys
including cross-kingdom homonyms.

**`refuse_disagreements`** (phase 3) withdraws what a name claims and the evidence
contradicts. It contradicts on the two facts both corpora record and a shared spelling
cannot fake.

**Extancy.** PBDB calls a taxon extinct, OTT's same-named taxon carries no extinct flag,
and the node still has a chronogram-dated descendant — this catches homonyms across
kingdoms (PBDB's *Ivesia* is an Ediacaran rangeomorph; OTT's is a rose-family plant).

**Rank.** PBDB ranks the taxon above the genus and the node it reached is a genus or
below. A genus-group name and a name above it are separate nomenclatural acts, so two
taxa spelled alike across that line are homonyms and never the same taxon. This is the
class extancy is structurally blind to: a clade holding living species *is* extant, so
PBDB's *Eutheria* — flagged extant, as placentals are — passed the extancy sweep on its
way onto a leaf-beetle genus, taking 1,191 fossils into Coleoptera with it. 103 nodes
were holding 9,247 fossils that way. One direction only: a PBDB genus or species landing
on a family is GBIF and OTT filing a name they cannot place at its container, which is
where the fossil belongs anyway. OTT's `section` counts as suprageneric — it is
infrageneric in botany but every one this corpus reaches is zoological (*Schizophora*,
56,619 tips), and reading it the other way withdraws three correct resolutions.

Load-bearing ordering: extancy and rank both run **before** the ambiguity sweep, so a
node claimed twice is decided on evidence while one claimant survives rather than losing
both — `Scopus` keeps the hamerkop, and *Cytherelloidea* keeps the ostracod genus when
its superfamily namesake goes. Extancy needs phase 2's `age_ma` as a living-lineage guard
(without it 1,162 correct attachments go), and `manual` overrides are exempt from all
three.

### Manual override

Overrides live in `data/overrides.tsv`, git-tracked, one row per decision with a required
`reason` column. Git-tracked rather than in the database because an override is a judgement
call about contested taxonomy, and judgement calls need review, attribution, and history.

### Reconciliation report

Every build emits `build/reconciliation.json`: resolution counts by method, new
ambiguities, **regressions** (previously-resolved ids that now fail), and forwards chased.
The regression count is the one to gate on — a build that loses previously-working
mappings has a broken upstream snapshot and should fail rather than degrade quietly.

---

## 6. Time as an axis

### Source

Duke et al. 2026 `equal_splits_median_tree.tre` (Zenodo `10.5281/zenodo.19049120`,
CC-BY), keyed to OTT 3.7.3 against synthesis v16.1 — the same release the topology comes
from. Ages join by node, with no grafting step. `birth_model_median_tree.tre` is ingested
alongside as a comparison layer.

**The Duke et al. dated tree is accepted** (phase 2, 32/32 gates). A bifurcating
chronogram cannot be node-for-node compatible with a ~12,964-way polytomy, so the criterion
was restated rather than the data changed: the 947 genuinely contradicted nodes are demoted
to the `structural` tier and render without a number. **Do not start the fallback
congruification pipeline** (hash-matching shared taxon sets, then BLADJ interpolation) — it
is weeks of work for a less defensible time axis, retained only as a documented fallback.

Build-time validation: every node's age must be ≥ its children's. A nonzero violation
count in a region intended to render as `measured` fails the build.

**The source is extant-only**, which has a layout consequence: undated runs are positioned
by spreading them between the nearest dated ancestor and deepest dated *descendant*. An
extinct lineage has no dated descendant, so the spread drags toward the present (*T. rex*
would draw at 25.9 Ma, Cambrian trilobites in the Neogene). The fix belongs to the fossil
layer (§3.4, phase 4's `age_layout` rewrite) and cannot live in phase 2.

### Scale

**Proportional, and only proportional.** `ageFrac(age, maxAge)` in
`web/src/tree/layout.ts` is the single mapping — `age / max(maxAge, 1)`, present at 0 and
the deepest drawn node at 1 — and `layout()`, `toScreenX` and its inverse all go through
it. There is no mode parameter and no second scale.

A symlog view rode beside it for a long time: linear from 0 to `t₀` (1 Ma), logarithmic
above, with the knee marked, because `log(0) = -Infinity` and because linear time puts
every hominin divergence inside one pixel next to the Cambrian. It was removed (issue
150). Two scales meant every position on the canvas had to be read against a ruler the
reader first had to identify, and the tick ladder, the knee marker, the URL parameter,
a key binding and a chip in the sidebar all existed to tell them which one they were on.
Recent splits get their room from the zoom instead, which rescales the ruler with the
tree rather than bending it.

**The axis belongs to the canvas, not the selection.** It runs to the Big Bang
(13787 Ma) and stops — no rule, tick, or band beyond it; `maxAge` (deepest drawn node)
still normalises the scale. The geologic band stops at 4567 Ma (`chart.ttl` starts at the
Hadean's `begin_ma`); both ends carry a marker (*Earth forms*, *Big Bang*). Where the axis
continues past the viewport it is left to run off — an edge a reader cannot account for is
worse than one off-screen. **The present is named, not numbered** (the 0 tick reads
"present"); collision is measured between label boxes. **Ticks come from the visible
window**: the axis inverts screen x to age, generates a 1–2–5 ladder over what is on
screen, and places candidates by priority (present, then boundaries 66/252/541, then
powers of ten), so a zoom follows the view.

### Geologic scale bar

From ICS `chart.ttl` (v2026/06, CC-BY, 178 concepts, official CGMW colors), parsed once at
build into ~40 KB of JSON. Bands with level of detail driven by pixels-per-Ma **per region,
not per axis** (one rank across the whole strip is never right at every zoom). The band is
grown down the ICS containment tree (`parent` is in the payload): a node hands over to its
children when the children that carry their own names cover ≥ 70% of its width. Zooming
refines it; panning does not. **A band is labelled with its whole name or not at all** —
every abbreviation is worse than silence, and the name-aware tiling never makes a split that
would leave its children unnameable.

**Palette.** The design language wins over CGMW convention: keep the official hue
*relationships*, drop the saturation and luminance (dim, desaturated, recessive). Every
pairwise distance is scaled by `K = 0.22`, hue bit-preserved, gated as **faithful** rather
than as a distinguishability the flat ICS Paleoproterozoic ramp cannot deliver. The band
never glows; wayfinding is labels and hairline dividers first, hue second.

---

## 7. Rendering

[design-reference.md](design-reference.md) is authoritative on the visual language, command
surface, motion, and stack. This section records only what is specific to *this* data.

### The rendered set is tiny

The dataset is 2.4M leaves; the rendered set is not. `|L|` selections produce at most
`2|L| − 1` nodes after suppression — ten species is nineteen nodes; a drill-down lane adds
tens more. Drawing dozens to low hundreds of elements is what makes xyflow v12 viable (real
text, `getTotalLength()` draw-on animation, inline SVG silhouettes, native hit-testing,
accessibility). The large source dataset is the wrong number to optimize against.

### Layout — do not use a graph-layout engine

The layout is deterministic, computed, not simulated; nodes are not draggable. A graph
engine (dagre/ELK/d3-hierarchy) would assign `x` by depth, but here:

```
x = f(age_ma)      proportional time, present at the right edge        (§6)
y = tip lane       assigned by preorder idx                            (§3.1)
```

A solver would silently destroy the time axis. Two properties fall out of preorder
numbering: lane assignment is stable by construction (adding a leaf inserts in place), and
an internal node's `y` is the midpoint of its children's extent (so a lane keeps its
position and hue across renders). Edges are orthogonal with a small corner radius
(`M x1 y1 L x1 y2 L x2 y2`); convergent branches are ambiguous under bezier.

### Provenance needs a channel luminance has already taken

Brightness is reserved for recency and selection, never data value. Provenance (§3.5) is a
data value the app must render, so it gets:

- **`structural` tier — no numeric age at all.** The hard requirement: a dashed edge and an
  absent number, never a confident figure where nobody estimated one.
- **Dash pattern** for the edge (not stroke width, so it keeps uniform stroke weight; reads
  as inferred).
- **Desaturation** for `interpolated`, between measured and structural.

`structural` nodes are positioned ordinally between nearest dated ancestor and descendant.
Because the source is extant-only, a dated descendant is nearly always a tip at the present,
so most structural fills run from the ancestor down to zero; the ancestor side is always
answerable. `/v1/node` serves `layout_spread` (both bounds, recovered from the arrays by a
contiguous subtree scan); `web/src/detail/spread.ts` turns them into the sentence each case
needs. The dash channel cannot distinguish an ordinal position between two real bounds from
one with no lower bound that has drifted to the present; the `occurrence` tier's range mark
(§3.5) is the treatment for that, reading as *bounded but not pinned*.

### The signature interaction

design-reference.md specifies it in full. Two notes from the data side: **the MRCA is
free** (the last common element of the two ancestor paths, already in memory), so the flare
fires in the same frame as the click; and **draw order is root-ward → leaf-ward, lightly
staggered** over the segment's already-computed suppressed nodes. Honor
`prefers-reduced-motion` by cutting to the final state.

### Drill-down (interaction 3)

Clicking a segment expands it into a lane beneath the main chronogram, sharing the time
axis:

- **Intermediate OTT nodes** on the spine at their ages, ranked by `tip_count` and named
  rank — Synapsida, Therapsida, Cynodontia on the way to mammals.
- **PBDB fossil taxa** as time-range bars, ranked by `n_occs`, drawn with the **double
  bracket**: faded envelope `fea→lla` (maximal possible extent), solid bar `fla→lea`
  (minimal certain extent).

The four bounds do **not** form a chain. `fea ≥ fla`, `lea ≥ lla`, `fea ≥ lea` and
`fla ≥ lla` all hold, but **`fla ≥ lea` holds for only 39.6%** of rows (a taxon known from
one stratigraphic interval has both appearances inside it). For the other 60.4% there is no
certain extent and the solid bar must be left *undrawn* — not zero-width (reads as
precision), not inverted.

**The young end is not always a fact about the named taxon.** PBDB's `lastapp_min_ma`
aggregates a taxon's whole subtree, so a young end below every descendant's rests on
material catalogued no finer than the taxon itself (a `Stegosaurus sp.`). `lla_drawn` is the
only column a mark's x may read; where it differs from `lla`, the card prints PBDB's range
unchanged and states the difference in words. ~21% of PBDB taxa have no interval — an
explicit "no range recorded" treatment, not a zero-width bar. See
[fossil-grafts.md](fossil-grafts.md) §3.

### Silhouettes

Priority-one work: for a non-specialist an image is what makes a clade mean anything.
PhyloPic SVGs from the local mirror (~136 MB corpus). Monochrome, so `fill: currentColor`
lets them take the trace colour including the selection bloom. A silhouette legitimately
represents a *clade*, where a photograph represents one member.

Resolution is baked; there is no client-side climb. It lives in `node_image` (not
`node.phylopic_id`), which carries the drawing's own node, the shared clade, the climb, and
the method. Coverage is 100% and is **not** the thing to measure — every node resolving to
*an* image says nothing about whether the image is about anything. The size of the claim is
`node_image.clade_idx`, the smallest clade containing both the node and the drawing, and
that is what the UI renders. Only 12,863 drawings exist for 2.7M nodes, so a borrowed
drawing is drawn with the group it speaks for and how large that group is rather than
withheld.

**A divergence carries a second picture.** `node_image` prefers the most inclusive drawing
beneath a node, which at a *split* is a crown group that did not exist yet. So internal
nodes also carry a **witness** in `node_divergence_witness`: a fossil taxon from *somewhere
below the fork* whose stratigraphic bracket puts it at the split (*Acanthostega gunnari*,
*Eohippus*, *Pakicetus*, *Sahelanthropus* — 885 forks). It hangs off phase 4's
`attach_idx`, so it makes §3.4's weaker claim, and the caption renders `attach_walk` as
bands. Four refusals: the fork must be dated (falling back to `age_layout`), the taxon must
carry a bracket, the fork must lack its own image, and the taxon must be **extinct AND have
ended before the Holocene** (`is_extant` alone is not enough — PBDB flags the living turtle
grass extinct, and a range running to the present cannot fail to contain a recent split).

The two tables stay separate because which applies depends on how the reader reached the
node — only the client knows. A leaf they chose keeps its group's exemplar; a divergence
draws its witness, its own image, or nothing — **never a borrow** (Caniformia's 57 Ma split
would draw raccoons, 25 Ma too young). A node's own drawing is exempt.

**Attribution renders in the UI**, per design-reference.md, as a **command**: creator and
licence in the node detail card, plus a credits view enumerating everything displayed.
CC-BY requires it regardless of commercial use. `attribution` is the original creator and
`contributor` the uploader; they differ ~50% of the time.

### Typography

design-reference.md governs. **Numerics are tabular-figure mono.** One data-side
requirement is not negotiable: **scientific naming convention is not decoration** — species
and genus names italic, higher taxa roman, authority strings smaller and dimmer, keyed on
`rank`. The UI sans needs a genuine italic, not a synthesised oblique.

### Search and the command surface

The palette *is* the interface. Ranking blends baked corpus signals (exact match, then
`tip_count`, then has-silhouette, then has-measured-age) with client-side session signals
(recency, frequency). Vernacular names are the front door — a palette returning nothing for
"dog" or "T. rex" is broken at first contact, and OTT carries no common names, which is why
vernaculars are priority-one (phase 6).

### URL state

`/?n=770315,153563,664349&seg=1234-5678`

The selected set is the application state; encoding it in the URL makes every view
shareable and back-button-correct. design-reference.md extends this to all view state — zoom,
scope, and isolation belong here too.

---

## 8. The four interactions, end to end

1. **Two leaves → minimal connecting subtree.** Search resolves two `idx`; `path()` each;
   LCA is the last common element; render from the LCA down, suppressing degree-2 nodes. One
   round trip, zero once the client has `parent.npy`.
2. **Add an Nth node → induced subtree, animated.** Fetch one path, re-run the suppression
   rule. The new tip slots in at its preorder position; no server layout recomputation, no
   jump-cut.
3. **Click a branch → drill into intermediates.** The segment's suppressed nodes are already
   in memory; one `/segment` call fetches ranked fossils. Lane opens below, spine plus
   double-bracket range bars.
4. **Time axis.** `x` from `age_ma` under one proportional scale, driving the layout.
   Ticks and ICS bands generated from the age range under the viewport. Provenance tiers rendered
   so measured, interpolated, and structural are distinguishable at a glance.

---

## 9. What is deliberately absent

**The Open Tree live API is not a runtime dependency.** There is no rate limiting (nobody
implemented it), no terms-of-use page, and it is one `waitress` process behind a small
academic project; it serves whatever synthesis version it currently has, while our ages and
fossil attachments are pinned to v16.1, so a silent upstream bump would produce a subtly
wrong tree rather than an error. Its real role is a **build-time oracle**: generate induced
subtrees for a few hundred random tip sets via `/tree_of_life/induced_subtree` and diff them
against the baked artifacts.

**TimeTree is absent entirely** — its terms prohibit redistributing the data "and its
transformations", which a tree carrying its ages is.

**No fuzzy matching anywhere in the runtime** (§5).

---

## 10. Risks

| Risk | Severity | Mitigation |
|---|---|---|
| Duke et al. tree fails to validate against v16.1 | **high** — the entire time axis | Phase-2 gate with explicit accept/reject criteria; congruification+BLADJ fallback documented but not built |
| GBIF legacy backbone withdrawn | **high** — the only PBDB→OTT id path | Snapshot it in phase 1. Frozen as of 2023-08-28 |
| Users read interpolated ages as measured | **high** — credibility | Provenance tiers rendered visually (§3.5); structural regions never show a numeric age |
| No vernacular names in search | **medium** | Phase 6 pulls them from Wikidata |
| Broken taxa (9,839) silently answer a different question | **medium** | `broken_taxon` holds all 9,839, plus a fifth `node_fts` column so names are findable; UI explains and offers attachment points |
| PhyloPic NC/SA licensing in a commercial context | **medium** | Licence stored per image; `--commercial-safe` build flag filters NC at 93.7% coverage |
| A 12,964-child polytomy reaches the layout | **low** | Never rendered in full — suppression means only marked children appear; cap the drill-down lane with "showing N of M" |
| PBDB license ambiguity (API says CC0, FAQ says NC-ND) | **low** | Email `admin@paleobiodb.org` before any commercial launch |

---

## 11. Cost

Build: hours, on a release cadence, one machine. Runtime: two small instances (~2.2 GB
image, mostly page cache) behind a CDN that absorbs nearly everything, since all responses
are immutable. Storage: ~2 GB of artifacts plus ~156 MB of mirrored silhouettes.

`concestor-build package` reports the artifact size every build — treat it as a reading and
re-derive it before sizing a machine. Silhouettes are not in the artifact set and must be
wherever the binary is; RSS after startup is ≈361 MB, far below the artifact size. The size
gate in `package.py` is an `observe`: the right response is to decide what to trim, not to
fail a build.

This is a very cheap system to run — the payoff for pushing all the difficulty into a build
pipeline that runs roughly annually when a new synthesis release lands.
