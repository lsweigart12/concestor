/**
 * The tree makes room: marks already on the canvas slide to their new places
 * rather than jumping there.
 *
 * Adding a taxon moves almost everything. A new leaf takes a row, so every row
 * below it shifts down; a new divergence re-parents a branch, so the fork above
 * it moves in x and both its children move in y. All of that used to happen
 * between two frames — the reader pressed a key and the tree they were reading
 * was replaced by a different one, and the draw that followed was a line
 * arriving into a picture they had to re-find first.
 *
 * **It is split in two, and React Flow is what splits it.** Node positions are
 * React Flow's, and handing it a new `nodes` array on every animation frame
 * makes it drop every edge on the canvas for the whole tween — measured at
 * 60fps, 580ms with no branches drawn at all. So the marks are given their
 * settled positions once and glide on a CSS `transition`, which costs no render
 * at all; the traces, whose geometry is ours, are interpolated here per frame.
 * {@link REFLOW_BEZIER} is the one curve both follow, and it has to be one
 * curve: a dot is the end of a line.
 *
 * The interpolation runs against the *old* layout, so a node that did not exist
 * a moment ago has nothing to come from and is simply placed. That is right: a
 * new mark is invisible until its own line reaches it (`Graph.tsx`'s
 * `enterDelay`), so it has no business sliding in from anywhere.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import type { Placed } from "../tree/layout";
import { bezierEase } from "./gl/tuning";

/**
 * How long the tree takes to rearrange, in ms.
 *
 * It starts on the press, alongside the reframe and well before the draw — the
 * two are the same event and the design has always said so: *reflow and draw
 * overlap; sequential feels laggy*. It is sized to be settling as the first
 * trace leaves, so the branch draws into a tree that has stopped moving without
 * a dead beat between them.
 */
export const REFLOW_MS = 560;

/** Movement under this many layout units is not a reflow. */
const EPSILON = 0.5;

/**
 * The curve, as CSS writes it — and it is written here **once** because two
 * different things follow it and they have to agree exactly.
 *
 * The marks glide on a CSS `transition` (styles.css reads this same tuple
 * through `--reflow-ease`) and the traces are interpolated in JavaScript. A
 * dot is the end of a line: if the two eased even slightly differently, the
 * branch would visibly come away from the mark it arrives at, halfway through
 * every rearrangement.
 *
 * Ease-out: most of the distance early, then a settle. A rearrangement is not
 * a thing being thrown across the canvas — it is the tree conceding room, and
 * front-loading says the space was made immediately.
 */
export const REFLOW_BEZIER = [0.33, 1, 0.68, 1] as const;

export function easeReflow(t: number): number {
  return bezierEase(t, REFLOW_BEZIER);
}

/** Whether any node in both layouts has actually moved. */
export function moved(
  from: ReadonlyMap<number, Placed>,
  to: ReadonlyMap<number, Placed>,
): boolean {
  for (const [idx, p] of to) {
    const q = from.get(idx);
    if (!q) continue;
    if (Math.abs(q.x - p.x) > EPSILON || Math.abs(q.y - p.y) > EPSILON) {
      return true;
    }
  }
  return false;
}

/**
 * `to`, with every node that existed in `from` pulled back towards where it
 * was. `e` is eased progress: 0 is the old arrangement, 1 is `to` itself.
 *
 * Returns `to` unchanged at the end rather than a copy of it, so the frame that
 * finishes the tween hands every consumer the same object identity the settled
 * canvas will keep using.
 */
export function tweenPlaced(
  from: ReadonlyMap<number, Placed>,
  to: ReadonlyMap<number, Placed>,
  e: number,
): ReadonlyMap<number, Placed> {
  if (e >= 1) return to;
  const out = new Map<number, Placed>();
  for (const [idx, p] of to) {
    const q = from.get(idx);
    out.set(
      idx,
      q ? { ...p, x: q.x + (p.x - q.x) * e, y: q.y + (p.y - q.y) * e } : p,
    );
  }
  return out;
}

/**
 * The positions to draw this frame.
 *
 * Hands back `placed` itself whenever nothing is moving, which is almost
 * always, so a settled canvas allocates nothing and every memo downstream keeps
 * its identity. Refuses under `prefers-reduced-motion`: the rearrangement is
 * motion whose whole content is *where things went*, and a reader who has asked
 * for none is better served by the answer than by a slower version of it.
 */
export function useReflow(
  placed: ReadonlyMap<number, Placed>,
  reduced: boolean,
): ReadonlyMap<number, Placed> {
  const last = useRef(placed);
  const [from, setFrom] = useState<ReadonlyMap<number, Placed> | null>(null);
  const [t, setT] = useState(1);
  /**
   * Which tween is running. Bumped only when something actually moved, and it
   * is the *only* thing the clock below is keyed on.
   *
   * **This is not bookkeeping; it is what keeps a tween alive.** The clock used
   * to hang off `placed`, so any re-render handing down an equal-but-new map
   * tore its timers down — and the same guard that makes that case cheap
   * (`!moved` → return) meant nothing started them again. The tween was left
   * parked at whatever `t` it had reached, which in a pane the compositor is not
   * painting is `t = 0`: the branches stay at the arrangement they had before
   * the change while the marks sit at the one they have now, and every line ends
   * a row away from the dot it is drawn to. It does not recover, because nothing
   * is left running to recover it.
   *
   * Two renders in a row is not a corner case. Removing a fossil is exactly
   * that — the graft leaves the layout, and then the promotion pass in
   * `store.ts` prunes what the canvas is showing — and a layout recomputed from
   * an unchanged set still arrives as a new `Map`.
   */
  const [run, setRun] = useState(0);

  useEffect(() => {
    const prev = last.current;
    last.current = placed;
    if (reduced || prev === placed || !moved(prev, placed)) return;
    setFrom(prev);
    setT(0);
    setRun((r) => r + 1);
  }, [placed, reduced]);

  useEffect(() => {
    if (run === 0) return;
    let raf = 0;
    const start = performance.now();
    const settle = () => {
      setT(1);
      setFrom(null);
    };
    const tick = (now: number) => {
      // Progress is read off the clock rather than counted in frames, so a
      // dropped frame shortens the animation instead of stretching it.
      const u = Math.min(1, (now - start) / REFLOW_MS);
      setT(u);
      if (u < 1) raf = requestAnimationFrame(tick);
      else setFrom(null);
    };
    raf = requestAnimationFrame(tick);
    /*
      And a floor under the whole thing, because `requestAnimationFrame` is not
      a promise that anything will happen. A tab in the background, a pane the
      compositor is not painting — this project's own preview pane runs it at
      about a third of a frame per second — and the tween would sit at `t = 0`
      holding the tree in an arrangement it no longer has.

      A timer is throttled in those conditions too, but it is throttled to
      seconds rather than stopped, so this is a guarantee where the frames are a
      courtesy: the animation is optional and arriving at the answer is not.
      Late, it lands on the frame `tick` would have produced anyway.
    */
    const floor = window.setTimeout(settle, REFLOW_MS + 40);
    return () => {
      cancelAnimationFrame(raf);
      window.clearTimeout(floor);
    };
  }, [run]);

  return useMemo(
    () => (from ? tweenPlaced(from, placed, easeReflow(t)) : placed),
    [from, placed, t],
  );
}
