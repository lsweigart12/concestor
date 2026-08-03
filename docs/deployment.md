# Where Concestor runs

The decision is **all of it on Cloudflare**: one Worker serving the built
frontend as static assets, and `/v1/*` routed to a Container running the Go
read API unchanged — the same static binary, the same mmap'd `.npy` arrays, the
same `immutable=1` SQLite database, on a machine with a page cache.

This replaces the interim answer, which was frontend on Cloudflare and the API
in a container somewhere else with the Worker proxying to an `API_ORIGIN`. That
answer was correct when it was written and is no longer the best one: Cloudflare
Containers went generally available on **2026-04-13**, and an instance type with
4 GiB of memory and 8 GB of disk hosts this binary with room to spare.

Everything below was measured on 2026-08-02 against build `9bc853c7694f7551`,
or read off Cloudflare's own limits pages on the same day.

---

## 1. The premise, tested

> A Worker has a few hundred MB of memory and no mmap, so the binary as written
> does not port.

**True, and by a wider margin than that.** A Worker isolate is capped at
**128 MB**, not a few hundred, and that ceiling covers the JavaScript heap and
any WebAssembly allocation together. The artifact set the server opens at
startup is:

| Artifact | Size | Read by the server |
|---|---:|---|
| `build/concestor.db` | 1,925.0 MB | yes, `immutable=1` |
| `build/topology/` | 137.5 MB | 11 of the 13 arrays, mmap'd |
| `snapshot/phylopic/` (12,863 SVGs) | 155.9 MB | yes, served on request |
| the server binary, stripped for `linux/amd64` | 10.4 MB | — |
| **deployable payload** | **2,229 MB** | |

The payload figure is measured rather than summed: it is what
`scripts/deploy/push-api-image.sh` reports for the staged image context. Two
of the components are not what a casual `du` says — `du -sh snapshot/phylopic`
reports 173 MiB against 155.9 MB of actual bytes, because 12,865 small SVGs
round up to a lot of blocks, and it reports almost nothing at all inside a
worktree, where `build/` is a tree of symlinks.

Two corrections to `docs/handoff.md` §4 fall out of that table, neither of which
changes an argument:

- **The 2,004 MB figure is `concestor.db` plus the arrays, and it has drifted.**
  Today that pair is **2,048.9 MB**. The number moves with every pipeline run
  and `concestor-build package` reports it; treat it as a reading, not a
  constant.
- **It omits the silhouettes.** The server resolves `silhouette.svg_path`
  against `snapshot/phylopic` and serves the file. That is another **155.9 MB**
  that has to be wherever the binary is, and nothing had written it down —
  which matters precisely once, on the day someone sizes a container image from
  the artifact figure and every silhouette 404s.

So the binary does not port to a Worker, and no trimming makes it port. 128 MB
does not hold a 2.4M-name FTS5 index.

### What the binary actually needs

It needs a page cache, and it needs much less of one than the artifact size
suggests:

| | |
|---|---:|
| RSS immediately after startup | **361 MB** |
| RSS after 150 `/v1/path`, 64 `/v1/search`, 90 `/v1/random` | **463 MB** |
| virtual size | 444 GB |

**The working set is 0.46 GB against a 2.2 GB artifact set.** That is mmap
doing the thing it is for: the process maps everything and resides only what it
touches. It is also the number that decides the instance type, and it says
`standard-1` — 4 GiB — is generous rather than tight.

Startup, warm page cache: **0.78 s** from `exec` to the first `200` on
`/v1/about`, of which the store reports `took=498ms` for opening the database
and mapping the arrays.

### And what it costs to serve

| Endpoint | p50 | p95 | max |
|---|---:|---:|---:|
| `/v1/path/{key}` (60 random species) | **0.4 ms** | 0.6 ms | 0.9 ms |
| `/v1/search?q=` (16 queries × 4), before `fossil_fts` | 111 ms | 127 ms | 136 ms |
| `/v1/search?q=` (16 queries × 4), after | **0.1–15 ms** | — | — |
| `/v1/random?kind=species` | 167 ms | 174 ms | 187 ms |

`/v1/path` at **0.4 ms** is the number that rules out every design in §3. It is
41 dependent array reads and one batched database lookup — mean depth 41, and
60 entries for *Homo sapiens*. Any architecture that turns those reads into
network round trips is not a port of this endpoint; it is a different endpoint
with the same URL.

Search was worth one sentence because it was not what it looked like, and the
sentence turned out to be the whole story. The 111 ms was **flat against match
count** — `zzzqqq`, which matches nothing, cost 104 ms — which is the unindexed
full scan of the 523,112-row `fossil` table and not the FTS5 query at all.
Broken down, the scan was 100–117 ms of it and *every other stage of the
endpoint together* was under 25 ms. It is now indexed; `fossil-grafts.md` §7 is
the account, including what the index cannot match and why that is the right
trade.

