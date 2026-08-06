# Contributing

Issues and pull requests are welcome. This file covers the things that are
specific to this repository; [README.md](README.md) covers what the project is
and [CLAUDE.md](CLAUDE.md) covers the conventions and the mistakes that
motivated them.

## Before you open a pull request

```bash
scripts/check.sh
```

That is the run to trust. It is everything CI runs plus the tests CI cannot
run, and the difference matters more here than in most projects: CI checks out
a clean tree, a clean tree has no `build/`, and **most of the Go suite and a
fifth of the pipeline's skip themselves and both still report success.**
`check.sh` finds a dataset, sets `CONCESTOR_REQUIRE_BUILD=1` so a skip becomes
a failure, and is the only run that exercises the code against real artifacts.
[docs/ci.md](docs/ci.md) §2 is the whole argument, and the one place the split
is counted.

If you have no `build/` — it is a long one-time job, and the README's quick
start builds it — say so in the pull request. The per-component suites still
mean something:

```bash
cd pipeline && uv run ruff format src tests && uv run ruff check src tests && uv run ty check && uv run pytest
cd server && go test ./...
cd web && npm install && npm run format:check && npm run lint && npm run build && npm test
```

All four pipeline commands must pass. `ty check` runs clean and is expected to
stay that way; `Any` is allowed only for decoded JSON.

## Commits

Every commit carries a [Conventional Commits](https://www.conventionalcommits.org)
type and nothing else about it changes. The subject stays a sentence in this
project's voice — `feat: Make the card say what a thing is, and let the reader
walk from it` is a valid subject, and `subject-case` is off in
`commitlint.config.cjs` for exactly that reason.

The type is not cosmetic. Merging to `main` cuts a release and the version is
computed from these prefixes and nothing else. **`release.config.cjs`'s
`releaseRules` is the one place that mapping is written down** — read it there
rather than from memory. It was previously asserted in three prose files,
enforced in none of them, and wrong in all three.

## What a change is expected to carry

- **A gate, if the change makes a column load-bearing.** Each build phase
  collects gates rather than raising on the first failure, so a run reports
  every problem at once and then refuses to write its output. Counting rows is
  not the same as checking them: add a content gate whenever a column starts
  carrying something a downstream consumer depends on.
- **The current design, in `docs/` — and only what is current.** The documents
  in `docs/` are the specification: what the system does now, stated tersely. The
  *why* and the alternatives you rejected belong in the commit message and the
  pull request, where they stay searchable without becoming ongoing baggage. Do
  not narrate the journey in the docs; state the destination.
- **A test at the seam, if you touched one.** `web/src/tree/induced.ts` and its
  Go counterpart are both ports of `render.py`'s `induced_subtree`, each pinned
  to the Python reference by a test built from the real baked arrays. Change
  the suppression rule in one place and those tests will tell you which of the
  other two you missed.

## Two things that will waste your time

**The figures in `docs/` are measured, not estimated.** They were verified
against live APIs and data files, and several widely-repeated public numbers
are wrong in ways those documents record. When a gate fails against one, check
what the gate is measuring before changing either side — mean depth failed at
41.67 against an expected 41.32 because the document said *root-to-tip* and the
gate was averaging over internal nodes too. The document was right.

**Do not apply a lint or type fix without reading the surrounding code.** Two
real bugs here came from exactly that. Renaming `rank` to `_rank` to silence an
unused-variable warning left the column it fed permanently `NULL`; every gate
still passed and the only symptom was a database 19 MB smaller. When a lint fix
touches a name that flows into output, check the output.

## Data and licensing

The Apache licence covers the software. It does **not** cover the scientific
data the pipeline downloads or the artifact set it bakes — those carry their
own upstream terms, and [NOTICE](NOTICE) sets them out. Two consequences bear
on contributions:

- **A new upstream source needs its terms recorded in `NOTICE` before its data
  is used**, not after. TimeTree is excluded outright and no TimeTree-derived
  age may be added.
- **5.8% of the silhouette corpus is NonCommercial.** The pipeline applies no
  NonCommercial filter, deliberately, because the project is not commercial.
  Anything that changes that premise changes what may ship.

## Decisions

Decisions in this codebase are made by whoever holds it. The documents escalate
nothing and hold nothing open pending approval. If you meet a fork the docs do
not cover, propose a decision with your reasoning rather than a question — a
decision recorded with its evidence is worth more than a decision deferred.
