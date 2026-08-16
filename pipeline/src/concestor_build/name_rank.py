"""Ranking a taxon's common names into the order people actually use them.

Phase 6 harvests every English name and elects one headline (by `length(name)`
on a tie, which headlines *T. rex* as "TRex" and gives no order to the rest).
This phase orders them.

## What "most used" is measured against

English Wikipedia's title and redirect graph: an article title is the name
Wikipedia's policy calls the one most used in reliable sources; a redirect is a
name somebody thought a reader would type; no page is a name nobody did. The
pass is exact, offline-replayable and cheap (50 titles per MediaWiki request).

It also settles, by measurement, the failures where a name's ordinary referent
is a *different* taxon — `man`/`men` land on "Man", not Homo sapiens; `bug` on
"Bug", not Insecta — demoting them without a rule about any of them.

The taxon's own article title must be resolved through redirects first: Wikidata
gives *Homo sapiens* the sitelink `Homo sapiens`, itself a redirect to `Human`,
so comparing unresolved demotes every good name. Both ends resolve and the
comparison is between targets. Where the taxon has no English article the column
stays NULL, not "no page" — absent evidence is not evidence of absence.

## Sources considered and not used

- English corpus frequency: measures how common the string is, not how commonly
  it is used *for this taxon* — inside *Homo sapiens*'s names it ranks `man`
  above `human`.
- Wikimedia pageview dumps: exact per-title counts, but each still needs this
  phase's redirect pass to attribute to a taxon, so it is a strict addition, not
  an alternative. Deferred on size.
- Ranking search by this score: `band.go` ranks which *taxon* a query means, a
  different question. This score is display-only and no search path reads it.

## The bands

Strongest evidence first; within a band, corroboration then shape.

    1  title       the name is the taxon's article title
    2  redirect    the name reaches the taxon's article
    3  declared    Wikidata P1843 / PBDB ColDP — a curated common name
    4  label       the Wikidata item's own label
    5  alias       a Wikidata altLabel and nothing more

`elsewhere` — a real page landing on some other article — is demoted one band
and never removed: it is still a name this taxon is filed under.
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

# The sitelink pass binds QIDs with VALUES so each page is an indexed lookup,
# not a scan; 10,000 returns inside WDQS's 60 s ceiling.
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
# These decide ties *inside* a band and never move a name across one, so a shape
# rule can reorder two names Wikipedia is silent about but never overrule it.

_ARTICLE = re.compile(r"^(the|a|an)\s+", re.IGNORECASE)
_BRACKETED = re.compile(r"[(\[]")
_TRAILING_PUNCT = re.compile(r"[,;:]\s*$")
# A capitalised single word ending the way a Latin clade name ends; puts "Ferae"
# below "carnivorans" in the band they share. Only ever a tiebreak.
_LATINATE = re.compile(
    r"^[A-Z][a-z]+(aceae|idae|inae|oidea|ales|aria|ae|a|um|us|on|es)$"
)


def mangled_abbreviation(name: str, scientific: str | None) -> bool:
    """Is this an abbreviation of the taxon's binomial, spelled wrongly?

    `X. epithet` is the standard abbreviated binomial, so a string that
    abbreviates *this* binomial but is not in that form (`TRex`, `T-Rex`) is a
    mangling. Fires only on the taxon's own abbreviation, so it never reaches an
    ordinary common name.
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

    Each clause was found in the shipped table: trailing punctuation, bracketed
    disambiguators, leading articles, nomenclatural citations, Latinate clade
    names, mangled abbreviations, and over-long strings.
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

    `lepidopteran` against *Lepidoptera*. Not used to demote outright —
    `arthropod` is formed the same way and is the ordinary word — only
    relatively: within a band, a non-stem name beats a stem-derived one.
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
    #: The name reached this node through the infraspecific collapse — it is
    #: really a narrower, folded taxon's name. Searchable, never the headline.
    folded: bool = False


def _base_band(c: Candidate) -> int:
    if c.wiki == EV_TITLE:
        return BAND_TITLE
    if c.wiki == EV_REDIRECT:
        return BAND_REDIRECT
    return {"v": BAND_DECLARED, "l": BAND_LABEL}.get(c.kind, BAND_ALIAS)


def band(c: Candidate) -> int:
    """The band a name sorts in, after the `elsewhere` demotion.

    A name whose page lands on another article is demoted one band, never
    removed (removing it would delete `man` from *Homo sapiens*).
    """
    b = _base_band(c)
    if c.wiki == EV_ELSEWHERE:
        b = min(b + 1, BAND_WORST)
    return b