**Two things in this document made that bug invisible for as long as it lasted,
and both are worth keeping in mind before trusting any figure here.** The first
is that every number in this section was measured on the machine the pipeline
runs on, and `standard-1` is **half a vCPU** — so a CPU-bound endpoint costs
several times more in production than it does here, and nothing local will say
so. The second is that a table of p50s hides a bimodal cost: 15 of the 16
queries were cheap and the endpoint's whole expense sat in a stage none of them
varied. Where an endpoint is suspected of being flat against its input, measure
the stages rather than the endpoint.

---

## 2. The decision

One Worker. Static assets for everything that is not `/v1/*`; a Container
binding for everything that is.

```
                 ┌─────────────────────── Cloudflare ───────────────────────┐
  browser ──────▶│  Worker ──┬── static assets (web/dist)                   │
                 │           └── /v1/*  ──▶ Container: the Go binary,       │
                 │                          concestor.db + arrays + SVGs    │
                 └──────────────────────────────────────────────────────────┘
```

What this buys, in the order the project cares about:

- **`web/src/api.ts` keeps fetching `/v1` same-origin**, and now does so by
  construction rather than by configuration. The container is reachable only
  through the Worker's binding — it has no public hostname to get CORS wrong
  about. The interim design kept the same invariant by proxying to an
  `API_ORIGIN` that somebody had to set correctly; this one has nothing to set.
- **The architecture survives intact.** `docs/architecture.md` §4 is one static
  binary over mmap'd arrays and read-only SQLite. That is exactly what runs. No
  second implementation of `induced_subtree`, no second copy of the ranking in
  `fts_test.go`, no reimplementation of `path()` in TypeScript. The three-places
  rule in CLAUDE.md stays at three places.
- **Version pinning stays structural.** The Go binary and the artifacts are the
  same image. The image tag is in `web/wrangler.jsonc`, so deploying the Worker
  is what selects which dataset is live, and reverting that tag and deploying
  reverts the pair. Serving v16.1 dates against a v15.1 topology remains
  impossible for the same reason it always was. **Not** `wrangler rollback` —
  §5 is why.
- **One provider, one bill, one place to look at a log.**

`API_ORIGIN` does not disappear — it is demoted to a **development override**.
When it is set the Worker proxies to it and ignores the container, which is what
makes `wrangler dev` usable against a locally running `scripts/serve.sh` instead
of requiring Docker and a 2.2 GB image on a laptop. It is empty in production
and the Worker prefers the binding whenever it is empty.

### Instance type and what it costs

| | `basic` | **`standard-1`** | `standard-2` |
|---|---:|---:|---:|
| vCPU | 1/4 | 1/2 | 1 |
| memory | 1 GiB | **4 GiB** | 6 GiB |
| disk | 4 GB | **8 GB** | 12 GB |
| headroom over a 463 MB working set | 2.2× | 8.8× | 13× |
| headroom over a 2,229 MB image | 1.8× | 3.6× | 5.3× |

**`standard-1`.** `basic` fits on both axes and fits nothing else; a 1 GiB
ceiling over a 463 MB working set means the first traffic pattern that touches
more of the database than this benchmark did starts thrashing, and the failure
mode is a page-fault storm rather than an error anyone can read.

Cost of keeping one `standard-1` awake continuously, at the posted rates
($0.0000025/GiB-s memory beyond 25 GiB-hours included, $0.00000007/GB-s disk
beyond 200 GB-hours, active-CPU $0.000020/vCPU-s beyond 375 vCPU-minutes):

| | |
|---|---:|
| memory, 4 GiB × 730 h | $26.06 |
| disk, 8 GB × 730 h | $1.42 |
| CPU, 10,000 searches at 111 ms | $0 (inside the included 375 vCPU-min) |
| Workers Paid | $5.00 |
| **per month** | **≈ $32.50** |

Active-CPU pricing is why the CPU line is zero: the container is billed for
cycles it uses, and this one is idle between requests. The memory line is the
whole bill, and it is the price of not cold-starting.

`sleepAfter` is the dial on that memory line, and it is set to **1h**. Letting
it sleep costs a **1–3 s** image cold start plus the measured **0.78 s** open on
the first request after every idle period, and this is an app whose first
interaction is someone typing a species name — so the value is bought with
someone's first impression, not with money alone.

An hour is the trade this project takes: a reader browsing the tree never meets
a cold start, a second visit within the hour does not either, and the container
stops billing overnight. It was 6h, which bought nearly every first impression
at the full $26.06. §6.1 is why the shorter value won — the owner's constraint
is a low ceiling rather than a low average, and this is the largest cost that
can be lowered without touching the architecture.

---

## 3. The alternatives, with what each costs

### D1

