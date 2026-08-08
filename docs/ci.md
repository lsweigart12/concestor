# Continuous integration and deployment

What runs on a pull request, what a green run does and does not prove, and how the
project deploys on Cloudflare.

---

## 1. The workflows

| File | Trigger | Jobs |
|---|---|---|
| `.github/workflows/ci.yml` | every push to `main`, every pull request | `commits`, `web`, `server`, `pipeline`, `cloudflare` |
| `.github/workflows/release.yml` | **daily at 16:00 UTC**, or the Release button | `release` — semantic-release over everything merged since the last tag |
| `.github/workflows/deploy-web.yml` | **called by `release.yml`**, pull request, manual | `deploy` — skipped until Cloudflare credentials exist |
| `.github/dependabot.yml` | monthly | npm, gomod, uv, github-actions — grouped |

The chain is `merge → CI → (merges accumulate) → the train → release → deploy`, and no
link waits for a human: the cron is what replaces "someone remembered". Merging does not
release — §4. The three halves share only files, so they get three independent jobs and a
red run names the half that broke. **Nothing in CI needs `build/` (3.2 GB) or `snapshot/`
(1.7 GB), and nothing in CI should try to produce them** — the pipeline is hours of work
against academic APIs with no rate limiting (see `docs/data-sources.md`).

- **`web`** — `npm ci`, then `prettier --check`, `oxlint`, typecheck, vitest (two
  projects, `node` and `dom`), `vite build`. The built `dist` is uploaded and handed to
  the `cloudflare` job, so the thing validated for deployment is the thing tested. The
  linter is oxlint, not typescript-eslint (which throws on TS 7.0);
  `web/.oxlintrc.json` and `web/prettier.config.js` carry the config rationale. Neither
  vitest project needs `build/`, so a green `web` job means what it looks like — except it
  cannot cover what a real browser does and jsdom does not (layout, paint, WebGL).
- **`server`** — `gofmt -l`, `go vet`, `go build`, then `go test -json` through
  `scripts/ci/go-test-summary.py`. See §2.
- **`pipeline`** — `uv sync --locked`, then `ruff format --check`, `ruff check`,
  `ty check`, `pytest`, in that order. All four block the merge.
- **`cloudflare`** — `wrangler deploy --dry-run` against the built `dist`. See §3.
- **`commits`** — commitlint over the pull request's own commits. The version is a
  function of the commit log, so the log is a build input and gets checked like one. §4.

---

## 2. What a green run does not mean

On a checkout with no dataset (measured 2026-08-04) — **this table is the one place the
split is written down**:

| Suite | Runs | Skips |
|---|---|---|
| Go | 31 | **127** |
| pytest | 307 | 83 |

Both suites report success; `go test` prints `ok` for every package. That default is
correct — a clean checkout without a 3.2 GB build should not fail — but `ok` reads as
*the server is tested* when ~80% of the server's tests did not run.

Two complementary mechanisms guard against the silence:

- **`scripts/ci/go-test-summary.py`** prints the pass/skip split into the job summary and
  fails a run in which fewer than ten tests ran at all. It cannot tell you the dataset
  tests passed; it can tell you the dataset-free ones have not silently disappeared.
- **`CONCESTOR_REQUIRE_BUILD=1`** turns every dataset skip into a failure. The Go side
  routes all skips through `testenv.absent`; the pipeline side refuses the whole session
  in `pipeline/tests/conftest.py`. It guards the database, not `snapshot/`: with a build
  and no snapshot, 5 `test_vernaculars.py` tests still skip (the snapshot is 1.7 GB a
  worktree deliberately does not borrow). With a build the count is **158/158** Go tests
  and **385/390** pipeline tests.

```bash
scripts/check.sh
```

is the local counterpart to CI: every check above plus the dataset half. It resolves a
build, symlinks `build/` into the worktree root, exports `CONCESTOR_REQUIRE_BUILD=1` when
a build is found (a skip becomes a failure), and says so in yellow when it is not. Run it
before anything that touches the server or the pipeline. **CI is the floor, not the
check.**

### Running in a git worktree

`scripts/serve.sh` and `scripts/dev.sh` work unchanged in a parallel session's worktree,
which has the source but neither `build/` nor `snapshot/`; they borrow both read-only from
the main checkout. **`go test` does not borrow.** `testenv.BuildDir` walks six parents for
`build/concestor.db`, and from `<worktree>/server/internal/store` that stops one level
short — so **most of the Go suite silently skips and still prints `ok`.** Run
`scripts/check.sh`, which symlinks `build` into the worktree root (it is gitignored) and
sets `CONCESTOR_REQUIRE_BUILD=1` so a skip becomes a failure. Borrowed paths are pipeline
output nobody edits; `web/` always belongs to the worktree, and nothing may hardcode a
port.

---

## 3. Cloudflare deployment

**All of it deploys on Cloudflare** since Containers went GA (2026-04-13). One Worker
serves `web/dist` as static assets and routes `/v1/*` to a Container running architecture
§4's binary unchanged. See [docs/deployment.md](deployment.md) for the decision and
measurements (a Worker isolate caps at 128 MB and the artifact set is 2,229 MB, so the
binary does not port; the process working set is 463 MB; `/v1/path` answers in 0.4 ms,
which rules out any design that turns array reads into round trips).

