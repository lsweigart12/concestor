"""Ranking a taxon's common names into the order people actually use them.

Phase 6 harvests every English name a taxon goes by and elects one headline.
It does not *order* the rest, and the election it does make is decided by
`length(name)` once source and kind have tied — which is a tiebreak wearing a
ranking's clothes. Measured against the shipped build, it produces:

    Tyrannosaurus rex   "TRex"          (4 characters beats "T. rex"'s 6)
    Carnivora           "Ferae"         (not an English name at all)
    Lepidoptera         "lepidopteran"
    Bacteria            "eubacteria"
    Archaea             "Archaeon"

and below the headline there is no order at all: the server stable-sorts
`is_primary` to the front and leaves the remainder in rowid order, so the card
reads *"Homo sapiens — also called human being, human beings, humans, man,
men"*. 26,262 nodes carry more than one English name, which is the population
this phase exists for.

## What "most used" is measured against

**English Wikipedia's title and redirect graph.** A name that is an article
title is the name Wikipedia's own naming policy calls the one most used in
reliable English sources; a name that is a *redirect* to that article is one
somebody thought a reader would type; a name that is no page at all is one
nobody did. The pass is exact, offline-replayable and cheap — 50 titles per
request against the MediaWiki API.

It also settles, by measurement rather than by hand-written rules, the whole
class of failures where a name's ordinary English referent is a *different*
taxon. Verified against the live API:

    man, men     -> "Man"     which is not Homo sapiens' article    demoted
    bug, bugs    -> "Bug"     which is not Insecta's article        demoted
    moth         -> "Moth"    which is not Lepidoptera's article    demoted
    Ferae        -> "Ferae"   which is not Carnivora's article      demoted
    TRex         -> no page at all                                  demoted
    carnivorans  -> "Carnivora"                                     kept
    T. rex       -> "Tyrannosaurus"                                 kept

**The taxon's own article title has to be resolved through redirects first**,
and getting that wrong inverts the result. Wikidata gives *Homo sapiens*
(Q15978631) the enwiki sitelink `Homo sapiens` — which is itself a **redirect**
to `Human`. Compared unresolved, every good vernacular for the species reads as
pointing somewhere else and is demoted, and `Homo floresiensis`-grade noise
floats up. Both ends go through the same resolution and the comparison is
between *targets*.

**Where the taxon has no English article there is no wiki evidence at all**,
and the column stays NULL rather than recording "no page". That is the same
rule phase 6 applies to a Wikidata item with no `P225`: absent evidence is not
evidence of absence, and a name we never asked about must not be scored as one
we asked about and found missing.

## Three sources that were considered and are not used

- **English corpus frequency** (Google Books ngrams, `wordfreq`, any general
  word list). It measures how common the *string* is in English, not how
  commonly it is used *for this taxon*, and the two come apart exactly where
  the ranking matters: within *Homo sapiens*'s own names it ranks `man` above
  `human`, and `mouse` is mostly a pointing device. Refused on the same
  principle that keeps `age_ma` and `age_layout` apart — a number that
  measures a different question does not become the right one by being
  numeric.
- **Wikimedia pageview dumps** (`pageviews-YYYYMM-user.bz2`, 5.53 GB for June
  2026, measured). These give an exact per-title view count including
  redirects, which is the strongest possible statement of "most used" — but
  every count still has to be attributed to a taxon, which needs this phase's
  redirect pass anyway. It is a strict *addition* to what is built here, not
  an alternative: one more evidence column, keyed on titles this phase has
  already resolved. Deferred on the 5.53 GB and on the hours, not on doubt.
- **Ranking search results by the same score.** `server/internal/store/band.go`
  ranks which *taxon* a query means, and that is a different question from
  which *name* a taxon goes by. This score is display-only and no search path
  reads it; changing search ranking is its own decision with its own gates.

## The bands

Strongest evidence first. Within a band, corroboration and then shape.

    1  title       the name is the taxon's article title
    2  redirect    the name reaches the taxon's article
    3  declared    Wikidata P1843 / PBDB ColDP — a curated common name
    4  label       the Wikidata item's own label
    5  alias       a Wikidata altLabel and nothing more

`elsewhere` — a real page that lands on some *other* article — is **demoted one
band and never removed**, which is deliberately the same shape as the rule
`docs/handoff.md` records for search: exactness is withdrawn, not deleted. A
name that names something else is still a name this taxon is filed under, and a
reader who typed it deserves to see why they arrived here.
"""

from __future__ import annotations

import hashlib
import json
import re
import sqlite3
import time
import unicodedata
from dataclasses import dataclass
from typing import TYPE_CHECKING

import httpx

from .paths import BUILD
from .provenance import USER_AGENT

if TYPE_CHECKING:
    from collections.abc import Iterable, Sequence
    from pathlib import Path

    from .typing_ import JsonDict, Log

OUT = BUILD / "vernaculars"
SITELINK_PAGES = OUT / "enwiki_sitelink"
RESOLVE_PAGES = OUT / "enwiki_resolve"

WIKIDATA_ENDPOINT = "https://query.wikidata.org/sparql"
MEDIAWIKI_ENDPOINT = "https://en.wikipedia.org/w/api.php"

# The sitelink pass binds QIDs with VALUES for the same reason the phase-6 id
# crawl does — each page becomes an indexed literal lookup rather than a scan.
# 10,000 items returns comfortably inside WDQS's 60 s ceiling.
SITELINK_PAGE = 10_000
SITELINK_PAUSE_S = 1.5

