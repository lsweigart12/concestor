#!/usr/bin/env python3
"""Turn the beacon's dataset into something with names in it.

`docs/analytics.md` is the design and §8 is this script; `scripts/analytics-
report.sh` is the entry point and resolves the database path. The three
questions are that document's three questions, and nothing here invents a
fourth: three events cannot answer one.

The reason this is a bespoke report rather than a Grafana board is the join.
Analytics Engine holds **keys** — a row says `ott461645` and a tree says
`ott461645,ott478542` — and the only thing that turns those into *Apis
mellifera* and *Octopoda* is `build/concestor.db`, which is 1.9 GB, local, and
not reachable from a hosted dashboard. Printing names is the point.

Two things about the numbers, both of which change what a reader should believe:

- **`SUM(_sample_interval)`, never `COUNT()`.** Analytics Engine samples per
  index once volume is high and a sampled row stands for several. The edge
  dataset sets the same trap and reached a sample interval of 1.25 on a day with
  barely a thousand requests. Every count below is a weighted sum, and the
  overview prints the largest interval seen so the reader can tell whether
  sampling is in play at all.
- **Sessions cannot be weighted.** `COUNT(DISTINCT blob5)` counts the session
  ids that survived sampling, and there is no way to weight a distinct count.
  Under sampling it is a floor, and it is labelled as one.

Outside the pipeline's ruff/ty scope on purpose, for the reason
`scripts/ci/go-test-summary.py` gives: it runs under whatever python3 is on the
machine, before any dependency is installed. Standard library only.
"""

from __future__ import annotations

import argparse
import datetime
import html
import json
import os
import pathlib
import re
import sqlite3
import subprocess
import sys
import urllib.error
import urllib.request
from typing import Any, Iterable, Iterator, NamedTuple, Optional

DATASET = "concestor_events"
API = "https://api.cloudflare.com/client/v4/accounts/{account}/analytics_engine/sql"

# Analytics Engine retains three months. Asking for more is not an error at the
# API — it just quietly answers about the window that exists — so the ceiling is
# stated here rather than discovered.
RETENTION_DAYS = 92

# The causes that mean somebody *built* the tree. `link`, `back` and `open` mean
# they were handed one, and `docs/analytics.md` §2 is why mixing them would make
# a single popular shared link read as independent discovery. They are not
# dropped; they get their own section.
MADE = ("add", "remove")
MADE_SQL = "(" + ", ".join(f"'{cause}'" for cause in MADE) + ")"

# SQLite has a hard cap on host parameters (999 on older builds). Keys are
# batched under it rather than at it.
CHUNK = 500


class ApiError(RuntimeError):
    """A message already fit to print. Nothing above this adds to it."""


# --- credentials ------------------------------------------------------------
# Nothing new has to be minted to read this, verified 2026-08-03: the OAuth
# token `wrangler login` leaves behind authenticates the SQL API. A token minted
# by hand needs Account → Account Analytics → Read, which is *not* the
# permission that deploys.
#
# No token is ever printed, including in an error.


def wrangler_config() -> Optional[pathlib.Path]:
    """Where `wrangler login` puts its token, per platform."""
    home = pathlib.Path.home()
    xdg = os.environ.get("XDG_CONFIG_HOME")
    candidates = [
        home / "Library/Preferences/.wrangler/config/default.toml",  # macOS
        pathlib.Path(xdg) / ".wrangler/config/default.toml" if xdg else None,
        home / ".config/.wrangler/config/default.toml",  # Linux
        home / ".wrangler/config/default.toml",  # older wrangler
    ]
    for path in candidates:
        if path is not None and path.is_file():
            return path
    return None


def toml_string(text: str, key: str) -> Optional[str]:
    """One quoted scalar out of wrangler's config.

    A regex rather than a TOML parser because `tomllib` is 3.11 and this must
    run on whatever python3 the machine has. The file is written by wrangler
    and holds four flat quoted keys, so the shape is not in question.
    """
    match = re.search(rf'^\s*{re.escape(key)}\s*=\s*"([^"]*)"', text, re.M)
    return match.group(1) if match else None


