"""Phase 5a — mirror the PhyloPic corpus and resolve every node to a silhouette.

## Crawl the index, not per-node

Resolving each of 2.7M nodes with one API call would DoS a small volunteer
service. The corpus is only ~12,863 images, so crawl the index instead:

1. Page `/images?embed_items=true&embed_specificNode=true` (~268 requests). Each
   page carries every image's licence, attribution and contributor and its
   node's `/resolve/.../{ott_id}` link, yielding the whole `image → ott_id` map.
2. Propagate locally in numpy with zero further calls: seed the mapped nodes,
   then give every other node the picture of its closest drawn relative. Preorder
   (`parent[i] < i`) makes this a sweep. See `propagate`.

## `clade_idx`, not `climb`

Giving a node the image of its nearest seeded ancestor resolves everything (100%
coverage) but is worthless — the nearest seed is usually a superphylum, so most
of the tree draws as Ecdysozoa. A borrowed picture claims "this node and this
drawing are both inside clade C"; `clade_idx` is the smallest such C and its
`tip_count` is the size of that claim. That is what the UI renders and the gates
check; `climb` is just how far up C sat.

## The witness — a second answer for a divergence

`node_image` prefers the most inclusive drawing beneath a node, which at a split
is nearly always a crown group (the human–chimp split drew generic *Homo*). So
internal nodes get a second, independent resolution — the witness, in
`node_divergence_witness` — a drawn, dated, extinct taxon from below the fork
whose fossil record puts it at the split (*Acanthostega* for fish/tetrapod,
*Pakicetus* for whale–hippo). The two tables stay apart: a chosen node shows its
group; a node arrived at by splitting shows what stood at the fork.

A witness is a fossil, not a node — only ~0.5% of extinct OTT taxa are in
synthesis, so requiring a node capped the layer at ~2,552 forks. Phase 4's
`attach_idx` reaches the stem forms: a fossil attached at `a` may witness `a`
and every ancestor of `a`. The claim weakens with the reach (`attach_walk`).
Four refusals do the work:

- A dated split (`age_ma`, else `age_layout`, used only to choose, never shown).
- A bracket (`fea` and `lla`), read only as a containment test.
- Extinct: a range running to the present spans every split inside it, so
  otherwise the biggest forks take the crown group wearing a fossil's label.
- Exactness wins: a node with its own image keeps it and gets no witness.

`NEAR_FRACTION` is where the judgement sits; see the constant.

## Mirroring

Stale `build` values return 410 Gone with the current build in the body;
`_ApiClient` re-derives from that rather than hard-coding a number. Mirroring the
SVGs removes the runtime dependency; the fetch is ordered by `tip_count` so an
interrupted crawl has the most-seen images, and is resumable by checksum.
Attribution is a two-field problem — `attribution` is the creator, the
contributor the uploader, differing ~31% of the time — so both are stored.
"""

from __future__ import annotations

import hashlib
import json
import sqlite3
import time
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field
from typing import TYPE_CHECKING

import numpy as np

from .gates import GateSet
from .newick import NO_OTT
from .paths import BUILD, SNAPSHOT
from .provenance import Manifest, record_local
from .provenance import client as http_client
from .topology import DB, TAXONOMY
from .topology import OUT as TOPO_OUT

if TYPE_CHECKING:
    from collections.abc import Callable, Iterator, Mapping, Sequence

    import httpx

    from .typing_ import (
        BoolArray,
        DepthArray,
        F32Array,
        F64Array,
        I64Array,
        Json,
        JsonDict,
        Log,
        U8Array,
        U32Array,
    )

API = "https://api.phylopic.org"
IMAGE_HOST = "https://images.phylopic.org"
OTT_RESOLVE_PREFIX = "/resolve/opentreeoflife.org/taxonomy/"

MIRROR = SNAPSHOT / "phylopic"
INDEX = MIRROR / "index.jsonl"
INDEX_META = MIRROR / "index_meta.json"
OUT = BUILD / "images"

# Measured 2026-07-31 (data-sources.md finding 5). Checked as a band rather
# than an equality: the corpus grows with uploads, so a hard number here would
# fail the build on somebody else's contribution.
EXPECT_IMAGES = 12_863

# ingest.md phase 5. Measured against PhyloPic's own `primaryImage` clade
# fallback over sampled nodes — see the note where the gate is declared,
# because this build resolves differently and does considerably better.
BASELINE_INTERNAL = 0.886
BASELINE_LEAF = 0.940

# Method codes, stored in the arrays; `node_image.method` carries the name.
# `relative` is the ordinary case once resolution looks for the closest drawn
# relative rather than the nearest drawn ancestor: a cousin is neither above
# nor below, and before this existed those nodes took a superphylum's blob.
M_EXACT, M_ANCESTOR, M_DESCENDANT, M_RELATIVE, M_NONE = 0, 1, 2, 3, 255
METHOD_NAME = {
    M_EXACT: "exact",
    M_ANCESTOR: "ancestor",
    M_DESCENDANT: "descendant",
    M_RELATIVE: "relative",
}

# What size of clade may a borrowed picture speak for and still say something?
# The gate this backs replaced a 100% node-coverage gate that was true and
# useless. There is no natural threshold in the data — the distribution is
# smooth — so this is a product judgement stated once, in the open: a drawing
# from a clade of at most ten thousand species is about a recognisable group
# (Elminae, Coccinellidae, Selachii all sit far below it), and one from a clade
# of a million is about nothing a reader can picture. Measured against the
# built corpus the old rule cleared it for 13.4% of nodes and this one for
# 72.2%, so the gate is set where it discriminates between the two rules rather
# than where it happens to pass.
INFORMATIVE_CLADE_TIPS = 10_000
MIN_INFORMATIVE_LEAF = 0.65
MIN_INFORMATIVE_INTERNAL = 0.75

# How far from a split may a fossil sit and still be a witness to it? Expressed
# as a fraction of the split's own age, because "near" in deep time is read
# against the depth of the thing: 2 Ma is nothing at the whale–hippo split and
# most of the story at the human–chimp one.
#
# **Currently uncapped, deliberately.** The knob shipped at 0.25 and the tree
# was too bare to be worth looking at, because refusing a witness does not fall
# back to anything — a fork draws the witness or nothing. Measured on the built
# corpus, witnesses admitted at each cap:
#
#   0.20 -> 53   0.25 -> 66   0.33 -> 87   0.50 -> 114   1.00 -> 225   inf -> 229
#
# and with the layout fallback below, 548. The distribution is smooth — median
# gap is 50% of the split's age, p90 is 100% — so no threshold sits at a
# natural break, which is what makes this a preference rather than a finding.
#
# Uncapped, the ranking still does the work: every fork takes the *nearest*
# drawn fossil inside it, and the two facts a reader needs to judge it — the
# taxon's own range and the fork's age — render together wherever the picture
# does. What is lost is the refusal, so a fork can now take something far too
# young: Feliformia (47 Ma) draws a mongoose known only from the last 5 Ma.
# That is visible on the card rather than hidden, which is the trade.
#
# To dial back, set this to a fraction. Nothing else has to change.
NEAR_FRACTION = float("inf")

# The base of the Holocene, PBDB's youngest interval, and the floor a witness's
# last appearance must sit above.
#
# `is_extant` is the flag that is *supposed* to keep a living taxon out — a
# range running to the present contains every split younger than its start, so
# it cannot fail to look like a match — and measured on this corpus the flag is
# wrong often enough to undo the feature on its own. *Thalassia testudinum* is
# the living turtle grass, flagged extinct, bracketed 48.07–0.0117 Ma, and it
# won a fork of 378,328 tips. *Hippotragus equinus* is the roan antelope,
# *Pugettia producta* the northern kelp crab, *Globigerinoides ruber* a living
# foram at 85.7–0 Ma; all three are flagged extinct and all three won forks.
#
# So the same rule is applied to the evidence rather than to the label: a taxon
# whose last appearance is in the Holocene has no recorded end, and a range with
# no end is not evidence about when anything parted. That costs 233 forks and
# some genuine recent extinctions with them — *Aenocyon dirus*, the dire wolf,
# and *Moho braccatus*, the Kauai ʻōʻō, which died in 1987 — and it is worth it
# on §5's own terms: a wrong include is a silent regression and a wrong exclude
# is one missing picture.
HOLOCENE_MA = 0.0117

NO_IMAGE = -1

# Which seeding pass a node's image survived from — see `seed_nodes`. Ordered
# by strength, and only ever compared, never stored.
T_UNSEEDED, T_NAME_TRUNCATED, T_NAME, T_LIFTED, T_OTT_ID = 0, 1, 2, 3, 4

# Max root-to-tip depth is 111 (data-sources.md), so 7 rounds of pointer
# doubling cover any chain. The loop exits on a fixpoint anyway; the cap only
# stops a malformed `parent` array spinning forever.
MAX_JUMPS = 16

# Licences whose terms require the creator be credited. Everything else in the
# corpus is CC0 or the Public Domain Mark, neither of which does.
ATTRIBUTION_REQUIRED_MARKER = "/licenses/by"

# The one-hop lift's ceiling, in tips of the node being lifted onto — see
# `seed_nodes`. Excludes phylum-scale targets (Amphibia, Cnidaria) while
# admitting a genus for a species image.
LIFT_MAX_TIPS = 100

MIRROR_WORKERS = 6
API_PAUSE = 0.15  # between index pages; the API is one small service
SVG_PAUSE = 0.02  # between SVG fetches; images.phylopic.org is S3 + CloudFront


class PhylopicError(RuntimeError):
    pass


def _log(msg: str) -> None:
    """Unbuffered: a redirected log that stays empty looks like a hang."""
    print(msg, flush=True)


# --------------------------------------------------------------------------
# The index
# --------------------------------------------------------------------------


@dataclass(slots=True)
class ImageRecord:
    """One PhyloPic image, flattened out of the embedded index payload."""

    uuid: str
    license_url: str
    attribution: str | None
    contributor: str | None
    modified: str
    node_uuid: str | None
    node_title: str | None
    node_primary_image: str | None
    ott_ids: list[int] = field(default_factory=list)
    svg_url: str = ""

    @property
    def needs_attribution(self) -> bool:
        return ATTRIBUTION_REQUIRED_MARKER in self.license_url

    def to_json(self) -> JsonDict:
        return {
            "uuid": self.uuid,
            "license_url": self.license_url,
            "attribution": self.attribution,
            "contributor": self.contributor,
            "modified": self.modified,
            "node_uuid": self.node_uuid,
            "node_title": self.node_title,
            "node_primary_image": self.node_primary_image,
            "ott_ids": self.ott_ids,
            "svg_url": self.svg_url,
        }

    @classmethod
    def from_json(cls, d: JsonDict) -> ImageRecord:
        return cls(**d)


