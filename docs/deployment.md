# Where Concestor runs

**All of it on Cloudflare.** One Worker serves the built frontend as static
assets and routes `/v1/*` to a Container running the Go read API — the same
static binary, the same mmap'd `.npy` arrays, the same `immutable=1` SQLite
database.

```
                 ┌─────────────────────── Cloudflare ───────────────────────┐
  browser ──────▶│  Worker ──┬── static assets (web/dist)                   │
                 │           └── /v1/*  ──▶ Container: the Go binary,       │
                 │                          concestor.db + arrays + SVGs    │
                 └──────────────────────────────────────────────────────────┘
```

The binary does not port to a Worker: a 128 MB isolate cannot hold a 2.4M-name
FTS5 index. The deployable payload is ~2.2 GB (database + arrays + PhyloPic
SVGs, the last resolved against `snapshot/phylopic` and served on request). The
process mmaps everything and resides only what it touches — working set ~0.46 GB
after real traffic, startup ~0.8 s from `exec` to first `200`.

## Instance type

**`standard-1`** — half a vCPU, 4 GiB memory, 8 GB disk. `basic` (1 GiB) leaves
too little headroom over the working set and thrashes as a page-fault storm.
`max_instances: 1` caps the traffic-independent cost; raising it multiplies the
bill directly.

`sleepAfter` is **1h**. Sleeping costs a 1–3 s image cold start plus ~0.8 s to
open the dataset on the first request after idle, paid by a reader's first
impression. An hour means a browsing reader never meets a cold start and the
container stops billing overnight.

`API_ORIGIN` is a **development override**: when set, the Worker proxies to it
and ignores the container, which is what makes `wrangler dev` usable against a
local `scripts/serve.sh`. Empty in production; the Worker prefers the binding
when empty. It is also the immediate fallback for running the API off Cloudflare
— a repository variable, not a rewrite.

## How it deploys

**`release.yml` calls `deploy-web.yml` as a job** once semantic-release has
published, passing the tag. Not a trigger on the release: semantic-release
publishes with `secrets.GITHUB_TOKEN`, and GitHub does not start workflows from
events that token raises.

**A merge does not deploy.** `release.yml` runs on a daily train (16:00 UTC) or
the Release button, so production moves once per release rather than once per
releasable merge — `docs/ci.md` §4.

- **The production deploy log is in the Release run**, under a job called
  `deploy`. `deploy-web.yml`'s own run list holds PR previews and hand-deploys
  only.
- **The tag is checked out, not main's tip** — the deploy ships the commit the
  release notes describe, and the container image tag that commit pins.

To deploy by hand, run the **Deploy web** workflow manually and give it the tag.
An empty tag deploys the tip of the chosen branch.

### The preview is a second Worker

Cloudflare does not generate preview URLs for a Worker that implements a Durable
Object, and `ReadApi` (the container class) is one. So `concestor-web` cannot
have a preview URL; `preview_urls: false` is written in `web/wrangler.jsonc`.

**`web/wrangler.preview.jsonc` is the answer**: a second Worker,
`concestor-preview`, with no container, no Durable Object and no migration — so
Cloudflare generates its preview URLs — serving the branch's `web/dist` and
proxying `/v1` to `https://concestor.com` via `worker/index.ts`'s `API_ORIGIN`
branch. `worker/preview.ts` is the entry point; it re-uses `index.ts`'s `fetch`
and does not re-export `ReadApi`, which is what makes it preview-eligible.

```
  browser ──▶ pr-42-concestor-preview.<subdomain>.workers.dev
                 │  the branch's dist, as static assets
                 └── /v1/* ──▶ concestor.com ──▶ production Worker + cache + container
```

- **No second container.** `/v1` is production's, cache and all, so a preview
  usually does not wake the container.
- **A preview cannot show a `server/` or `pipeline/` change** — the API is
  production's binary over production's dataset. To see a server change, push an
  image and deploy it.
- **The preview Worker must exist before a version can be uploaded to it:**
  `npx wrangler deploy -c wrangler.preview.jsonc`, once. It is deployed with no
  routes and `workers_dev: false`; everything anybody looks at is an alias.