def wrangler(*args: str) -> Optional[str]:
    """Run the wrangler binary the shell wrapper found, if it found one.

    `scripts/analytics-report.sh` resolves it — this checkout, then the main
    one, then PATH — because a worktree has no `web/node_modules` of its own
    and the wrapper is already the half of this tool that knows that.
    """
    binary = os.environ.get("CONCESTOR_WRANGLER") or ""
    if not binary:
        return None
    try:
        done = subprocess.run(
            [binary, *args], capture_output=True, text=True, timeout=120, check=False
        )
    except (OSError, subprocess.SubprocessError):
        return None
    return done.stdout if done.returncode == 0 else None


def account_id() -> str:
    """Which account, without writing it down anywhere tracked.

    `web/wrangler.jsonc` carries an `ACCOUNT_ID` placeholder that the deploy
    workflow substitutes, and keeping the real one out of the repository is
    deliberate. So: the environment, else ask wrangler.
    """
    from_env = os.environ.get("CLOUDFLARE_ACCOUNT_ID", "").strip()
    if from_env:
        return from_env

    out = wrangler("whoami")
    if out:
        # whoami prints a box-drawn table of Account Name | Account ID. The id
        # is the only 32-hex field in it.
        ids = re.findall(r"\b[0-9a-f]{32}\b", out)
        if len(set(ids)) == 1:
            return ids[0]
        if len(set(ids)) > 1:
            raise ApiError(
                "`wrangler whoami` lists more than one account. Set "
                "CLOUDFLARE_ACCOUNT_ID to the one holding concestor-web."
            )

    hint = ""
    if os.environ.get("CLOUDFLARE_API_TOKEN"):
        # wrangler prefers that variable over its own stored login, so a token
        # that cannot read the account stops `whoami` before it can answer —
        # and "run wrangler login" would be the wrong advice for it.
        hint = (
            " wrangler used CLOUDFLARE_API_TOKEN from the environment, so if "
            "that token cannot read the account, this is where it shows."
        )
    raise ApiError(
        "No account id. Set CLOUDFLARE_ACCOUNT_ID, or make `wrangler whoami` "
        "able to answer — `wrangler login` is the usual way." + hint
    )


def api_token() -> str:
    """A token that can read the SQL API, preferring an explicit one."""
    from_env = os.environ.get("CLOUDFLARE_API_TOKEN", "").strip()
    if from_env:
        return from_env

    path = wrangler_config()
    if path is None:
        raise ApiError(
            "No credentials. Run `wrangler login`, or set CLOUDFLARE_API_TOKEN "
            "to a token with Account → Account Analytics → Read."
        )

    text = path.read_text()
    token = toml_string(text, "oauth_token")
    expires = toml_string(text, "expiration_time")

    # wrangler refreshes this file on use, and we cannot: the refresh needs
    # wrangler's own OAuth client id. So when the stored token has expired, run
    # a cheap wrangler command to make wrangler refresh it, and read again.
    if token and expires and _expired(expires):
        if wrangler("whoami") is not None:
            token = toml_string(path.read_text(), "oauth_token") or token

    if not token:
        raise ApiError(f"No oauth_token in {path}. Run `wrangler login`.")
    return token


def _expired(expiration: str) -> bool:
    """Whether wrangler's stored expiry is in the past.

    wrangler writes ISO-8601 UTC. A parse failure returns False, because
    guessing "expired" would send the reader to `wrangler login` over a format
    change rather than a real problem — and a genuinely dead token still fails
    loudly at the 401, which says the same thing.
    """
    try:
        when = datetime.datetime.strptime(expiration[:19], "%Y-%m-%dT%H:%M:%S")
    except ValueError:
        return False
    now = datetime.datetime.now(datetime.timezone.utc).replace(tzinfo=None)
    return when < now


# --- the SQL API ------------------------------------------------------------


