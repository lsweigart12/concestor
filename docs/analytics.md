# What readers do, and how we know

Three questions: **what do people search for**, **what trees do they build**, and
**which taxa do they add**. Four instruments answer them, and they disagree by
design — report a range and name the instrument that produced it (§9.7).

---

## 1. Why the server cannot answer this alone

The edge request log (`httpRequestsAdaptiveGroups`) holds `clientRequestPath`,
and this API puts keys in the path, so `/v1/path/ott770315` and `/v1/node/{key}`
resolve cleanly against `build/concestor.db` into names. It counts cache hits.
But it does **not** hold:

- **The query string**, on any plan below Enterprise — so no search is
  recoverable from this dataset. (Workers Logs is the exception; §9.5.)
- **More than 8 days**, one day per query.
- **A tree.** A shared link is `/v1/paths?keys=…` (query string, invisible) or
  just `/`, and there is no app session to group by.

**Workers Logs** is the one place a query string survives retroactively
(`event.request.url` in full, 7 days). It is readable through Cloudflare's
`cloudflare-observability` MCP server, which carries its own OAuth — the wrangler
token returns `10000 Authentication error` against the telemetry API. The Worker
is **not invoked on a cache hit**, so it sees misses only, and that blind spot
widens as the cache works.

So the browser has to say what happened, because it is the only thing that knows.

---

## 2. Three events, and why only three

`web/src/analytics/beacon.ts` sends them; `web/worker/index.ts` writes them.

| Event | Fired when | Answers |
|---|---|---|
| `search` | a query settles — 1.5 s idle, or the palette closes | what people search for |
| `add` | a taxon is added *interactively* | which taxa people go looking for |
| `tree` | the selection settles at two or more, 2 s idle | what trees people build |

The rules that keep each event answering its question:

- **A prefix chain is one search.** The palette searches per keystroke; the
  **longest** string in a prefix chain is kept (covers typing forward and
  backspacing). `dog` → `cat` is two searches.
- **The palette closing flushes** the pending search, so a query submitted
  inside the idle window is recorded.
- **A tree is its set, sorted** — "human, whale" and "whale, human" are one row.
- **A tree of one is not a tree.**
- **A tree carries its `cause`**, so a received tree (`link`, `back`) is not
  counted as a made one (`add`, `remove`). An **opening emits no `add` events**:
  its taxa were chosen by us. An opening's cause is `open`, and it is one press
  and so one row.

The store is the only feed: one effect watches `view.keys`, so nothing changes
the canvas without the beacon seeing it, and an add that changed nothing is not
recorded.

---

## 3. The schema is positional

Analytics Engine has no column names — the SQL API reads `blob1`, `blob2`, … so
**inserting a field in the middle reinterprets every earlier row. Append only.**

| Column | Holds |
|---|---|
| `index1` | the kind — also the sampling key (§4) |
| `blob1` | kind: `search` \| `add` \| `tree` |
| `blob2` | subject: the query typed, or the key added. Empty on `tree` |
| `blob3` | tree: the sorted key set. Empty except on `tree` |
| `blob4` | cause: `add` \| `remove` \| `open` \| `link` \| `back` \| `clear` |
| `blob5` | session id — random, per tab, 8 chars |
| `double1` | keys in the tree, derived in the Worker from `blob3` |

Keys are in **API form** (`ott770315`, `mrcaott…`), so a row joins against
`/v1/path/{key}` and the edge log directly. `double1` is derived in the Worker
so it cannot disagree with `blob3`. Both sides truncate every string.

### What it does not collect

No identity, no IP, no cookie, no `localStorage`. **This is a claim about this
dataset only.** Workers Logs is a different store that holds the request's IP for
7 days (§9.4). The session id is a random 8-char string in `sessionStorage` —
per-tab, so a link opened tomorrow is a new session; it groups one reader's adds
into one tree and cannot follow anyone. A persistent `localStorage` id is
refused.

---

## 4. Reading it

```bash
curl "https://api.cloudflare.com/client/v4/accounts/$ACCOUNT/analytics_engine/sql" \
  -H "Authorization: Bearer $TOKEN" \
  --data "SELECT blob2 AS query, SUM(_sample_interval) AS n
          FROM concestor_events
          WHERE blob1 = 'search' AND timestamp > NOW() - INTERVAL '7' DAY
          GROUP BY query ORDER BY n DESC LIMIT 50"
```

