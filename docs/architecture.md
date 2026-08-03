# Concestor — architecture proposal

A web app for exploring the tree of life: pick species, see the minimal subtree that
connects them through their common ancestors, drill into the fossil record along any
branch, all laid out against deep time.

This document proposes the data model, storage, backend, and rendering. It assumes the
findings in [data-sources.md](data-sources.md), which corrects several assumptions in
the original spec. The ingest pipeline is specified separately in
[ingest.md](ingest.md).

---

## 1. Shape of the system

**Everything is baked at build time. The runtime is read-only and stateless.**

The dataset is static — a fixed release of a synthetic tree, a fixed taxonomy snapshot,
a fixed fossil database export. Nothing a user does writes to it. That single fact
determines the whole architecture: there is no database to operate, no cache to
invalidate, no write path to make consistent. A rebuild produces a new immutable
artifact set, which ships as a new container image, which deploys atomically.

```
  BUILD (offline, ~hours, run on a release cadence)
  ┌────────────────────────────────────────────────────────────────┐
  │ OTT synth v16.1 ─┐                                             │
  │ OTT taxonomy 3.7.3┤                                            │
  │ Duke et al. dates ┼─→ resolve ─→ normalize ─→ emit artifacts   │
  │ PBDB snapshot    ─┤   (xref)                                   │
  │ PhyloPic mirror  ─┤                                            │
  │ ICS chart.ttl    ─┘                                            │
  └────────────────────────────────────────────────────────────────┘
                              │
              ┌───────────────┼────────────────┐
              ▼               ▼                ▼
      topology.bin      concestor.db     silhouettes/
      meta.bin          (SQLite, RO)     (SVG, on CDN)
       (mmap'd)
              │               │                │
  RUNTIME     └───────┬───────┘                │
  ┌──────────────────────────────────┐         │
  │  read API (single static binary) │         │
  │  stateless · N replicas · no DB  │         │
  └──────────────────────────────────┘         │
              │                                │
              ▼                                ▼
  ┌────────────────────────────────────────────────────────────────┐
  │  client: SVG chronogram · owns topology after first paint      │
  └────────────────────────────────────────────────────────────────┘
```

The Open Tree live API appears nowhere in the runtime. It is used at build time as a
validation oracle only — see §9.

---

## 2. The load-bearing idea: everything is ancestor paths

Interactions 1 and 2 look like they need a tree-traversal service. They don't. They need
one primitive:

> **`path(node) → [root, …, node]`** — the ancestor chain, root-first.

Mean length 41, max 111 (measured; see data-sources). About 450 bytes on the wire.

Given a selected set `L`, fetch `path(l)` for each `l ∈ L`. Then:

```
marked   = ⋃ path(l)                                       # every node on any path
rendered = { v ∈ marked : v ∈ L  or  v has ≥2 children in marked }
edges    = each rendered node → its nearest rendered ancestor
```

That is the induced subtree with degree-2 nodes suppressed. It is `O(|L| × depth)` —
for ten selections, about 410 array reads. Sub-millisecond, in the browser, with no
server round trip.

Three consequences follow, and they are why this is the right foundation:

**Interaction 1 is a special case.** The LCA of two leaves is the last common element of
their two paths. No separate MRCA endpoint, no separate code path. Two selections is
just `|L| = 2`.

**Interaction 2 is free, and reflow is genuinely smooth.** Adding an Nth node fetches
one path (~450 bytes) and re-runs the same computation. The client owns the topology, so
the new layout is available in the same frame as the click — before the network even
settles, if the path is cached. Nothing about the reflow is waiting on a server, which
is exactly the difference between an animated transition and a jump-cut.

**Interaction 3's content falls out of the same structure.** The nodes *dropped* by the
suppression rule are the interesting ones. A rendered edge `u → v` is not an edge; it is
a **segment** carrying the ordered list of suppressed intermediate nodes between them.
Those are the "notable intermediate entries" — already computed, already ordered,
already carrying ages. Drilling into a branch means rendering data you already have,
plus a fossil query keyed on it.

So `path()` is the only topology primitive the API needs to expose. Everything else is
set operations on its output.

---

## 3. Data model

### 3.1 Node identity

The synthetic tree has two kinds of node. Named ones carry an OTT id (`ott770315`).
Unnamed internal nodes carry a synthesized label (`mrcaott83926ott3607676`) and have no
OTT id at all. Both appear constantly in induced subtrees — they are the divergence
points with no name attached.

So OTT id **cannot** be the primary key. The model uses a **dense internal index**
(`idx`, a `u32` assigned by preorder traversal) as the primary key, and carries OTT id
as an indexed secondary attribute that is nullable.

This matters more than it looks. `idx` being preorder-assigned means:

- `parent[idx] < idx` always, so the parent array delta-encodes to almost nothing
- subtree containment is an interval test: `v` is under `u` iff
  `in[u] ≤ in[v] < out[u]`
- **tip ordering is inherent.** Sorting selected leaves by `idx` gives a stable,
  canonical vertical order. Adding a leaf inserts it in its correct place and never
  permutes the others — which is precisely what makes reflow animate rather than
  reshuffle. Getting this for free from the numbering scheme, rather than maintaining
  it in layout code, is worth the indirection.

OTT ids are also **not stable**: `forwards.tsv` carries 297,070 retirements in this
release alone, and the live API follows them silently. The resolution layer (§5) chases
forwards transitively at build time and records every hop.

### 3.2 Core arrays — `topology.bin`, `meta.bin`

Hot-path data lives in flat typed arrays, memory-mapped by the API process. No SQL on
the path lookup.

