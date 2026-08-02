#!/usr/bin/env bash
#
# Build the release artifacts for one version. Called by semantic-release's
# `prepare` step, which is the first moment the version exists — it is derived
# from the commits since the last tag, so nothing before this point can know
# it. That is also why the version is compiled in here rather than read from a
# file: there is no file.
#
#   scripts/ci/build-release.sh 0.2.0
#
# Produces release-artifacts/, which is gitignored and never committed. The
# dataset is not in here and never will be: 2,004 MB of baked artifacts move
# on the pipeline's cadence, not the code's, and a running instance reports
# which one it has on /v1/about as `build_id`.

set -euo pipefail

cd "$(dirname "$0")/../.."
ROOT="$PWD"

VERSION="${1:?usage: build-release.sh <version>}"
OUT="$ROOT/release-artifacts"

rm -rf "$OUT"
mkdir -p "$OUT"

# The commit is worth carrying separately from the tag. A tag can be moved;
# `git describe` in a support conversation cannot be argued with.
COMMIT=$(git rev-parse --short HEAD)

# --- server -----------------------------------------------------------------
# Linux only, and only the two architectures anything deploys on. Adding
# darwin builds would be four more artifacts nobody downloads — `go run` is
# the local story, and scripts/serve.sh is what a developer actually uses.
#
# CGO_ENABLED=0 for a static binary. The SQLite driver is modernc.org/sqlite,
# which is transpiled Go rather than a cgo wrapper, so this costs nothing —
# see docs/serving-binary.md.
for platform in "linux/amd64" "linux/arm64"; do
  goos="${platform%%/*}"
  goarch="${platform##*/}"
  echo "building server for $goos/$goarch…" >&2

  staging="$OUT/stage-$goos-$goarch"
  mkdir -p "$staging"

  CGO_ENABLED=0 GOOS="$goos" GOARCH="$goarch" go build -C server \
    -trimpath \
    -ldflags "-s -w -X main.version=$VERSION -X main.commit=$COMMIT" \
    -o "$staging/concestor-serve" .

  cp "$ROOT/LICENSE" "$ROOT/NOTICE" "$staging/"
  tar -czf "$OUT/concestor-serve_${VERSION}_${goos}_${goarch}.tar.gz" \
    -C "$staging" concestor-serve LICENSE NOTICE
  rm -rf "$staging"
done

# --- frontend ---------------------------------------------------------------
# Built here rather than reused from CI's artifact so that the version is in
# it. `tsc -b` runs as part of `npm run build`, so a type error still stops
# the release.
echo "building frontend…" >&2
(
  cd "$ROOT/web"
  npm ci --no-audit --no-fund
  VITE_APP_VERSION="$VERSION" npm run build
)
tar -czf "$OUT/concestor-web_${VERSION}.tar.gz" -C "$ROOT/web" dist

# --- checksums --------------------------------------------------------------
# Computed over the finished tarballs, in the directory that holds them, so
# the file has bare names and `shasum -c SHA256SUMS` works after a download.
(
  cd "$OUT"
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum ./*.tar.gz >SHA256SUMS
  else
    shasum -a 256 ./*.tar.gz >SHA256SUMS
  fi
)

echo >&2
echo "release-artifacts for $VERSION ($COMMIT):" >&2
ls -lh "$OUT" >&2