# The MediaWiki API's anonymous limit is 50 titles per request and it is a hard
# cap, not a suggestion: ask for more and the surplus comes back untouched in
# `query.normalized` with no page entry, which would read here as "no such
# page" — the exact silent-NULL failure this repo keeps meeting.
RESOLVE_BATCH = 50
RESOLVE_PAUSE_S = 0.4
RESOLVE_ATTEMPTS = 5

# Only English is harvested and only English is ranked; see `LANG_NOTE` in
# `web/src/detail/wiki.ts` for why a language picker is a feature rather than a
# constant, and why doing it properly means doing the names and the prose
# together.
LANG = "en"

# Bands, strongest first. The numbers are the sort key and nothing else reads
# them, but they are written down here rather than inline because the demotion
# below works by arithmetic on them.
BAND_TITLE = 1
BAND_REDIRECT = 2
BAND_DECLARED = 3
BAND_LABEL = 4
BAND_ALIAS = 5
# One past the weakest real band, so a demoted alias still sorts.
BAND_WORST = 6

#: `wiki_evidence` values. NULL is a sixth state and means *not asked*.
EV_TITLE = "title"
EV_REDIRECT = "redirect"
EV_ELSEWHERE = "elsewhere"
EV_NONE = "none"


# --------------------------------------------------------------------------
# Shape
# --------------------------------------------------------------------------
#
# These decide ties *inside* a band and never move a name across one. That
# division is the whole of why they are allowed to be judgement calls at all:
# a shape rule can reorder two names Wikipedia is silent about, and it can
# never overrule Wikipedia about a name Wikipedia has an opinion on.

_ARTICLE = re.compile(r"^(the|a|an)\s+", re.IGNORECASE)
_BRACKETED = re.compile(r"[(\[]")
_TRAILING_PUNCT = re.compile(r"[,;:]\s*$")
# A capitalised single word ending the way a Latin clade name ends. This is
# what puts "Ferae" and "Archaeon" below "carnivorans" and "archaeans" in the
# band they share, and it is only ever a tiebreak — where Wikipedia has an
# opinion the band has already decided.
_LATINATE = re.compile(
    r"^[A-Z][a-z]+(aceae|idae|inae|oidea|ales|aria|ae|a|um|us|on|es)$"
)


def mangled_abbreviation(name: str, scientific: str | None) -> bool:
    """Is this an abbreviation of the taxon's binomial, spelled wrongly?

    *Tyrannosaurus rex* carries `T. rex`, `T rex`, `T-Rex` and `TRex`, and
    Wikipedia has no opinion that separates them: the first three are all
    redirects to *Tyrannosaurus*. Left to the generic tiebreaks the shortest
    string wins and the app headlines its most famous fossil as **T-Rex**.

    The discriminator is the taxon's own name. `X. epithet` is the standard
    abbreviated binomial — the same form this project's search already indexes
    as an abbreviation kind — so a string that abbreviates *this* binomial and
    is *not* in that form is a mangling of a convention rather than a name of
    its own. It fires only on the taxon's own abbreviation, so it can never
    reach an ordinary common name: `blue whale` is not an abbreviation of
    *Balaenoptera musculus* and is untouched.
    """
    if not scientific:
        return False
    parts = scientific.split()
    if len(parts) != 2:
        return False
    genus, epithet = parts
    squashed = "".join(ch for ch in _fold(name) if ch.isalnum())
    if squashed != _fold(genus[0]) + _fold(epithet):
        return False
    return _fold(name.strip()) != _fold(f"{genus[0]}. {epithet}")


def shape_penalty(name: str, scientific: str | None = None) -> int:
    """Count the defects in a name's *form*. Lower is a better display name.

    Every clause here was found in the shipped table rather than imagined:
    `Sibbold's Rorqual,` carries a trailing comma, `spider (arachnid)` carries
    a disambiguator meant for a different medium, `the lion` carries an
    article, `Zanthoxylum diversifolium Warb. (1891), non Lesq. (1878)` is a
    nomenclatural citation that reached a vernacular column, and `T-Rex` is a
    real convention spelled four different ways.
    """
    n = name.strip()
    p = 0
    if _TRAILING_PUNCT.search(n):
        p += 2
    if _BRACKETED.search(n):
        p += 2
    if "," in n:
        p += 1
    if _ARTICLE.match(n):
        p += 1
    if _LATINATE.match(n):
        p += 2
    if mangled_abbreviation(n, scientific):
        p += 1
    words = n.split()
    if len(words) >= 4:
        p += 1
    return p


def _fold(s: str) -> str:
    """Casefold and strip accents, for comparing a name against a stem."""
    d = unicodedata.normalize("NFKD", s)
    return "".join(c for c in d if not unicodedata.combining(c)).casefold()


def shares_stem(name: str, scientific: str | None, *, min_stem: int = 5) -> bool:
    """Is `name` the scientific name with an English suffix bolted on?

    `lepidopteran` against *Lepidoptera*, `Dipterous` against *Diptera*,
    `Actinopterygian` against *Actinopterygii*. It is **not** used to demote
    such a name outright, because `arthropod`, `tetrapod`, `mollusc`,
    `primate` and `chordate` are all formed exactly this way and are all the
    ordinary English word — there is nothing else to call an arthropod. It is
    used only *relatively*, inside one band: where a taxon has both a
    stem-derived name and one that is not, the one that is not is the one a
    reader recognises.
    """
    if not scientific:
        return False
    stem = _fold(scientific.split()[0])[:8]
    if len(stem) < min_stem:
        return False
    return _fold(name.replace(" ", "")).startswith(stem[:min_stem])


