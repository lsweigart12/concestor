#!/usr/bin/env bash
#
# Every check CI runs, plus the ones it cannot: the dataset tests.
#
# CI runs on a clean checkout, so 82 of the 99 Go tests and 47 of the 291
# pipeline tests skip themselves and both suites still report success. That is
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
# Resolved through the same borrowing rules as serve.sh, so this works in a
# worktree. The symlink is the missing half: `testenv.BuildDir` walks six
# parents from server/internal/store, which from a worktree stops one level
# short of the main checkout, so borrowing alone is not enough — Go has to
# find a build/ at *this* root. It is gitignored, so leaving it costs nothing
# and makes every later `go test` in this worktree honest too.
export CONCESTOR_REQUIRE_BUILD=""
if [ "$WANT_DATASET" = 1 ] && concestor_resolve_artifacts; then
  if [ -n "$CONCESTOR_BORROWED_FROM" ] && [ ! -e "$ROOT/build" ]; then
    ln -s "$CONCESTOR_BUILD" "$ROOT/build"
    echo "Linked build/ -> $CONCESTOR_BUILD (borrowed, gitignored)" >&2
  fi
  export CONCESTOR_REQUIRE_BUILD=1
  echo "Dataset tests: required, against $CONCESTOR_BUILD" >&2
elif [ "$WANT_DATASET" = 1 ]; then
  echo "Dataset tests: skipped — no build/ in this checkout or the main one." >&2
  echo "  This is CI's coverage, not a full run. See docs/ci.md §2." >&2
else
  echo "Dataset tests: skipped by --no-dataset." >&2
fi

# --- pipeline ---------------------------------------------------------------
# The four gates CLAUDE.md requires of every pipeline change, in order.
if wants pipeline; then
  gate "pipeline · ruff format" uv run --project pipeline ruff format --check pipeline/src pipeline/tests
  gate "pipeline · ruff check" uv run --project pipeline ruff check pipeline/src pipeline/tests
  gate "pipeline · ty" bash -c 'cd pipeline && uv run ty check'
  gate "pipeline · pytest" bash -c 'cd pipeline && uv run pytest -q -rs'
fi

# --- server -----------------------------------------------------------------
if wants server; then
  gate "server · gofmt" bash -c '
    cd server
    out=$(gofmt -l .)
    [ -z "$out" ] || { echo "gofmt would rewrite:"; echo "$out"; exit 1; }'
  gate "server · go vet" go vet -C server ./...
  gate "server · go test" go test -C server ./...
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
  gate "web · typecheck" npm --prefix web run typecheck
  gate "web · test" npm --prefix web test
  gate "web · build" npm --prefix web run build
fi

# --- cloudflare -------------------------------------------------------------
# The same dry run CI does: bundles the Worker and validates wrangler.jsonc
# without credentials. Needs web/dist, so it runs after the build above.
if wants cloudflare && [ "$NODE_MODULES" = 1 ]; then
  if [ ! -f "$ROOT/web/dist/index.html" ]; then
    gate "web · build (for the dry run)" npm --prefix web run build
  fi
  gate "cloudflare · wrangler dry run" env WRANGLER_SEND_METRICS=false npm --prefix web run cf:check
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
