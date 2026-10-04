#!/usr/bin/env bash
#
# Every check CI runs, plus the ones it cannot: the dataset tests.
#
# CI runs on a clean checkout, so most of the Go suite and a fifth of the
# pipeline's skip themselves and both still report success — docs/ci.md §2
# counts the split, and is the only place that does. That is
# the right default there — producing build/ is hours of pipeline time against
# APIs with no rate limiting — but it means a green CI badge says nothing
# about any code path that reads the baked artifacts. This script is where
# that half gets tested, on a machine that already has a build.
#
# It follows the pipeline's own convention: collect failures and report all of
# them at the end, rather than stopping at the first. A run that tells you
# about one broken gate when three are broken costs three runs.
#
# Usage:
#   scripts/check.sh              everything; dataset tests required if a build is reachable
#   scripts/check.sh --no-dataset skip the dataset half even when a build is there
#   scripts/check.sh web|server|pipeline|cloudflare   just that half

set -uo pipefail

cd "$(dirname "$0")/.."
ROOT="$PWD"

# shellcheck source=lib/paths.sh
. "$ROOT/scripts/lib/paths.sh"

WANT_DATASET=1
ONLY=""
for arg in "$@"; do
  case "$arg" in
  --no-dataset) WANT_DATASET=0 ;;
  web | server | pipeline | cloudflare) ONLY="$arg" ;;
  *)
    echo "unknown argument: $arg" >&2
    exit 2
    ;;
  esac
done

FAILED=()

# Runs one check, records the failure, and keeps going.
gate() {
  local name=$1
  shift
  printf '\n\033[1m▸ %s\033[0m\n' "$name" >&2
  if ! "$@"; then
    FAILED+=("$name")
  fi
}

wants() { [ -z "$ONLY" ] || [ "$ONLY" = "$1" ]; }

# --- the dataset ------------------------------------------------------------
# A worktree has no build/ of its own until one is cloned into its state
# directory, and the pipeline's tests read only that one: `paths.BUILD` is
# also where a phase writes, so it never falls back to another checkout's.
#
# `concestor_borrow_build` makes the clone, and scripts/lib/paths.sh says why
# it is a clone rather than a link. It runs before resolution, so what gets
# resolved below is this checkout's own directory.
export CONCESTOR_REQUIRE_BUILD=""
if [ "$WANT_DATASET" = 1 ]; then
  concestor_borrow_build
fi
if [ "$WANT_DATASET" = 1 ] && concestor_resolve_artifacts; then
  export CONCESTOR_REQUIRE_BUILD=1
  echo "Dataset tests: required, against $CONCESTOR_BUILD" >&2
  if [ -n "${CONCESTOR_BORROW_NOTE:-}" ]; then
    echo "  $CONCESTOR_BORROW_NOTE" >&2
  fi

  # **Observe, not require.** web/wrangler.jsonc pins the dataset production
  # serves, and this checkout's build/ is whatever the pipeline last produced
  # here — a rebuilt local dataset is the normal state of a machine that runs
  # the pipeline, so a gate that failed on the difference would block every
  # experiment. What it is worth saying is that the two have parted, because
  # the only other way to find out is a deploy that serves the old data.
  #
  # This is also what replaced a hazard rather than adding one. The image tag
  # used to be minted locally from build/manifest.json, so a single-phase rerun
  # without `package` left the manifest stale and the tag quietly lied about
  # which artifacts it held. Nothing local mints that tag any more; this note
  # is where the same question gets asked instead.
  LOCAL_BUILD_ID=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["build_id"])' \
    "$CONCESTOR_BUILD/manifest.json" 2>/dev/null || echo "")
  PINNED_BUILD_ID=$(sed -n 's|.*/concestor-api:\([A-Za-z0-9_.]*\)-RELEASE.*|\1|p' \
    "$ROOT/web/wrangler.jsonc" | head -1)
  if [ -n "$LOCAL_BUILD_ID" ] && [ -n "$PINNED_BUILD_ID" ] && [ "$LOCAL_BUILD_ID" != "$PINNED_BUILD_ID" ]; then
    printf '\033[33mDataset pin: local build/ is %s, web/wrangler.jsonc pins %s.\033[0m\n' \
      "$LOCAL_BUILD_ID" "$PINNED_BUILD_ID" >&2
    echo "  Production is not serving what this checkout holds. When it should:" >&2
    echo "    CLOUDFLARE_ACCOUNT_ID=… scripts/deploy/push-data-image.sh" >&2
    echo "  then commit the pin it prints. Observation, not a failure." >&2
  fi
