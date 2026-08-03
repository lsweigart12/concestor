# What readers do, and how we know

Three questions: **what do people search for**, **what trees do they build**, and
**which taxa do they add**. This is how each is answered, what the answer costs,
and — the part worth reading before proposing anything — which of them no
server-side log can answer at all.

Everything below was measured against the live account on **2026-08-03**, against
zone `concestor.com` (created 2026-08-02, **Free** plan) and Worker
`concestor-web`. Do not re-research the plan limits; they are recorded here
because two of them are surprising.

---

## 1. Why the server cannot answer this

The obvious design is to read the request log. It was tried first, and it
answers one of the three questions and one half of another.

**What the edge log does hold.** `httpRequestsAdaptiveGroups` carries
`clientRequestPath`, and this API puts keys in the path, so `/v1/path/ott770315`
and `/v1/node/{key}` are legible: a day's traffic resolved cleanly against
`build/concestor.db` into *Mus musculus*, *Homo habilis*, *Aves*, *Carcharodon
carcharias* and the rest. It also counts **cache hits** — 272 hit against 286
miss in the first day — so the caching design costs this source nothing, which
is the opposite of the usual worry.

**Three things it does not hold, all measured:**

- **The query string, on any plan below Enterprise.** The API refuses the
  dimension outright: *"zone … does not have access to the field
  'clientrequestquery'"*. So `/v1/search?q=whale` reads as `/v1/search`, and
  **no search is recoverable**. Pro and Business do not change this.
- **More than 8 days.** *"cannot request data older than 1w1d"*, and a single
  query may span at most **1 day** — so it is one call per day, and anything not
  pulled inside the window is gone.
- **A tree.** A tree is a *set* of selections and the server never sees one. A
  single add is `/v1/path/{key}`, but a shared link is `/v1/paths?keys=a,b,c` —
  the keys are in the query string, and therefore invisible by the first bullet
  — and the `?sel=` link itself is just `/`. There is also no session to group
  by: `sessionIdHash` exists in the dataset and is not an app session.

**And the cache holds nothing readable.** The edge cache stores responses keyed
by URL; it cannot be enumerated, and the top-URL Cache Analytics report is
Enterprise. "Read it back out of the cache" is not a thing that exists — the
request *log* is the retroactive source, and §6 is how to pull it.

**Workers Logs** (enabled, `observability.enabled`) is the one place a query
string survives retroactively: the trace event carries `event.request.url` in
full, for **7 days**. Two caveats make it a poor primary source. It is
dashboard-only unless a token carrying Workers Observability read is minted —
the wrangler OAuth token returns `10000 Authentication error` against
`/workers/observability/telemetry/*`. And **the Worker is not invoked on a cache
hit**, so it sees misses only: today that is nearly everything (473 invocations
against ~438 `/v1` edge requests, a cold cache), and the blind spot widens
exactly as the caching starts working.

So: the browser has to say what happened, because it is the only thing that
knows.

---

## 2. Three events, and why only three

`web/src/analytics/beacon.ts` sends them; `web/worker/index.ts` writes them.

| Event | Fired when | Answers |
|---|---|---|
| `search` | a query settles — 1.5 s idle, or the palette closes | what people search for |
| `add` | a taxon is added *interactively* | which taxa people go looking for |
| `tree` | the selection settles at two or more, 2 s idle | what trees people build |

Five rules decide what is and is not an event. Each of them is a way the naive
version answers the question wrongly rather than incompletely.

- **A prefix chain is one search.** The palette searches per keystroke, so
  recording what it ran would answer "what do people search for" with `w`, `wh`,
  `wha`, `whal`, `whale`. One string being a prefix of the other covers typing
  forward *and* backspacing, which is the whole of what happens inside a single
  search — and the **longest** is kept, so backspacing out of `dogs` still
  records `dogs` rather than `dog`. `dog` → `cat` is two searches and is
  recorded as two.
- **The palette closing flushes it.** Otherwise a reader who types `axolotl` and
  presses Enter inside the idle window is recorded as having searched for
  nothing — which is precisely the search that worked.
- **A tree is its set, sorted.** "human, whale" and "whale, human" are one row in
  the answer. Selection order is real state and is in the URL, but it is not what
  makes two readers' trees the same tree.
- **A tree of one is not a tree.** It has no divergence in it and the `add` that
  made it is already recorded. Counting it would answer "what trees" with a list
  of species.
- **A tree carries its cause, and a received tree is not a made one.** `link`
  (a cold load of `?n=…`), `back`, `open` (one of the nine canned openings),
  against `add` and `remove`. Counting them together would make one popular
  shared link look like a thing readers keep independently discovering. For the
  same reason an **opening does not emit `add` events**: its taxa were chosen by
  us, and counting them would pin whatever the openings happen to name to the top
  of "most added" for ever.

The store is the only feed. Every mutator sets `cause` and changes `view.keys`,
and one effect watches `view.keys` — so there is no path that changes the canvas
without the beacon seeing it, and an add that changed nothing (a key already
selected) is not recorded, because the diff is against what was actually on
screen.

---

## 3. The schema, which is positional

Analytics Engine has no column names. The SQL API reads `blob1`, `blob2`, … so
**inserting a field in the middle silently reinterprets every row written before
it.** Append only.

| Column | Holds |
|---|---|
| `index1` | the kind — also the sampling key, see §4 |
| `blob1` | kind: `search` \| `add` \| `tree` |
| `blob2` | subject: the query typed, or the key added. Empty on `tree` |
| `blob3` | tree: the sorted key set. Empty except on `tree` |
| `blob4` | cause: `add` \| `remove` \| `open` \| `link` \| `back` \| `clear` |
| `blob5` | session id — random, per tab, 8 chars |
| `double1` | keys in the tree, derived in the Worker from `blob3` |