def sort_key(c: Candidate, scientific: str | None, stem_free_available: bool) -> tuple:
    """The full ordering key. Total, deterministic, and stable across builds.

    `length(name)` is kept only as the last tiebreak, never as the ranking (it
    elected `TRex` over `T. rex`).
    """
    stemmy = stem_free_available and shares_stem(c.name, scientific)
    return (
        # Before every other signal: a folded taxon's name never outranks a
        # name that is the node's own, whatever its evidence says — the
        # evidence is about the narrower taxon ("Greenland Wolf" has a fine
        # article; it is not what Canis lupus is called).
        1 if c.folded else 0,
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
    # Computed once per taxon: "is there a non-stem name in this band" is a fact
    # about the set.
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

    Ordered by `tip_count` so an interrupted crawl still answers famous animals.
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
            # Named in neither `pages` nor either map — the API's 50-title limit
            # dropped the surplus. Record as never asked, not "no such page".
            out[t] = None
    return out


def _resolve_plan(con: sqlite3.Connection, sitelinks: dict[str, str]) -> list[str]:
    """Every title worth resolving, deduplicated and ordered deterministically.

    Two populations, one list: the taxa's own article titles (which must be
    resolved before anything can be compared against them — `Homo sapiens`
    redirects to `Human`), and every English vernacular on a node whose taxon has
    such a title. A name on a node with no English article is not asked about.
    """
    # QID filter done in Python, not a SQL `IN`, to avoid binding 100k+ params.
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
    # Digest the first batch only, so widening the corpus appends pages rather
    # than discarding fetched ones.
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

    Returns None (*not asked*) where the taxon has no English article or the
    name was never resolved — distinct from `none`, so a partial crawl does not
    demote names it has not reached.
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

    A node claimed by more than one Wikidata item takes the lowest QID, so the
    answer is stable. Folded rows are excluded: their items are about the
    folded infraspecific taxon, and letting one claim the node would title the
    wolf's article "Dog" (Q144 sorts below the wolf's own item as text).
    """
    out: dict[int, tuple[str, str, str | None]] = {}
    for idx, qid in con.execute(
        "SELECT DISTINCT idx, source_id FROM vernacular "
        "WHERE idx IS NOT NULL AND source_id LIKE 'Q%' AND folded = 0 "
        "ORDER BY idx, source_id"
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

    Called twice with identical rules: phase 6 with no crawl evidence (so a
    build has a defensible order regardless), and this phase with the crawls.
    Only moves names — none is added, removed or rewritten.
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
    for rowid, idx, name, lang, kind, n_src, folded in con.execute(
        "SELECT rowid, idx, name, lang, kind, n_sources, folded "
        "FROM vernacular WHERE idx IS NOT NULL ORDER BY rowid"
    ):
        i = int(idx)
        taxon_target = targets.get(i, ("", "", None))[2] if targets else None
        # A folded row is not asked the wiki question: the node's article is
        # about the node, not about the folded taxon the name belongs to, and
        # most folded items hold no article of their own (English Wikipedia
        # files the dog's article on a concept item, not the taxon item).
        # Evidence None is the honest fifth state. The server's search rule
        # for folded exactness is what hands "dog" to Canis lupus.
        if folded:
            taxon_target = None
        groups.setdefault((i, lang), []).append(
            Candidate(
                rowid=int(rowid),
                name=name,
                kind=kind or "a",
                n_sources=int(n_src or 1),
                wiki=evidence(name, taxon_target, res) if lang == LANG else None,
                folded=bool(folded),
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

# The headline a reader should meet. Each is a set, since more than one answer
# is defensible ("insect"/"insects") and gating on the exact string would test
# the tiebreak rather than the evidence.
HEADLINE_CHECKS: tuple[tuple[str, tuple[str, ...]], ...] = (
    ("Homo sapiens", ("human", "humans")),
    # The domestic dog folded into the wolf (phase 1's infraspecific
    # collapse). "dog" stays searchable on this node, but as a folded name it
    # must never lead it — the check is that the wolf's own name still does.
    ("Canis lupus", ("wolf", "wolves", "gray wolf", "grey wolf")),
    ("Felis catus", ("cat", "cats", "domestic cat")),
    ("Panthera leo", ("lion", "lions")),
    ("Mammalia", ("mammal", "mammals")),
    ("Aves", ("bird", "birds")),
    ("Insecta", ("insect", "insects")),
    ("Metazoa", ("animal", "animals")),
    # Was "Ferae" (not English); `carnivorans` redirects to Carnivora's article.
    ("Carnivora", ("carnivorans", "carnivores", "carnivoran")),
    # Was "TRex", not a page on English Wikipedia in any form.
    ("Tyrannosaurus rex", ("T. rex", "Tyrannosaurus rex", "T rex", "T-Rex")),
)

# Names that must NOT lead their taxon — each has a different ordinary English
# referent, caught by the redirect pass rather than a rule written about it.
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

    GROUP BY rather than a glued key, since any separator is a character some
    name might contain.
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

    Computes `complete` from the plan on disk: the spot-check gates only
    `require` when the crawl is complete, so omitting the field would silently
    downgrade them all to observations.
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

    # Captured before the rewrite so the phase can report what it moved.
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
        # With no sitelink checkpoints there is no `node_wiki` and no evidence
        # written, so the gate is vacuous rather than failing.
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