- **Two ways to get one.** A PR previews under `pr-<N>` and the URL is commented
  onto it. A branch with no PR runs the **Deploy web** workflow with
  `preview_alias` filled in — which makes that dispatch a preview instead of a
  deploy. Exercise the dispatch path from `main`: if the input fails to arrive
  the run reads as a production deploy, and from `main` that costs nothing.

## The container image, and its two cadences

**The image is a dataset and a binary, and they do not move together.** The
dataset is ~2.2 GB of pipeline output that is not in the repository and **must
never be produced in CI** (`docs/ci.md` §6); it changes when the pipeline runs.
The binary is ~10 MB and changes on every release. Welded into one hand-built
image they drifted, and the drift was silent: production ran a pre-#51 server
for two releases because shipping a 10 MB change meant rebuilding 2.2 GB on a
laptop.

So the image is two images.

| | Built by | Where | Cadence | Tag |
|---|---|---|---|---|
| **data base** | `scripts/deploy/push-data-image.sh` | a checkout with `build/` | pipeline runs | `concestor-data:<build_id>` |
| **API** | `deploy-web.yml`, `Assemble the API image` | CI, every production deploy | releases | `concestor-api:<build_id>-<release>` |

`server/Dockerfile.data` is the first. It has no binary, no `USER`, no
`EXPOSE`, no `ENTRYPOINT` — **it cannot be run**, which is the point: a runnable
image with a stale binary in it is the drift this split exists to end.

The second is `crane mutate` against the remote base: append one layer, set the
four directives, push. The registry already holds the 2.2 GB and dedupes blobs
across repositories in an account, so **the whole assembly is ~7 s and uploads
about 10 MB** (measured 2026-08-08, including the crane download). Pulling the
base to run `docker build` was the fallback design and would have cost minutes;
`server/Dockerfile.api` is that fallback, kept for local and emergency rebuilds,
and the two must stay equivalent.

`web/wrangler.jsonc` references the API image **by registry tag**:

```jsonc
"containers": [{ "class_name": "ReadApi",
                 "image": "registry.cloudflare.com/ACCOUNT_ID/concestor-api:<build_id>-RELEASE" }]
```

The registry-reference form is load-bearing: with `"image": "./Dockerfile"`,
`wrangler deploy --dry-run` refuses to run without Docker, which would break the
`cloudflare` CI job. With a registry reference the dry run completes with no
Docker, no credentials and no network — the form CI validates.

- **`ACCOUNT_ID` and `RELEASE` are substituted at deploy time; `<build_id>` is
  committed.** Wrangler does not interpolate env vars into its config, and the
  placeholders are what let the dry run validate this file on a checkout with no
  account. The build id stays committed because pinning the dataset is what
  makes a rollback roll the data back too.
- **Nothing has to exist at the API tag when it is committed.** The deploy
  checks, and builds it if it is missing.
- The image must be **`linux/amd64`**. The Go binary is cross-compiled; the data
  image's Docker build is told too, on what is likely an arm64 machine.
- **`--provenance=false` on that Docker build is not optional.** BuildKit's
  default attaches an attestation, which makes the pushed artifact an *index* of
  two manifests rather than one image, and `crane mutate` refuses an index.
  Without it every release fails at assembly with a media-type error that says
  nothing about where it came from.

### Two build ids

`concestor-build package` stamps `build/manifest.json` with a **content** hash —
a stable name for an artifact set. `store.computeBuildID` computes its own from
the name, size and mtime of the arrays, database, `timescale.json` and gate
files, plus the snapshot's `synth_id` — the id every ETag and `Cache-Control`
on `/v1` keys on. Both are correct for their job; `/v1/about` reports both. The
data image tag is the manifest's. `Dockerfile.data` must copy
`snapshot/manifest.json` and the phase gate files, because leaving them out
silently changes the store's identity of the build.

### The tag is `<build_id>-<release>`, and only the first half is committed

A dataset rebuild and a release both mint a new tag, so an unchanged tag still
means an unchanged image, and rolling the Worker back rolls the *server* back
and not only the data.