The OAuth token `wrangler login` leaves behind authenticates the SQL API. A
minted API token needs **Account → Account Analytics → Read** (different from the
deploy permission). Retention is **three months**. The dataset is created by the
first write, through the binding, so no runtime token is involved. If a scheduled
job ever pulls reports, give it its own read-only secret rather than widening the
deploy token.

The three questions:

```sql
-- what people search for
SELECT blob2 AS query, SUM(_sample_interval) n FROM concestor_events
WHERE blob1 = 'search' GROUP BY query ORDER BY n DESC

-- which taxa people add
SELECT blob2 AS key, SUM(_sample_interval) n FROM concestor_events
WHERE blob1 = 'add' GROUP BY key ORDER BY n DESC

-- what trees people build, excluding the ones they were handed
SELECT blob3 AS tree, double1 AS size, SUM(_sample_interval) n FROM concestor_events
WHERE blob1 = 'tree' AND blob4 IN ('add', 'remove')
GROUP BY tree, size ORDER BY n DESC
```

**`SUM(_sample_interval)`, never `COUNT()`.** Analytics Engine samples per index
once volume is high, and `index1` is the *kind* so a chatty `search` never costs
`tree` its fidelity. A key is not a name; resolve against `build/concestor.db`.
§8 is the script that does all of this and prints names.

---

## 5. What it costs, and what it cannot break

- **No latency.** `writeDataPoint` does not return a promise.
- **No effect on caching.** The beacon is a `POST`, uncacheable per RFC 9111, so
  it adds no path the caching design has to special-case.
- **It is under `/v1/`** (what `run_worker_first` routes to the Worker), handled
  before both the `API_ORIGIN` branch and the binding, so it behaves identically
  under `wrangler dev`, against a local `serve.sh`, and in production.
- **A bad payload is dropped, not diagnosed:** `204`, except an over-long body
  which is `413`.
- **Rate limiting is already there** — the WAF `/v1/*` rule covers this prefix.
- **It cannot break the page:** every send is wrapped and failures are swallowed.
  Under `scripts/dev.sh` the beacon `404`s (Vite proxies `/v1` to the Go binary,
  which has never heard of it) and that costs nothing.

---

## 6. The retroactive pull

The edge log answers "which taxa" for the **8 days before the beacon shipped**
and only that window — one query per day, `clientRequestPath` grouped by count,
against `viewer.zones.httpRequestsAdaptiveGroups`, with a zone-analytics-read
token. Worth running once. Not worth automating, and its counts must not be added
to the beacon's — the edge log counts requests, which the client's in-process
cache already deduplicates.

---

## 7. Known limits

- **The cache blind spot in §1 does not apply to the beacon** — it fires whether
  `/v1` came from the container, the edge, or the client's in-process cache.
- **A tree is recorded once it settles**, so a tab closed within 2 s is caught
  only by `visibilitychange` (reliable on mobile Safari); a hard crash loses it.
- **The `cause` on a tree is the last mutator that ran**; a few internal state
  changes reuse whatever it was, so the `tree` string stays true but the cause is
  approximate.
- **Nothing is recorded about a fossil by the beacon** — grafts, drill-down and
  the fossil card are outside these three events (append to the schema, never
  insert). But a fossil card is a `GET /v1/fossil/{pbdb_taxon_no}` with the key
  in the path, so §1's edge log and §9's request record both see it and it joins
  to `fossil` in `build/concestor.db`.

---

## 8. The local report

`scripts/analytics-report.sh` reads the dataset and prints it **with names in
it** — which is its whole reason to exist, because Cloudflare ships no dashboard
for Analytics Engine and every hosted view would show `ott461645`.

```bash
scripts/analytics-report.sh                       # the last 30 days
scripts/analytics-report.sh --days 7 --limit 50
scripts/analytics-report.sh --no-html             # stdout only
```

Plain-text summary on stdout plus a self-contained HTML page at
`build/analytics/report-{N}d.html`. Names come from `build/concestor.db` (1.9 GB,
local, not something a hosted dashboard can join against). The join is
`node.node_key`, which carries the key in the exact API form the beacon sends —
**not** `node.ott_id` (splitting `ottNNN` back to an integer fails on every
`mrcaott…` row, whose `node.name` is NULL). A key that resolves to nothing prints
as itself: a divergence has no name of its own.

