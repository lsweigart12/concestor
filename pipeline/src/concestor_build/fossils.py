"""Phase 4 — attach PBDB taxa to the synthesis tree.

Fossils are not placed in the tree, they are attached to it: only ~0.5% of
extinct OTT taxa appear in the synthesis tree, so the fossil record is a
parallel corpus with no topology of its own. Each PBDB taxon gets an attachment
point — the deepest node that is an ancestor-or-self of it — found by walking
PBDB's `parent_no` hierarchy upward until a taxon resolves through phase 3's
`xref` to an in-synth `idx`. The claim is weak by design: this taxon belongs
somewhere below node X, and existed between these dates. Nothing more.

Three things this phase must not get wrong, all recorded as gates:

- Key on `accepted_no`, display `accepted_name`.
- Never group by `taxon_rank`: rank does not survive resolution (*Aublysodon*
  is a genus whose accepted name is a family).
- Carry all four appearance bounds uncollapsed: `fea/fla` and `lea/lla` are two
  uncertainty brackets, and a single range is a different, wrong claim.

The parent-walk ceiling is not a bug: GBIF's backbone has fewer ranks than PBDB,
so some PBDB taxa sit at ranks it cannot express and are unmatchable rather than
unmatched. The walk just walks further.
"""

from __future__ import annotations

import json
import random
import time
from collections import Counter
from typing import TYPE_CHECKING, NamedTuple

import httpx
import numpy as np

from .dates import TIER_OCCURRENCE, TIER_STRUCTURAL
from .gates import GateSet
from .paths import BUILD
from .provenance import USER_AGENT
from .resolve import METHOD_ORDER, ROOT_IDX, connect, load_pbdb_taxa, table_exists

if TYPE_CHECKING:
    import sqlite3
    from collections.abc import Iterator, Sequence

    from .resolve import PbdbTaxon
    from .typing_ import F32Array, F64Array, JsonDict, Log, U8Array, U32Array

TOPOLOGY = BUILD / "topology"
BASELINE = BUILD / "phase4_baseline.json"
LAYOUT_BASELINE = BUILD / "phase4_layout.json"
# Phase 2's un-fossil-informed layout, kept so the two can be diffed and so a
# re-run of this phase clamps the original rather than compounding its output.
LAYOUT_PHASE2 = TOPOLOGY / "age_layout_phase2.npy"

# Float32 positions and REAL bounds do not compare exactly; 0.01 Ma is well
# below the resolution of any PBDB interval.
LAYOUT_TOLERANCE_MA = 0.01

PBDB_SINGLE = "https://paleobiodb.org/data1.2/taxa/list.json"

# --- measured baselines -------------------------------------------------------

EXPECT_ROWS = 523_112
EXPECT_WITH_INTERVAL = 411_039  # rows carrying a first-appearance bound
MIN_INTERVAL_PCT = 78.0
EXPECT_ACCEPTED_DIFFERS = 52_595  # 10.1%
EXPECT_EXTANT_UNKNOWN = 9_059  # 1.7%, genuinely unknown rather than false
EXPECT_UNMATCHABLE_RANK = 32_629  # at ranks GBIF's backbone cannot express

# The PBDB ranks that survive translation to GBIF's backbone; everything else is
# unmatchable by construction, which is why the parent-walk exists.
GBIF_EXPRESSIBLE_RANKS = frozenset(
    {"species", "genus", "family", "subspecies", "order", "class", "phylum", "kingdom"}
)

# The occurrence tier's size — a floor, not an equality. It guards against a
# regression (an upstream refusal quietly emptying the tier); a few dozen rows
# moving because PBDB published is not a bug and must not block a build.
MIN_OCCURRENCE_NODES = 2_000

# Accepted taxa the tree holds under a name PBDB files on a second `taxon_no` —
# see `under_accepted_name`. 6,271 of them are the accepted record itself, which
# is the row `is_primary` picks and search serves.
EXPECT_UNDER_ACCEPTED_NAME = 37_720

SPOT_TYRANNOSAURUS = 38613
SPOT_AUBLYSODON = 38614
# The accepted record, entered as *Pithecanthropus erectus*. The current
# combination *Homo erectus* is taxon 376854 and is what resolves by name.
SPOT_HOMO_ERECTUS = 83084
# Dinosauria is not a node in the synthesis tree, so the containment test uses
# the deepest named ancestor that is — a strictly stronger claim.
SPOT_CONTAINER = "Tyrannosauridae"
SPOT_APPEARANCE = (83.6, 72.2, 72.2, 66.0)

ORACLE_SAMPLE = 40
ORACLE_SEED = 20_260_731
ORACLE_MIN_AGREEMENT = 95.0

# --- attachment provenance ----------------------------------------------------
# Dictionary-encoded. Code 0 is the terminal fallback: the root, where a taxon
# lands when nothing on its parent chain resolved.
ATTACH_ROOT = 0
ATTACH_METHOD_CODE: dict[str, int] = {"root_fallback": ATTACH_ROOT} | {
    m: i for i, m in enumerate(METHOD_ORDER, start=1)
}
ATTACH_METHOD_NAME = {v: k for k, v in ATTACH_METHOD_CODE.items()}

MAX_WALK = 64  # PBDB's deepest classification chain is far shorter; a guard


class Attachment(NamedTuple):
    idx: int
    method: int
    walk: int
    via: int | None  # the PBDB taxon_no that actually resolved


class FossilRow(NamedTuple):
    pbdb_taxon_no: int
    pbdb_orig_no: int
    accepted_no: int
    name: str
    rank: str | None
    own_name: str
    own_rank: str | None
    difference: str | None
    is_primary: int
    attach_idx: int
    attach_method: int
    attach_walk: int
    attach_via: int | None
    fea: float | None
    fla: float | None
    lea: float | None
    lla: float | None
    n_occs: int
    is_extant: int | None
    # The identified young end, occurrences at it, and where this taxon may be
    # drawn — see `young_ends`. `lla_identified > lla` is the exact unwitnessed
    # test; `lla_drawn != lla` says the clamp fired.
    lla_identified: float | None
    young_end_occs: int
    lla_drawn: float | None
    lea_drawn: float | None


def load_xref_pbdb(con: sqlite3.Connection) -> dict[int, tuple[int, int]]:
    """`taxon_no → (idx, attach_method_code)` for every PBDB id phase 3 resolved."""
    out: dict[int, tuple[int, int]] = {}
    for source_id, idx, method in con.execute(
        "SELECT source_id, idx, method FROM xref WHERE source = 'pbdb' AND idx IS NOT NULL"
    ):
        code = ATTACH_METHOD_CODE.get(method)
        if code is None:  # a method this phase does not know about
            continue
        out[int(source_id)] = (int(idx), code)
    return out


def under_accepted_name(
    taxa: Sequence[PbdbTaxon], resolved: dict[int, tuple[int, int]]
) -> dict[int, int]:
    """`accepted_no → taxon_no` of a resolved row spelling out the accepted name.

    PBDB enters a recombination under a `taxon_no` of its own and leaves the
    accepted record under the original combination: *Homo erectus* is taxon
    376854, while accepted taxon 83084 is *Pithecanthropus erectus* (same
    `orig_no`, same animal). Phase 3's `name_exact` reads `taxon_name`, so only
    376854 reaches the tree's own *Homo erectus* node — and the accepted record,
    the one `is_primary` picks and search and the lane serve, walked up to the
    genus. `attach_walk` then said 1 for a taxon the tree holds exactly, so
    `notInTree` did not refuse it and the same animal arrived twice: once as a
    node, once as a fossil to graft below *Homo*.

    **Only a row whose own name IS the accepted name qualifies.** Grouping on
    `accepted_no` alone would hand a class its synonym's node — PBDB files the
    radiolarian genus *Cenellipsis* under accepted name *Radiolaria*, and OTT has
    a *Cenellipsis*, so *Radiolaria* would attach inside one of its own genera.
    Name equality is the whole claim: this row is the accepted taxon, written
    the way the tree writes it.

    Where several rows qualify, the strongest method wins (`METHOD_ORDER`, via
    `ATTACH_METHOD_CODE`), then the lowest `taxon_no` — deterministic, though no
    accepted taxon in the pinned snapshot has two such rows disagreeing on a
    node.
    """
    best: dict[int, tuple[int, int]] = {}  # accepted_no -> (method code, taxon_no)
    for t in taxa:
        if t.name != t.accepted_name:
            continue
        hit = resolved.get(t.taxon_no)
        if hit is None:
            continue
        accepted = t.accepted_no or t.taxon_no
        key = (hit[1], t.taxon_no)
        current = best.get(accepted)
        if current is None or key < current:
            best[accepted] = key
    return {accepted: taxon_no for accepted, (_method, taxon_no) in best.items()}


