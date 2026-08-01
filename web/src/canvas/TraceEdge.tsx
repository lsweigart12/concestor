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
import { TIER_INTERPOLATED, TIER_STRUCTURAL, type Tier } from "../api";

export interface TraceEdgeData extends Record<string, unknown> {
  d: string;
  hue: number;
  tier: Tier;
  dim: boolean;
  /** True when nothing below this node is dated: the position is a guess. */
  unbounded: boolean;
  /** Changes when a new draw should run; null means "already settled". */
  drawToken: number | null;
  /** ms after the interaction start, per the signature sequence. */
  delay: number;
  reduced: boolean;
}

const TIER_CLASS: Record<number, string> = {
  [TIER_INTERPOLATED]: "tier-interpolated",
  [TIER_STRUCTURAL]: "tier-structural",
};

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
      { duration: 350, delay: d.delay, easing: "cubic-bezier(.16,.9,.3,1)", fill: "both" },
    );

    // t=470 relative to the interaction: decay from flare-bright to steady
    // over ~800ms. Brightness encodes recency here, which is exactly what
    // luminance is reserved for.
    const decay = group.animate(
      [
        { opacity: 1, filter: "brightness(2.1)" },
        { opacity: 1, filter: "brightness(1)" },
      ],
      { duration: 800, delay: d.delay + 350, easing: "ease-out", fill: "both" },
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

  const stroke = `hsl(${d.hue} ${d.tier === TIER_STRUCTURAL ? 22 : d.tier === TIER_INTERPOLATED ? 42 : 68}% ${d.tier === TIER_STRUCTURAL ? 52 : 62}%)`;

  return (
    <g
      ref={groupRef}
      className={[
        "trace",
        TIER_CLASS[d.tier] ?? "tier-measured",
        d.unbounded ? "trace-unbounded" : "",
        d.dim ? "dimmed" : "",
      ]
        .filter(Boolean)
        .join(" ")}
      data-id={id}
    >
      <path className="trace-halo" d={d.d} stroke={stroke} />
      <path ref={coreRef} className="trace-core" d={d.d} stroke={stroke} />
    </g>
  );
}
