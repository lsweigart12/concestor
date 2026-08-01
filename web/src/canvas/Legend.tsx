/**
 * What the lines mean.
 *
 * The dash channel carries the one claim this app cannot afford to leave
 * unexplained. A dashed trace means nobody has estimated when that split
 * happened, and inside a dashed region the horizontal axis stops meaning
 * *time* and starts meaning *nesting depth* (architecture §3.5). Before this
 * existed the only place that was written down was the design docs, which is
 * not where a reader is — and "be honest about uncertainty visually" is not
 * satisfied by a channel nobody can decode.
 *
 * Four rules keep it a piece of chrome rather than a wall of caveats:
 *
 *   - It is **not a panel**. It is flat text on the axis footer, sharing that
 *     line with the units and the scale mode, because all three answer the one
 *     question "how do I read a position here?". Two earlier cuts got this
 *     wrong in the same way — a titled card, then a bordered pill — and each
 *     added a floating object to an edge that already had two.
 *   - It only names patterns that are actually **on screen**. The rows are
 *     derived from the edges being drawn, so a fully dated tree gets no legend
 *     at all, and no row ever explains a line the reader cannot point at. A
 *     tree with nothing to admit says nothing.
 *   - The swatches are **real traces** — same `.trace-core` class, same tier
 *     class, same stroke helper as the canvas. Change a dash pattern in
 *     styles.css and the legend moves with it; the two cannot drift. The only
 *     thing dropped is the halo, because a 3.5px blur inside a 26px swatch is
 *     mush rather than glow.
 *   - It does **not** fade with the auto-hiding chrome. The hint bar advertises
 *     bindings that work whether or not you can read them; this says how to
 *     read the picture, which is the axis's job and the axis does not fade.
 *
 * Two or three words is all a key gets. The sentence-length version of each of
 * these already exists in the node card, one click away on the node the reader
 * is actually asking about — which is the right place for it, because that is
 * where they asked.
 */

import { useMemo } from "react";
import { TIER_INTERPOLATED, TIER_MEASURED, TIER_STRUCTURAL, type Tier } from "../api";
import { traceStroke, TIER_CLASS, type TraceEdgeData } from "./TraceEdge";

/** Just enough of an edge to say which patterns are on screen. */
export type TracePattern = Pick<TraceEdgeData, "tier" | "unbounded">;

export interface LegendRow {
  id: string;
  tier: Tier;
  /** Extra trace classes beyond the tier's own, in canvas order. */
  unbounded: boolean;
  text: string;
}

/**
 * Ordered most certain to least, which is also the order the eye reads them
 * in: each concedes more than the one before it.
 *
 * Every label stands alone. Rows appear only when their pattern is drawn, so
 * any of these can turn up without its neighbours — an earlier draft phrased
 * the last one as a continuation ("and nothing below it either…") and it hung
 * off a sentence that was frequently not on screen.
 *
 * "Upper bound" is the only jargon that survives, because there is no shorter
 * honest way to say the number is a ceiling rather than an estimate, and
 * getting a reader to distrust `≤ 652 Ma` slightly is the whole reason it is
 * written that way.
 */
const ALL_ROWS: readonly LegendRow[] = [
  { id: "measured", tier: TIER_MEASURED, unbounded: false, text: "dated" },
  {
    id: "interpolated",
    tier: TIER_INTERPOLATED,
    unbounded: false,
    text: "upper bound",
  },
  { id: "structural", tier: TIER_STRUCTURAL, unbounded: false, text: "no age" },
  { id: "unbounded", tier: TIER_STRUCTURAL, unbounded: true, text: "guessed" },
];

/**
 * Which rows this canvas has earned.
 *
 * Returns nothing when every trace is solid: with no dashes to decode, a row
 * saying "solid means measured" is a caption on the absence of a problem.
 */
export function legendRows(edges: readonly TracePattern[]): LegendRow[] {
  const present = new Set<string>();
  for (const e of edges) {
    if (e.tier === TIER_MEASURED) present.add("measured");
    else if (e.tier === TIER_INTERPOLATED) present.add("interpolated");
    else present.add(e.unbounded ? "unbounded" : "structural");
  }
  if (!present.has("interpolated") && !present.has("structural") && !present.has("unbounded")) {
    return [];
  }
  return ALL_ROWS.filter((r) => present.has(r.id));
}

export function Legend({ edges }: { edges: readonly TracePattern[] }) {
  const rows = useMemo(() => legendRows(edges), [edges]);
  // Not `null`: the footer is a three-column grid that centres the caption on
  // the viewport, and an absent first column would slide it off centre.
  if (rows.length === 0) return <span className="legend" />;

  return (
    <div className="legend">
      {rows.map((r) => (
        <span className="legend-row" key={r.id}>
          {/* aria-hidden: the swatch illustrates the label, it does not make a
              second statement. A screen reader gets the words, which is where
              the meaning is. */}
          <svg className="legend-swatch" width="22" height="8" aria-hidden="true">
            <g
              className={`trace ${TIER_CLASS[r.tier]}${r.unbounded ? " trace-unbounded" : ""}`}
            >
              <path
                className="trace-core"
                d="M1 4 H21"
                stroke={traceStroke("var(--accent-h)", r.tier)}
              />
            </g>
          </svg>
          {r.text}
        </span>
      ))}
    </div>
  );
}
