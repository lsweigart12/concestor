/**
 * A draw belongs to its token; the dash belongs to the geometry.
 *
 * Both halves are regressions, in opposite directions, and they are why the
 * effect distinguishes "a new draw" from "the same draw, moved".
 *
 * `d` was in the effect's dependency array, so a reflow — which moves every
 * branch on the canvas — re-ran it, and a branch that had already finished
 * drawing re-armed from `stroke-dashoffset: len` and drew itself on again. It
 * vanished and came back, once, exactly as the reflow began.
 *
 * So `d` was removed, and the dash was then cut once for a length the branch
 * did not keep. `stroke-dasharray` is a length: on a path longer than the one
 * it was cut for, the overhang is a visible segment standing on screen before
 * anything has drawn. A tree loading with a fossil in the URL does exactly
 * that — the fossil resolves on its own fetch, takes a row, and reflows a tree
 * that is midway through drawing itself on.
 */
import { Position } from "@xyflow/react";
import { render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TIER_MEASURED } from "../api";
import { TraceEdge, type TraceEdgeData } from "./TraceEdge";

const ELBOW = "M 0 0 L 0 40 Q 0 49 9 49 L 80 49";
const MOVED = "M 0 0 L 0 60 Q 0 69 9 69 L 80 69";

/** What each shape measures, so a re-cut dash can be told from a stale one. */
const LENGTH: Record<string, number> = { [ELBOW]: 100, [MOVED]: 140 };

function data(over: Partial<TraceEdgeData> = {}): TraceEdgeData {
  return {
    d: ELBOW,
    hue: 200,
    tier: TIER_MEASURED,
    dim: false,
    unbounded: false,
    drilled: false,
    attachment: false,
    drawToken: 1,
    delay: 0,
    reduced: false,
    biolum: false,
    ...over,
  };
}

interface Fake {
  cancel: ReturnType<typeof vi.fn>;
  finished: Promise<void>;
  currentTime: number;
}

let animate: ReturnType<typeof vi.fn>;
let made: Fake[];

/** The animations for the dash — the two the group's settle is not among. */
const dashCalls = () =>
  animate.mock.calls.filter(
    (c) =>
      (c[0] as { strokeDashoffset?: number }[])[0]?.strokeDashoffset !==
      undefined,
  );

/** The length a dash animation was cut for. */
const cutFor = (call: unknown[]) =>
  (call[0] as { strokeDashoffset: number }[])[0]?.strokeDashoffset;

beforeEach(() => {
  // jsdom has neither, and both are load-bearing here. It also does not expose
  // `SVGPathElement` as a global, so the prototype is reached through an
  // element rather than named.
  const proto = Object.getPrototypeOf(
    document.createElementNS("http://www.w3.org/2000/svg", "path"),
  ) as { getTotalLength?: () => number };
  proto.getTotalLength = function (this: Element) {
    return LENGTH[this.getAttribute("d") ?? ""] ?? 0;
  };
  // jsdom implements no Web Animations API at all, so this is an assignment
  // rather than a spy — there is nothing there to spy on.
  made = [];
  animate = vi.fn(() => {
    const a: Fake = {
      cancel: vi.fn(),
      finished: Promise.resolve(),
      currentTime: 0,
    };
    made.push(a);
    return a;
  });
  (Element.prototype as unknown as { animate: unknown }).animate = animate;
});

afterEach(() => {
  vi.restoreAllMocks();
  delete (Element.prototype as unknown as { animate?: unknown }).animate;
});

const draw = (props: TraceEdgeData) => (
  <svg>
    <TraceEdge
      id="a-b"
      source="a"
      target="b"
      sourceX={0}
      sourceY={0}
      targetX={80}
      targetY={49}
      sourcePosition={Position.Right}
      targetPosition={Position.Left}
      data={props as unknown as Record<string, unknown>}
    />
  </svg>
);

describe("the draw-on", () => {
  it("arms once for a token", () => {
    render(draw(data()));
    // Two dash animations (core and halo) and the group's settle.
    expect(animate).toHaveBeenCalledTimes(3);
    expect(dashCalls().map(cutFor)).toEqual([100, 100]);
  });

  /**
   * The second regression. A dash cut for 100 on a path of 140 leaves 40 units
   * of visible stroke from the first frame — the fragments the reader sees
   * standing on the canvas before the draw has begun.
   */
  it("re-cuts the dash to the length the branch now has", () => {
    const { rerender } = render(draw(data()));
    animate.mockClear();
    rerender(draw(data({ d: MOVED })));
    expect(dashCalls().map(cutFor)).toEqual([140, 140]);
  });

  /**
   * The first regression, and the reason a move may not simply re-arm: the
   * branch is being *moved*, not redrawn, so it carries on from where the
   * reader was watching it.
   */
  it("keeps the clock when the branch moves under it", () => {
    const { rerender } = render(draw(data()));
    for (const a of made) a.currentTime = 420;
    animate.mockClear();
    made.length = 0;
    rerender(draw(data({ d: MOVED })));
    expect(made.map((a) => a.currentTime)).toEqual([420, 420]);
  });

  /** The settle is a separate effect precisely so a move cannot interrupt it. */
  it("does not restart the settle when the branch moves", () => {
    const { rerender } = render(draw(data()));
    const settle =
      made[
        animate.mock.calls.findIndex(
          (c) => "filter" in ((c[0] as object[])[0] ?? {}),
        )
      ]!;
    animate.mockClear();
    rerender(draw(data({ d: MOVED })));
    expect(animate).toHaveBeenCalledTimes(2);
    expect(settle.cancel).not.toHaveBeenCalled();
  });

  /** A branch that has arrived is never redrawn because something moved it. */
  it("does not re-arm once the line has arrived", async () => {
    const { rerender } = render(draw(data()));
    // `finished` is already resolved; let its continuation run.
    await Promise.resolve();
    animate.mockClear();
    rerender(draw(data({ d: MOVED })));
    expect(animate).not.toHaveBeenCalled();
  });

  it("arms again for a new token, which is a real second draw", async () => {
    const { rerender } = render(draw(data()));
    await Promise.resolve();
    animate.mockClear();
    made.length = 0;
    rerender(draw(data({ drawToken: 2 })));
    expect(animate).toHaveBeenCalledTimes(3);
    // From the start, not from wherever the first draw had got to.
    expect(made.every((a) => a.currentTime === 0)).toBe(true);
  });

  /**
   * A settled branch never arms at all. `null` is what `Graph.tsx` gives every
   * branch outside the current delta, which during a reflow is most of them.
   */
  it("never arms a branch with no token", () => {
    const { rerender } = render(draw(data({ drawToken: null })));
    expect(animate).not.toHaveBeenCalled();
    rerender(draw(data({ drawToken: null, d: MOVED })));
    expect(animate).not.toHaveBeenCalled();
  });
});