The halves are pinned differently on purpose. `<build_id>` is **committed**: it
is a choice, taken when a new dataset is ready, and reverting the file reverts
the data. `<release>` is **derived** from the tag being deployed, so it is not a
choice at all and cannot be forgotten. A hand tip-deploy (empty `release_tag`)
names it with `git describe --tags --always --dirty`, so a tip three commits
past `v0.6.0` assembles `…-v0.6.0-3-gabc1234` rather than claiming to be the
release.

**To revert the dataset, revert the pin in `web/wrangler.jsonc` and run
`deploy`.** Not `wrangler rollback`: Wrangler warns that container config changes
(image, `max_instances`) are not rolled out with versions and only take effect
on `deploy`, so a version rollback would leave the container on the newer image
— the new dataset under old code. Treat `wrangler rollback` as unsafe here.

**The staleness check that used to belong here is gone, and nothing replaced
it,** because there is nothing left to be stale. The binary in the deployed
image is compiled from the deployed tag on every release. What survives is the
opposite question — is the *dataset* the local one? — and `scripts/check.sh`
answers it as an observation, never a failure: a rebuilt local `build/` is the
normal state of a machine that runs the pipeline.

### The dirty-tag and stale-manifest hazards are gone

Two hazards lived in the local binary build and died with it. A `--dirty` tag
named no commit and could not be rebuilt, so the script had to warn against
pinning it. And a single-phase pipeline rerun without `package` left
`build/manifest.json` stale, so the tag's dataset id was a lie. Neither is
reachable now: the local script names only the dataset, and the release half is
minted by CI from a tag.

### The ETag names the binary too

`api.etag` is **`"<build_id>-<code_id>"`**. `store.BuildID` alone is a pure
function of the dataset, so a code-only change would have revalidated `304` on
stale content. `code_id` is the commit from `-X main.commit` where there is one,
else `dev-<12 hex>` over the executable's path, size and mtime. `writeJSON`,
`/v1/timescale` and `/v1/silhouette` all stamp through `stampCacheable`.

### Shipping a new dataset

1. `CLOUDFLARE_ACCOUNT_ID=… scripts/deploy/push-data-image.sh` — from a checkout
   that has `build/`. It prints the pin.
2. Commit that pin into `web/wrangler.jsonc`. It rides the next train like any
   other change.
3. The release's `deploy` job assembles `concestor-api:<new build_id>-<tag>` and
   ships it. Nothing else is run by hand.

Bootstrapping an account from nothing is the same list with the two repository
secrets — `CLOUDFLARE_API_TOKEN` (*Edit Cloudflare Workers* **and** container
registry write) and `CLOUDFLARE_ACCOUNT_ID` — set between 2 and 3. Every deploy
step is skipped while they are unset (`docs/ci.md` §3).

### Rebuilding the image without CI

The emergency procedure, for a registry-side assembly that has stopped working
or a machine with no network to GitHub. It needs Docker and the data base:

```bash
CLOUDFLARE_ACCOUNT_ID=… scripts/deploy/push-data-image.sh      # if the base is missing
mkdir -p /tmp/api && cd server
CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -trimpath \
  -ldflags "-s -w -X main.version=$(git describe --tags --always) -X main.commit=$(git rev-parse --short HEAD)" \
  -o /tmp/api/concestor-server .
docker build --platform linux/amd64 \
  --build-arg DATA_IMAGE=registry.cloudflare.com/<account>/concestor-data:<build_id> \
  -f server/Dockerfile.api -t registry.cloudflare.com/<account>/concestor-api:<build_id>-<version> /tmp/api
npx --prefix web wrangler containers push registry.cloudflare.com/<account>/concestor-api:<build_id>-<version>
```

It pulls the 2.2 GB base, which is why it is not the normal path. The result is
the same image `crane mutate` produces — `Dockerfile.api` and the assembly step
are two spellings of one operation, and changing either means changing both.

## Caching

The Worker returns the container's response unmodified: `/v1` is long-lived and
ETag'd by build id, and the response decides its own lifetime. `web/wrangler.jsonc`
enables **Workers Cache** (`"cache": { "enabled": true }`, wrangler ≥ 4.69.0),
a tiered edge cache in front of the Worker.

