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
  **no search is recoverable from this dataset**. Pro and Business do not change
  this. Workers Logs is the exception and §9.5 is the account — it indexes the
  query as a field of its own, and holds more of it than the beacon does.
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
full, for **7 days**. One caveat that was written here has since been paid off
and one has not.

**It is no longer dashboard-only.** The wrangler OAuth token does return `10000
Authentication error` against `/workers/observability/telemetry/*`, and that is
still true — but the token is not the only door. Cloudflare's
`cloudflare-observability` MCP server authenticates by its own OAuth flow and
reads the same store, keys, values and query builder alike. Measured
**2026-08-04**: it answers for `concestor-web` without this project minting or
holding any token at all.

**The Worker is still not invoked on a cache hit**, so it sees misses only:
today that is nearly everything (473 invocations against ~438 `/v1` edge
requests, a cold cache), and the blind spot widens exactly as the caching starts
working. That one is structural and no credential fixes it.

Both caveats are about reading the *request* log retroactively. Neither touches
§9, where the same store holds the beacon's own events because the Worker puts
them there: that is a dashboard rather than an API call, and a beacon is not a
side effect of a request being served.

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
  (a cold load of `?n=…`), `back`, and the three opening causes below, against
  `add` and `remove`. Counting them together would make one popular
  shared link look like a thing readers keep independently discovering. For the
  same reason an **opening does not emit `add` events**: its taxa were chosen by
  us, and counting them would pin whatever the openings happen to name to the top
  of "most added" for ever.
- **An opening has three causes, because it is pressed three ways.** `open` is
  the set drawn at once, which is what a reader who has asked for reduced motion
  gets; `sequence` is one whose taxa arrived one at a time and ran to the end;
  `sequence-cut` is one the reader interrupted. `web/src/state/sequence.ts` is
  the feature and this split is its instrumentation: the open question is
  whether a sequence that completes converts to a manual `add` more often than
  the other two, and the answer is what should decide whether per-step `reveal`
  copy is worth writing — fifteen openings times three to five beats — rather
  than an argument about it. The query is per `blob5`: the session's first
  `tree` row gives which arm it is in, and any later row with cause `add` is the
  conversion. Both new strings fit `blob4`'s 16 characters.
  **A sequence emits one row, not four.** Each step restarts `TREE_IDLE_MS`, so
  the intermediate canvases never settle; the row that lands carries the last
  mutator's cause, which is `sequence` for a completed run and `sequence-cut`
  for an interrupted one.

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
| `blob4` | cause: `add` \| `remove` \| `open` \| `sequence` \| `sequence-cut` \| `link` \| `back` \| `clear` |
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