def _uuid_from_href(href: str | None) -> str | None:
    if not href:
        return None
    return href.rsplit("/", 1)[-1].split("?", 1)[0] or None


def ott_ids_from_node(node: JsonDict) -> list[int]:
    """OTT ids a PhyloPic node declares, from its `_links.external` list.

    A node can cite several — a genus and its type species both resolving to
    the same silhouette — so this returns all of them rather than the first.
    """
    out: list[int] = []
    for e in (node.get("_links") or {}).get("external") or []:
        href = e.get("href") or ""
        if not href.startswith(OTT_RESOLVE_PREFIX):
            continue
        tail = href[len(OTT_RESOLVE_PREFIX) :].split("?", 1)[0].strip("/")
        try:
            out.append(int(tail))
        except ValueError:
            continue
    return out


def record_from_item(item: JsonDict) -> ImageRecord:
    """Flatten one `_embedded.items` entry from the paged image index."""
    links = item.get("_links") or {}
    node = (item.get("_embedded") or {}).get("specificNode")
    node_links = (node or {}).get("_links") or {}
    return ImageRecord(
        uuid=item["uuid"],
        license_url=(links.get("license") or {}).get("href") or "",
        attribution=item.get("attribution"),
        contributor=(links.get("contributor") or {}).get("title"),
        modified=item.get("modified") or "",
        node_uuid=(node or {}).get("uuid"),
        node_title=(node_links.get("self") or {}).get("title"),
        node_primary_image=_uuid_from_href(
            (node_links.get("primaryImage") or {}).get("href")
        ),
        ott_ids=ott_ids_from_node(node) if node else [],
        svg_url=(links.get("vectorFile") or {}).get("href") or "",
    )


class _ApiClient:
    """Paced GET against the PhyloPic API, re-deriving the build on 410.

    A stale `build` returns 410 Gone with the current build in the error body,
    so the build is read from the service rather than hard-coded.
    """

    def __init__(self, client: httpx.Client, log: Log) -> None:
        self.client = client
        self.log = log
        self.requests = 0
        head = self._collection_head()
        self.build: int = head["build"]
        # The service's own count, so the crawl can be gated on completeness.
        self.total_items: int | None = head.get("totalItems")
        self.items_per_page: int | None = head.get("itemsPerPage")

    def _collection_head(self) -> JsonDict:
        """Ask the service what build it is on, rather than hard-coding one.

        `/images` with no parameters 307s to the current build and carries
        `totalItems`/`itemsPerPage`, which makes "did the crawl finish"
        checkable. Every payload, including error bodies, carries `build`.
        """
        r = self.client.get(f"{API}/images")
        self.requests += 1
        try:
            payload = r.json()
        except ValueError:
            r.raise_for_status()
            raise PhylopicError(f"{API}/images returned no JSON") from None
        if not isinstance(payload.get("build"), int):
            r.raise_for_status()
            raise PhylopicError(f"no build index in {API}/images response")
        return payload

    def get(self, path: str, params: JsonDict | None = None) -> Json:
        for attempt in range(3):
            r = self.client.get(
                f"{API}{path}", params=dict(params or {}) | {"build": self.build}
            )
            self.requests += 1
            if r.status_code == 410:
                fresh = r.json().get("build")
                if not isinstance(fresh, int) or fresh == self.build:
                    raise PhylopicError(f"410 on {path} with no usable build: {r.text}")
                self.log(f"  build {self.build} is stale; PhyloPic is on {fresh}")
                self.build = fresh
                continue
            if r.status_code >= 500 and attempt < 2:
                time.sleep(2.0 * (attempt + 1))
                continue
            r.raise_for_status()
            return r.json()
        raise PhylopicError(f"gave up on {path}")


def crawl_index(api: _ApiClient, log: Log) -> list[ImageRecord]:
    """Page the whole image index, embedding each image's specific node.

    ~268 requests for the entire corpus. `embed_specificNode` is what makes
    this work: without it every image would need a second call to learn its OTT
    id, which is 12,863 more requests for something the index already carries.
    """
    records: list[ImageRecord] = []
    params = {"embed_items": "true", "embed_specificNode": "true"}
    page = 0
    t0 = time.monotonic()
    while True:
        payload = api.get("/images", {**params, "page": page})
        records.extend(
            record_from_item(it)
            for it in (payload.get("_embedded") or {}).get("items") or []
        )
        if page % 25 == 0:
            log(f"  page {page:>4}  {len(records):>6,} images")
        if not (payload.get("_links") or {}).get("next"):
            break
        page += 1
        time.sleep(API_PAUSE)
    log(
        f"  crawled {len(records):,} images over {page + 1} pages in "
        f"{time.monotonic() - t0:,.1f}s ({api.requests} requests)"
    )
    return records


def save_index(
    records: list[ImageRecord], build: int, total_items: int | None = None
) -> None:
    MIRROR.mkdir(parents=True, exist_ok=True)
    with INDEX.open("w", encoding="utf-8") as fh:
        for r in records:
            fh.write(json.dumps(r.to_json(), separators=(",", ":")) + "\n")
    INDEX_META.write_text(
        json.dumps(
            {"build": build, "images": len(records), "total_items": total_items},
            indent=2,
        )
        + "\n"
    )


def load_index() -> tuple[list[ImageRecord], JsonDict]:
    """The crawled index and its metadata, or empty when nothing is cached."""
    if not INDEX.exists():
        return [], {}
    with INDEX.open(encoding="utf-8") as fh:
        records = [
            ImageRecord.from_json(json.loads(line)) for line in fh if line.strip()
        ]
    meta = json.loads(INDEX_META.read_text()) if INDEX_META.exists() else {}
    return records, meta


# --------------------------------------------------------------------------
# Seeding: PhyloPic's OTT ids onto our node indices
# --------------------------------------------------------------------------


def _rank(r: ImageRecord) -> tuple[bool, str, str]:
    return (r.uuid == r.node_primary_image, r.modified, r.uuid)


def pick_per_ott(records: list[ImageRecord]) -> dict[int, int]:
    """`ott_id -> position in records`, deciding between competing images.

    PhyloPic already curates this: the specific node names its own
    `primaryImage`, so prefer that. Otherwise take the most recently modified,
    tie-broken on uuid so the build is deterministic.
    """
    best: dict[int, int] = {}
    for i, r in enumerate(records):
        if not r.ott_ids or not r.license_url:
            continue
        for ott in r.ott_ids:
            cur = best.get(ott)
            if cur is None or _rank(r) > _rank(records[cur]):
                best[ott] = i
    return best


def load_forwards(con: sqlite3.Connection) -> dict[int, int]:
    """Retired OTT id -> current, already chased transitively in phase 1.

    PhyloPic's external ids were recorded against whatever OTT release was
    current when a curator added them, and forwarding is silent, so a direct
    lookup that misses is not the same as an id absent from the tree.
    """
    return dict(con.execute("SELECT old_ott_id, new_ott_id FROM forward"))


def name_candidates(records: list[ImageRecord]) -> set[str]:
    """Every taxon name the name passes might need to look up.

    Collected up front so `taxonomy_index` can filter 4.5M rows down to the
    few thousand that matter in a single pass. Holding the whole `name -> uid`
    map would be ~4.5M strings for the ~30k this ever asks about.
    """
    out: set[str] = set()
    for r in records:
        title = (r.node_title or "").strip()
        if not title:
            continue
        out.add(title)
        out.update(_truncations(title))
    return out


def _truncations(title: str) -> list[str]:
    """A binomial's species and genus, in decreasing specificity.

    `Equus quagga chapmani -> ["Equus quagga", "Equus"]`. A one-word title has
    nothing to truncate to: dropping a word off `Orthocerida` yields nothing,
    and dropping one off a genus would be a rank jump, not a truncation.
    """
    parts = title.split()
    return [" ".join(parts[:k]) for k in (2, 1) if len(parts) > k]


def taxonomy_index(
    wanted_names: set[str] | None = None,
) -> tuple[dict[int, int], dict[str, list[int]]]:
    """`uid -> parent_uid` and `name -> uids`, from OTT's `taxonomy.tsv`.

    One pass for both, because the file is 4.5M rows and the two consumers —
    the one-hop lift and the name passes — want it at the same moment.

    Names are returned as a *list* of uids: OTT carries homonyms across
    kingdoms, and a name that resolves two ways is a name we cannot use. The
    caller refuses those rather than picking one.

    Returns empties when the taxonomy has not been extracted; both lifting and
    name matching are improvements, not prerequisites, so their absence must
    not fail the phase.
    """
    parents: dict[int, int] = {}
    names: dict[str, list[int]] = {}
    if not TAXONOMY.exists():
        return parents, names
    with TAXONOMY.open(encoding="utf-8") as fh:
        cols = [c.strip() for c in fh.readline().split("\t|\t")]
        i_uid, i_par = cols.index("uid"), cols.index("parent_uid")
        i_name = cols.index("name")
        need = max(i_uid, i_par, i_name)
        for line in fh:
            f = line.split("\t|\t")
            if len(f) <= need:
                continue
            uid_s, par_s = f[i_uid].strip(), f[i_par].strip()
            if not uid_s.isdigit():
                continue
            uid = int(uid_s)
            # Exactly one row in 4.5M has no parent: `life`, the root.
            if par_s.isdigit():
                parents[uid] = int(par_s)
            name = f[i_name].strip()
            if wanted_names is not None and name not in wanted_names:
                continue
            names.setdefault(name, []).append(uid)
    return parents, names


@dataclass(slots=True)
class NameSeeds:
    """What the name passes found. Each list is `(node idx, record position)`."""

    exact: list[tuple[int, int]] = field(default_factory=list)
    truncated: list[tuple[int, int]] = field(default_factory=list)
    ambiguous: int = 0