def query(account: str, token: str, sql: str) -> list[dict[str, Any]]:
    """One statement, JSON back. Raises ApiError with something readable."""
    request = urllib.request.Request(
        API.format(account=account),
        data=(sql + " FORMAT JSON").encode(),
        headers={"Authorization": f"Bearer {token}", "Content-Type": "text/plain"},
    )
    try:
        with urllib.request.urlopen(request, timeout=60) as response:
            payload = json.loads(response.read().decode())
    except urllib.error.HTTPError as error:
        body = error.read().decode(errors="replace")[:400]
        if error.code in (401, 403):
            # Two causes, and the API does not distinguish them: the token
            # cannot read analytics, or the account is not this token's
            # account. Both are worth naming, because a wrong
            # CLOUDFLARE_ACCOUNT_ID reads exactly like an expired login.
            raise ApiError(
                f"Cloudflare refused the request (HTTP {error.code}). Either "
                "the account id is not this token's account, or the token "
                "cannot read analytics: a minted CLOUDFLARE_API_TOKEN needs "
                "Account → Account Analytics → Read, which is a different "
                "permission from the one that deploys, and the token "
                "`wrangler login` leaves behind expires — run `wrangler "
                "login` to renew it."
            ) from None
        if error.code == 404:
            raise ApiError(
                f"No dataset `{DATASET}` on this account (HTTP 404). It is "
                "created by the first beacon write — check the account id."
            ) from None
        raise ApiError(f"Analytics Engine said HTTP {error.code}: {body}") from None
    except urllib.error.URLError as error:
        raise ApiError(f"Could not reach the SQL API: {error.reason}") from None

    return payload.get("data", [])


def n(value: Any) -> int:
    """A count out of the API, which returns UInt64 as a string and Float64 not."""
    try:
        return int(float(value))
    except (TypeError, ValueError):
        return 0


def window(days: int) -> str:
    return f"timestamp > NOW() - INTERVAL '{days}' DAY"


# --- names ------------------------------------------------------------------


class Taxon(NamedTuple):
    """What a key turned out to mean. `name` is None for a divergence."""

    key: str
    name: Optional[str]
    rank: Optional[str]
    common: Optional[str]

    def label(self) -> str:
        """The one string that identifies this row to a reader.

        A key that resolved to nothing prints as itself. That is not an error
        state: `mrcaott…` names a divergence, and a divergence genuinely has no
        name — the app derives one for the canvas and the database stores NULL.
        """
        return self.name or self.key


def chunked(items: list[str], size: int) -> Iterator[list[str]]:
    for start in range(0, len(items), size):
        yield items[start : start + size]


def resolve(db: pathlib.Path, keys: Iterable[str]) -> dict[str, Taxon]:
    """Keys to taxa, against the shipped database.

    One join, on `node.node_key`, which carries the key in exactly the API form
    the beacon sends — `ott461645` and `mrcaott2ott3973` alike — and is indexed.
    Splitting `ottNNN` back into an integer to join `node.ott_id` would work for
    half the keys and silently resolve nothing for the other half, because
    `node.name` is NULL on every `mrcaott…` row rather than holding the key.

    Read-only, `immutable=1`, like everything else here.
    """
    wanted = sorted({key for key in keys if key})
    found: dict[str, Taxon] = {}
    if not wanted:
        return found

    connection = sqlite3.connect(f"file:{db}?immutable=1", uri=True)
    try:
        for batch in chunked(wanted, CHUNK):
            marks = ",".join("?" * len(batch))
            rows = connection.execute(
                f"SELECT node_key, name, rank FROM node WHERE node_key IN ({marks})",
                batch,
            ).fetchall()
            for key, name, rank in rows:
                found[key] = Taxon(key, name, rank, None)

            # The name a reader would use, where the taxon has one.
            # `is_primary` is exactly `usage_rank = 1` — the most used English
            # name, per docs/name-ranking.md — and it is indexed for that.
            commons = connection.execute(
                f"""SELECT n.node_key, v.name
                      FROM node n
                      JOIN vernacular v ON v.idx = n.idx
                     WHERE n.node_key IN ({marks})
                       AND v.lang = 'en' AND v.is_primary = 1""",
                batch,
            ).fetchall()
            for key, common in commons:
                if key in found:
                    found[key] = found[key]._replace(common=common)
    finally:
        connection.close()

    return found


def tree_label(tree: str, names: dict[str, Taxon]) -> str:
    """`ott461645,ott478542` → `Apis mellifera + Octopoda`."""
    parts = [key for key in tree.split(",") if key]
    return " + ".join(names[key].label() if key in names else key for key in parts)


# --- the report -------------------------------------------------------------


class Row(NamedTuple):
    """One line of one section, already resolved and already counted."""

    label: str
    note: str
    count: int
    sessions: int