| Array | Type | Bytes | Size |
|---|---|---:|---:|
| `parent` | u32 | 4 | 10.9 MB |
| `depth` | u8 | 1 | 2.7 MB |
| `subtree_out` | u32 | 4 | 10.9 MB |
| `tip_count` | u32 | 4 | 10.9 MB |
| `age_ma` | f32 | 4 | 10.9 MB |
| `age_tier` | u8 | 1 | 2.7 MB |
| `flags` | u16 | 2 | 5.5 MB |

**~55 MB total** for 2,725,682 nodes. `path()` is a 41-step walk through a mmap'd
`u32` array — nanoseconds, no allocation, no query planner.

`subtree_in` is `idx` itself, so it isn't stored.

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
  is_broken    INTEGER NOT NULL DEFAULT 0,
  phylopic_id  TEXT,                  -- resolved at build time
  source       INTEGER NOT NULL       -- 0=taxonomy-only, 1=phylogeny-supported
);
CREATE UNIQUE INDEX node_ott ON node(ott_id) WHERE ott_id IS NOT NULL;

CREATE VIRTUAL TABLE node_fts USING fts5(
  name, synonyms, content='', tokenize='unicode61 remove_diacritics 2'
);

-- fossil taxa, attached to the tree rather than placed in it
CREATE TABLE fossil (
  -- Keyed on `taxon_no`, NOT `orig_no`. `orig_no` is not unique — 407,634
  -- distinct values over 523,112 rows, 86,302 of them repeated, and
  -- Dinosauria alone has ten rank-variant records sharing 52775. `taxon_no`
  -- is unique and is what `parent_no`, `accepted_no` and GBIF's `sourceId`
  -- all reference. `orig_no` is kept as an ordinary column.
  pbdb_taxon_no   INTEGER PRIMARY KEY,
  pbdb_orig_no    INTEGER NOT NULL,
  accepted_no     INTEGER NOT NULL,
  name            TEXT NOT NULL,
  rank            TEXT,
  attach_idx      INTEGER NOT NULL,   -- deepest in-synth ancestor. see §3.4
  attach_method   INTEGER NOT NULL,   -- provenance of that attachment
  fea, fla, lea, lla  REAL,           -- the two appearance brackets
  lla_identified  REAL,               -- youngest end an *identified* member reaches
  young_end_occs  INTEGER NOT NULL,   -- occurrences sitting at it
  lla_drawn       REAL,               -- where it may be drawn. see §7 and fossil-grafts §3
  n_occs          INTEGER NOT NULL,   -- notability signal
  is_extant       INTEGER             -- nullable: 1.7% are genuinely unknown
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
  contributor TEXT,                   -- uploader; differs 31% of the time
  commercial_ok INTEGER NOT NULL
);
```

Estimated ~600 MB with the FTS index. Combined with the arrays, the whole dataset is
**under 700 MB** — it fits in a container image and stays resident in page cache on a
small instance.

### 3.4 Fossils attach to segments; they are not placed in the tree

This is the design point the spec's caveat was reaching for, and the data supports it
more strongly than expected: **only 0.5% of OTT taxa flagged `extinct` appear in the
synthetic tree at all**. Fossils are not gaps in an otherwise complete topology. They
are a parallel corpus with no topology of its own.

So at build time each PBDB taxon gets an **attachment point**: the deepest node in the
synthetic tree that is an ancestor-or-self of it. Computed by walking PBDB's own
`parent_no` classification hierarchy upward until a taxon resolves to an in-synth OTT
node. *Tyrannosaurus* attaches to itself (it happens to be in the tree);
*Triceratops* attaches to whatever its nearest in-synth ancestor is — Dinosauria, say.

The claim being made is therefore weak and honest: *"this taxon belongs somewhere below
node X, and existed between these dates."* Not *"this taxon is the sister of that one."*
The UI must not imply more.

Segment query becomes an index scan:

```sql
SELECT * FROM fossil
 WHERE attach_idx IN (…suppressed nodes on this segment, plus its lower endpoint…)
 ORDER BY n_occs DESC;
