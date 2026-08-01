#!/usr/bin/env bash
#
# Start Concestor for local preview: one Go process serving both the read API
# on /v1 and the built frontend on /.
#
# This is what `.claude/launch.json` runs, so it is also what the preview
# browser opens. It is deliberately a single process rather than the Vite dev
# server plus an API — a preview should show the thing that ships, and the
# server already serves `web/dist` with SPA fallback. Use `npm run dev` in
# `web/` when you want hot reload; that proxies /v1 here.
#
# It refuses to start rather than serving something misleading. An empty canvas
# because `build/` is missing looks identical to an empty canvas because the
# app is broken, and the difference costs whoever hits it an hour.

set -euo pipefail

cd "$(dirname "$0")/.."
ROOT="$PWD"
PORT="${PORT:-8080}"

fail() {
  printf '\n  %s\n\n' "$1" >&2
  exit 1
}

# --- the baked artifacts ----------------------------------------------------
# The runtime is read-only over files the pipeline produces; without them there
# is nothing to serve and no useful degraded mode.
[ -d "$ROOT/build/topology" ] || fail \
  "No build/topology — the pipeline has not run.
  See docs/handoff.md §2 'Reproduce from a clean checkout'. At minimum:
      cd pipeline && uv sync && uv run concestor-build topology"

[ -f "$ROOT/build/concestor.db" ] || fail \
  "No build/concestor.db — phase 1 has not run. See docs/handoff.md §2."

# --- the frontend -----------------------------------------------------------
# Built, not dev-served. Rebuild only when it is missing; `npm run build` is
# fast but a preview that silently recompiles on every launch hides the fact
# that dist is stale.
if [ ! -f "$ROOT/web/dist/index.html" ]; then
  echo "web/dist missing — building the frontend once…" >&2
  [ -d "$ROOT/web/node_modules" ] || (cd "$ROOT/web" && npm install --no-audit --no-fund)
  (cd "$ROOT/web" && npm run build)
fi

# --- serve ------------------------------------------------------------------
# `-C server` because the Go module lives there; the binary still resolves
# `-build ../build` relative to it.
#
# `-immutable=false` drops `Cache-Control: immutable` from /v1 responses. That
# header is correct in production — the data genuinely cannot change within a
# build — and actively hostile locally, where it makes the browser serve last
# hour's search results out of cache after you have rebuilt the index.
#
# It does NOT make the dataset hot-reloadable: the arrays are mmap'd and
# SQLite is opened immutable, both at startup. **Restart this after any
# pipeline run**, or you are looking at the previous build.
echo "Concestor on http://localhost:${PORT}  (Ctrl-C to stop)" >&2
exec go run -C server . -addr ":${PORT}" -build ../build -immutable=false
