"""Repo-relative locations for the build's inputs and outputs.

`REPO_ROOT` is *this* checkout, resolved from this file. In a git worktree that
is the worktree, which is the whole reason `check_build_writable` below exists:
a worktree has no `build/` of its own, so one is arranged for it, and only one
of the two shapes that can take is safe to write to.
"""

from __future__ import annotations

import json
import os
import sys
from pathlib import Path
from typing import Any

REPO_ROOT = Path(__file__).resolve().parents[3]

SNAPSHOT = REPO_ROOT / "snapshot"
BUILD = REPO_ROOT / "build"
DATA = REPO_ROOT / "data"

SNAPSHOT_MANIFEST = SNAPSHOT / "manifest.json"

# Written by `concestor_borrow_build` in scripts/lib/paths.sh when it clones
# another checkout's artifacts into this one. Names where they came from and
# which build id they were, so a stale clone can say so rather than look
# current. Inside build/, which is gitignored, so it never reaches a commit.
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
        f"      rm build && cp -Rc {other}/build build\n\n"
        f"  Or run the pipeline from {other} itself, which is where the shared\n"
        f"  dataset is supposed to be rebuilt.\n\n"
        f"  To write through anyway — deliberately rebuilding the shared\n"
        f"  artifacts, with nothing running against them — set {ALLOW_SHARED}=1.\n",
        file=sys.stderr,
    )
    return False