**That is a claim about this dataset, and it stops there.** §9 writes each event a
second time as a structured log, and Workers Logs is a different store with
different contents: alongside what this Worker logs, the platform keeps its own
record of the request for seven days, and that record carries the reader's IP.
Nothing above became untrue — the beacon's rows hold no more than the table says,
and the log line §9 adds holds the same seven validated values — but the sentence
had to stop being about the whole Worker. §9.4 is what is in there, measured, and
the lever for taking it out.

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
SELECT name FROM node WHERE node_key = 'ott770315';   -- build/concestor.db
```

§8 is the script that does all of the above and prints names rather than keys.
Run that before writing any of this by hand.

---

## 5. What it costs, and what it cannot break

- **No latency.** `writeDataPoint` does not return a promise and does not extend
  the invocation.
- **No effect on caching.** The beacon is a `POST`, which is uncacheable per
  RFC 9111 without anyone deciding it should be. That matters because
  `docs/deployment.md` §5 lays down that nothing in `worker/index.ts` may grow
  into a list of paths the cache treats specially — a list somebody eventually
  forgets to add the next exception to. That list is empty now that `/v1/random`
  is gone, which makes the rule easier to keep and no less worth keeping. This
  adds a path the caching design does not have to know exists.
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
- **Nothing is recorded about a fossil**, *by the beacon*. Grafts, drill-down and
  the detail card are all outside these three events. They can be added — append
  to the schema, never insert. But the claim stops at this dataset: a fossil card
  is a `GET /v1/fossil/{pbdb_taxon_no}` and the key is **in the path**, so both
  §1's edge log and §9's request record see it, and `pbdb_taxon_no` joins
  straight to `fossil` in `build/concestor.db`. That is how the one non-local
  session of 2026-08-04 was reconstructed as far as *Diodorus scytobrachion*
  without a single beacon field naming a fossil. It is a weaker source in the
  usual two ways — 7 days, and blind to a cache hit — and it is not a reason to
  leave the schema as it is, but "invisible" was too strong.

---

## 8. The local report

`scripts/analytics-report.sh` reads the dataset and prints it with names in it.

```bash
scripts/analytics-report.sh                       # the last 30 days
scripts/analytics-report.sh --days 7 --limit 50
scripts/analytics-report.sh --no-html             # stdout only
```

A plain-text summary on stdout, and a self-contained HTML page at
`build/analytics/report-{N}d.html` whose path it prints. `build/` is gitignored,
the page has no external assets, and it opens from the filesystem.

The page goes beside the database it resolved against, which in a worktree is
the main checkout's `build/`, and deliberately not the worktree's own.
`scripts/check.sh` links `build/` into a worktree *only when there is none
there* and sets `CONCESTOR_REQUIRE_BUILD=1` either way, so a worktree-local
`build/` holding nothing but a report would leave the link unmade and 82 Go
tests failing for want of a database two directories away. `CONCESTOR_REPORT_DIR`
overrides the location.

**Names are the whole reason it exists.** Cloudflare ships no dashboard for
Analytics Engine at all — a SQL API, a Grafana integration, and querying from a
Worker — and every one of those would show `ott461645`, and a tree as
`ott461645,ott478542`. What turns those into *Apis mellifera* and *Apis
mellifera + Octopoda* is `build/concestor.db`: 1.9 GB, local, and not something
a hosted dashboard can join against. That is why this is a script in this
repository rather than a board somewhere else.

The join is one column, and the obvious one is wrong. `node.node_key` carries
the key in exactly the API form the beacon sends — `ott461645` and
`mrcaott2ott3973` alike — and is indexed for it. Splitting `ottNNN` back into an
integer to meet `node.ott_id` resolves half the keys and silently fails on the
rest, because **`node.name` is NULL on every `mrcaott…` row** rather than
holding the key. A key that resolves to nothing prints as itself, which is the
answer rather than a fallback: a divergence has no name of its own.

Nothing has to be set up, per §4. It prefers `$CLOUDFLARE_API_TOKEN` and falls
back to the token `wrangler login` left behind, refreshing that one by running
wrangler when it has expired — an expired token is a `wrangler login` away and
should say so rather than 401 obscurely. The account id comes from
`$CLOUDFLARE_ACCOUNT_ID` or `wrangler whoami`, never from a tracked file, for
the reason `web/wrangler.jsonc`'s `ACCOUNT_ID` placeholder exists. No token is
printed anywhere, including in an error. The database is resolved through
`scripts/lib/paths.sh`, so it borrows the main checkout's copy in a worktree,
and is opened `immutable=1`.

Plain `python3` behind a bash entry point, outside the pipeline's ruff/ty scope
on purpose and standard library only — `scripts/ci/go-test-summary.py`'s header
is the reason. It is an ops script, not pipeline code, and it has to run in a
checkout where `uv sync` has never happened.

### What it shows, and what it cannot

Four sections are §2's three questions, plus a count by day:

- **Top searches**, **most-added taxa** with every key resolved, and **trees
  people built**.
- **Trees people arrived at**, separately. That is §2's last rule made visible
  rather than silent: the built list is `blob4 IN ('add', 'remove')`, and a
  `link` or `back` tree gets its own heading — filtering it away without saying
  so would leave a reader unable to tell an unpopular week from a well-shared
  one.
- **By day**: events per kind, and sessions.

There is no fifth question. Three events cannot answer one, and nothing here is
derived from a metric the beacon does not send.

Two numbers to read carefully:

- Counts are `SUM(_sample_interval)`, never `COUNT()`, per §4. The overview
  prints the largest interval seen, so *no sampling in this window* is stated
  rather than assumed.
- **Session counts are a floor.** `COUNT(DISTINCT blob5)` counts the ids that
  survived sampling, and a distinct count cannot be weighted. At today's volume
  the interval is 1 and the two agree; they will not always.

It refuses to run without `build/concestor.db` rather than falling back to
printing keys, on `scripts/serve.sh`'s rule. A report whose every row reads
`ott461645` is the thing this replaces, and a missing database would read as an
empty week.

---

## 9. Browsing it

§8 exists because Analytics Engine has no dashboard — a SQL API, a Grafana
integration, and querying from a Worker, and that is the whole list. It still
has none. What changed is that the **Workers Observability** dashboard became a
real analytics browser — charts, a query builder, saved queries, CSV export, a
query language in the search bar — and the one sentence that makes it usable
here is that *the Query Builder can use any field you store in your logs as a
key to visualize, filter and group by.*

A `POST` body never appears in request metadata, so none of this could see the
beacon. So `worker/index.ts` logs each accepted event a second time, as flat
JSON, beside the `writeDataPoint` it already made:

```jsonc
{ "concestor": "beacon", "kind": "search", "subject": "whale",
  "tree": "", "cause": "", "session": "a1b2c3d4", "size": 0 }
