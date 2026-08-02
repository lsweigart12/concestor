# The image store

How drawings are identified, stored, ranked and served. This governs **all**
image sources — phase 5a's PhyloPic mirror as it exists today, phase 5c's
generated outlines, and anything added later. It is deliberately not inside
`phase5c-decision.md`, because whoever next touches the PhyloPic path needs to
find it.

**Status: designed, not built, and not scheduled.** Phase 5a currently
implements the "before" column throughout, and that is fine: with PhyloPic as
the only source, one node has one drawing and nothing in §1's list of futures is
being asked for. This design exists so that the *first* of them costs a
migration rather than a rewrite — see §9 for what triggers it and what may
safely wait.

---

## 1. What this is for

Today one node has one drawing. The plausible futures all break that:

- more than one drawing per taxon, from more than one source
- a ranked list a reader can cycle through
- public voting on which drawing is best for a species
- a training set for a phylogeny-aware ranker

None of those need building now. All of them become a schema migration plus a
UI rewrite if the identity and the mutability boundary are wrong, and cost
almost nothing if they are right. That is the whole point of this document.

---

## 2. What is load-bearing today

| | where |
|---|---|
| `phylopic_id` **is** the identity of a drawing | PK of `silhouette`, column on `node_image`, path segment of `GET /v1/silhouette/{file}`, JSON field name |
| `node_image` is strictly 1:1 | 2,725,682 rows, one image each |
| node JSON carries flat `silhouette_*` fields | `server/internal/api/api.go:158-172` |
| serving is "find a file in a directory by id" | `server/internal/store/enrich.go:158-177` |
| everything is immutable build output | `concestor-build package` refuses to ship a failed phase |

A second source has no `phylopic_id`. A vote is not immutable. Those two facts
are the entire migration.

---

## 3. Identity — the decision that matters most

**Two identifiers, and conflating them is the trap.**

- **`blob_sha256`** addresses the *bytes*. It dedups storage, makes a URL
  cache-forever safe, and is what a reproducible build wants.
- **`image_id`** addresses the *logical drawing* — "the generated outline of
  Commons file X", "PhyloPic silhouette Y". It is **stable across re-renders**.

If `image_id` were the content hash, re-running potrace with different
parameters would mint a new id and orphan every vote attached to the old one. So
the bytes are content-addressed underneath a stable logical id.

`image_id` is **source-scoped**, never a bare uuid: `pp:<phylopic-uuid>`,
`wc:<commons-sha1>`. A bare uuid cannot tell you which namespace to look in, and
that is how you end up with a resolver that guesses.

---

## 4. Schema

```sql
-- one row per logical drawing, from any source
CREATE TABLE image (
  image_id      TEXT PRIMARY KEY,   -- 'pp:<uuid>' | 'wc:<commons-sha1>'
  source        TEXT NOT NULL,      -- 'phylopic' | 'commons-outline'
  kind          TEXT NOT NULL,      -- 'silhouette' | 'outline'
  blob_sha256   TEXT NOT NULL,
  blob_off      INTEGER NOT NULL,   -- byte offset into images.blob
  bytes         INTEGER NOT NULL,   -- length of the gzipped entry
  license_url   TEXT NOT NULL,
  attribution   TEXT,               -- the creator
  contributor   TEXT,               -- the uploader; differs 31% of the time
  origin_ref    TEXT,               -- Commons filename + revision, or PhyloPic build
  generator     TEXT,               -- NULL for PhyloPic; 'vision2p/potrace@<params-sha>'
  features      TEXT                -- JSON; see §8
);

-- candidacy. Attaches to the taxon a drawing DEPICTS.
CREATE TABLE image_node (
  image_id  TEXT NOT NULL,
  idx       INTEGER NOT NULL,
  relation  TEXT NOT NULL,       -- exact | ancestor | descendant | relative
  clade_idx INTEGER NOT NULL,    -- unchanged in meaning: the size of the claim
  score     REAL NOT NULL,       -- baked rank
  PRIMARY KEY (image_id, idx)
);
CREATE INDEX image_node_by_node ON image_node(idx, score DESC);
```

### The sizing argument

`image_node` holds only **depiction** edges — 7,470 PhyloPic seeds plus ~210,000
generated, so roughly 220,000 rows. It does **not** hold one row per node per
candidate, which would be 2.7M × k and is the obvious wrong turn.

This is also semantically right. A node that borrows a picture has no candidates
of its own; the alternatives belong to the taxon the drawing is *of*. Cycling at
a node means cycling the candidates of its `source_idx`. You are choosing
between drawings of a beetle, not between beetles.

### `node_image` survives unchanged