class Attacher:
    """Walks PBDB's `parent_no` chain to the deepest node the tree has.

    Memoised per `taxon_no`: the chain above a genus is shared by every species
    in it.
    """

    __slots__ = ("_memo", "by_accepted_name", "parent_of", "resolved")

    def __init__(
        self,
        resolved: dict[int, tuple[int, int]],
        parent_of: dict[int, int],
        by_accepted_name: dict[int, int] | None = None,
    ) -> None:
        self.resolved = resolved
        self.parent_of = parent_of
        self.by_accepted_name = by_accepted_name or {}
        self._memo: dict[int, Attachment] = {}

    def _hit(self, taxon_no: int) -> tuple[int, int, int] | None:
        """`(idx, method, via)` where this PBDB taxon reaches the tree, or None.

        Two ways to be the taxon itself, and neither is a `parent_no` hop: the
        record resolved, or a row spelling out its accepted name did — see
        `under_accepted_name`. Consulted inside the walk as well as at its start,
        so a child of a recombined taxon stops at it rather than climbing past.
        """
        r = self.resolved.get(taxon_no)
        if r is not None:
            return r[0], r[1], taxon_no
        via = self.by_accepted_name.get(taxon_no)
        if via is None:
            return None
        r = self.resolved[via]
        return r[0], r[1], via

    def _from(self, start: int) -> Attachment:
        cached = self._memo.get(start)
        if cached is not None:
            return cached

        chain: list[int] = []
        cur = start
        seen: set[int] = set()
        found: Attachment | None = None
        while cur and cur not in seen and len(chain) < MAX_WALK:
            hit = self._hit(cur)
            if hit is not None:
                found = Attachment(hit[0], hit[1], len(chain), hit[2])
                break
            seen.add(cur)
            chain.append(cur)
            cur = self.parent_of.get(cur, 0)

        if found is None:
            found = Attachment(ROOT_IDX, ATTACH_ROOT, len(chain), None)

        # Memoise every taxon on the chain, each with its own walk length.
        for hops, node in enumerate(chain):
            self._memo[node] = Attachment(
                found.idx, found.method, found.walk - hops, found.via
            )
        self._memo[start] = found
        return found

    def attach(self, t: PbdbTaxon) -> Attachment:
        """Resolve the record itself first, then its accepted taxon's chain.

        `walk` counts genuine `parent_no` hops, so a synonym resolving through
        its own accepted taxon is still walk 0 — both are "the taxon itself".
        """
        own = self._hit(t.taxon_no)
        if own is not None:
            return Attachment(own[0], own[1], 0, own[2])
        return self._from(t.accepted_no or t.taxon_no)


# --- the unwitnessed young end ------------------------------------------------
#
# PBDB's `lastapp_min_ma` aggregates a taxon's whole subtree. When a taxon's
# young end is younger than every one of its descendants', that end rests only on
# material catalogued no finer than the taxon itself (an "sp." or "indet.") — an
# exact, structural test. Left alone, *Stegosaurus* draws in the Cenomanian,
# 50 Myr after the animal.
#
# Detecting it is exact; correcting it is not. Moving the drawn position needs
# the identified young end to be worth trusting, and two things spoil it:
#   - Form/ichno taxa (PBDB `I`/`F`): a genus-level id is the finest that exists,
#     so their own young end is real.
#   - Sparse linkage: *Tasmanites*'s only species-level record is Proterozoic,
#     so clamping would be a ~1,595 Myr error.
# The share identified to species does not separate these; corroboration at the
# identified end (how many occurrences sit there) does — hence
# `MIN_YOUNG_END_OCCS`, a threshold on whether to act, falling back to PBDB's
# own number rather than a worse one.
MIN_YOUNG_END_OCCS = 5

# PBDB `flags`: `I` ichnotaxon, `F` form taxon; only these two matter here.
FORM_TAXON_FLAGS = frozenset("IF")

# --- measured baselines -------------------------------------------------------
EXPECT_UNWITNESSED = 10_655  # accepted taxa whose young end no descendant reaches
EXPECT_CLAMPED = 4_819  # of those, the ones the drawn position moves for
# PBDB's aggregate is not monotone (a child reaching younger than its parent);
# not zero, which the first version of this gate wrongly assumed.
EXPECT_NON_MONOTONE = 440

# Pinned by PBDB id because names are not unique.
SPOT_STEGOSAURUS = 38814
SPOT_STEGOSAURUS_LLA = 93.9  # PBDB's own, kept
SPOT_STEGOSAURUS_DRAWN = 143.1  # where the named animal's record actually ends
# The guard case: an identified young end on one occurrence, where clamping
# would be worse than leaving it alone.
SPOT_TASMANITES = 264674


class YoungEnd(NamedTuple):
    """What a taxon's last-appearance young end is worth, and where to draw it.

    - `identified` — youngest last appearance any identified member reaches;
      `None` where nothing below carries a bracket. `identified > lla` is the
      exact test for an unwitnessed young end.
    - `occs` — occurrences sitting at `identified`; separates *Stegosaurus* from
      *Tasmanites*.
    - `drawn` — where the taxon may be drawn: `lla` except where the clamp fires.
    - `identified_lea` / `drawn_lea` — the older end of the same `[lea, lla]`
      bracket, moved as a pair with `drawn` since both ends share occurrences.
    """

    identified: float | None
    identified_lea: float | None
    occs: int
    drawn: float | None
    drawn_lea: float | None
    clamped: bool


def young_ends(taxa: Sequence[PbdbTaxon]) -> tuple[dict[int, YoungEnd], JsonDict]:
    """Per accepted taxon, whether its young end is witnessed and where to draw it.

    Two linear reverse passes over PBDB's `parent_no` hierarchy: youngest last
    appearance among descendants, then the occurrences at it. Keyed on accepted
    taxa only, so a synonym is not its own descendant.
    """
    lla: dict[int, float] = {}
    lea: dict[int, float] = {}
    fea: dict[int, float] = {}
    occs: dict[int, int] = {}
    flags: dict[int, str] = {}
    parent: dict[int, int] = {}
    for t in taxa:
        accepted = t.accepted_no or t.taxon_no
        if t.taxon_no != accepted:
            continue
        if t.lla is not None:
            lla[t.taxon_no] = t.lla
        if t.lea is not None:
            lea[t.taxon_no] = t.lea
        if t.fea is not None:
            fea[t.taxon_no] = t.fea
        occs[t.taxon_no] = t.n_occs
        flags[t.taxon_no] = t.flags
        parent[t.taxon_no] = t.parent_no

    kids: dict[int, list[int]] = {}
    for child, p in parent.items():
        if p and p != child and p in parent:
            kids.setdefault(p, []).append(child)

    # Preorder from the roots. Every taxon has one parent and is pushed only by
    # it, so a parent is always appended before its children and one reverse
    # pass sees children first. Taxa in a `parent_no` cycle are never reached
    # and get no verdict, which is the safe direction; the count is a gate.
    order: list[int] = []
    seen: set[int] = set()
    stack = [t for t, p in parent.items() if not p or p == t or p not in parent]
    while stack:
        cur = stack.pop()
        if cur in seen:
            continue
        seen.add(cur)
        order.append(cur)
        stack.extend(kids.get(cur, ()))

    # Occurrences identified exactly at a taxon rather than below it. `n_occs`
    # is a subtree total, so subtract to avoid counting a genus once for itself
    # and again for each species in it.
    own_occs = {
        t: max(0, occs.get(t, 0) - sum(occs.get(c, 0) for c in kids.get(t, ())))
        for t in parent
    }

    # One reverse pass, so a parent reads its children's corrected positions and
    # the correction carries up (else the fix is defeated one rank up).
    # `sub_min`/`sub_at` are about the subtree; `identified`/`drawn` about the
    # taxon itself.
    out: dict[int, YoungEnd] = {}
    sub_min: dict[int, float] = {}
    sub_lea: dict[int, float | None] = {}
    sub_at: dict[int, int] = {}
    unwitnessed_n = refused_form = refused_sparse = inverted = 0
    refused_form_ok = refused_contradiction = 0
    for cur in reversed(order):
        child_mins = [sub_min[c] for c in kids.get(cur, ()) if c in sub_min]
        end = min(child_mins) if child_mins else None
        # The pair, not just the young end: `[lea, lla]` is one bracket sharing
        # occurrences, so adopt the identified member's whole last-appearance
        # bracket rather than correcting `lla` alone.
        end_lea = next(
            (
                sub_lea.get(c)
                for c in kids.get(cur, ())
                if sub_min.get(c) == end and sub_lea.get(c) is not None
            ),
            None,
        )
        n_at = (
            sum(sub_at.get(c, 0) for c in kids.get(cur, ()) if sub_min.get(c) == end)
            if end is not None
            else 0
        )
        own = lla.get(cur)
        # PBDB's aggregate is not monotone (a child can reach younger than its
        # parent). Nothing here depends on monotonicity — the test only fires
        # when the identified end is older — but count it; assuming zero is the
        # bug this gate caught.
        if own is not None and end is not None and end < own:
            inverted += 1
        unwitnessed = own is not None and end is not None and end > own
        is_form = bool(FORM_TAXON_FLAGS & set(flags.get(cur, "")))
        # A clamp may never put a taxon older than its own first appearance,
        # which keeps the invariant `lla <= lla_drawn <= fea`.
        contradicts = end is not None and cur in fea and end > fea[cur]
        clamped = (
            unwitnessed
            and not is_form
            and not contradicts
            and n_at >= MIN_YOUNG_END_OCCS
        )
        if unwitnessed:
            unwitnessed_n += 1
            if is_form:
                refused_form += 1
                if n_at >= MIN_YOUNG_END_OCCS:
                    # Corroborated but refused because it is an ichno/form taxon.
                    refused_form_ok += 1
            elif contradicts:
                refused_contradiction += 1
            elif n_at < MIN_YOUNG_END_OCCS:
                refused_sparse += 1
        drawn = end if clamped else own
        out[cur] = YoungEnd(
            identified=end,
            identified_lea=end_lea,
            occs=n_at,
            drawn=drawn,
            drawn_lea=end_lea if clamped else lea.get(cur),
            clamped=clamped,
        )

        here = [v for v in (drawn, end) if v is not None]
        if here:
            m = min(here)
            sub_min[cur] = m
            # The lea of whichever end won, so a parent inherits the pair intact.
            sub_lea[cur] = (
                (end_lea if clamped else lea.get(cur)) if drawn == m else end_lea
            )
            sub_at[cur] = (own_occs[cur] if drawn == m else 0) + sum(
                sub_at.get(c, 0) for c in kids.get(cur, ()) if sub_min.get(c) == m
            )

    stats: JsonDict = {
        "accepted": len(parent),
        "unreached": len(parent) - len(seen),
        "unwitnessed": unwitnessed_n,
        "clamped": sum(1 for ye in out.values() if ye.clamped),
        # Why the rest were left alone: form/ichno taxa vs sparse linkage.
        "refused_form": refused_form,
        "refused_form_corroborated": refused_form_ok,
        "refused_sparse": refused_sparse,
        "refused_contradiction": refused_contradiction,
        # PBDB's aggregate read the other way — recorded, never acted on.
        "non_monotone": inverted,
    }
    return out, stats