```

Seven keys, no nesting — a nested object would be one key holding JSON rather
than seven keys to group by — and the values are the same variables
`writeDataPoint` is given on the line above, after validation and truncation.
Never the parsed body: an unknown kind never reaches either writer, every string
is capped, and a log holding unchecked input from the open internet is a log you
cannot trust when you read it back. The body cap is 8 KB and a single log is
capped at 256 KB, so this is a correctness argument rather than a size one.

**Where.** Cloudflare dashboard → **Workers & Pages** → `concestor-web` →
**Observability**. The account-wide Observability tab shows every Worker at
once; the **Investigate** tab is the Query Builder.

### 9.1 Queries

The search bar takes free text or field queries: `=`, `!=`, `>`, `>=`, `<`,
`<=`, `:` (contains), the functions `contains()`, `startsWith()`, `regex()` and
`exists()`, and `AND` / `OR` / `NOT`. Everything below is that language, not a
description of it.

```
concestor = "beacon"
```

That is the one filter that isolates these events from the Worker's other logs,
which is what the marker field is for — the key is the project's name rather
than something plausible like `event` or `type`, so it cannot start matching
lines nobody wrote. The three questions, each of which then wants **Visualize:
COUNT**, **Group by** the field named:

```
concestor = "beacon" AND kind = "search"            → group by subject
concestor = "beacon" AND kind = "add"               → group by subject
concestor = "beacon" AND kind = "tree" AND (cause = "add" OR cause = "remove")
                                                    → group by tree
