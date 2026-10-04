"""Locations for the build's inputs and outputs.

`REPO_ROOT` is *this* checkout, resolved from this file, and in the main
checkout everything below is inside it. A git worktree's tree holds tracked
files only, so its two gitignored directories are elsewhere:

- `BUILD` is in the worktree's **state directory**, `<git-dir>/concestor`. It
  is this checkout's own, cloned from the main checkout's, and a phase writes
  to it — which is the reason `check_build_writable` below exists, because one
  of the two shapes that clone can take is not safe to write to.
- `SNAPSHOT` is the main checkout's. Nothing rewrites a file in it, so there
  is one copy and a phase that fetches more adds to that one. Only
  `SNAPSHOT_MANIFEST` is tracked, and it stays with the checkout.

scripts/lib/paths.sh makes the same decision for the shell and
server/internal/testenv for the Go tests. Change it in all three.
"""

from __future__ import annotations

import json
import os
import sys
from pathlib import Path
from typing import Any

REPO_ROOT = Path(__file__).resolve().parents[3]


def _worktree_dirs(root: Path) -> tuple[Path, Path] | None:
    """A linked worktree's git directory and its main checkout, else None.

    Read from `.git` rather than asked of git, so importing this module never
    spawns a process. In a linked worktree `.git` is a file naming the git
    directory, and `commondir` in there names the repository's own.
    """
    try:
        pointer = (root / ".git").read_text()
    except OSError:
        return None
    if not pointer.startswith("gitdir:"):
        return None
    git_dir = (root / pointer.removeprefix("gitdir:").strip()).resolve()
    try:
        common = (git_dir / (git_dir / "commondir").read_text().strip()).resolve()
    except OSError:
        return None
    return git_dir, common.parent


_WORKTREE = _worktree_dirs(REPO_ROOT)

#: Where this checkout keeps what it derives rather than tracks.
STATE = _WORKTREE[0] / "concestor" if _WORKTREE else REPO_ROOT

SNAPSHOT = (_WORKTREE[1] if _WORKTREE else REPO_ROOT) / "snapshot"
BUILD = STATE / "build"
DATA = REPO_ROOT / "data"

SNAPSHOT_MANIFEST = REPO_ROOT / "snapshot" / "manifest.json"

# Written by `concestor_borrow_build` in scripts/lib/paths.sh when it clones
# another checkout's artifacts for this one. Names where they came from and
# which build id they were, so a stale clone can say so rather than look
# current.
BORROW_STAMP = BUILD / ".borrowed"

#: Set to 1 to write through a borrowed build/ anyway. There is one honest use
#: — deliberately rebuilding the shared artifacts from a worktree, with nothing
#: else running against them.
ALLOW_SHARED = "CONCESTOR_ALLOW_SHARED_BUILD"


def ensure_dirs() -> None:
    for d in (SNAPSHOT, BUILD, DATA):
        d.mkdir(parents=True, exist_ok=True)


def borrow_stamp() -> dict[str, Any] | None:
    """What this checkout's build/ was cloned from, if it was cloned."""
    try:
        loaded: Any = json.loads(BORROW_STAMP.read_text())
    except OSError, ValueError:
        return None
    return loaded if isinstance(loaded, dict) else None


def _links_out() -> list[Path]:
    """The symlinks in build/ that make a write here land somewhere else.

    `build/` itself is the shape scripts/check.sh used to leave behind. The
    per-entry shape is the one `scripts/deploy/push-data-image.sh` defends
    against when it stages a context, so it is real and worth catching too —
    a run that only rewrites `topology/` would otherwise slip past a check on
    the parent alone.
    """
    if BUILD.is_symlink():
        return [BUILD]
    if not BUILD.is_dir():
        return []
    return sorted(p for p in BUILD.iterdir() if p.is_symlink())


def check_build_writable() -> bool:
    """Whether a phase may write to build/. Explains itself when it may not.

    Every phase writes its output in place — `np.save(TOPO_OUT / "age_ma.npy")`
    in phase 2, `g.write(BUILD / "phase4_gates.json")` in phase 4, no temp file
    and no rename — so a `build/` that is a symlink into another checkout makes
    a pipeline run in *this* one silently rewrite the artifacts *that* one is
    serving, under whatever processes have them mmap'd. Nothing inside a phase
    can see that; it is a property of the directory it was handed.

    A clone is fine and is the normal worktree arrangement: the output is this
    checkout's own, and stays here.
    """
    links = _links_out()
    if not links:
        stamp = borrow_stamp()
        if stamp is not None:
            print(
                f"build/ is a private clone of {stamp.get('from', 'another checkout')} "
                f"(dataset {stamp.get('build_id', 'unknown')}).\n"
                "What this phase writes stays in this checkout — the one it was "
                "cloned from will not see it.\n",
                file=sys.stderr,
            )
        return True

    if os.environ.get(ALLOW_SHARED) == "1":
        print(
            f"build/ reaches into another checkout and {ALLOW_SHARED}=1 — writing "
            "through to it.\nAnything serving those artifacts is reading what this "
            "run is rewriting.\n",
            file=sys.stderr,
        )
        return True

    where = links[0].resolve()
    # The *checkout* the link lands in, which is what the remediation below has
    # to name — one level above the resolved `build/` when build/ itself is the
    # link, two when a single entry inside it is.
    other = where.parent if links[0] == BUILD else where.parent.parent
    print(
        f"\n  Refusing to run: build/ is borrowed, not this checkout's.\n\n"
        f"    {links[0]}\n      -> {where}\n\n"
        f"  Every phase writes its arrays in place, so this run would rewrite\n"
        f"  the artifacts in {other},\n"
        f"  under any server that has them mmap'd and under every other\n"
        f"  worktree borrowing the same directory.\n\n"
        f"  To build here instead, give this checkout its own copy first. On APFS\n"
        f"  it is a copy-on-write clone, so 3.2 GB costs about 0.4 s and 2 MB:\n\n"
        f"      rm {BUILD} && cp -Rc {other}/build {BUILD}\n\n"
        f"  Or run the pipeline from {other} itself, which is where the shared\n"
        f"  dataset is supposed to be rebuilt.\n\n"
        f"  To write through anyway — deliberately rebuilding the shared\n"
        f"  artifacts, with nothing running against them — set {ALLOW_SHARED}=1.\n",
        file=sys.stderr,
    )
    return False