**Closer than it was, and still not it.** D1's maximum database size is now
**10 GB** on Workers Paid, so the 1,925 MB database fits with room, and it is
real SQLite with FTS5, so the ranking `fts_test.go` pins would survive. The
import path also works on paper: `wrangler d1 execute --file` accepts up to
5 GiB and this database's `.dump` is **2.54 GB**, measured.

Three things stop it, and only the third is about size.

- **The arrays have nowhere to live.** D1 is SQL and nothing else. `parent`,
  `depth`, `tip_count`, `age_ma`, `age_tier`, `age_layout`, `ott_to_idx` and the
  rest are 123.9 MB of raw little-endian values that the server reads by index.
  Expressing the 41-deep walk as SQL means a recursive CTE per request against a
  2.7M-row table, or 41 statements — and a D1 database executes queries
  **sequentially**, so at the 111 ms this app's heaviest query already takes,
  one database tops out near ten queries a second regardless of how many Workers
  are calling it.
- **D1 is mutable, and that breaks the release invariant.** The artifact set
  currently ships inside the thing that reads it. A D1 binding points at a live
  database that outlives any particular deploy, so shipping a new build means
  creating a new database, importing 2.54 GB into it, swapping the binding, and
  inventing a rollback story for the case where the swap was wrong. That is a
  distributed-systems problem introduced to serve data that never changes.
- **The FTS index would have to be rebuilt inside D1.** D1 does not accept a
  prebuilt SQLite file, and `.dump` cannot faithfully carry an FTS5 virtual
  table — Cloudflare's own documentation says export is unsupported for virtual
  tables. So the 2.4M-name index gets rebuilt from `INSERT`s through the SQL
  API, and `fts_test.go`'s pinned ordering has to be re-verified on the other
  side of a rebuild that nothing in this repo can run locally.

### R2 with range reads

A `.npy` file is a 128-byte ASCII header followed by raw values, so a range
request genuinely *is* an array read. That is the appeal and it is real.

It dies on dependency. `path()` cannot issue 41 reads in parallel, because
read *n* needs the index that read *n−1* returned. Even at an optimistic 10 ms
per range read — arithmetic, not a measurement, since there is no account to
measure against — that is **410 ms against a measured 0.4 ms**: three orders of
magnitude, on the endpoint the entire interaction is built from.

The honest counter is that you would not do it that way. `parent.npy` is
10.9 MB and would fit inside a 128 MB isolate, so the walk could be local and
the round trips would go to zero. But the walk is not what `/v1/path` returns —
it returns a name, rank, age, tier, tip count and silhouette for each of 41
entries, and those come out of a 1.9 GB database that does not fit in 128 MB by
a factor of fifteen. Solving the cheap half of the endpoint is not progress.

Worth keeping in view for a different reason: `docs/architecture.md` §4's
progressive client-side topology is this idea aimed at the client instead, where
it works, because the client already has the enrichment on screen.

### Durable Objects with SQLite storage

10 GB per object, and the SQL runs *inside* the object with no network hop —
which is the one thing R2 cannot offer and is genuinely interesting. It fails on
the same two counts as D1 and one of its own: the arrays still have no home, the
storage is mutable state that outlives a deploy, and a Durable Object is
single-threaded, so the 111 ms search serialises against every other request to
the same object.

### Hyperdrive

Not applicable. Hyperdrive pools connections to an external Postgres or MySQL,
and `docs/architecture.md` §4 rejected Postgres for reasons that have not
changed — nothing here needs a query planner, transactions, or concurrent
writes. Adding Hyperdrive would mean first adding the database it exists to
accelerate.

### Keep the API in a container off Cloudflare

Still a perfectly good answer, and it is what the interim configuration
assumed. It costs the same thing it always did: a second provider, a second
place to hold credentials, a public API origin, and one variable
(`CONCESTOR_API_ORIGIN`) whose wrongness is invisible until a user's browser
reports it. Cloudflare Containers removes those costs without removing anything
else, so this is now the fallback rather than the plan.

**It remains the immediate fallback**, and cheaply: the Worker keeps the
`API_ORIGIN` branch, so pointing production back at an external origin is a
repository variable, not a rewrite.

---

## 4. Trimming, and what it is actually worth

The brief asked whether trimming the artifact set turns an architecture problem
into a pipeline one. It does not — nothing in §3 is unlocked by getting under a
size threshold, because none of the refusals above are size refusals. But the
fat is real and it was worth measuring, so here is the number.

**`xref` is never read by the server.** The string does not occur anywhere in
`server/**/*.go`. It is phase 3's resolution table, it is a build-time artifact,
and it is the single largest thing in the database:

| | before | after |
|---|---:|---:|
| `concestor.db` | 1,836 MiB | **1,315 MiB** |
| deployable payload | 2,229 MB | **1,683 MB** |

