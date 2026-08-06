#!/usr/bin/env bash
#
# Path resolution shared by scripts/serve.sh and scripts/dev.sh.
#
# This file exists because of git worktrees. Claude Code puts each parallel
# session in its own worktree under .claude/worktrees/, and a worktree is a
# checkout of *tracked* files only. So it has all the source and none of
# build/ (2.9 GB), snapshot/ (1.7 GB) or web/node_modules. Rebuilding those
# per worktree is hours of pipeline time and gigabytes of disk for artifacts
# that are byte-identical to the ones already on the machine.
#
# So a worktree borrows the main checkout's baked artifacts and keeps its own
# frontend. That split is the whole idea: build/ and snapshot/ are inputs
# nobody edits, web/ is the thing under development.
#
# Sharing them is safe rather than merely convenient. The server mmaps the
# arrays and opens SQLite immutable, both read-only at startup, so N processes
# reading one build/ behaves exactly like one process reading it.
#
# Every function here expects ROOT to be set to the calling script's checkout.

# shellcheck shell=bash

# The main checkout — the directory holding the real .git. In the main
# checkout that is ROOT itself; in a worktree, .git is a file pointing into
# the main repository and --git-common-dir resolves through it.
concestor_main_checkout() {
  local common
  common=$(git -C "$ROOT" rev-parse --path-format=absolute --git-common-dir 2>/dev/null) || return 1
  [ -n "$common" ] || return 1
  dirname "$common"
}

# The two artifacts the server cannot start without, per phase 1.
concestor_has_artifacts() {
  [ -d "$1/build/topology" ] && [ -f "$1/build/concestor.db" ]
}

# Sets CONCESTOR_BUILD, CONCESTOR_SILHOUETTES and CONCESTOR_BORROWED_FROM.
# Returns non-zero when no checkout on this machine has the artifacts, which
# is the one case the caller must turn into a useful error.
concestor_resolve_artifacts() {
  local main=""
  main=$(concestor_main_checkout) || main=""

  CONCESTOR_BUILD=""
  CONCESTOR_BORROWED_FROM=""
  if concestor_has_artifacts "$ROOT"; then
    CONCESTOR_BUILD="$ROOT/build"
  elif [ -n "$main" ] && [ "$main" != "$ROOT" ] && concestor_has_artifacts "$main"; then
    CONCESTOR_BUILD="$main/build"
    CONCESTOR_BORROWED_FROM="$main"
  else
    return 1
  fi

  # Resolved separately from build/, because the PhyloPic mirror can be
  # present in one checkout and absent in the other. The server would
  # otherwise infer it from build/'s parent, which after borrowing is the
  # wrong repository — and a preview with no silhouettes reads as a bug in
  # the renderer rather than a missing mirror.
  CONCESTOR_SILHOUETTES=""
  local candidate
  for candidate in "$ROOT/snapshot/phylopic" "${main:+$main/snapshot/phylopic}"; do
    if [ -n "$candidate" ] && [ -d "$candidate" ]; then
      CONCESTOR_SILHOUETTES="$candidate"
      break
    fi
  done
}

# The message for the one unrecoverable case. Kept here so both entry points
# fail the same way.
concestor_artifacts_missing() {
  printf '\n  %s\n\n' "No build/topology or build/concestor.db, in this checkout or the main one.
  The pipeline has not run. See the quick start in README.md. At minimum:
      cd pipeline && uv sync && uv run concestor-build topology" >&2
  exit 1
}

# The packages web/package.json asks for that $1/web/node_modules does not
# have. npm's own answer rather than a walk of our own, because a hand-rolled
# one gets two things wrong: a platform-specific optional dependency is *meant*
# to be absent (95 of them in this lockfile, every foreign-platform `sharp` and
# `workerd` binary), and a nested copy satisfies a dependency that a hoisted
# one does not. `npm ls` reads the installed tree, needs no network and costs
# ~0.2 s. Of its `problems`, only `missing:` means a package that is not on
# disk — `invalid` and `extraneous` are different complaints and not ours.
#
# `npm ls` exits non-zero whenever it has anything to report, which here is the
# ordinary case, so its status is swallowed rather than allowed to trip
# `pipefail` in the callers. An unreadable answer is reported as a shortfall
# rather than as silence: this whole function exists because a check that
# cannot tell said everything was fine.
concestor_lock_shortfall() {
  { npm --prefix "$1/web" ls --all --json 2>/dev/null || true; } |
    node -e '
      const chunks = [];
      process.stdin.on("data", (d) => chunks.push(d)).on("end", () => {
        let problems;
        try {
          problems = JSON.parse(Buffer.concat(chunks)).problems || [];
        } catch {
          problems = ["missing: (npm ls gave no readable answer)"];
        }
        for (const p of problems) {
          if (p.startsWith("missing:")) console.log(p.slice(8).split(",")[0].trim());
        }
      });
    '
}