Three things about the deploy path:

- **The API image is never built in CI, and cannot be** — it carries 2.2 GB of pipeline
  output not in this repository. `scripts/deploy/push-api-image.sh` builds and pushes it
  from a checkout that has `build/`, and `web/wrangler.jsonc` names it by **registry
  tag**. (A Dockerfile in that config makes `wrangler deploy --dry-run` require Docker
  even for a dry run, which would break the `cloudflare` job; a registry reference passes
  clean.)
- **`assets.run_worker_first: ["/v1/*"]` is load-bearing.** Without it,
  `not_found_handling: "single-page-application"` answers every unmatched path with
  `index.html` and the Worker never runs — `/v1/search` would return the HTML shell with
  a 200. (This bug was live on `/healthz`, which is outside the glob, so the boot probe
  read `res.ok` off the HTML shell and reported the API healthy regardless. `/v1/about`
  is the probe now.)
- **The Worker returns the upstream response unmodified.** `/v1` is long-lived and ETag'd
  by build id; the only `no-store` passed through is `/v1/random-pool/{build_id}`'s 404
  for a stale build id (which must not be cached or it outlives the deploy that caused it).

### Turning the deploy on

Nothing is configured; `deploy-web.yml` skips every later step with no credentials, so the
run is green with a notice. The `cloudflare` job in `ci.yml` still bundles the Worker and
validates the config on every PR. Order matters — a Worker whose container image does not
exist will not deploy. Push the image first and commit the tag it prints, then set:

| | Name | Value |
|---|---|---|
| secret | `CLOUDFLARE_API_TOKEN` | *Edit Cloudflare Workers* + registry write |
| secret | `CLOUDFLARE_ACCOUNT_ID` | substituted into the image reference at deploy time |
| variable | `CONCESTOR_API_ORIGIN` | **optional** — set only to route `/v1` outside Cloudflare |

A release then runs `wrangler deploy`; a PR from this repository uploads a preview version
and comments the URL. The preview is a version of a **second** Worker, `concestor-preview`
— Cloudflare does not generate preview URLs for a Worker implementing a Durable Object,
and production's container class is one. A preview cannot show `server/` or `pipeline/`
changes: `/v1` is production's.

Locally:

```bash
npm --prefix web run cf:check           # the same dry run CI does
npm --prefix web run cf:check:preview   # and the preview Worker's
npm --prefix web run cf:dev             # wrangler dev; set API_ORIGIN at a local server
```

`cf:dev` wants `API_ORIGIN` pointed at a running `scripts/serve.sh` rather than the
container (which means Docker and a 2.2 GB image).

---

## 4. Releases

**Releases are batched onto a train.** Merging does not release. Everything merged since
the last tag rides the next run of `release.yml` — daily at **16:00 UTC**, or whenever
somebody presses **Release** (uncheck `dry_run`). Nobody decides a version or writes
release notes.

```
merges accumulate on main
        │
        ├── 16:00 UTC daily ──┐
        └── the Release button┴─→ tip-green gate → semantic-release → tag + Release → deploy
```

### Why a train

One release per releasable merge was one *production deploy* per releasable merge. This
project is worked in several parallel worktrees, so a sitting produces several pull
requests; five merges became five versions and five deploys, four of them pointless, each
with notes describing one pull request. Batching is semantic-release's native mode —
highest bump wins, the notes cover every commit since the last tag — so `release.config.cjs`
is untouched and the whole change is the trigger.

What it costs: **a merged fix waits up to a day** unless somebody presses the button, and
a red release run now blocks several pull requests' worth of work rather than one. The
button is the escape hatch for the first; the gate below makes the second rare.

### The version is a function of the commit log

Conventional Commits. Two files do different jobs: which types are **allowed** is
`commitlint.config.cjs`; which of them **bump** is `release.config.cjs`'s `releaseRules`.
**The bump mapping is written down in that second file and deliberately nowhere else** —
read it there, do not restate it.

The type prefix is the whole of what the convention imposes; the subject stays a sentence
in this project's voice (`feat: Make the card say what a thing is`). `subject-case` is
**off** in commitlint (config-conventional would reject every commit this project writes),
and the rules are **written out rather than `extends`-ed** (commitlint resolves `extends`
from the repository root where there is no `node_modules`, throwing `MODULE_NOT_FOUND`
under `npx`, which is how CI runs it).

### Dependabot

`commitlint.config.cjs` **ignores commits signed off by `dependabot[bot]`** (a bot writes
no type prefix), and `.github/dependabot.yml` settles the type instead: **`ci` for
workflows, `build` for npm/gomod/uv** — both types `release.config.cjs` leaves alone, so a
dependency bump cuts no version. The exemption keys on the **sign-off trailer**, not the
author. Every ecosystem is **grouped** (one PR per ecosystem, not per dependency), and
auto-merge is deliberately absent.

