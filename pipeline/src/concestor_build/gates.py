"""Validation gates.

A gate is a named assertion with an expected value, an observed value, and a
verdict. Gates are collected rather than raised so that a phase reports every
failure at once instead of stopping at the first; the phase then refuses to
write its output if any gate failed.

The distinction that matters: `require` gates fail the build, `observe` gates
are recorded for the manifest but never block. Nothing in this module ever
downgrades a failure to a warning on its own.
"""

from __future__ import annotations

import json
import sys
from dataclasses import asdict, dataclass, field
from typing import TYPE_CHECKING, Any

if TYPE_CHECKING:
    from pathlib import Path


@dataclass(slots=True)
class Gate:
    name: str
    expected: Any
    actual: Any
    passed: bool
    blocking: bool = True
    note: str = ""

    def line(self) -> str:
        mark = "PASS" if self.passed else ("FAIL" if self.blocking else "WARN")
        body = f"[{mark}] {self.name}"
        if self.expected is not None:
            body += f"\n         expected: {self.expected}"
        body += f"\n         actual:   {self.actual}"
        if self.note:
            body += f"\n         note:     {self.note}"
        return body


@dataclass(slots=True)
class GateSet:
    phase: str
    gates: list[Gate] = field(default_factory=list)

    def require(
        self,
        name: str,
        actual: Any,
        expected: Any = None,
        *,
        ok: bool | None = None,
        note: str = "",
    ) -> Gate:
        passed = (actual == expected) if ok is None else bool(ok)
        g = Gate(name, expected, actual, passed, blocking=True, note=note)
        self.gates.append(g)
        print(g.line(), flush=True)
        return g

    def observe(
        self,
        name: str,
        actual: Any,
        expected: Any = None,
        *,
        ok: bool | None = None,
        note: str = "",
    ) -> Gate:
        passed = True if ok is None else bool(ok)
        g = Gate(name, expected, actual, passed, blocking=False, note=note)
        self.gates.append(g)
        print(g.line(), flush=True)
        return g

    @property
    def failures(self) -> list[Gate]:
        return [g for g in self.gates if g.blocking and not g.passed]

    @property
    def ok(self) -> bool:
        return not self.failures

    def summary(self) -> str:
        n_pass = sum(1 for g in self.gates if g.passed)
        return f"{self.phase}: {n_pass}/{len(self.gates)} gates passed"

    def write(self, path: Path) -> None:
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(
            json.dumps(
                {
                    "phase": self.phase,
                    "ok": self.ok,
                    "gates": [asdict(g) for g in self.gates],
                },
                indent=2,
                default=str,
            )
        )

    def exit_if_failed(self) -> None:
        print("\n" + self.summary(), flush=True)
        if self.failures:
            print(
                f"\n{len(self.failures)} blocking gate(s) failed — refusing to "
                f"write phase output:",
                file=sys.stderr,
            )
            for g in self.failures:
                print(f"  - {g.name}", file=sys.stderr)
            raise SystemExit(1)
