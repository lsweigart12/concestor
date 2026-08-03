#!/usr/bin/env bash
#
# Build and push the read API's container image: the Go binary plus the whole
# baked artifact set, ~2.2 GB, tagged with the build id it contains.
#
# This runs on a machine that has build/, and nowhere else. CI does not have
# the dataset and must never produce it — docs/ci.md §5 — so the image cannot
# be built there, which is why web/wrangler.jsonc references it by registry
# tag rather than by Dockerfile path. docs/deployment.md §5 is the whole
# argument, including the bootstrap order the first time.
#
# It prints the tag. Commit that tag into web/wrangler.jsonc: pinning it is
# what makes rolling the Worker back roll the dataset back with it.
#
# Usage:
#   CLOUDFLARE_ACCOUNT_ID=… scripts/deploy/push-api-image.sh [--no-push]
#
# Runs unchanged inside a git worktree, borrowing build/ and snapshot/ from
# the main checkout the same way scripts/serve.sh does.

set -euo pipefail

cd "$(dirname "$0")/../.."
ROOT="$PWD"

# shellcheck source=../lib/paths.sh
. "$ROOT/scripts/lib/paths.sh"

PUSH=1
[ "${1:-}" = "--no-push" ] && PUSH=0

# --- what has to be here before anything is built ---------------------------
concestor_resolve_artifacts || concestor_artifacts_missing

if [ -z "${CONCESTOR_SILHOUETTES:-}" ]; then
  printf '\n  %s\n\n' "No snapshot/phylopic in this checkout or the main one.
  The image would build and every silhouette would 404 — the server resolves
  silhouette.svg_path against that mirror at request time. 156 MB, phase 0." >&2
  exit 1
fi

if [ "$PUSH" = 1 ] && [ -z "${CLOUDFLARE_ACCOUNT_ID:-}" ]; then
  echo "CLOUDFLARE_ACCOUNT_ID is unset. It is the registry path, not a secret." >&2
  echo "Pass --no-push to build the image without pushing it." >&2
  exit 1
fi

for tool in docker go python3; do
  command -v "$tool" >/dev/null || { echo "$tool is required but not on PATH" >&2; exit 1; }
done

# The tag is the manifest's build id — `concestor-build package`'s, hashed
# from artifact *content*.
#
# It is deliberately not the id /v1/about reports. `store.computeBuildID`
# hashes file sizes and *mtimes*, so it changes when a file is copied and
# would give a different answer inside the image than outside it. That id is
# exactly right for what it does — keying an ETag on something that changes
# whenever the bytes on this disk do — and exactly wrong as a name for an
# artifact set. docs/deployment.md §5 records both.
BUILD_ID=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["build_id"])' \
  "$CONCESTOR_BUILD/manifest.json")
# The fallback is lowercase and that is not a style choice: Docker refuses a
# repository name containing an uppercase letter, so an `ACCOUNT_ID` stand-in
# fails the build itself with `repository name must be lowercase` — which is
# only ever hit under --no-push, the one path that has no account id and the
# one path whose whole job is to prove the image builds. A real Cloudflare
# account id is 32 lowercase hex characters and was never at risk.
#
# web/wrangler.jsonc's placeholder stays uppercase ACCOUNT_ID deliberately.
# It is a config string that deploy-web.yml greps for and substitutes, never a
# tag handed to Docker, and making it shout is what stops it being mistaken
# for a real account id in review.
TAG="registry.cloudflare.com/${CLOUDFLARE_ACCOUNT_ID:-account_id}/concestor-api:${BUILD_ID}"

echo "build    $CONCESTOR_BUILD${CONCESTOR_BORROWED_FROM:+  (borrowed from $CONCESTOR_BORROWED_FROM)}"
echo "phylopic $CONCESTOR_SILHOUETTES"
echo "tag      $TAG"

# --- staging ----------------------------------------------------------------
# A staging directory rather than building from the repository root: the
# context is 2.2 GB that lives outside the repository, and `docker build .`
# here would send the entire checkout — snapshot/ and all — to the daemon.
#
# Symlinks would be cheaper and do not work; Docker will not follow a symlink
# out of the build context. On APFS `cp -c` clones copy-on-write, so the
# 1.9 GB database costs neither time nor disk; elsewhere this is a real copy.
CTX=$(mktemp -d "${TMPDIR:-/tmp}/concestor-image.XXXXXX")
trap 'rm -rf "$CTX"' EXIT
mkdir -p "$CTX/build/gates" "$CTX/snapshot"

