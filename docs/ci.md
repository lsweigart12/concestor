# Continuous integration and deployment

What runs on a pull request, what it can and cannot prove, and what has to
happen before Concestor deploys on Cloudflare.

---

## 1. The workflows

| File | Trigger | Jobs |
|---|---|---|
| `.github/workflows/ci.yml` | every push to `main`, every pull request | `web`, `server`, `pipeline`, `cloudflare` |
| `.github/workflows/deploy-web.yml` | push to `main`, pull request, manual | `deploy` — skipped entirely until Cloudflare credentials exist |
| `.github/dependabot.yml` | monthly | npm, gomod, uv, github-actions |

The three halves share only files, so they get three independent jobs and a red
run names the half that broke. Nothing in CI needs `build/` (2.9 GB) or
`snapshot/` (1.7 GB), and nothing in CI should ever try to produce them: the
pipeline is hours of work against academic APIs that, per
`docs/data-sources.md`, have no rate limiting because nobody implemented it.
Pointing a CI matrix at Open Tree would be the rudest thing this project could
do.

**`web`** — `npm ci`, then typecheck, vitest (220 tests), and `vite build`. The
built `dist` is uploaded as an artifact and handed to the `cloudflare` job, so
the thing that gets validated for deployment is the thing that was tested.

**`server`** — `gofmt -l`, `go vet`, `go build`, then `go test -json` through
`scripts/ci/go-test-summary.py`. See §2, which is the important part.

**`pipeline`** — `uv sync --locked` and then the four gates CLAUDE.md requires
of every pipeline change, in order: `ruff format --check`, `ruff check`,
`ty check`, `pytest`. Nothing here is advisory; all four block the merge.

**`cloudflare`** — `wrangler deploy --dry-run` against the built `dist`. See §3.

---

## 2. What a green run does not mean

On a checkout with no dataset:

| Suite | Runs | Skips |
|---|---|---|
| Go | 17 | **82** |
| pytest | 244 | 47 |

Both suites report success. `go test` prints `ok` for every package.

That default is correct — a clean checkout without a 2.9 GB build should not
fail — and it is dangerous left unsaid, because `ok` reads as *the server is
tested* when 83% of the server's tests did not run. The same trap has already
caught someone inside a git worktree, where `testenv.BuildDir`'s six-parent
walk stops one directory short of the borrowed `build/` and the suite quietly
stopped testing anything.

So there are two mechanisms, and they are complementary:

- **`scripts/ci/go-test-summary.py`** prints the pass/skip split into the job
  summary, and fails a run in which fewer than ten tests ran at all. It cannot
  tell you the dataset tests passed; it can tell you the dataset-free ones have
  not silently disappeared too.

- **`CONCESTOR_REQUIRE_BUILD=1`** turns every dataset skip into a failure. The
  Go side routes all of them through `testenv.absent` — which is why
  `npy_test.go`'s second copy of the six-parent walk is gone, since a skip
  the flag does not reach is exactly the skip that hides something. The
  pipeline side refuses the whole session in `pipeline/tests/conftest.py`,
  once, rather than failing 47 times with the same message.

  It guards the database, not `snapshot/`. With a build and no snapshot, 5
  tests in `test_vernaculars.py` still skip: the snapshot is 1.7 GB of pinned
  upstream sources a worktree deliberately does not borrow, so requiring it
  would make the flag unusable where it is most needed. With both present the
  count is **99 of 99** Go tests and **291 of 291** pipeline tests.

```bash
scripts/check.sh
```

is the local counterpart to CI: every check above, plus the dataset half. It
resolves a build through the same borrowing rules as `scripts/serve.sh`, so it
works from a worktree, and it symlinks `build/` into the worktree root — which
is the missing half, because Go's own walk cannot follow the borrow. When it
finds a build it exports `CONCESTOR_REQUIRE_BUILD=1` and a skip becomes a
failure; when it does not, it says so in yellow rather than printing a green
that means less than it looks like. Like the pipeline's own gates, it collects
failures and reports all of them at the end.

Run it before anything that touches the server or the pipeline. CI is the
floor, not the check.

---

## 3. Cloudflare: what can actually deploy there

**The frontend can. The read API cannot.**

