/**
 * The word the age slot cannot spell as a figure — "fossils", before a range —
 * drawn as a mark. Load-bearing (see `occurrenceSpan`): beside a node drawn at
 * 66 Ma, a bare "84–66 Ma" reads as that node's age, so the range never renders
 * without this in front of it. Stroked, not filled: a filled shape beside a node
 * is a silhouette, a claim about what the taxon looks like. The word survives as
 * the accessible name, and nowhere else — nothing on this canvas explains itself
 * on hover.
 */

export type AgeGlyphKind = "fossil";

/** Drawn on a 16-unit grid so the stroke stays round at the 13px it renders at. */
const PATHS: Record<AgeGlyphKind, React.ReactNode> = {
  // An ammonite spiral: successive half-turns, each radius half its chord, so
  // the whorls open out smoothly. A geometric expansion draws a comma instead.
  fossil: (
    <path
      d="M8.25 8.63a1.4 1.4 0 1 1-2.8 0a2.45 2.45 0 1 1 4.9 0a3.6 3.6 0 1 1-7.2 0a4.85 4.85 0 1 1 9.7 0"
      fill="none"
    />
  ),
};

const LABELS: Record<AgeGlyphKind, string> = {
  fossil: "fossils",
};

export function AgeGlyph({ kind }: { kind: AgeGlyphKind }) {
  return (
    <svg
      className="age-glyph"
      viewBox="0 0 16 16"
      role="img"
      aria-label={LABELS[kind]}
      stroke="currentColor"
      strokeWidth={1.2}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {PATHS[kind]}
    </svg>
  );
}
