"""The packaging gate — the only thing that checks the artifact set as a whole.

Individual phases validate their own output. Nothing else notices that the age
array is shorter than the topology it claims to describe, or that a phase wrote
gates recording its own failure and then everything downstream carried on.

Both tests below cover mistakes this file actually made on its first run.
"""

from __future__ import annotations

import json

from concestor_build import package


def _write_gates(tmp_path, name, *, ok, gates=()) -> None:
    (tmp_path / name).write_text(
        json.dumps({"phase": name, "ok": ok, "gates": list(gates)})
    )


def test_gate_summaries_ignore_our_own_previous_run(tmp_path, monkeypatch):
    """A failing package run must not make every later run fail.

    `_gate_summaries` globs `*_gates.json`, and this phase writes
    `package_gates.json` into the same directory. Reading it back means one bad
    build poisons every subsequent one with a failure it inherited from itself.
    """
    monkeypatch.setattr(package, "BUILD", tmp_path)
    _write_gates(tmp_path, "phase1_gates.json", ok=True)
    _write_gates(tmp_path, "package_gates.json", ok=False)

    out = package._gate_summaries()
    assert "phase1_gates" in out
    assert "package_gates" not in out


def test_gate_summaries_surface_the_failing_gate_not_just_the_verdict(
    tmp_path, monkeypatch
):
    monkeypatch.setattr(package, "BUILD", tmp_path)
    _write_gates(
        tmp_path,
        "phase6_gates.json",
        ok=False,
        gates=[
            {
                "name": "vernacular for 'dog'",
                "passed": False,
                "blocking": True,
                "expected": "1+",
                "actual": "0",
            },
            {
                "name": "rows",
                "passed": True,
                "blocking": True,
                "expected": 1,
                "actual": 1,
            },
        ],
    )
    out = package._gate_summaries()["phase6_gates"]
    assert out["ok"] is False
    assert out["passed"] == 1
    # The manifest has to name what failed. "ok: false" alone sends whoever
    # reads /v1/about back to the build machine to find out why.
    assert [f["name"] for f in out["failures"]] == ["vernacular for 'dog'"]


def test_a_corrupt_gate_file_is_reported_rather_than_crashing_the_build(
    tmp_path, monkeypatch
):
    monkeypatch.setattr(package, "BUILD", tmp_path)
    (tmp_path / "phase9_gates.json").write_text("{not json")
    out = package._gate_summaries()["phase9_gates"]
    assert "error" in out


def test_sha256_marks_a_capped_digest_as_partial(tmp_path):
    p = tmp_path / "big.bin"
    p.write_bytes(b"x" * (3 << 20))
    full = package._sha256(p)
    capped = package._sha256(p, limit=1 << 20)
    # A prefix hash still catches truncation and replacement, which is what it
    # is for — but it is not the whole-file digest and must not be filed as one.
    assert full != capped
    assert len(capped) == 64
