#!/usr/bin/env python3
"""Turn `go test -json` into a pass/skip split, and refuse a hollow green run.

`server/internal/testenv` skips every test that needs the baked artifacts when
build/concestor.db is absent, so a clean checkout — which is what CI is, and
what a fresh git worktree is — runs 17 of 99 tests and prints `ok`. That is the
right default (a checkout without a 2.9 GB dataset should not fail) and a bad
thing to leave invisible, because `ok` reads as "the server is tested".

So this prints the split where the reader will see it, and fails when the
dataset-free tests have gone too. It cannot check the dataset half; that is
`CONCESTOR_REQUIRE_BUILD=1`, which `scripts/check.sh` sets whenever a build is
reachable.

Outside the pipeline's ruff/ty scope on purpose: it runs under whatever python3
the runner ships, before any dependency is installed.
"""

import collections
import json
import os
import pathlib
import sys

# A floor, not an expectation. 17 tests run without a dataset today; this
# fails only if that collapses to almost nothing, which is what a broken
# testenv lookup or an accidentally dataset-gated package looks like. Raising
# it every time a test is added would be churn for no signal.
MIN_TESTS_WITHOUT_DATASET = 10


def main() -> int:
    stream = pathlib.Path(sys.argv[1])
    counts: collections.Counter[str] = collections.Counter()
    failed: list[str] = []

    for line in stream.read_text().splitlines():
        try:
            event = json.loads(line)
        except ValueError:
            continue  # `go test` interleaves build output, which is not JSON
        action, test = event.get("Action"), event.get("Test")
        # Subtests carry a "/" in their name and are counted by their parent;
        # counting both would inflate the totals by an arbitrary factor.
        if not test or "/" in test:
            continue
        if action in ("pass", "fail", "skip"):
            counts[action] += 1
        if action == "fail":
            failed.append(f"{event.get('Package', '?')}.{test}")

    ran = counts["pass"] + counts["fail"]
    total = ran + counts["skip"]
    summary = [
        f"**{counts['pass']} passed, {counts['fail']} failed, "
        f"{counts['skip']} skipped** of {total} tests.",
    ]
    if counts["skip"]:
        summary += [
            "",
            f"The {counts['skip']} skips are tests that read the baked "
            "artifacts, and there is no `build/` here. That is expected in "
            "CI and it is most of the suite — run `scripts/check.sh` on a "
            "machine with a build to exercise them.",
        ]
    if failed:
        summary += ["", "Failed:", *(f"- `{name}`" for name in failed)]

    text = "\n".join(summary)
    print(text)
    if step_summary := os.environ.get("GITHUB_STEP_SUMMARY"):
        with pathlib.Path(step_summary).open("a") as fh:
            fh.write(f"### Go tests\n\n{text}\n")

    if failed or counts["fail"]:
        return 1
    if ran < MIN_TESTS_WITHOUT_DATASET:
        print(
            f"::error::only {ran} tests ran; at least "
            f"{MIN_TESTS_WITHOUT_DATASET} run without a dataset. The suite is "
            "skipping itself — check testenv.BuildDir and the package layout.",
        )
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
