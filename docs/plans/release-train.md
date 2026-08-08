# Plan: the release train and the two-cadence image

**Status: plan, not spec.** Written 2026-08-08. Nothing below is implemented.
As each phase lands, its content moves into `docs/ci.md` and
`docs/deployment.md` as a description of the current design, and the section
here is deleted; when the file is empty it goes too. Do not cite this file as
the state of the system.

---

## 1. The problem

Two frictions, one cause: the pipeline was designed for one change at a time,
and the way of working is now many parallel worktrees producing many PRs per
sitting.

1. **Every releasable merge cuts a version and a production deploy.** Merge
   five PRs and production deploys five times, four of them pointlessly, each
   with a version number whose release notes describe one PR. `release.yml`
   runs on CI succeeding on `main`, so batching is currently impossible by
   construction.

2. **The container image's binary drifts from the released code.** The API
   image is dataset + Go binary in one, built and pushed by hand from a
   machine that has `build/`. The dataset half genuinely cannot be built in CI
   (docs/ci.md §5 — that constraint does not move). But the binary half rides
   along: server code changes release and deploy, and production keeps running
   the old binary until someone remembers to rebuild 2.2 GB locally to update
   10 MB. This has already happened once (`push-api-image.sh`'s own comments
   record production running a pre-#51 server for two releases).

A third, smaller one: merging N PRs serially against a moving `main` means
N−1 rounds of "update branch, wait for CI, repeat".

## 2. The decisions

| # | Decision | Replaces |
|---|---|---|
| 1 | Releases run on a **daily schedule plus a manual button**, batching everything merged since the last tag | Release per releasable merge |
| 2 | The image splits into a **data base image** (local, pipeline cadence) and a **binary layer assembled in CI** (release cadence) | One hand-built 2.2 GB image |
| 3 | Image assembly lives **inside the production deploy, idempotently**: deploy checks whether the tag's image exists and creates it if not | A hand-run script and a committed tag |
| 4 | PRs land via **auto-merge under a ruleset**, no required-up-to-date, no manual rebasing | Serial merge-and-rebase |

What deliberately does not change: semantic-release and the commit-log-derived
version (batching is its native mode — highest bump wins, notes cover every
commit since the last tag; `release.config.cjs` is untouched); the dataset
never being produced in CI; the tag being the only place the version is
written; the preview Worker; the structural pinning of dataset to deploy.

Rejected, and why, so they stay rejected:

- **A dev/`next` branch or semantic-release channels** — the rebase treadmill
  with a name. Channels exist for parallel release lines, not batching.
- **Dataset in R2, fetched at container boot** — trades a build-time pairing
  (structural, rollback-safe) for a runtime one with new failure modes: a
  2.2 GB cold-start fetch on a container that scales to zero, instance disk
  limits, and a boot that fails because a bucket hiccuped. Most of
  docs/deployment.md's reasoning would need rewriting for marginal gain over
  decision 2.
- **A self-hosted runner on the machine that has `build/`** — a self-hosted
  runner on a public repository is a standing security liability, and a
  sleeping laptop becomes a release failure mode.
- **GitHub's native merge queue** — unavailable: it requires an
  organization-owned repository and this one is user-owned. See §5 for the
  upgrade path if that ever changes.

---

## 3. Phase 1 — the release train

**Landed.** `docs/ci.md` §1 and §4 describe it.

---

## 4. Phase 2 — split the image on its two cadences

The image is a dataset **and** a binary (the tag already says so:
`<build_id>-<code_id>`). The two halves change on different cadences and are
currently welded together; every dataset non-change still costs a 2.2 GB
rebuild to ship a binary change. `server/Dockerfile` is already ordered
coldest-first with the binary as the last layer — it was built to be cut here.

### 4.1 The data base image (local, rare)

`scripts/deploy/push-api-image.sh` becomes `scripts/deploy/push-data-image.sh`:
the same staging, symlink-resolution, and guards it has today, minus the Go
cross-compile. It builds `Dockerfile.data` — today's Dockerfile minus the
`COPY … concestor-server` line and the runtime directives — and pushes:

```
registry.cloudflare.com/<account>/concestor-data:<BUILD_ID>
```

`BUILD_ID` stays the manifest's content-hashed id, for the reasons the current
script documents. The `CODE_ID` half disappears from this tag because the tag
no longer contains code — which also dissolves the `-dirty` hazard and the
"tag's dataset id lies after a single-phase rerun without `package`" hazard:
both lived in the local binary build, which no longer exists.

The script ends the way the current one does: print the tag, instruct the
one-line pin commit (§4.3). That commit rides the next train like any other
change.

### 4.2 The API image, assembled in CI (release cadence)

`Dockerfile.api`, new, small:

```dockerfile
ARG DATA_IMAGE
FROM ${DATA_IMAGE}
COPY --chown=nonroot:nonroot concestor-server /usr/local/bin/concestor-server
USER nonroot
EXPOSE 8080
ENTRYPOINT ["/usr/local/bin/concestor-server"]
CMD ["-addr", ":8080", "-build", "/srv/build"]
```

Assembly produces `concestor-api:<BUILD_ID>-<version>` — the tag keeps both
halves, but the code half is now the release version, minted by CI from the
tag being released, never by hand, never `-dirty`.

**Where assembly runs: inside `deploy-web.yml`'s production path, before
`wrangler deploy`, idempotently.** Not a separate release job. The step:

1. Resolve the target tag from the committed data pin (§4.3) and the
   `release_tag` input.
2. **HEAD the manifest** in the registry. Exists → done, deploy proceeds
   (re-runs and rollbacks hit this path).
3. Missing → cross-compile the linux/amd64 static binary from the checked-out
   tag (the same `CGO_ENABLED=0` build `build-release.sh` does, ~30 s), build
   `Dockerfile.api` against the data base, push via
   `npx wrangler containers push`. The registry already holds the 2.2 GB of
   data layers, so the push uploads megabytes.

Why inside the deploy: it makes the deploy **self-healing and honest** — a
deploy can never point at an image that doesn't exist, a failed assembly is a
red deploy next to the release it failed, re-running the Deploy web workflow
heals any gap, and rolling back to an old tag reconstructs that tag's exact
image (its wrangler.jsonc names its data base; its source builds its binary)
even if the registry has been cleaned. No new workflow, no new failure
surface, and hand-deploys get the machinery for free.

**The one open implementation question: how CI reads the base image.** Two
paths, decided by a spike at implementation time:

- *Preferred:* `crane append`/`crane mutate` against the remote base — no
  2.2 GB pull, seconds. Depends on obtaining registry credentials the way
  `wrangler containers push` does; verify whether wrangler exposes them (a
  `registries credentials`-shaped command has existed) or whether the
  Cloudflare API issues them directly.
- *Fallback, known-good:* `docker login` with those credentials (or wrangler's
  own pull path), `docker pull` the base (~2 GB into the runner, a few
  minutes), `docker build`, `wrangler containers push`. Slower but entirely
  within documented tooling, and the cost is per-release, not per-merge.

Either way `CLOUDFLARE_API_TOKEN` needs registry write — `deploy-web.yml`'s
header already anticipates exactly this ("registry write if the image is ever
pushed from CI").

### 4.3 The pin

`web/wrangler.jsonc`'s committed image reference becomes:

```jsonc
"image": "registry.cloudflare.com/ACCOUNT_ID/concestor-api:<build_id>-RELEASE"
```

with a real `build_id` and two shouting placeholders. `ACCOUNT_ID` is
substituted at deploy time exactly as today. `RELEASE` is substituted with the
tag being deployed; a hand tip-deploy (empty `release_tag`) substitutes
`git describe --tags --abbrev=0` — the frontend may be past the tag on that
path, but `/v1` is pinned to the last release either way, which is what a
tip-deploy already means today.

The **dataset pairing stays structural**: the build_id half is committed, so
rolling the Worker back rolls the dataset back, unchanged. The code half moves
from "committed, hand-maintained, drifts" to "derived from the deployed tag,
cannot drift". The `Resolve the container image reference` step's grep guards
in `deploy-web.yml` extend to the new placeholder, and ci.yml's dry run keeps
validating the committed shape on accountless checkouts.

### 4.4 Gates against the drift that remains

- **Deploy-time existence gate** — §4.2 step 2 is itself the gate: a missing
  *data base* (pushed but never pinned, or pinned but never pushed) is a red
  deploy naming the exact tag it wanted, not a container that boots without a
  dataset.
- **Local freshness observation** — `scripts/check.sh` gains an
  observe-level note when the local `build/manifest.json` build_id differs
  from the committed pin: "local dataset is newer than production's — push
  and pin when ready". Observe, not require: a rebuilt local dataset is
  normal, and this project's gate culture says a gate must measure what it
  claims (a require here would block every experiment).
- The release-time binary-staleness gate that Phase 2 was originally going to
  need is **unnecessary by construction** — CI compiles the deployed binary
  from the deployed tag every time.

### 4.5 Migration order

1. Land `Dockerfile.data`, `Dockerfile.api`, the renamed script, and the
   deploy-workflow changes in one PR (config validated by ci.yml's dry run;
   nothing deployed yet).
2. From the checkout with `build/`: run `push-data-image.sh`, commit the pin
   (`concestor-api:<build_id>-RELEASE`).
3. Press the Release button (or wait for the train). The deploy assembles the
   first CI-built image and ships it. `/v1/about` now reports a `release`
   equal to the tag — the field the old flow could leave stale.
4. Retire `push-api-image.sh`; document the full local build as an emergency
   procedure in `docs/deployment.md` §5 (it remains possible: build
   `Dockerfile.data` then `Dockerfile.api` locally).
5. Rewrite the prose: `docs/ci.md` §3 ("The API image is never built in CI,
   and cannot be" — now "the *dataset* is never built in CI; the image is
   assembled there from a pre-pushed data base"), §5 first bullet,
   `docs/deployment.md` §5, `CLAUDE.md` if it gains a deploy sentence, and
   both workflows' headers.

---

## 5. Phase 3 — landing many PRs without the treadmill

Native merge queue is off the table (organization-owned repos only). What
replaces the manual serialization:

- **A ruleset on `main`**: require the five CI checks, block force pushes.
  **Do not require branches to be up to date** — that requirement is the
  rebase treadmill, and the safety it buys (testing the exact merge result
  pre-merge) is bought more cheaply here: CI re-runs on the merge commit on
  `main`, and the train's tip-green gate refuses to ship a red tip. A
  semantic collision between two green PRs surfaces on `main`'s CI within
  minutes, blocks the train (not production), and is fixed forward.
- **Enable auto-merge** in repo settings. The working motion for a sitting
  becomes: review each agent PR, `gh pr merge --auto --merge` each one, walk
  away; they land as their checks finish, in whatever order CI decides.
- **Flake discipline is the real precondition.** Under batch volume a flaky
  test stops being a monthly annoyance and starts blocking trains. Any test
  that flakes twice gets fixed or quarantined the second time, as a `test:`
  commit that releases nothing.

If PR volume ever outgrows this (cross-PR semantic collisions more than
rarely), the upgrade is transferring the repo to a free organization —
redirects preserved, native merge queue unlocked — not adding a bot.

## 6. Failure modes, named

| State | Meaning | Remedy |
|---|---|---|
| Train ran, no release | Nothing releasable merged | None — correct no-op |
| Train skipped, notice about tip | `main`'s tip CI red/absent | Fix `main`; next train ships it |
| Dispatch failed on the gate | Asked to release a red tip | Fix `main`, press again |
| Release red, semantic-release green | Version cut, deploy failed | Re-run **Deploy web** with the tag — unchanged from today, §4.2 makes it also rebuild a missing image |
| Deploy red at the existence gate | Data base missing for the pinned build_id | `push-data-image.sh`, re-run deploy |
| Image exists but assembly logic changed | Old tag redeploys byte-identical image | Intended — tags are immutable |

## 7. Verification

- **Phase 1:** dispatch with `dry_run` on a quiet `main` (no release, green);
  merge a `docs:` PR, confirm the next train is a no-op; merge a `fix:`,
  confirm the train cuts exactly one patch whose notes list it; while red on
  purpose (a branch-protection test commit), confirm cron skips with the
  notice and dispatch fails.
- **Phase 2:** after migration step 3, `curl /v1/about` — `release` equals
  the new tag and `build_id` equals the pinned dataset; re-run the deploy,
  confirm the existence gate short-circuits (no rebuild); roll back to the
  previous tag via **Deploy web**, confirm the previous pairing serves.
- **Phase 3:** open three trivial PRs from three worktrees, auto-merge all
  three with zero manual branch updates, confirm one train releases the batch
  with three-entry notes.

## 8. Sequencing

Three PRs, in order, each independently shippable: Phase 1 (release.yml +
docs), Phase 2 (image split + deploy workflow + docs, then the migration
steps), Phase 3 (settings + a docs/ci.md section; mostly configuration).
Phase 2's crane-vs-docker spike happens inside its PR, not before it.