def _seed_by_name(
    titles: Sequence[str | None] | None,
    landed: set[int],
    name_uids: Mapping[str, list[int]] | None,
    lookup: Callable[[I64Array], I64Array],
    forwards: dict[int, int],
    tip_count: U32Array,
    max_tips: int,
) -> NameSeeds:
    """Passes 4 and 5 of `seed_nodes` — reach an image through its node's name.

    Only images that seeded nothing through an OTT id are considered, so this
    can add nodes but never move one an id already claimed.
    """
    found = NameSeeds()
    if not titles or not name_uids:
        return found

    def resolve(uids: list[int]) -> tuple[int, bool]:
        """`(node idx, ambiguous)`. Chases a forward, as pass 2 does."""
        ids = np.array(uids, dtype=np.int64)
        hit = lookup(ids)
        miss = hit == NO_IMAGE
        if bool(miss.any()) and forwards:
            fwd = np.array(
                [forwards.get(int(o), int(o)) for o in ids[miss]], dtype=np.int64
            )
            hit[miss] = lookup(fwd)
        nodes = {int(n) for n in hit.tolist() if n != NO_IMAGE}
        if len(nodes) > 1:
            return NO_IMAGE, True
        return (nodes.pop() if nodes else NO_IMAGE), False

    for record, raw in enumerate(titles):
        if record in landed:
            continue
        title = (raw or "").strip()
        if not title:
            continue

        uids = name_uids.get(title)
        if uids:
            node, ambiguous = resolve(uids)
            if ambiguous:
                # A homonym tells us the title is not enough to identify the
                # taxon. Truncating it would only widen the ambiguity.
                found.ambiguous += 1
                continue
            if node != NO_IMAGE:
                found.exact.append((node, record))
                continue

        for candidate in _truncations(title):
            uids = name_uids.get(candidate)
            if not uids:
                continue
            node, ambiguous = resolve(uids)
            if ambiguous:
                found.ambiguous += 1
                break
            if node == NO_IMAGE:
                continue
            # Truncations run specific-first, so a target too broad here is
            # only going to get broader. Stop rather than climb to the family.
            if tip_count[node] <= max_tips:
                found.truncated.append((node, record))
            break

    return found


def seed_nodes(
    ott_id: I64Array,
    tip_count: U32Array,
    per_ott: dict[int, int],
    forwards: dict[int, int],
    parents: dict[int, int] | None = None,
    lift_max_tips: int = LIFT_MAX_TIPS,
    titles: Sequence[str | None] | None = None,
    name_uids: Mapping[str, list[int]] | None = None,
) -> tuple[I64Array, JsonDict]:
    """Map PhyloPic's images onto node indices.

    Returns `seed[idx] = position in records`, `NO_IMAGE` elsewhere.

    Five passes, in decreasing strength:

    1. Direct: the cited OTT id is a node.
    2. Forwarded: OTT forwarding is silent, so a direct miss may just be a
       forwarded id; phase 1's `forward` table already chased the chains.
    3. Lifted one hop: cited ids in `taxonomy.tsv` but not in synthesis are
       mostly extinct. Bounded to exactly one hop and onto a node narrow enough
       (`lift_max_tips`) to stay representative, refusing every fossil-onto-
       phylum case (admits `Homo sapiens sapiens → Homo sapiens`).
    4. Named: images with no OTT id still name their node; match `node_title`
       against `taxonomy.tsv`. An exact claim, so no tip bound.
    5. Named, truncated: a title naming no node may once the trailing epithet
       comes off (`Equus quagga chapmani → Equus`). Bounded like pass 3.

    Passes 4 and 5 refuse a name resolving to more than one node (cross-kingdom
    homonyms). A direct hit beats a lifted one; an OTT id beats a name.
    """
    order = np.argsort(ott_id, kind="stable")
    order = order[ott_id[order] != NO_OTT]
    sorted_ott = ott_id[order]

    wanted = np.fromiter(per_ott.keys(), dtype=np.int64, count=len(per_ott))
    images = np.fromiter(per_ott.values(), dtype=np.int64, count=len(per_ott))

    def lookup(ids: I64Array) -> I64Array:
        # `ids` may carry sentinels; no OTT id is negative and NO_OTT rows were
        # dropped above, so a sentinel simply fails the equality test.
        pos = np.clip(np.searchsorted(sorted_ott, ids), 0, sorted_ott.size - 1)
        hit = sorted_ott[pos] == ids
        return np.where(hit, order[pos], NO_IMAGE).astype(np.int64)

    idx = lookup(wanted)

    missed = idx == NO_IMAGE
    n_forwarded = 0
    if bool(missed.any()) and forwards:
        fwd = np.array(
            [forwards.get(int(o), int(o)) for o in wanted[missed]], dtype=np.int64
        )
        retry = lookup(fwd)
        n_forwarded = int((retry != NO_IMAGE).sum())
        idx[missed] = retry

    lift = np.full(wanted.size, NO_IMAGE, dtype=np.int64)
    n_lifted = 0
    if parents:
        still = idx == NO_IMAGE
        up = np.array(
            [parents.get(int(o), NO_IMAGE) for o in wanted[still]], dtype=np.int64
        )
        cand = lookup(up)
        narrow = (cand != NO_IMAGE) & (
            tip_count[np.clip(cand, 0, tip_count.size - 1)] <= lift_max_tips
        )
        lift[still] = np.where(narrow, cand, NO_IMAGE)
        n_lifted = int(narrow.sum())

    ok = idx != NO_IMAGE
    lifted = lift != NO_IMAGE

    by_name = _seed_by_name(
        titles=titles,
        landed=set(images[ok].tolist()) | set(images[lifted].tolist()),
        name_uids=name_uids,
        lookup=lookup,
        forwards=forwards,
        tip_count=tip_count,
        max_tips=lift_max_tips,
    )

    seed = np.full(ott_id.size, NO_IMAGE, dtype=np.int64)
    # Two OTT ids can land on one node (a forward collapsing a synonym). Last
    # write wins deterministically, so weakest evidence goes down first and a
    # stronger pass overwrites it. `tier` records which pass a node's seed
    # survived from, which is the only honest way to credit one.
    tier = np.zeros(ott_id.size, dtype=np.uint8)
    for node, record in by_name.truncated:
        seed[node], tier[node] = record, T_NAME_TRUNCATED
    for node, record in by_name.exact:
        seed[node], tier[node] = record, T_NAME
    seed[lift[lifted]], tier[lift[lifted]] = images[lifted], T_LIFTED
    seed[idx[ok]], tier[idx[ok]] = images[ok], T_OTT_ID

    return seed, {
        "ott_ids_offered": len(per_ott),
        "ott_ids_in_tree": int(ok.sum()),
        "ott_ids_via_forward": n_forwarded,
        "ott_ids_lifted_one_hop": n_lifted,
        "names_matched": len(by_name.exact),
        "names_matched_truncated": len(by_name.truncated),
        "names_ambiguous": by_name.ambiguous,
        # Nodes seeded by a name and by nothing stronger.
        "nodes_from_name": int((tier == T_NAME).sum()),
        "nodes_from_name_truncated": int((tier == T_NAME_TRUNCATED).sum()),
        "seeded_nodes": int((seed != NO_IMAGE).sum()),
    }


# --------------------------------------------------------------------------
# The propagation sweep — the part with real logic in it
# --------------------------------------------------------------------------


@dataclass(slots=True)
class Assignment:
    image: I64Array  # position in `records`; NO_IMAGE where unresolved
    source: I64Array  # the node the image is actually OF; NO_IMAGE if none
    clade: I64Array  # smallest clade holding both idx and source; NO_IMAGE if none
    climb: U8Array  # hops from idx up to `clade`; 0 = the image is at or below idx
    method: U8Array  # M_EXACT | M_ANCESTOR | M_DESCENDANT | M_RELATIVE | M_NONE


def exemplars(
    parent: U32Array, depth: DepthArray, tip_count: U32Array, seed: I64Array
) -> I64Array:
    """For each node, the best-drawn taxon anywhere in its subtree.

    "Best" is the most inclusive: the seeded node with the largest `tip_count`,
    tie-broken by shallower depth then index. Preferring the inclusive seed
    picks the image whose author intended it as an exemplar (a boa for Serpentes,
    not a blind snake).

    Walks each seed's ancestor chain best-first, stopping at the first ancestor a
    better seed already claimed, so work is bounded by the nodes with any seed
    beneath them, not by the whole tree.
    """
    n = parent.size
    best = np.full(n, NO_IMAGE, dtype=np.int64)
    seeds = np.flatnonzero(seed != NO_IMAGE)
    order = sorted(
        (int(s) for s in seeds),
        key=lambda s: (-int(tip_count[s]), int(depth[s]), s),
    )
    par = parent.astype(np.int64)
    for s in order:
        v = s
        while best[v] == NO_IMAGE:
            best[v] = s
            if v == 0:  # the root's parent is a sentinel, not an index
                break
            v = int(par[v])
    return best


def propagate(
    parent: U32Array,
    depth: DepthArray,
    subtree_out: U32Array,
    seed: I64Array,
    tip_count: U32Array,
) -> Assignment:
    """Give every node the picture of its closest drawn relative.

    A borrowed picture claims "this node and this drawing are both inside clade
    C". C is the smallest such clade — the nearest ancestor-or-self with any seed
    beneath it — and `clade`/its tip_count is the size of that claim, which the UI
    must render. (The old "nearest seeded ancestor" rule drew most of the tree as
    a superphylum blob.) Exactness still wins: a seeded node draws itself.
    """
    n = parent.size
    if not depth.size == subtree_out.size == seed.size == tip_count.size == n:
        raise ValueError("propagate: array lengths disagree")

    idxs = np.arange(n, dtype=np.int64)
    seeded: BoolArray = seed != NO_IMAGE
    best = exemplars(parent, depth, tip_count, seed)

    # The shared clade: nearest ancestor-or-self with a seed anywhere below it.
    # Same pointer doubling as before, over "has an exemplar" instead of "is
    # seeded" — a node with an exemplar is a self-loop and absorbs the chain.
    link = np.where(best != NO_IMAGE, idxs, parent.astype(np.int64))
    link[0] = 0  # the root's parent is the NO_PARENT sentinel, not an index
    for _ in range(MAX_JUMPS):
        nxt = link[link]
        if np.array_equal(nxt, link):
            break
        link = nxt

    resolved: BoolArray = best[link] != NO_IMAGE
    depth64 = depth.astype(np.int64)
    clade = np.where(resolved, link, NO_IMAGE)
    # Exactness beats inclusiveness: a seeded node draws itself, not the
    # biggest thing under it.
    source = np.where(seeded, idxs, np.where(resolved, best[link], NO_IMAGE))
    image = np.where(resolved, seed[source], NO_IMAGE)
    hops = np.where(resolved, depth64 - depth64[link], 0)

    # The method is the topological relationship, derived rather than tracked so
    # it cannot drift. `relative` is the common case: a cousin.
    out64 = subtree_out.astype(np.int64)
    is_anc = (source <= idxs) & (idxs < out64[np.maximum(source, 0)])
    is_desc = (idxs < source) & (source < out64)
    method = np.where(
        ~resolved,
        M_NONE,
        np.where(
            source == idxs,
            M_EXACT,
            np.where(is_anc, M_ANCESTOR, np.where(is_desc, M_DESCENDANT, M_RELATIVE)),
        ),
    )

    if int(hops.max(initial=0)) > 255:
        raise ValueError("climb exceeds u8; the tree is deeper than it should be")
    return Assignment(
        image=image,
        source=source,
        clade=clade,
        climb=hops.astype(np.uint8),
        method=method.astype(np.uint8),
    )