def _drawn_for(t: PbdbTaxon, ye: YoungEnd | None) -> float | None:
    """Where one row may be drawn, holding `lla <= lla_drawn <= fea`.

    The accepted taxon decides whether to move; this decides whether this row
    can follow it there, tested against this row's own bounds because PBDB lets
    them differ from the accepted taxon's in both directions (a clamp too old for
    a narrow-bracket synonym, or too young for a living genus whose synonym is a
    fossil). Either way the row keeps PBDB's own number.
    """
    if ye is None or not ye.clamped or ye.identified is None:
        return t.lla
    if t.lla is not None and ye.identified < t.lla:
        return t.lla
    if t.fea is not None and ye.identified > t.fea:
        return t.lla
    return ye.identified


def _lea_drawn_for(t: PbdbTaxon, ye: YoungEnd | None) -> float | None:
    """The older end of the last-appearance bracket, moved only when `lla` was.

    Held to `lla_drawn <= lea_drawn <= fea` so the pair stays a bracket.
    """
    if ye is None or not ye.clamped or _drawn_for(t, ye) != ye.identified:
        return t.lea
    candidate = ye.drawn_lea
    if candidate is None:
        return t.lea
    low = ye.identified if ye.identified is not None else candidate
    if candidate < low:
        return low
    if t.fea is not None and candidate > t.fea:
        return t.fea
    return candidate


def build_rows(
    taxa: Sequence[PbdbTaxon],
    attacher: Attacher,
    ends: dict[int, YoungEnd] | None = None,
) -> tuple[list[FossilRow], Counter[int], Counter[int]]:
    rows: list[FossilRow] = []
    walks: Counter[int] = Counter()
    methods: Counter[int] = Counter()
    ends = ends or {}
    for t in taxa:
        a = attacher.attach(t)
        walks[a.walk] += 1
        methods[a.method] += 1
        # The verdict belongs to the accepted taxon; a synonym inherits it, but
        # the bounds are the row's own (they can be narrower), so the invariant
        # `lla <= lla_drawn <= fea` is enforced per row.
        ye = ends.get(t.accepted_no or t.taxon_no)
        rows.append(
            FossilRow(
                pbdb_taxon_no=t.taxon_no,
                pbdb_orig_no=t.orig_no,
                accepted_no=t.accepted_no or t.taxon_no,
                # Display the accepted name/rank; keep the record's own beside it.
                name=t.accepted_name or t.name,
                rank=t.accepted_rank or None,
                own_name=t.name,
                own_rank=t.rank or None,
                difference=t.difference or None,
                is_primary=int(t.taxon_no == t.accepted_no),
                attach_idx=a.idx,
                attach_method=a.method,
                attach_walk=a.walk,
                attach_via=a.via,
                fea=t.fea,
                fla=t.fla,
                lea=t.lea,
                lla=t.lla,
                n_occs=t.n_occs,
                is_extant=t.is_extant,
                lla_identified=ye.identified if ye else None,
                young_end_occs=ye.occs if ye else 0,
                lla_drawn=_drawn_for(t, ye),
                lea_drawn=_lea_drawn_for(t, ye),
            )
        )
    return rows, walks, methods


def write_db(con: sqlite3.Connection, rows: Sequence[FossilRow]) -> None:
    con.executescript(
        """
        DROP TABLE IF EXISTS fossil;
        DROP TABLE IF EXISTS fossil_attach_method;

        -- Keyed on `taxon_no`, not `orig_no`: `orig_no` is not unique, while
        -- `taxon_no` is and is what `parent_no`/`accepted_no`/GBIF's `sourceId`
        -- reference. `orig_no` is kept as a column.
        CREATE TABLE fossil (
          pbdb_taxon_no INTEGER PRIMARY KEY,
          pbdb_orig_no  INTEGER NOT NULL,
          accepted_no   INTEGER NOT NULL,
          name          TEXT NOT NULL,     -- accepted_name
          rank          TEXT,              -- accepted_rank
          own_name      TEXT NOT NULL,
          own_rank      TEXT,              -- may differ in rank, not just name
          difference    TEXT,              -- 'nomen dubium', 'subjective synonym of', …
          is_primary    INTEGER NOT NULL,  -- taxon_no == accepted_no
          attach_idx    INTEGER NOT NULL,
          attach_method INTEGER NOT NULL,
          attach_walk   INTEGER NOT NULL,  -- parent_no hops taken
          attach_via    INTEGER,           -- the PBDB taxon that resolved
          fea REAL, fla REAL, lea REAL, lla REAL,   -- two brackets, uncollapsed
          n_occs        INTEGER NOT NULL,
          is_extant     INTEGER,           -- nullable: 1.7% genuinely unknown

          -- The young end of the last-appearance bracket, read for what it is
          -- worth. `lla` stays PBDB's own number and is never overwritten.
          --   lla_identified  youngest last appearance an identified member
          --                   reaches; NULL where nothing below carries one.
          --   young_end_occs  occurrences sitting at `lla_identified`.
          --   lla_drawn       where the taxon may be drawn (see `young_ends`).
          --   lea_drawn       the other end of the same bracket, moved with it.
          lla_identified REAL,
          young_end_occs INTEGER NOT NULL DEFAULT 0,
          lla_drawn      REAL,
          lea_drawn      REAL
        );

        CREATE TABLE fossil_attach_method (
          code INTEGER PRIMARY KEY,
          name TEXT NOT NULL
        );
        """
    )
    con.executemany(
        "INSERT INTO fossil VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
        rows,
    )
    con.executemany(
        "INSERT INTO fossil_attach_method VALUES (?,?)",
        sorted(ATTACH_METHOD_NAME.items()),
    )
    con.executescript(
        """
        CREATE INDEX fossil_attach ON fossil(attach_idx, n_occs DESC);
        CREATE INDEX fossil_accepted ON fossil(accepted_no);
        """
    )
    con.commit()


def oracle_appearances(
    rows: Sequence[FossilRow], *, samples: int = ORACLE_SAMPLE, log: Log = print
) -> JsonDict:
    """Check baked appearance bounds against PBDB's live API.

    A handful of requests, catching a snapshot that has drifted from its source.
    """
    rng = random.Random(ORACLE_SEED)
    pool = [r for r in rows if r.fea is not None and r.n_occs > 0]
    picked = rng.sample(pool, k=min(samples, len(pool)))
    ids = ",".join(f"txn:{r.pbdb_taxon_no}" for r in picked)
    with httpx.Client(
        headers={"User-Agent": USER_AGENT}, timeout=httpx.Timeout(60.0, connect=30.0)
    ) as client:
        r = client.get(PBDB_SINGLE, params={"taxon_id": ids, "show": "app"})
        r.raise_for_status()
        live = {
            int(rec["oid"].removeprefix("txn:")): rec for rec in r.json()["records"]
        }

    compared = agreed = 0
    disagreements: list[JsonDict] = []
    for row in picked:
        rec = live.get(row.pbdb_taxon_no)
        if rec is None:
            continue
        compared += 1
        ours = (row.fea, row.fla, row.lea, row.lla)
        theirs = tuple(rec.get(k) for k in ("fea", "fla", "lea", "lla"))
        if all(
            a is not None and b is not None and abs(a - b) < 1e-6
            for a, b in zip(ours, theirs, strict=True)
        ):
            agreed += 1
        else:
            disagreements.append(
                {"taxon_no": row.pbdb_taxon_no, "ours": ours, "live": theirs}
            )
    log(f"  oracle: {agreed}/{compared} appearance brackets agree with live PBDB")
    return {
        "sampled": len(picked),
        "compared": compared,
        "agreed": agreed,
        "disagreements": disagreements[:10],
    }