# node_modules is gitignored, so a fresh worktree has none. Copying the main
# checkout's tree beats a fresh install: it needs no network, and on APFS
# `cp -c` clones copy-on-write, so 103 MB costs neither time nor disk until
# something diverges. Only when the lockfiles agree — a worktree that changed
# dependencies gets a real install.
#
# A copy rather than a symlink, deliberately: a later `npm install` in the
# worktree must not reach through and rewrite the main checkout's tree.
#
# Matching lockfiles decide whether cloning is *appropriate*; they cannot
# decide whether the result is *usable*, and for a while this function asked
# only the first question. Two checkouts on the same commit have identical
# lockfiles by construction, so `cmp` passed while the tree being cloned was
# itself 52 packages behind its own lockfile — every worktree faithfully
# inherited a `node_modules` with no `jsdom` in it, and reported nothing. The
# tree is therefore checked against the lockfile after it exists, whatever
# produced it, and a shortfall is installed rather than carried.
concestor_ensure_node_modules() {
  local main="" cloned_from=""
  main=$(concestor_main_checkout) || main=""

  if [ ! -d "$ROOT/web/node_modules" ]; then
    if [ -n "$main" ] && [ "$main" != "$ROOT" ] &&
      [ -d "$main/web/node_modules" ] &&
      cmp -s "$main/web/package-lock.json" "$ROOT/web/package-lock.json"; then
      echo "web/node_modules missing — cloning from $main (lockfiles match)…" >&2
      if ! cp -Rc "$main/web/node_modules" "$ROOT/web/node_modules" 2>/dev/null; then
        rm -rf "$ROOT/web/node_modules"
        cp -R "$main/web/node_modules" "$ROOT/web/node_modules"
      fi
      cloned_from="$main"
    else
      echo "web/node_modules missing — installing…" >&2
      (cd "$ROOT/web" && npm install --no-audit --no-fund) || return 1
    fi
  fi

  # Also reached by a worktree that has been sitting on a bad clone since
  # before this check existed, which is the point of doing it here rather than
  # only after the copy above.
  local short
  short=$(concestor_lock_shortfall "$ROOT")
  [ -n "$short" ] || return 0

  echo "web/node_modules does not satisfy web/package-lock.json. Missing:" >&2
  echo "$short" | sed 's/^/    /' >&2
  if [ -n "$cloned_from" ]; then
    echo "  The clone is faithful; the tree it came from is not current." >&2
    echo "  Run 'npm --prefix web install' in $cloned_from too," >&2
    echo "  or every worktree after this one pays for it again." >&2
  fi
  echo "Installing the shortfall…" >&2

  (cd "$ROOT/web" && npm install --no-audit --no-fund) || {
    concestor_node_modules_unfixable
    return 1
  }

  short=$(concestor_lock_shortfall "$ROOT")
  [ -n "$short" ] || return 0
  concestor_node_modules_unfixable
  return 1
}

# The other unrecoverable case, alongside concestor_artifacts_missing: the
# frontend's dependencies are not there and cannot be fetched. Said here so
# nothing downstream has to guess, because the failure it turns into is
# `Cannot find package 'jsdom'` from inside vitest's pool, which reads as a
# broken test harness rather than a checkout that never finished installing.
concestor_node_modules_unfixable() {
  printf '\n  %s\n\n' "web/node_modules is still short of web/package-lock.json and the
  install did not fix it. Nothing that compiles, tests or bundles web/ will
  work until it does. Run it yourself and read the error:
      npm --prefix web install" >&2
}

# Lowest free TCP port at or above $1, checked with bash's own /dev/tcp so
# this stays dependency-free. Racy in principle; the loser fails loudly.
concestor_free_port() {
  local port=$1 limit=$((${1} + 64))
  while [ "$port" -lt "$limit" ]; do
    if ! (exec 3<>"/dev/tcp/127.0.0.1/$port") 2>/dev/null; then
      echo "$port"
      return 0
    fi
    exec 3>&- 2>/dev/null || true
    port=$((port + 1))
  done
  echo "no free port in $1..$limit" >&2
  return 1
}
