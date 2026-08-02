# Continuous integration and deployment

What runs on a pull request, what it can and cannot prove, and what has to
happen before Concestor deploys on Cloudflare.

---

## 1. The workflows

| File | Trigger | Jobs |
|---|---|---|
| `.github/workflows/ci.yml` | every push to `main`, every pull request | `commits`, `web`, `server`, `pipeline`, `cloudflare` |
| `.github/workflows/release.yml` | CI succeeding on `main`, or manual | `release` — semantic-release, fully automatic |
| `.github/workflows/deploy-web.yml` | a published release, pull request, manual | `deploy` — skipped entirely until Cloudflare credentials exist |
| `.github/dependabot.yml` | monthly | npm, gomod, uv, github-actions |

The chain is `merge → CI → release → deploy`, and no link in it waits for a
human.

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

**`commits`** — commitlint over the pull request's own commits only. The
version is a function of the commit log, so the commit log is an input to the
build and gets checked like one. See §4.

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

**All of it**, since Containers went generally available on 2026-04-13. One
Worker serves `web/dist` as static assets and routes `/v1/*` to a Container
running `docs/architecture.md` §4's binary unchanged — same mmap'd arrays,
same `immutable=1` SQLite, on a machine with a page cache.

**[docs/deployment.md](deployment.md) is the decision, the alternatives and the
measurements.** It supersedes this section's earlier answer, which was
frontend-here-API-elsewhere and was correct when it was written. The three
numbers that decided it: a Worker isolate is capped at **128 MB** and the
artifact set is **2,229 MB**, so the binary genuinely does not port; the
process's measured working set is **463 MB**, which a 4 GiB instance holds with
room; and `/v1/path` answers in **0.4 ms**, which is 41 dependent array reads
and rules out every design that turns them into round trips.

Three things about the deploy path belong here rather than there.

**The API image is never built in CI, and cannot be.** It carries 2.2 GB of
pipeline output that is not in this repository — §5's rule, unchanged. So
`scripts/deploy/push-api-image.sh` builds and pushes it from a checkout that
has `build/`, and `web/wrangler.jsonc` names it by **registry tag**. That form
is not cosmetic: with a Dockerfile in that config, `wrangler deploy --dry-run`
refuses to run without Docker *even in a dry run*, which would break the
`cloudflare` job below. With a registry reference the dry run passes clean, no
Docker and no credentials.

**`assets.run_worker_first: ["/v1/*"]` is load-bearing.** Without it,
`not_found_handling: "single-page-application"` answers *every* unmatched path
with `index.html` and the Worker never runs — `/v1/search` would return the
HTML shell with a 200 and the client would try to parse it as JSON.

**The Worker returns the upstream response unmodified.** `/v1` is
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

The order matters, because a Worker whose container image does not exist yet
will not deploy. `docs/deployment.md` §5 has it in full; in short, push the
image first and commit the tag it prints, then set:

| | Name | Value |
|---|---|---|
| secret | `CLOUDFLARE_API_TOKEN` | *Edit Cloudflare Workers*, plus registry write to push images |
| secret | `CLOUDFLARE_ACCOUNT_ID` | substituted into the image reference at deploy time |
| variable | `CONCESTOR_API_ORIGIN` | **optional.** Set it only to route `/v1` to an API *outside* Cloudflare |

Then a release runs `wrangler deploy`, and a pull request from this repository
runs `wrangler versions upload --preview-alias pr-N`, which publishes a preview
URL without moving production traffic. Pull requests from forks have no secrets
and skip the deploy, which is the correct behaviour rather than a limitation to
work around.

`CONCESTOR_API_ORIGIN` is passed with `--var`, not as a secret, deliberately:
it is a public origin the browser already sends every request to. Leaving it
unset is the normal case and is what uses the container; setting it is both the
local-development path and the one-variable fallback if the API ever moves back
off Cloudflare.

Locally:

```bash
npm --prefix web run cf:check   # the same dry run CI does
npm --prefix web run cf:dev     # wrangler dev; set API_ORIGIN at a local server
```

`cf:dev` wants `API_ORIGIN` pointed at a running `scripts/serve.sh` rather than
the container: starting the real one locally means Docker and a 2.2 GB image,
which is not a thing to ask of someone changing a button.

---

## 4. Releases

Fully automatic. Merge to `main`, CI passes, a release is cut. Nobody decides
a version number and nobody writes release notes.

```
merge → CI green on main → semantic-release → tag + GitHub Release → deploy
```

### The version is a function of the commit log