#
# Every source is resolved to its real path first, and that is not a
# nicety. Inside a worktree, build/ is a directory of *symlinks* into the main
# checkout — `cp -R` copies a symlink as a symlink, so without this the
# staged context is a tree of dangling links, the image builds, and the whole
# dataset is missing. The guard below is what turns that into an error here
# rather than a 500 on the first request.
real() { python3 -c 'import os,sys; print(os.path.realpath(sys.argv[1]))' "$1"; }
clone() { cp -Rc "$(real "$1")" "$2" 2>/dev/null || cp -R "$(real "$1")" "$2"; }
clone "$CONCESTOR_BUILD/concestor.db" "$CTX/build/concestor.db"
clone "$CONCESTOR_BUILD/topology" "$CTX/build/topology"
clone "$CONCESTOR_BUILD/manifest.json" "$CTX/build/manifest.json"
clone "$CONCESTOR_BUILD/timescale.json" "$CTX/build/timescale.json"
clone "$CONCESTOR_SILHOUETTES" "$CTX/snapshot/phylopic"

# snapshot/manifest.json is the only part of snapshot/ that is in git, and it
# is not optional: the server reads `synth_id` out of it, folds that into the
# build id, and serves the whole thing as /v1/about's `sources`.
SNAPSHOT_MANIFEST="$(dirname "$(real "$CONCESTOR_SILHOUETTES")")/manifest.json"
if [ ! -f "$SNAPSHOT_MANIFEST" ]; then
  echo "no snapshot/manifest.json beside the phylopic mirror at $SNAPSHOT_MANIFEST" >&2
  exit 1
fi
clone "$SNAPSHOT_MANIFEST" "$CTX/snapshot/manifest.json"

# The gate files are staged in their own directory only so the Dockerfile can
# COPY them without a wildcard; they land flat in /srv/build. They are read for
# real — store.go globs phase*_gates*.json — and they are part of what the
# build id hashes, so an image without them serves a different build id than
# the same artifacts do locally.
for g in "$CONCESTOR_BUILD"/phase*_gates*.json; do
  [ -e "$g" ] || continue
  clone "$g" "$CTX/build/gates/$(basename "$g")"
done

if find "$CTX" -type l -print -quit | grep -q .; then
  echo "staged context still contains symlinks; Docker will not follow them" >&2
  find "$CTX" -type l | head -5 >&2
  exit 1
fi

# Cross-compiled here rather than in the image, so the image needs no
# toolchain and no build stage. Static for the same reason release.yml's
# binaries are: the SQLite driver is modernc.org/sqlite, not a cgo wrapper,
# so CGO_ENABLED=0 costs nothing.
echo "compiling server for linux/amd64…"
(cd "$ROOT/server" && CGO_ENABLED=0 GOOS=linux GOARCH=amd64 \
  go build -trimpath -ldflags "-s -w" -o "$CTX/concestor-server" .)

cp "$ROOT/server/Dockerfile" "$CTX/Dockerfile"

# Apparent size, not `du`. On APFS the clones above share blocks, so `du`
# reports about ten megabytes for a context Docker is going to read 2.2 GB out
# of — a number that reads as "something did not get copied".
CTX_MB=$(python3 -c 'import os,sys; print(round(sum(os.path.getsize(os.path.join(d,f)) for d,_,fs in os.walk(sys.argv[1]) for f in fs)/1e6))' "$CTX")
echo "context  ${CTX_MB} MB"

# --- build and push ---------------------------------------------------------
# --platform is not optional: Cloudflare Containers requires linux/amd64 and
# the machine holding build/ is very likely an arm64 Mac, where Docker would
# otherwise produce an arm64 image that fails at deploy rather than here.
docker build --platform linux/amd64 -t "$TAG" "$CTX"

if [ "$PUSH" = 0 ]; then
  echo
  echo "Built $TAG — not pushed (--no-push)."
  exit 0
fi

npx --prefix "$ROOT/web" wrangler containers push "$TAG"

cat <<EOF

Pushed. Now pin it, or nothing points at it:

  web/wrangler.jsonc  ->  "image": "registry.cloudflare.com/ACCOUNT_ID/concestor-api:${BUILD_ID}"

The tag is committed and the account id is substituted at deploy time. Rolling
the Worker back to a previous version rolls the dataset back with it, which is
the whole reason this is not :latest.
EOF
