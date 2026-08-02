# The read API and its dataset, in one image.
#
# Built by scripts/deploy/push-api-image.sh, which assembles the build context
# — this file expects a staging directory, not the repository root. That is
# deliberate: the context is 2.2 GB of pipeline output that lives outside the
# repository, and `docker build .` at the root would try to send the whole
# checkout, snapshot/ included, to the daemon.
#
# Not referenced from web/wrangler.jsonc. Wrangler pushes an already-built
# image by tag there, because a Dockerfile in that config makes
# `wrangler deploy --dry-run` require Docker even in CI, where the dataset
# does not and must not exist. docs/deployment.md §5 has the reasoning.
#
# linux/amd64 is required by Cloudflare Containers, and the machine holding
# build/ is very likely an arm64 Mac. The binary is cross-compiled by the push
# script rather than built here, so this image needs no toolchain at all.
FROM gcr.io/distroless/static-debian12:nonroot

# Everything the server opens at startup, in the layout it expects. `-build`
# points at /srv/build and the server derives *both* the silhouette mirror and
# snapshot/manifest.json from that directory's parent, so /srv/snapshot has to
# sit beside /srv/build — the same relationship scripts/lib/paths.sh resolves
# locally. Get that wrong and there is no error: 12,863 silhouettes 404 and
# /v1/about reports no sources.
#
# The small JSON is not decoration. `store.computeBuildID` hashes the name,
# size and mtime of the arrays, the database, timescale.json and
# `phase*_gates*.json`, and folds in the snapshot's `synth_id` — and that id is
# what every ETag and `Cache-Control: immutable` on /v1 keys on. Leaving those
# files out does not fail; it quietly changes the identity of the build.
#
# Ordered coldest-first so a rebuild that only changes the binary reuses the
# 2 GB of layers underneath it.
COPY --chown=nonroot:nonroot snapshot/phylopic /srv/snapshot/phylopic
COPY --chown=nonroot:nonroot build/concestor.db /srv/build/concestor.db
COPY --chown=nonroot:nonroot build/topology /srv/build/topology
COPY --chown=nonroot:nonroot snapshot/manifest.json /srv/snapshot/manifest.json
COPY --chown=nonroot:nonroot build/manifest.json /srv/build/manifest.json
COPY --chown=nonroot:nonroot build/timescale.json /srv/build/timescale.json
COPY --chown=nonroot:nonroot build/gates/ /srv/build/
COPY --chown=nonroot:nonroot concestor-server /usr/local/bin/concestor-server

USER nonroot
EXPOSE 8080

# 8080 is worker/index.ts's `defaultPort`. Nothing may hardcode a port
# elsewhere in this project; here the image and the Worker have to agree on
# one, and this is the pair.
#
# No frontend is copied, so the server's default `<build>/../web/dist` does
# not exist and it serves the API alone — which is what we want, because the
# bundle is served by Workers static assets. Two sources of one bundle is two
# bundles that can differ.
ENTRYPOINT ["/usr/local/bin/concestor-server"]
CMD ["-addr", ":8080", "-build", "/srv/build"]