# --------------------------------------------------------------------------
# The score
# --------------------------------------------------------------------------


@dataclass(slots=True, frozen=True)
class Candidate:
    """One name in the running, with every piece of evidence about it."""

    rowid: int
    name: str
    #: 'v' declared common name | 'l' item label | 'a' alias.
    kind: str
    #: How many independent sources carried this exact string for this taxon.
    n_sources: int
    #: One of the `EV_*` values, or None where the taxon has no English
    #: article and the question could not be asked.
    wiki: str | None


def _base_band(c: Candidate) -> int:
    if c.wiki == EV_TITLE:
        return BAND_TITLE
    if c.wiki == EV_REDIRECT:
        return BAND_REDIRECT
    return {"v": BAND_DECLARED, "l": BAND_LABEL}.get(c.kind, BAND_ALIAS)


def band(c: Candidate) -> int:
    """The band a name sorts in, after the `elsewhere` demotion.

    A name whose page lands on another article is demoted **one band, never
    removed**. Removing it would delete `man` from *Homo sapiens*, which is a
    name for humans however much the article `Man` is about something
    narrower, and a reader who searched it deserves to be told why they are
    here rather than to conclude the search misheard.
    """
    b = _base_band(c)
    if c.wiki == EV_ELSEWHERE:
        b = min(b + 1, BAND_WORST)
    return b


def sort_key(c: Candidate, scientific: str | None, stem_free_available: bool) -> tuple:
    """The full ordering key. Total, deterministic, and stable across builds.

    The last two components are the old election's whole ruleset, kept as a
    dead heat breaker rather than as a ranking: `length(name)` is a perfectly
    good way to choose between two names nothing else distinguishes, and a
    catastrophic way to choose a headline. It elected `TRex` over `T. rex`.
    """
    stemmy = stem_free_available and shares_stem(c.name, scientific)
    return (
        band(c),
        1 if stemmy else 0,
        -c.n_sources,
        shape_penalty(c.name, scientific),
        len(c.name.split()),
        len(c.name),
        c.name,
    )


def rank(
    candidates: Iterable[Candidate], scientific: str | None = None
) -> list[Candidate]:
    """Order one taxon's names, most used first."""
    cands = list(candidates)
    if not cands:
        return []
    # Computed once per taxon rather than per name: "is there anything here
    # that is not just the Latin with an -an on it" is a fact about the set.
    by_band: dict[int, bool] = {}
    for c in cands:
        b = band(c)
        by_band[b] = by_band.get(b, False) or not shares_stem(c.name, scientific)
    return sorted(cands, key=lambda c: sort_key(c, scientific, by_band[band(c)]))


# --------------------------------------------------------------------------
# The enwiki sitelink pass — which article is this taxon's?
# --------------------------------------------------------------------------


def _sparql_sitelinks(qids: Sequence[str]) -> str:
    values = " ".join(f"wd:{q}" for q in qids)
    return (
        "SELECT ?q ?title WHERE {\n"
        f"  VALUES ?q {{ {values} }}\n"
        "  ?a schema:about ?q ;\n"
        "     schema:isPartOf <https://en.wikipedia.org/> ;\n"
        "     schema:name ?title .\n"
        "}"
    )


def _post(client: httpx.Client, url: str, data: dict[str, str], log: Log) -> JsonDict:
    """POST with backoff. A decode failure is a timeout, not a bad response."""
    last = ""
    for attempt in range(RESOLVE_ATTEMPTS):
        try:
            r = client.post(url, data=data)
            if r.status_code == 429:
                wait = float(r.headers.get("Retry-After", 2**attempt * 5))
                log(f"    429; sleeping {wait:.0f}s")
                time.sleep(min(wait, 120.0))
                continue
            if r.status_code >= 500:
                last = f"HTTP {r.status_code}"
                time.sleep(2**attempt * 5)
                continue
            r.raise_for_status()
            payload: JsonDict = r.json()
        except (httpx.TransportError, json.JSONDecodeError) as exc:
            last = f"{type(exc).__name__}: {exc}"
            time.sleep(2**attempt * 5)
        else:
            return payload
    raise RuntimeError(f"{url} gave up after {RESOLVE_ATTEMPTS} attempts: {last}")


def _qids(con: sqlite3.Connection) -> list[str]:
    """Every Wikidata item the vernacular crawl tied to a node, notable first.

    Ordered by `tip_count` for the same reason phase 6's plan is: a crawl that
    is interrupted must still leave the famous animals answerable.
    """
    return [
        r[0]
        for r in con.execute(
            "SELECT v.source_id FROM vernacular v JOIN node n ON n.idx = v.idx "
            "WHERE v.source_id LIKE 'Q%' AND v.idx IS NOT NULL "
            "GROUP BY v.source_id ORDER BY max(n.tip_count) DESC, v.source_id"
        )
    ]