def _subtree_container(con: sqlite3.Connection, name: str) -> tuple[int, int] | None:
    row = con.execute(
        "SELECT idx FROM node WHERE name = ? ORDER BY tip_count DESC LIMIT 1", (name,)
    ).fetchone()
    if row is None:
        return None
    idx = int(row[0])
    subtree_out: U32Array = np.load(TOPOLOGY / "subtree_out.npy")
    return idx, int(subtree_out[idx])


def _histogram(counter: Counter[int], top: int = 12) -> str:
    total = sum(counter.values())
    parts = [
        f"{k}:{v:,} ({100 * v / total:.1f}%)" for k, v in sorted(counter.items())[:top]
    ]
    if len(counter) > top:
        parts.append("…")
    return " · ".join(parts)


def _median(counter: Counter[int]) -> float:
    total = sum(counter.values())
    if not total:
        return 0.0
    half = total / 2
    seen = 0
    for k in sorted(counter):
        seen += counter[k]
        if seen >= half:
            return float(k)
    return float(max(counter))


def _iter_depths(rows: Sequence[FossilRow], depth: U32Array) -> Iterator[int]:
    for r in rows:
        yield int(depth[r.attach_idx])


def run(use_api: bool = True) -> int:
    g = GateSet("phase4-fossils")
    BUILD.mkdir(parents=True, exist_ok=True)

    con = connect()
    if not table_exists(con, "xref"):
        raise SystemExit("phase 4 needs phase 3's xref table — run `resolve` first")

    print("--- loading pbdb_taxa.csv and xref ---", flush=True)
    taxa = load_pbdb_taxa()
    g.require("pbdb_taxa.csv rows", len(taxa), EXPECT_ROWS)

    resolved = load_xref_pbdb(con)
    g.observe(
        "PBDB taxa carrying an xref resolution",
        f"{len(resolved):,} ({100 * len(resolved) / len(taxa):.2f}%)",
    )

    parent_of = {t.taxon_no: t.parent_no for t in taxa}
    by_accepted_name = under_accepted_name(taxa, resolved)
    attacher = Attacher(resolved, parent_of, by_accepted_name)

    print("--- reading the last-appearance young ends ---", flush=True)
    ends, end_stats = young_ends(taxa)
    print(
        f"  {end_stats['unwitnessed']:,} unwitnessed, {end_stats['clamped']:,} clamped",
        flush=True,
    )

    print("--- attaching ---", flush=True)
    t0 = time.monotonic()
    rows, walks, methods = build_rows(taxa, attacher, ends)
    print(f"  {len(rows):,} rows in {time.monotonic() - t0:,.1f}s", flush=True)

    print("--- writing fossil ---", flush=True)
    write_db(con, rows)

    # --- structural gates -----------------------------------------------------
    print("\n--- structural gates ---", flush=True)
    n_rows = con.execute("SELECT count(*) FROM fossil").fetchone()[0]
    g.require("fossil rows", n_rows, EXPECT_ROWS)
    g.require(
        "rows whose attach_idx is not a node",
        con.execute(
            "SELECT count(*) FROM fossil LEFT JOIN node ON node.idx = fossil.attach_idx "
            "WHERE node.idx IS NULL"
        ).fetchone()[0],
        0,
    )
    g.require(
        "rows whose attach_method is outside the dictionary",
        con.execute(
            "SELECT count(*) FROM fossil WHERE attach_method NOT IN "
            "(SELECT code FROM fossil_attach_method)"
        ).fetchone()[0],
        0,
    )
    g.require(
        "records whose accepted_no differs from orig_no",
        con.execute(
            "SELECT count(*) FROM fossil WHERE accepted_no != pbdb_orig_no"
        ).fetchone()[0],
        EXPECT_ACCEPTED_DIFFERS,
        note="10.1% — the reason the table keys on accepted_no and displays "
        "accepted_name.",
    )

    # --- content gates: every column below is read by a downstream consumer ---
    print("\n--- content gates ---", flush=True)
    with_interval = con.execute(
        "SELECT count(*) FROM fossil WHERE fea IS NOT NULL"
    ).fetchone()[0]
    pct = 100 * with_interval / n_rows
    g.require(
        "rows carrying an appearance interval",
        f"{pct:.2f}% ({with_interval:,}/{n_rows:,})",
        f"≥ {MIN_INTERVAL_PCT}% (baseline {EXPECT_WITH_INTERVAL:,} = 78.58%)",
        ok=pct >= MIN_INTERVAL_PCT,
    )
    missing_with_occs = con.execute(
        "SELECT count(*) FROM fossil WHERE fea IS NULL AND n_occs > 0"
    ).fetchone()[0]
    g.observe(
        "rows with no interval despite n_occs > 0",
        missing_with_occs,
        0,
        note="ingest.md says the missing set is *exactly* the n_occs = 0 rows. "
        "Containment holds — all 111,864 zero-occurrence rows lack an interval "
        "— but the missing set is 112,073, so 209 rows have occurrences and no "
        "bounds. (111,864 rather than 111,848 because 16 rows carry an empty "
        "n_occs field rather than a zero.)",
    )
    g.require(
        "rows carrying all four bounds where any is present",
        con.execute(
            "SELECT count(*) FROM fossil WHERE fea IS NOT NULL AND "
            "(fla IS NULL OR lea IS NULL OR lla IS NULL)"
        ).fetchone()[0],
        424,
        note="fea/fla and lea/lla are two brackets; 424 rows carry a first "
        "appearance without a last. They must not be collapsed or invented.",
    )
    g.require(
        "is_extant NULL — genuinely unknown, not false",
        con.execute("SELECT count(*) FROM fossil WHERE is_extant IS NULL").fetchone()[
            0
        ],
        EXPECT_EXTANT_UNKNOWN,
    )
    g.observe(
        "rows where the accepted rank differs from the record's own",
        con.execute(
            "SELECT count(*) FROM fossil WHERE own_rank IS NOT rank"
        ).fetchone()[0],
        note="the count is the point, not a threshold — see the Aublysodon "
        "spot check. Grouping by taxon_rank on the assumption it survives "
        "resolution is the bug this column exists to make visible.",
    )
    unmatchable = sum(1 for t in taxa if t.rank not in GBIF_EXPRESSIBLE_RANKS)
    g.require(
        "PBDB taxa at ranks GBIF's backbone cannot express",
        unmatchable,
        EXPECT_UNMATCHABLE_RANK,
        note="6.2%, unmatchable rather than unmatched. The parent-walk is what "
        "handles them.",
    )

    # --- the unwitnessed young end --------------------------------------------
    print("\n--- young ends ---", flush=True)
    g.require(
        "accepted taxa whose young end no identified member reaches",
        end_stats["unwitnessed"],
        EXPECT_UNWITNESSED,
        note="structural and exact: PBDB aggregates upward, so a young end "
        "below every descendant's can only rest on `sp.`/`indet.` material.",
    )
    g.require(
        "of those, the ones the drawn position moves for",
        end_stats["clamped"],
        EXPECT_CLAMPED,
        note=f"the rest keep PBDB's own number — refusing to act falls back to "
        f"the status quo. Held back by an I/F flag (a genus-level id is the "
        f"finest that exists for an ichnotaxon) or by fewer than "
        f"{MIN_YOUNG_END_OCCS} occurrences at the identified end.",
    )
    g.require(
        "taxa whose identified end is younger than their own",
        end_stats["non_monotone"],
        EXPECT_NON_MONOTONE,
        note="PBDB's aggregate is not monotone — *Planolites montanus* reaches "
        "66.0 Ma under a genus PBDB stops at 468.0. Nothing acts on these; the "
        "test only fires when the identified end is older. Pinned because the "
        "first version of this gate assumed the count was zero.",
    )
    g.observe(
        "accepted taxa unreachable from a root (parent_no cycles)",
        end_stats["unreached"],
        0,
        note="a taxon in a cycle gets no verdict, which is the safe direction.",
    )
    g.require(
        "primary rows left unclamped despite a corroborated alternative",
        con.execute(
            "SELECT count(*) FROM fossil WHERE is_primary = 1 "
            "AND lla_identified IS NOT NULL AND lla IS NOT NULL "
            "AND lla_identified > lla AND lla_drawn = lla AND young_end_occs >= ?",
            (MIN_YOUNG_END_OCCS,),
        ).fetchone()[0],
        end_stats["refused_form_corroborated"],
        note="the ichnotaxon refusal, and it must be the *only* thing leaving "
        "a corroborated alternative unused. Any excess is a row that lost its "
        "clamp somewhere between the computation and the table.",
    )
    g.require(
        "rows drawn outside their own appearance bracket",
        con.execute(
            "SELECT count(*) FROM fossil WHERE lla_drawn IS NOT NULL AND "
            "((lla IS NOT NULL AND lla_drawn < lla) OR "
            " (fea IS NOT NULL AND lla_drawn > fea))"
        ).fetchone()[0],
        0,
        note="`lla <= lla_drawn <= fea`. A graft draws its glyph at "
        "`lla_drawn` and its bracket from the four bounds, so a position "
        "outside them puts the picture beside the evidence rather than on it.",
    )
    g.require(
        "rows whose drawn last-appearance bracket is inverted",
        con.execute(
            "SELECT count(*) FROM fossil WHERE lea_drawn IS NOT NULL "
            "AND lla_drawn IS NOT NULL AND lea_drawn < lla_drawn"
        ).fetchone()[0],
        0,
        note="`[lea_drawn, lla_drawn]` is still a bracket and still reads "
        "old-to-young. Correcting one end and not the other is the bug this "
        "catches: Stegosaurus' `lea` of 100.5 is the same Cenomanian "
        "occurrence as its `lla` of 93.9, so moving `lla` alone would have "
        "left half of the refused record in place.",
    )
    g.require(
        "rows whose young end moved without its partner",
        con.execute(
            "SELECT count(*) FROM fossil WHERE lla_drawn != lla "
            "AND lea IS NOT NULL AND lea_drawn = lea AND lea < lla_drawn"
        ).fetchone()[0],
        0,
        note="the pair moves together or not at all.",
    )
    g.observe(
        "unwitnessed young ends left alone, by reason",
        f"{end_stats['refused_form']:,} ichno/form taxon, "
        f"{end_stats['refused_sparse']:,} under {MIN_YOUNG_END_OCCS} occurrences, "
        f"{end_stats['refused_contradiction']:,} contradicting their own fea",
    )
    steg = con.execute(
        "SELECT lla, lla_identified, lla_drawn, young_end_occs FROM fossil "
        "WHERE pbdb_taxon_no = ?",
        (SPOT_STEGOSAURUS,),
    ).fetchone()
    g.require(
        "Stegosaurus keeps PBDB's 93.9 and is drawn at 143.1",
        None if steg is None else tuple(steg),
        (SPOT_STEGOSAURUS_LLA, SPOT_STEGOSAURUS_DRAWN, SPOT_STEGOSAURUS_DRAWN, 18),
        ok=steg is not None
        and steg[0] == SPOT_STEGOSAURUS_LLA
        and steg[2] == SPOT_STEGOSAURUS_DRAWN,
        note="one `Stegosaurus sp.` from the Mussentuchit Member carried the "
        "genus 50 Myr into the Cenomanian. `lla` is untouched; only the "
        "position moves.",
    )
    tas = con.execute(
        "SELECT lla, lla_identified, lla_drawn, young_end_occs FROM fossil "
        "WHERE pbdb_taxon_no = ?",
        (SPOT_TASMANITES,),
    ).fetchone()
    g.require(
        "Tasmanites is left alone — its alternative rests on one occurrence",
        None if tas is None else tuple(tas),
        "lla_drawn == lla",
        ok=tas is not None and tas[2] == tas[0],
        note="56 occurrences, two species entered, one of them with a single "
        "Proterozoic record. Clamping would be a 1,595 Myr error.",
    )

    # --- attachment quality ---------------------------------------------------
    print("\n--- attachment ---", flush=True)
    depth: U32Array = np.load(TOPOLOGY / "depth.npy")
    depths: Counter[int] = Counter(_iter_depths(rows, depth))
    median_depth = _median(depths)
    median_walk = _median(walks)

    g.observe("attachment depth distribution", _histogram(depths, top=16))
    g.observe("attachment depth — median", median_depth)
    g.observe("parent-walk length distribution", _histogram(walks, top=16))
    g.observe("parent-walk length — median", median_walk)
    g.observe(
        "attachment provenance",
        " · ".join(
            f"{ATTACH_METHOD_NAME[k]} {v:,}" for k, v in sorted(methods.items())
        ),
    )

    top_points = con.execute(
        "SELECT f.attach_idx, n.name, n.depth, count(*) c FROM fossil f "
        "JOIN node n ON n.idx = f.attach_idx GROUP BY f.attach_idx "
        "ORDER BY c DESC LIMIT 12"
    ).fetchall()
    g.observe(
        "busiest attachment points",
        " · ".join(f"{name or key}({d}) {c:,}" for key, name, d, c in top_points),
    )

    at_root = con.execute(
        "SELECT count(*) FROM fossil WHERE attach_idx = ?", (ROOT_IDX,)
    ).fetchone()[0]
    g.observe(
        "fossils falling back to the root",
        f"{at_root:,} ({100 * at_root / n_rows:.1f}%)",
        note="every fossil attaches somewhere; the root is the terminal "
        "fallback. Everything landing at Eukaryota means the chain is broken.",
    )

    # --- the taxon the tree already holds -------------------------------------
    g.require(
        "accepted taxa reached through a row spelling out their accepted name",
        len(by_accepted_name),
        EXPECT_UNDER_ACCEPTED_NAME,
        note="see `under_accepted_name`. PBDB enters a recombination under a "
        "`taxon_no` of its own and leaves the accepted record under the "
        "original combination, and phase 3's `name_exact` reads `taxon_name`.",
    )
    g.require(
        "accepted records the tree holds exactly, still walking to an ancestor",
        con.execute(
            "SELECT count(*) FROM fossil f WHERE f.is_primary = 1 "
            "AND f.attach_walk != 0 AND EXISTS ("
            "  SELECT 1 FROM fossil d WHERE d.accepted_no = f.accepted_no "
            "  AND d.own_name = d.name AND d.attach_walk = 0)"
        ).fetchone()[0],
        0,
        note="the rule §9 of fossil-grafts.md states from the other end: a "
        "fossil row is a taxon the tree does not contain. `notInTree` refuses "
        "`attach_walk = 0`, so a taxon the tree holds under a name PBDB files "
        "on a second `taxon_no` used to pass the filter and arrive twice — "
        "6,271 of them, *Homo erectus* among them.",
    )
    he = con.execute(
        "SELECT f.attach_walk, n.name FROM fossil f JOIN node n ON n.idx = f.attach_idx "
        "WHERE f.pbdb_taxon_no = ?",
        (SPOT_HOMO_ERECTUS,),
    ).fetchone()
    g.require(
        "spot check — the accepted *Homo erectus* record attaches to its node",
        None if he is None else tuple(he),
        (0, "Homo erectus"),
        ok=he is not None and tuple(he) == (0, "Homo erectus"),
        note="PBDB's accepted record for *Homo erectus* is 83084, entered as "
        "*Pithecanthropus erectus*; the current combination is 376854. Only the "
        "second matched a node by name, so the first walked to genus *Homo* and "
        "the palette offered a fossil to graft below *Homo* beside the tree's "
        "own *Homo erectus* node.",
    )

    baseline: JsonDict = json.loads(BASELINE.read_text()) if BASELINE.exists() else {}
    prior = baseline.get("median_attachment_depth")
    g.require(
        "median attachment depth vs the previous build",
        median_depth,
        prior,
        ok=prior is None or median_depth >= prior - 1,
        note="no baseline — first build" if prior is None else "",
    )

    # --- spot checks ----------------------------------------------------------
    print("\n--- spot checks ---", flush=True)
    tyr = con.execute(
        "SELECT name, fea, fla, lea, lla, attach_idx, attach_walk, attach_method "
        "FROM fossil WHERE pbdb_taxon_no = ?",
        (SPOT_TYRANNOSAURUS,),
    ).fetchone()
    g.require(
        "spot check — Tyrannosaurus appearance bracket",
        None if tyr is None else tuple(tyr[1:5]),
        SPOT_APPEARANCE,
        ok=tyr is not None and tuple(tyr[1:5]) == SPOT_APPEARANCE,
    )
    container = _subtree_container(con, SPOT_CONTAINER)
    inside = (
        tyr is not None
        and container is not None
        and container[0] <= tyr[5] < container[1]
    )
    g.require(
        "spot check — Tyrannosaurus attaches inside " + SPOT_CONTAINER,
        None if tyr is None else f"attach_idx={tyr[5]} walk={tyr[6]}",
        f"within [{container[0]}, {container[1]})" if container else "container absent",
        ok=inside,
        note="ingest.md asks for 'at or below Dinosauria'. Dinosauria is "
        "ott 90215 in the taxonomy but is not a node in the synthesis tree, so "
        "the test uses the deepest named ancestor that is — a stronger claim.",
    )
    aub = con.execute(
        "SELECT own_name, own_rank, name, rank, difference FROM fossil "
        "WHERE pbdb_taxon_no = ?",
        (SPOT_AUBLYSODON,),
    ).fetchone()
    g.require(
        "spot check — Aublysodon is a genus whose accepted name is a family",
        aub,
        ("Aublysodon", "genus", "Tyrannosauridae", "family", "nomen dubium"),
        ok=aub is not None
        and aub[1] == "genus"
        and aub[3] == "family"
        and aub[2] == "Tyrannosauridae",
    )

    # --- oracle ---------------------------------------------------------------
    oracle: JsonDict = {}
    if use_api:
        print("\n--- oracle: live PBDB appearance bounds ---", flush=True)
        oracle = oracle_appearances(rows, log=print)
        agree_pct = 100 * oracle["agreed"] / max(oracle["compared"], 1)
        g.require(
            "oracle — appearance brackets agree with live PBDB",
            f"{oracle['agreed']}/{oracle['compared']} ({agree_pct:.0f}%)",
            f"≥ {ORACLE_MIN_AGREEMENT}%",
            ok=oracle["compared"] > 0 and agree_pct >= ORACLE_MIN_AGREEMENT,
            note="not 100%: unlike OTT's pinned synthesis, PBDB is continuously "
            "edited, so the snapshot and the live service legitimately drift. "
            + (
                json.dumps(oracle["disagreements"])
                if oracle["disagreements"]
                else "No disagreements in this sample."
            ),
        )
    else:
        g.observe("oracle — appearance brackets", "skipped (--no-api)")

    print("\n--- bounding age_layout by the fossil record ---", flush=True)
    parent = np.load(TOPOLOGY / "parent.npy")
    age_ma = np.load(TOPOLOGY / "age_ma.npy")
    # Re-run safe: clamp phase 2's output, never this phase's own.
    if LAYOUT_PHASE2.exists():
        before = np.load(LAYOUT_PHASE2)
    else:
        before = np.load(TOPOLOGY / "age_layout.npy")
        np.save(LAYOUT_PHASE2, before)
    bound, direct, refused, ancient, homonyms = layout_bounds(con, parent, age_ma)
    after, moved, conflicts = bound_layout(before, age_ma, parent, bound)
    np.save(TOPOLOGY / "age_layout.npy", after)
    layout_report = layout_gates(
        g,
        parent,
        age_ma,
        before,
        after,
        bound,
        direct,
        refused,
        ancient,
        homonyms,
        moved,
        conflicts,
    )
    print(f"  {moved:,} undated nodes moved back", flush=True)

    print("\n--- the occurrence age tier ---", flush=True)
    # Re-run safe for the same reason the layout is: promote phase 2's tiers,
    # never this phase's own, so running twice differs from running once only
    # in the log.
    if TIER_PHASE2.exists():
        tier_before = np.load(TIER_PHASE2)
    else:
        tier_before = np.load(TOPOLOGY / "age_tier.npy")
        np.save(TIER_PHASE2, tier_before)
    ranges, tier_after, occ_stats = occurrence_ranges(con, parent, age_ma, tier_before)
    extinct = [
        int(i)
        for (i,) in con.execute("SELECT idx FROM node WHERE flags LIKE '%extinct%'")
    ]
    occ_report = occurrence_gates(
        g,
        ranges,
        age_ma,
        tier_after,
        occ_stats,
        len(extinct),
        sum(1 for i in extinct if tier_after[i] == TIER_OCCURRENCE),
    )
    write_occurrence(con, ranges, tier_after)
    np.save(TOPOLOGY / "age_tier.npy", tier_after)
    layout_report["occurrence"] = occ_report
    LAYOUT_BASELINE.write_text(json.dumps(layout_report, indent=2) + "\n")
    print(f"  {occ_report['nodes']:,} nodes gained a fossil range", flush=True)

    BASELINE.write_text(
        json.dumps(
            {
                "written_at": time.strftime("%Y-%m-%dT%H:%M:%S"),
                "rows": n_rows,
                "median_attachment_depth": median_depth,
                "median_parent_walk": median_walk,
                "attachment_depth_histogram": dict(sorted(depths.items())),
                "parent_walk_histogram": dict(sorted(walks.items())),
                "attachment_provenance": {
                    ATTACH_METHOD_NAME[k]: v for k, v in sorted(methods.items())
                },
                "at_root": at_root,
                "with_interval": with_interval,
                "oracle": oracle,
            },
            indent=2,
        )
        + "\n"
    )
    con.close()

    g.write(BUILD / "phase4_gates.json")
    g.exit_if_failed()
    return 0