# --------------------------------------------------------------------------
# The divergence witness — the same tree, a different question
# --------------------------------------------------------------------------


@dataclass(slots=True, frozen=True)
class FossilCandidate:
    """A drawn, dated, extinct PBDB taxon, offering itself as a witness.

    Not a node: requiring one capped the layer at ~2,552 forks, since only ~0.5%
    of extinct OTT taxa are in the synthesis tree.
    """

    pbdb_taxon_no: int
    name: str
    rank: str | None
    attach_idx: int  # deepest node that is an ancestor-or-self of it
    attach_walk: int  # `parent_no` hops PBDB took to find that node
    oldest: float  # `fea` — read only as one end of a containment test
    youngest: float  # `lla`
    n_occs: int
    image: int  # position in `records`


@dataclass(slots=True)
class Witness:
    """Per node: the fossil taxon whose bracket sits at that node's split."""

    image: I64Array  # position in `records`; NO_IMAGE where there is no witness
    source: I64Array  # `fossil.pbdb_taxon_no`, NOT a node index. NO_IMAGE = none
    gap: F64Array  # Ma from the split to that taxon's observed range; 0 = spans
    taxa: dict[int, FossilCandidate]  # idx -> the candidate that won it


def load_fossil_candidates(
    con: sqlite3.Connection, records: list[ImageRecord], links: dict[int, int]
) -> tuple[list[FossilCandidate], JsonDict]:
    """Every PBDB taxon that could witness anything, from phase 4's `fossil`.

    Conditions:

    - Drawn (via `fossil_image`): a witness with no drawing is nothing to draw.
    - Dated: both `fea` and a young end. A containment test, so `fea` is never
      read as a position; a wide bracket only loses the tie-break.
    - Young end is `lla_drawn`, not `lla`: a bracket widened at the young end
      cannot fail to contain a recent split (the `HOLOCENE_MA` failure again).
    - Extinct AND ended before `HOLOCENE_MA`, checked against the bracket not
      just the flag — trusting the flag once handed a 378,328-tip fork to a
      living seagrass. `is_extant = 0` also excludes NULL (genuinely unknown).
    - Primary only, and keyed on `pbdb_taxon_no` never the name: PBDB has
      internal homonyms (`Scopus` is both a hamerkop and a Permian genus), and
      aggregating by name would merge them into a tree-spanning envelope.
    """
    stats: JsonDict = {"rows": 0, "drawn": 0, "extant_excluded": 0, "unended": 0}
    out: list[FossilCandidate] = []
    if not links:
        return out, stats
    have = con.execute(
        "SELECT count(*) FROM sqlite_master WHERE type='table' AND name='fossil'"
    ).fetchone()[0]
    if not have:
        return out, stats

    has_drawn = bool(
        con.execute(
            "SELECT count(*) FROM pragma_table_info('fossil') WHERE name = 'lla_drawn'"
        ).fetchone()[0]
    )
    stats["young_end_corrected"] = has_drawn

    stats["extant_excluded"] = int(
        con.execute(
            "SELECT count(*) FROM fossil WHERE is_primary = 1 AND fea IS NOT NULL "
            "AND lla IS NOT NULL AND (is_extant IS NULL OR is_extant = 1)"
        ).fetchone()[0]
    )
    ended_col = "coalesce(lla_drawn, lla)" if has_drawn else "lla"
    stats["unended"] = int(
        con.execute(
            f"SELECT count(*) FROM fossil WHERE is_primary = 1 AND is_extant = 0 "
            f"AND fea IS NOT NULL AND {ended_col} IS NOT NULL AND {ended_col} <= ?",
            (HOLOCENE_MA,),
        ).fetchone()[0]
    )
    # `lla_drawn` not `lla`: a young end widened by `sp.`/`indet.` material would
    # let a taxon win a fork it has no business at. `coalesce` keeps a pre-column
    # fossil table working.
    young = "coalesce(lla_drawn, lla)" if has_drawn else "lla"
    for row in con.execute(
        f"SELECT pbdb_taxon_no, accepted_no, name, rank, attach_idx, attach_walk, "
        f"       fea, {young}, n_occs "
        f"  FROM fossil "
        f" WHERE is_primary = 1 AND is_extant = 0 AND attach_idx >= 0 "
        f"   AND fea IS NOT NULL AND {young} > ?",
        (HOLOCENE_MA,),
    ):
        taxon_no, accepted_no, name, rank, attach, walk, fea, lla, n_occs = row
        stats["rows"] += 1
        image = links.get(int(accepted_no))
        if image is None or not records[image].license_url:
            continue
        stats["drawn"] += 1
        out.append(
            FossilCandidate(
                pbdb_taxon_no=int(taxon_no),
                name=name,
                rank=rank,
                attach_idx=int(attach),
                attach_walk=int(walk),
                oldest=float(fea),
                youngest=float(lla),
                n_occs=int(n_occs),
                image=image,
            )
        )
    return out, stats


def divergence_witnesses(
    parent: U32Array,
    tip_count: U32Array,
    age_ma: F32Array,
    seed: I64Array,
    candidates: Sequence[FossilCandidate],
    near_fraction: float = NEAR_FRACTION,
    age_layout: F32Array | None = None,
) -> Witness:
    """For each fork, the fossil taxon that was around when it split.

    `propagate` prefers the most inclusive drawing beneath a node, which at a
    split is the wrong end of the branch (a crown group). This answers the other
    question into its own table. A candidate is a fossil, not a node: phase 4's
    `attach_idx` lets a fossil attached at `a` witness `a` and every ancestor of
    `a`, which is what lifts the cap from ~2,552 forks.

    Each candidate offers itself upward and each fork keeps the best offer:

    - Reject unless the fork has a position in time: `age_ma`, else `age_layout`
      where nobody has dated it. The layout age is used only to choose, never
      rendered as an age, so the "no number on a structural node" rule holds.
    - Reject if the fork carries its own image (exactness wins).
    - Reject if the gap between the split and `[lla, fea]` exceeds
      `near_fraction` of the split's age.
    - Otherwise rank: gap, then narrower bracket, then `attach_walk` (zero hops
      is a different quality of claim from eight, and it is what the caption
      carries), then `n_occs`, then taxon number for determinism.

    Cost is bounded by the candidates: each walks at most 111 ancestors.
    """
    n = parent.size
    if not tip_count.size == seed.size == age_ma.size == n:
        raise ValueError("divergence_witnesses: array lengths disagree")

    image = np.full(n, NO_IMAGE, dtype=np.int64)
    source = np.full(n, NO_IMAGE, dtype=np.int64)
    gap = np.full(n, np.nan, dtype=np.float64)
    taxa: dict[int, FossilCandidate] = {}

    par = parent.astype(np.int64)
    age = age_ma.astype(np.float64)
    if age_layout is not None:
        # Where nobody has estimated a split, use where it is drawn. Never the
        # other way round: a finite `age_ma` always wins, so this only ever
        # reaches nodes that would otherwise have had no witness at all.
        age = np.where(np.isfinite(age), age, age_layout.astype(np.float64))
    seeded: BoolArray = seed != NO_IMAGE

    # (gap, bracket width, attach_walk, -n_occs, taxon_no) — smallest wins.
    # Ranked per fork, because `gap` depends on whose split is being asked about.
    best: dict[int, tuple[float, float, int, int, int]] = {}
    for c in candidates:
        if not 0 <= c.attach_idx < n:
            continue
        hi, lo = c.oldest, c.youngest
        tail = (hi - lo, c.attach_walk, -c.n_occs, c.pbdb_taxon_no)
        v = c.attach_idx
        while 0 <= v < n:
            a = age[v]
            if np.isfinite(a) and a > 0.0 and tip_count[v] > 1 and not seeded[v]:
                d = 0.0 if lo <= a <= hi else min(abs(hi - a), abs(lo - a))
                if d <= near_fraction * a:
                    key = (d, *tail)
                    if v not in best or key < best[v]:
                        best[v] = key
                        source[v] = c.pbdb_taxon_no
                        image[v] = c.image
                        gap[v] = d
                        taxa[v] = c
            if v == 0:  # the root's parent is a sentinel, not an index
                break
            v = int(par[v])

    return Witness(image=image, source=source, gap=gap, taxa=taxa)


# --------------------------------------------------------------------------
# Drawings for fossils, which are not nodes
# --------------------------------------------------------------------------