### One version, and the tag is the only place it is written

`web/package.json` and `pipeline/pyproject.toml` stay at `0.1.0` and are never touched.
Nothing is committed back to `main` — no version bump, no `CHANGELOG.md`, no bot commit.
Release notes are generated from the commits between tags and live on the GitHub Release.
One version rather than three because architecture §4 makes pinning structural: the
artifact set and the code that reads it ship together.

A release produces a tag, a GitHub Release with generated notes, and four assets from
`scripts/ci/build-release.sh`: the server for `linux/amd64` and `linux/arm64`, the built
frontend, and `SHA256SUMS`. Binaries are static (`CGO_ENABLED=0`;
`modernc.org/sqlite` needs no cgo) and carry the version via `-ldflags -X main.version`.

**The dataset is not in the release and never will be** — 2 GB of baked artifacts move on
the pipeline's cadence, not the code's, via the container image of §3. `/v1/about` reports
both: `release` is the tag it was built from, `build_id` the artifact set it has mmap'd.

### The release calls the deploy, because a release cannot trigger one

**`GITHUB_TOKEN` does not start workflows** — events raised by the token Actions hands a
job (pushes, tags, published releases) are ignored by every `on:` trigger. This is
GitHub's recursion guard and cannot be switched off. So the deploy is a **job in
`release.yml`**, called with `uses:` and gated on semantic-release having published:

```yaml
deploy:
  needs: release
  if: needs.release.outputs.released == 'true'
  uses: ./.github/workflows/deploy-web.yml
  with: { release_tag: "${{ needs.release.outputs.tag }}" }
  secrets: inherit
```

Consequences:

- **No new credential.** The alternative (a PAT or GitHub App token so the release is
  raised by an unguarded identity) adds a second long-lived credential; a `uses:` line
  does the same work.
- **A failed deploy is loud** and turns the Release run red. The state to recognise: a red
  Release run whose `semantic-release` job is green means the version was cut but
  production was not updated — re-run the **Deploy web** workflow manually with the tag.
- **Production deploys no longer appear as `deploy-web.yml` runs** — a called workflow's
  jobs appear under the Release run. `deploy-web.yml`'s own run list is previews and
  hand-deploys only.
- **A called workflow may not request more permission than its caller grants.**
  `deploy-web.yml` needs `pull-requests: write` for the preview comment; without a matching
  `permissions:` block on the `deploy` job in `release.yml`, the Release run ends in
  `startup_failure` (validated before any job runs, so the `if:` is no protection). The two
  permission blocks move together.

Triggering on `push: tags: v*` instead does not work — semantic-release pushes the tag
with the same token, so the guard applies. A guard step in `release.yml` diffs the local
tag list across semantic-release and **fails** if a tag was cut without the deploy's
trigger output being set.

### The tip-green gate

A train has no event telling it the tests passed, so it asks. The first step of
`release.yml` looks up the `ci.yml` run for `main`'s exact tip sha, on the `push` that
landed it, and requires `conclusion == success`. **The two triggers answer a non-green tip
differently, on purpose:**

| Tip state | Cron | Release button |
|---|---|---|
| green | releases | releases |
| red, still running, or no run at all | **skips with a notice** | **fails** |

Nobody asked for the cron, so a red morning is a notice and tomorrow's train ships the
fix; a red train every day until somebody noticed would teach people to stop reading red.
A human who pressed the button is standing there and should be told no rather than
silently obliged tomorrow. *No run at all* is treated as red on both paths: CI runs on
every push to `main`, so its absence is a broken assumption, and "no evidence" must never
read as "green".

This needs `actions: read` in `release.yml`'s `permissions:` — reading another workflow's
runs is its own scope, and without it the gate 404s and every train fails.

### The baseline

`v0.1.0` is tagged at the last commit before this pipeline existed; without it,
semantic-release's first release is `v1.0.0` (a stability claim nobody made). From `0.x`,
`feat` gives `0.2.0` and a breaking change gives `1.0.0`. Run the **Release** workflow
manually with `dry_run` on to watch it decide without releasing.

---

## 5. What is deliberately not here

- **No pipeline run in CI** — release cadence, not per commit, and the upstream APIs must
  be paced.
- **No workflow that builds the read API's image** — its image contains the dataset, so a
  workflow that builds it would need the pipeline's output in CI.
  `scripts/deploy/push-api-image.sh` runs where `build/` already is.
- **No coverage percentage** — the number that matters is the pass/skip split in §2, and a
  coverage badge computed without a dataset would report the tiny dataset-free figure as
  the truth.
- **No release-approval step** — the gates are CI and the train's tip-green check; to hold
  a release back, do not merge the `feat:`.
- **No end-to-end browser test** — it needs a dataset, so it belongs with
  `scripts/check.sh` and a real build.
- **Nothing times the deployed API** — every latency figure was taken on a developer
  machine, and production is half a vCPU. That gap has hidden two expensive endpoints (the
  unindexed `fossil` scan behind `/v1/search`, and `/v1/random`), both found by hand with
  `curl`. A real hole rather than a deliberate omission.