class Section(NamedTuple):
    title: str
    caption: str
    columns: tuple[str, str]
    rows: list[Row]
    empty: str


def gather(account: str, token: str, db: pathlib.Path, days: int, limit: int) -> dict:
    since = window(days)

    overview = query(
        account,
        token,
        f"""SELECT SUM(_sample_interval) AS events,
                   COUNT() AS raw,
                   MAX(_sample_interval) AS worst,
                   COUNT(DISTINCT blob5) AS sessions,
                   MIN(timestamp) AS first, MAX(timestamp) AS last
              FROM {DATASET} WHERE {since}""",
    )

    searches = query(
        account,
        token,
        f"""SELECT blob2 AS subject,
                   SUM(_sample_interval) AS count,
                   COUNT(DISTINCT blob5) AS sessions
              FROM {DATASET}
             WHERE blob1 = 'search' AND {since} AND blob2 != ''
             GROUP BY subject ORDER BY count DESC, subject ASC LIMIT {limit}""",
    )

    adds = query(
        account,
        token,
        f"""SELECT blob2 AS subject,
                   SUM(_sample_interval) AS count,
                   COUNT(DISTINCT blob5) AS sessions
              FROM {DATASET}
             WHERE blob1 = 'add' AND {since} AND blob2 != ''
             GROUP BY subject ORDER BY count DESC, subject ASC LIMIT {limit}""",
    )

    made = query(
        account,
        token,
        f"""SELECT blob3 AS tree, double1 AS size,
                   SUM(_sample_interval) AS count,
                   COUNT(DISTINCT blob5) AS sessions
              FROM {DATASET}
             WHERE blob1 = 'tree' AND {since} AND blob3 != ''
               AND blob4 IN {MADE_SQL}
             GROUP BY tree, size ORDER BY count DESC, tree ASC LIMIT {limit}""",
    )

    received = query(
        account,
        token,
        f"""SELECT blob3 AS tree, blob4 AS cause, double1 AS size,
                   SUM(_sample_interval) AS count,
                   COUNT(DISTINCT blob5) AS sessions
              FROM {DATASET}
             WHERE blob1 = 'tree' AND {since} AND blob3 != ''
               AND blob4 NOT IN {MADE_SQL}
             GROUP BY tree, cause, size ORDER BY count DESC, tree ASC LIMIT {limit}""",
    )

    daily_kinds = query(
        account,
        token,
        f"""SELECT toDate(timestamp) AS day, blob1 AS kind,
                   SUM(_sample_interval) AS count
              FROM {DATASET} WHERE {since}
             GROUP BY day, kind ORDER BY day ASC""",
    )
    daily_sessions = query(
        account,
        token,
        f"""SELECT toDate(timestamp) AS day, COUNT(DISTINCT blob5) AS sessions
              FROM {DATASET} WHERE {since}
             GROUP BY day ORDER BY day ASC""",
    )

    # Every key that will be printed, resolved in one pass over the database.
    keys: set[str] = {str(row["subject"]) for row in adds}
    for row in list(made) + list(received):
        keys.update(key for key in str(row["tree"]).split(",") if key)
    names = resolve(db, keys)

    def taxon_note(taxon: Optional[Taxon]) -> str:
        """What to say about a key beside the name it resolved to.

        A key the database has never heard of is worth saying out loud: it is
        either a build older than the reader's, or a taxon that has since been
        suppressed from synthesis.
        """
        if taxon is None:
            return "not in this build"
        bits = [taxon.rank or ""]
        if taxon.common:
            bits.append(taxon.common)
        if taxon.name is None:
            bits.append("a divergence, which has no name of its own")
        return " · ".join(bit for bit in bits if bit)

    sections = [
        Section(
            "Top searches",
            "What people typed. A prefix chain is one search and the longest "
            "form is the one kept, so a reader who typed “dogs” and backspaced "
            "is recorded as having searched for “dogs”.",
            ("Query", ""),
            [
                Row(str(row["subject"]), "", n(row["count"]), n(row["sessions"]))
                for row in searches
            ],
            "No searches in this window.",
        ),
        Section(
            "Most-added taxa",
            "What people went looking for, interactively. The nine canned "
            "openings deliberately emit no add event, so nothing here is us.",
            ("Taxon", "Key and rank"),
            [
                Row(
                    names[str(row["subject"])].label()
                    if str(row["subject"]) in names
                    else str(row["subject"]),
                    " · ".join(
                        bit
                        for bit in (
                            str(row["subject"]),
                            taxon_note(names.get(str(row["subject"]))),
                        )
                        if bit
                    ),
                    n(row["count"]),
                    n(row["sessions"]),
                )
                for row in adds
            ],
            "No adds in this window.",
        ),
        Section(
            "Trees people built",
            "A selection that settled at two or more, where the last thing "
            "that happened was an add or a remove. This is the section that "
            "answers what readers explore.",
            ("Tree", "Size"),
            [
                Row(
                    tree_label(str(row["tree"]), names),
                    f"{n(row['size'])} taxa",
                    n(row["count"]),
                    n(row["sessions"]),
                )
                for row in made
            ],
            "No trees built in this window.",
        ),
        Section(
            "Trees people arrived at",
            "The same event with any other cause — a shared link, the back "
            "button, a canned opening. Kept apart from the section above "
            "because one popular link is not a thing readers keep "
            "independently discovering.",
            ("Tree", "How they got there"),
            [
                Row(
                    tree_label(str(row["tree"]), names),
                    f"{row['cause']} · {n(row['size'])} taxa",
                    n(row["count"]),
                    n(row["sessions"]),
                )
                for row in received
            ],
            "No received trees in this window.",
        ),
    ]

    by_day: dict[str, dict[str, int]] = {}
    for row in daily_kinds:
        day = by_day.setdefault(str(row["day"]), {})
        day[str(row["kind"])] = n(row["count"])
    for row in daily_sessions:
        by_day.setdefault(str(row["day"]), {})["sessions"] = n(row["sessions"])

    head = overview[0] if overview else {}
    return {
        "days": days,
        "limit": limit,
        "events": n(head.get("events")),
        "raw": n(head.get("raw")),
        "worst_interval": n(head.get("worst")) or 1,
        "sessions": n(head.get("sessions")),
        "first": head.get("first") or "—",
        "last": head.get("last") or "—",
        "daily": sorted(by_day.items()),
        "sections": sections,
    }