`DROP TABLE xref; VACUUM;` removes **521 MiB** — 258.5 MB of table, 96.6 MB of
`xref_idx`, and 182 MiB of freelist pages that `VACUUM` reclaims on its own and
that nothing was ever using. The server was smoke-tested against the trimmed
database: `/v1/about`, `/v1/path`, `/v1/search` twice, `/v1/node`, `/v1/random`
and `/v1/timescale` all answer `200`, and the store logs `missing_arrays=[]`.

Three things to know before acting on that:

- **It is a packaging step, not a schema change.** `xref` must stay in
  `build/concestor.db`, because phase 4 and every future phase-3 consumer reads
  it. What should be trimmed is the *copy that goes into the container image*.
  Deleting it from the build would be deleting the evidence for
  `refuse_disagreements`.
- **It changes both build ids.** The trimmed database reported
  `98182ee940959298` from the store against the original's `9bc853c7694f7551`,
  which is correct and is the system working — these are different artifacts.
  The manifest's id would have to be re-stamped too, which is why the trim
  belongs in `package.py` and not in a deploy script. §5 has the two ids and
  why they differ.
- **Do not go looking for a second `xref`.** The next three tables down —
  `search_name` 220.5 MB, `broken_taxon` 180.7 MB, `node_image` 169.2 MB — are
  all read at runtime, and `node_fts_docsize` at 98.8 MB is what bm25 ranks
  with. There is one free 521 MiB here and no second one.

**`scripts/deploy/push-api-image.sh` deliberately does not do this.** A deploy
script that quietly ships a different database than the one the manifest
describes is exactly the failure the second bullet names. The trim belongs in
`package.py`, as a second packaged artifact with its own stamped `build_id`,
and until it is written there the image carries the whole database.

Whether to take it is a judgement about deploy time and disk, not about
feasibility: 1,683 MB fits `basic`'s 4 GB disk where 2,229 MB is uncomfortable
in it, and a smaller image cold-starts faster. It is worth doing and it is not
urgent.

---

## 5. How it deploys

### What actually runs `wrangler deploy`

**`release.yml` calls `deploy-web.yml` as a job**, once semantic-release has
published, passing the tag. Not a trigger on the release — `docs/ci.md` §4 is
the account, and the short version is that semantic-release publishes with
`secrets.GITHUB_TOKEN`, GitHub does not start workflows from events that token
raises, and the `on: release: [published]` line that used to sit in
`deploy-web.yml` therefore fired zero times in ten releases while every release
job stayed green.

Two things follow that matter when you go looking:

- **The production deploy log is in the Release run**, under a job called
  `deploy`. It is not in `deploy-web.yml`'s run list, which now holds pull
  request previews and hand-deploys only.
- **The tag is checked out, not main's tip.** The workflow takes it as an
  input and passes it to `actions/checkout`, so the deploy ships the commit the
  release notes describe — and therefore the container image tag *that commit*
  pins, which is the next three sections.

To deploy by hand — after a failed deploy job, or to put a specific version
back — run the **Deploy web** workflow manually and give it the tag. Leaving
the tag empty deploys the tip of whatever branch is chosen, which is rarely
what is wanted once a release exists.

### The image is built where the dataset is, and never in CI

This is the constraint that shapes everything else. The container image contains
2.2 GB of pipeline output that is not in the repository, not in a release, and
must never be produced in CI — `docs/ci.md` §5. So the image is built and pushed
from a machine that has `build/`, by hand or by a release script, and
`web/wrangler.jsonc` references it **by registry tag**:

```jsonc
"containers": [{ "class_name": "ReadApi",
                 "image": "registry.cloudflare.com/<account>/concestor-api:<build_id>-<commit>" }]
```

That form is load-bearing and was verified against wrangler 4.118.0 locally:

- With `"image": "./Dockerfile"`, **`wrangler deploy --dry-run` refuses to run
  without Docker** — the error is explicit that it builds the image even in a
  dry run. That would break the `cloudflare` job in `ci.yml`, which is the check
  keeping this whole design honest before there is an account.
- With a registry reference, the dry run completes with no Docker, no
  credentials and no network, printing the container it would use. That is the
  form CI can validate.

**Wrangler does not interpolate environment variables into the config.** A
literal `${CLOUDFLARE_ACCOUNT_ID}` passes straight through to the registry path.
So the account id is substituted into the config by the deploy workflow before
`wrangler deploy` runs, and the committed file carries a placeholder that the
dry run is happy to validate.

The image must be `linux/amd64`. The Go binary is already cross-compiled for
that target by `scripts/ci/build-release.sh`; the Docker build has to be told
too, on a machine that is very likely an arm64 Mac.

### There are two build ids, and they are not the same number

Worth knowing before the first deploy, because it looks like a bug and is not.
`concestor-build package` stamps `build/manifest.json` with a **content** hash —
`45ada2238ded2c93` on the build this was written against. `store.computeBuildID`
computes its own from the *name, size and mtime* of the arrays, the database,
`timescale.json` and `phase*_gates*.json`, plus the snapshot's `synth_id`, and
that one reported `9bc853c7694f7551` on the same files.

