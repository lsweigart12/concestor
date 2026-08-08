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

## The container image

The image contains ~2.2 GB of pipeline output that is not in the repository and
**must never be produced in CI** (`docs/ci.md` §5). It is built and pushed from
a machine that has `build/`, by `scripts/deploy/push-api-image.sh`, and
`web/wrangler.jsonc` references it **by registry tag**:

```jsonc
"containers": [{ "class_name": "ReadApi",
                 "image": "registry.cloudflare.com/<account>/concestor-api:<build_id>-<commit>" }]
```

The registry-reference form is load-bearing: with `"image": "./Dockerfile"`,
`wrangler deploy --dry-run` refuses to run without Docker, which would break the
`cloudflare` CI job. With a registry reference the dry run completes with no
Docker, no credentials and no network — the form CI validates.

- **Wrangler does not interpolate env vars into the config.** The account id is
  substituted into the config by the deploy workflow before `wrangler deploy`;
  the committed file carries a placeholder the dry run validates.
- The image must be **`linux/amd64`**. The Go binary is already cross-compiled;
  the Docker build must be told too, on what is likely an arm64 machine.

### Two build ids

`concestor-build package` stamps `build/manifest.json` with a **content** hash —
a stable name for an artifact set. `store.computeBuildID` computes its own from
the name, size and mtime of the arrays, database, `timescale.json` and gate
files, plus the snapshot's `synth_id` — the id every ETag and `Cache-Control`
on `/v1` keys on. Both are correct for their job; `/v1/about` reports both. The
image tag is the manifest's. The Dockerfile must copy `snapshot/manifest.json`
and the phase gate files, because leaving them out silently changes the store's
identity of the build.

### The tag is `<build_id>-<commit>`, committed

A dataset rebuild and a code change both mint a new tag, so an unchanged tag
means an unchanged image, and rolling the Worker back rolls the *server* back
and not only the data. A dirty tree appends `-dirty` and `push-api-image.sh`
refuses to pin it.

**To revert the dataset, revert the tag in `web/wrangler.jsonc` and run
`deploy`.** Not `wrangler rollback`: Wrangler warns that container config changes
(image, `max_instances`) are not rolled out with versions and only take effect
on `deploy`, so a version rollback would leave the container on the newer image
— the new dataset under old code. Treat `wrangler rollback` as unsafe here.

**A stale image is invisible to a Worker deploy.** If `server/` changed between
the pinned commit and the commit being deployed, the pinned image predates a
server change and endpoints the new frontend calls will 404 or misbehave. Check
before every deploy:

```bash
git diff --quiet <pinned-commit> HEAD -- server/ || echo "pinned image predates a server change"
```

### The ETag names the binary too

`api.etag` is **`"<build_id>-<code_id>"`**. `store.BuildID` alone is a pure
function of the dataset, so a code-only change would have revalidated `304` on
stale content. `code_id` is the commit from `-X main.commit` where there is one,
else `dev-<12 hex>` over the executable's path, size and mtime. `writeJSON`,
`/v1/timescale` and `/v1/silhouette` all stamp through `stampCacheable`.

### Bootstrap order

Every deploy step is skipped while credentials are unset (`docs/ci.md` §3). When
they exist:

1. `scripts/deploy/push-api-image.sh` — build and push the image from a checkout
   that has `build/`. It prints the tag.
2. Commit that tag into `web/wrangler.jsonc`.
3. Set repository secrets `CLOUDFLARE_API_TOKEN` (needs *Edit Cloudflare
   Workers* **and** container registry write) and `CLOUDFLARE_ACCOUNT_ID`.
4. Merge. CI passes, semantic-release cuts the release, and the release's
   `deploy` job deploys the Worker.

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
