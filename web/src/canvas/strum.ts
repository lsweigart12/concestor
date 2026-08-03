/**
 * Plucking a branch.
 *
 * Running the pointer across a trace displaces it and it rings — a real
 * standing wave on a string fixed at both ends, not a wobble. The physics is
 * three factors multiplied, and each one is doing a job the others cannot:
 *
 *   sin(π · warp(s))    the **mode shape**. Zero at both ends — which is what
 *                       "fixed at both ends" means, and without it the branch
 *                       detaches from its own nodes and the dots stop being
 *                       where the line arrives — and largest **wherever the
 *                       pointer touched it**. See {@link warpTo}.
 *   sin(2π · f · t)     the **ring**.
 *   e^(−t/τ)            the **decay**, because water is not a vacuum. This is
 *                       heavily damped on purpose: a branch that rang for two
 *                       seconds would still be moving when the reader's pointer
 *                       reached the next one, and the canvas would never settle.
 *
 * Displacement is **perpendicular to the local tangent**, so the corner of an
 * L-shaped trace bends the way a bent string does rather than the whole path
 * sliding sideways.
 *
 * The samples are taken once, when the pluck starts, and only displaced after
 * that. `getPointAtLength` is not free and calling it forty times a frame for
 * the length of a ring is the difference between this being a flourish and it
 * being a cost.
 */

/** How long the ring lasts, ms. */
export const STRUM_MS = 620;
/** Cycles per second. Fast enough to read as a string, slow enough to see. */
export const STRUM_HZ = 7.5;
/** Peak displacement at the pluck point, in layout px. */
export const STRUM_AMP = 7;
/** Samples along the path. Enough for a smooth curve at any length we draw. */
export const STRUM_SAMPLES = 40;

/**
 * Move the antinode to where the string was actually plucked.
 *
 * `sin(π · s)` is the fundamental: fixed at both ends, largest in the middle,
 * and it was the right shape only as long as every pluck was assumed to land in
 * the middle. A real string bends most *where you catch it* — the classic
 * triangular pluck, peaking at the contact point and running straight to each
 * fixed end.
 *
 * So the arc length is re-parameterised: `at` is mapped to the half-way mark,
 * everything below it is stretched to fill the first half and everything above
 * compressed into the second. Feeding that through the same `sin(π · …)` gives
 * a curve that is still exactly zero at both ends, still smooth, and peaks
 * precisely at the contact point. The corner a literal triangle would have at
 * the pluck is invisible here because a sine's slope is zero at its peak, which
 * is the reason for warping the *input* rather than drawing two straight lines.
 *
 * A pluck of zero length is not a pluck: `at` is clamped away from the ends, or
 * one half of the map divides by zero and the whole branch goes `NaN`.
 */
export function warpTo(s: number, at: number): number {
  const p = Math.min(0.98, Math.max(0.02, at));
  return s <= p ? (s / p) * 0.5 : 0.5 + ((s - p) / (1 - p)) * 0.5;
}

export interface StrumPoint {
  x: number;
  y: number;
  /** Unit normal to the path here. */
  nx: number;
  ny: number;
  /** Position along the path, `0…1`. */
  t: number;
}

/** Just enough of an `SVGPathElement` to sample, so this stays testable. */
export interface Samplable {
  getTotalLength(): number;
  getPointAtLength(len: number): { x: number; y: number };
}

/**
 * The rest shape, with a normal at every sample.
 *
 * Normals come from the *chord* to the neighbouring samples rather than from
 * the tangent at the point, which matters at the rounded corner an `orthPath`
 * puts in: a one-sided difference there swings through ninety degrees between
 * two adjacent samples and the corner folds. A central difference turns
 * smoothly through it.
 */
export function samplePath(path: Samplable, n = STRUM_SAMPLES): StrumPoint[] {
  const total = path.getTotalLength();
  if (!(total > 0)) return [];
  const pts: { x: number; y: number }[] = [];
  for (let i = 0; i <= n; i++) pts.push(path.getPointAtLength((i / n) * total));

  const out: StrumPoint[] = [];
  for (let i = 0; i <= n; i++) {
    const a = pts[Math.max(0, i - 1)]!;
    const b = pts[Math.min(n, i + 1)]!;
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const m = Math.hypot(dx, dy);
    /*
      A degenerate chord gets a real unit normal, not a zero one.

      `|| 1` on the magnitude was not a guard: it divides `(0, 0)` by one and
      yields `(0, 0)`, which is a normal of length zero. Harmless while these
      points only bent an SVG path; the renderer now interpolates between
      adjacent normals and calls `normalize` on the result, and normalising a
      zero vector is NaN — which propagates into a vertex position and silently
      drops whatever was riding on it. Any unit vector will do at a point that
      has no direction; what may not happen is returning something that is not
      one.
    */
    const unit = m > 1e-9;
    out.push({
      x: pts[i]!.x,
      y: pts[i]!.y,
      // Rotate the tangent a quarter turn.
      nx: unit ? -dy / m : 0,
      ny: unit ? dx / m : 1,
      t: i / n,
    });
  }
  return out;
}