Both are right for what they do. The store's is what every ETag and long
`Cache-Control` on `/v1` keys on — with the code id beside it, see below — and
keying that on mtime is correct: it changes whenever the bytes on that disk
change, which is precisely when a cached response stops being valid. The manifest's is a *name* for an
artifact set, stable across copies.

So the image tag is the manifest's, and `/v1/about` will report the other one.
Two consequences: the store's id changes on every image rebuild even from
identical data, because `cp` does not preserve mtimes and the layer bakes in
whatever it got — which is harmless, since it only invalidates caches that were
about to be invalidated anyway. And the small JSON files matter: the Dockerfile
copies `snapshot/manifest.json` and the phase gate files not because the app
needs them to answer a query, but because leaving them out silently changes the
identity of the build.

### The tag is the build id *and* the commit, and it is committed

Pinning the tag in the config rather than deploying `:latest` is what keeps
rollback meaningful: shipping a new dataset is a commit that says which one,
and reverting to an old one is a commit that says which one. `:latest` would
make "roll back the frontend" silently also mean "keep the new database", which
is the class of mistake `docs/ci.md` §4 exists to prevent.

**To revert the dataset, revert the tag in this file and run `deploy`.** Not
`wrangler rollback` — this paragraph used to say a Worker version carries the
image reference that was live with it, and the first real deploy produced
Wrangler's own warning that it does not:

> Your Worker has Containers configured. Container configuration changes (such
> as image, max_instances, etc.) will not be gradually rolled out with
> versions. These changes will only take effect after running `deploy`.

So a version rollback reverts the Worker's *code* and leaves the container on
the newer image — which is the new dataset under old code, precisely the
mismatched pair the pinning exists to prevent, arriving through the mechanism
meant to prevent it. Cloudflare's [Rollouts] and [Rollbacks] pages do not
address the combination, so the warning is the only evidence and it has not
been tested against a second image. Treat `wrangler rollback` as unsafe here
until someone does test it.

[Rollouts]: https://developers.cloudflare.com/containers/platform-details/rollouts/
[Rollbacks]: https://developers.cloudflare.com/workers/versions-and-deployments/rollbacks/

**The tag used to name the dataset and not the image, and that cost two
releases.** It was the manifest's content hash over the artifact set alone, so
a change to the *server binary* — a version string, a bug fix — rebuilt to the
same tag and replaced what was in the registry under it, with nothing warning.
This paragraph predicted that and asked for a binary change that matters to
"ride with the next dataset or be pushed under a tag that says it does not name
one". Neither happened, and here is what it cost.

`Entry.Vernacular` shipped in #51, the commit that also gave the canvas its
labels switcher. The dataset did not move, so no image was pushed. Production
kept serving a binary compiled at #47: `/v1/path` carried no `vernacular` key
at all, `markName` read `undefined` and fell back to `node.name` for every
mark, and the canvas drew scientific names in **both** switch positions. The
common-name default and the toggle were not broken — they were rendering
identical strings. It survived review and two releases because every local
test passed, `/v1/search` has carried `vernacular` since long before #51 and so
kept showing common names, and `/v1/about` reported a `release` nobody read
against the frontend's.

The tag is now **`<build_id>-<commit>`**. A dataset rebuild and a code change
both mint a new tag, so an unchanged tag means an unchanged image, and rolling
the Worker back rolls the *server* back and not only the data. A tree with
uncommitted edits appends `-dirty`, and `push-api-image.sh` prints a warning
refusing to have it pinned: a tag naming no commit cannot be rebuilt, which is
the same reproducibility claim in the other direction.

The general lesson is worth more than the fix: **an artifact's name must cover
everything inside it.** Half a name is a mutable tag wearing an immutable
one's clothes, and it fails silently by construction — the registry cannot warn
about a collision it cannot see.

### Bootstrap order, once there is an account

Nothing here is configured, and per `docs/ci.md` §3 that costs nothing: every
deploy step is skipped while the credentials are unset. When they exist, the
order matters, because a Worker whose container image does not exist yet will
not deploy:

1. `scripts/deploy/push-api-image.sh` — build and push the image from a checkout
   that has `build/`. It prints the tag.
2. Commit that tag into `web/wrangler.jsonc`.
3. Set the repository secrets `CLOUDFLARE_API_TOKEN` and
   `CLOUDFLARE_ACCOUNT_ID`. The token needs *Edit Cloudflare Workers* **and**
   container registry write for step 1 to be runnable from anywhere but a
   laptop.
4. Merge. CI passes, semantic-release cuts the release, and the release's own
   `deploy` job deploys the Worker — which names the image.

`CONCESTOR_API_ORIGIN` stays unset in production. Setting it is the documented
way to point the whole thing back at an external API without redeploying
anything else.

### Caching