def link_fossil_images(
    con: sqlite3.Connection, records: list[ImageRecord]
) -> tuple[dict[int, int], JsonDict]:
    """`pbdb accepted_no -> position in records`, by name, refusing ambiguity.

    The fossil corpus is not nodes, so this join is how a drawn, dated, attached
    fossil (*Acanthostega*, *Pakicetus*) reaches its drawing. Matched by name,
    the only shared key, so `_seed_by_name`'s refusal rule applies: PBDB has
    internal homonyms, and a name resolving to more than one `accepted_no` is
    refused. Keyed on `accepted_no`, not the name.
    """
    by_title: dict[str, int] = {}
    for i, r in enumerate(records):
        if not r.node_title or not r.license_url:
            continue
        cur = by_title.get(r.node_title)
        if cur is None or _rank(r) > _rank(records[cur]):
            by_title[r.node_title] = i

    accepted: dict[str, set[int]] = {}
    for name, acc in con.execute(
        "SELECT name, accepted_no FROM fossil WHERE is_primary = 1"
    ):
        if name in by_title:
            accepted.setdefault(name, set()).add(int(acc))

    out: dict[int, int] = {}
    ambiguous = 0
    for name, accs in accepted.items():
        if len(accs) != 1:
            ambiguous += 1
            continue
        out[next(iter(accs))] = by_title[name]
    return out, {
        "titles_offered": len(by_title),
        "fossil_taxa_matched": len(out),
        "names_ambiguous": ambiguous,
    }


def write_fossil_image(
    con: sqlite3.Connection, records: list[ImageRecord], links: dict[int, int]
) -> int:
    """One row per PBDB taxon that has a drawing.

    Keyed on `accepted_no` because that is the taxon; `fossil.accepted_no` is
    the join. Deliberately not keyed on `pbdb_taxon_no`, which is one row per
    *name* including synonyms, so a taxon would appear several times over.
    """
    con.executescript(
        """
        DROP TABLE IF EXISTS fossil_image;
        CREATE TABLE fossil_image (
          accepted_no  INTEGER PRIMARY KEY,  -- PBDB taxon; join fossil.accepted_no
          phylopic_id  TEXT NOT NULL,
          matched_name TEXT NOT NULL         -- the name both corpora agreed on
        );
        """
    )
    con.executemany(
        "INSERT INTO fossil_image VALUES (?,?,?)",
        (
            (acc, records[i].uuid, records[i].node_title or "")
            for acc, i in sorted(links.items())
        ),
    )
    con.commit()
    return int(con.execute("SELECT count(*) FROM fossil_image").fetchone()[0])


# --------------------------------------------------------------------------
# The SVG mirror
# --------------------------------------------------------------------------


@dataclass(slots=True)
class MirrorRow:
    uuid: str
    rel_path: str
    sha256: str
    bytes: int


def svg_rel_path(uuid: str) -> str:
    """Sharded so the mirror is not one directory of 12,863 entries."""
    return f"svg/{uuid[:2]}/{uuid}.svg"


def existing_mirror(records: list[ImageRecord], log: Log) -> dict[str, MirrorRow]:
    """Whatever is already on disk, verified by checksum rather than presence.

    A re-run must skip only files that are genuinely complete; a truncated
    write from an interrupted run has to be refetched, and only reading the
    bytes back distinguishes the two.
    """
    have: dict[str, MirrorRow] = {}
    for rec in records:
        rel = svg_rel_path(rec.uuid)
        p = MIRROR / rel
        if not p.exists():
            continue
        body = p.read_bytes()
        if not body.lstrip().startswith(b"<"):
            continue
        have[rec.uuid] = MirrorRow(
            rec.uuid, rel, hashlib.sha256(body).hexdigest(), len(body)
        )
    if have:
        log(f"  {len(have):,} SVGs already mirrored and verified")
    return have


def fetch_svg(client: httpx.Client, rec: ImageRecord) -> MirrorRow:
    url = rec.svg_url or f"{IMAGE_HOST}/images/{rec.uuid}/vector.svg"
    r = client.get(url)
    r.raise_for_status()
    body = r.content
    if not body.lstrip().startswith(b"<"):
        raise PhylopicError(f"{rec.uuid}: response is not SVG")
    rel = svg_rel_path(rec.uuid)
    dest = MIRROR / rel
    dest.parent.mkdir(parents=True, exist_ok=True)
    dest.write_bytes(body)
    time.sleep(SVG_PAUSE)
    return MirrorRow(rec.uuid, rel, hashlib.sha256(body).hexdigest(), len(body))


def mirror_svgs(
    records: list[ImageRecord],
    order: list[int],
    have: dict[str, MirrorRow],
    budget: int,
    log: Log,
) -> tuple[dict[str, MirrorRow], list[str]]:
    """Fetch missing SVGs in `order`, which is by descending resolved tip_count.

    Ordering that way means an interrupted crawl has already stored the images
    people actually see — Mammalia long before some monotypic beetle genus.
    """
    todo = [i for i in order if records[i].uuid not in have]
    outstanding = len(todo)
    if budget > 0:
        todo = todo[:budget]
        log(f"  budget {budget:,}: fetching {len(todo):,} of {outstanding:,} missing")
    if not todo:
        log("  mirror is complete; nothing to fetch")
        return have, []

    total_bytes = sum(r.bytes for r in have.values())
    failures: list[str] = []
    t0 = time.monotonic()
    log(f"  fetching {len(todo):,} SVGs with {MIRROR_WORKERS} workers…")

    with (
        http_client(timeout=60.0) as client,
        ThreadPoolExecutor(max_workers=MIRROR_WORKERS) as pool,
    ):

        def one(i: int) -> MirrorRow | str:
            # One bad image must not stop the other 12,862, and a failure is
            # reported rather than swallowed: it comes back as a string and is
            # counted in a gate. Re-running retries it.
            try:
                return fetch_svg(client, records[i])
            except Exception as exc:
                return f"{records[i].uuid}: {type(exc).__name__}: {exc}"

        for k, result in enumerate(pool.map(one, todo), 1):
            if isinstance(result, MirrorRow):
                have[result.uuid] = result
                total_bytes += result.bytes
            else:
                failures.append(result)
            if k % 500 == 0 or k == len(todo):
                rate = k / max(time.monotonic() - t0, 1e-6)
                log(
                    f"  {k:>6,}/{len(todo):,}  {total_bytes / 1e6:,.1f} MB  "
                    f"{rate:,.1f}/s  {len(failures)} failed"
                )
    return have, failures


def mirror_order(
    records: list[ImageRecord], tip_count: U32Array, assign: Assignment | None
) -> list[int]:
    """Fetch order: by the largest subtree each image is the silhouette for.

    Falls back to index order when the resolution has not been computed, which
    is the `--mirror-only` case.
    """
    if assign is None:
        return list(range(len(records)))
    weight = np.zeros(len(records), dtype=np.int64)
    used = assign.image != NO_IMAGE
    np.maximum.at(
        weight, assign.image[used], tip_count[assign.source[used]].astype(np.int64)
    )
    return sorted(range(len(records)), key=lambda i: (-int(weight[i]), records[i].uuid))


# --------------------------------------------------------------------------
# Output
# --------------------------------------------------------------------------


def connect_rw() -> sqlite3.Connection:
    """A writer that waits rather than failing.

    Other phases write this database too, and a 2.7M-row insert holds the write
    lock for a while, so the timeout is generous on both sides.
    """
    con = sqlite3.connect(DB, timeout=300.0)
    con.execute("PRAGMA busy_timeout = 300000")
    return con


def write_silhouette(
    con: sqlite3.Connection, records: list[ImageRecord], mirrored: dict[str, MirrorRow]
) -> None:
    con.executescript(
        """
        DROP TABLE IF EXISTS silhouette;
        CREATE TABLE silhouette (
          phylopic_id  TEXT PRIMARY KEY,
          license_url  TEXT NOT NULL,
          attribution  TEXT,     -- the original creator
          contributor  TEXT,     -- the uploader; differs 31% of the time
          svg_path     TEXT,     -- relative to the mirror root; NULL until fetched
          sha256       TEXT,
          bytes        INTEGER
        );
        """
    )
    con.executemany(
        "INSERT INTO silhouette VALUES (?,?,?,?,?,?,?)",
        [
            (
                r.uuid,
                r.license_url,
                r.attribution,
                r.contributor,
                m.rel_path if m else None,
                m.sha256 if m else None,
                m.bytes if m else None,
            )
            for r in records
            for m in (mirrored.get(r.uuid),)
        ],
    )
    con.commit()


def write_node_image(
    con: sqlite3.Connection, records: list[ImageRecord], assign: Assignment
) -> int:
    """One row per resolved node.

    architecture §3.3 puts `phylopic_id` on `node`, but that table has 2.7M
    rows and other phases are writing it, so the resolution lands in its own
    table keyed by the same `idx`. It also carries more than a single column
    could: `source_idx` and `climb` are what let the UI say "this silhouette
    represents Mammalia" rather than implying it is a portrait of the species.
    """
    con.executescript(
        """
        DROP TABLE IF EXISTS node_image;
        CREATE TABLE node_image (
          idx          INTEGER PRIMARY KEY,
          phylopic_id  TEXT NOT NULL,
          source_idx   INTEGER NOT NULL,  -- the node the image is actually OF
          clade_idx    INTEGER NOT NULL,  -- smallest clade holding idx and source
          climb        INTEGER NOT NULL,  -- hops from idx up to clade_idx
          method       TEXT NOT NULL      -- exact|ancestor|descendant|relative
        );
        """
    )
    uuids = [r.uuid for r in records]

    def rows() -> Iterator[tuple[int, str, int, int, int, str]]:
        img = assign.image.tolist()
        src = assign.source.tolist()
        clade = assign.clade.tolist()
        climb = assign.climb.tolist()
        for i, m in enumerate(assign.method.tolist()):
            if m == M_NONE:
                continue
            yield (i, uuids[img[i]], src[i], clade[i], climb[i], METHOD_NAME[m])

    con.executemany("INSERT INTO node_image VALUES (?,?,?,?,?,?)", rows())
    # Deliberately no secondary indexes. `idx` is the rowid, so the lookup the
    # UI actually makes — node -> silhouette + attribution, including for the
    # credits command — is already a primary-key probe. Measured with dbstat,
    # an index on `phylopic_id` costs 124 MB and one on `source_idx` 31 MB
    # against a 164 MB table, for reverse lookups nothing currently performs,
    # on a dataset architecture §3.3 wants under 700 MB in total.
    con.commit()
    return int(con.execute("SELECT count(*) FROM node_image").fetchone()[0])


