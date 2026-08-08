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

**Landed.** `docs/deployment.md` "The container image, and its two cadences"
describes it, including the spike's answer: `crane mutate` against the remote
base, ~7 s, because the Cloudflare registry dedupes blobs across repositories
in an account. The Docker fallback survives as `server/Dockerfile.api` and the
emergency procedure in `docs/deployment.md`.

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