The Worker returns the container's response unmodified, and that is deliberate
for the reason it always was: `/v1` is long-lived and ETag'd by build id, and
**`/v1/random` is `no-store` with no ETag**, because caching it hands every
visitor the same "random" species forever.

`docs/architecture.md` §4 costs the design at "a CDN in front absorbs
essentially all traffic", and that is the mechanism that makes one container
instance enough. **The header alone did not buy it.** A Worker runs *before*
the zone cache and nothing puts its output back, so a response coming out of a
container binding was cached by the reader's own browser and by nothing else:
the same clade asked for by two readers was two container requests, and the
year on it was doing a session's work rather than a CDN's.

So `web/wrangler.jsonc` enables **Workers Cache** — `"cache": { "enabled":
true }`, which puts a tiered edge cache in front of the Worker, requires
wrangler ≥ 4.69.0, and is off unless asked for. Four things about it are worth
writing down, because each one is a decision this design had already taken and
the feature happens to agree with:

- **It decides from the response's own `Cache-Control`, per RFC 9111.** That is
  the rule this section used to state as a warning for whoever added caching
  later, and the mechanism now enforces it rather than a reviewer:
  `/v1/random`'s `no-store` is refused at the edge without anything in the
  Worker naming the path. The rule survives as a prohibition — nothing in
  `worker/index.ts` may grow into a list of cacheable paths, because a list of
  cacheable paths is a list somebody eventually forgets to add `/v1/random`'s
  successor to.
- **The cache key is path + query string + Worker version.** The query string
  matters or `/v1/search?q=` would answer every reader with the first reader's
  query. The *version* is what makes a one-year `s-maxage` safe on a URL that
  is not content-addressed: `/v1/node/{key}` is the same URL across builds, and
  what invalidates it is that a dataset change is a new image tag, a new image
  tag is a `deploy` (see above — it must be), and a deploy is a new version
  with an empty cache. **It is an argument about this cache and no other**,
  which is why the browser's `max-age` is an hour and not a year — see below. **`cross_version_cache` therefore stays off.** Turning it
  on to hold the hit rate across deploys would let a rollback serve the new
  build's JSON under the old build's code, which is exactly the mismatched pair
  the committed image tag exists to prevent.
- **Request collapsing comes with it.** A burst on a cold key runs the Worker
  once per data centre instead of once per reader, which is the one thing that
  made `sleepAfter = 1h` uncomfortable: the cost of a cold start used to be
  paid by however many people arrived during it.
- **A cache hit does not wake the container.** That is the money argument, not
  the latency one. §6.1 is why this project cares: there is no spend cap, so
  the ceiling is the share of traffic that never reaches the expensive thing.

**What is still unverified is the hit rate, not the mechanism.** Every `/v1`
path except `/v1/random` is cacheable and the popular ones repeat across
readers — `/v1/timescale` is fetched by every session and is a certain hit —
but this app's `/v1/path/{key}` traffic has a long tail by construction, and
nobody has measured what fraction of it repeats within a colo within a version.
`Cf-Cache-Status` and the Workers observability dashboard are where that gets
answered on the first deploy with real traffic.

### The ETag names the binary too, for the reason the image tag does

The section above says the cache is safe because a deploy resets it. The
**validator** was not, and the same half-a-name bug that cost two releases in
the registry was sitting in the response headers the whole time.

`api.etag` was `store.BuildID` alone. That id hashes the name, size and mtime of
the arrays, the database and the gate files, plus the snapshot's `synth_id` —
it is a pure function of the *dataset*, which is exactly what makes it right for
`/v1/about`'s `build_id` and wrong as the whole of an ETag. Nothing about the
binary is in it.

Observed on `concestor.com` after `v0.23.0`, which added an optional
`layout_spread` to `/v1/node` and moved no data:

```
$ curl -s https://concestor.com/v1/about | jq -r '.commit'          # cached
60036c0
$ curl -s -H 'Cache-Control: no-cache' 'https://concestor.com/v1/about?cb=1' | jq -r '.commit'
db76ae0                                                              # origin
```

`cf-cache-status: HIT`, `age: 610`, `etag: "5e08e162f6a877bd"` — the previous
build's id, which the *new* build would also have emitted.

The ETag is now **`"<build_id>-<code_id>"`**, the container tag's shape for the
container tag's reason, and the general lesson two subsections up applies
unchanged: *an artifact's name must cover everything inside it.* `code_id` is
the commit from `-X main.commit` where there is one, and otherwise
`dev-<12 hex>` over the executable's own path, size and mtime — computeBuildID's
trick applied to the binary, because a fallback constant would put the same
collision in the place nobody would look for it. **`computeBuildID` was
deliberately not touched**: the two ids stay two ids, `/v1/about` goes on
publishing them separately, and the ETag is the one place they are combined.