```

`n_occs` is the notability ranking. It is a real signal — a genus with 400 occurrences
is one people have heard of; a genus with 1 is a single paper.

### 3.5 Age provenance is a first-class field, not a footnote

**Only 6.7% of the synthetic tree's tips are phylogenetically placed.** The other ~2.23M
come from taxonomy alone. Any dating of this tree, including Duke et al.'s, is
overwhelmingly interpolating ages onto taxonomy-derived structure.

A date rendered without that context is a lie of omission, and this app's entire premise
is putting dates on an axis. So `age_tier` is stored per node and rendered visually:

| Tier | Meaning | Rendering |
|---|---|---|
| **measured** | matched a published chronogram node | solid, age label shown |
| **interpolated** | between two measured nodes | lighter, age shown with a range |
| **structural** | inside a taxonomy-only region | dashed spine, no numeric age; position is ordinal |

The third tier is the important one. In a structural region the horizontal axis stops
meaning "time" and starts meaning "nesting depth", and the rendering has to say so. A
dashed spine costs nothing and prevents the app from confidently asserting that two
beetle genera diverged 46.3 Ma when nobody has ever estimated that.

**All three rows describe divergence times, and the source has no extinct taxa in it.**
That is a limit of the table, not of the data available to us. An extinct taxon never
joins the chronogram, so it lands in row three by construction — 1,742 of the 1,743
extinct-flagged nodes in the tree are `structural`, including *T. rex* and *Homo
erectus*, which report "not estimated". Meanwhile §3.4's `fossil` table holds a
first/last appearance bracket for most of them.

A fourth row is **decided and unbuilt**:

| Tier | Meaning | Rendering |
|---|---|---|
| **occurrence** | extinct, with a fossil appearance interval attached at the node itself | range mark spanning the interval; **never a point**, labelled as fossil occurrences rather than as an age |

A stratigraphic range is an *observation of occurrence*, not an estimate of divergence:
one says "specimens of this were in the ground between these dates", the other says
"these two lineages parted". They are only superficially the same kind of number, which
is why the row is separate and why the interval **lives in its own array and never in
`age_ma`** — a rule that then costs no discipline to keep. The channel it needs reads as
*bounded but not pinned* (§7), not as a fourth dash density.

It is worth it because the alternative is worse. Every extinct taxon currently reports
"not estimated", which to a curious reader is the app claiming to know nothing about
dinosaurs — while §3.4's table holds a sourced range for most of them. Declining to show
a real observation is not honesty; it is a different inaccuracy with better manners.
Scope, measurements and the `fea` trap in handoff.md §7.

---

## 4. Backend

### Recommendation: one static binary over mmap'd arrays plus read-only SQLite

Go or Rust. The `topology.bin` / `meta.bin` arrays are mmap'd at startup;
`concestor.db` is opened `immutable=1`. Both are baked into the container image.

- **No database server.** Nothing to provision, back up, fail over, or migrate.
- **Stateless replicas.** Scale horizontally by adding containers.
- **Atomic releases.** A rebuild is a new image tag. Rollback is a previous image tag.
- **Version pinning is structural**, not conventional: the artifact set and the code that
  reads it ship together, so there is no way to serve v16.1 dates against a v15.1
  topology.

Image size ~700 MB. That is large for a container and completely fine for one that
deploys on a release cadence rather than per-commit.

### Endpoints

| Route | Returns | Cost |
|---|---|---|
| `GET /v1/path/{key}` | ancestor chain: idx, key, name, rank, age, tier, tip_count, phylopic | 41 array reads + one batched SQLite lookup |
| `GET /v1/search?q=` | typeahead candidates | one FTS5 query |
| `GET /v1/segment/{upper}/{lower}` | intermediates + ranked fossils with brackets | one index scan |
| `GET /v1/node/{key}` | detail panel: synonyms, sources, xref provenance, attribution | a few indexed lookups |
| `GET /v1/timescale` | ICS intervals, ~40 KB, `immutable` | static |
| `GET /v1/random?kind=` | random taxa that carry their own drawing, from one corpus or the other | one full scan behind `ORDER BY random()`, 83–100 ms |

All responses are `Cache-Control: immutable` keyed by build id, because the data cannot
change within a build. A CDN in front absorbs essentially all traffic — on Cloudflare
that is Workers Cache, enabled in `web/wrangler.jsonc`, and `deployment.md` §5 is why
the header alone was not enough to earn this sentence.

**`/v1/random` is the one exception, and it must stay one.** Its answer is not a
function of the build, so it is served `no-store` with no ETag. Through the
immutable path a browser would answer every later request from cache with the
first pick, permanently — an endpoint that appears to work and never picks
twice. `handoff.md` §3 has the pools and why they are narrow.

### Search ranking

FTS5 over names plus 2.2M synonyms, ranked by: exact match, then `tip_count`
descending, then has-silhouette, then has-measured-age. Ranking ambiguous prefixes by
subtree size is what makes "can" surface Canidae before *Cania*.

**Known gap: OTT carries no vernacular names.** "Tyrannosaurus" works; "T. rex" and
"dog" do not. For an app whose premise is inviting exploration, that is a serious UX
hole, not a rough edge. Vernaculars from GBIF or Wikidata are scheduled as ingest
phase 5 — see [ingest.md](ingest.md).

### Rejected alternatives

**Postgres.** Nothing here needs a query planner, transactions, concurrent writes, or
connection pooling. It would add an operational dependency to serve data that never
changes.

**Fully static via `sql.js-httpvfs`** (SQLite over HTTP range requests, no backend at
all). Genuinely tempting for a static dataset, and worth revisiting if the app ever
needs to run offline. Rejected for now because FTS5 over 2.4M names through range
requests is slow and unpredictable, and the segment drill-down is join-heavy enough to
turn into a request storm. A 40 MB binary is a smaller price than that.

**Graph database.** The tree is a tree. A parent pointer array is the correct data
structure and it is four bytes per node.

### Progressive client-side topology

`topology.bin` delta-encodes extremely well — preorder numbering guarantees
`parent[i] < i` and usually close, so `i - parent[i]` varint-encodes to roughly
**3–4 MB, ~2 MB Brotli**. Fetched in the background after first paint. Once resident,
the client computes paths locally and stops calling `/path` entirely.

This is a **progressive enhancement, not a requirement**. The app is fully functional
against the server endpoint from the first frame; the download just removes the last
network dependency from the interaction loop and enables a whole-tree context ribbon
later. Never block first paint on it.

---

## 5. Identifier resolution

You asked for an explicit resolution layer with a persisted mapping table and manual
override, not fuzzy matching at query time. Agreed, and here is the specification.

**All resolution happens at build time. The runtime never matches names.** The `xref`
table is an artifact, reviewed like code.

### Methods, in strict precedence order

| # | Method | Source | Confidence |
|---|---|---|---|
| 1 | `manual` | curated TSV in the repo | 1.00 |
| 2 | `ott_sourceinfo` | OTT's own `sourceinfo` column | 0.99 |
<!-- This resolves *ids*, and it is the reason three documents claimed GBIF
     vernacular names arrive free with no new resolution work. They do not:
     `topology.py` never parses `sourceinfo` into the database, and the
     snapshotted `simple.txt.gz` carries no vernacular names at all. Common
     names come from Wikidata P9157 and the PBDB ColDP archive. -->
| 3 | `phylopic_resolve` | PhyloPic `/resolve/opentreeoflife.org/taxonomy/{ott}` | 0.98 |
| 4 | `gbif_pbdb_chain` | PBDB `taxon_no` → GBIF legacy `taxonID` → `nubKey` → OTT | 0.90 |
| 5 | `name_exact` | exact string, **unique** candidate only | 0.70 |
| 6 | — | ambiguous or unmatched → `idx = NULL`, candidates recorded | 0.00 |

Method 2 is nearly free and covers a lot: OTT already stores NCBI, GBIF, IRMNG, WoRMS,
Index Fungorum, and SILVA ids verbatim. Note it is **many-to-one** — *Amanita muscaria*
carries six NCBI ids — so the table holds a list, never a scalar.

Method 4 is the one that makes fossils work, at ~59% end-to-end yield. See
data-sources §4 for the verified chain and its decay risk.

**There is no fuzzy method.** Method 5 requires an exact string match yielding exactly
one candidate. If a name yields two, it is not resolved — the candidates are recorded in
the `candidates` column and the row goes to review. This is the whole point: 16% of PBDB
genus names hit multiple GBIF keys, including cross-kingdom homonyms like `Laminarites`
in both Chromista and Plantae. A system that silently picks one is worse than a system
that admits it doesn't know.

### Manual override

Overrides live in `data/overrides.tsv`, git-tracked, one row per decision with a
required `reason` column:

```
source  source_id  ott_id   reason
pbdb    38613      664348   verified via GBIF nubKey 4822631, 2026-07-31
pbdb    52983      NULL     Brontosaurus/Apatosaurus synonymy unstable; suppress
```

Git-tracked rather than in the database, deliberately. An override is a judgement call
about contested taxonomy, and judgement calls need review, attribution, and history —
all of which a database row silently loses.

### Reconciliation report

Every build emits `build/reconciliation.json`: resolution counts by method, new
ambiguities since the last build, **regressions** (previously-resolved ids that now
fail), and forwards chased. The regression count is the one to gate on. A build that
loses 10,000 previously-working PBDB mappings has a broken upstream snapshot, and that
should fail the build rather than quietly degrade the fossil layer.

---

## 6. Time as an axis

### Source

Duke et al. 2026 `equal_splits_median_tree.tre` (Zenodo `10.5281/zenodo.19049120`,
CC-BY), keyed to OTT 3.7.3 against synthesis v16.1 — the same release we build the
topology from. Ages join by node, with no grafting step. `birth_model_median_tree.tre`
is ingested alongside as a comparison layer.

This replaces the congruification pipeline the spec anticipated. That pipeline
(hash-matching shared taxon sets between incongruent topologies, then BLADJ
interpolation) is retained only as a documented fallback if phase-2 validation rejects
the Duke tree. See ingest.md.

Build-time validation: every node's age must be ≥ its children's. Violations are
counted and reported; a nonzero count in a region we intend to render as `measured`
fails the build.

**The source is extant-only, and that has a layout consequence, not just a coverage
one.** Undated runs are positioned by spreading them between the nearest dated ancestor
and the deepest dated *descendant*. An extinct lineage has no dated descendant, so the
spread has nothing to anchor its lower end and drags the whole run toward the present:
*T. rex* is drawn at 25.9 Ma, and Cambrian trilobites land in the Neogene. This is not
the ordinal-position caveat working as intended — an ordinal position between two real
bounds is honest, and a position 450 Ma past the taxon's last fossil is not, while the
two render identically. The fix belongs to the fossil layer (§3.4) and cannot live in
this phase; handoff.md §7 has the measurements and the phase-ordering constraint.

### Scale

Linear and logarithmic, toggleable, as specified. Two things to get right:

**Log of time-before-present is undefined at the present.** `log(0)` is where a naive
implementation produces `-Infinity` and the layout silently collapses. Use a **symlog**:
linear from 0 to a threshold `t₀` (1 Ma is a reasonable default), logarithmic above.

**Mark the transition.** The axis changes character at `t₀`, and a scale that bends
without saying so misleads. A visible tick treatment at the breakpoint costs one
gridline and keeps the chart honest.

The log mode is what makes this app work at all: linear time puts every hominin
divergence inside one pixel next to the Cambrian. The point of the toggle is to make the
last 10 Ma legible without losing the other 4,000.

**The toggle is a scale and not a caption.** It shipped once as neither — `axisMode`
reached the axis strip, where it removed the knee marker and changed one word in the
footer, and never reached the layout, which computed `x` from `symlogFrac` in both
modes. "Linear" was therefore the symlog view with its warning taken off, which is the
one arrangement worse than either scale. `ageFrac(age, maxAge, mode)` in
`web/src/tree/layout.ts` is now the single mapping, and `layout()`, `toScreenX` and its
inverse all take the mode. `AxisMode` has one definition, in `layout.ts`; the copy that
used to sit in `state/store.ts` re-exports it.

**The axis belongs to the canvas, not to the selection.** It ran from the present to
`maxAge` — the deepest node in whatever is currently drawn — so it began abruptly and
unlabelled wherever that root happened to fall, and moved every time a species was
added. It now runs to the **Big Bang, 13787 Ma** (Planck 2018's ΛCDM figure, quoted in
Ma to match the rest of the axis), and stops there: no rule, no tick, no band beyond it.
`maxAge` still normalises the *scale* — it is what puts the deepest node at the left of
the plot — and the layout is unchanged.

The geologic band does **not** run that far. `chart.ttl` starts at the Hadean's
`begin_ma`, so the coloured strip stops at 4567 Ma and 9,220 Ma of bare axis runs on
beyond it. That stretch is most of the diagram rather than a gap in it, and both of its
ends carry a marker the way the knee does — *Earth forms* where the band starts and
*Big Bang* where the axis does. The two labels share the bare stretch, so they take
different rows (the Earth's in the band's row, which is empty exactly there) and drop
their figures on the same measure rather than one running under the other's marker.

The general rule this is an instance of: **an edge a reader cannot account for is worse
than one that runs off the screen.** Where the axis genuinely continues past the
viewport — a shallow selection puts 4567 Ma far off to the left — it is left to run off,
and nothing is drawn to suggest otherwise.

**The present is named, not numbered.** The tick at 0 reads "present", in the same lower
case an extant tip already carries on the canvas (*Homo sapiens* · present). It is a
place on the axis rather than a quantity, and "0" made a reader work out which end they
were looking at. Tick collision is consequently measured between label *boxes* rather
than centre to centre — a flat gap was fine while every tick was one to four characters
and stopped being fine the moment one of them was seven.

**Ticks come from the visible window, not from the tree.** A fixed set of ten ages
(`[0, 1, 10, 66, 100, 252, 541, 1000, 2500, 4000]`) fails twice over: nothing between 1
and 10 means human-and-chimp, whose whole tree is inside 7 Ma, draws an axis carrying the
single number `0`; and any zoom past the fit pushes all ten off-screen and leaves the
strip blank. The axis now inverts screen x back to age, generates a 1–2–5 ladder over
what is actually on screen, and places candidates by *priority* — the present, then the
boundaries a reader recognises (66, 252, 541), then powers of ten — so 50 Ma never
crowds out the K–Pg.

### Geologic scale bar

From ICS `chart.ttl` (v2026/06, CC-BY, 178 concepts, 100% with official CGMW colors),
parsed once at build into ~40 KB of JSON. Rendered as bands with level of detail driven
by pixels-per-Ma — **per region, not per axis**.

One rank across the whole strip is what this originally said, and it cannot be right
anywhere on a log scale: the same view that gives the Cenozoic 225 px gives the
Neoproterozoic 29. Picking the rank by the median band width therefore chooses between
"PHANEROZOIC" written across two thirds of the screen and a Precambrian of unreadable
slivers. The band is instead grown down the ICS containment tree (`parent` is in the
payload) from its roots, and a node hands over to its children when the children that
can carry *their own names* cover ≥ 70% of its width. So one strip reads Proterozoic,
Paleozoic, Mesozoic, Paleogene, Miocene, Pliocene, Pleistocene — every band named in
full, coarse at the deep end and fine at the recent one. Zooming refines it; panning
does not change it, because legibility is measured on the whole interval rather than on
the part on screen.

Two cheaper split rules are wrong on real intervals and were tried: "all children fit"
lets one 37-pixel Paleozoic hold the entire Phanerozoic at Eon, and counting legible
children rather than measuring them fails on the Quaternary, whose two children are a
screen-wide Pleistocene and an 11,700-year Holocene.

A band is labelled with its whole name or not at all. Every abbreviation available here
is worse than silence: a fixed three-character truncation puts "NEO" on a strip holding
both a Neogene and a Neoproterozoic, and the shortest-unambiguous-prefix rule produces
"Jura", "Lowe" and "Upper C". Making the *tiling* name-aware is what makes that
affordable — a split that would leave its own children unnameable does not happen.

**This is the one genuine collision with [design-reference.md](design-reference.md).**
The official CGMW palette is warm and highly saturated — Permian orange, Triassic purple,
Jurassic blue, Devonian brown — and the design language is emphatic: cool throughout, low
saturation, no warm-orange palette, and "the glow comes from the data, nowhere else."

The design language wins, with the convention preserved where it still pays. The original
argument for exact CGMW colour was that it "reads as authoritative to someone who knows
the field" — which is precisely the audience this product is *not* for. So:

- **Keep the official hue *relationships*, drop the official saturation and luminance.**
  Periods stay distinguishable and stay in their familiar relative order, but the band is
  dim, desaturated and recessive.
- **The band never glows.** It is a reference scale at the edge of the canvas, not data.
  Nothing in it should compete with a trace for attention.
- Wayfinding comes from labels and hairline dividers first, hue second.

A geologist will still recognise the column. Nobody will mistake it for the subject.

---

## 7. Rendering

**[design-reference.md](design-reference.md) is authoritative on the visual language,
the command surface, motion, and the stack.** This section records only what is specific
to *this* data — the parts a general design language cannot know — and the three places
where the two documents had to be reconciled.

### The rendered set is tiny, which is what makes the whole approach affordable

The dataset is 2.4M leaves. **The rendered set is not.** `|L|` selections produce at most
`2|L| − 1` nodes after suppression: ten species is nineteen nodes, verified exactly by
the walking-skeleton renderer. A drill-down lane adds tens more. We are drawing dozens to
low hundreds of elements.

That is what makes React Flow / xyflow v12 viable, and it is the number to watch. React
Flow renders edges as SVG paths, which keeps everything the visual-quality requirement
needs: real text with proper font features, `getTotalLength()` draw-on animation, inline
SVG silhouettes, native hit-testing, and accessibility that works without
reimplementation. Reaching for WebGL because the *source* dataset is large would be
optimizing the wrong number. WebGL becomes relevant only if the whole-tree context ribbon
gets built, which is a separate view with a separate renderer.

### Layout — the one place the design reference must not be taken literally

design-reference.md calls for a deterministic hierarchical layout, no force-direction,
positions computed and never simulated, nodes not draggable. **All of that holds.** But
it also suggests `d3-hierarchy / ELK / dagre`, and a graph-layout engine would assign `x`
by *depth*. Here `x` is *time*:

```
x = f(age_ma)      symlog, linear below t₀ = 1 Ma, logarithmic above   (§6)
y = tip lane       assigned by preorder idx                            (§3.1)
```

Running dagre or ELK over this would silently destroy the time axis, which is the one
thing the layout is for. Use them for nothing, or at most for `y`-packing. The layout is
already deterministic and already computed — it does not need a solver, and it must not
get one.

Two properties fall out of preorder numbering and are worth naming, because the design
language depends on both:

- **Lane assignment is stable by construction.** Sorting selected leaves by `idx` gives a
  canonical vertical order; adding a leaf inserts it in place and never permutes the
  others. That is exactly the "motion preserves object identity" requirement, obtained
  from the numbering scheme rather than maintained in layout code.
- **Internal node `y` is the midpoint of its children's extent**, so a lane keeps its
  position — and therefore its hue — across renders.

Edges are orthogonal with a small consistent corner radius, per the design reference. The
skeleton renderer already draws them this way (`M x1 y1 L x1 y2 L x2 y2`); convergent
branches are genuinely ambiguous under bezier.

### Provenance needs a channel that luminance has already taken

design-reference.md reserves brightness for **recency and selection, never data value**.
But age provenance (§3.5) *is* a data value, and one the app is obliged to render, since
the whole premise is putting dates on an axis.

So provenance does not get luminance. It gets:

- **`structural` tier — no numeric age at all.** This is the hard requirement and the
  only one that really matters. A dashed edge and an absent number, never a confident
  figure where nobody has estimated one.
- **Dash pattern for the edge.** Dash is not stroke *width*, so it does not violate
  "uniform stroke weight, encode meaning in luminance and hue", and it reads
  conventionally as inferred rather than measured.
- **Desaturation for `interpolated`**, sitting between measured and structural.

`structural`-tier nodes are positioned ordinally between their nearest dated ancestor and
descendant. In those regions the horizontal axis stops meaning time and starts meaning
nesting depth, and the rendering has to say so.

**"And descendant" is true of 2.8% of them, and any prose repeating this sentence to a
reader is wrong about the other 97.2%.** Every age in the artifact set comes from a
chronogram of *extant* species, so a dated descendant is nearly always a tip sitting at
the present and the fill runs from the ancestor down to zero. Measured over the 186,317
structural nodes in build `854cdfa42f77e78e`:

| | nodes | share |
|---|---|---|
| dated descendant older than the present | 5,168 | 2.8% |
| lower end of the span **is** the present | 181,149 | 97.2% |
| upper bound is an `mrcaott…` node, so has no name to print | 45,428 | 24.4% |
| upper bound sits at the present itself — **no span at all** | 49,240 | 26.4% |
| upper bound both nameable and older than the present | 91,680 | 49.2% |
| no dated ancestor | 0 | 0% |

Two consequences. The last row is what lets any surface promise to name *something*: the
ancestor side is always answerable. And the fourth row is a case the sentence above does
not describe at all — where the bounds coincide `layout_ages` collapses the node onto the
bound rather than inventing room, so it was not positioned "between" anything.
`topo.LayoutSpreadFor` recovers both bounds from the arrays (a contiguous subtree scan;
preorder makes it `[idx, subtree_out[idx])`, and a structural subtree is 1 node at the
median and 38 at the 99th percentile), `/v1/node` serves them as `layout_spread`, and
`web/src/detail/spread.ts` turns them into the four sentences the four cases need.
`server/internal/topo/bounds_test.go` pins the census, so this table fails a build rather
than going quietly stale.

**The channel is one bit short and it shows on extinct taxa.** Dash currently says only
"this position is ordinal". It cannot distinguish an ordinal position sitting between two
real bounds from one that has no lower bound at all and has drifted to the present — and
the second is where *T. rex* renders in the Oligocene (§6). If the fourth tier in §3.5 is
ever built, it needs a treatment that reads as *bounded but not pinned* — a range mark, a
bracketed extent — rather than a fourth dash density, because dash density is already
carrying an ordering the eye reads as confidence and a fossil bound is more certain than
what sits above it, not less.

### The signature interaction

design-reference.md specifies it in full and it is the product; that spec governs. Two
notes from the data side:

**The MRCA is free.** It is the last common element of the two ancestor paths (§2), which
are already in memory from the layout pass. There is no separate query and no server
round trip, so the `t=80` flare can fire in the same frame as the click.

**Draw order is root-ward → leaf-ward, lightly staggered**, and the segment list for that
is already computed: a rendered edge carries the ordered list of suppressed intermediate
nodes between its endpoints (§2). Stagger over those.

Honor `prefers-reduced-motion` by cutting to the final state and keeping the glow static.

### Drill-down (interaction 3)

Clicking a segment expands it into a lane beneath the main chronogram, sharing the time
axis so everything stays comparable:

- **Intermediate OTT nodes** on the spine at their ages, ranked by `tip_count` and
  whether they carry a named rank. These are the "notable entries" — Synapsida,
  Therapsida, Cynodontia on the way to mammals.
- **PBDB fossil taxa** as time-range bars beside the spine, ranked by `n_occs`, drawn
  with the **double bracket**: faded envelope `fea→lla` (maximal possible extent), solid
  bar `fla→lea` (minimal certain extent). Anything else misrepresents PBDB's uncertainty
  model.

  > **Amended by the build.** The four bounds do *not* form a chain. `fea ≥ fla`,
  > `lea ≥ lla`, `fea ≥ lea` and `fla ≥ lla` each hold for all 410,615 rows carrying
  > four bounds; **`fla ≥ lea` holds for 39.6%**. A taxon known from one stratigraphic
  > interval has both appearances inside it, so the two cross. For the other **60.4%
  > there is no certain extent at all** and the solid bar must be left *undrawn* — not
  > zero-width, which reads as precision, and not inverted. Three cases, not two.

  > **Also amended: the young end is not always a fact about the named taxon.**
  > PBDB's `lastapp_min_ma` aggregates a taxon's whole subtree, so a young end below
  > every descendant's can only rest on material catalogued no finer than the taxon
  > itself — a `Stegosaurus sp.` **10,655 taxa** are like this, and the bracket above
  > is still drawn from PBDB's four bounds unchanged. What moves is the *position*:
  > `lla_drawn` is the only column a mark's x may read, and on **7,802 rows** it
  > differs from `lla`. *Stegosaurus* drawn at `lla` sits in the Cenomanian, 50 Myr
  > after the animal, on the strength of one occurrence. The card prints PBDB's range
  > and says the difference in words. See fossil-grafts.md §3.
- Visually distinct from the spine, because they are annotations on a segment, not
  resolved positions within it. Offset lane, different mark, no connecting edges to
  siblings.
- ~21% of PBDB taxa have no appearance interval at all. They get an explicit
  "no range recorded" treatment, not a zero-width bar.

### Silhouettes

Priority-one work. For a curious non-specialist an image is what makes a clade mean
anything, and it is the third of the three things this product is for.

PhyloPic SVGs from the local mirror (~136 MB for the full corpus — mirroring removes a
runtime dependency and the build-number churn described in data-sources).

Silhouettes are monochrome, so `fill: currentColor` drops them straight into a dark
instrument and lets them take the trace colour, including the selection bloom. That is a
real advantage over photographs, alongside the one that matters more: a silhouette
legitimately represents a *clade*, where a photograph can only represent one member.
Rendering a mole for "Mammalia" is worse than rendering nothing.

> **Amended by the build.** That last sentence is right and was read too widely. It is
> about a *specific* node wearing a picture of something far broader, and the number
> that decides it is `node_image.clade_idx` — the smallest clade containing both the
> node and the drawing. Mammalia has an image of its own and draws it, so the mole case
> never arises; a riffle beetle shares Elminae's 987 species with the drawing beside it,
> which is a fact about the beetle. Only 12,863 drawings exist for 2.7M nodes, so
> withholding every borrowed picture means withholding nearly all of them. The rule that
> ships is: draw it, and say what group it speaks for and how large that group is.
> Measured before and after the resolution change, and the reasoning, in handoff.md §5.

> **A divergence gets a second picture.** The rule above answers "what does something
> in this clade look like", and it answers it by preferring the most inclusive drawing
> beneath a node. At a *split* that is the wrong end of the branch every time: the
> human–chimp divergence drew the generic *Homo*, the whale–hippo divergence drew the
> Cetacea dolphin, and neither existed when the lineages parted. So internal nodes also
> carry a **witness** in `node_divergence_witness` — a *fossil taxon from somewhere
> below the fork* whose stratigraphic bracket puts it at the split. *Acanthostega
> gunnari*, *Eohippus*, *Pakicetus*, *Sahelanthropus*. The two tables stay separate
> because which one applies depends on how the reader reached the node, which only the
> client knows: a species they chose wants its group's exemplar, a divergence they
> arrived at wants the witness. It is refused where the split is undated, where the node
> draws its own image, and where nothing drawn, dated and extinct hangs below it — 885
> forks, not 2.7M nodes. See handoff.md §5 and witness-ceiling.md.
>
> **A witness is not a node, so it makes §3.4's weaker claim and must be worded as
> one.** It hangs off `fossil.attach_idx`, so the honest sentence is *this taxon belongs
> somewhere below this node, and existed between these dates* — not *this taxon is
> inside this group*, which is what the earlier node-only version could say. Requiring a
> node capped the layer at 2,552 forks whatever the image budget, because only 0.5% of
> OTT taxa flagged extinct are in synthesis; `attach_walk` is what replaces that
> certainty, and the caption renders it as three bands rather than a number.
>
> **And a fork draws its witness or nothing** — never a borrow. That reverses "draw
> everything" above for internal nodes, on a ground that rule does not address: it
> judges a borrowed picture by the size of the clade shared with the drawing, and what
> is wrong with a borrow beside a fork is not size but *time*. Caniformia's 57 Ma split
> drew Procyonidae, 469 species and comfortably inside the threshold, and raccoons
> postdate that fork by 25 Ma. Most forks therefore now carry no picture, which is the
> honest answer rather than a gap.

A silhouette is drawn at every scale and in every label mode, including with the words
switched off. This paragraph used to file them "at the upper tiers of semantic zoom",
which was backwards for this element and is now moot: pulled back, type is too small to
read and a shape is not, so the picture is the *last* thing carrying meaning rather than
the first to go. With the words deliberately off it is the whole label, which is most of
why that state is worth having. design-reference.md's *Zoom* has the rest.

Resolution is baked, so there is no client-side climb — though not in
`node.phylopic_id`: it lives in `node_image`, which carries the drawing's own node, the
shared clade, the climb and the method. `primaryImage` is not used either; one call per
node is 2.7M requests against a volunteer service, and crawling the index instead is 269
(ingest.md phase 5). **Coverage is 100% and is not the thing to measure** — every node
resolving to *an* image says nothing about whether that image is about anything. See
handoff.md §5.

**Attribution renders in the UI**, not in a licence file: creator and licence in the node
detail card, plus a credits view enumerating everything currently displayed. CC-BY
requires it regardless of commercial use. Per design-reference.md the credits view is a
**command**, not a settings panel. It is a two-field problem — `attribution` is the
original creator, `_links.contributor.title` the uploader, and they differ 31% of the
time.

### Typography

design-reference.md governs: one geometric or grotesque sans for UI, one mono for
identifiers and all numerics, two weights maximum, hierarchy from size and opacity and
glow rather than weight. **Numerics are tabular-figure mono** — this supersedes the
old-style figures this document originally called for, which belong to a print-adjacent
aesthetic rather than an instrument.

One requirement survives from the data side and is not negotiable: **scientific naming
convention is not decoration.** Species and genus names are italic, higher taxa roman,
authority strings smaller and dimmer. It costs one rule keyed on `rank`, and getting it
wrong is visible to exactly the audience most likely to share the thing. So the UI sans
needs a genuine italic, not a synthesised oblique — worth checking when the face is
chosen.

### Search and the command surface

The palette *is* the interface (design-reference.md), which puts real weight on ranking
and makes one gap load-bearing.

**Ranking blends two signals that live in different places.** Corpus signals are baked:
exact match, then `tip_count` descending, then has-silhouette, then has-measured-age —
which is what makes "can" surface Canidae before *Cania*. Session signals — recency and
frequency, per the Raycast model — are client-side and layered on top. Neither alone is
right.

**Vernacular names are the front door.** A command palette that returns nothing for
"dog", "T. rex" or "shark" is broken at first contact, and OTT carries no common names at
all. This is why they moved from deferred to priority-one; see
[handoff.md](handoff.md) §1.

### URL state

`/?n=770315,153563,664349&axis=log&seg=1234-5678`

The selected set is the application state. Encoding it in the URL makes every view
shareable and back-button-correct, which for something visual is most of its
distribution — and design-reference.md extends this to *all* view state, so zoom, scope
and isolation belong here too.

---

## 8. The four interactions, end to end

**1 — Two leaves → minimal connecting subtree.** Search resolves two `idx` values.
`path()` each. LCA is the last common element. Render the two paths from the LCA down,
suppressing degree-2 nodes. One round trip, or zero once the client has `topology.bin`.

**2 — Add an Nth node → induced subtree, animated.** Fetch one path. Re-run the
suppression rule over the enlarged marked set. New tip slots in at its preorder position;
existing nodes spring to new coordinates; the new lineage grows from its attachment
point. No layout recomputation on the server, no jump-cut.

**3 — Click a branch → drill into intermediates.** The segment's suppressed nodes are
already in memory from the layout pass. One `/segment` call fetches ranked fossils. Lane
opens below, sharing the time axis, spine plus double-bracket range bars.

**4 — Time axis.** `x` from `age_ma` under linear or symlog — both real, and both
driving the layout, not just the strip. Ticks and ICS bands are generated from the age
range under the viewport, so the axis follows a zoom in rather than sliding off it.
Provenance tiers rendered so measured, interpolated, and structural ages are visually
distinguishable at a glance.

---

## 9. What is deliberately absent

**The Open Tree live API is not a runtime dependency.** It maps onto interactions 1 and 2
directly, and using it would still be wrong. There is no rate limiting because
[nobody implemented it](https://github.com/OpenTreeOfLife/germinator/issues/1268) — open
since 2021 — no terms-of-use page, and it is one `waitress` process behind a small
academic project. Beyond the courtesy problem: it serves whatever synthesis version it
currently has, while our ages and fossil attachments are pinned to v16.1. A silent
upstream bump would produce node ids that don't join, and the failure would be a
subtly wrong tree rather than an error.

It has a real role at **build time**, as an oracle: generate induced subtrees for a few
hundred random tip sets via `/tree_of_life/induced_subtree` and diff them against what
our baked artifacts produce. That is a genuinely strong correctness test — it caught
nothing during design because nothing is built yet, and it is the first thing to wire up.

**TimeTree is absent entirely.** Its terms prohibit redistributing the data "and its
transformations", which a tree carrying its ages plainly is. It is simultaneously the
best-identified source and the one we are least permitted to ship.

**No fuzzy matching anywhere in the runtime**, per §5.

---

## 10. Risks

| Risk | Severity | Mitigation |
|---|---|---|
| Duke et al. tree fails to validate against v16.1 | **high** — it is the entire time axis | Phase-2 gate in ingest with explicit accept/reject criteria; congruification + BLADJ fallback documented but not built |
| GBIF legacy backbone withdrawn | **high** — it is the only PBDB→OTT id path | Snapshot it in phase 1, not later. It is frozen as of 2023-08-28 and GBIF has moved on to CoL Extended Release |
| Users read interpolated ages as measured | **high** — it is a credibility failure, not a bug | Provenance tiers rendered visually (§3.5); structural regions never show a numeric age |
| No vernacular names in search | **medium** — blocks casual exploration | Ingest phase 5 pulls vernaculars from GBIF/Wikidata |
| Broken taxa (9,839) answer a different question silently | **medium** | `is_broken` baked; UI explains and offers the attachment points rather than substituting |
| PhyloPic NC/SA licensing in a commercial context | **medium** | License stored per image; `--commercial-safe` build flag filters NC at 93.7% coverage |
| A 12,964-child polytomy reaches the layout | **low** | Never rendered in full — suppression means only marked children appear. Guard the drill-down lane with a cap and an explicit "showing N of M" |
| PBDB license ambiguity (API says CC0, FAQ says NC-ND) | **low** | Email `admin@paleobiodb.org` before any commercial launch |

---

## 11. Cost

Build: hours, on a release cadence, on one machine. Runtime: two small instances
(~700 MB image, mostly page cache) behind a CDN that absorbs nearly everything, since
all responses are immutable. Storage: ~700 MB of artifacts plus ~136 MB of mirrored
silhouettes.

This is a very cheap system to run. That is the payoff for pushing all the difficulty
into a build pipeline that runs when a new synthesis release lands — roughly annually.