# --- rendering --------------------------------------------------------------

KINDS = ("search", "add", "tree")


def sampling_note(worst: int) -> str:
    if worst <= 1:
        return (
            "No sampling in this window — every row stands for itself. Counts "
            "are still SUM(_sample_interval), which is what keeps them right "
            "when that stops being true."
        )
    return (
        f"Sampled: one row stood for as many as {worst}. Counts are "
        "SUM(_sample_interval) and are correct; session counts are a floor, "
        "because a distinct count cannot be weighted."
    )


def plural(count: int, word: str) -> str:
    return f"{count:,} {word}" if count == 1 else f"{count:,} {word}s"


def render_text(report: dict) -> str:
    out: list[str] = []
    add = out.append

    add(f"Concestor · what readers did · last {report['days']} days")
    add("=" * 64)
    add("")
    add(
        f"{plural(report['events'], 'event')} over "
        f"{plural(report['sessions'], 'session')}"
        f"  ({report['first']} → {report['last']} UTC)"
    )
    add(sampling_note(report["worst_interval"]))
    add("")

    if report["daily"]:
        add("By day")
        add("-" * 64)
        add(f"  {'day':<12}{'search':>8}{'add':>8}{'tree':>8}{'sessions':>10}")
        for day, counts in report["daily"]:
            cells = "".join(f"{counts.get(kind, 0):>8,}" for kind in KINDS)
            add(f"  {day:<12}{cells}{counts.get('sessions', 0):>10,}")
        add("")

    for section in report["sections"]:
        add(section.title)
        add("-" * 64)
        if not section.rows:
            add(f"  {section.empty}")
            add("")
            continue
        width = max(len(row.label) for row in section.rows)
        width = min(max(width, 12), 58)
        for row in section.rows:
            label = row.label if len(row.label) <= width else row.label[: width - 1] + "…"
            add(f"  {row.count:>6,}  {label:<{width}}  {row.note}".rstrip())
        add("")

    return "\n".join(out)