def write_node_divergence_witness(
    con: sqlite3.Connection, records: list[ImageRecord], witness: Witness
) -> int:
    """One row per fork that has a witness.

    A second table, not columns on `node_image`: the two resolutions answer
    different questions and a consumer must take one without the other (a
    selected node wants its clade's exemplar; only a split wants the witness).

    Keyed by `fossil.pbdb_taxon_no`, NOT a node idx — a consumer joining it
    against `node` would join cleanly to an unrelated taxon, so the old
    `node_divergence_image` name is dropped. Name, rank and bracket are
    denormalised here because a witness may not render without its dates.
    """
    con.executescript(
        """
        DROP TABLE IF EXISTS node_divergence_image;
        DROP TABLE IF EXISTS node_divergence_witness;
        CREATE TABLE node_divergence_witness (
          idx           INTEGER PRIMARY KEY,
          phylopic_id   TEXT NOT NULL,
          pbdb_taxon_no INTEGER NOT NULL,  -- fossil.pbdb_taxon_no, NOT a node idx
          taxon_name    TEXT NOT NULL,
          taxon_rank    TEXT,
          attach_idx    INTEGER NOT NULL,  -- deepest node it hangs below
          attach_walk   INTEGER NOT NULL,  -- parent_no hops PBDB took to find it
          fea           REAL NOT NULL,     -- the bracket, uncollapsed. No midpoint
          lla           REAL NOT NULL,
          gap_ma        REAL NOT NULL      -- split to its range; 0 = range spans it
        );
        """
    )
    uuids = [r.uuid for r in records]
    gap = witness.gap.tolist()
    img = witness.image.tolist()
    con.executemany(
        "INSERT INTO node_divergence_witness VALUES (?,?,?,?,?,?,?,?,?,?)",
        (
            (
                idx,
                uuids[img[idx]],
                c.pbdb_taxon_no,
                c.name,
                c.rank,
                c.attach_idx,
                c.attach_walk,
                c.oldest,
                c.youngest,
                gap[idx],
            )
            for idx, c in sorted(witness.taxa.items())
        ),
    )
    con.commit()
    return int(
        con.execute("SELECT count(*) FROM node_divergence_witness").fetchone()[0]
    )


def write_arrays(records: list[ImageRecord], assign: Assignment) -> None:
    """The same resolution as flat arrays, for the packaging step."""
    OUT.mkdir(parents=True, exist_ok=True)
    np.save(OUT / "node_image.npy", assign.image.astype(np.int32))
    np.save(OUT / "node_image_source.npy", assign.source.astype(np.int64))
    np.save(OUT / "node_image_clade.npy", assign.clade.astype(np.int64))
    np.save(OUT / "node_image_climb.npy", assign.climb)
    np.save(OUT / "node_image_method.npy", assign.method)
    # The witness gets no arrays: it needs a name and a bracket beside its
    # picture, so it is read from the table. Remove the stale files, whose
    # column now holds a PBDB taxon number rather than a node index.
    for stale in (
        "node_divergence_image.npy",
        "node_divergence_source.npy",
        "node_divergence_gap.npy",
    ):
        (OUT / stale).unlink(missing_ok=True)
    (OUT / "silhouette_ids.json").write_text(
        json.dumps([r.uuid for r in records], separators=(",", ":")) + "\n"
    )


def record_mirror(records: list[ImageRecord], have: dict[str, MirrorRow]) -> None:
    """One manifest entry for the mirror, not 12,863.

    Per-file digests live in `silhouette.sha256`; the index is checksummed
    properly because the whole resolution derives from it.
    """
    m = Manifest()
    if INDEX.exists():
        record_local(
            m,
            name="phylopic_index",
            path=INDEX,
            url=f"{API}/images?embed_items=true&embed_specificNode=true",
            note=(
                f"{len(records):,} images with licence, attribution, contributor "
                "and their specific node's OTT ids. ~268 paged requests, not one "
                "per node."
            ),
        )
    m.meta["phylopic_mirror"] = {
        "images": len(records),
        "mirrored": len(have),
        "bytes": sum(r.bytes for r in have.values()),
        "root": str(MIRROR.relative_to(SNAPSHOT.parent)),
        "note": "Per-file SHA-256 lives in the silhouette table, not here.",
    }
    m.write()


# --------------------------------------------------------------------------
# Gates
# --------------------------------------------------------------------------


def coverage_gates(
    g: GateSet,
    assign: Assignment,
    tip_count: U32Array,
    subtree_out: U32Array,
    depth: DepthArray,
) -> JsonDict:
    is_tip = tip_count == 1
    resolved = assign.method != M_NONE
    strict = (assign.method == M_EXACT) | (assign.method == M_ANCESTOR)

    n_leaf, n_internal = int(is_tip.sum()), int((~is_tip).sum())
    leaf_cov = float(resolved[is_tip].mean())
    internal_cov = float(resolved[~is_tip].mean())
    leaf_strict = float(strict[is_tip].mean())
    internal_strict = float(strict[~is_tip].mean())

    # --- what the picture is actually claiming ---------------------------
    #
    # Coverage (whether an image resolved) reads 100% and means nothing: under
    # the old rule two thirds of the tree resolved to a blob standing for a
    # million species. A borrowed picture claims "this node and this drawing are
    # both inside clade C", so the honest measure is the size of C — the share of
    # nodes whose C is small enough to be about something.
    claim = np.where(resolved, tip_count[np.maximum(assign.clade, 0)], 0)
    informative = resolved & (claim <= INFORMATIVE_CLADE_TIPS)
    leaf_inf = float(informative[is_tip].mean())
    internal_inf = float(informative[~is_tip].mean())
    note = (
        "The clade is the smallest one containing both the node and the "
        "drawing, so its tip count is the size of the claim the picture "
        f"makes. At or below {INFORMATIVE_CLADE_TIPS:,} tips it is a group a "
        "reader can picture — Elminae is 987, Coccinellidae 2,272, Selachii "
        "723. The rule this replaced resolved 100% of nodes and cleared this "
        "bar for 13.4% of them, because it took the nearest *seeded ancestor* "
        "and that is usually a superphylum. Coverage is still reported below, "
        "as an observation: it says an image exists, this says whether it is "
        "about anything."
    )
    g.require(
        "leaf silhouettes represent a clade a reader can picture",
        f"{leaf_inf:.2%} of {n_leaf:,}",
        f">= {MIN_INFORMATIVE_LEAF:.0%}",
        ok=leaf_inf >= MIN_INFORMATIVE_LEAF,
        note=note,
    )
    g.require(
        "internal silhouettes represent a clade a reader can picture",
        f"{internal_inf:.2%} of {n_internal:,}",
        f">= {MIN_INFORMATIVE_INTERNAL:.0%}",
        ok=internal_inf >= MIN_INFORMATIVE_INTERNAL,
    )

    claimed = claim[resolved]
    pcts = np.percentile(claimed, [50, 75, 90]) if claimed.size else (0, 0, 0)
    g.observe(
        "clade a silhouette speaks for",
        f"median {pcts[0]:,.0f} tips, p75 {pcts[1]:,.0f}, p90 {pcts[2]:,.0f}",
        note=(
            "Median was 1,208,417 under the nearest-seeded-ancestor rule — "
            "i.e. the typical node was drawn as Ecdysozoa."
        ),
    )
    g.observe(
        "nodes whose silhouette speaks for over a million tips",
        f"{float((claim > 1_000_000).mean()):.2%}",
        note="65.3% under the previous rule.",
    )

    g.observe(
        "leaf node coverage",
        f"{leaf_cov:.4%} of {n_leaf:,}",
        f">= {BASELINE_LEAF:.1%}",
        note=(
            "The 88.6%/94.0% baseline was measured on PhyloPic's own "
            "`primaryImage` clade fallback over sampled nodes "
            "(data-sources.md finding 5). It was the right floor for a "
            "mechanism that asked the API per node, and it stopped being the "
            "right thing to *block* on once local propagation made it "
            "unanimous. Kept because a fall here would still mean a real "
            "regression in seeding."
        ),
    )
    g.observe("internal node coverage", f"{internal_cov:.4%} of {n_internal:,}")
    g.observe(
        "coverage, ancestor-or-self only",
        f"leaf {leaf_strict:.4%}, internal {internal_strict:.4%}",
        note="excludes the cousin and descendant routes",
    )

    counts = {
        METHOD_NAME.get(m, "none"): int((assign.method == m).sum())
        for m in (M_EXACT, M_ANCESTOR, M_DESCENDANT, M_RELATIVE, M_NONE)
    }
    g.observe(
        "resolution method",
        ", ".join(f"{k} {v:,}" for k, v in counts.items()),
        note=(
            "`relative` is a cousin — neither ancestor nor descendant — and is "
            "the ordinary case. It is not a weaker claim than `ancestor`: it is "
            "the same claim about a smaller clade, which is why it exists."
        ),
    )

    climb = assign.climb[resolved].astype(np.int64)
    p50, p75, p90, p99 = (
        np.percentile(climb, [50, 75, 90, 99]) if climb.size else (0.0, 0.0, 0.0, 0.0)
    )
    hist = {
        int(k): int(v)
        for k, v in zip(*np.unique(climb, return_counts=True), strict=True)
    }
    g.observe(
        "climb distribution",
        f"mean {float(climb.mean()) if climb.size else 0:.2f}, "
        f"p50 {p50:.0f}, p75 {p75:.0f}, p90 {p90:.0f}, p99 {p99:.0f}, "
        f"max {int(climb.max(initial=0))}",
        note=(
            "Hops from a node up to the clade its picture speaks for. Climb 0 "
            "means the drawing is of this node or of something inside it. This "
            "used to count hops to the *source* and averaged 27, which was "
            "measuring the search rather than the answer — the clade size "
            "above is what a reader is affected by."
        ),
    )

    # A content gate, not a row count. CLAUDE.md records a column that stayed
    # permanently NULL while every structural gate passed: counting rows is not
    # checking them. The preorder interval is the whole claim being made.
    rng = np.random.default_rng(20260731)
    pool = np.flatnonzero(resolved)
    sample = rng.choice(pool, size=min(200_000, pool.size), replace=False)
    src = assign.source[sample]
    cld = assign.clade[sample]
    out = subtree_out.astype(np.int64)
    depth64 = depth.astype(np.int64)
    # The whole claim, checked as one statement: the clade contains both the
    # node and the drawing. Under the old ancestor-only rule this was
    # "source is an ancestor of node", which a cousin fails while being a
    # strictly better answer — so the invariant moves to the clade, which is
    # the thing the UI now shows and therefore the thing that must be true.
    sane = (
        (cld <= sample)
        & (sample < out[cld])
        & (cld <= src)
        & (src < out[cld])
        & (assign.climb[sample] == (depth64[sample] - depth64[cld]))
    )
    g.require(
        "a sampled silhouette's clade really contains both node and drawing",
        f"{int((~sane).sum())} violations in {sample.size:,} sampled nodes",
        "0 violations",
        ok=bool(sane.all()),
        note=(
            "clade <= i < subtree_out[clade] for both the node and its image's "
            "node, and climb is the depth difference. That is exactly what the "
            "card asserts when it says the picture is of something within this "
            "clade, so it is what gets checked."
        ),
    )
    g.require(
        "an exact silhouette is the node's own, and only then",
        int(((src == sample) != (assign.method[sample] == M_EXACT)).sum()),
        0,
        note=(
            "Replaces a gate reading `climb == 0 iff exact`, which stopped "
            "being true when climb started counting hops to the clade: an "
            "unseeded genus holding a drawn species sits at climb 0 and is "
            "emphatically not a portrait of itself."
        ),
    )
    return {
        "leaf_informative": leaf_inf,
        "internal_informative": internal_inf,
        "clade_tips_median": float(np.median(claimed)) if claimed.size else 0.0,
        "leaf": leaf_cov,
        "internal": internal_cov,
        "leaf_strict": leaf_strict,
        "internal_strict": internal_strict,
        "methods": counts,
        "climb_histogram": hist,
    }