It prefers `$CLOUDFLARE_API_TOKEN`, falls back to the `wrangler login` token
(refreshing it by running wrangler when expired), takes the account id from
`$CLOUDFLARE_ACCOUNT_ID` or `wrangler whoami`, never prints a token, and resolves
the database through `scripts/lib/paths.sh` (so it borrows the main checkout's
copy in a worktree), opened `immutable=1`. It is standard-library `python3`
behind a bash entry point — an ops script outside the pipeline's ruff/ty scope,
because it must run in a checkout where `uv sync` never happened. It refuses to
run without `build/concestor.db` rather than printing keys.

Sections: top searches, most-added taxa, trees people **built** (`blob4 IN
('add','remove')`), trees people **arrived at** (`link`/`back`, shown
separately), and events + sessions by day. Counts are `SUM(_sample_interval)`;
the overview prints the largest interval so "no sampling" is stated not assumed.
Session counts (`COUNT(DISTINCT blob5)`) are a **floor** — a distinct count
cannot be sample-weighted.

---

## 9. Browsing it in Workers Observability

Analytics Engine has no dashboard, but the **Workers Observability** dashboard is
a real analytics browser (charts, a query builder, saved queries, CSV export)
whose Query Builder can group by any field stored in the logs. A `POST` body
never appears in request metadata, so `worker/index.ts` logs each accepted event
a second time as flat JSON beside the `writeDataPoint`:

```jsonc
{ "concestor": "beacon", "kind": "search", "subject": "whale",
  "tree": "", "cause": "", "session": "a1b2c3d4", "size": 0 }
```

Seven keys, no nesting (a nested object is one key holding JSON rather than seven
to group by), and the values are the validated, truncated variables — never the
parsed body.

**Where.** Dashboard → **Workers & Pages** → `concestor-web` → **Observability**;
the **Investigate** tab is the Query Builder.

### 9.1 Queries

The `concestor` marker field isolates these events from the Worker's other logs
— named for the project so it cannot match a line nobody wrote. Each question
wants **Visualize: COUNT** and **Group by** the named field:

```
concestor = "beacon" AND kind = "search"            → group by subject
concestor = "beacon" AND kind = "add"               → group by subject
concestor = "beacon" AND kind = "tree" AND (cause = "add" OR cause = "remove")
                                                    → group by tree
```

The openings (`cause = "open"`), the
big canvases (`size >= 5`), one reader's visit (`session = "…"`), divergence
adds (`startsWith(subject, "mrcaott")`), and trees holding one taxon
(`contains(tree, "ott770315")`) all follow the same shape.

**A beacon event cannot be grouped by geography** — the reader's IP/city/ASN
live on the *invocation* record, not the log record, and the Query Builder
groups rather than joins. The exact workaround: group the requests to the beacon
endpoint instead, since a `POST` to it happens only when there is an event:

```
$workers.event.request.path = "/v1/e"       → group by cf.city, cf.country, cf.asOrganization
```

The request record answers **who and where**, the log record answers **what**,
and they meet at the session. Neither can turn a key into a name — that is §8's
job (the local database). **Dashboard: how many, when, which shape. §8's report:
which animal.**

There is no query here for a fossil (§7): a graft lives in `sel=`/`f=`, never in
`view.keys`, which is the only thing the beacon reads.

### 9.2 Which surface answers which question

|  | Workers Logs | Analytics Engine |
|---|---|---|
| Retention | **7 days** (3 on Free) | **three months** |
| Reading it | a dashboard | SQL API, `scripts/analytics-report.sh` |
| Names | keys only | keys resolved to names |
| Sampling | head-based, off (§9.3) | per-index, weighted by `_sample_interval` |
| Good for | this week, exploring, charts | last month, the recurring report |

### 9.3 What it costs

```jsonc
"observability": {
  "enabled": true,
  "logs": { "invocation_logs": true, "head_sampling_rate": 1 },
},
```

`head_sampling_rate` **stays at 1**: below 1 it drops that share of requests
before anything they emit is stored, with no `_sample_interval` to weight by — a
wrong answer for analytics. On Workers Paid, 20M log events/month are included,
then $0.60/M; roughly 30 log events per reader puts the allowance near 22,000
readers/day. One request may carry `MAX_EVENTS` = 32 events, so the WAF `/v1/*`
rate limit is what bounds a single IP's exposure.

