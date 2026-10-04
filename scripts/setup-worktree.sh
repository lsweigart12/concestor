#!/usr/bin/env bash
#
# Prepare a fresh git worktree: a build/ of its own in its state directory,
# and web/node_modules. T3 Code runs this once when it creates a worktree for
# a thread — see t3.json.
#
# scripts/dev.sh, serve.sh and check.sh make the same two calls on first use,
# so nothing depends on this having run. It makes the clone before the first
# command rather than during it.

set -euo pipefail

cd "$(dirname "$0")/.."
ROOT="$PWD"

# shellcheck source=lib/paths.sh
. "$ROOT/scripts/lib/paths.sh"

concestor_borrow_build
concestor_ensure_node_modules