def _licence_label(url: str) -> str:
    if not url:
        return "<none>"
    parts = [p for p in url.split("/") if p]
    return "/".join(parts[-2:]) if len(parts) >= 2 else url


# The cases the witness rule was built for, pinned by OTT id because names are
# ambiguous in this taxonomy. The first two (Acanthostega, Eohippus) are the
# reason the layer moved off nodes: textbook animals for their divergences,
# already drawn, but not in the synthesis tree.
WITNESS_ANCHORS: tuple[tuple[str, tuple[int, ...], str], ...] = (
    ("the fish–tetrapod split", (229562,), "Acanthostega gunnari"),
    ("the horse–rhino split", (541948,), "Eohippus angustidens"),
    ("the human–chimp split", (770309, 417957), "Sahelanthropus tchadensis"),
    ("the whale–hippo split", (7655791,), "Pakicetus"),
)


def _mrca(parent: U32Array, nodes: Sequence[int]) -> int:
    """Last common element of the ancestor paths."""
    par = parent.astype(np.int64)

    def path(v: int) -> list[int]:
        out = [v]
        while v != 0:
            v = int(par[v])
            out.append(v)
        return out[::-1]

    common = path(nodes[0])
    for v in nodes[1:]:
        other = set(path(v))
        common = [u for u in common if u in other]
    return common[-1]


# Witnessed forks whose taxon's range actually contains the split — this, not
# coverage, is the measure (coverage is easy to fill and hard to fill
# defensibly). Spanning is not clean either: a range running to the present
# spans by construction (the HOLOCENE_MA hazard), so moving off nodes lowered
# spanning even while reaching far more forks. The floor catches a rule that has
# stopped working, not a number to ratify.
MIN_SPANNING_WITNESSES = 175


def witness_gates(
    g: GateSet,
    witness: Witness,
    con: sqlite3.Connection,
    parent: U32Array,
    tip_count: U32Array,
    candidates: Sequence[FossilCandidate],
    candidate_stats: JsonDict,
    age_ma: F32Array,
) -> None:
    """Check the forks everyone will look at, then the failure modes.

    The blocking gates are the named forks and the count of witnesses that span
    their split; everything else observes.
    """
    found = witness.source != NO_IMAGE
    n = int(found.sum())
    spans = int((witness.gap[found] == 0.0).sum())
    undated = int((found & ~np.isfinite(age_ma.astype(np.float64))).sum())
    cap = "uncapped" if not np.isfinite(NEAR_FRACTION) else f"{NEAR_FRACTION:.0%}"

    g.observe(
        "fossil taxa eligible to witness",
        f"{candidate_stats['drawn']:,} drawn, of "
        f"{candidate_stats['rows']:,} extinct and dated",
        note=(
            "Drawn through `fossil_image`, dated by both `fea` and `lla`, "
            "extinct, ended before the Holocene, and accepted rather than a "
            f"synonym. {candidate_stats['extant_excluded']:,} otherwise-eligible "
            "taxa are excluded for being extant or of unknown extancy — PBDB "
            "carries Mammalia at 239.5–0 Ma and a range running to the present "
            "spans every split inside it — and a further "
            f"{candidate_stats['unended']:,} for being flagged extinct while "
            "their bracket runs to the present anyway, which is the same hazard "
            "arriving through a wrong flag. See HOLOCENE_MA."
        ),
    )
    g.observe(
        "forks given a divergence witness",
        f"{n:,}",
        note=(
            f"Coverage, and deliberately not a blocking gate — see "
            f"MIN_SPANNING_WITNESSES. Gap {cap}. A witness must be a fossil "
            "attached below the fork, not a node, which is what raises this "
            "past the 2,552 the node-only design could ever reach."
        ),
    )
    g.require(
        "forks whose witness spans the split",
        f"{spans:,} of {n:,} ({spans / max(n, 1):.0%})",
        f">= {MIN_SPANNING_WITNESSES:,}",
        ok=spans >= MIN_SPANNING_WITNESSES,
        note=(
            "The taxon was demonstrably alive across the divergence, so the "
            "picture needs no hedging. The gate is here rather than on coverage "
            "because coverage rises when the rule gets looser. Read it against "
            "207 under the node-only design on the same data, and read that "
            "against the 14 of those 207 that spanned only because a living "
            "taxon's range runs to the present — Moho braccatus, a bird that "
            "died in 1987, spanned Passeriformes at a 52 Ma gap. See "
            "MIN_SPANNING_WITNESSES for the whole comparison."
        ),
    )
    # Not a failure — it is the fallback working — but it is the number that
    # says how much of this layer rests on a position rather than an estimate,
    # and the UI is obliged to caption every one of them as undated.
    g.observe(
        "witnesses chosen against a fork nobody has dated",
        f"{undated:,} of {n:,} ({undated / max(n, 1):.0%})",
        note=(
            "`age_ma` is NaN on these, so the split was matched against "
            "`age_layout` — where the fork is drawn, not an estimate of when "
            "it happened. No number is shown for them anywhere; the card says "
            "the fork is undated. Without this fallback Carnivora, Canidae, "
            "Primates and Rodentia have no witness at all."
        ),
    )
    _witness_shape_gates(g, witness, candidates)

    ott = {o: i for i, o in con.execute("SELECT idx, ott_id FROM node WHERE ott_id")}
    for label, ids, expected in WITNESS_ANCHORS:
        nodes = [ott[o] for o in ids if o in ott]
        if len(nodes) != len(ids):
            g.require(
                f"{label} resolves",
                "missing",
                "in the tree",
                ok=False,
                note=f"OTT {ids} not all present; the anchor cannot be checked.",
            )
            continue
        node = _mrca(parent, nodes) if len(nodes) > 1 else nodes[0]
        c = witness.taxa.get(node)
        g.require(
            f"{label} is witnessed by {expected}",
            f"{c.name} {c.oldest:g}–{c.youngest:g} Ma, walk {c.attach_walk}"
            if c
            else "no witness",
            expected,
            ok=c is not None and c.name == expected,
            note=(
                f"node {node}, {int(tip_count[node]):,} tips. Before this rule "
                "existed it drew the most inclusive picture beneath it, which "
                "is a crown group that did not exist when the split happened."
            ),
        )


def _witness_shape_gates(
    g: GateSet, witness: Witness, candidates: Sequence[FossilCandidate]
) -> None:
    """The two failure modes that look exactly like success.

    - A wide bracket wins everything it contains: the most prolific witnesses are
      reported by name, since a single taxon holding a large share of the table
      is the shape of that failure (the narrow-bracket tie-break should demote it).
    - A loose attachment reads like a placement: the `attach_walk` distribution
      shows whether the caption's hedging is doing real work.
    """
    by_taxon: dict[int, int] = {}
    walks: dict[int, int] = {}
    for c in witness.taxa.values():
        by_taxon[c.pbdb_taxon_no] = by_taxon.get(c.pbdb_taxon_no, 0) + 1
        walks[c.attach_walk] = walks.get(c.attach_walk, 0) + 1
    total = max(len(witness.taxa), 1)

    names = {c.pbdb_taxon_no: c.name for c in candidates}
    top = sorted(by_taxon.items(), key=lambda kv: (-kv[1], kv[0]))[:8]
    biggest = top[0][1] if top else 0
    g.observe(
        "the most prolific witnesses",
        ", ".join(f"{names.get(t, t)} {k:,}" for t, k in top),
        note=(
            f"The widest single share is {biggest / total:.1%} of the table. "
            "Ammonitina (249.9–56 Ma, 43,884 occurrences) is the taxon to watch "
            "here: it contains a great many forks and the narrow-bracket "
            "tie-break is the only thing demoting it."
        ),
    )
    g.observe(
        "how far witnesses hang below their fork",
        ", ".join(f"{w} hops {k:,}" for w, k in sorted(walks.items())),
        note=(
            "`attach_walk` = 0 means PBDB's own taxon is in the synthesis tree "
            "and the fossil sits exactly there. Every hop above that widens the "
            "claim from a lineage to a group, which is what the caption's "
            "'somewhere below this fork' has to carry."
        ),
    )


