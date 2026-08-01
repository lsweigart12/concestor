"""Phase 5a — mirror the PhyloPic corpus and resolve every node to a silhouette.

Silhouettes are priority-one work (handoff.md §1): for a curious non-specialist
an image is what makes a clade mean anything, and unlike a photograph a
silhouette legitimately represents a *clade* rather than one member of it.

## Why this does not do what ingest.md phase 5 step 2 says

Step 2 reads "resolve each node to an image", and the obvious implementation is
one `primaryImage` or `/resolve/opentreeoflife.org/taxonomy/{ott_id}` call per
node. There are **2,725,682 nodes**. That is not a crawl, it is a denial of
service against a small volunteer-run service, and every operational note in
data-sources.md says to pace requests to exactly this kind of host.

The corpus is 12,863 images against 2.7M nodes, so the index is two orders of
magnitude smaller than the thing being resolved. Crawl the index instead:

1. Page `/images?embed_items=true&embed_specificNode=true`, 48 items a page,
   ~268 requests. Each page carries every image's licence, attribution and
   contributor *and* its specific node's `_links.external`, which includes
   `/resolve/opentreeoflife.org/taxonomy/{ott_id}`. That yields the whole
   `image → ott_id` mapping from the index alone.
2. Propagate locally in numpy with **zero further API calls**: seed the mapped
   OTT nodes, then give every other node the picture of its closest drawn
   relative. See `propagate`.

Preorder numbering (`parent[i] < i`) is what makes step 2 a sweep rather than a
traversal, and the same interval property gives the content gate its check.

## The number that matters is `clade_idx`, not `climb`

The first version of step 2 gave a node the image of its nearest
ancestor-or-self that had one. That resolves every node in the tree, which is
why this phase used to report 100% coverage — and 100% was worthless, because
with 7,470 seeds over 2.7M nodes the nearest *seeded* ancestor is usually a
superphylum. Two thirds of the tree was drawn as Ecdysozoa, `cellular
organisms` or Opisthokonta, so a screen full of arthropods showed one shape
repeated and told a reader nothing.

What a borrowed picture claims is "this node and this drawing are both inside
clade C". `clade_idx` is that C — the *smallest* one, which is the nearest
ancestor-or-self of the node with any seed beneath it, cousins included — and
its `tip_count` is the size of the claim. That is what the UI must render and
what the gates are written against; `climb` is now just how far up C sat.

## Mirroring

Stale `build` values return **410 Gone, not a redirect**, with the current build
in the error body; `_ApiClient` re-derives from that body rather than hard-coding
a number. Mirroring the SVGs removes both the runtime dependency and the
build-number churn. The fetch is ordered by the `tip_count` of the node an image
resolves, so an interrupted crawl has already stored the images people actually
see, and it is resumable by checksum rather than by presence.

This is not a commercial project (handoff.md §1), so there is no NonCommercial
filtering and no `--commercial-safe` flag. Attribution still applies: CC-BY
requires it for any redistribution and the artists deserve credit. It is a
two-field problem — `attribution` is the original creator, the contributor is
the uploader, and they differ 31% of the time — so both are stored separately.
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
# `seed_nodes`. Measured on the real corpus: 211 lifts at 10 tips, 317 at 100,
# 410 at 1,000, so the curve is already flat here and every extra lift past
# this point is a broader claim for less. At 100 the widest target is Felidae
# (91 tips), and Amphibia (10,018), Echinodermata (8,729), Cnidaria (15,451)
# and Sauropsida (32,043) are all excluded, which is the whole point.
LIFT_MAX_TIPS = 100

MIRROR_WORKERS = 6
API_PAUSE = 0.15  # between index pages; the API is one small service
SVG_PAUSE = 0.02  # between SVG fetches; images.phylopic.org is S3 + CloudFront


class PhylopicError(RuntimeError):
    pass


def _log(msg: str) -> None:
    """Unbuffered, because the mirror runs for a quarter of an hour.

    `print` buffers when stdout is not a terminal, which is exactly when the
    progress lines are wanted — a redirected log that stays empty for ten
    minutes is indistinguishable from a hang.
    """
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

    A stale `build` returns 410 Gone rather than a redirect, and the current
    build is in the error body. Hard-coding a build number would therefore
    break this phase at PhyloPic's next release, so it is read from the service
    and re-read whenever the service says it has moved on.
    """

    def __init__(self, client: httpx.Client, log: Log) -> None:
        self.client = client
        self.log = log
        self.requests = 0
        head = self._collection_head()
        self.build: int = head["build"]
        # The service's own count, so the crawl can be gated on completeness
        # rather than on a constant that goes stale with the next upload.
        self.total_items: int | None = head.get("totalItems")
        self.items_per_page: int | None = head.get("itemsPerPage")

    def _collection_head(self) -> JsonDict:
        """Ask the service what build it is on, rather than hard-coding one.

        `/images` with *no* parameters 307s to the current build; `?page=0`
        without a build is a 400 rather than a redirect ("Cannot pass `page`
        without also specifying a build"). The unpaged collection is worth the
        extra request anyway: it carries `totalItems` and `itemsPerPage`, which
        is what turns "did the crawl finish" into a checkable question.

        Responses are `application/vnd.phylopic.v2+json`, not `application/json`,
        so there is nothing to be gained by sniffing the content type. Every
        payload including the error bodies carries `build` at the top level.
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

    1. **Direct.** The cited OTT id is a node. 6,976 of 9,461 offered ids.
    2. **Forwarded.** OTT id forwarding is silent, so a direct miss is not the
       same as an id absent from the tree; phase 1's `forward` table already
       chased the chains transitively.
    3. **Lifted one hop.** 2,485 cited ids are in `taxonomy.tsv` but not in the
       synthesis tree, and they are overwhelmingly *extinct* taxa — only 0.5%
       of OTT taxa flagged extinct appear in synthesis at all (architecture
       §3.4). Walking those up an unbounded parent chain is not a win, it is
       the "mole for Mammalia" failure with extra steps: it would seed Amphibia
       with a Devonian stem tetrapod, Cnidaria with an Ediacaran frond and
       Sauropsida with a marine reptile. So the lift is bounded on both ends —
       exactly one hop, and only onto a node narrow enough that the image is
       still broadly representative of it. That admits `Homo sapiens sapiens →
       Homo sapiens`, `Panthera gombaszoegensis → Panthera` and 315 more, and
       refuses every fossil-onto-phylum case.
    4. **Named.** 1,783 images declare no OTT id at all — their specific node
       resolves only in GBIF or PBDB namespaces — so passes 1–3 cannot reach
       them however hard they try. But every image *names* its node, and that
       name is an OTT name: match `node_title` against `taxonomy.tsv` and the
       id comes back. This is an exact claim about the taxon, so it carries no
       tip bound. `Chlamydiae`'s silhouette really is of Chlamydiae.
    5. **Named, truncated.** A title that names no node may still name one once
       the trailing epithet comes off: `Equus quagga chapmani → Equus quagga →
       Equus`, `Phoca caspica → Phoca`. Bounded by `lift_max_tips` for exactly
       the reason pass 3 is — a genus is a defensible target for a species
       image, a family is not.

    Passes 4 and 5 refuse a name that resolves to more than one node. OTT
    carries homonyms across kingdoms and nothing in the title says which
    `Prunella` PhyloPic drew, so the honest answer is no image.

    A direct hit always beats a lifted one for the same node, and an OTT id
    always beats a name.
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
    # Two OTT ids can land on one node when a forward collapses a synonym onto
    # its accepted id. Last write wins, deterministically: `wanted` comes out of
    # an insertion-ordered dict built from a stable record list, and the name
    # passes walk `titles` in record order. Weakest evidence goes down first so
    # that a stronger pass overwrites it.
    #
    # `tier` records which pass a node's seed *survived* from, which is the only
    # honest way to credit one. Most name matches land on a node an OTT id also
    # reaches, so counting matches would report thousands of "recoveries" that
    # changed nothing — the flattering-gate failure this project keeps hitting.
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
    tie-broken by shallower depth and then by index so the choice is
    deterministic. That ordering is not a matter of taste. A contributor who
    attaches a drawing to a large clade is saying the drawing stands for the
    group, and a contributor who attaches one to a species is saying it stands
    for that species — so preferring the inclusive seed picks the image whose
    author intended it as an exemplar. Measured on the real corpus it is also
    the difference between showing a boa constrictor for Serpentes and showing
    a blind snake, and between a mushroom for Fungi and a mould.

    Only 7,470 nodes are seeded, so this walks each seed's ancestor chain
    best-first and stops at the first ancestor a better seed already claimed —
    everything above it is claimed too. Total work is bounded by the 30,982
    nodes that have any seed beneath them, not by the 2.7M in the tree.
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

    The rule this replaced was "the nearest ancestor that is *itself* seeded",
    and it resolved every node in the tree — which is why phase 5a reported
    100% coverage and why that number told nobody anything. With 7,470 seeds
    over 2.7M nodes the nearest seeded ancestor is usually enormous: measured,
    65.3% of the tree borrowed from a clade of more than a million tips, and
    three sources — Ecdysozoa, `cellular organisms`, Opisthokonta — served
    1.79M nodes between them. A riffle beetle was drawn as the Ecdysozoa blob;
    so was every other arthropod on screen, so the canvas carried no
    information at all.

    The claim a borrowed picture actually makes is "this node and this drawing
    are both inside clade C, and here is what something in C looks like". What
    matters is therefore the size of **C**, not how many hops the search took —
    and the honest choice of C is the *smallest* clade containing both, which
    is the nearest ancestor-or-self of the node with any seed beneath it. For
    that beetle C is Elminae (987 tips) rather than Ecdysozoa (1,208,417), and
    the median across the tree falls from 1,208,417 tips to 3,153.

    Exactness still wins: a node with its own image keeps it, so Mammalia is
    still drawn as Mammalia and never as one mole inside it. architecture §7's
    warning survives intact — it is about a *specific* node wearing a clade's
    picture, and `clade` is exactly the number that says how big a claim that
    is. The UI must render it; a picture from a 987-tip family is a fact about
    the beetle, and one from a 1.2M-tip superphylum is not.
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

    # The method is the topological relationship, derived rather than tracked,
    # so it cannot drift from the arrays it describes. `relative` is new and is
    # the common case: a cousin, neither ancestor nor descendant.
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


def write_arrays(records: list[ImageRecord], assign: Assignment) -> None:
    """The same resolution as flat arrays, for the packaging step.

    `node_image` is the queryable form; these are the mmap-able one, and they
    keep the hot path off SQLite the way architecture §3.2 does for topology.
    """
    OUT.mkdir(parents=True, exist_ok=True)
    np.save(OUT / "node_image.npy", assign.image.astype(np.int32))
    np.save(OUT / "node_image_source.npy", assign.source.astype(np.int64))
    np.save(OUT / "node_image_clade.npy", assign.clade.astype(np.int64))
    np.save(OUT / "node_image_climb.npy", assign.climb)
    np.save(OUT / "node_image_method.npy", assign.method)
    (OUT / "silhouette_ids.json").write_text(
        json.dumps([r.uuid for r in records], separators=(",", ":")) + "\n"
    )


def record_mirror(records: list[ImageRecord], have: dict[str, MirrorRow]) -> None:
    """One manifest entry for the mirror, not 12,863.

    Per-file digests live in `silhouette.sha256`; putting them in the
    git-tracked `snapshot/manifest.json` would add megabytes of churn for
    something the database already carries. The index is checksummed properly,
    because it is what the whole resolution is derived from.
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
    # This pair of gates replaces the pair that used to block here, which
    # required 94%/88.6% node coverage and measured 100.0000%. Both numbers
    # were true and neither meant anything: coverage asks whether *an* image
    # resolved, and under the old rule two thirds of the tree resolved to a
    # blob standing for a million species. A reader seeing 100% would conclude
    # the silhouette layer worked, and management.md records that in every
    # screenshot of the last build not one silhouette usefully rendered.
    #
    # What a borrowed picture claims is "this node and this drawing are both
    # inside clade C". So the honest measure is the size of C, and the gate is
    # the share of nodes whose C is small enough to be about something. Read
    # it as: for this fraction of the tree, the picture beside a node depicts
    # a group the node genuinely belongs to and a reader can hold in mind.
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

    `budget` caps **SVG downloads** in one run rather than node resolutions.
    There is no per-node remote work left to budget — that is the point of the
    redesign at the top of this module — so the only unbounded remote cost is
    the mirror, and that is what the flag governs. Runs are resumable, so
    repeated budgeted runs converge on a complete mirror.
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
    # The service states its own `totalItems`, so completeness is checkable
    # rather than assumed. A short crawl means paging stopped early, which is
    # the failure mode that would silently shrink coverage.
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
    con.close()
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
