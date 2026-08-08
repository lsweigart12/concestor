#!/usr/bin/env bash
#
# Build and push the **data base image**: the whole baked artifact set, ~2.2 GB,
# tagged with the build id it contains. No binary, no entrypoint — it cannot be
# run, and that is deliberate.
#
# This runs on a machine that has build/, and nowhere else. CI does not have
# the dataset and must never produce it — docs/ci.md §5 — which is why
# web/wrangler.jsonc references an image by registry tag rather than by
# Dockerfile path.
#
# **The binary is not here any more.** It used to be: this script cross-compiled
# the server, baked it into the same image, and the tag carried both halves.
# That welded a 10 MB artifact to a 2.2 GB one on the wrong cadence — server
# code changed, a release shipped, and production went on running the old binary
# until somebody remembered to rebuild 2.2 GB locally. It happened, for two
# releases. The binary is now added in CI from the tag being deployed
# (.github/workflows/deploy-web.yml, `Assemble the API image`), so it cannot
# drift from the release by construction. docs/deployment.md §5.
#
# Two hazards died with it, and both were real: a `-dirty` tag naming no
# commit, and a tag whose dataset id was a lie after a single-phase rerun
# without `package`. Both lived in the local binary build. The second is now an
# observation in scripts/check.sh instead.
#
# It prints the tag. Commit that tag into web/wrangler.jsonc: pinning it is
# what makes rolling the Worker back roll the dataset back with it.
#
# Usage:
#   CLOUDFLARE_ACCOUNT_ID=… scripts/deploy/push-data-image.sh [--no-push]
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

for tool in docker python3; do
  command -v "$tool" >/dev/null || { echo "$tool is required but not on PATH" >&2; exit 1; }
done

# The tag names the dataset, and now names *only* the dataset — the manifest's
# build id from `concestor-build package`, hashed from artifact *content*.
#
# It is deliberately not the id /v1/about reports. `store.computeBuildID`
# hashes file sizes and *mtimes*, so it changes when a file is copied and
# would give a different answer inside the image than outside it. That id is
# exactly right for what it does — keying an ETag on something that changes
# whenever the bytes on this disk do — and exactly wrong as a name for an
# artifact set. docs/deployment.md §5 records both.
#
# There is no code half. An image with no binary in it has no code identity to
# carry, and the API tag CI mints (`<build_id>-<release>`) is where the other
# half now lives.
BUILD_ID=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["build_id"])' \
  "$CONCESTOR_BUILD/manifest.json")

# The fallback is lowercase and that is not a style choice: Docker refuses a
# repository name containing an uppercase letter, so an `ACCOUNT_ID` stand-in
# fails the build itself with `repository name must be lowercase` — which is
# only ever hit under --no-push, the one path that has no account id and the
# one path whose whole job is to prove the image builds.
#
# web/wrangler.jsonc's placeholders stay uppercase ACCOUNT_ID and RELEASE
# deliberately. They are config strings that deploy-web.yml greps for and
# substitutes, never tags handed to Docker, and making them shout is what stops
# them being mistaken for a real account id or a real version in review.
TAG="registry.cloudflare.com/${CLOUDFLARE_ACCOUNT_ID:-account_id}/concestor-data:${BUILD_ID}"

echo "build    $CONCESTOR_BUILD${CONCESTOR_BORROWED_FROM:+  (borrowed from $CONCESTOR_BORROWED_FROM)}"
echo "phylopic $CONCESTOR_SILHOUETTES"
echo "dataset  $BUILD_ID"
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

cp "$ROOT/server/Dockerfile.data" "$CTX/Dockerfile"

# Apparent size, not `du`. On APFS the clones above share blocks, so `du`
# reports about ten megabytes for a context Docker is going to read 2.2 GB out
# of — a number that reads as "something did not get copied".
CTX_MB=$(python3 -c 'import os,sys; print(round(sum(os.path.getsize(os.path.join(d,f)) for d,_,fs in os.walk(sys.argv[1]) for f in fs)/1e6))' "$CTX")
echo "context  ${CTX_MB} MB"

# --- build and push ---------------------------------------------------------
# --platform is not optional: Cloudflare Containers requires linux/amd64 and
# the machine holding build/ is very likely an arm64 Mac, where Docker would
# otherwise produce an arm64 image that fails at deploy rather than here.
#
# --provenance=false is not optional either, and it is the one flag here that
# is about CI rather than about this machine. BuildKit's default attaches an
# attestation, which makes the pushed artifact an *index* of two manifests
# rather than one image — and `crane mutate`, which is how the release
# assembles the API image on top of this one, refuses an index. Without this
# flag every release fails at the assembly step with a media-type error that
# says nothing about where it came from.
docker build --platform linux/amd64 --provenance=false -t "$TAG" "$CTX"

if [ "$PUSH" = 0 ]; then
  echo
  echo "Built $TAG — not pushed (--no-push)."
  exit 0
fi

npx --prefix "$ROOT/web" wrangler containers push "$TAG"

cat <<EOF

Pushed. Now pin it, or nothing points at it:

  web/wrangler.jsonc  ->  "image": "registry.cloudflare.com/ACCOUNT_ID/concestor-api:${BUILD_ID}-RELEASE"

Note the repository: the pin names **concestor-api**, not concestor-data. The
API image at that tag does not exist yet and does not need to — the release's
deploy assembles it from this base and the binary compiled from the tag it is
shipping, and skips the work when it is already there. Both placeholders are
substituted at deploy time: ACCOUNT_ID from the secret, RELEASE from the tag
being deployed.

Rolling the Worker back to a previous version rolls the dataset back with it,
which is the whole reason this is not :latest — and the code half rolls back
too, because the tag it names is a release and that release's source is what
built its binary.
EOF