def crawl_sitelinks(con: sqlite3.Connection, log: Log = print) -> JsonDict:
    """Fetch each item's English Wikipedia article title. Resumable."""
    SITELINK_PAGES.mkdir(parents=True, exist_ok=True)
    qids = _qids(con)
    n_pages = (len(qids) + SITELINK_PAGE - 1) // SITELINK_PAGE
    digest = hashlib.sha256(
        f"{SITELINK_PAGE}|{len(qids)}|".encode() + ",".join(qids).encode()
    ).hexdigest()

    plan_path = SITELINK_PAGES / "plan.json"
    if plan_path.exists() and json.loads(plan_path.read_text()).get("digest") != digest:
        log("  sitelink plan changed since the last crawl; discarding checkpoints")
        for stale in SITELINK_PAGES.glob("page_*.jsonl"):
            stale.unlink()
    plan_path.write_text(
        json.dumps(
            {"digest": digest, "n_qids": len(qids), "n_pages": n_pages}, indent=2
        )
    )

    done = {p.name for p in SITELINK_PAGES.glob("page_*.jsonl")}
    log(f"  {len(qids):,} QIDs in {n_pages} pages; {len(done)} already on disk")
    fetched, stopped = 0, ""
    with httpx.Client(
        headers={"User-Agent": USER_AGENT, "Accept": "application/sparql-results+json"},
        timeout=httpx.Timeout(180.0, connect=30.0),
        follow_redirects=True,
    ) as client:
        for page in range(n_pages):
            name = f"page_{page:05d}.jsonl"
            if name in done:
                continue
            chunk = qids[page * SITELINK_PAGE : (page + 1) * SITELINK_PAGE]
            try:
                payload = _post(
                    client,
                    WIKIDATA_ENDPOINT,
                    {"query": _sparql_sitelinks(chunk), "format": "json"},
                    log,
                )
            except RuntimeError as exc:
                stopped = str(exc)
                break
            part = SITELINK_PAGES / (name + ".part")
            with part.open("w", encoding="utf-8") as fh:
                for b in payload.get("results", {}).get("bindings", []):
                    fh.write(
                        json.dumps(
                            {
                                "q": b["q"]["value"].rsplit("/", 1)[-1],
                                "t": b["title"]["value"],
                            },
                            separators=(",", ":"),
                            ensure_ascii=False,
                        )
                        + "\n"
                    )
            part.replace(SITELINK_PAGES / name)
            fetched += 1
            log(f"    sitelink page {page + 1}/{n_pages}")
            time.sleep(SITELINK_PAUSE_S)

    on_disk = len(list(SITELINK_PAGES.glob("page_*.jsonl")))
    return {
        "pages_total": n_pages,
        "pages_on_disk": on_disk,
        "pages_fetched_this_run": fetched,
        "complete": on_disk == n_pages,
        "qids_asked": len(qids),
        "stopped_early": stopped,
    }


def read_sitelinks() -> dict[str, str]:
    """QID -> English article title, from the checkpoints. Needs no network."""
    out: dict[str, str] = {}
    for path in sorted(SITELINK_PAGES.glob("page_*.jsonl")):
        with path.open(encoding="utf-8") as fh:
            for line in fh:
                d = json.loads(line)
                out[d["q"]] = d["t"]
    return out


# --------------------------------------------------------------------------
# The redirect pass — where does a title actually land?
# --------------------------------------------------------------------------


def _resolve_batch(client: httpx.Client, titles: Sequence[str], log: Log) -> JsonDict:
    """Resolve up to `RESOLVE_BATCH` titles to their target articles.

    Returns `{asked_title: target_or_None}`. `redirects=1` makes MediaWiki
    follow the chain itself, so a double redirect costs no extra request, and
    `normalized` carries the case and underscore fixes it applied — both have
    to be replayed to get from what we asked to what came back.
    """
    payload = _post(
        client,
        MEDIAWIKI_ENDPOINT,
        {
            "action": "query",
            "format": "json",
            "formatversion": "2",
            "redirects": "1",
            "titles": "|".join(titles),
        },
        log,
    )
    q = payload.get("query", {})
    norm = {n["from"]: n["to"] for n in q.get("normalized", [])}
    red = {r["from"]: r["to"] for r in q.get("redirects", [])}
    pages = [p for p in q.get("pages", []) if p.get("title")]
    missing = {p["title"] for p in pages if p.get("missing") or p.get("invalid")}
    present = {p["title"] for p in pages}
    out: JsonDict = {}
    for t in titles:
        n = norm.get(t, t)
        target = red.get(n, n)
        if target in missing:
            out[t] = {"target": None, "normalized": n}
        elif target in present:
            out[t] = {"target": target, "normalized": n}
        else:
            # Named in neither `pages` nor either map, which is what a batch
            # over the API's 50-title limit does to its surplus. Recording it
            # as "no such page" would be a lie of exactly the kind this file
            # exists to avoid, so it is written out as never asked.
            out[t] = None
    return out


def _resolve_plan(con: sqlite3.Connection, sitelinks: dict[str, str]) -> list[str]:
    """Every title worth resolving, deduplicated and ordered deterministically.

    Two populations, one list: the **article titles** the taxa themselves sit
    at, which have to be resolved before anything can be compared against
    them (`Homo sapiens` is a redirect to `Human`), and every **English
    vernacular** on a node whose taxon has such a title. A name on a node with
    no English article is not asked about at all — there would be nothing to
    compare its answer to, and a resolution recorded with no counterpart is a
    column waiting to be misread.
    """
    # The QID filter is done in Python rather than as a SQL `IN`: there are
    # 108,682 of them and binding that many parameters is neither possible nor
    # necessary for a table that fits in memory several times over.
    wanted: set[int] = {
        int(idx)
        for idx, qid in con.execute(
            "SELECT DISTINCT idx, source_id FROM vernacular "
            "WHERE idx IS NOT NULL AND source_id LIKE 'Q%'"
        )
        if qid in sitelinks
    }
    names = {
        name
        for idx, name in con.execute(
            "SELECT idx, name FROM vernacular WHERE idx IS NOT NULL AND lang = ?",
            (LANG,),
        )
        if int(idx) in wanted
    }
    return sorted(set(sitelinks.values()) | names)


