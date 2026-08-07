/**
 * The hook, with a clock we control.
 *
 * Its arithmetic is pinned in `reflow.test.ts`; what is here is the part that
 * cannot be — when the tween arms, what it hands back while it runs, and that
 * it lands whether or not a single frame is ever drawn. That last one is not
 * hypothetical: `requestAnimationFrame` runs at about a third of a frame per
 * second in this project's own preview pane, and a tween that only advanced on
 * frames would leave the tree in an arrangement it no longer has.
 */
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PathNode } from "../api";
import type { Placed } from "../tree/layout";
import { REFLOW_MS, useReflow } from "./reflow";

const node = { idx: 0 } as unknown as PathNode;

function at(entries: [number, number, number][]): Map<number, Placed> {
  return new Map(
    entries.map(([idx, x, y]) => [
      idx,
      { idx, x, y, node, isLeaf: true, isMRCA: false, hue: 200 },
    ]),
  );
}

/** Frames only when we ask for them, so "no frames at all" is expressible. */
let frames: FrameRequestCallback[] = [];

beforeEach(() => {
  vi.useFakeTimers();
  frames = [];
  vi.stubGlobal("requestAnimationFrame", (fn: FrameRequestCallback) => {
    frames.push(fn);
    return frames.length;
  });
  vi.stubGlobal("cancelAnimationFrame", () => {});
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

/** Run the one frame that is pending, at `now` ms into the tween. */
function frame(now: number) {
  const pending = frames;
  frames = [];
  act(() => {
    for (const fn of pending) fn(performance.now() + now);
  });
}

describe("useReflow", () => {
  it("hands back the layout itself when nothing has moved", () => {
    const first = at([[1, 0, 0]]);
    const { result, rerender } = renderHook(({ p }) => useReflow(p, false), {
      initialProps: { p: first },
    });
    expect(result.current).toBe(first);

    // A taxon added below everything drawn moves nothing, which is the common
    // case and the one that has to cost nothing at all.
    const grown = at([
      [1, 0, 0],
      [2, 40, 80],
    ]);
    rerender({ p: grown });
    expect(result.current).toBe(grown);
  });

  it("pulls a moved node back to where it was, then releases it", () => {
    const { result, rerender } = renderHook(({ p }) => useReflow(p, false), {
      initialProps: { p: at([[1, 0, 0]]) },
    });
    rerender({ p: at([[1, 0, 100]]) });
    // The frame the layout changed on already draws the old arrangement, so
    // nothing jumps before the tween has had a frame to run.
    expect(result.current.get(1)!.y).toBe(0);

    frame(REFLOW_MS / 2);
    const mid = result.current.get(1)!.y;
    expect(mid).toBeGreaterThan(0);
    expect(mid).toBeLessThan(100);

    frame(REFLOW_MS);
    expect(result.current.get(1)!.y).toBe(100);
  });

  /**
   * The guarantee, as against the courtesy above. Not one frame is drawn here.
   */
  it("lands without a single frame, on the timer alone", () => {
    const target = at([[1, 0, 100]]);
    const { result, rerender } = renderHook(({ p }) => useReflow(p, false), {
      initialProps: { p: at([[1, 0, 0]]) },
    });
    rerender({ p: target });
    expect(result.current.get(1)!.y).toBe(0);

    frames = [];
    act(() => {
      vi.advanceTimersByTime(REFLOW_MS + 100);
    });
    expect(result.current).toBe(target);
  });

  /**
   * A rearrangement's whole content is *where things went*. A reader who has
   * asked for no motion is better served by the answer than by a slower
   * version of it — so this is a refusal, not a shorter duration.
   */
  it("refuses under reduced motion", () => {
    const target = at([[1, 0, 100]]);
    const { result, rerender } = renderHook(({ p }) => useReflow(p, true), {
      initialProps: { p: at([[1, 0, 0]]) },
    });
    rerender({ p: target });
    expect(result.current).toBe(target);
  });
});