```

The third repeats §2's last rule: `add` and `remove` are the trees people
*built*, and dropping the filter mixes in the ones they were handed. Ask for
those on their own with `cause = "link" OR cause = "back"`.

The openings, which is the split `state/sequence.ts` was instrumented to settle:

```
concestor = "beacon" AND kind = "tree" AND startsWith(cause, "sequence")
concestor = "beacon" AND kind = "tree" AND cause = "open"
```

Group the first by `cause` and it separates a run that finished from one the
reader cut. **The conversion question is not answerable here**, and that is a
property of the surface rather than of the fields: "did a session whose first
`tree` row said `sequence` later emit a row with cause `add`" is a join from a
session to its own later rows, and the Query Builder groups and counts rather
than joining. That query belongs in §4's SQL, per `blob5`.

**And a beacon event cannot be grouped by geography, which is the tempting
query and the one this section came close to promising.** The seven fields above
group cleanly against each other — `concestor`, `kind`, `cause`, `session`,
`size` — but filter to `concestor = "beacon"` and group by
`$workers.event.request.cf.country` and the result is **empty**, not sparse.
The reason is that the beacon's `console.log` writes a *log* record and the
reader's IP, city and ASN live on the *invocation* record, and the same
groups-rather-than-joins property refuses to bridge them. Measured 2026-08-04
against every `cf.*` field tried.

The workaround costs nothing and is exact, because the beacon has an endpoint of
its own: **group the requests to `/v1/e` instead of the events inside them.**

```
$workers.event.request.path = "/v1/e"       → group by cf.city, cf.country, cf.asOrganization
```

A `POST` to that path happens only when there is an event to send, so its
request record is a reader who *did* something, carrying the geography the log
record cannot. What it cannot tell you is *which* of the three things they did —
for that, read the two sides separately and accept that they meet at the
session rather than in a row. This is the same division of labour §9.1 already
draws, one level down: the request record answers **who and where**, the log
record answers **what**.

Some others that have earned their place:

```
concestor = "beacon" AND size >= 5                     -- the big canvases
concestor = "beacon" AND session = "a1b2c3d4"          -- one reader's whole visit
concestor = "beacon" AND kind = "add" AND startsWith(subject, "mrcaott")
                                                       -- adds of a divergence