elif [ "$WANT_DATASET" = 1 ]; then
  echo "Dataset tests: skipped — no build/ in this checkout or the main one." >&2
  echo "  This is CI's coverage, not a full run. See docs/ci.md §2." >&2
else
  echo "Dataset tests: skipped by --no-dataset." >&2
fi

# --- where the checks write -------------------------------------------------
# In a worktree, to its state directory, so that its tree is left as it was
# found — scripts/lib/paths.sh says what depends on that. tsc, vitest and the
# bundle already write under web/node_modules or where they are told. The
# Python tools write beside the source unless the environment says otherwise.
if [ "$CONCESTOR_STATE" != "$ROOT" ]; then
  export UV_PROJECT_ENVIRONMENT="$CONCESTOR_STATE/pipeline/.venv"
  export PYTHONPYCACHEPREFIX="$CONCESTOR_STATE/pycache"
  export RUFF_CACHE_DIR="$CONCESTOR_STATE/pipeline/.ruff_cache"
fi

# --- pipeline ---------------------------------------------------------------
# The four gates AGENTS.md requires of every pipeline change, in order.
if wants pipeline; then
  gate "pipeline · ruff format" uv run --project pipeline ruff format --check pipeline/src pipeline/tests
  gate "pipeline · ruff check" uv run --project pipeline ruff check pipeline/src pipeline/tests
  gate "pipeline · ty" bash -c 'cd pipeline && uv run ty check'
  gate "pipeline · pytest" bash -c 'cd pipeline && uv run pytest -q -rs -o cache_dir="$1"' \
    _ "$CONCESTOR_STATE/pipeline/.pytest_cache"
fi

# --- server -----------------------------------------------------------------
if wants server; then
  gate "server · gofmt" bash -c '
    cd server
    out=$(gofmt -l .)
    [ -z "$out" ] || { echo "gofmt would rewrite:"; echo "$out"; exit 1; }'
  gate "server · go vet" go vet -C server ./...
  # **`-count=1` is not a preference, it is the whole point of this script.**
  #
  # Go's test cache keys on the source, the flags and the environment. It does
  # not key on `build/` — 3.2 GB of mmap'd arrays and an immutable database
  # that no compiler input mentions — so a rerun of a pipeline phase changes
  # every dataset test's subject and invalidates nothing. `go test` then
  # prints `ok (cached)` for a test that would now fail.
  #
  # That is not hypothetical. `TestLayoutSpreadCensus` went red the moment
  # phase 4 promoted one node's tier, and this script reported "All checks
  # passed, dataset included" in green over it for the rest of the day, on
  # every branch, because the cached pass predated the rebuild. A tool whose
  # entire reason to exist is catching what CI cannot must not be able to say
  # that — it is the same silent success docs/ci.md §2 is about, one level up.
  #
  # The cost is the full suite every time, ~80 s. CI keeps the cache: its
  # runner has no `build/`, so its dataset tests skip and there is nothing for
  # a stale entry to hide.
  gate "server · go test" go test -C server -count=1 ./...
fi