# ------------------------------------------------------------------------------
# Bounding the layout by the fossil record
# ------------------------------------------------------------------------------
#
# Phase 2 fills an undated run by spreading it between the nearest dated ancestor
# and the deepest dated descendant. An extinct lineage has no dated descendant
# (every age comes from a chronogram of extant species), so the fill drags it
# toward the present — *T. rex* drawn at 25.9 Ma against a last occurrence at 66.
# The dashed spine says the position is ordinal, not that it is wrong by 450 Ma.
#
# This runs here because phase 4 is the first point a fossil bound exists, hence
# a rewrite of `age_layout.npy`. `age_ma` is not touched and no node gains a
# number: the three arrays are separate so a position and an age can disagree.


def _pick_bracket_end() -> str:
    """Which appearance bound bounds the layout: `lla`.

    `fea` is frequently junk-wide and an occurrence-count floor does not fix it
    (the bracket widens, not narrows, with more occurrences). What discriminates
    is which end is read: the latest possible last appearance (`lla`) is the
    weakest and safest of the four numbers, and a spuriously old occurrence only
    moves `fea`, which is never read.
    """
    return "lla"


def layout_bounds(
    con: sqlite3.Connection, parent: U32Array, age_ma: F32Array
) -> tuple[F64Array, int, int, int, int]:
    """Oldest last-appearance a node must be drawn at or before, per node.

    A taxon observed in the rock at `lla` was alive then, so the node standing
    for it cannot be drawn younger than that — and neither can any ancestor,
    since a lineage's origin precedes its occurrences. That is the propagation.

    Exact attachments only (`attach_walk = 0`). A bracket attached at a parent
    belongs to some taxon below it and names no child, so it constrains none;
    borrowing it would put a Neanderthal range on any undated sibling.
    """
    n = parent.size
    bound = np.zeros(n, dtype=np.float64)
    rows = con.execute(
        f"SELECT attach_idx, max({_pick_bracket_end()}) FROM fossil "
        f"WHERE attach_walk = 0 AND {_pick_bracket_end()} IS NOT NULL "
        "GROUP BY attach_idx"
    ).fetchall()
    for idx, val in rows:
        if 0 <= idx < n and val is not None:
            bound[idx] = float(val)

    # A last-appearance bound is evidence about a lineage that ended. Where a
    # node has a dated descendant its position is already pinned by something
    # still alive, so a bound there is a bad attachment (usually a cross-kingdom
    # homonym), not a conflict to resolve. Phase 3's `refuse_disagreements`
    # withdraws most of these; this guard keeps the statement true regardless.
    p_l = parent.astype(np.int64).tolist()
    d_l = np.isfinite(age_ma).tolist()
    for i in range(n - 1, 0, -1):
        if d_l[i]:
            d_l[p_l[i]] = True
    dated_below = np.array(d_l, dtype=bool)
    refused = int(((bound > 0) & dated_below).sum())

    # The same comparison read as evidence about phase 3, counted before the
    # bounds are cleared (clearing them hides it).
    ancient = homonyms = 0
    for idx, lla in con.execute(
        "SELECT attach_idx, max(lla) FROM fossil WHERE attach_walk = 0 "
        "AND lla IS NOT NULL AND lla > 250 "
        "AND (is_extant IS NULL OR is_extant = 0) GROUP BY attach_idx"
    ):
        if not (0 <= idx < n) or lla is None:
            continue
        ancient += 1
        if dated_below[idx]:
            homonyms += 1

    bound[dated_below] = 0.0
    direct = int((bound > 0).sum())

    # Preorder gives parent[i] < i, so one reverse pass carries every bound to
    # the root.
    b = bound.tolist()
    for i in range(n - 1, 0, -1):
        if b[i] > b[p_l[i]]:
            b[p_l[i]] = b[i]
    return np.array(b, dtype=np.float64), direct, refused, ancient, homonyms


