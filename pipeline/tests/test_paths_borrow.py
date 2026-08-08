"""The guard that stops a worktree rebuilding another checkout's artifacts.

`build/` in a git worktree is arranged by `concestor_borrow_build` in
scripts/lib/paths.sh, and it can end up in one of two shapes. A copy-on-write
clone is this checkout's own and safe to write. A symlink — the fallback where
the filesystem cannot clone, and the shape every worktree on this machine used
to be in — reaches into another checkout, where every phase's in-place
`np.save` would land on artifacts that other servers have mmap'd.

These tests are the reason the distinction is enforced rather than documented:
nothing inside a phase can see which shape it was handed.
"""

from __future__ import annotations

import json
from typing import TYPE_CHECKING

import pytest

from concestor_build import paths

if TYPE_CHECKING:
    from pathlib import Path


@pytest.fixture
def build_at(monkeypatch: pytest.MonkeyPatch):
    """Point the module's paths at a throwaway build/ and hand it back."""

    def use(root: Path) -> Path:
        build = root / "build"
        monkeypatch.setattr(paths, "BUILD", build)
        monkeypatch.setattr(paths, "BORROW_STAMP", build / ".borrowed")
        return build

    return use


def test_a_real_directory_is_writable(build_at, tmp_path: Path) -> None:
    build = build_at(tmp_path)
    build.mkdir()
    (build / "topology").mkdir()

    assert paths.check_build_writable()


def test_a_missing_build_is_writable(build_at, tmp_path: Path) -> None:
    """A checkout building from scratch has no build/ yet, and that is fine."""
    build_at(tmp_path)

    assert paths.check_build_writable()


def test_a_symlinked_build_is_refused(
    build_at, tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    other = tmp_path / "main" / "build"
    other.mkdir(parents=True)
    build = build_at(tmp_path / "worktree")
    build.parent.mkdir()
    build.symlink_to(other)

    assert not paths.check_build_writable()

    # The remediation has to name the *checkout*, not the build directory
    # inside it. Getting this off by one level printed `…/build/build`, which
    # is advice that silently does the wrong thing when followed.
    said = capsys.readouterr().err
    assert f"cp -Rc {tmp_path / 'main' / 'build'} build" in said
    assert f"run the pipeline from {tmp_path / 'main'} itself" in said


def test_a_symlinked_entry_is_refused(
    build_at, tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    """The per-entry shape too, which is what push-data-image.sh guards against.

    A phase that only rewrites `topology/` would slip past a check on the
    parent directory alone.
    """
    other = tmp_path / "main" / "build" / "topology"
    other.mkdir(parents=True)
    build = build_at(tmp_path / "worktree")
    build.mkdir(parents=True)
    (build / "topology").symlink_to(other)

    assert not paths.check_build_writable()

    # Two levels up from the resolved link this time, and the same answer.
    said = capsys.readouterr().err
    assert f"cp -Rc {tmp_path / 'main' / 'build'} build" in said


def test_the_escape_hatch_allows_a_symlink(
    build_at, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    other = tmp_path / "main" / "build"
    other.mkdir(parents=True)
    build = build_at(tmp_path / "worktree")
    build.parent.mkdir()
    build.symlink_to(other)
    monkeypatch.setenv(paths.ALLOW_SHARED, "1")

    assert paths.check_build_writable()


def test_a_clone_is_writable_and_names_its_source(
    build_at, tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    build = build_at(tmp_path)
    build.mkdir()
    (build / ".borrowed").write_text(
        json.dumps({"from": "/somewhere/concestor", "build_id": "1a06c3c2a2be4ccf"})
    )

    assert paths.check_build_writable()

    said = capsys.readouterr().err
    assert "/somewhere/concestor" in said
    assert "1a06c3c2a2be4ccf" in said


def test_an_unreadable_stamp_is_not_fatal(build_at, tmp_path: Path) -> None:
    """The stamp is a courtesy. A truncated one must not stop a build."""
    build = build_at(tmp_path)
    build.mkdir()
    (build / ".borrowed").write_text("{not json")

    assert paths.borrow_stamp() is None
    assert paths.check_build_writable()
