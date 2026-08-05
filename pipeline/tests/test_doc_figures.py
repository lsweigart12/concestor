"""The prose, held to `build/manifest.json`.

`web/src/canvas/viewport.test.ts` pins layout constants by reading
`styles.css`, and `icons.test.ts` pins the favicon to its generator. The
documents never got the same treatment, and issue #92 is what that cost: the
occurrence tier was written as 2,133 in six files against a build that
produced 2,128, the build id appeared as three different values none of which
was the one in `build/manifest.json`, and phase 4's gate count was 39/39
against a real 50 — copied, plausibly, from the row underneath it.

Every figure below is **read from the manifest**, never restated here. A test
that carried its own copy of the number would be a seventh place for it to
drift.

**What is deliberately not pinned**, because a test that pins everything is a
test somebody deletes the first inconvenient morning:

- **Row counts that are correct and appear in twenty prose shapes** — 523,112
  fossils, 162,466 vernaculars, 885 witness forks. Covering them takes a
  pattern per sentence, and a pattern per sentence fails on the sentence
  rather than on the figure. They were audited by hand and were right.
- **`build/`'s size on disk.** It is not in the manifest, and it moves with
  what has been run rather than with what was built.
- **Test counts.** Pinning one makes every pull request that adds a test edit
  a document, which is how a check gets removed. Those figures were taken out
  of the prose instead — `docs/ci.md` §2 keeps the one that carries an
  argument, the skip split, and nothing else states a total.
- **Build ids that date a measurement.** `architecture.md`'s structural-node
  table and `witness-ceiling.md`'s pre-change analysis both name the build
  they were measured on, and updating those would falsify the measurement.
  Only a claim about the *current* set is checked, and §2 of `handoff.md` is
  the only place allowed to make one.
"""

import json
import re

import pytest

from concestor_build.paths import BUILD, REPO_ROOT

MANIFEST = BUILD / "manifest.json"

pytestmark = pytest.mark.skipif(
    not MANIFEST.exists(), reason="run `concestor-build package` first"
)

# CLAUDE.md and the two front-door files, plus every design document. `web/`
# and `server/` are out of scope on purpose: a build id in a test fixture is an
# arbitrary string chosen to exercise ETag composition, not a claim about
# `build/`, and sweeping it would force a fixture to churn with the dataset.
CORPUS = [
    REPO_ROOT / "CLAUDE.md",
    REPO_ROOT / "README.md",
    REPO_ROOT / "CONTRIBUTING.md",
    *sorted((REPO_ROOT / "docs").glob("*.md")),
]

HANDOFF = REPO_ROOT / "docs" / "handoff.md"


@pytest.fixture(scope="module")
def manifest():
    return json.loads(MANIFEST.read_text())


@pytest.fixture(scope="module")
def docs():
    return {p: p.read_text() for p in CORPUS}


# --- the current build id -----------------------------------------------------
# One claim, one place. The uniqueness half is the load-bearing half: without
# it the next writer states the build id somewhere new, that copy goes stale on
# the next `package` run, and this test passes the whole time.

CURRENT_BUILD = re.compile(r"The current artifact set is `([0-9a-f]{16})`")
CURRENCY_CLAIM = re.compile(
    r"(?:current (?:build|artifact set)|build in `build/`)[^.\n]{0,40}`([0-9a-f]{16})`"
)


def test_handoff_names_the_build_that_is_actually_in_build(manifest):
    found = CURRENT_BUILD.findall(HANDOFF.read_text())
    assert found == [manifest["build_id"]], (
        f"docs/handoff.md §2 names {found}, build/manifest.json says "
        f"{manifest['build_id']!r}"
    )


def test_nothing_else_claims_to_name_the_current_build(docs):
    """A second copy of this figure is a second thing to forget."""
    offenders = {
        p.name: CURRENCY_CLAIM.findall(text)
        for p, text in docs.items()
        if p != HANDOFF and CURRENCY_CLAIM.search(text)
    }
    assert not offenders, (
        f"{offenders} — handoff.md §2 is the only place that may name the "
        "current build. Elsewhere, cite the build a measurement was taken on "
        "('measured on build `…`') and leave it there when the dataset moves."
    )


# --- phase gate counts --------------------------------------------------------

STATE_ROW = re.compile(r"^\| (\d[ab]?) — .*?(\d+)/(\d+) gates", re.MULTILINE)


def test_the_state_table_carries_each_phase_s_real_gate_count(manifest):
    """handoff §2's table, row by row, against the manifest's phase summaries.

    This is the one that caught 39/39 on phase 4: phase 5a's row, immediately
    below, really does have 39, and the eye slides straight over it.
    """
    rows = STATE_ROW.findall(HANDOFF.read_text())
    assert len(rows) >= 8, f"only {len(rows)} phase rows matched; table reshaped?"
    for phase, passed, total in rows:
        summary = manifest["phases"][f"phase{phase}_gates"]
        assert (int(passed), int(total)) == (summary["passed"], summary["gates"]), (
            f"phase {phase}: table says {passed}/{total}, manifest says "
            f"{summary['passed']}/{summary['gates']}"
        )


CITED_GATES = re.compile(r"(\d+)/(\d+) gates")


def test_every_gate_count_cited_anywhere_is_green_and_real(manifest, docs):
    """The looser half, for the citations that name no phase.

    `name-ranking.md`'s "31/31 gates" and `phase2-decision.md`'s "32/32" sit in
    prose with no row label to key on, so all this can ask is that they are
    green and that the total belongs to some phase. That is weak, and it is
    the honest ceiling for a figure written without saying what it counts.
    """
    totals = {s["gates"] for s in manifest["phases"].values()}
    for p, text in docs.items():
        for passed, total in CITED_GATES.findall(text):
            assert passed == total, f"{p.name} cites {passed}/{total} — not green"
            assert int(total) in totals, (
                f"{p.name} cites {total} gates, which is no phase's count "
                f"({sorted(totals)})"
            )


# --- the occurrence tier ------------------------------------------------------
# Six files, one number. The patterns are anchored on the words around the
# figure rather than on the figure, so the test fails when the prose is wrong
# rather than when the prose is rewritten.

OCCURRENCE_SITES = [
    (re.compile(r"([\d,]+) nodes carry (?:one|a range)"), 4),
    (re.compile(r"([\d,]+) useful rows"), 2),
    (re.compile(r"\| `occurrence` \|[^|]*\|\s*([\d,]+)\s*\|"), 1),
    (re.compile(r"0 violations of\s+([\d,]+)"), 1),
    (re.compile(r"The number that matters is not ([\d,]+)"), 1),
]


def test_the_occurrence_tier_is_the_same_size_in_the_prose_and_the_build(
    manifest, docs
):
    expected = f"{manifest['tables']['occurrence']:,}"
    for pattern, minimum in OCCURRENCE_SITES:
        found = [(p.name, m) for p, text in docs.items() for m in pattern.findall(text)]
        assert len(found) >= minimum, (
            f"{pattern.pattern!r} matched {len(found)} sites, expected at least "
            f"{minimum} — the sentence moved, so this pattern now guards nothing"
        )
        wrong = [(name, m) for name, m in found if m != expected]
        assert not wrong, f"{wrong} against build/manifest.json's {expected}"
