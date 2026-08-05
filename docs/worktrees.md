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

  **Matching lockfiles decide whether cloning is appropriate. They cannot
  decide whether the result is usable**, and treating them as if they could is
  how this went wrong once already. Two checkouts on the same commit have
  identical lockfiles by construction, so the comparison passed while the tree
  being cloned was itself 52 packages behind its own lockfile — nobody had run
  `npm install` in the main checkout since #82 added `jsdom`. Every worktree
  faithfully inherited a `node_modules` with no `jsdom` in it and said nothing,
  and the failure surfaced a layer away as vitest's `Cannot find package
  'jsdom'`, which reads as a broken test harness rather than an unfinished
  checkout. So `concestor_ensure_node_modules` now asks `npm ls` whether the
  tree it ended up with satisfies the lockfile — after the copy, and equally
  after finding a `node_modules` already there, which is what makes a worktree
  sitting on an old bad clone repair itself. A shortfall is installed rather
  than carried, and the message names the checkout that was behind, because
  installing into this worktree fixes this worktree and the next one starts
  from the same stale source.

  `npm ls` rather than a walk of our own: 95 of this lockfile's entries are
  platform-specific optional dependencies that are *meant* to be absent, and a
  check that counts those as missing reinstalls on every run.

The server derives both the frontend path and the silhouette root from
`-build`'s parent directory, so once `build/` is borrowed they both follow it
to the main checkout. That is right for the silhouette mirror and wrong for the
frontend, which is the thing under development. Both scripts therefore pass
`-web` and `-silhouettes` explicitly: it fixes the frontend, and it makes the
mirror deliberate rather than a lucky consequence of where `build/` came from.
Getting the mirror wrong is quiet — the app renders and every silhouette is
missing, which reads as a regression in the renderer rather than an unset path.

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

## One thing that does not work, and is not ours to fix

The preview server runs in **the folder the session started in**, not the
folder the session is currently in. A session launched in a worktree — which is
every parallel session, and `claude --worktree <name>` — is therefore fine, and
that is the case this page is about.

But calling `EnterWorktree` *mid-session* moves the session's working directory
and leaves the preview behind: it goes on running the original checkout's
`scripts/serve.sh` against the original checkout's files, with no error, and
the preview browser shows that code rather than the worktree's. Measured, not
inferred — the launched process receives `$PORT` and nothing identifying the
session's directory, so no change to these scripts could detect it.

Start the session in the worktree if you need the preview to follow.
