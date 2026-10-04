#!/usr/bin/env bash
#
# Path resolution shared by scripts/serve.sh, dev.sh, check.sh,
# setup-worktree.sh, analytics-report.sh and deploy/push-data-image.sh.
#
# This file exists because of git worktrees. Each parallel session gets its
# own — Claude Code's under .claude/worktrees/, T3 Code's under
# ~/.t3/worktrees/ — and a worktree is a checkout of *tracked* files only. So
# it has all the source and none of build/ (3.2 GB), snapshot/ (1.7 GB) or
# web/node_modules. Rebuilding those per worktree is hours of pipeline time
# and gigabytes of disk for artifacts that are byte-identical to the ones
# already on the machine.
#
# So a worktree borrows the main checkout's baked artifacts and keeps its own
# frontend. That split is the whole idea: build/ and snapshot/ are inputs
# the session under way is not writing, web/ is the thing under development.
#
# **Borrowing is not one mechanism.** Reading really is free to share — the
# server mmaps the arrays and opens SQLite immutable, both read-only at
# startup, so N processes reading one build/ behaves exactly like one process
# reading it. Writing is not, and the pipeline writes its arrays in place. So
# build/ is cloned copy-on-write (cheap on APFS, and private), while snapshot/
# is read where it is, in the main checkout (append-only, and shared on
# purpose). `concestor_borrow_build` below carries the argument; docs/ci.md §2
# "Running in a git worktree" is the account of record.
#
# **What a checkout derives lives in its state directory, CONCESTOR_STATE.**
# That is the checkout itself in the main checkout and `<git-dir>/concestor`
# in a worktree, and a gitignored path P is `$CONCESTOR_STATE/P` in both — so
# the dataset is `$CONCESTOR_STATE/build` and the bundle
# `$CONCESTOR_STATE/web/dist`, and in the main checkout each is where it
# always was. A worktree's own tree is left holding tracked files and
# web/node_modules, which is what lets it be retired without anyone looking:
# T3 Code will not remove a worktree that has any other ignored file in it,
# and `git worktree remove` takes the git directory, state and all.
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

# Where this checkout keeps what it derives — see the header. Outside a git
# repository, which is how a release tarball unpacks, that is the tree itself.
#
# `server/internal/testenv` and `concestor_build/paths.py` each make the same
# decision by reading `.git` rather than asking git. Change it in all three.
concestor_state_dir() {
  local git_dir common
  git_dir=$(git -C "$ROOT" rev-parse --path-format=absolute --git-dir 2>/dev/null) || git_dir=""
  common=$(git -C "$ROOT" rev-parse --path-format=absolute --git-common-dir 2>/dev/null) || common=""
  if [ -z "$git_dir" ] || [ "$git_dir" = "$common" ]; then
    echo "$ROOT"
  else
    echo "$git_dir/concestor"
  fi
}
CONCESTOR_STATE=$(concestor_state_dir)

# The two artifacts the server cannot start without, per phase 1, in the
# build directory $1.
concestor_has_artifacts() {
  [ -d "$1/topology" ] && [ -f "$1/concestor.db" ]
}

# Sets CONCESTOR_BUILD, CONCESTOR_SILHOUETTES and CONCESTOR_BORROWED_FROM.
# Returns non-zero when no checkout on this machine has the artifacts, which
# is the one case the caller must turn into a useful error.
concestor_resolve_artifacts() {
  local main=""
  main=$(concestor_main_checkout) || main=""

  CONCESTOR_BUILD=""
  CONCESTOR_BORROWED_FROM=""
  if concestor_has_artifacts "$CONCESTOR_STATE/build"; then
    CONCESTOR_BUILD="$CONCESTOR_STATE/build"
  elif [ -n "$main" ] && [ "$main" != "$ROOT" ] && concestor_has_artifacts "$main/build"; then
    CONCESTOR_BUILD="$main/build"
    CONCESTOR_BORROWED_FROM="$main"
  else
    return 1
  fi

  # snapshot/ is the main checkout's, in every checkout: 1.7 GB of pinned
  # upstream sources that nothing rewrites, so there is one copy and no
  # worktree holds another. Passed to the server explicitly, because it would
  # otherwise infer the PhyloPic mirror from build/'s parent, which in a
  # worktree is its git directory — and a preview with no silhouettes reads as
  # a bug in the renderer rather than a missing mirror.
  CONCESTOR_SILHOUETTES=""
  if [ -n "$main" ] && [ -d "$main/snapshot/phylopic" ]; then
    CONCESTOR_SILHOUETTES="$main/snapshot/phylopic"
  elif [ -d "$ROOT/snapshot/phylopic" ]; then
    CONCESTOR_SILHOUETTES="$ROOT/snapshot/phylopic"
  fi
}