concestor = "beacon" AND contains(tree, "ott770315")   -- trees holding one taxon
NOT exists(concestor)                                  -- everything that is not this
```

There is no query here for a fossil, and there cannot be: §7's last limit holds
unchanged. A graft lives in `sel=` and `f=`, never in `view.keys`, and
`store.ts` feeds the beacon from `view.keys` alone — so no graft has ever
reached these three events, and a new browsing surface does not change what was
sent.

**A key is not a name, here as everywhere.** The dashboard will group `ott770315`
and `ott461645,ott478542` and cannot do otherwise: what turns those into *Homo
sapiens* and *Apis mellifera + Octopoda* is a 1.9 GB local database no hosted
dashboard can join against. That is §8's whole argument and it is unchanged. The
division of labour that follows is the useful one — **the dashboard answers how
many, when, and which shape; §8's report answers which animal.**

### 9.2 Which surface answers which question

|  | Workers Logs | Analytics Engine |
|---|---|---|
| Retention | **7 days** (3 on Free) | **three months** |
| Reading it | a dashboard, in a browser | SQL API, `scripts/analytics-report.sh` |
| Names | keys only | keys resolved to names |
| Sampling | head-based, off (§9.3) | per-index, weighted by `_sample_interval` |
| Good for | this week, exploring, charts | last month, the recurring report |

Neither replaces the other and the Analytics Engine write stays. A month-old
question has only one store that can answer it, and a "what happened yesterday"
question should not need a token, a SQL string and a local database.

### 9.3 What it costs

`web/wrangler.jsonc` now writes the logs configuration out in full, although
both keys are already the default:

```jsonc
"observability": {
  "enabled": true,
  "logs": { "invocation_logs": true, "head_sampling_rate": 1 },
},
```

`head_sampling_rate` is the one to have written down. Below 1 it drops that share
of **requests** before anything they emit is stored, and nothing in the output
says so — there is no `_sample_interval` to weight by, the way §4's dataset has.
As a debugging setting that is a saved byte. As an analytics setting it is a
wrong answer, so it stays at 1 and lowering it is now a decision somebody takes
rather than a default they inherit.

The arithmetic, on **Workers Paid** — which this account is on, Containers
requiring it, whatever the zone's own Free plan says:

- **20 million log events a month included**, then **$0.60 per additional
  million**. That is about 658,000 a day.
- One log per accepted event, plus one invocation log per request. §1 measured
  ~500 invocations on the first day. A reader who searches twice, adds three
  taxa and settles one tree emits six events, which `FLUSH_MS` batches into two
  or three requests — under ten log events for the visit, plus an invocation log
  for each `/v1` call that missed the edge cache.
- Reckon **30 log events per reader** and the included allowance is about
  **22,000 readers a day**. A day that ran a million events over the line would
  cost 60 cents.
- The account-wide ceiling is **5 billion a day**, past which everything drops
  to a 1% sample for the rest of that day — silently, and for every Worker on
  the account. That is ~7,600× the included daily allowance and seven orders of
  magnitude above what this app emits today.

One multiplier is worth naming rather than rediscovering: a single request may
carry `MAX_EVENTS` = **32** events, so 33 log lines. What bounds that is the WAF
rule in `docs/deployment.md` §6.1 — `/v1/*`, 100 requests per 10 s per IP — and
one IP sitting exactly on it is 864,000 requests a day, which at full batches is
~28 million log events: the month's allowance in an afternoon. The exposure is
not new (those same requests already write those same 32 data points to
Analytics Engine) and the answer is the same rule, which drops the request before
the Worker ever runs.

### 9.4 What the Worker's own logs hold about a reader

§3 says the beacon collects no identity, no IP, no cookie. That is true of the
dataset. **Workers Logs is a different store**, and this section is why §3 now
says where its claim stops.

Measured on **2026-08-03**, `wrangler tail concestor-web --format json` against
the deployed Worker with one ordinary browser request. The trace event — the
object Workers Logs deserializes and indexes — carries, under
`event.request`:

- **`cf-connecting-ip`**, the reader's address in full, and `x-forwarded-for`
  repeating it.
- The complete **`user-agent`**.
- **`cf`**: `city`, `region`, `postalCode`, `latitude`, `longitude`, `timezone`,
  `asn`, `asOrganization`, `colo`, and TLS client fingerprints
  (`tlsClientRandom`, `tlsClientExtensionsSha1`).
- The **full URL**, query string included — which is §1's reason Workers Logs
  is the one retroactive source that sees a search at all.

Exactly one header is redacted: `cookie` arrives as the literal string
`REDACTED`. The IP does not.

So, plainly: **for seven days, this Worker's logs pair a reader's IP with the
paths they asked for.** Three things about that are worth being exact on.

- **This did not start with §9.** `observability.enabled` has been true since the
  Worker shipped, and invocation logs are on by default; the request record was
  already being kept. What §9 changes is that the logs became a surface someone
  is meant to *read*, and a surface nobody reads is still a store. A section that
  turns logs into the analytics browser cannot leave this unwritten.
- **The beacon's own line holds none of it.** `/v1/e` is a `POST`, so the URL in
  its invocation log is `/v1/e` and nothing more — the payload is in the body,
  which no log holds — and the seven fields in §9's line are the validated ones.
  The identifying material is the platform's record of the request, not ours.
- **The lever is `"invocation_logs": false`**, and it is not taken. It removes
  the platform's request record — which takes the IP, the geolocation and the
  fingerprints with it — and takes with it every request's method, URL, status,
  outcome, CPU and wall time. That is the whole of what makes this Worker
  debuggable, and §1's note that Workers Logs is the only place a query string
  survives retroactively. The trade is a real one and the reason to refuse it
  today is that the data is Cloudflare's ordinary request handling, held for a
  week, on a site with no accounts and nothing to correlate against. If that
  stops being true — a login, a second data source, anything that could join an
  IP to a person — this is the line to change, and it is one line.

The honest limit on the measurement **has since been closed, and the
conservative reading was right.** The paragraph here used to say that
enumerating the keys Workers Logs actually stores would need the observability
telemetry API, which refuses the wrangler token. §1's MCP server reaches it, so
on **2026-08-04** the keys were enumerated rather than inferred from the trace
event. Every field named above is indexed under its own key —
`headers.cf-connecting-ip`, `cf.city`, `cf.region`, `cf.postalCode`,
`cf.latitude`, `cf.longitude`, `cf.timezone`, `cf.asn`, `cf.asOrganization`,
`cf.colo`, `cf.tlsClientRandom`, `cf.tlsClientExtensionsSha1`, and
`headers.user-agent` — so these are not merely *ingested*, they are **groupable
dimensions**, which is a stronger statement than this section originally made
and in the same direction. Two additions the trace event did not reveal:
`cf.verifiedBotCategory`, and the query string broken out as `search.q`, which
§9.5 is about. Stating the larger thing was the right way round, and the
measurement did not have to be walked back.

### 9.5 The query string is a field, and it holds more than the beacon does

`$workers.event.request.search.q` is indexed on its own. Not the URL with the
query in it — the value of `q`, as a groupable dimension:

```
exists($workers.event.request.search.q)     → group by $workers.event.request.search.q
```

That is the correction to §1. A search *is* recoverable retroactively, for seven
days, without the beacon and without Analytics Engine.

**And it is not the same answer.** §2's first rule collapses a prefix chain to
one search on purpose, because recording what the palette *ran* would answer
"what do people search for" with `w`, `wh`, `wha`, `whal`, `whale`. The request
log has no such rule and never did, so it holds exactly that: measured
2026-08-04, `ha`, `har`, `hard`, `hard ma`, `hard map`, `hard mapl`,
`hard maple`, each as its own row. The beacon is right about the question it
answers and this does not replace it — **the beacon says what a reader searched
for, the log says what they typed.**

The second is worth having for one thing the first cannot show: **where a reader
gave up.** A query typed to completion that returns nothing looks identical in
the beacon to one that worked — `hard maple` is a real common name for *Acer
saccharum* absent from the corpus, and `ardvark` is a typo the front door does
not forgive. Both are visible here as a chain that ran to its end and stopped,
and neither is distinguishable in `blob2` alone.

Two consequences to carry. `zzzqqq` in this data is `fossil-grafts.md` §7's own
benchmark rather than a reader, so **the corpus is not clean** and anything
counted off it should exclude the strings this project types at it. And a
per-keystroke record of what readers type sits in the same store as their IP,
which is a larger claim than §3 makes about the dataset and belongs under §9.4's
rule rather than this one: it is not something the beacon collects, it is
something the platform already logged, and `"invocation_logs": false` remains
the single lever over all of it.

### 9.6 Telling a bot from a reader, on a Free zone

**The real bot score is not available and no amount of querying finds it.** The
zone refuses the dimension in the same shape it refuses the query string:
*"zone … does not have access to the field 'botscoresrcname'"*. Bot Management
is Enterprise and this is a Free zone.

What Workers Logs does carry is **`cf.verifiedBotCategory`**, which is narrower
and honest about it — a bot that declares itself and passes Cloudflare's
verification. Measured 2026-08-02→04 across 4,591 invocations: **14 requests
from 1 IP**, all `Search Engine Crawler`. That is the whole of what the platform
will name.

So the discriminator that actually worked was **`cf.asOrganization`**, and it
worked well: residential carriers on one side, and on the other Palo Alto
Networks, three Amazon organisations, HostRoyale, Datacamp, Linode, two OVH
ranges, UAB code200, a Tor exit and an AS registered as `yyysqeortiwa`. None of
those is a reader and none of them declared itself a bot.

**The better instrument is the funnel, because a scanner cannot fake the far end
of it.** Each stage is one path, and the drop between stages is the measurement:

| Stage | Path | Unique IPs |
|---|---|---|
| Reached the edge | — | 237 / 113 per day |
| Invoked the Worker | any | 52 |
| Fetched the build id | `/v1/about` | 38 |
| Drew a tree | `/v1/silhouette/…` | 22 |
| Searched | `/v1/search` | 8 |
| Emitted an event | `/v1/e` | 8 |

**Read that table with two corrections, both of which cost something the first
draft of this section claimed.**

*`/v1/about` is not "ran the JavaScript".* It is a single well-known URL on an
API, which is exactly what a scanner probes by name, and the ASN breakdown says
so: of its 38 addresses, roughly 26 are datacenter — Palo Alto Networks, three
Amazon organisations, three OVH ranges, Linode, HostRoyale, UAB code200,
webshield.com, Rica Web Services, Cogent, a Tor exit — and almost every one of
them made a single request and went no further. The same zone log shows
`/.env` fetched 28 times, which is what that traffic is. `/v1/silhouette` is the
honest load signal, because it is thousands of URLs that only the running app
knows how to ask for.

*And even 22 is not 22 readers.* Several of those datacenter ASNs **do** appear
at the silhouette stage — webshield.com, Linode, HostRoyale, Rica Web Services,
Amazon — so some of this traffic executes JavaScript and renders. Meanwhile
Verizon and Cox account for 7 addresses and **90% of all silhouette requests**,
which is this project's own machines. Subtract both ends and the number of
distinct outside readers who have ever drawn a tree is around **eight**.

The cache does not rescue this and does not wreck it either, but it must be
stated or the table reads as more precise than it is: **every stage undercounts,
and they do not undercount equally.** A cache hit does not invoke the Worker, so
each row is a floor whose depth depends on how many distinct URLs the stage has.
Measured 2026-08-03→04: `/v1/about` **38%** hit, `/v1/timescale` 30%,
`/v1/silhouette/*` **25%**, `/v1/search` 10%. The single-URL stages hide more
readers than the many-URL ones, so the drop from 38 to 22 is if anything
understated — which is why the explanation had to come from ASN composition
rather than from the shape of the funnel.

Two further cautions. Unique *IPs* is not unique people in either direction: a
household NATs to one and a phone changing networks is two. And a request count
here is not a request — the store holds more than one record per request
(`cf-worker` alongside `cf-worker-event`), so **compare unique-IP figures and
treat the raw counts as relative**.

### 9.7 Web Analytics is already running, and nothing here said so

The zone log shows **`/cdn-cgi/rum` taking 171 requests** over 2026-08-03→04.
That is Cloudflare Web Analytics' beacon, injected at the edge, and it means a
third source has been collecting alongside the two this document is about since
before any of it was written.

It is worth knowing precisely because of what §9.6 is: it counts *visits* and
*visitors* rather than IPs, applies Cloudflare's own bot filtering, and needs
none of the ASN reasoning above. It cannot do what §8 does — it has never heard
of a taxon key, so no row in it will ever say *Apis mellifera* — and it is not a
substitute for either store. But for the one question this document answers
worst, **how many actual people**, it is the right instrument and it is free.

It is read in the dashboard under **Analytics & Logs → Web Analytics**, and by
API. `/accounts/{id}/rum/*` refuses the token `wrangler login` leaves behind —
`10000 Authentication error` — but the `cloudflare-api` MCP server carries its
own credential and reaches both the site list and the GraphQL datasets. The site
is `auto_install: true` on the zone and `lite: true`, which is the Free tier.
The data lives in **`rumPageloadEventsAdaptiveGroups`** under `viewer.accounts`,
filtered by `siteTag`: `count` is page views and `sum { visits }` is visits.

Measured 2026-08-02→04: **100 page views, 83 visits**, against the edge's 237
unique IPs in a single day. Three countries, not the edge's 36. And the useful
column is `refererHost`, because it is the only place in any of these stores
where **distribution** is visible: 80 visits direct, 17 internal, **2 from
`www.google.com`** and **1 from `teams.public.onecdn.static.microsoft`** — the
first organic search arrivals and the first evidence of the link being pasted
into somebody's chat.

**It has its own blind spot, and it is the opposite of the Worker's.** The
non-local session of 2026-08-04 that §7 followed as far as *Diodorus
scytobrachion* **does not appear in this dataset at all** — its country is
missing from the breakdown. A beacon served from `static.cloudflareinsights.com`
is a third-party script, so a content blocker or a privacy-minded browser drops
it, and the reader is gone from RUM while remaining fully visible in §9.6's
request log. That is not a small caveat for this product: the reader most likely
to block it is the tinkerer most likely to enjoy the thing. So the three sources
fail differently — the edge log counts scanners as readers, RUM discards readers
who block scripts, and the Worker sees neither what the cache served nor what it
was never asked for. **Do not reconcile them to a single number.** The honest
statement of outside readership on 2026-08-04 is a range of a handful, and the
range is the answer.