CSS = """
:root {
  color-scheme: light dark;
  --ink: #14181c; --dim: #5c6672; --line: #e2e6ea; --bg: #fbfcfd;
  --panel: #ffffff; --accent: #2f6f4f;
}
@media (prefers-color-scheme: dark) {
  :root {
    --ink: #e8ecef; --dim: #96a1ad; --line: #2a3138; --bg: #14181c;
    --panel: #1a1f25; --accent: #7fc0a0;
  }
}
* { box-sizing: border-box; }
body {
  margin: 0; padding: 2.5rem 1.25rem 5rem; background: var(--bg); color: var(--ink);
  font: 15px/1.55 ui-sans-serif, -apple-system, "Segoe UI", Helvetica, sans-serif;
}
main { max-width: 62rem; margin: 0 auto; }
h1 { font-size: 1.45rem; margin: 0 0 .35rem; font-weight: 620; letter-spacing: -.01em; }
h2 {
  font-size: 1.05rem; margin: 2.75rem 0 .3rem; font-weight: 620;
  letter-spacing: -.005em;
}
p.sub { color: var(--dim); margin: 0 0 .4rem; font-size: .9rem; max-width: 46rem; }
p.caption { color: var(--dim); margin: 0 0 .9rem; font-size: .875rem; max-width: 46rem; }
.stats { display: flex; flex-wrap: wrap; gap: .5rem; margin: 1.1rem 0 .75rem; }
.stat {
  background: var(--panel); border: 1px solid var(--line); border-radius: 8px;
  padding: .55rem .8rem; min-width: 8.5rem;
}
.stat b { display: block; font-size: 1.3rem; font-weight: 620; line-height: 1.2; }
.stat span { color: var(--dim); font-size: .78rem; text-transform: uppercase;
  letter-spacing: .05em; }
/* `p.note`, not `.note`: the second column of a table is `td.note` and a
   border-left meant for the callout showed up as a stray rule down the middle
   of every section. */
p.note {
  border-left: 3px solid var(--accent); padding: .5rem .85rem; margin: .5rem 0 0;
  background: var(--panel); color: var(--dim); font-size: .875rem;
  border-radius: 0 6px 6px 0;
}
.scroll { overflow-x: auto; }
table {
  width: 100%; border-collapse: collapse; background: var(--panel);
  border: 1px solid var(--line); border-radius: 8px; overflow: hidden;
  font-size: .9rem;
}
th, td { text-align: left; padding: .5rem .75rem; border-bottom: 1px solid var(--line); }
th {
  font-weight: 560; color: var(--dim); font-size: .76rem; text-transform: uppercase;
  letter-spacing: .05em; white-space: nowrap;
}
tr:last-child td { border-bottom: 0; }
td.n, th.n { text-align: right; font-variant-numeric: tabular-nums; white-space: nowrap; }
td.name { font-weight: 520; }
td.note, td.dim { color: var(--dim); font-size: .85rem; }
code { font: .85em ui-monospace, SFMono-Regular, Menlo, monospace; color: var(--dim); }
.empty { color: var(--dim); font-style: italic; padding: .35rem 0 0; }
footer { color: var(--dim); font-size: .8rem; margin-top: 3.5rem;
  border-top: 1px solid var(--line); padding-top: .9rem; }
"""


def esc(value: Any) -> str:
    return html.escape(str(value), quote=True)