`node_image` stays exactly as it is — 2,725,682 rows, one image per node — but
becomes a **materialized default**, derived from `image_node` by the same
propagation that writes it today. Nothing on the hot path changes.
`web/src/tree/induced.ts`, its Go port and `render.py` are untouched, and the
three-way pin between them is not disturbed.

The rule from `phase5c-decision.md` §1 is enforced here: where a node has a
`relation = 'exact'` PhyloPic candidate, it wins, and a generated outline never
displaces it.

---

## 5. Blob storage

```
build/images/images.blob      concatenated, each entry gzipped independently
build/images/images_off.npy   u64[n+1], byte offsets
```

mmapped exactly like the topology arrays. `image.blob_off` and `image.bytes`
locate an entry directly.

**Compress per entry, not whole-blob.** Per-entry gzip measured 2.09× on real
output. Whole-blob compression is better but you would have to inflate 350 MB to
read one silhouette.

Two hundred thousand small files is the alternative and it is worse: inode
overhead, slow directory walks, and a `rsync` that takes longer than the build.

---

## 6. Serving

```
GET /v1/image/{image_id}
```

mmap, slice, write the bytes to the socket with `Content-Encoding: gzip` and
`Cache-Control: public, max-age=31536000, immutable`. **The server never
decompresses.** The response is immutable because `image_id` plus the build id
pins the bytes.

`GET /v1/silhouette/{phylopic_id}` stays permanently as an alias. It costs one
lookup and breaks nothing.

### JSON

Nest now, and keep the flat fields as deprecated aliases for one release:

```json
"silhouette": {
  "image_id": "pp:87782103-…",
  "source": "phylopic",
  "kind": "silhouette",
  "relation": "relative",
  "clade_idx": 41, "clade_tips": 987, "clade_name": "Elminae",
  "license_url": "…", "attribution": "…"
},
"alternatives": 3
```

`alternatives` is a count, not a list — the list is one request away and most
nodes never need it:

```
GET /v1/node/{idx}/images   -> ranked [{image_id, source, kind, score, …}]
```

Additive. The existing single-image path keeps working throughout.

---

## 7. The mutability boundary

**Votes never enter `build/`.**

```sql
-- runtime.db — writable, never rebuilt, never packaged
CREATE TABLE vote (
  image_id TEXT NOT NULL,
  idx      INTEGER NOT NULL,
  voter    TEXT NOT NULL,       -- opaque hash, never a raw identifier
  value    INTEGER NOT NULL,
  ts       INTEGER NOT NULL,
  PRIMARY KEY (image_id, idx, voter)
);
```

`build/` stays immutable and reproducible from the snapshot, and
`concestor-build package` keeps refusing to ship anything mutable.

Ranking is `baked score ⊕ f(votes)`, blended at read time — candidate lists are
single digits, so this needs no materialization until it does.

**The property this buys:** votes key on `(image_id, idx)`, and both are stable
across a full pipeline rebuild. Rebuild the entire artifact from scratch and not
one vote is invalidated. That is the single reason to fix identity before there
is anything to vote on.

---

## 8. `features`, and why it is not optional

Phase 5c computes per-mask quality signals to decide rejection: edge-coincidence,
solidity, compactness, frame fraction, reframe gain, bbox fill. They cost
nothing to persist and they are exactly the inputs a ranker needs.

`(image_id, idx, clade_idx, features, votes)` **is** a learning-to-rank dataset —
baked features as inputs, votes as ground truth, the tree as the phylogenetic
structure. Stored as JSON on `image`, it costs a column now. Added later it
costs re-running 210,000 segmentations, which is a three-day crawl if the
thumbnails were not kept.

`origin_ref` and `generator` make the whole set reproducible and let a future
run diff itself against this one.

---

## 9. Migration order

**Nothing here is needed while PhyloPic is the only source**, which is why none
of it is built. The trigger is a *second* source of drawings — `phase5c-decision.md`'s
generated outlines if that phase is ever picked up, or anything else that has no
`phylopic_id`. Do these five with that source, in the same change, because doing
them afterwards is a rewrite rather than a migration:

1. `image` and `image_node`, with `silhouette` backfilled as `source='phylopic'`.
2. `node_image` rewritten as a materialization of `image_node` — same columns,
   same row count, same arrays.
3. Packed blob + offsets; `/v1/image/{id}`; `/v1/silhouette/{id}` aliased.
4. Nested JSON with the flat fields deprecated in place.
5. `features`, `origin_ref`, `generator` populated for both sources.

Safe to defer indefinitely, because none of it changes a stored shape:

- the `vote` table and the ranking blend
- `GET /v1/node/{idx}/images` and UI cycling
- any third source
- ranker training

The only real cost above what a second source must build anyway is splitting
`image` from `silhouette` instead of widening `silhouette`, and nesting the
JSON.