# The dataset id `concestor-build package` wrote into a manifest, or empty.
#
# Deliberately not the id /v1/about reports: `store.computeBuildID` hashes file
# sizes and *mtimes*, so a copy of an artifact set gets a different answer than
# the original. That is right for an ETag and wrong for a name, and a clone is
# exactly the case where the difference shows. docs/deployment.md §5.
concestor_build_id() {
  python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["build_id"])' \
    "$1" 2>/dev/null || echo ""
}

# Moves what a worktree made before the state directory existed out of its
# tree: a real build/ goes to the state directory with whatever a pipeline run
# left in it, and the links — build/ where it was one, snapshot/'s entries —
# are removed. Removing a symlink never touches its target.
concestor_empty_the_tree() {
  local link
  if [ -L "$ROOT/build" ]; then
    rm "$ROOT/build"
  elif [ -d "$ROOT/build" ] && [ ! -e "$CONCESTOR_STATE/build" ]; then
    mkdir -p "$CONCESTOR_STATE"
    mv "$ROOT/build" "$CONCESTOR_STATE/build"
    echo "Moved build/ out of the working tree, to $CONCESTOR_STATE/build" >&2
  fi
  for link in "$ROOT"/snapshot/*; do
    if [ -L "$link" ]; then
      rm "$link"
    fi
  done
}

# Gives a worktree a build/ of its own in its state directory, cloned from the
# main checkout's.
#
# **The clone is the point.** A worktree used to borrow by symlink, which reads
# perfectly and writes catastrophically: every pipeline phase writes its arrays
# in place, so `concestor-build dates` in a worktree rewrote the main
# checkout's artifacts under whatever had them mmap'd, and under every other
# worktree pointing at the same directory. 26 of 28 worktrees on this machine
# were in that state when this was written.
#
# It is affordable because of APFS. `cp -c` clones copy-on-write, so the whole
# 3.2 GB artifact set costs 0.38 s and 2.2 MB of disk — measured on this
# repository's build/, not estimated. Blocks are shared until something writes,
# which means a worktree that rebuilds one phase pays only for that phase's
# output. That is the "build on top" this is for. The state directory is in
# the main checkout's .git, so the two are always on one volume.
#
# Where cloning is impossible — any filesystem without copy-on-write, where a
# real copy would be 3.2 GB per session — it falls back to the old symlink and
# says so. `paths.check_build_writable` in the pipeline refuses to run a phase
# against that shape, which is the correct outcome: on such a machine a
# worktree can serve and test the shared dataset but cannot rebuild it.
#
# Sets CONCESTOR_BORROW_NOTE to a line worth printing, or empty.
concestor_borrow_build() {
  CONCESTOR_BORROW_NOTE=""

  local main="" build="$CONCESTOR_STATE/build"
  main=$(concestor_main_checkout) || return 0
  # The main checkout owns its artifacts; there is nothing to borrow from.
  [ -n "$main" ] && [ "$main" != "$ROOT" ] || return 0
  concestor_empty_the_tree
  concestor_has_artifacts "$main/build" || return 0

  # The fallback's shape, tried again in case the filesystem can clone now.
  if [ -L "$build" ]; then
    rm "$build"
  fi

  if [ -e "$build" ]; then
    concestor_borrow_staleness "$main"
    return 0
  fi

  # Cloned straight to the final name rather than staged and renamed. The
  # failure path below is what makes that safe.
  mkdir -p "$CONCESTOR_STATE"
  if cp -Rc "$main/build" "$build" 2>/dev/null; then
    concestor_write_borrow_stamp "$main"
    CONCESTOR_BORROW_NOTE="build/ is a copy-on-write clone of $main/build"
    echo "Cloned build/ from $main to $build (copy-on-write, writable here)" >&2
    return 0
  fi

  # Only ever a partial copy this function just made: any pre-existing symlink
  # was removed above, and any pre-existing directory returned above. Checked
  # anyway, because this is an `rm -rf` and the cost of being wrong is 3.2 GB
  # of someone else's artifacts.
  if [ -e "$build" ] && [ ! -L "$build" ]; then
    rm -rf "$build"
  fi

  ln -s "$main/build" "$build"
  CONCESTOR_BORROW_NOTE="build/ is a SYMLINK into $main — this filesystem has no copy-on-write"
  printf '\n  %s\n\n' "build/ could not be cloned, so it is a symlink to $main/build.
  Reading is fine — that is what serving and testing do. Writing is not: the
  pipeline refuses to run a phase here, because it would rewrite that
  checkout's artifacts in place. Rebuild the dataset from $main." >&2
}

# Records what was cloned and when, so a clone can later say it is behind
# rather than look current.
concestor_write_borrow_stamp() {
  local main=$1 bid
  bid=$(concestor_build_id "$main/build/manifest.json")
  printf '{\n  "from": "%s",\n  "build_id": "%s",\n  "cloned_at": "%s"\n}\n' \
    "$main" "$bid" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" >"$CONCESTOR_STATE/build/.borrowed"
}

# Says when the checkout this build/ was cloned from has since rebuilt.
#
# This is the local half of the drift check scripts/check.sh already runs
# against web/wrangler.jsonc's pin: the same question — "is the dataset in
# front of me the one that is meant to be current?" — asked of the machine
# rather than of production. An observation, never a failure: a worktree
# deliberately holding an older dataset while a rebuild lands elsewhere is a
# legitimate thing to be doing, and only the reader knows which it is.
concestor_borrow_staleness() {
  local main=$1 build="$CONCESTOR_STATE/build" was now
  [ -f "$build/.borrowed" ] || return 0

  was=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1])).get("build_id",""))' \
    "$build/.borrowed" 2>/dev/null || echo "")
  now=$(concestor_build_id "$main/build/manifest.json")
  [ -n "$was" ] && [ -n "$now" ] || return 0

  if [ "$was" = "$now" ]; then
    CONCESTOR_BORROW_NOTE="build/ is a clone of $main/build, dataset $was"
    return 0
  fi

  CONCESTOR_BORROW_NOTE="build/ is dataset $was; $main has rebuilt to $now"
  printf '\033[33m%s\033[0m\n' "build/ here was cloned from $main at dataset $was." >&2
  echo "  That checkout is now on $now — this clone is behind." >&2
  echo "  To take the newer one:  rm -rf \"$build\"   (it is re-cloned on next run)" >&2
  echo "  Observation, not a failure — an older dataset may be what you want." >&2
}

# The message for the one unrecoverable case. Kept here so both entry points
# fail the same way.
concestor_artifacts_missing() {
  printf '\n  %s\n\n' "No build/topology or build/concestor.db, in this checkout or the main one.
  The pipeline has not run. See the quick start in README.md. At minimum:
      cd pipeline && uv sync && uv run concestor-build topology" >&2
  exit 1
}

# Builds the frontend into the state directory's web/dist, which
# web/vite.config.ts takes from the environment.
concestor_build_web() {
  (cd "$ROOT/web" && CONCESTOR_WEB_DIST="$CONCESTOR_STATE/web/dist" npm run build)
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

# Whether nothing is listening on TCP port $1, checked with bash's own
# /dev/tcp so this stays dependency-free.
#
# Probed by name, not as 127.0.0.1: bash tries every address `localhost`
# resolves to, and Vite listens on [::1] alone, where an IPv4 probe sees a
# free port.
concestor_port_free() {
  ! (exec 3<>"/dev/tcp/localhost/$1") 2>/dev/null
}

# Lowest free TCP port at or above $1. Racy in principle; the loser fails
# loudly.
concestor_free_port() {
  local port=$1 limit=$((${1} + 64))
  while [ "$port" -lt "$limit" ]; do
    if concestor_port_free "$port"; then
      echo "$port"
      return 0
    fi
    port=$((port + 1))
  done
  echo "no free port in $1..$limit" >&2
  return 1
}

# The port this checkout serves on: $PORT when the caller names one,
# otherwise $1 plus an offset derived from the checkout's path.
#
# Derived rather than first-free so that a checkout's URL is the same on every
# run and is never another checkout's. A preview left open on a first-free
# port shows whichever checkout took that port next, and the default every
# Vite project shares is taken by whichever started first. T3 Code needs no
# configured URL to find it: it lists a thread's listening servers on the
# thread itself.
#
# A derived port something else already holds moves to the next free one,
# unless the holder is this checkout — then it is already being served, and
# starting a second server would only split the reader between two.
concestor_checkout_port() {
  if [ -n "${PORT:-}" ]; then
    echo "$PORT"
    return 0
  fi

  local sum port pid cwd
  sum=$(printf '%s' "$ROOT" | cksum)
  port=$(($1 + ${sum%% *} % 800))
  if concestor_port_free "$port"; then
    echo "$port"
    return 0
  fi

  # Compared as physical paths, which is what lsof reports.
  pid=$(lsof -nP -t -iTCP:"$port" -sTCP:LISTEN 2>/dev/null | head -1)
  cwd=$(lsof -a -p "${pid:-0}" -d cwd -Fn 2>/dev/null | sed -n 's/^n//p')
  case "$cwd/" in
  "$(cd "$ROOT" && pwd -P)"/*)
    echo "This checkout is already being served on http://localhost:$port (pid $pid)." >&2
    return 1
    ;;
  esac
  concestor_free_port "$port"
}