/**
 * The displacement multiplier at position `t` along the path, `elapsed` ms in.
 *
 * Returns 0 once the ring has decayed, which is what the caller uses to know it
 * can put the original path string back and stop paying for the animation.
 */
export function strumAt(
  t: number,
  elapsed: number,
  amp = STRUM_AMP,
  at = 0.5,
): number {
  if (elapsed >= STRUM_MS || elapsed < 0) return 0;
  const secs = elapsed / 1000;
  const mode = Math.sin(Math.PI * warpTo(t, at));
  const ring = Math.sin(TAU * STRUM_HZ * secs);
  // τ chosen so the tail is inaudible by `STRUM_MS` rather than cut off at it.
  const decay = Math.exp(-secs / (STRUM_MS / 1000 / 3.2));
  // Caught near an end, a string gives less. Mild — the feedback still has to
  // feel the same wherever a reader touches the branch, and a pluck that went
  // nearly silent at the ends would read as the interaction being unreliable
  // rather than as physics.
  const reach = 0.55 + 0.45 * Math.sin(Math.PI * Math.min(1, Math.max(0, at)));
  return amp * reach * mode * ring * decay;
}

const TAU = Math.PI * 2;

/**
 * The rung shape as a path string.
 *
 * A polyline and not a smooth curve, deliberately: at forty samples over a
 * branch the segments are shorter than the stroke is wide, so nothing is
 * visibly faceted, and `L` costs a third of the characters of a `Q` on a string
 * that is rewritten sixty times a second for the length of the ring.
 */
export function strumPath(
  pts: readonly StrumPoint[],
  elapsed: number,
  amp = STRUM_AMP,
  at = 0.5,
): string {
  let d = "";
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i]!;
    const k = strumAt(p.t, elapsed, amp, at);
    d += `${i === 0 ? "M" : "L"}${(p.x + p.nx * k).toFixed(2)} ${(p.y + p.ny * k).toFixed(2)}`;
    if (i < pts.length - 1) d += " ";
  }
  return d;
}

/**
 * The point on a sampled centreline closest to `(x, y)`, in the same space.
 *
 * This is what turns *where the pointer crossed* into a position along the
 * branch, and it projects onto the line rather than taking the nearest sample
 * for two reasons. The hit target is 16px wide and the pointer can be a long
 * way off the ink, so the light a pluck sheds has to come off the **branch**
 * and not off the cursor. And the samples on a long branch are ~16px apart, so
 * snapping to one would quantise the pluck into visible steps along a line a
 * reader is dragging smoothly across.
 *
 * Returns the projected point, its interpolated normal, and its `t`.
 */
export function nearestOn(
  pts: readonly StrumPoint[],
  x: number,
  y: number,
): StrumPoint | null {
  if (pts.length < 2) return null;
  let best = Infinity;
  let out: StrumPoint | null = null;
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i]!;
    const b = pts[i + 1]!;
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const len2 = dx * dx + dy * dy;
    // A zero-length segment has no direction to project onto; its endpoint is
    // already a candidate through its neighbours.
    const f = len2 > 0 ? Math.min(1, Math.max(0, ((x - a.x) * dx + (y - a.y) * dy) / len2)) : 0;
    const px = a.x + dx * f;
    const py = a.y + dy * f;
    const d2 = (x - px) ** 2 + (y - py) ** 2;
    if (d2 >= best) continue;
    best = d2;
    const nx = a.nx * (1 - f) + b.nx * f;
    const ny = a.ny * (1 - f) + b.ny * f;
    const m = Math.hypot(nx, ny) || 1;
    out = { x: px, y: py, nx: nx / m, ny: ny / m, t: a.t + (b.t - a.t) * f };
  }
  return out;
}
