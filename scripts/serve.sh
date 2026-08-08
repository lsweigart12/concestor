#!/usr/bin/env bash
#
# Start Concestor for local preview: one Go process serving both the read API
# on /v1 and the built frontend on /.
#
# This is `.claude/launch.json`'s `concestor-built` entry, the second of the
# two. It is deliberately a single process rather than the Vite dev server plus
# an API — it exists to show the thing that ships, and the server already
# serves `web/dist` with SPA fallback. `scripts/dev.sh` is the entry that leads
# and the one to use while writing code; it starts its own API, proxies /v1 to
# it, and serves the frontend from source.
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
#
# In a worktree the artifacts are cloned in first, copy-on-write, so this
# checkout has its own. That costs 0.38 s and 2.2 MB the first time and nothing
# after — and it is also where the dataset gets to say it is behind the
# checkout it came from, which is the one staleness question this script could
# not previously answer. The frontend bundle's freshness is checked below; this
# is the same courtesy for the data underneath it.
concestor_borrow_build
concestor_link_snapshot
concestor_resolve_artifacts || concestor_artifacts_missing

if [ -n "${CONCESTOR_BORROW_NOTE:-}" ]; then
  echo "$CONCESTOR_BORROW_NOTE" >&2
elif [ -n "$CONCESTOR_BORROWED_FROM" ]; then
  echo "Borrowing read-only artifacts from $CONCESTOR_BORROWED_FROM" >&2
fi

# --- the frontend -----------------------------------------------------------
# Built, not dev-served, and rebuilt whenever an input is newer than the
# bundle. This is the `concestor-built` entry in `.claude/launch.json`, the one
# reached for specifically to see what ships: before merging, and for anything
# touching asset loading or the analytics beacon, neither of which exists under
# `scripts/dev.sh`. That is exactly when being handed an old bundle costs the
# most, and it has already cost one bug report filed against source that was
# fixed and merely not rebuilt.
#
# This used to rebuild only when dist was *missing*, on the reasoning that a
# preview which silently recompiles on every launch hides the fact that dist is
# stale. The goal was right and nothing implemented it: the script neither
# recompiled nor said a word, so it produced the outcome it set out to avoid.
# Freshness is now checked rather than assumed, and the argument the artifacts
# section above already makes applies here verbatim — a stale bundle looks
# identical to a current one, and the difference costs whoever hits it an hour.
#
# Rebuilding rather than warning, because the build is under a second (0.4–0.6 s
# measured cold, TypeScript 7 being the native compiler) and a warning printed
# above a server's own startup chatter is a warning nobody reads.
#
# The inputs are enumerated rather than taken as `web/`, because node_modules,
# dist and tsconfig.tsbuildinfo all live there and are outputs or dependencies
# rather than sources. `web/worker` is deliberately absent: it is the Cloudflare
# Worker, deployed separately, and never part of the bundle this process serves.
web_inputs=(index.html package.json package-lock.json vite.config.ts
  tsconfig.json src public)

rebuild=""
if [ ! -f "$ROOT/web/dist/index.html" ]; then
  rebuild="web/dist is missing"
else
  newer=$(cd "$ROOT/web" && find "${web_inputs[@]}" -newer dist/index.html -print -quit) || newer=""
  [ -n "$newer" ] && rebuild="web/$newer is newer than the bundle"
fi

if [ -n "$rebuild" ]; then
  echo "Building the frontend — $rebuild…" >&2
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
# `-public-cache=false` drops the production `Cache-Control` lifetimes from /v1
# responses. They are correct in production — the data genuinely cannot change
# within a build — and actively hostile locally, where an hour of freshness
# makes the browser serve last hour's search results out of cache after you
# have rebuilt the index.
#
# It does NOT make the dataset hot-reloadable: the arrays are mmap'd and
# SQLite is opened immutable, both at startup. **Restart this after any
# pipeline run**, or you are looking at the previous build.
args=(-addr ":${PORT}" -build "$CONCESTOR_BUILD" -web "$ROOT/web/dist" -public-cache=false)
[ -n "$CONCESTOR_SILHOUETTES" ] && args+=(-silhouettes "$CONCESTOR_SILHOUETTES")

echo "Concestor on http://localhost:${PORT}  (Ctrl-C to stop)" >&2
exec go run -C server . "${args[@]}"
