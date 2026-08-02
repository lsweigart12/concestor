"""Session-wide guard for the tests that need a built dataset.

Forty-seven of the tests here carry a module-level `skipif` on some artifact
existing — `build/concestor.db`, a phase's `.npy` output, the snapshot. On a
clean checkout they all skip and pytest reports success, which is correct for
CI and misleading anywhere a build was supposed to be present.

`CONCESTOR_REQUIRE_BUILD=1` refuses the run instead, before a single test is
collected. Failing at the session level rather than per test is deliberate:
the question "is a dataset here" has one answer for the whole run, and 47
identical failures would bury it. `scripts/check.sh` sets the variable
whenever it can resolve a build; the Go suite reads the same one.

It guards the database, not `snapshot/`. With a build and no snapshot, 5 tests
in test_vernaculars.py still skip and pytest's own count is the only thing
that says so — the snapshot is 1.7 GB of pinned upstream sources that a
worktree deliberately does not borrow, so requiring it here would make the
flag unusable in the place it is most needed.
"""

import os

import pytest

from concestor_build.topology import DB


# No `session` parameter: pluggy injects hook arguments by name and accepts an
# implementation that declares a subset, so taking one only to ignore it would
# trip ARG001 for nothing.
def pytest_sessionstart() -> None:
    if not os.environ.get("CONCESTOR_REQUIRE_BUILD"):
        return
    if DB.exists():
        return
    raise pytest.UsageError(
        f"CONCESTOR_REQUIRE_BUILD is set but {DB} does not exist, so every "
        "dataset test would skip and the run would pass without testing "
        "anything. Run `uv run concestor-build topology` (and the later "
        "phases), or unset the variable to accept the skips.",
    )
