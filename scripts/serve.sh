#!/usr/bin/env bash
#
# Start Concestor for local preview: one Go process serving both the read API
# on /v1 and the built frontend on /.
#
# This is what `.claude/launch.json` runs, so it is also what the preview
# browser opens. It is deliberately a single process rather than the Vite dev
# server plus an API — a preview should show the thing that ships, and the
# server already serves `web/dist` with SPA fallback. Use `scripts/dev.sh`
# when you want hot reload; that starts its own API and proxies /v1 to it.
#
# It refuses to start rather than serving something misleading. An empty canvas
# because `build/` is missing looks identical to an empty canvas because the
# app is broken, and the difference costs whoever hits it an hour.
#
# Runs unchanged inside a git worktree, where build/ and snapshot/ do not
# exist — see scripts/lib/paths.sh for what gets borrowed and why.

set -euo pipefail

cd "$(dirname "$0")/.."
ROOT="$PWD"
PORT="${PORT:-8080}"

# shellcheck source=lib/paths.sh
. "$ROOT/scripts/lib/paths.sh"

# --- the baked artifacts ----------------------------------------------------
# The runtime is read-only over files the pipeline produces; without them there
# is nothing to serve and no useful degraded mode.
concestor_resolve_artifacts || concestor_artifacts_missing

if [ -n "$CONCESTOR_BORROWED_FROM" ]; then
  echo "Borrowing read-only artifacts from $CONCESTOR_BORROWED_FROM" >&2
fi

# --- the frontend -----------------------------------------------------------
# Built, not dev-served. Rebuild only when it is missing; `npm run build` is
# fast but a preview that silently recompiles on every launch hides the fact
# that dist is stale.
if [ ! -f "$ROOT/web/dist/index.html" ]; then
  echo "web/dist missing — building the frontend once…" >&2
  concestor_ensure_node_modules
  (cd "$ROOT/web" && npm run build)
fi

# --- serve ------------------------------------------------------------------
# `-C server` because the Go module lives there. Every path is passed
# absolute rather than left to its default. The server derives both the
# frontend and the silhouette root from `-build`'s parent directory, so once
# build/ is borrowed they both follow it to the main checkout: right for the
# silhouette mirror, wrong for the frontend, which must come from *this*
# checkout because it is the thing being worked on. Passing both explicitly
# makes the first deliberate rather than lucky, and fixes the second.
#
# `-immutable=false` drops `Cache-Control: immutable` from /v1 responses. That
# header is correct in production — the data genuinely cannot change within a
# build — and actively hostile locally, where it makes the browser serve last
# hour's search results out of cache after you have rebuilt the index.
#
# It does NOT make the dataset hot-reloadable: the arrays are mmap'd and
# SQLite is opened immutable, both at startup. **Restart this after any
# pipeline run**, or you are looking at the previous build.
args=(-addr ":${PORT}" -build "$CONCESTOR_BUILD" -web "$ROOT/web/dist" -immutable=false)
[ -n "$CONCESTOR_SILHOUETTES" ] && args+=(-silhouettes "$CONCESTOR_SILHOUETTES")

echo "Concestor on http://localhost:${PORT}  (Ctrl-C to stop)" >&2
exec go run -C server . "${args[@]}"
