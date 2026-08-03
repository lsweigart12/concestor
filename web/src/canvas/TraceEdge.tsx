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

import { useCallback, useEffect, useRef } from "react";
import type { EdgeProps } from "@xyflow/react";
import {
  TIER_INTERPOLATED,
  TIER_MEASURED,
  TIER_OCCURRENCE,
  TIER_STRUCTURAL,
  type Tier,
} from "../api";
import { hashKey } from "./biolum";
import {
  branchParams,
  onLanding,
  PATH_SAMPLES,
  registerFlow,
  surgeBranch,
  surgeOf,
  tierBrightness,
} from "./flow";
import { LANDING_AMP, LANDING_AT, revealAt } from "./gl/tuning";
import {
  nearestOn,
  samplePath,
  strumAt,
  strumPath,
  STRUM_MS,
  type StrumPoint,
} from "./strum";

export interface TraceEdgeData extends Record<string, unknown> {
  d: string;
  hue: number;
  tier: Tier;
  dim: boolean;
  /**
   * True when nothing below this node is dated, so its far end has no younger
   * age to be spaced against. A statement about where the end was placed, not
   * about whether the lineage is real.
   */
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
  /**
   * Bioluminescence is on: pump the branch, and let it be plucked.
   *
   * Carried on the edge rather than read from a class because the pump is an
   * *element* and the pluck is a handler, and the contract the toggle makes is
   * that with the mode off nothing extra is rendered, nothing extra is
   * animated, and nothing extra is listening — not rendered-and-hidden.
   */
  biolum: boolean;
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

/**
 * Does the reaction travel down this line?
 *
 * The pump is a *descent* animation: it leaves the ancestor and arrives at the
 * descendant, which is what the line means and the direction `orthPath` draws
 * it in. An attachment tether does not mean descent — architecture §3.4's claim
 * is only that the taxon belongs *somewhere* below that branch — so pumping one
 * would animate a lineage nobody has resolved. It is the same refusal that
 * already denies the tether a click target, in the same file and for the same
 * reason: the tether may not offer what a branch offers.
 */
export function mayPump(d: Pick<TraceEdgeData, "attachment">): boolean {
  return !d.attachment;
}

export function TraceEdge({ id, data }: EdgeProps) {
  const d = data as unknown as TraceEdgeData;
  const coreRef = useRef<SVGPathElement>(null);
  const groupRef = useRef<SVGGElement>(null);
  const haloRef = useRef<SVGPathElement>(null);
  /** When the current ring started, or null. Guards a jittery pointer. */
  const strumAtRef = useRef<number | null>(null);
  /** The live ring shape, read by the stream so it bends with its own branch. */
  const bendRef = useRef<((t: number) => number) | null>(null);
  /** The sampled centreline, shared by the stream and the pluck. */
  const ptsRef = useRef<StrumPoint[] | null>(null);
  /** The live ring's frame handle, so it can be called off. */
  const ringRef = useRef(0);
  /**
   * When this branch's draw-on began, or null once it is settled.
   *
   * The river inside the stroke is revealed from the same clock, so the light
   * and the line arrive together — see `revealAt`. Null means "fully lit",
   * which is what a settled canvas and a mid-session mode toggle both want.
   */
  const drawFrom = useRef<number | null>(null);
  /**
   * The rest shape, read at the moment the ring ends rather than captured when
   * it started. A ring outlives layout changes and the geometry it has to
   * restore is whatever the branch has become since.
   */
  const restRef = useRef(d.d);
  restRef.current = d.d;
  const streaming = d.biolum && mayPump(d) && !d.reduced;

  useEffect(() => {
    const core = coreRef.current;
    const group = groupRef.current;
    if (!core || !group || d.drawToken === null) return;

    if (d.reduced) {
      // Cut to the final state and keep the glow static. `drawFrom` stays null,
      // so the river is fully lit rather than frozen part-drawn.
      core.style.removeProperty("stroke-dasharray");
      core.style.removeProperty("stroke-dashoffset");
      drawFrom.current = null;
      return;
    }

    const len = core.getTotalLength();
    core.style.strokeDasharray = `${len}`;
    core.style.strokeDashoffset = `${len}`;
    drawFrom.current = performance.now();

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
      drawFrom.current = null;
    };
    draw.finished.then(done).catch(() => {});

    return () => {
      draw.cancel();
      decay.cancel();
      done();
    };
  }, [d.drawToken, d.delay, d.reduced, d.d]);