def licence_gates(
    g: GateSet, records: list[ImageRecord], mirrored: dict[str, MirrorRow]
) -> None:
    g.require(
        "images stored without a licence URL",
        sum(1 for r in records if not r.license_url),
        0,
    )
    needs = [r for r in records if r.needs_attribution]
    g.require(
        "attribution-required images with a null attribution",
        sum(1 for r in needs if not (r.attribution or "").strip()),
        0,
        note=(
            "attribution is null 19.3% overall but 0% null among images that "
            "require it, so a null here is a hard failure, not a shrug."
        ),
    )
    n = max(len(records), 1)
    g.observe(
        "images requiring attribution",
        f"{len(needs):,} ({len(needs) / n:.1%})",
        "47.2% of primaryImage results (data-sources.md)",
    )
    differ = sum(
        1
        for r in records
        if r.contributor and (r.attribution or "") != (r.contributor or "")
    )
    g.observe(
        "creator differs from uploader",
        f"{differ:,} ({differ / n:.1%})",
        "31%",
        note="Conflating the two credits the wrong person; both columns exist.",
    )
    by_licence: dict[str, int] = {}
    for r in records:
        lbl = _licence_label(r.license_url)
        by_licence[lbl] = by_licence.get(lbl, 0) + 1
    g.observe(
        "licence distribution",
        ", ".join(
            f"{k} {v:,}" for k, v in sorted(by_licence.items(), key=lambda kv: -kv[1])
        ),
        note="No NonCommercial filtering: this is not a commercial project.",
    )
    g.observe(
        "SVGs mirrored",
        f"{len(mirrored):,} / {len(records):,} "
        f"({sum(m.bytes for m in mirrored.values()) / 1e6:,.1f} MB)",
        f"{EXPECT_IMAGES:,} (~136 MB)",
    )


# --------------------------------------------------------------------------
# Phase entry point
# --------------------------------------------------------------------------


def run(budget: int = 0, mirror_only: bool = False, log: Log = _log) -> int:
    """Phase 5a.

    `budget` caps SVG downloads per run, not node resolutions (there is no
    per-node remote work). Runs are resumable, so repeated budgeted runs
    converge on a complete mirror.
    """
    g = GateSet("phase5a-images")
    MIRROR.mkdir(parents=True, exist_ok=True)
    OUT.mkdir(parents=True, exist_ok=True)

    records, meta = load_index()
    build: int | None = meta.get("build")
    total_items: int | None = meta.get("total_items")

    if mirror_only:
        if not records:
            raise SystemExit(
                "--mirror-only needs a crawled index; run `concestor-build images` first"
            )
        log(f"--- mirror only: {len(records):,} images from {INDEX} ---")
    else:
        log("--- PhyloPic index crawl ---")
        with http_client(timeout=60.0) as client:
            api = _ApiClient(client, log)
            if records and build == api.build:
                log(f"  index is current for build {api.build}; reusing {INDEX}")
            else:
                if records:
                    log(f"  index is for build {build}, service is on {api.build}")
                records = crawl_index(api, log)
                save_index(records, api.build, api.total_items)
            build, total_items = api.build, api.total_items

    g.observe("PhyloPic build index", build, note="Stale builds 410; never hard-coded.")
    # The service states its own `totalItems`, so a short crawl (paging stopped
    # early) is caught rather than silently shrinking coverage.
    g.require(
        "crawled every image the service lists",
        f"{len(records):,}",
        f"{total_items:,}" if total_items is not None else "unknown",
        ok=total_items is not None and len(records) == total_items,
        note=f"data-sources.md measured {EXPECT_IMAGES:,} on 2026-07-31.",
    )
    g.observe(
        "corpus size against the documented figure",
        f"{len(records):,}",
        f"{EXPECT_IMAGES:,}",
        note="The corpus grows with uploads; the gate above is the real check.",
    )
    with_ott = sum(1 for r in records if r.ott_ids)
    g.observe(
        "images with a specific node", f"{sum(1 for r in records if r.node_uuid):,}"
    )
    g.observe(
        "images whose node declares an OTT id",
        f"{with_ott:,} ({with_ott / max(len(records), 1):.1%})",
        note="The rest resolve only in GBIF/PBDB namespaces, so they seed nothing.",
    )

    # --- resolution ------------------------------------------------------
    tip_count = np.load(TOPO_OUT / "tip_count.npy")
    subtree_out = np.load(TOPO_OUT / "subtree_out.npy")
    assign: Assignment | None = None
    witness: Witness | None = None
    links: dict[int, int] = {}
    link_stats: JsonDict = {"fossil_taxa_matched": 0, "names_ambiguous": 0}
    fossil_candidates: list[FossilCandidate] = []
    candidate_stats: JsonDict = {"rows": 0, "drawn": 0, "extant_excluded": 0}

    if mirror_only:
        g.observe("node resolution", "skipped (--mirror-only)")
    else:
        log("\n--- resolving 2,725,682 nodes locally (zero API calls) ---")
        parent = np.load(TOPO_OUT / "parent.npy")
        depth = np.load(TOPO_OUT / "depth.npy")
        ott_id = np.load(TOPO_OUT / "ott_id.npy")

        con = sqlite3.connect(f"file:{DB}?mode=ro", uri=True)
        forwards = load_forwards(con)
        con.close()

        t0 = time.monotonic()
        parents, name_uids = taxonomy_index(name_candidates(records))
        seed, stats = seed_nodes(
            ott_id,
            tip_count,
            pick_per_ott(records),
            forwards,
            parents,
            titles=[r.node_title for r in records],
            name_uids=name_uids,
        )
        assign = propagate(parent, depth, subtree_out, seed, tip_count)
        # The join that makes a fossil drawable has to happen before the witness
        # can use it, and it is the same join the drill-down lane consumes, so
        # it is computed once here and written once below.
        con = sqlite3.connect(f"file:{DB}?mode=ro", uri=True)
        links, link_stats = link_fossil_images(con, records)
        fossil_candidates, candidate_stats = load_fossil_candidates(con, records, links)
        con.close()
        # Phase 2's output is optional here the way phase 4's is: without a
        # dated split there is nothing for a fossil to be near, so the witness
        # table is simply absent and every consumer falls back to `node_image`.
        ages = TOPO_OUT / "age_ma.npy"
        layout = TOPO_OUT / "age_layout.npy"
        if ages.exists():
            witness = divergence_witnesses(
                parent,
                tip_count,
                np.load(ages),
                seed,
                fossil_candidates,
                age_layout=np.load(layout) if layout.exists() else None,
            )
        log(f"  propagated in {time.monotonic() - t0:,.1f}s")

        g.observe(
            "OTT ids offered by PhyloPic",
            f"{stats['ott_ids_offered']:,}",
            note="distinct ids across every image's specific node",
        )
        g.require(
            "seeded nodes",
            f"{stats['seeded_nodes']:,}",
            "> 0",
            ok=stats["seeded_nodes"] > 0,
            note=(
                f"{stats['ott_ids_in_tree']:,} of the offered ids are in the tree; "
                f"{stats['ott_ids_via_forward']:,} only after chasing a forward."
            ),
        )
        g.observe(
            "seeds recovered by the one-hop lift",
            f"{stats['ott_ids_lifted_one_hop']:,}",
            note=(
                f"Cited taxa absent from synthesis, lifted onto a parent of "
                f"<= {LIFT_MAX_TIPS} tips. Without it Homo sapiens has no "
                "silhouette of its own and climbs 35 nodes to Mammalia, because "
                "PhyloPic attaches its human images to the subspecies Homo "
                "sapiens sapiens, which synthesis does not carry."
                if parents
                else "taxonomy.tsv not extracted; lifting skipped"
            ),
        )
        g.observe(
            "nodes seeded by their image's node name and nothing stronger",
            f"{stats['nodes_from_name']:,} exact, "
            f"{stats['nodes_from_name_truncated']:,} truncated to species or genus",
            note=(
                f"{len(records) - with_ott:,} images declare no OTT id at all — "
                "their specific node resolves only in GBIF or PBDB namespaces — "
                "and no amount of id chasing reaches those. The name does. "
                f"Read this against the {stats['names_matched']:,} exact and "
                f"{stats['names_matched_truncated']:,} truncated matches the "
                "passes actually made: most land on a node an OTT id also "
                "reaches, and crediting those to the name would be counting "
                "work rather than result. "
                f"{stats['names_ambiguous']:,} refused as homonyms, resolving "
                "to more than one node."
                if name_uids
                else "taxonomy.tsv not extracted; name matching skipped"
            ),
        )
        cov = coverage_gates(g, assign, tip_count, subtree_out, depth)
        (BUILD / "phase5a_coverage.json").write_text(json.dumps(cov, indent=2) + "\n")
        if witness is None:
            g.observe(
                "divergence witnesses",
                "skipped",
                note="age_ma.npy is absent; phase 2 has not run.",
            )
        else:
            con = sqlite3.connect(f"file:{DB}?mode=ro", uri=True)
            witness_gates(
                g,
                witness,
                con,
                parent,
                tip_count,
                fossil_candidates,
                candidate_stats,
                np.load(ages),
            )
            con.close()
        write_arrays(records, assign)

    # --- mirror ----------------------------------------------------------
    log("\n--- SVG mirror ---")
    have = existing_mirror(records, log)
    have, failures = mirror_svgs(
        records, mirror_order(records, tip_count, assign), have, budget, log
    )
    if failures:
        log(f"  {len(failures)} failures; first few: {failures[:3]}")
    g.observe(
        "SVG fetch failures this run",
        len(failures),
        0,
        note="A failure does not block; re-running retries it.",
    )

    # --- tables ----------------------------------------------------------
    log("\n--- writing tables ---")
    con = connect_rw()
    write_silhouette(con, records, have)
    log(f"  silhouette: {len(records):,} rows")
    if assign is not None:
        log(f"  node_image: {write_node_image(con, records, assign):,} rows")
    if witness is not None:
        rows = write_node_divergence_witness(con, records, witness)
        log(f"  node_divergence_witness: {rows:,} rows")
    if not mirror_only:
        log(f"  fossil_image: {write_fossil_image(con, records, links):,} rows")
    con.close()

    g.require(
        "PBDB fossil taxa given a drawing",
        f"{link_stats['fossil_taxa_matched']:,}",
        "> 0",
        ok=mirror_only or link_stats["fossil_taxa_matched"] > 0,
        note=(
            "Matched by name — the only key PhyloPic and PBDB share — and keyed "
            "on `accepted_no`, which is the taxon. This is what makes a fossil "
            "drawable at all: it is not a node, so nothing above reaches it. "
            f"{link_stats['names_ambiguous']:,} names refused for resolving to "
            "more than one accepted taxon; PBDB carries homonyms internally, "
            "not only against OTT, and `Scopus` is both an extant hamerkop and "
            "an extinct Permian genus."
        ),
    )
    record_mirror(records, have)

    licence_gates(g, records, have)
    g.observe(
        "concestor.db",
        f"{DB.stat().st_size / 1e6:,.1f} MB",
        note="node_image is one row per resolved node.",
    )

    g.write(BUILD / "phase5a_gates.json")
    g.exit_if_failed()
    return 0
