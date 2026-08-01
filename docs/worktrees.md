# Worktrees, and why the preview works inside one

Every parallel Claude Code session runs in its own git worktree under
`.claude/worktrees/`. A worktree is a checkout of **tracked files only**, so it
gets all the source and none of this:

| Missing in a worktree | Size | Why it is not tracked |
|---|---|---|
| `build/` | 2.9 GB | derived — six pipeline phases |
| `snapshot/` | 1.7 GB | pinned upstream sources |
| `web/node_modules` | 103 MB | installed |
| `pipeline/.venv` | 84 MB | installed |

Rebuilding those per session is hours of pipeline time and gigabytes of disk,
for artifacts byte-identical to the ones already on the machine. So the launch
scripts borrow instead, and `.worktreeinclude` copies nothing.

## What a worktree borrows, and what it owns

`scripts/lib/paths.sh` resolves the main checkout through
`git rev-parse --git-common-dir` and splits the tree in two:

- **Borrowed, read-only** — `build/` and `snapshot/phylopic`. Nobody edits
  these; they are pipeline output. Sharing is safe rather than merely
  convenient: the server mmaps the arrays and opens SQLite immutable, both at
  startup, so N processes reading one `build/` behaves exactly like one.
- **Owned by the worktree** — `web/dist` and `web/node_modules`. This is the
  code under development, and a session must never see another branch's
  frontend. `node_modules` is cloned from the main checkout with `cp -Rc`,
  which on APFS is a copy-on-write clone: no network, no wait, no disk until
  something diverges. Only when the lockfiles match; a worktree that changed
  dependencies gets a real `npm install`. A copy and not a symlink, so a later
  install cannot reach through and rewrite the main checkout's tree.

The server derives both the frontend path and the silhouette root from
`-build`'s parent directory. That is right in the main checkout and the wrong
repository once `build/` is borrowed, so `serve.sh` passes `-web` and
`-silhouettes` explicitly. Getting the second one wrong is quiet: the app
renders, and every silhouette is missing, which reads as a regression in the
renderer rather than an unset path.

## Ports

Nothing may hardcode a port, because the whole point is more than one of these
running at once. Both `launch.json` entries set `"autoPort": true`; Claude
picks a free port and passes it as `$PORT`, which `serve.sh`, `dev.sh` and
`vite.config.ts` all honour. Vite additionally sets `strictPort`, so it fails
rather than drifting to the next free port — a preview silently pointed at
another worktree's app is worse than one that will not start.

`dev.sh` starts its own API on a free port and tells Vite to proxy there. The
older arrangement, proxying to whatever was on :8080, breaks the moment a
second checkout exists.

## Getting a worktree running

Nothing to do — start the preview and the scripts handle it. First launch in a
new worktree costs a Go compile and a Vite build, roughly half a minute; after
that it is the same as the main checkout.

The one prerequisite is that **the main checkout has been built at least
once**. If no checkout on the machine has `build/topology` and
`build/concestor.db`, both scripts refuse to start and point at
`handoff.md` §2, which is the same failure the main checkout has always had.