- **It decides from the response's own `Cache-Control`, per RFC 9111.** Nothing
  in `worker/index.ts` may grow into a list of cacheable paths; a cacheable path
  is a list somebody forgets to add the next exception to.
- **Cache key is path + query string + Worker version.** The version is what
  makes a one-year `s-maxage` safe on a URL that is not content-addressed: a
  dataset change is a new image tag, a new tag is a `deploy`, a deploy is a new
  version with an empty cache. **`cross_version_cache` stays off** — turning it
  on would let a rollback serve new JSON under old code.
- **Request collapsing** runs the Worker once per data centre on a cold key.
- **A cache hit does not wake the container**, which is the money argument on a
  platform with no spend cap.

`/v1` sends `public, max-age=3600, s-maxage=31536000` and does **not** say
`immutable`. The `s-maxage` year is the edge's (safe by the version key); the
one-hour `max-age` is the browser's, so a browser's conditional request is
answered by the edge from its own fresh copy — a round trip to the nearest colo
that does not wake the container.

### A deploy is two things and they are not atomic

`wrangler deploy` returns as soon as the Worker version is live. The Container
then pulls a ~2.2 GB image behind it — **~3 minutes**. Workers Cache is keyed by
Worker version, so the new version begins with an empty cache, and every request
in that gap is answered by the **old** container and stored under the **new**
version's key wearing the year `s-maxage` gives it.

**The remedy is manual.** After an image deploy, wait until `/v1/about` reports
the pinned commit, then deploy again — a new version, a new empty cache, filled
by the build that is actually running:

```bash
curl -s -H 'Cache-Control: no-cache' https://concestor.com/v1/about | jq -r .commit
gh workflow run "Deploy web" -f release_tag=<the tag just released>
```

That is the whole purge mechanism: Workers Cache has no purge API, and a new
version is a new keyspace. Only needed where the image tag changed. Do not
automate this by polling `/v1/about` from a GitHub runner — those IPs cannot
reach `concestor.com` (bot protection), so the poll reads "cannot see the site"
as "still rolling". The container cannot be rolled first: it is named *by* the
Worker config.

### `/v1/about` is short-lived, and it is the boot probe

`max-age=60, must-revalidate`, same ETag as everything else. It is fetched on
**every page load**, so a year-long lifetime would make "the deploy did not
land" a permanent answer. `must-revalidate` at 60 s means the request reaches
the origin on every boot, so `/v1/about` is the app's **warm-up** as well as its
identity check — the frontend asks it *first* to start the wake a round trip
earlier. It is also the **health probe**: the old `/healthz` probe read the
app's own HTML shell (nothing routes a non-`/v1/*` path to the container) and
reported the API healthy whether or not it ran. `/v1/about` answers from the
container or it does not answer.

## What this costs

- **Cold starts.** 1–3 s to start a stopped container plus ~0.8 s to open the
  dataset, traded against the memory bill by `sleepAfter` (1h).
- **No autoscaling.** The pattern is `getRandom(env.READ_API, N)` over a fixed
  *N*; fine here because the traffic is small and sits behind a long-lived cache.
- **Placement is not the Worker's.** A container starts in the nearest location
  with a pre-fetched image, not necessarily where its Durable Object or the
  reader is; the edge cache covers the second reader of anything.

### There is no spend cap

Cloudflare offers no hard spend limit — budget alerts are informational and fire
a day late. The ceiling is a property of the configuration, and the costs split:

- **Traffic-independent, capped** by `max_instances: 1` and the instance type.
  The arithmetic maximum is ~$58/month (Workers Paid base, memory, disk, and
  half a vCPU pegged all month).
- **Traffic-dependent, uncapped:** Workers + Durable Object requests per `/v1`
  call, plus egress. Static assets are free, so only `/v1/*` bills.

**The throttle belongs in the WAF, not in the Worker.** Requests blocked by a
rate-limiting rule never reach the Worker and are not billed; the Workers
rate-limiting *binding* runs inside the Worker, so the request is already paid
for. The rule in force is `/v1/*`, **100 requests per 10 s per IP**. The
absolute stop is `wrangler delete`, which takes both uncapped lines to zero and
costs a redeploy to undo.