# --- web dependencies -------------------------------------------------------
# Resolved once, before either half that needs it, and a failure here cancels
# both. Every web and cloudflare check below fails on a short node_modules, so
# running them anyway reports five broken checks where there is one unfinished
# checkout — and the loudest of the five is vitest's `Cannot find package
# 'jsdom'`, which names the test harness rather than the cause.
NODE_MODULES=0
if wants web || wants cloudflare; then
  if concestor_ensure_node_modules; then
    NODE_MODULES=1
  else
    FAILED+=("web · node_modules")
  fi
fi

# --- web --------------------------------------------------------------------
if wants web && [ "$NODE_MODULES" = 1 ]; then
  # The .ico and the touch icon are generated from web/public/favicon.svg, and
  # the share card from the same script. `src/icons.test.ts` pins the
  # generator's geometry to the SVG and `src/meta.test.ts` pins the document's
  # tags to the card it ships; this pins the committed bytes to the generator,
  # which is the half a test inside web/ cannot do without carrying a second
  # rasteriser.
  gate "web · images" python3 scripts/make-icons.py --check
  # Formatter then linter then typechecker, matching the order the pipeline and
  # server halves already use. `web/prettier.config.js` and
  # `web/.oxlintrc.json` say what each enforces and why.
  gate "web · prettier" npm --prefix web run format:check
  gate "web · oxlint" npm --prefix web run lint
  gate "web · typecheck" npm --prefix web run typecheck
  gate "web · test" npm --prefix web test
  gate "web · build" concestor_build_web
fi

# --- cloudflare -------------------------------------------------------------
# The same dry run CI does: bundles the Worker and validates wrangler.jsonc
# without credentials. Needs web/dist, so it runs after the build above.
#
# Told where the bundle is and where to write its own, as CI's is, because in
# a worktree neither is in the tree. wrangler makes an empty .wrangler/tmp
# beside its config whatever it is told; `rmdir` takes that back and cannot
# take anything else.
wrangler_dry_run() {
  local status=0
  (cd "$ROOT/web" && WRANGLER_SEND_METRICS=false npx wrangler deploy --dry-run \
    --assets "$CONCESTOR_STATE/web/dist" \
    --outdir "$CONCESTOR_STATE/web/.wrangler/dry-run") || status=$?
  rmdir "$ROOT/web/.wrangler/tmp" "$ROOT/web/.wrangler" 2>/dev/null || true
  return "$status"
}

if wants cloudflare && [ "$NODE_MODULES" = 1 ]; then
  if [ ! -f "$CONCESTOR_STATE/web/dist/index.html" ]; then
    gate "web · build (for the dry run)" concestor_build_web
  fi
  gate "cloudflare · wrangler dry run" wrangler_dry_run
fi

# --- the tree ---------------------------------------------------------------
# What T3 Code looks at before it retires a worktree: an ignored file in the
# tree, other than node_modules, keeps the worktree. Nothing above leaves
# one, so whatever is listed came from a tool run by hand. An observation,
# never a failure — it is this worktree's business what it holds.
if [ "$CONCESTOR_STATE" != "$ROOT" ]; then
  LEFT=$(git -C "$ROOT" ls-files --others --ignored --exclude-standard --directory |
    grep -Ev '(^|/)node_modules/$' || true)
  if [ -n "$LEFT" ]; then
    printf '\n\033[33mIgnored files in this worktree, which keep it from being retired:\033[0m\n' >&2
    printf '%s\n' "$LEFT" | sed 's/^/  /' >&2
    echo "  To clear them:  git clean -fdX   (web/node_modules is cloned back on the next run)" >&2
  fi
fi

# --- report -----------------------------------------------------------------
echo
if [ ${#FAILED[@]} -eq 0 ]; then
  if [ -n "$CONCESTOR_REQUIRE_BUILD" ]; then
    printf '\033[32mAll checks passed, dataset included.\033[0m\n'
  else
    printf '\033[33mAll checks passed — but the dataset tests did not run.\033[0m\n'
  fi
  exit 0
fi

printf '\033[31m%d check(s) failed:\033[0m\n' "${#FAILED[@]}"
printf '  %s\n' "${FAILED[@]}"
exit 1