  /**
   * Register the branch's river.
   *
   * No loop and no solver of its own. Every pinpoint in every branch is drawn
   * by one instanced call in `gl/renderer.ts`, into the one light buffer the
   * marine snow reads to know how much light is near it and the glass reads to
   * know what to reflect. A branch drawing its own would light nothing and be
   * lit by nothing.
   *
   * What this owns is the *geometry*: the centreline is sampled **once per
   * geometry**, not per frame. `getPointAtLength` is not free and this runs for
   * every branch on the canvas. The count is fixed at {@link PATH_SAMPLES}
   * because it is a texture row — a per-branch count would need either a
   * ragged texture or a second lookup, and forty-eight samples of a path is
   * cheaper than either.
   */
  useEffect(() => {
    const core = coreRef.current;
    if (!core || !streaming) return;
    const len = core.getTotalLength();
    if (!(len > 0)) return;

    // `samplePath` walks `0..=n`, so it returns n+1 points. The texture row is
    // exactly PATH_SAMPLES wide and the glass strip is built from the same
    // array, so asking for one fewer is what keeps the river and the tube it
    // runs in the same length — off by one here left the river ending 2% short
    // of its own wall.
    const pts: StrumPoint[] = samplePath(core, PATH_SAMPLES - 1);
    if (pts.length < 2) return;
    ptsRef.current = pts;

    return registerFlow({
      id,
      pts,
      len,
      hue: d.hue,
      gain: tierBrightness(d.tier, d.unbounded),
      params: branchParams(hashKey(id), len),
      // Read live rather than captured, so a pluck bends the river that is in
      // the tube at the time without re-registering anything.
      bend: () => bendRef.current,
      surgeAt: () => surgeOf(id),
      reveal: () => revealAt(performance.now(), drawFrom.current, d.delay, DRAW_MS),
    });
  }, [id, d.d, d.hue, d.tier, d.unbounded, d.delay, streaming]);

  /**
   * Ring the branch, from wherever it was disturbed.
   *
   * Extracted from the pluck because the entrance fires the same physics from a
   * clock rather than a pointer — see {@link onLanding}. One implementation, so
   * a tree locking into place and a reader running across a branch cannot drift
   * into being two different animations.
   *
   * **And it surges.** This used to throw a burst of particles out across the
   * branch. It does not any more, and the reason is the whole redesign: light
   * leaving an organism and going on shining on its own is the image this mode
   * gave up. A disturbed tentacle fires *harder*, in place — so the river
   * brightens, the glass around it brightens with it because the wall is lit
   * from inside, and the marine snow drifting past brightens too, because the
   * vicinity field it reads went up. Three things respond to one float, and
   * none of them was told about the pluck.
   *
   * The ring is 620ms of writing straight to two `d` attributes, and it can
   * outlive the geometry it started on. Two consequences, both handled rather
   * than hoped away. It restores `restRef` and not the `d.d` it was called
   * with, because adding a species mid-ring gives the branch a new path and the
   * captured one would be put back over it. And it is cancellable, because a
   * component that unmounts mid-ring would otherwise go on calling
   * `setAttribute` on detached nodes for the rest of the 620ms.
   */
  const startRing = useCallback(
    (pts: readonly StrumPoint[], at: number, amp?: number) => {
      const core = coreRef.current;
      const halo = haloRef.current;
      if (!core) return;
      strumAtRef.current = performance.now();
      const walls = [halo, core].filter((el): el is SVGPathElement => el !== null);
      surgeBranch(id);

      const t0 = performance.now();
      const frame = (now: number) => {
        const elapsed = now - t0;
        if (elapsed >= STRUM_MS) {
          for (const el of walls) el.setAttribute("d", restRef.current);
          bendRef.current = null;
          strumAtRef.current = null;
          ringRef.current = 0;
          return;
        }
        bendRef.current = (t) => strumAt(t, elapsed, amp, at);
        const rung = strumPath(pts, elapsed, amp, at);
        for (const el of walls) el.setAttribute("d", rung);
        ringRef.current = window.requestAnimationFrame(frame);
      };
      ringRef.current = window.requestAnimationFrame(frame);
    },
    [id],
  );