def crawl_resolutions(
    con: sqlite3.Connection, sitelinks: dict[str, str], log: Log = print
) -> JsonDict:
    """Resolve every candidate title against English Wikipedia. Resumable."""
    RESOLVE_PAGES.mkdir(parents=True, exist_ok=True)
    titles = _resolve_plan(con, sitelinks)
    n_pages = (len(titles) + RESOLVE_BATCH - 1) // RESOLVE_BATCH
    # Digest the first batch only, for the reason phase 6's by-name crawl
    # gives: widening the corpus should append pages rather than throw away
    # every page already fetched, and a prefix digest is what makes that a
    # checked property rather than a hope.
    prefix = hashlib.sha256(
        f"{RESOLVE_BATCH}|".encode() + "\n".join(titles[:RESOLVE_BATCH]).encode()
    ).hexdigest()
    plan_path = RESOLVE_PAGES / "plan.json"
    if (
        plan_path.exists()
        and json.loads(plan_path.read_text()).get("prefix_digest") != prefix
    ):
        log("  resolve plan changed; discarding checkpoints")
        for stale in RESOLVE_PAGES.glob("page_*.jsonl"):
            stale.unlink()
    plan_path.write_text(
        json.dumps(
            {"prefix_digest": prefix, "n_titles": len(titles), "n_pages": n_pages},
            indent=2,
        )
    )

    done = {p.name for p in RESOLVE_PAGES.glob("page_*.jsonl")}
    log(f"  {len(titles):,} titles in {n_pages} batches; {len(done)} already on disk")
    t0 = time.monotonic()
    fetched, stopped = 0, ""
    with httpx.Client(
        headers={"User-Agent": USER_AGENT},
        timeout=httpx.Timeout(120.0, connect=30.0),
        follow_redirects=True,
    ) as client:
        for page in range(n_pages):
            name = f"page_{page:06d}.jsonl"
            if name in done:
                continue
            chunk = titles[page * RESOLVE_BATCH : (page + 1) * RESOLVE_BATCH]
            try:
                got = _resolve_batch(client, chunk, log)
            except RuntimeError as exc:
                stopped = str(exc)
                break
            part = RESOLVE_PAGES / (name + ".part")
            with part.open("w", encoding="utf-8") as fh:
                for asked, res in got.items():
                    if res is None:
                        continue
                    fh.write(
                        json.dumps(
                            {"a": asked, "n": res["normalized"], "t": res["target"]},
                            separators=(",", ":"),
                            ensure_ascii=False,
                        )
                        + "\n"
                    )
            part.replace(RESOLVE_PAGES / name)
            fetched += 1
            if fetched % 50 == 0 or page == n_pages - 1:
                rate = (time.monotonic() - t0) / fetched
                left = (n_pages - len(done) - fetched) * rate
                log(
                    f"    batch {page + 1}/{n_pages}  {rate:.2f}s/batch  "
                    f"~{left / 60:.0f} min left"
                )
            time.sleep(RESOLVE_PAUSE_S)

    on_disk = len(list(RESOLVE_PAGES.glob("page_*.jsonl")))
    return {
        "pages_total": n_pages,
        "pages_on_disk": on_disk,
        "pages_fetched_this_run": fetched,
        "complete": on_disk == n_pages,
        "titles_asked": len(titles),
        "elapsed_s": round(time.monotonic() - t0, 1),
        "stopped_early": stopped,
    }


@dataclass(slots=True)
class Resolution:
    """What English Wikipedia did with one asked-for title."""

    normalized: str
    #: The article it lands on, or None where no such page exists.
    target: str | None


def read_resolutions() -> dict[str, Resolution]:
    """Asked title -> resolution, from the checkpoints. Needs no network."""
    out: dict[str, Resolution] = {}
    for path in sorted(RESOLVE_PAGES.glob("page_*.jsonl")):
        with path.open(encoding="utf-8") as fh:
            for line in fh:
                d = json.loads(line)
                out[d["a"]] = Resolution(normalized=d["n"], target=d["t"])
    return out


def evidence(
    name: str,
    taxon_target: str | None,
    res: dict[str, Resolution],
) -> str | None:
    """Classify one name against the taxon's resolved article.

    Returns None — *not asked* — wherever the taxon has no English article or
    this name was never resolved. That state is distinct from `none`, and
    conflating them is how a partially-completed crawl would silently demote
    every name it had not reached yet.
    """
    if taxon_target is None:
        return None
    r = res.get(name)
    if r is None:
        return None
    if r.target is None:
        return EV_NONE
    if r.target != taxon_target:
        return EV_ELSEWHERE
    return EV_TITLE if r.normalized == taxon_target else EV_REDIRECT


# --------------------------------------------------------------------------
# Writing the order back
# --------------------------------------------------------------------------

NODE_WIKI_SCHEMA = """
DROP TABLE IF EXISTS node_wiki;
CREATE TABLE node_wiki (
  idx    INTEGER PRIMARY KEY,
  qid    TEXT NOT NULL,
  title  TEXT NOT NULL,   -- the sitelink, as Wikidata records it
  target TEXT             -- where it lands after redirects; NULL if it 404s
);
"""