def render_html(report: dict, account: str, generated: str) -> str:
    parts: list[str] = []
    add = parts.append

    add("<!doctype html>")
    add('<html lang="en"><head><meta charset="utf-8">')
    add('<meta name="viewport" content="width=device-width, initial-scale=1">')
    add(f"<title>Concestor · what readers did · {report['days']} days</title>")
    add(f"<style>{CSS}</style></head><body><main>")

    add("<h1>What readers did</h1>")
    add(
        f'<p class="sub">The last {report["days"]} days of '
        f"<code>{esc(DATASET)}</code>, keys resolved against this machine's "
        f"<code>build/concestor.db</code>. Account <code>{esc(account[:6])}…</code>. "
        f"Generated {esc(generated)}.</p>"
    )

    add('<div class="stats">')
    for value, label in (
        (f"{report['events']:,}", "events"),
        (f"{report['sessions']:,}", "sessions"),
        (esc(report["first"]), "first event (UTC)"),
        (esc(report["last"]), "last event (UTC)"),
    ):
        add(f"<div class='stat'><b>{value}</b><span>{label}</span></div>")
    add("</div>")
    add(f'<p class="note">{esc(sampling_note(report["worst_interval"]))}</p>')

    if report["daily"]:
        add("<h2>By day</h2>")
        add(
            '<p class="caption">Every event, by kind. A session is one browser '
            "tab: the id lives in <code>sessionStorage</code> and cannot follow "
            "anyone anywhere.</p>"
        )
        add('<div class="scroll"><table><thead><tr><th>Day</th>')
        for kind in KINDS:
            add(f'<th class="n">{kind}</th>')
        add('<th class="n">sessions</th></tr></thead><tbody>')
        for day, counts in report["daily"]:
            add(f"<tr><td>{esc(day)}</td>")
            for kind in KINDS:
                add(f'<td class="n">{counts.get(kind, 0):,}</td>')
            add(f'<td class="n">{counts.get("sessions", 0):,}</td></tr>')
        add("</tbody></table></div>")

    for section in report["sections"]:
        add(f"<h2>{esc(section.title)}</h2>")
        add(f'<p class="caption">{esc(section.caption)}</p>')
        if not section.rows:
            add(f'<p class="empty">{esc(section.empty)}</p>')
            continue
        head, note_head = section.columns
        # Searches have nothing to say beside the string somebody typed, so
        # that section is three columns rather than four with a blank one.
        annotated = any(row.note for row in section.rows)
        add('<div class="scroll"><table><thead><tr>')
        add(f"<th>{esc(head)}</th>")
        if annotated:
            add(f"<th>{esc(note_head)}</th>")
        add('<th class="n">count</th><th class="n">sessions</th>')
        add("</tr></thead><tbody>")
        for row in section.rows:
            add(f'<tr><td class="name">{esc(row.label)}</td>')
            if annotated:
                add(f'<td class="note">{esc(row.note)}</td>')
            add(
                f'<td class="n">{row.count:,}</td>'
                f'<td class="n">{row.sessions:,}</td></tr>'
            )
        add("</tbody></table></div>")

    add(
        "<footer>Counts are <code>SUM(_sample_interval)</code>, never "
        "<code>COUNT()</code>. Session counts are distinct ids and cannot be "
        "weighted, so under sampling they are a floor. Nothing here identifies "
        "anyone: no IP, no cookie, no <code>localStorage</code>. "
        "<code>docs/analytics.md</code> is the design, and §7 the known limits."
        "</footer>"
    )
    add("</main></body></html>")
    return "\n".join(parts)


# --- entry point ------------------------------------------------------------


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Read the beacon's Analytics Engine dataset, with names."
    )
    parser.add_argument(
        "--days",
        type=int,
        default=30,
        help="window in days (default 30; the dataset retains 92)",
    )
    parser.add_argument(
        "--limit", type=int, default=25, help="rows per section (default 25)"
    )
    parser.add_argument("--db", required=True, help="path to build/concestor.db")
    parser.add_argument("--out-dir", required=True, help="where the HTML page goes")
    parser.add_argument(
        "--no-html", action="store_true", help="print the summary and write nothing"
    )
    args = parser.parse_args()

    if args.days < 1:
        parser.error("--days must be at least 1")
    if args.days > RETENTION_DAYS:
        print(
            f"note: retention is {RETENTION_DAYS} days; asking for "
            f"{args.days} answers about the window that exists.",
            file=sys.stderr,
        )

    database = pathlib.Path(args.db)
    if not database.is_file():
        print(f"No database at {database}.", file=sys.stderr)
        return 1

    try:
        account = account_id()
        token = api_token()
        report = gather(account, token, database, args.days, args.limit)
    except ApiError as error:
        print(f"\n  {error}\n", file=sys.stderr)
        return 1

    print(render_text(report))

    if not args.no_html:
        generated = datetime.datetime.now().strftime("%Y-%m-%d %H:%M")
        page = pathlib.Path(args.out_dir) / f"report-{args.days}d.html"
        page.write_text(render_html(report, account, generated))
        print(f"HTML: {page}")

    return 0


if __name__ == "__main__":
    sys.exit(main())