def bound_layout(
    layout: F32Array, age_ma: F32Array, parent: U32Array, bound: F64Array
) -> tuple[F32Array, int, int]:
    """Push undated nodes back to their fossil bound, then restore monotonicity.

    Only undated nodes move: a dated node's position is its displayed number.
    Where a dated ancestor is younger than a fossil beneath it, the monotonicity
    sweep pulls the descendant back down and the conflict is counted (a real
    chronogram/rock disagreement), not silently resolved.
    """
    out = layout.astype(np.float64).copy()
    undated = ~np.isfinite(age_ma)
    moved = int((undated & (bound > out)).sum())
    out = np.where(undated & (bound > out), bound, out)

    par = parent.astype(np.int64).tolist()
    o = out.tolist()
    conflicts = 0
    for i in range(1, len(o)):
        if o[i] > o[par[i]]:
            if bound[i] > 0:
                conflicts += 1
            o[i] = o[par[i]]
    return np.array(o, dtype=np.float32), moved, conflicts


def layout_gates(
    g: GateSet,
    parent: U32Array,
    age_ma: F32Array,
    before: F32Array,
    after: F32Array,
    bound: F64Array,
    direct: int,
    refused: int,
    ancient: int,
    homonyms: int,
    moved: int,
    conflicts: int,
) -> JsonDict:
    """The layout-bound gate, over the population it can act on.

    The claim is "no undated node is laid out younger than its own last fossil".
    Dated nodes are excluded because this pass does not move them — a dated
    node's layout position is the figure printed on its card — so gating on them
    would measure a number the step is not allowed to change. The dated
    population is reported as an observation instead.
    """
    has = bound > 0
    undated = ~np.isfinite(age_ma)
    late_before = before < bound - LAYOUT_TOLERANCE_MA
    late_after = after < bound - LAYOUT_TOLERANCE_MA

    viol_before = int((has & undated & late_before).sum())
    viol_after = int((has & undated & late_after).sum())
    dated_before = int((has & ~undated & late_before).sum())

    # What the pass can reach: a node cannot be drawn older than its parent, and
    # a dated parent does not move. So the achievable target is the fossil bound
    # capped by the parent's final position — that, not the raw bound, is the
    # blocking claim; the gap is a real chronogram/rock conflict, reported below.
    par = parent.astype(np.int64)
    par[0] = 0  # the root's parent is the NO_PARENT sentinel, not an index
    reach = np.minimum(bound, after[par])
    reach[0] = bound[0]
    short = int((has & undated & (after < reach - LAYOUT_TOLERANCE_MA)).sum())

    capped = has & undated & late_after
    residual = (bound - after)[capped]

    g.observe(
        "nodes carrying an exact-attach fossil bound",
        f"{direct:,} directly, {int(has.sum()):,} including ancestors",
        note=(
            "Exact attachments only. A bracket at a parent belongs to some "
            "taxon below it and names no child, so it constrains none."
        ),
    )
    g.observe(
        "resolutions that are near-certain cross-kingdom homonyms",
        f"{homonyms:,} of {ancient:,} fossils last seen before 250 Ma",
        note=(
            "A phase 3 defect, measured here because this is the first phase "
            "where a resolution can be compared against *time* — `fossil.lla` "
            "does not exist until now. A taxon last seen before the Permian "
            "cannot be a living genus, so an exact attachment older than 250 Ma "
            "landing on a node with living descendants is almost certainly the "
            "wrong taxon: *Sadleria* is a Hawaiian fern carrying a Devonian "
            "fossil, *Streptosolen* a South American shrub carrying an "
            "Ordovician one. **Phase 3 now refuses these** — see "
            "`refuse_disagreements` — and this number is how that is checked "
            "from the outside, on the one axis phase 3 does not have. It read "
            "1,019 of 1,048 before the sweep existed and 31 of 60 after: the "
            "population itself collapsed, which is the shape a real fix makes. "
            "It stays an `observe` because the residue is not repairable here "
            "and a hard threshold on it would be a number nobody measured. "
            "34 of 63 since `under_accepted_name` — and those three are the "
            "measure's own blind spot rather than new defects: PBDB files "
            "*Palaeonisci* under the accepted name *Actinopterygii*, so a "
            "genuinely Devonian fish now attaches exactly at a class that is "
            "very much alive. An extinct member of a living clade is not a "
            "homonym; the bound is refused below on the same evidence either "
            "way."
        ),
    )
    g.observe(
        "fossil bounds refused because the node has a living descendant",
        f"{refused:,}",
        note=(
            "A last appearance is evidence about a lineage that ended. This "
            "used to read 27,018 and be mostly cross-kingdom homonyms out of "
            "phase 3's name-based `xref` — PBDB's *Ivesia* is an Ediacaran "
            "rangeomorph and OTT's a rose-family plant, so a 538.8 Ma bound "
            "reached a living genus. Phase 3's sweep withdrew those and it now "
            "reads 15,563. What is left is the statement itself doing its "
            "work: a bracket on a clade that is still alive is not evidence "
            "about where that clade's origin sits."
        ),
    )
    g.observe("undated nodes pushed back to their fossil bound", f"{moved:,}")
    g.require(
        "every undated node is pushed back as far as its fossil bound allows",
        f"{short:,} short of reachable",
        "0 short",
        ok=short == 0,
        note=(
            f"{viol_before:,} before this pass. Uses `lla`, the latest possible "
            "last appearance — the weakest of PBDB's four bounds and the only "
            "one whose error direction is safe, since a spuriously young "
            "occurrence only weakens the bound. `fea` is never read: measured, "
            "its bracket widens with occurrence count rather than narrowing "
            "(5.24 Ma median at one occurrence, 6.20 at fifty or more), so the "
            "occurrence-count floor ingest.md proposes as a prerequisite does "
            "not address what it was meant to. See `_pick_bracket_end`."
        ),
    )
    g.observe(
        "dated nodes younger than a fossil attaching at or below them",
        f"{dated_before:,}",
        note=(
            "Not fixed here and not a defect in this pass: a dated node's "
            "layout position is the figure on its card, and moving it would "
            "make the number and the picture disagree — a worse failure than "
            "the one being repaired, and a different kind. Mostly PBDB "
            "attaching a stem fossil to a crown node the chronogram dates "
            "younger. Worth a look if the drill-down ever renders these "
            "side by side, because there the disagreement becomes visible."
        ),
    )
    g.observe(
        "undated nodes still younger than their own last fossil",
        f"{viol_after:,} of {viol_before:,}, all capped by a dated ancestor"
        + (
            f"; median remaining gap {float(np.median(residual)):,.1f} Ma"
            if residual.size
            else ""
        ),
        note=(
            "Not reachable without either inverting the tree or moving a dated "
            "node away from its own printed figure. *Allosaurus fragilis* is "
            "the shape of these: drawn at 18.5 Ma before this pass, 129.6 Ma "
            "after, against a last fossil at 143.1 — the remaining 13.5 Ma is "
            "its nearest dated ancestor refusing to be older. The fix for the "
            "residual is upstream, in whatever attaches a stem fossil to a "
            "crown node, not here."
        ),
    )
    return {
        "undated_violations_before": viol_before,
        "undated_violations_after": viol_after,
        "dated_violations": dated_before,
        "nodes_bounded_directly": direct,
        "nodes_bounded_including_ancestors": int(has.sum()),
        "undated_nodes_moved": moved,
        "short_of_reachable": short,
        "ancient_exact_attachments": ancient,
        "probable_kingdom_homonyms": homonyms,
        "pulled_back_by_dated_ancestor": conflicts,
    }


