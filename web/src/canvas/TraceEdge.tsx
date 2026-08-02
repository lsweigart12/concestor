/**
 * A trace: 1–2px luminous core plus a soft halo, drawn on from the MRCA
 * outward.
 *
 * The draw-on is `getTotalLength()` with `stroke-dasharray` /
 * `stroke-dashoffset`, exactly as design-reference.md specifies, which is the
 * reason edges stay real SVG paths rather than becoming WebGL geometry. Decay
 * is a separate opacity tween on the same element, so the flare and the settle
 * are independent and either can be interrupted.
 *
 * The one subtlety: age provenance already uses `stroke-dasharray` to mark
 * inferred structure. During the draw the dash pattern is commandeered for the
 * animation, then handed back to the stylesheet when it finishes — so a
 * structural trace draws solid and *becomes* dashed as it settles, which reads
 * as the line resolving into what it actually is.
 */

import { useEffect, useRef } from "react";
import type { EdgeProps } from "@xyflow/react";
import {
  TIER_INTERPOLATED,
  TIER_MEASURED,
  TIER_OCCURRENCE,
  TIER_STRUCTURAL,
  type Tier,
} from "../api";

export interface TraceEdgeData extends Record<string, unknown> {
  d: string;
  hue: number;
  tier: Tier;
  dim: boolean;
  /** True when nothing below this node is dated: the position is a guess. */
  unbounded: boolean;
  /**
   * This segment's drill-down lane is open. Brightness is legitimate here: it
   * is a selection, which is exactly what luminance is reserved for.
   */
  drilled: boolean;
  /**
   * A fossil's connector rather than a branch of the tree.
   *
   * It is not a segment: there is nothing between its ends to drill into, and
   * the position it leaves the lineage from is the *deepest* node the taxon is
   * known to sit below rather than the point it actually parted. So it is drawn
   * as an attachment and not as descent — sparser, dimmer, and with no hit
   * target, because the one interaction a branch offers is the one thing this
   * line cannot honestly do.
   */
  attachment: boolean;
  /** Changes when a new draw should run; null means "already settled". */
  drawToken: number | null;
  /** ms after the interaction start, per the signature sequence. */
  delay: number;
  reduced: boolean;
}

/**
 * How long a trace takes to draw itself on, and how long it takes to settle
 * from flare-bright back to steady, in ms.
 *
 * Exported because `Graph.tsx` has to hold the delta open until the last trace
 * has finished both — hand it back early and the cleanup here cancels a draw
 * mid-flight. That is a real coupling between two files, so it is a shared
 * constant rather than a number that happens to be large enough today.
 */
export const DRAW_MS = 613;
export const DECAY_MS = 1400;

/**
 * The class that carries a tier's dash pattern. Exported because the legend
 * draws real traces rather than pictures of them — see `Legend.tsx`.
 */
export const TIER_CLASS: Record<number, string> = {
  [TIER_MEASURED]: "tier-measured",
  [TIER_INTERPOLATED]: "tier-interpolated",
  [TIER_STRUCTURAL]: "tier-structural",
  // Deliberately the structural dash, not a fourth pattern. The dash channel
  // answers one question — has anyone estimated an age for this node — and the
  // answer for an occurrence node is no, exactly as for a structural one. What
  // it has instead is a fossil range, and that shows as a figure on the node,
  // where a reader can read it. Four dash densities is more than the channel
  // can carry and more than anyone can tell apart.
  [TIER_OCCURRENCE]: "tier-structural",
};

/**
 * The stroke for a trace, given its lane hue and its provenance tier.
 *
 * Saturation and lightness are the *second* provenance channel — dash is the
 * first — because luminance is reserved for recency and selection and may not
 * be spent on a data value. Inference reads as desaturated, not as dim.
 *
 * `hue` takes a CSS expression as well as a number so the legend can pass
 * `var(--accent-h)`: its swatches belong to no lane, and borrowing one lane's
 * hue would imply the row was about that lineage.
 */
export function traceStroke(hue: number | string, tier: Tier): string {
  const undated = tier === TIER_STRUCTURAL || tier === TIER_OCCURRENCE;
  const sat = undated ? 22 : tier === TIER_INTERPOLATED ? 42 : 68;
  const light = undated ? 52 : 62;
  return `hsl(${hue} ${sat}% ${light}%)`;
}

export function TraceEdge({ id, data }: EdgeProps) {
  const d = data as unknown as TraceEdgeData;
  const coreRef = useRef<SVGPathElement>(null);
  const groupRef = useRef<SVGGElement>(null);

  useEffect(() => {
    const core = coreRef.current;
    const group = groupRef.current;
    if (!core || !group || d.drawToken === null) return;

    if (d.reduced) {
      // Cut to the final state and keep the glow static.
      core.style.removeProperty("stroke-dasharray");
      core.style.removeProperty("stroke-dashoffset");
      return;
    }

    const len = core.getTotalLength();
    core.style.strokeDasharray = `${len}`;
    core.style.strokeDashoffset = `${len}`;

    const draw = core.animate(
      [{ strokeDashoffset: len }, { strokeDashoffset: 0 }],
      { duration: DRAW_MS, delay: d.delay, easing: "cubic-bezier(.16,.9,.3,1)", fill: "both" },
    );

    // Once the line has arrived, it decays from flare-bright to steady.
    // Brightness encodes recency here, which is exactly what luminance is
    // reserved for.
    const decay = group.animate(
      [
        { opacity: 1, filter: "brightness(2.1)" },
        { opacity: 1, filter: "brightness(1)" },
      ],
      { duration: DECAY_MS, delay: d.delay + DRAW_MS, easing: "ease-out", fill: "both" },
    );

    const done = () => {
      // Hand the dash pattern back to the stylesheet, which is where the
      // provenance tier lives.
      core.style.removeProperty("stroke-dasharray");
      core.style.removeProperty("stroke-dashoffset");
    };
    draw.finished.then(done).catch(() => {});

    return () => {
      draw.cancel();
      decay.cancel();
      done();
    };
  }, [d.drawToken, d.delay, d.reduced, d.d]);

  const stroke = traceStroke(d.hue, d.tier);

  return (
    <g
      ref={groupRef}
      className={[
        "trace",
        TIER_CLASS[d.tier] ?? "tier-measured",
        d.unbounded ? "trace-unbounded" : "",
        d.drilled ? "trace-drilled" : "",
        d.attachment ? "trace-attachment" : "",
        d.dim ? "dimmed" : "",
      ]
        .filter(Boolean)
        .join(" ")}
      data-id={id}
    >
      {/* An invisible target, because a 1.6px core is not something a person
          can click and the drill-down is a first-class interaction rather than
          a power-user affordance. This is what xyflow's `interactionWidth`
          does for its own edge types; ours draws its own paths and so has to
          carry it. An attachment gets none: it is not a segment, so a click
          would open a lane for a branch that does not exist. */}
      {!d.attachment && <path className="trace-hit" d={d.d} />}
      <path className="trace-halo" d={d.d} stroke={stroke} />
      <path ref={coreRef} className="trace-core" d={d.d} stroke={stroke} />
    </g>
  );
}