Three handlers wrote this pair of headers by hand — `writeJSON`,
`/v1/timescale` and `/v1/silhouette` — so the bug was in all three. They now go
through `stampCacheable`, which is also how the silhouette handler acquired the
`If-None-Match` check it had been missing.

### What that fixes, and what it does not

It fixes **revalidation**, which was not merely stale but actively wrong: a
client holding the old copy sent `If-None-Match: "<old build id>"`, the new
server compared it against a string that had not moved, and answered `304 Not
Modified` — confirming stale content over a build that no longer served it. The
edge does this too, so a stale entry could refresh its own freshness
indefinitely off a wrong 304. Every conditional request now gets the truth, and
two container instances mid-rollout can no longer be conflated.

It does **not** un-stick anything stored before it shipped. Those copies were
written under `max-age=31536000, immutable`, the URL has not changed, and a
browser holding one will not ask again — there is nothing to revalidate *with*.
They last until the year is out or the reader hard-reloads. The edge can be
purged and browsers cannot, and no header shipped later reaches them. This
mattered little in practice only because the app had no readers yet; on a live
audience it would have been a year of split-brain.

**And the hole was never only about past deploys, which is the part worth
carrying.** `immutable` on a URL that is not content-addressed is safe at the
edge *because the Worker version keys the cache* — that argument is above, and
it is sound. It never covered the browser. A reader who visited yesterday held
`/v1/node/ott770315` under a one-year `immutable`, and no *future* deploy would
have reached them either: the corrected ETag would have been a validator for a
request that is never sent. That is why the first of the two closures below is
not optional and was taken in the same change.

Two ways to close it, and the cheaper one is not the obvious one:

- **Bound the lifetime — done.** `/v1` now sends
  `public, max-age=3600, s-maxage=31536000` and no longer says `immutable`. The
  two numbers are the point: `s-maxage` is the edge's and stays a year, because
  a deploy is a new Worker version and the cache is keyed by version, so the
  argument above holds unchanged; `max-age` is the browser's, and an hour is
  what makes the corrected ETag worth having. The conditional request a browser
  then sends is answered by the edge out of its own fresh copy, so it costs a
  round trip to the nearest colo and **does not wake the container**, which is
  the cost that matters here (§6.1). If Workers Cache should turn out not to
  honour `s-maxage`, the failure is bounded and visible: edge entries expire
  hourly instead of yearly, the hit rate drops, and `Cf-Cache-Status` says so.
  The `-immutable` flag was renamed `-public-cache` with the header, because a
  flag named after a directive nothing sends is the same half-truth as an ETag
  naming half the build.
- **Version the URL** — `build_id` in the path or the query, so a new build is
  a new URL and nothing warm can be served. **Evaluated and refused.** It is the
  complete answer and it is the expensive one. The client learns the id *from*
  `/v1/about`, so either every `/v1` call queues behind an identity fetch on the
  boot path — spending the one thing the design protects, speed to a drawn tree
  — or the id is baked into the frontend bundle, which the Worker deploys on a
  different cadence from the container image (see the pinned tag above), so the
  bundle would pin an id the running API may not have and the server would have
  to 404 or ignore it. At the edge it buys nothing that the Worker version does
  not already buy, and it strands every entry on a rebuild rather than replacing
  it. It is the right shape for a static asset, which is why Vite already does
  it for the frontend's own files, and the wrong shape for an API a reader
  reaches by name.

### `/v1/about` is short-lived

`max-age=60, must-revalidate`, with the same ETag as everything else —
`api.writeShortLivedJSON`, and it is the third policy beside `writeJSON`'s hour
and `writeVolatileJSON`'s `no-store`.

About is a function of the build, so its validator was never wrong; the
*question* was. This is the endpoint a deploy check, a monitor or a person asks
"what is running", and a year-long `immutable` makes "the deploy did not land"
a permanent answer to it. The transcript above is what that looks like: ten
minutes and counting of a successful deploy reported as not having happened,
and indefinitely to a browser.

It is not `no-store`, which is what `/v1/random` needs and must keep. The store
counts about's age statistics at startup precisely because it is fetched on
**every page load**, so this is the boot path for every reader, and `no-store`
would also take request collapsing off it — on half a vCPU a cold burst is the
one thing worth collapsing (§2). A minute keeps the collapsing and bounds the
staleness to less than any deploy takes.

---

## 6. What this costs, stated plainly

- **Cold starts.** 1–3 s to start a container from stopped, plus 0.78 s to open
  the dataset. Traded against the memory bill by `sleepAfter`, which is 1h and
  therefore accepts one overnight cold start a day; not mitigated by anything
  clever. §6.1 is the reasoning.
- **No autoscaling.** Cloudflare's own docs say built-in autoscaling does not
  exist yet — the pattern is `getRandom(env.READ_API, N)` over a fixed *N*, and
  the routing is random rather than nearest. For this app, behind a long-lived
  cache, small *N* is fine, and the honest statement is that it is fine
  *because the traffic is small*, not because the platform solved it.