def taxon_targets(
    con: sqlite3.Connection, sitelinks: dict[str, str], res: dict[str, Resolution]
) -> dict[int, tuple[str, str, str | None]]:
    """node idx -> (qid, sitelink title, resolved target).

    A node claimed by more than one Wikidata item takes the lowest QID, for
    the reason `store.WikidataQID` gives: six of 108,683 are, and answering
    the same way every time matters more than which one wins.
    """
    out: dict[int, tuple[str, str, str | None]] = {}
    for idx, qid in con.execute(
        "SELECT DISTINCT idx, source_id FROM vernacular "
        "WHERE idx IS NOT NULL AND source_id LIKE 'Q%' ORDER BY idx, source_id"
    ):
        i = int(idx)
        if i in out or qid not in sitelinks:
            continue
        title = sitelinks[qid]
        r = res.get(title)
        out[i] = (qid, title, r.target if r else None)
    return out


def assign_ranks(
    con: sqlite3.Connection,
    sitelinks: dict[str, str] | None = None,
    res: dict[str, Resolution] | None = None,
    log: Log = print,
) -> JsonDict:
    """Rank every resolved name and write `usage_rank`, `is_primary`, `wiki_evidence`.

    Called twice with different evidence and identical rules. Phase 6 calls it
    with nothing, so a build that never runs this phase still has a defensible
    order rather than rowid order; this phase calls it with the crawls, which
    only ever *moves* names — no name is added, removed or rewritten here.
    """
    sitelinks = sitelinks or {}
    res = res or {}
    targets = taxon_targets(con, sitelinks, res) if sitelinks else {}

    if sitelinks:
        con.executescript(NODE_WIKI_SCHEMA)
        con.executemany(
            "INSERT INTO node_wiki (idx, qid, title, target) VALUES (?,?,?,?)",
            ((i, q, t, g) for i, (q, t, g) in sorted(targets.items())),
        )

    scientific = {
        int(idx): name
        for idx, name in con.execute(
            "SELECT idx, name FROM node WHERE name IS NOT NULL"
        )
    }

    groups: dict[tuple[int, str], list[Candidate]] = {}
    for rowid, idx, name, lang, kind, n_src in con.execute(
        "SELECT rowid, idx, name, lang, kind, n_sources FROM vernacular "
        "WHERE idx IS NOT NULL ORDER BY rowid"
    ):
        i = int(idx)
        taxon_target = targets.get(i, ("", "", None))[2] if targets else None
        groups.setdefault((i, lang), []).append(
            Candidate(
                rowid=int(rowid),
                name=name,
                kind=kind or "a",
                n_sources=int(n_src or 1),
                wiki=evidence(name, taxon_target, res) if lang == LANG else None,
            )
        )

    updates: list[tuple[int, int, str | None, int]] = []
    counts: dict[str, int] = {}
    for (idx, _lang), cands in groups.items():
        for pos, c in enumerate(rank(cands, scientific.get(idx)), start=1):
            updates.append((pos, 1 if pos == 1 else 0, c.wiki, c.rowid))
            counts[c.wiki or "unasked"] = counts.get(c.wiki or "unasked", 0) + 1

    con.execute("UPDATE vernacular SET usage_rank = NULL, is_primary = 0")
    con.executemany(
        "UPDATE vernacular SET usage_rank = ?, is_primary = ?, wiki_evidence = ? "
        "WHERE rowid = ?",
        updates,
    )
    con.commit()
    log(f"  ranked {len(updates):,} names over {len(groups):,} (node, language) groups")
    return {"ranked": len(updates), "groups": len(groups), "evidence": counts}


# --------------------------------------------------------------------------
# Phase entry point
# --------------------------------------------------------------------------

# The headline a reader should meet. Each is a *set*, because more than one
# answer is defensible for a clade — "insect" and "insects" are both right and
# which one wins is not worth gating on — and because gating on the exact
# string would make every one of these a test of the tiebreak rather than of
# the evidence.
HEADLINE_CHECKS: tuple[tuple[str, tuple[str, ...]], ...] = (
    ("Homo sapiens", ("human", "humans")),
    ("Canis lupus familiaris", ("dog", "dogs", "domestic dog")),
    ("Felis catus", ("cat", "cats", "domestic cat")),
    ("Panthera leo", ("lion", "lions")),
    ("Mammalia", ("mammal", "mammals")),
    ("Aves", ("bird", "birds")),
    ("Insecta", ("insect", "insects")),
    ("Metazoa", ("animal", "animals")),
    # Was "Ferae", a Latin clade name that is not English at all. `carnivorans`
    # is a redirect to Carnivora's article and `Ferae` is an article of its own,
    # so the evidence separates them without anything being hand-written.
    ("Carnivora", ("carnivorans", "carnivores", "carnivoran")),
    # Was "TRex", which is not a page on English Wikipedia in any form.
    ("Tyrannosaurus rex", ("T. rex", "Tyrannosaurus rex", "T rex", "T-Rex")),
)

# Names that must **not** lead their taxon, and the reason each one led or
# could lead. Every one of these is a name whose ordinary English referent is
# a different, usually narrower, thing — and every one is caught by the
# redirect pass rather than by a rule written about it.
DEMOTED_CHECKS: tuple[tuple[str, str], ...] = (
    ("Homo sapiens", "man"),  # -> the article "Man"
    ("Homo sapiens", "men"),
    ("Insecta", "bug"),  # -> the article "Bug"
    ("Insecta", "bugs"),
    ("Lepidoptera", "moth"),  # -> the article "Moth"; Lepidoptera is both
    ("Carnivora", "Ferae"),
    ("Tyrannosaurus rex", "TRex"),
)

