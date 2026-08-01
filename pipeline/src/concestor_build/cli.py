"""Command line entry point.

Each phase is a separate subcommand writing to `build/` with a manifest, and
phases are resumable — `dates` does not re-run `topology`.
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

    sub.add_parser("render", help="throwaway renderer — one induced subtree")

    args = p.parse_args(argv)

    match args.phase:
        case "snapshot":
            from . import snapshot

            return snapshot.run(
                skip_checklist=args.skip_checklist, force=args.force
            )
        case "topology":
            from . import topology

            return topology.run(
                oracle=not args.no_oracle, oracle_samples=args.oracle_samples
            )
        case "dates":
            from . import dates

            return dates.run(tree=args.tree, provisional=args.provisional)
        case "render":
            from . import render

            return render.run()

    return 1


if __name__ == "__main__":
    sys.exit(main())
