/**
 * The rearrangement, as arithmetic. What the hook adds is a clock, and what it
 * is doing with these is the whole of the behaviour: `moved` decides there is
 * anything to animate, `easeReflow` shapes it, `tweenPlaced` produces the
 * frame.
 */
import { describe, expect, it } from "vitest";
import type { PathNode } from "../api";
import type { Placed } from "../tree/layout";
import { decl } from "../test/css";
import {
  easeReflow,
  moved,
  REFLOW_BEZIER,
  REFLOW_MS,
  tweenPlaced,
} from "./reflow";

const node = { idx: 0 } as unknown as PathNode;

function at(entries: [number, number, number][]): Map<number, Placed> {
  return new Map(
    entries.map(([idx, x, y]) => [
      idx,
      { idx, x, y, node, isLeaf: true, isMRCA: false, hue: 200 },
    ]),
  );
}

describe("moved", () => {
  it("sees a node that shifted", () => {
    expect(moved(at([[1, 0, 0]]), at([[1, 0, 40]]))).toBe(true);
  });

  it("ignores a jitter below the epsilon", () => {
    expect(moved(at([[1, 0, 0]]), at([[1, 0.2, 0.2]]))).toBe(false);
  });

  /**
   * The common case by far, and the one that has to be free: adding a taxon
   * whose row goes below everything already drawn moves nothing. A tween armed
   * here would cost a rebuild of every node and edge per frame for nothing.
   */
  it("is false when only new nodes appeared", () => {
    expect(
      moved(
        at([[1, 0, 0]]),
        at([
          [1, 0, 0],
          [2, 30, 40],
        ]),
      ),
    ).toBe(false);
  });

  it("is false when a node went away", () => {
    expect(
      moved(
        at([
          [1, 0, 0],
          [2, 30, 40],
        ]),
        at([[1, 0, 0]]),
      ),
    ).toBe(false);
  });
});

/**
 * The two halves of the rearrangement move on one curve for one duration, and
 * only one of them is in this module — the marks glide on a CSS `transition`
 * because React Flow drops every edge if its node array is churned per frame.
 * A dot is the end of a line: eased differently, the branch would come away
 * from the mark it arrives at, halfway through. So the stylesheet is read.
 */
describe("the stylesheet moves the marks on the same curve", () => {
  it("uses this module's duration and bezier", () => {
    const t = decl(".react-flow__node", "transition");
    expect(t).toContain(`${REFLOW_MS}ms`);
    expect(t).toContain(`cubic-bezier(${REFLOW_BEZIER.join(", ")})`);
  });
});

describe("easeReflow", () => {
  it("runs 0 to 1", () => {
    expect(easeReflow(0)).toBe(0);
    expect(easeReflow(1)).toBe(1);
  });

  it("front-loads: half the time is most of the distance", () => {
    expect(easeReflow(0.5)).toBeGreaterThan(0.8);
  });

  it("clamps rather than overshooting, so a late frame cannot pass the target", () => {
    expect(easeReflow(1.4)).toBe(1);
    expect(easeReflow(-0.2)).toBe(0);
  });
});

describe("tweenPlaced", () => {
  it("is the old arrangement at 0 and the new one at 1", () => {
    const from = at([[1, 0, 0]]);
    const to = at([[1, 100, 50]]);
    expect(tweenPlaced(from, to, 0).get(1)).toMatchObject({ x: 0, y: 0 });
    expect(tweenPlaced(from, to, 1).get(1)).toMatchObject({ x: 100, y: 50 });
  });

  it("interpolates both axes", () => {
    const t = tweenPlaced(at([[1, 0, 0]]), at([[1, 100, 50]]), 0.25);
    expect(t.get(1)).toMatchObject({ x: 25, y: 12.5 });
  });

  /**
   * A node that did not exist a moment ago has nowhere to come from, and must
   * not be given one: it is invisible until its own line reaches it, so sliding
   * it in from the origin would put a mark on screen early and in the wrong
   * place.
   */
  it("places a node the old layout never had, rather than tweening it", () => {
    const t = tweenPlaced(at([[1, 0, 0]]), at([[2, 80, 90]]), 0.1);
    expect(t.get(2)).toMatchObject({ x: 80, y: 90 });
  });

  /**
   * Identity, not a copy, once it is over. Every memo downstream keys on this
   * map, so a fresh object on the settling frame would rebuild every node and
   * edge one last time for positions that did not change.
   */
  it("hands back the target itself when finished", () => {
    const to = at([[1, 100, 50]]);
    expect(tweenPlaced(at([[1, 0, 0]]), to, 1)).toBe(to);
  });

  it("carries everything else on the node through untouched", () => {
    const to = at([[1, 100, 50]]);
    const t = tweenPlaced(at([[1, 0, 0]]), to, 0.5).get(1)!;
    expect(t.hue).toBe(200);
    expect(t.isLeaf).toBe(true);
    expect(t.node).toBe(node);
  });
});
