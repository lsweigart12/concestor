#!/usr/bin/env bash
#
# Start Concestor with hot reload: the Vite dev server on $PORT, backed by its
# own read API on a private port that Vite proxies /v1 to.
#
# The API is started here rather than assumed to be running elsewhere. The
# old arrangement — `npm run dev` proxying to whatever sat on 8080 — breaks
# the moment there is more than one checkout, because each git worktree gets
# its own port and 8080 may be another worktree's server, another branch's
# frontend, or nothing at all. A dev server that silently proxies to the
# wrong process is worse than one that will not start.
#
# Use scripts/serve.sh instead when you want to see what actually ships: this
# one serves Vite's transformed modules, not web/dist.

set -euo pipefail

cd "$(dirname "$0")/.."
ROOT="$PWD"
PORT="${PORT:-5173}"

# shellcheck source=lib/paths.sh
. "$ROOT/scripts/lib/paths.sh"

concestor_resolve_artifacts || concestor_artifacts_missing

if [ -n "$CONCESTOR_BORROWED_FROM" ]; then
  echo "Borrowing read-only artifacts from $CONCESTOR_BORROWED_FROM" >&2
fi

concestor_ensure_node_modules

API_PORT="$(concestor_free_port 8090)"

# Built rather than `go run`, so there is one process to signal. `go run`
# leaves the compiled binary running as a grandchild that outlives a kill on
# the parent, and a stale API holding the port is exactly the confusion this
# script exists to avoid. The output path is already gitignored.
echo "Building the read API…" >&2
go build -C server -o concestor-serve .

# `-web` is passed even though Vite is the frontend in this mode, because the
# server otherwise infers it from `-build`'s parent — the main checkout, once
# build/ is borrowed. Anyone hitting the API port directly would then get
# another checkout's app.
api_args=(-addr "127.0.0.1:${API_PORT}" -build "$CONCESTOR_BUILD"
  -web "$ROOT/web/dist" -public-cache=false)
[ -n "$CONCESTOR_SILHOUETTES" ] && api_args+=(-silhouettes "$CONCESTOR_SILHOUETTES")

"$ROOT/server/concestor-serve" "${api_args[@]}" &
API_PID=$!

cleanup() {
  kill "$API_PID" 2>/dev/null || true
  wait "$API_PID" 2>/dev/null || true
}
trap cleanup EXIT INT TERM

# Wait for the API before handing over to Vite, so the first page load does
# not race the dataset opening: 2.9 GB of arrays mmap in well under a second,
# but the SQLite open is not free.
for _ in $(seq 1 100); do
  if (exec 3<>"/dev/tcp/127.0.0.1/${API_PORT}") 2>/dev/null; then
    exec 3>&- 2>/dev/null || true
    break
  fi
  if ! kill -0 "$API_PID" 2>/dev/null; then
    echo "The read API exited during startup — see its output above." >&2
    exit 1
  fi
  sleep 0.1
done

echo "Concestor (hot reload) on http://localhost:${PORT}, API on ${API_PORT}" >&2
PORT="$PORT" CONCESTOR_API="http://127.0.0.1:${API_PORT}" npm --prefix web run dev
