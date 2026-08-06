# The image store

How drawings are identified, stored, ranked and served. This governs **all**
image sources.

**Status: designed, not built.** Phase 5a implements the "before" column
throughout — PhyloPic is the only source, one node has one drawing, and nothing
here is asked for yet. This design exists so that the *first* additional source
of drawings costs a migration rather than a rewrite (§9). The second source is
future work.

---

## 1. What this is for

Today one node has one drawing. The plausible futures — more than one drawing per
taxon from more than one source, a ranked list a reader can cycle through, public
voting on the best drawing, a training set for a phylogeny-aware ranker — all
break that. Each becomes a schema migration plus a UI rewrite if the identity and
the mutability boundary are wrong, and costs almost nothing if they are right.

---

## 2. What is load-bearing today

| | where |
|---|---|
| `phylopic_id` **is** the identity of a drawing | PK of `silhouette`, column on `node_image`, path segment of `GET /v1/silhouette/{file}`, JSON field name |
| `node_image` is strictly 1:1 | one image per node |
| node JSON carries flat `silhouette_*` fields | `server/internal/api/api.go` |
| serving is "find a file in a directory by id" | `server/internal/store/enrich.go` |
| everything is immutable build output | `concestor-build package` refuses to ship a failed phase |

A second source has no `phylopic_id`; a vote is not immutable. Those two facts
are the entire migration.

---

## 3. Identity — the decision that matters most

**Two identifiers, and conflating them is the trap:**

- **`blob_sha256`** addresses the *bytes*. It dedups storage and makes a URL
  cache-forever safe.
- **`image_id`** addresses the *logical drawing* ("the generated outline of
  Commons file X", "PhyloPic silhouette Y") and is **stable across re-renders**.

If `image_id` were the content hash, re-rendering with different parameters would
mint a new id and orphan every vote attached to the old one. So the bytes are
content-addressed underneath a stable logical id.

`image_id` is **source-scoped**, never a bare uuid: `pp:<phylopic-uuid>`,
`wc:<commons-sha1>`. A bare uuid cannot tell a resolver which namespace to look
in.

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
  clade_idx INTEGER NOT NULL,    -- the size of the claim
  score     REAL NOT NULL,       -- baked rank
  PRIMARY KEY (image_id, idx)
);
CREATE INDEX image_node_by_node ON image_node(idx, score DESC);
```

`image_node` holds only **depiction** edges (~220,000 rows), not one row per node
per candidate (2.7M × k, the obvious wrong turn). This is also semantically
right: a node that borrows a picture has no candidates of its own; cycling at a
node means cycling the candidates of its `source_idx` — you are choosing between
drawings of a beetle, not between beetles.

**`node_image` survives unchanged** — one image per node — but becomes a
**materialized default**, derived from `image_node` by the same propagation that
writes it today. Nothing on the hot path changes; `web/src/tree/induced.ts`, its
Go port and `render.py` are untouched and their three-way pin is undisturbed.
Where a node has a `relation = 'exact'` PhyloPic candidate it wins, and a
generated outline never displaces it.

---

## 5. Blob storage

```
build/images/images.blob      concatenated, each entry gzipped independently
build/images/images_off.npy   u64[n+1], byte offsets
```

mmapped exactly like the topology arrays; `image.blob_off` and `image.bytes`
locate an entry directly. **Compress per entry, not whole-blob** — per-entry gzip
measured 2.09× and does not require inflating 350 MB to read one silhouette. Two
hundred thousand small files is the alternative and is worse (inode overhead,
slow walks, slow `rsync`).

---

## 6. Serving

```
GET /v1/image/{image_id}
```

mmap, slice, write the bytes with `Content-Encoding: gzip` and `Cache-Control:
public, max-age=31536000, immutable`. **The server never decompresses.**
Immutable because `image_id` plus the build id pins the bytes.
`GET /v1/silhouette/{phylopic_id}` stays permanently as an alias.

### JSON

Nest, keeping the flat fields as deprecated aliases for one release:

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

Additive; the existing single-image path keeps working.

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

`build/` stays immutable and reproducible from the snapshot. Ranking is
`baked score ⊕ f(votes)`, blended at read time (candidate lists are single
digits, so this needs no materialization). **The property this buys:** votes key
on `(image_id, idx)`, both stable across a full rebuild — rebuild the entire
artifact and not one vote is invalidated. That is the single reason to fix
identity before there is anything to vote on.

---

## 8. `features`, and why it is not optional

Any segmentation-based source computes per-mask quality signals to decide
rejection (edge-coincidence, solidity, compactness, frame fraction, reframe gain,
bbox fill). Stored as JSON on `image`, `(image_id, idx, clade_idx, features,
votes)` **is** a learning-to-rank dataset — baked features as inputs, votes as
ground truth, the tree as structure. It costs a column now, or re-running
~210,000 segmentations later. `origin_ref` and `generator` make the set
reproducible and let a future run diff itself against this one.

---

## 9. Migration order

Nothing here is needed while PhyloPic is the only source. The trigger is a
*second* source of drawings (anything with no `phylopic_id`). Do these five with
that source, in the same change, because doing them afterwards is a rewrite:

1. `image` and `image_node`, with `silhouette` backfilled as `source='phylopic'`.
2. `node_image` rewritten as a materialization of `image_node` — same columns,
   same row count, same arrays.
3. Packed blob + offsets; `/v1/image/{id}`; `/v1/silhouette/{id}` aliased.
4. Nested JSON with the flat fields deprecated in place.
5. `features`, `origin_ref`, `generator` populated for both sources.

Safe to defer indefinitely (none of it changes a stored shape): the `vote` table
and ranking blend, `GET /v1/node/{idx}/images` and UI cycling, any third source,
ranker training. The only real cost above what a second source must build anyway
is splitting `image` from `silhouette` instead of widening `silhouette`, and
nesting the JSON.