ALLOWED_EVIDENCE = (EV_TITLE, EV_REDIRECT, EV_ELSEWHERE, EV_NONE)


def _headline(con: sqlite3.Connection, sci: str) -> str | None:
    row = con.execute(
        "SELECT v.name FROM vernacular v JOIN node n ON n.idx = v.idx "
        "WHERE n.name = ? AND v.lang = ? AND v.usage_rank = 1 "
        "ORDER BY n.tip_count DESC LIMIT 1",
        (sci, LANG),
    ).fetchone()
    return row[0] if row else None


def _rank_of(con: sqlite3.Connection, sci: str, name: str) -> int | None:
    row = con.execute(
        "SELECT v.usage_rank FROM vernacular v JOIN node n ON n.idx = v.idx "
        "WHERE n.name = ? AND v.lang = ? AND lower(v.name) = lower(?) "
        "ORDER BY n.tip_count DESC LIMIT 1",
        (sci, LANG, name),
    ).fetchone()
    return None if row is None else (None if row[0] is None else int(row[0]))


def _row_census(con: sqlite3.Connection) -> tuple[int, int]:
    """Row count, and distinct (idx, lang, name) count.

    Counted with a GROUP BY rather than by gluing the three columns into one
    key. Any separator is a character some name might contain — and the first
    draft reached for one that cannot appear in a name, which turned out to be
    a character that cannot appear in Python source either.
    """
    total = con.execute(
        "SELECT count(*) FROM vernacular WHERE idx IS NOT NULL"
    ).fetchone()[0]
    distinct = con.execute(
        "SELECT count(*) FROM (SELECT idx, lang, name FROM vernacular "
        "WHERE idx IS NOT NULL GROUP BY idx, lang, name)"
    ).fetchone()[0]
    return int(total), int(distinct)


def _replayed(pages: Path) -> JsonDict:
    """The crawl report for a `--no-api` run, read off the checkpoints.

    It has to compute `complete` from the plan on disk rather than leaving it
    unset. The spot-check gates only *require* when the crawl is complete, so a
    report that simply omits the field downgrades every one of them to an
    observation — a full, finished crawl replayed offline would then fail to
    block a build that had broken the ranking. Which is what the first version
    of this did, and it took a passing 31/31 captioned "resolution crawl
    incomplete" to notice.
    """
    on_disk = len(list(pages.glob("page_*.jsonl")))
    plan_path = pages / "plan.json"
    total = None
    if plan_path.exists():
        total = json.loads(plan_path.read_text()).get("n_pages")
    return {
        "pages_total": total,
        "pages_on_disk": on_disk,
        "pages_fetched_this_run": 0,
        "complete": total is not None and on_disk == total,
        "stopped_early": "--no-api",
    }


