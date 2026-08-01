"""Repo-relative locations for the build's inputs and outputs."""

from __future__ import annotations

from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[3]

SNAPSHOT = REPO_ROOT / "snapshot"
BUILD = REPO_ROOT / "build"
DATA = REPO_ROOT / "data"

SNAPSHOT_MANIFEST = SNAPSHOT / "manifest.json"


def ensure_dirs() -> None:
    for d in (SNAPSHOT, BUILD, DATA):
        d.mkdir(parents=True, exist_ok=True)