# ------------------------------------------------------------------------------
# The fourth age tier
# ------------------------------------------------------------------------------
#
# All three of phase 2's tiers describe *divergence times*, and all three derive
# from a chronogram containing only extant species. An extinct taxon has no
# counterpart to join to, so it is `structural` by construction — 1,742 of the
# 1,743 extinct-flagged nodes — and reads "not estimated". That is true and it
# is a poor answer to give someone who came to ask about dinosaurs.
#
# `occurrence` is a different and weaker claim in the same units: not when
# lineages parted, but when this taxon is observed in the rock. Refusing to
# show a sourced observation is not honesty. The honesty rule was always "never
# a confident divergence figure where nobody estimated one", and a stratigraphic
# range does not trip it.
#
# Four constraints, none of them negotiable, and each is enforced structurally
# rather than by discipline:
#
#   1. It never enters `age_ma`. It gets its own array, so nothing downstream
#      can mistake a range for a divergence age.
#   2. It is a range and never a point. The array carries all four PBDB bounds
#      and no midpoint is computed anywhere, so there is no single number for a
#      caller to reach for.
#   3. It is labelled as fossil occurrences, not as an age.
#   4. Exact attachments only. A bracket at a parent belongs to some taxon
#      below it and names no child.

# fea, fla, lea, lla — architecture §7's double bracket, uncollapsed. The
# envelope is fea→lla and the solid bar fla→lea; collapsing them into one range
# is a different and wrong claim about what PBDB knows.
# The occurrence table's column order. The *values* written into the last two
# come from `lea_drawn`/`lla_drawn` — see `occurrence_ranges` — because both
# ends of a last-appearance bracket come from the same records and this table
# is rendered beside grafts of the same taxa.
OCCURRENCE_BOUNDS = ("fea", "fla", "lea", "lla")
TIER_PHASE2 = TOPOLOGY / "age_tier_phase2.npy"

# The occurrence range gets its own table (not `age_ma`) so nothing reading
# `age_ma` can mistake a range for a divergence age. A dense (n, 4) float32
# array would be wasteful for ~2,129 rows and the Go reader is 1-D only. The
# dense array is still built in memory and every gate below runs against it,
# because that is where a transposed column or a stray finite value would show.


