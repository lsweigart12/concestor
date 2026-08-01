"""Fetching with provenance.

Every byte that enters `snapshot/` is recorded in `snapshot/manifest.json` with
its URL, declared `Content-Length`, SHA-256, and fetch timestamp. The manifest
is git-tracked even though the payloads are not, so the repo always states
exactly what a build was made from.

Downloads resume via HTTP Range and are verified against a recorded digest on
re-run, so an interrupted 500 MB fetch costs only the missing tail.
"""

from __future__ import annotations

import hashlib
import json
import os
import time
from dataclasses import dataclass, asdict
from datetime import datetime, timezone
from pathlib import Path
from typing import Iterator

import httpx

from .paths import SNAPSHOT, SNAPSHOT_MANIFEST

USER_AGENT = (
    "concestor-build/0.1 (+https://github.com/lsweigart12/concestor) "
    "one-off research snapshot; contact lsweigart12@gmail.com"
)

CHUNK = 1 << 20


@dataclass(slots=True)
class Artifact:
    name: str
    url: str
    path: str
    bytes: int
    sha256: str
    fetched_at: str
    content_length: int | None = None
    note: str = ""


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def _human(n: float) -> str:
    for unit in ("B", "KiB", "MiB", "GiB"):
        if n < 1024 or unit == "GiB":
            return f"{n:,.1f} {unit}"
        n /= 1024
    return f"{n} B"


def sha256_file(path: Path) -> tuple[str, int]:
    h = hashlib.sha256()
    total = 0
    with path.open("rb") as fh:
        while chunk := fh.read(CHUNK):
            h.update(chunk)
            total += len(chunk)
    return h.hexdigest(), total


class Manifest:
    """Accumulates artifact provenance; merges with any prior manifest."""

    def __init__(self, path: Path = SNAPSHOT_MANIFEST) -> None:
        self.path = path
        self.artifacts: dict[str, Artifact] = {}
        self.meta: dict = {}
        if path.exists():
            raw = json.loads(path.read_text())
            self.meta = raw.get("meta", {})
            for a in raw.get("artifacts", []):
                self.artifacts[a["name"]] = Artifact(**a)

    def record(self, art: Artifact) -> None:
        self.artifacts[art.name] = art

    def get(self, name: str) -> Artifact | None:
        return self.artifacts.get(name)

    def write(self) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        payload = {
            "meta": self.meta | {"written_at": _now()},
            "artifacts": [
                asdict(self.artifacts[k]) for k in sorted(self.artifacts)
            ],
        }
        self.path.write_text(json.dumps(payload, indent=2) + "\n")


def fetch(
    client: httpx.Client,
    manifest: Manifest,
    *,
    name: str,
    url: str,
    dest: Path,
    expect_bytes: int | None = None,
    note: str = "",
    force: bool = False,
) -> Artifact:
    """Download `url` to `dest`, resuming if partial, and record provenance.

    A file already present with a matching recorded digest is left alone.
    """
    dest.parent.mkdir(parents=True, exist_ok=True)
    prior = manifest.get(name)

    if dest.exists() and prior and not force:
        digest, size = sha256_file(dest)
        if digest == prior.sha256 and size == prior.bytes:
            print(f"  ok (cached)  {name}  {_human(size)}", flush=True)
            return prior
        print(f"  re-fetching  {name}  (digest changed on disk)", flush=True)

    part = dest.with_suffix(dest.suffix + ".part")
    start = part.stat().st_size if part.exists() and not force else 0
    if force and part.exists():
        part.unlink()
        start = 0

    headers = {"User-Agent": USER_AGENT}
    if start:
        headers["Range"] = f"bytes={start}-"

    t0 = time.monotonic()
    with client.stream("GET", url, headers=headers, follow_redirects=True) as r:
        if start and r.status_code == 200:
            # Server ignored the Range header; restart cleanly.
            start = 0
            part.unlink(missing_ok=True)
        elif start and r.status_code != 206:
            r.raise_for_status()
        r.raise_for_status()

        declared = r.headers.get("content-length")
        content_length = (int(declared) + start) if declared else None
        mode = "ab" if start else "wb"
        seen = start
        with part.open(mode) as fh:
            for chunk in r.iter_bytes(CHUNK):
                fh.write(chunk)
                seen += len(chunk)
                if content_length:
                    pct = 100 * seen / content_length
                    print(
                        f"\r  {name}: {_human(seen)} / "
                        f"{_human(content_length)} ({pct:5.1f}%)",
                        end="",
                        flush=True,
                    )
                else:
                    print(f"\r  {name}: {_human(seen)}", end="", flush=True)
    print(flush=True)

    digest, size = sha256_file(part)
    os.replace(part, dest)
    elapsed = time.monotonic() - t0

    art = Artifact(
        name=name,
        url=url,
        path=str(dest.relative_to(SNAPSHOT.parent)),
        bytes=size,
        sha256=digest,
        fetched_at=_now(),
        content_length=content_length,
        note=note,
    )
    manifest.record(art)
    print(
        f"  got {name}: {_human(size)} in {elapsed:,.1f}s  sha256={digest[:16]}…",
        flush=True,
    )
    if expect_bytes is not None and size != expect_bytes:
        print(
            f"  !! size mismatch for {name}: expected {expect_bytes:,}, "
            f"got {size:,}",
            flush=True,
        )
    return art


def record_local(
    manifest: Manifest, *, name: str, path: Path, url: str, note: str = ""
) -> Artifact:
    """Checksum an already-materialised file (e.g. API-paginated output)."""
    digest, size = sha256_file(path)
    art = Artifact(
        name=name,
        url=url,
        path=str(path.relative_to(SNAPSHOT.parent)),
        bytes=size,
        sha256=digest,
        fetched_at=_now(),
        content_length=None,
        note=note,
    )
    manifest.record(art)
    print(f"  recorded {name}: {_human(size)}  sha256={digest[:16]}…", flush=True)
    return art


def client(timeout: float = 120.0) -> httpx.Client:
    return httpx.Client(
        headers={"User-Agent": USER_AGENT},
        timeout=httpx.Timeout(timeout, connect=30.0),
        follow_redirects=True,
    )
