"""The data image's tag is checked against the artifacts it names.

`push-data-image.sh` runs `build_id.py` as a script, under the machine's own
`python3`, and tags the image with what it prints.
"""

from __future__ import annotations

import ast
import json
import subprocess
import sys
from pathlib import Path

from concestor_build import build_id

SCRIPT = Path(build_id.__file__)


def _build(tmp_path: Path) -> Path:
    (tmp_path / "topology").mkdir()
    (tmp_path / "topology" / "parent.npy").write_bytes(b"\x00" * 64)
    (tmp_path / "concestor.db").write_bytes(b"db" * 1000)
    (tmp_path / "timescale.json").write_text("{}")
    files = build_id.digests(tmp_path)
    (tmp_path / "manifest.json").write_text(
        json.dumps({"build_id": build_id.build_id(files), "files": files})
    )
    return tmp_path


def _run(build: Path) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        [sys.executable, "-I", str(SCRIPT), str(build)],
        capture_output=True,
        text=True,
        check=False,
    )


def test_a_current_manifest_prints_its_build_id(tmp_path):
    build = _build(tmp_path)
    named = json.loads((build / "manifest.json").read_text())["build_id"]
    out = _run(build)
    assert out.returncode == 0, out.stderr
    assert out.stdout.strip() == named


def test_a_phase_rerun_after_package_is_refused(tmp_path):
    build = _build(tmp_path)
    (build / "concestor.db").write_bytes(b"db" * 999 + b"DB")
    out = _run(build)
    assert out.returncode == 1
    assert out.stdout == ""
    assert "a phase ran after" in out.stderr


def test_a_change_past_any_prefix_changes_the_id(tmp_path):
    """The old digest read the database's first 64 MB and stopped."""
    build = _build(tmp_path)
    before = build_id.build_id(build_id.digests(build))
    with (build / "concestor.db").open("r+b") as fh:
        fh.seek(-1, 2)
        fh.write(b"!")
    assert build_id.build_id(build_id.digests(build)) != before


def test_no_manifest_is_refused(tmp_path):
    build = _build(tmp_path)
    (build / "manifest.json").unlink()
    assert _run(build).returncode == 1


def test_it_still_parses_as_the_python_macos_ships():
    """/usr/bin/python3 is 3.9, and the push script runs this file with it."""
    ast.parse(SCRIPT.read_text(), feature_version=(3, 9))