- **Placement is not the Worker's.** A container starts in the nearest location
  with a pre-fetched image, which is not necessarily where its Durable Object
  runs or where the reader is. Every `/v1` response except `/v1/random` is held
  at the edge for a year, so the second reader of anything pays nothing for
  that; the first one might.
- **Unverified end to end.** There is no Cloudflare account, so the Worker
  config, the container config and the cache behaviour are validated by
  `wrangler deploy --dry-run` on every pull request and by nothing else. That
  check is real — it caught the Dockerfile-needs-Docker behaviour above — and it
  is not a deploy.
- **The image has never been built.** No Docker daemon was running on the
  machine this was written on, so `scripts/deploy/push-api-image.sh` is verified
  as far as the staged build context — 2,229 MB, no symlinks, the right tag off
  the manifest — and `server/Dockerfile` has not been through `docker build`
  once. It is a short file over a binary that already runs, and it is still an
  unrun file. Expect to fix something in it on the first attempt; the thing to
  check first is that `/srv/snapshot/phylopic` landed beside `/srv/build`,
  because the server infers the silhouette mirror from `-build`'s parent and a
  wrong answer there is 12,863 silent 404s rather than an error.

### 6.1 There is no spend cap, and the ceiling is built rather than set

Read against Cloudflare's own billing docs on 2026-08-02. **Cloudflare offers no
hard spend limit on Workers or Containers.** The feature that sounds like one
says otherwise in as many words: *"Budget alerts are informational only. They do
not pause or cap usage."* They also fire the day *after* a threshold is crossed.
A budget alert is a smoke detector, not a circuit breaker, and nothing on this
platform will stop serving to protect a bill.

So the ceiling is a property of the configuration, and the useful thing is that
the costs split in two.

**Traffic-independent, and already capped** by `max_instances: 1` and a fixed
instance type. There is an arithmetic maximum and this is it:

| | worst case / month |
|---|---:|
| Workers Paid base | $5.00 |
| memory, 4 GiB × 730 h | $26.06 |
| disk, 8 GB × 730 h | $1.42 |
| CPU, half a vCPU pegged for the whole month | $25.83 |
| **ceiling** | **$58.31** |

**The container cannot run away.** That is worth stating plainly because it is
the part that reads as frightening and is not, and because `max_instances` is
doing the work — raising it multiplies this table directly.

**Traffic-dependent, and genuinely uncapped:** Workers requests at $0.30/M over
10M, Durable Object requests at $0.15/M over 1M — every `/v1` call is both — and
egress at $0.025/GB over 1 TB. Static asset requests are free and unlimited, so
the bundle costs nothing however often it is served and only `/v1/*` bills, which
is `run_worker_first`'s bill as well as its correctness. At a 5 KB mean response
that is $1.35 at 10M `/v1` requests, $41.85 at 100M and **$546.85 at 1G**. A
sustained denial-of-wallet attack here is a bad month, not a ruinous one, and
the number is bounded partly because one instance at half a vCPU can only serve
so fast.

Three consequences worth keeping:

- **The throttle belongs in the WAF, not in the Worker.** Requests blocked by a
  rate limiting rule never reach the Worker and are not billed — so a WAF rule
  cuts all three uncapped lines at once. The Workers rate-limiting *binding*
  cannot: it runs inside the Worker, so the request is already paid for when it
  answers, and it is per-location rather than global and documented as *"not to
  be used as an accurate accounting system"*. The rule in force is `/v1/*`, 100
  requests per 10 s per IP, which is the Free plan's one rule and its fixed
  10 s window.
- **The DO duration line is the one to watch on the first real bill.** No
  official page states whether a container's Durable Object accrues duration
  while the container is awake. If it does, one DO at the billed 128 MB for a
  full month is 336,384 GB-s against 400,000 included — inside, but 84% of the
  allowance, and that is an estimate rather than a measurement.
- **There is no automatic stop, so the stop is a procedure.** `wrangler delete`
  removes the Worker, takes both uncapped lines to zero immediately, and costs
  a redeploy to undo. Deciding that at 2am is worse than deciding it now.

## 7. What would reopen this

- **Container cold starts get worse, or the memory bill stops being worth it.**
  Then the fallback in §3 is one repository variable away, and it is the same
  architecture on someone else's machine.
- **Cloudflare ships a read-only, versioned, file-shaped store** — an R2-backed
  volume a container or a Worker can map, or a D1 that can be created immutable
  from an uploaded file. The refusals in §3 are all about mutability and round
  trips, not about size, and either of those would answer them.
- **The dataset stops fitting.** 20 GB is the largest disk on offer and the
  payload is 2.2 GB, so this is not close. It becomes interesting if generated
  outlines ever ship (`docs/phase5c-decision.md`), which is where the next large
  artifact would come from.