Keys are in **API form** (`ott770315`, `mrcaott…`), not the URL's compact form,
so a row joins against `/v1/path/{key}` and against the edge log without anyone
having to know that `770315` and `ott770315` are the same taxon.

`double1` is derived in the Worker rather than sent, so it cannot disagree with
the string it describes. Both sides truncate every string — the client so a long
paste is never sent, the Worker because the client is the open internet.

### What it does not collect

No identity, no IP, no cookie, no `localStorage`. Analytics Engine stores what is
written and nothing else, and nothing here writes anything about a person.

The session id is a random 8-character string in **`sessionStorage`**, on exactly
the reasoning that put bioluminescence there (`store.ts`): per-tab means a link
opened tomorrow is a different session, which is what a session *is*. It exists
to group one reader's adds into one tree and it cannot follow anyone anywhere. A
persistent id in `localStorage` would be a different thing legally and morally,
and is refused.

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

**Nothing has to be set up to read this.** Verified on 2026-08-03: the OAuth
token `wrangler login` already leaves in
`~/Library/Preferences/.wrangler/config/default.toml` authenticates the SQL API
— `SHOW TABLES` and `SELECT 1` both answer `200`. A minted API token needs
**Account → Account Analytics → Read**, which is a different permission from
the one that deploys. Retention is **three months**.

**And nothing has to be set up to write it.** The Worker writes through the
binding, so no token is involved at runtime, and the dataset is created by the
first write. `CLOUDFLARE_API_TOKEN`'s existing *Edit Cloudflare Workers* covers
uploading a script that declares one more binding — Cloudflare documents an
extra permission where binding needs one (Secrets Store requires **Edit**, and
fails at deploy without it) and documents none here. If a scheduled job ever
pulls reports, give it its **own** secret rather than widening the deploy
token: read-only reporting should not ride on the credential that can replace
the Worker.

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
once volume is high, and a sampled row stands for several. This is the same trap
the edge dataset sets — `sampleInterval` there reached 1.25 on a day with barely
a thousand requests — and the reason `index1` is the *kind* is so that a chatty
`search` never costs the rarer `tree` its fidelity.

A key is not a name. Resolve against the shipped database:

```sql
SELECT name FROM node WHERE ott_id = 770315;   -- build/concestor.db
```

---

## 5. What it costs, and what it cannot break

- **No latency.** `writeDataPoint` does not return a promise and does not extend
  the invocation.
- **No effect on caching.** The beacon is a `POST`, which is uncacheable per
  RFC 9111 without anyone deciding it should be. That matters because
  `docs/deployment.md` §5 lays down that nothing in `worker/index.ts` may grow
  into a list of paths the cache treats specially — a list somebody eventually
  forgets to add the next `/v1/random` to. This adds a path the caching design
  does not have to know exists.
- **It is under `/v1/`** because that is what `run_worker_first` routes to the
  Worker. A second glob would be a second thing to keep in step. The container
  never sees it: the handler runs before both the `API_ORIGIN` branch and the
  binding, so it behaves identically under `wrangler dev`, against a local
  `scripts/serve.sh`, and in production.
- **A bad payload gets dropped, not diagnosed.** Malformed JSON, an unknown
  kind, an oversized body: `204`, except an over-long body which is `413`. A
  beacon is fire-and-forget, the client cannot act on a `400`, and a status code
  is not the place to teach anyone the schema.
- **Rate limiting is already there.** The WAF rule in `docs/deployment.md` §6.1 —
  `/v1/*`, 100 requests per 10 s per IP — covers this path because it covers the
  prefix. A request blocked at the WAF never reaches the Worker and is not
  billed.
- **It cannot break the page.** Every send is wrapped; a failure is swallowed.
  In `scripts/dev.sh` the beacon `404`s, because Vite proxies `/v1` to the Go
  binary which has never heard of it. That is expected and costs nothing.

---

## 6. The retroactive pull, which is a separate thing

The edge log answers "which taxa" for the **8 days before the beacon shipped**,
and only for that window — it is not a backfill of the other two questions and
never can be. One query per day, `clientRequestPath` grouped by count, against
`viewer.zones.httpRequestsAdaptiveGroups`. `/v1/path/{key}` is an add and
`/v1/node/{key}` is a card opened. It needs a token with zone analytics read.

Worth running once. Not worth automating: the beacon answers the same question
better from the day it ships, and the two counts must not be added together —
the edge log counts requests, which the client's own in-process cache already
deduplicates within a session.

---

## 7. Known limits

- **The cache blind spot in §1 does not apply here**, and that is the point of
  the design rather than a happy accident. The beacon is not a side effect of a
  request being served; it is the browser reporting what the reader did, so it
  fires whether `/v1` came from the container, from the edge, or from the
  client's own in-process cache.
- **A tree is recorded once it settles**, so a reader who builds a canvas and
  closes the tab within 2 s is recorded only by `visibilitychange`, which fires
  reliably on mobile Safari where `unload` does not. A hard crash loses the
  event.
- **The `cause` on a tree is the last mutator that ran**, and a few internal
  state changes (dropping a broken taxon, dropping an unresolvable fossil id)
  reuse whatever it was. They cannot change what is on screen, so the `tree`
  string stays true; the cause on those rows is approximate.
- **`search` records what the palette ran**, which is at least
  `MIN_QUERY` characters. A one-letter query is not recorded because the server
  never searched it.
- **Nothing is recorded about a fossil.** Grafts, drill-down and the detail card
  are all outside these three events. They can be added — append to the schema,
  never insert.
