#!/usr/bin/env bash
#
# Read the beacon's dataset and print it with names in it.
#
# `docs/analytics.md` is the design; §8 is this script. Cloudflare ships no
# dashboard for Analytics Engine at all — a SQL API, a Grafana integration, and
# querying from a Worker — so without something like this the data is only
# reachable by hand-writing SQL and reading keys.
#
# Reading keys is the actual problem. A row says `ott461645` and a tree says
# `ott461645,ott478542`; the thing that turns those into *Apis mellifera* and
# *Octopoda* is `build/concestor.db`, which is 1.9 GB, local, and not something
# an external dashboard can join against. That join is why this exists rather
# than a Grafana board.
#
# This half resolves paths and hands over. It is bash for the same reason
# scripts/dev.sh is: scripts/lib/paths.sh already knows how a worktree borrows
# the main checkout's artifacts, and that logic should have one home.

set -euo pipefail

cd "$(dirname "$0")/.."
ROOT="$PWD"

# shellcheck source=lib/paths.sh
. "$ROOT/scripts/lib/paths.sh"

# --- the database -----------------------------------------------------------
# Resolved exactly the way the server's is, borrowing from the main checkout
# when this one is a worktree. Opened read-only at the far end.
#
# It refuses to run without one rather than falling back to printing keys,
# which is scripts/serve.sh's rule and holds for the same reason: a report
# whose every row reads `ott461645` is the thing this replaces, and shipping it
# under the same name would make a missing database look like an empty week.
concestor_resolve_artifacts || concestor_artifacts_missing

if [ -n "$CONCESTOR_BORROWED_FROM" ]; then
  echo "Borrowing the read-only database from $CONCESTOR_BORROWED_FROM" >&2
fi

# --- wrangler ---------------------------------------------------------------
# Only needed to answer two questions — which account, and what token — and
# only when the environment has not already answered them. A worktree has no
# node_modules, so the main checkout's copy is the usual hit; PATH last,
# because a globally installed wrangler may be a different major version than
# the one this repository pins.
CONCESTOR_WRANGLER=""
_main=$(concestor_main_checkout) || _main=""
for _candidate in \
  "$ROOT/web/node_modules/.bin/wrangler" \
  "${_main:+$_main/web/node_modules/.bin/wrangler}" \
  "$(command -v wrangler || true)"; do
  if [ -n "$_candidate" ] && [ -x "$_candidate" ]; then
    CONCESTOR_WRANGLER="$_candidate"
    break
  fi
done
export CONCESTOR_WRANGLER

# --- where the page goes ----------------------------------------------------
# Beside the database it was resolved from, which is `build/analytics/` in the
# main checkout and stays gitignored either way.
#
# **Not `$ROOT/build` in a worktree**, and this is the one trap here worth a
# comment. `scripts/check.sh` links build/ into a worktree only when there is
# no build/ there — `[ ! -e "$ROOT/build" ]` — and it exports
# CONCESTOR_REQUIRE_BUILD=1 regardless, which turns a skipped dataset test into
# a failure. So a worktree-local build/ holding nothing but a report would
# leave the link unmade and 82 Go tests failing for want of a database that is
# two directories away. Writing a report should not be able to do that.
#
# CONCESTOR_REPORT_DIR overrides, for a checkout whose build/ is somewhere it
# should not be written to.
OUT_DIR="${CONCESTOR_REPORT_DIR:-$CONCESTOR_BUILD/analytics}"
mkdir -p "$OUT_DIR"

# `python3` and nothing else, exactly like scripts/ci/go-test-summary.py: this
# is an ops script, it is outside the pipeline's ruff/ty scope on purpose, and
# it has to run in a checkout where `uv sync` has never happened.
exec python3 "$ROOT/scripts/analytics-report.py" \
  --db "$CONCESTOR_BUILD/concestor.db" \
  --out-dir "$OUT_DIR" \
  "$@"