### 9.4 What the Worker's own logs hold about a reader

§3's "no identity" is true of the **dataset**. Workers Logs is a different store.
The trace event carries, under `event.request`, for **seven days**:

- **`cf-connecting-ip`** in full (and `x-forwarded-for`), the complete
  **`user-agent`**, and `cf`: `city`, `region`, `postalCode`, `latitude`,
  `longitude`, `timezone`, `asn`, `asOrganization`, `colo`,
  `verifiedBotCategory`, TLS fingerprints — every one a **groupable dimension**.
- The **full URL** with query string (broken out as `search.q`; §9.5).

Only `cookie` is redacted; the IP is not. So **for seven days, this Worker's logs
pair a reader's IP with the paths they asked for.**

- This did not start with §9 — `observability.enabled` and invocation logs have
  been on since the Worker shipped. §9 only made the logs a surface someone reads.
- **The beacon's own line holds none of it** — `/v1/e` is a `POST`, so its
  invocation-log URL is just `/v1/e`, and the seven logged fields are validated.
- **The lever is `"invocation_logs": false`**, not taken. It removes the
  platform's request record (IP, geo, fingerprints) but also every request's
  method, URL, status, CPU/wall time — the whole of what makes the Worker
  debuggable, and §1's only retroactive search source. The reason to refuse it
  today is a site with no accounts and nothing to correlate against; if that
  stops being true, this is the one line to change.

### 9.5 The query string is a field

`$workers.event.request.search.q` is indexed on its own — a search **is**
recoverable retroactively for seven days, without the beacon:

```
exists($workers.event.request.search.q)     → group by $workers.event.request.search.q
```

It is **not the same answer** as the beacon. The request log has no
prefix-collapsing rule, so it holds `ha`, `har`, `hard`, … each as its own row —
**the beacon says what a reader searched for, the log says what they typed.**
That makes it the one place to see **where a reader gave up**: a query typed to
completion that returns nothing (`hard maple`, a real name absent from the
corpus) looks identical to a working one in the beacon, but is visible here as a
chain that ran to its end. The corpus is not clean — `zzzqqq` is this project's
own benchmark, not a reader — and the per-keystroke record sits in the same store
as the IP, so it falls under §9.4's lever.

### 9.6 Telling a bot from a reader, on a Free zone

The real bot score is Enterprise-only and refused. `cf.verifiedBotCategory` is
all the platform names (a bot that declares itself and passes verification). The
discriminators that work are **`cf.asOrganization`** (residential carriers vs.
datacenter ASNs) and the **funnel**, because a scanner cannot fake its far end:

| Stage | Path | Note |
|---|---|---|
| Reached the edge | — | includes scanners |
| Invoked the Worker | any | |
| Fetched the build id | `/v1/about` | **not** "ran the JS" — a well-known URL scanners probe by name; most of its IPs are datacenter, single-request |
| Drew a tree | `/v1/silhouette/…` | the honest load signal — thousands of URLs only the running app knows to ask for |
| Searched / emitted an event | `/v1/search`, `/v1/e` | |

Read it with three corrections: `/v1/about` overcounts (scanners), the app's own
machines dominate `/v1/silhouette`, and **every stage undercounts unequally**
because a cache hit does not invoke the Worker (single-URL stages hide more
readers than many-URL ones). Unique IPs are not unique people (a household NATs
to one; a phone changing networks is two), and the store holds more than one
record per request — **compare unique-IP figures, treat raw counts as relative.**

### 9.7 Four instruments, disagreeing by design

A single readership number is always wrong. The four sources fail in different
directions:

- **The edge zone log** counts scanners as readers.
- **Workers Logs** is blind to every cache hit.
- **Web Analytics (RUM)** (`/cdn-cgi/rum`, `rumPageloadEventsAdaptiveGroups`
  under `viewer.accounts`, read via the `cloudflare-api` MCP server) counts
  visits and visitors with Cloudflare's own bot filtering — the right instrument
  for "how many actual people" — but its beacon is a third-party script
  (`static.cloudflareinsights.com`), so a content blocker drops it, and the
  reader most likely to block it is exactly the curious tinkerer this product is
  for. Its useful column is `refererHost` (the only place distribution is
  visible). It has never heard of a taxon key.
- **The app beacon** only exists once somebody acts.

**Report a range and say which instrument produced it. Do not reconcile them to a
single number.**
