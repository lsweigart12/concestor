# Security

## Reporting a vulnerability

Report privately through GitHub's
[private vulnerability reporting](https://github.com/lsweigart12/concestor/security/advisories/new)
rather than by opening an issue. Expect an acknowledgement within a week. This
is a single-maintainer project, so there is no on-call rotation and no promised
patch window beyond a good-faith one.

## What the attack surface actually is

Worth stating plainly, because it is much smaller than the size of the
repository suggests.

**The runtime is read-only and stateless.** One Go process memory-maps the
pipeline's `.npy` arrays and opens a SQLite database with `immutable=1`. There
are no writes, no user accounts, no sessions, no uploads, and no request
handler that can change what the next reader sees. The dataset is baked into
the container image at build time.

**The pipeline is offline and is never a runtime dependency.** Every upstream
API — Open Tree, PBDB, GBIF, Wikidata, PhyloPic — is contacted only by
`concestor-build`, on a developer's machine, and never by the served binary.
Sources are pinned by SHA-256 in `snapshot/manifest.json`. A compromised
upstream cannot reach a reader without someone re-running a phase and shipping
a new image.

**Nothing reader-supplied is persisted.** The one exception is the analytics
beacon, which writes to Cloudflare Analytics Engine; `docs/analytics.md` is the
design and what it does and does not record.

That leaves roughly three places worth your attention:

- `/v1/silhouette/{file}` resolves a path against the mirrored PhyloPic
  corpus. Path traversal there is the sharpest edge in the API and is tested
  directly (`server/internal/api/api_test.go`).
- `/v1/search` builds an FTS5 `MATCH` expression from free text. Query shapes
  that turn into unbounded scans are a denial-of-service concern rather than an
  injection one, and `server/internal/store/search.go` bounds them.
- The Cloudflare Worker in `web/worker/index.ts`, which routes `/v1` to the
  container. The container has no public hostname and is reachable only through
  its binding.

## Out of scope

- **Accuracy of the science.** A wrong date, a misplaced fossil or a silhouette
  claiming too large a clade is a bug — open an issue. It is not a security
  report.
- **Missing hardening on the build pipeline's handling of upstream data.** It
  is a developer tool run deliberately against sources chosen by the person
  running it.
- **Anything requiring the attacker to already control the artifact set**, which
  is to say the container image, which is to say the deploy.