def occurrence_ranges(
    con: sqlite3.Connection, parent: U32Array, age_ma: F32Array, tier: U8Array
) -> tuple[F32Array, U8Array, JsonDict]:
    """The best-attested fossil range for each node that has one, and the tier.

    "Best-attested" is the single PBDB taxon with the most occurrences attaching
    exactly here, not a union across several (which would invent a bracket no
    source asserts). Only `structural` nodes are eligible: a node with a real
    divergence estimate keeps it.
    """
    n = parent.size
    out = np.full((n, 4), np.nan, dtype=np.float32)
    new_tier = tier.copy()

    # A fossil range is evidence about a lineage that ended; a node with a dated
    # descendant is still alive. See `layout_bounds`.
    p_l = parent.astype(np.int64).tolist()
    d_l = np.isfinite(age_ma).tolist()
    for i in range(n - 1, 0, -1):
        if d_l[i]:
            d_l[p_l[i]] = True
    alive = np.array(d_l, dtype=bool)

    # The last-appearance bracket as it may be drawn, so the node-level range
    # agrees with a graft of the same taxon. `fea`/`fla` are untouched.
    cols = "fea, fla, coalesce(lea_drawn, lea), coalesce(lla_drawn, lla)"
    rows = con.execute(
        f"SELECT attach_idx, {cols}, n_occs, name FROM fossil "
        "WHERE attach_walk = 0 AND (is_extant IS NULL OR is_extant = 0) "
        "AND (fea IS NOT NULL OR fla IS NOT NULL "
        "     OR lea IS NOT NULL OR lla IS NOT NULL) "
        "ORDER BY attach_idx, n_occs DESC, name"
    ).fetchall()

    eligible = 0
    refused_alive = 0
    refused_dated = 0
    seen: set[int] = set()
    for idx, fea, fla, lea, lla, _n_occs, _name in rows:
        if idx in seen or not (0 <= idx < n):
            continue
        seen.add(idx)  # ORDER BY put the best-attested row first
        if alive[idx]:
            refused_alive += 1
            continue
        if new_tier[idx] != TIER_STRUCTURAL:
            refused_dated += 1
            continue
        out[idx] = [np.nan if v is None else float(v) for v in (fea, fla, lea, lla)]
        new_tier[idx] = TIER_OCCURRENCE
        eligible += 1

    return (
        out,
        new_tier,
        {
            "nodes_with_a_range": eligible,
            "candidates_seen": len(seen),
            "refused_still_alive": refused_alive,
            "refused_already_dated": refused_dated,
        },
    )


def occurrence_gates(
    g: GateSet,
    ranges: F32Array,
    age_ma: F32Array,
    tier: U8Array,
    stats: JsonDict,
    extinct_total: int,
    extinct_covered: int,
) -> JsonDict:
    """The constraints, checked against the arrays rather than the code."""
    has = tier == TIER_OCCURRENCE

    # The number a reader is actually asking about. "2,129 nodes gained a
    # range" invites the conclusion that the available brackets were used up,
    # and the honest question is narrower: does a taxon someone came here to
    # look up stop reading "not estimated"?
    g.observe(
        "extinct-flagged nodes that now report a range",
        f"{extinct_covered:,} of {extinct_total:,} "
        f"({100 * extinct_covered / max(extinct_total, 1):.0f}%)",
        note=(
            "The reason the tier exists. The remainder have no PBDB taxon "
            "attaching at the node itself; a bracket attached at a parent "
            "names no child, so it constrains none (the Neanderthal case, "
            "whose real fix is an `xref` rank gap in phase 3)."
        ),
    )
    g.observe(
        "fossil ranges refused because the lineage is still alive",
        f"{stats.get('refused_still_alive', 0):,}",
        note=(
            "Deliberate, and the largest exclusion by far, so it is reported "
            "rather than left as a gap between two other numbers. These are "
            "structural nodes with a bracket whose clade contains living "
            "species. The statement 'fossils of this group are known from "
            "60–50 Ma' is true of them, but a *range* ending at 50 Ma reads as "
            "an extinction, and no caption inside a bracket undoes that. The "
            "tier is for taxa that ended."
        ),
    )
    n_tier = int(has.sum())
    g.require(
        "nodes gaining the occurrence tier",
        f"{n_tier:,}",
        f"≥ {MIN_OCCURRENCE_NODES:,} (measured 2,129)",
        ok=n_tier >= MIN_OCCURRENCE_NODES,
        note=(
            "Extinct taxa read 'not estimated' before this, by construction "
            "rather than by measurement: every age in the artifact set comes "
            "from a chronogram of extant species. This is a different and "
            "weaker claim in the same units — when a taxon is observed in the "
            "rock, not when lineages parted. A floor, and blocking: an "
            "upstream refusal that empties the tier is the failure worth "
            "catching."
        ),
    )
    g.require(
        "no occurrence node carries a divergence age",
        int((has & np.isfinite(age_ma)).sum()),
        0,
        note=(
            "The first constraint, checked on the array rather than trusted to "
            "the code that wrote it. A stratigraphic range is not a divergence "
            "age and `age_ma` is where a confident number lives."
        ),
    )
    g.require(
        "every occurrence node carries at least one bound",
        int((has & ~np.isfinite(ranges).any(axis=1)).sum()),
        0,
        note="A tier promising a range must have one; otherwise it says less "
        "than `structural` did while looking like it says more.",
    )
    g.require(
        "no node outside the tier carries a range",
        int((~has & np.isfinite(ranges).any(axis=1)).sum()),
        0,
        note="The array and the tier are one statement; they cannot disagree.",
    )

    # What PBDB actually guarantees, checked rather than assumed.
    #
    # The chain `fea >= fla >= lea >= lla` is the obvious reading of
    # architecture §7's "faded envelope fea→lla, solid bar fla→lea", and the
    # middle link of it is **false**. Measured over all 410,615 rows carrying
    # four bounds: the four invariants below hold for every single one, and
    # `fla >= lea` holds for only 39.6%.
    #
    # It is not a data defect. A taxon known from one stratigraphic interval has
    # its first appearance and its last appearance in that same interval, so
    # `fla` sits at the interval's young end and `lea` at its old end and the
    # two cross. What that means is worth stating plainly, because the renderer
    # has to: **for 60.4% of PBDB taxa there is no certain extent at all**. The
    # solid bar is empty and must not be drawn, rather than drawn zero-width or
    # drawn inverted.
    r = ranges[has]
    bad = 0
    if r.size:
        f = np.isfinite(r)
        for a, b in ((0, 1), (2, 3), (0, 2), (1, 3)):
            both = f[:, a] & f[:, b]
            bad += int((both & (r[:, a] < r[:, b] - 1e-6)).sum())
    g.require(
        "occurrence bounds satisfy PBDB's four orderings",
        bad,
        0,
        note=(
            "fea >= fla, lea >= lla, fea >= lea, fla >= lla — all four hold for "
            "every row in the corpus. `fla >= lea` is deliberately NOT among "
            "them: it holds for 39.6% of rows, because a taxon known from one "
            "interval has both appearances inside it. A failure here means the "
            "columns were transposed and a bracket would render inside out."
        ),
    )
    empty = 0
    if r.size:
        both = np.isfinite(r[:, 1]) & np.isfinite(r[:, 2])
        empty = int((both & (r[:, 1] < r[:, 2] - 1e-6)).sum())
    g.observe(
        "occurrence nodes whose certain extent is empty",
        f"{empty:,} of {int(has.sum()):,}",
        note=(
            "architecture §7's solid bar is fla→lea and for these it does not "
            "exist: everything known about the taxon comes from a single "
            "interval. It must be left undrawn, not drawn zero-width — a "
            "hairline at one date reads as precision, which is the opposite of "
            "what it means. Across the whole fossil table this is 60.4%."
        ),
    )
    return {
        "nodes": int(has.sum()),
        "empty_certain_extent": empty,
        "extinct_flagged_total": extinct_total,
        "extinct_flagged_covered": extinct_covered,
        **stats,
    }


def write_occurrence(con: sqlite3.Connection, ranges: F32Array, tier: U8Array) -> int:
    """One row per node carrying a fossil range.

    Its own table, not a column on `node` (2.7M rows, few carrying a value). The
    four bounds stay four columns; one `range` column would collapse two
    brackets into one.
    """
    con.executescript(
        """
        DROP TABLE IF EXISTS occurrence;
        CREATE TABLE occurrence (
          idx INTEGER PRIMARY KEY,
          fea REAL, fla REAL, lea REAL, lla REAL  -- uncollapsed, per §7
        );
        """
    )
    rows = [
        (int(i), *(None if not np.isfinite(v) else float(v) for v in ranges[i]))
        for i in np.flatnonzero(tier == TIER_OCCURRENCE)
    ]
    con.executemany("INSERT INTO occurrence VALUES (?,?,?,?,?)", rows)
    con.commit()
    return len(rows)
