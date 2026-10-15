"""The dataset's name: one build id for one artifact set.

`package` writes it into `build/manifest.json`, and
`scripts/deploy/push-data-image.sh` tags the data image with it. Only `package`
writes the manifest, so a phase rerun without it leaves the manifest naming the
set before — and a push would put different bytes under a tag a deploy is
pinned to. So the push script runs this file first, which recomputes the id
from the artifacts and refuses when the manifest names anything else.

Every byte is hashed: a prefix digest of the 1.8 GB database misses a rewrite
past the prefix, and the whole set takes about 3 s.

The push script runs this as a script under whatever `python3` the machine has,
without the pipeline's environment, which on macOS is 3.9. So it is the standard
library only, with no relative imports, and `test_build_id.py` parses it as 3.9.
"""

from __future__ import annotations

import hashlib
import json
import sys
from pathlib import Path
from typing import TypedDict


class Digest(TypedDict):
    bytes: int
    sha256: str


def _sha256(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as fh:
        while chunk := fh.read(1 << 20):
            h.update(chunk)
    return h.hexdigest()


def digests(build: Path) -> dict[str, Digest]:
    """Every artifact the id names, keyed by its path under `build`."""
    paths = sorted((build / "topology").glob("*.npy"))
    paths += [
        p for p in (build / "concestor.db", build / "timescale.json") if p.exists()
    ]
    return {
        p.relative_to(build).as_posix(): {
            "bytes": p.stat().st_size,
            "sha256": _sha256(p),
        }
        for p in paths
    }


def build_id(files: dict[str, Digest]) -> str:
    digest = hashlib.sha256()
    for name in sorted(files):
        digest.update(name.encode())
        digest.update(files[name]["sha256"].encode())
    return digest.hexdigest()[:16]


def main(argv: list[str]) -> int:
    """Print the build id `build/manifest.json` names, if the artifacts agree."""
    build = Path(argv[1])
    manifest = build / "manifest.json"
    if not manifest.exists():
        print(f"no {manifest}: run `concestor-build package`", file=sys.stderr)
        return 1
    named = json.loads(manifest.read_text())["build_id"]
    actual = build_id(digests(build))
    if named != actual:
        print(
            f"{manifest} names build {named}, but the artifacts beside it are "
            f"build {actual}: a phase ran after `concestor-build package`.",
            file=sys.stderr,
        )
        return 1
    print(named)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