Conventional Commits, per `commitlint.config.cjs`. `feat:` bumps the minor,
`fix:` the patch, `BREAKING CHANGE:` in a body bumps the major; `docs`,
`chore`, `ci`, `refactor`, `test`, `build`, `style` and `revert` release
nothing. **`perf` deliberately does not bump** — a faster induced-subtree walk
is not a new capability, and shipping it as one makes the version a worse
description of the change than the commit already was.

The type prefix is the whole of what the convention imposes here. The subject
stays a sentence in this project's voice:

```
feat: Make the card say what a thing is, and let the reader walk from it
```

That is five characters more than the commit that actually shipped. Two rules
exist to keep it that way, and both are load-bearing: **`subject-case` is
off**, because config-conventional forbids sentence case and would reject
every commit this project has ever written, and the rules are **written out
rather than `extends`-ed**, because commitlint resolves `extends` from the
repository root, there is no `node_modules` there, and the extended form
throws `MODULE_NOT_FOUND` under `npx` — which is exactly how CI runs it.

### One version, and the tag is the only place it is written

`web/package.json` and `pipeline/pyproject.toml` stay at `0.1.0` and are never
touched. Nothing is committed back to `main` — no version bump, no
`CHANGELOG.md`, no bot commit, so `main`'s history is only ever what someone
wrote.

One version rather than three because architecture §4 makes version pinning
structural: the artifact set and the code that reads it ship together, and
three components drifting apart at `0.1.0`, `0.4.2` and `1.1.0` would describe
a system this is not.

The consequence of committing nothing back is that **there is no
`CHANGELOG.md` in the tree**. The release notes are generated from the commits
between tags and live on the GitHub Release, where they cannot go stale. A
file would cost a bot commit on `main` for every release; if that trade ever
looks worth making, it is `@semantic-release/changelog` plus
`@semantic-release/git` and a `[skip ci]` marker.

### What a release produces

A tag, a GitHub Release with generated notes, and four assets from
`scripts/ci/build-release.sh`: the server for `linux/amd64` and `linux/arm64`,
the built frontend, and `SHA256SUMS`. The binaries are static
(`CGO_ENABLED=0`, which costs nothing because the SQLite driver is
`modernc.org/sqlite` rather than a cgo wrapper) and carry the version through
`-ldflags -X main.version`.

**The dataset is not in the release and never will be.** Two gigabytes of baked
artifacts move on the pipeline's cadence, not the code's; their vehicle is the
container image of §3, tagged with the build id it contains. A running instance
reports both on `/v1/about`: `release` is the tag it was built from, `build_id`
is the artifact set it has mmap'd. Conflating them would be the same mistake as
merging `age_ma` into `age_layout` to save 10 MB — one number where the honest
answer needs two.

### Two guards worth knowing

- **The release runs on CI succeeding, not on push to `main`.** `workflow_run`
  is the only trigger that can know the commit's tests were green.
- **If `main` moved while CI was running, the release skips** with a notice
  rather than shipping the newer, untested tip. Nothing is lost: that commit
  has its own CI run, and its success triggers the release again.

### The baseline

`v0.1.0` is tagged at the last commit before this pipeline existed. Without it
semantic-release's first release is `v1.0.0`, which is a claim about stability
that nobody has made. From `0.x`, `feat` gives `0.2.0` and a breaking change
gives `1.0.0` when someone means it.

To watch it decide without releasing anything, run the **Release** workflow
manually with `dry_run` left on.

---

## 5. What is deliberately not here

- **No pipeline run in CI.** Release cadence, not per commit, and the upstream
  APIs are a build-time oracle that must be paced.
- **No workflow that builds the read API's image.** The API does deploy now —
  as a Container, per §3 — but its image contains the dataset, and a workflow
  that builds it would need the pipeline's output in CI. `scripts/deploy/push-api-image.sh`
  runs where `build/` already is, on the pipeline's cadence rather than the
  code's, and prints a tag for someone to commit.
- **No coverage percentage.** The number that matters on this repo is the
  pass/skip split in §2, and a coverage badge computed without a dataset would
  report the 17-test figure as the truth.
- **No release-approval step.** A release PR to merge, or an environment
  awaiting review, would make the version a decision someone takes on a
  Thursday rather than a consequence of what was merged. The gate is CI, and
  the way to hold a release back is not to merge the `feat:`.
- **No end-to-end browser test.** It would need a dataset, which means it
  belongs with `scripts/check.sh` and a real build, not in CI. `docs/handoff.md`
  §7 already records that no accessibility or performance pass exists; this is
  the same gap and should be filled there rather than papered over here.
