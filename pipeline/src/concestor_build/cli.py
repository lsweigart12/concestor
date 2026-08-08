"""Command line entry point.

Each phase is a separate subcommand writing to `build/` with a manifest, and
phases are resumable — `dates` does not re-run `topology`. The numbering is a
dependency order, not a priority order.
"""

from __future__ import annotations

import argparse
import sys


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(
        prog="concestor-build",
        description="Offline build pipeline for Concestor's artifact set.",
    )
    sub = p.add_subparsers(dest="phase", required=True)

    s = sub.add_parser("snapshot", help="phase 0 — pin and checksum sources")
    s.add_argument(
        "--skip-checklist",
        action="store_true",
        help="skip the ~470-request GBIF checklist nubKey export",
    )
    s.add_argument("--force", action="store_true", help="re-download everything")

    t = sub.add_parser("topology", help="phase 1 — parse the OTT Newick")
    t.add_argument(
        "--no-oracle",
        action="store_true",
        help="skip the live induced_subtree oracle check",
    )
    t.add_argument(
        "--oracle-samples", type=int, default=200, help="oracle sample count"
    )

    d = sub.add_parser("dates", help="phase 2 — validate the Duke et al. dated tree")
    d.add_argument(
        "--tree",
        default="equal_splits",
        choices=("equal_splits", "birth_model"),
        help="which median tree to validate",
    )
    d.add_argument(
        "--provisional",
        action="store_true",
        help="write age arrays even if the gate fails (walking skeleton only)",
    )

    r = sub.add_parser("resolve", help="phase 3 — the identifier resolution layer")
    r.add_argument(
        "--budget",
        type=int,
        default=25_000,
        help="PBDB taxa to point-look-up via the API, ordered by n_occs descending",
    )
    r.add_argument("--no-api", action="store_true", help="offline methods only")

    f = sub.add_parser("fossils", help="phase 4 — attach PBDB taxa to segments")
    f.add_argument("--no-api", action="store_true", help="offline methods only")

    i = sub.add_parser("images", help="phase 5a — PhyloPic mirror and node resolution")
    i.add_argument(
        "--budget",
        type=int,
        default=0,
        help="stop after N node resolutions (0 = no limit); the crawl is resumable",
    )
    i.add_argument(
        "--mirror-only", action="store_true", help="fetch SVGs for already-resolved ids"
    )

    sub.add_parser("timescale", help="phase 5b — ICS chart.ttl into timescale.json")

    v = sub.add_parser("vernaculars", help="phase 6 — common names")
    v.add_argument("--no-api", action="store_true", help="skip the Wikidata query")

    # Separate from `vernaculars` so ordering can be re-run without replaying
    # phase 6's ingest. Reads the `vernacular` table, writes order and evidence.
    nr = sub.add_parser("names", help="phase 6b — rank common names by use")
    nr.add_argument("--no-api", action="store_true", help="replay checkpoints only")

    sub.add_parser("search", help="build the FTS index over names and vernaculars")

    sub.add_parser("package", help="gate the artifact set and write the build manifest")

    sub.add_parser("render", help="throwaway renderer — one induced subtree")

    args = p.parse_args(argv)

    # Before any phase is imported, because the answer is a property of the
    # checkout rather than of the work: in a git worktree `build/` may be a
    # symlink into the main checkout, and every phase below writes in place.
    # `paths.check_build_writable` says what that would do and how to fix it.
    from . import paths

    if not paths.check_build_writable():
        return 1

    match args.phase:
        case "snapshot":
            from . import snapshot

            return snapshot.run(skip_checklist=args.skip_checklist, force=args.force)
        case "topology":
            from . import topology

            return topology.run(
                oracle=not args.no_oracle, oracle_samples=args.oracle_samples
            )
        case "dates":
            from . import dates

            return dates.run(tree=args.tree, provisional=args.provisional)
        case "resolve":
            from . import resolve

            return resolve.run(budget=args.budget, use_api=not args.no_api)
        case "fossils":
            from . import fossils

            return fossils.run(use_api=not args.no_api)
        case "images":
            from . import images

            return images.run(budget=args.budget, mirror_only=args.mirror_only)
        case "timescale":
            from . import timescale

            return timescale.run()
        case "vernaculars":
            from . import vernaculars

            return vernaculars.run(use_api=not args.no_api)
        case "names":
            from . import name_rank

            return name_rank.run(use_api=not args.no_api)
        case "search":
            from . import search

            return search.run()
        case "package":
            from . import package

            return package.run()
        case "render":
            from . import render

            return render.run()

    return 1


if __name__ == "__main__":
    sys.exit(main())