def run(use_api: bool = True) -> int:
    """Rank every taxon's common names. Reads phase 6's table; writes order only."""
    from .gates import GateSet
    from .topology import DB

    g = GateSet("phase6b-name-rank")
    OUT.mkdir(parents=True, exist_ok=True)

    con = sqlite3.connect(DB, timeout=120.0)
    con.execute("PRAGMA busy_timeout = 120000")
    con.execute("PRAGMA synchronous = OFF")

    if con.execute("SELECT count(*) FROM vernacular").fetchone()[0] == 0:
        print("vernacular is empty — run `concestor-build vernaculars` first")
        return 1

    print("--- enwiki sitelinks ---", flush=True)
    if use_api:
        sitelink_crawl = crawl_sitelinks(con, log=print)
    else:
        sitelink_crawl = _replayed(SITELINK_PAGES)
    sitelinks = read_sitelinks()
    print(f"  {len(sitelinks):,} items carry an English article", flush=True)

    print("\n--- enwiki title resolution ---", flush=True)
    if use_api:
        resolve_crawl = crawl_resolutions(con, sitelinks, log=print)
    else:
        resolve_crawl = _replayed(RESOLVE_PAGES)
    res = read_resolutions()
    print(f"  {len(res):,} titles resolved", flush=True)

    # Captured before the rewrite so the phase can say what it actually moved.
    # A change nobody counted is a change nobody can review.
    before = dict(
        con.execute(
            "SELECT idx, name FROM vernacular WHERE is_primary = 1 AND lang = ?",
            (LANG,),
        )
    )
    rows_before = _row_census(con)

    print("\n--- ranking ---", flush=True)
    stats = assign_ranks(con, sitelinks, res, log=print)

    after = dict(
        con.execute(
            "SELECT idx, name FROM vernacular WHERE usage_rank = 1 AND lang = ?",
            (LANG,),
        )
    )
    moved = sum(1 for k, v in after.items() if before.get(k) != v)

    # ---- gates ----------------------------------------------------------
    print("\n--- gates ---", flush=True)

    g.require(
        "every resolved name carries a rank",
        con.execute(
            "SELECT count(*) FROM vernacular WHERE idx IS NOT NULL AND usage_rank IS NULL"
        ).fetchone()[0],
        0,
        note="an unranked row sorts arbitrarily, which is what this phase exists to end",
    )
    g.require(
        "no unresolved name carries a rank",
        con.execute(
            "SELECT count(*) FROM vernacular WHERE idx IS NULL AND usage_rank IS NOT NULL"
        ).fetchone()[0],
        0,
    )
    g.require(
        "exactly one rank 1 per (idx, lang)",
        con.execute(
            "SELECT count(*) FROM (SELECT idx, lang FROM vernacular "
            "WHERE usage_rank = 1 GROUP BY idx, lang HAVING count(*) > 1)"
        ).fetchone()[0],
        0,
    )
    g.require(
        "ranks are 1..n with no gap or repeat",
        con.execute(
            "SELECT count(*) FROM (SELECT idx, lang FROM vernacular "
            "WHERE idx IS NOT NULL GROUP BY idx, lang "
            "HAVING count(DISTINCT usage_rank) <> count(*) "
            "    OR min(usage_rank) <> 1 OR max(usage_rank) <> count(*))"
        ).fetchone()[0],
        0,
        note="a duplicate rank is a tie the sort key failed to break",
    )
    g.require(
        "is_primary is exactly usage_rank = 1",
        con.execute(
            "SELECT count(*) FROM vernacular "
            "WHERE is_primary <> (usage_rank = 1 AND usage_rank IS NOT NULL)"
        ).fetchone()[0],
        0,
        note="two columns saying one thing must not be able to disagree",
    )
    g.require(
        "wiki_evidence holds only the four measured values",
        con.execute(
            "SELECT count(*) FROM vernacular WHERE wiki_evidence IS NOT NULL "
            f"AND wiki_evidence NOT IN ({','.join('?' * len(ALLOWED_EVIDENCE))})",
            ALLOWED_EVIDENCE,
        ).fetchone()[0],
        0,
        note="NULL is a fifth state and means the question could not be asked",
    )
    rows_after = _row_census(con)
    g.require(
        "no name was added, removed or rewritten",
        f"{rows_after[0]:,} rows, {rows_after[1]:,} distinct (idx, lang, name)",
        f"{rows_before[0]:,} rows, {rows_before[1]:,} distinct (idx, lang, name)",
        ok=rows_after == rows_before,
        note="this phase writes order and evidence only; the strings are phase 6's",
    )
    g.require(
        "no node carries wiki evidence without an article to compare against",
        con.execute(
            "SELECT count(*) FROM vernacular v WHERE v.wiki_evidence IS NOT NULL "
            "AND NOT EXISTS (SELECT 1 FROM node_wiki w WHERE w.idx = v.idx "
            "                 AND w.target IS NOT NULL)"
        ).fetchone()[0]
        if sitelinks
        # With no sitelink checkpoints there is no `node_wiki` to join to and
        # no evidence to have written, so the gate is vacuous rather than
        # failing. Querying a table this run did not create would fail the
        # build for the absence of a crawl, which is a different complaint and
        # is the one the observe gate below actually makes.
        else 0,
        0,
        note="the Homo sapiens trap: the taxon's own title is itself a redirect",
    )

    complete = bool(resolve_crawl.get("complete"))
    for sci, expect in HEADLINE_CHECKS:
        got = _headline(con, sci)
        ok = got is not None and got.lower() in {e.lower() for e in expect}
        gate = g.require if complete else g.observe
        gate(
            f"{sci} leads with a name people use",
            got,
            list(expect),
            ok=ok,
            note="" if complete else "resolution crawl incomplete; re-run to resume",
        )

    for sci, name in DEMOTED_CHECKS:
        r = _rank_of(con, sci, name)
        # Absent is fine — the claim is that it does not *lead*, not that it
        # exists. Demoted and never removed is the rule; a missing row means
        # phase 6 never harvested it, which is a different phase's business.
        ok = r is None or r > 1
        gate = g.require if complete else g.observe
        gate(
            f"{sci} does not lead with '{name}'",
            f"rank {r}" if r else "not carried",
            "rank > 1",
            ok=ok,
            note="" if complete else "resolution crawl incomplete; re-run to resume",
        )

    g.observe(
        "enwiki sitelink crawl",
        f"{sitelink_crawl.get('pages_on_disk')}/"
        f"{sitelink_crawl.get('pages_total', '?')} pages, {len(sitelinks):,} articles",
        note=str(sitelink_crawl.get("stopped_early") or ""),
    )
    g.observe(
        "enwiki resolution crawl",
        f"{resolve_crawl.get('pages_on_disk')}/"
        f"{resolve_crawl.get('pages_total', '?')} batches, {len(res):,} titles",
        "complete",
        note=str(resolve_crawl.get("stopped_early") or ""),
    )
    g.observe(
        "names by wiki evidence",
        stats["evidence"],
        note="`unasked` is a node with no English article, not a name with no page",
    )
    g.observe(
        "headline names this phase moved",
        f"{moved:,} of {len(after):,}",
        note="phase 6's election decided ties by length(name); it elected 'TRex'",
    )
    g.observe(
        "nodes with more than one English name",
        con.execute(
            "SELECT count(*) FROM (SELECT idx FROM vernacular WHERE idx IS NOT NULL "
            "AND lang = ? GROUP BY idx HAVING count(*) > 1)",
            (LANG,),
        ).fetchone()[0],
        note="the population an ordering is for; the rest have one name and no choice",
    )
    g.observe(
        "nodes with an English article",
        f"{con.execute('SELECT count(*) FROM node_wiki').fetchone()[0]:,}"
        if sitelinks
        else "no sitelink checkpoints; ranked on offline evidence alone",
    )

    (OUT / "rank_report.json").write_text(
        json.dumps(
            {
                "sitelinks": sitelink_crawl,
                "resolutions": resolve_crawl,
                "rank": stats,
                "headlines_moved": moved,
            },
            indent=2,
        )
    )
    con.close()
    g.write(BUILD / "phase6b_gates.json")
    g.exit_if_failed()
    return 0