  /**
   * The landing.
   *
   * The entrance reaches out of the root a wave at a time, and when the last
   * branch has arrived the whole tree locks in with one ring — harder than a
   * pointer's and struck at the middle, because what arrived is the *branch*
   * rather than a place somebody touched.
   *
   * Attachments are excluded by the same rule that already denies them a pump
   * and a hit target: a tether is not a branch and may not behave like one.
   */
  useEffect(() => {
    if (!d.biolum || d.reduced || !mayPump(d)) return;
    return onLanding(() => {
      const core = coreRef.current;
      if (!core || strumAtRef.current !== null) return;
      const pts = ptsRef.current;
      if (!pts || pts.length < 2) return;
      startRing(pts, LANDING_AT, LANDING_AMP);
    });
  }, [d.biolum, d.reduced, d.attachment, startRing]);

  /**
   * Plucking it.
   *
   * A pointer crossing a branch displaces it and it rings — `strum.ts` has the
   * physics — and it sheds a burst of light where it was touched, because that
   * is what the rest of this mode says a disturbed lineage does.
   *
   * Written straight to the DOM. The ring is a sixty-frame animation on two
   * `d` attributes and it is over in 620ms; routing it through React would
   * re-render the edge sixty times, and a hover has no business in the URL.
   *
   * The **hit target deliberately does not ring**: a target that moved out from
   * under the pointer would re-fire on the way back and hold the branch in a
   * permanent tremor. The stream inside bends through `bendRef`, so the fluid
   * rings with the tube rather than staying rigid while the wall moves around
   * it.
   *
   * It rings **where the pointer touched**, not at the middle. A string bends
   * most where you catch it, and a branch that always bowed at its midpoint
   * regardless of where a reader crossed it read as a canned animation rather
   * than as a response to them. `nearestOn` turns the contact into a position
   * along the branch and `warpTo` moves the antinode there.
   */
  const strum = useCallback(
    (e: React.PointerEvent<SVGPathElement>) => {
      const core = coreRef.current;
      if (!core || d.reduced || !d.biolum) return;
      if (strumAtRef.current !== null) return;
      const pts = ptsRef.current ?? samplePath(core, 24);
      if (pts.length < 2) return;

      /*
        Where the pointer actually crossed, in layout space.

        The event carries client pixels and the path lives inside React Flow's
        transformed viewport, so the two are related by pan, zoom and every
        transform between — `getScreenCTM` is that whole chain, and inverting it
        is the only way to ask the question that does not re-derive the
        viewport by hand and drift from it.

        Then projected onto the branch. The hit target is 16px wide, so the
        pointer can be a long way off the ink, and a pluck has to ring and shed
        light from the *line* rather than from wherever the cursor happened to
        be.
      */
      const ctm = core.getScreenCTM();
      if (!ctm) return;
      const local = new DOMPoint(e.clientX, e.clientY).matrixTransform(ctm.inverse());
      const hitAt = nearestOn(pts, local.x, local.y);
      if (!hitAt) return;

      startRing(pts, hitAt.t);
    },
    [d.reduced, d.biolum, startRing],
  );

  /** Call off any ring still running when this edge goes away. */
  useEffect(
    () => () => {
      if (ringRef.current) window.cancelAnimationFrame(ringRef.current);
      ringRef.current = 0;
      bendRef.current = null;
      strumAtRef.current = null;
    },
    [],
  );

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
          would open a lane for a branch that does not exist.

          It is also where the pluck is caught, and it has to be: the ring is a
          response to the pointer *crossing the branch*, and a 1.6px core is no
          more hoverable than it is clickable. `pointerenter` and not
          `pointermove`, so travelling along a branch plucks it once rather than
          holding it in a permanent tremor. */}
      {!d.attachment && (
        <path className="trace-hit" d={d.d} onPointerEnter={strum} />
      )}
      <path ref={haloRef} className="trace-halo" d={d.d} stroke={stroke} />
      <path ref={coreRef} className="trace-core" d={d.d} stroke={stroke} />
    </g>
  );
}