`docs/architecture.md` §4 is one static binary that mmaps the topology arrays
and opens `concestor.db` with `immutable=1`, both at startup, both read-only.
The artifact set is **2,004 MB** (`docs/handoff.md` §4 — architecture §11's
700 MB estimate predates the resolution layer and the silhouette map). A
Worker has a few hundred megabytes of memory and no mmap, so this is not a
porting exercise; it is a different backend. The honest alternatives, none of
which is scheduled:

- **Move the data to D1 or R2.** D1 caps well below 2 GB and is not a drop-in
  for a 41-row-deep ancestor walk plus an FTS5 index. R2 with range reads
  could serve the `.npy` arrays — they are a 128-byte header followed by raw
  little-endian values, so a range request *is* an array read — but every
  `path()` call is 41 dependent lookups, and 41 sequential round trips to
  object storage is not the 41 array reads architecture §4 costs it at.
- **Keep the API on a container** — Fly, Cloud Run, a VM — and put Cloudflare
  in front of the frontend only. This is what the config assumes.

So `web/wrangler.jsonc` deploys `web/dist` as Workers static assets, and
`web/worker/index.ts` proxies `/v1/*` to `API_ORIGIN`. The proxy exists to
keep one invariant true: `web/src/api.ts` fetches `/v1` **same-origin**, as it
does under the Go binary and under `scripts/dev.sh`'s vite proxy. The
alternative is a base-URL setting in the client plus CORS on the server, which
is two more things to configure and two more ways for a deploy to be subtly
wrong.

Two details in that config are load-bearing:

- `assets.run_worker_first: ["/v1/*"]`. Without it, `not_found_handling:
  "single-page-application"` answers *every* unmatched path with `index.html`
  and the Worker never runs — `/v1/search` would return the HTML shell with a
  200 and the client would try to parse it as JSON.
- The Worker returns the upstream response unmodified. `/v1` is
  `Cache-Control: immutable` keyed by build id because the data cannot change
  within a build, and `/v1/random` is the one deliberate exception, `no-store`
  with no ETag. Caching that at the edge would hand every visitor the same
  "random" species forever — an endpoint that appears to work and never picks
  twice.

### Turning the deploy on

Nothing is configured, and `deploy-web.yml` is written so that costs nothing:
with no credentials in the repository the guard step skips every later step and
the run is green with a notice. It is not a failure to have no Cloudflare
account; it is a failure to find out on the day you get one that the pipeline
was never wired up. Meanwhile the `cloudflare` job in `ci.yml` still bundles
the Worker and validates the config on every pull request, so the first real
deploy is a credentials problem rather than a config one.

To enable it, set in the repository:

| | Name | Value |
|---|---|---|
| secret | `CLOUDFLARE_API_TOKEN` | scoped to *Edit Cloudflare Workers* |
| secret | `CLOUDFLARE_ACCOUNT_ID` | |
| variable | `CONCESTOR_API_ORIGIN` | `https://` origin of the Go read API |

Then a push to `main` runs `wrangler deploy`, and a pull request from this
repository runs `wrangler versions upload --preview-alias pr-N`, which
publishes a preview URL without moving production traffic. Pull requests from
forks have no secrets and skip the deploy, which is the correct behaviour
rather than a limitation to work around.

`CONCESTOR_API_ORIGIN` is passed with `--var`, not as a secret, deliberately:
it is a public origin the browser already sends every request to.

Locally:

```bash
npm --prefix web run cf:check   # the same dry run CI does
npm --prefix web run cf:dev     # wrangler dev, needs API_ORIGIN set
```

---

## 4. What is deliberately not here

- **No pipeline run in CI.** Release cadence, not per commit, and the upstream
  APIs are a build-time oracle that must be paced.
- **No deployment of the read API.** There is nowhere to deploy it to yet, and
  a workflow that pretends otherwise is worse than none.
- **No coverage percentage.** The number that matters on this repo is the
  pass/skip split in §2, and a coverage badge computed without a dataset would
  report the 17-test figure as the truth.
- **No end-to-end browser test.** It would need a dataset, which means it
  belongs with `scripts/check.sh` and a real build, not in CI. `docs/handoff.md`
  §7 already records that no accessibility or performance pass exists; this is
  the same gap and should be filled there rather than papered over here.
