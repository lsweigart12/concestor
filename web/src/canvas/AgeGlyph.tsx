/**
 * The two words the age slot used to spell out, as marks.
 *
 * Everything else in that slot is a figure — "96 Ma", "≤ 96 Ma" — so the two
 * cases that are not figures were the two that had to say a word: "fossils"
 * before a range, and "present" where there is no number to give. Set in the
 * same colour and the same slot as the numbers, they read as part of the
 * quantity rather than as a change of register, and they are the widest thing
 * in a label whose whole placement problem is width.
 *
 * A mark is not a decoration here. **The prefix on a fossil range is
 * load-bearing** (see `occurrenceSpan`): beside a node drawn at 66 Ma, a bare
 * "84–66 Ma" is indistinguishable from that node's age, which is the one thing
 * the occurrence tier exists not to imply. So the glyph inherits the whole of
 * that job — it must be as unmissable as the word was, which is why it sits
 * before the range and never after it, and why the range never renders without
 * it. The words survive as the accessible name and the tooltip; nothing is
 * only available to someone who can see it.
 *
 * The shapes are stroked, deliberately. A *filled* shape beside a node means
 * something specific on this canvas — it is a silhouette, a claim about what
 * the taxon looks like (`node_image.clade_idx` and handoff §5) — and a UI
 * affordance drawn in the same register would read as one more such claim.
 *
 * - **fossil**: an ammonite spiral, the ordinary shorthand for a fossil, and
 *   apt here because ammonites are the textbook index fossil — a taxon whose
 *   whole use is saying *when*. Lucide's `shell` (ISC) is the same idea and was
 *   the starting point; its five whorls turn to mud below about 20px, so this
 *   is the same construction opened out to two.
 * - **present**: a clock. In a slot that answers *when*, the reader needs "now"
 *   rather than "time" — but every kingdom-neutral alternative for "alive
 *   today" is worse: a sprout or a leaf beside a dog is wrong, and a heartbeat
 *   beside a fungus is wrong. A clock is never wrong, and the tooltip carries
 *   the rest.
 */

export type AgeGlyphKind = "fossil" | "present";

/**
 * Drawn on a 16 unit grid rather than Lucide's 24, so the stroke stays a round
 * fraction of the box at the 13px this actually renders at.
 */
const PATHS: Record<AgeGlyphKind, React.ReactNode> = {
  // Successive half-turns, each one's radius half the chord it spans, which is
  // what makes the joins tangent and the whorls open out smoothly.
  //
  // The expansion rate is the whole difference between a shell and a swirl. A
  // *geometric* one — each whorl half again as wide as the last — draws a
  // comma, because the outer whorl is nowhere near a circle. Growing by a
  // roughly constant amount instead keeps the outline round and the whorls a
  // stroke and a half apart at 13px, which is the smallest gap that survives.
  fossil: (
    <path
      d="M8.25 8.63a1.4 1.4 0 1 1-2.8 0a2.45 2.45 0 1 1 4.9 0a3.6 3.6 0 1 1-7.2 0a4.85 4.85 0 1 1 9.7 0"
      fill="none"
    />
  ),
  present: (
    <>
      <circle cx="8" cy="8" r="6.1" fill="none" />
      <path d="M8 4.4V8l2.6 1.3" fill="none" />
    </>
  ),
};

const LABELS: Record<AgeGlyphKind, string> = {
  fossil: "fossils",
  present: "present",
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
