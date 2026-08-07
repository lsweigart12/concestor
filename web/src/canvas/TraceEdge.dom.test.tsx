/**
 * A draw belongs to its token, not to its geometry.
 *
 * The tree rearranges when a taxon is added — every branch already on the
 * canvas moves — and `d` was in this effect's dependency array, so every one of
 * them re-ran it. A branch that had already finished drawing re-armed from
 * `stroke-dashoffset: len` and drew itself on again: it vanished and came back,
 * once, exactly as the reflow began. Nothing else about the branch changed, and
 * nothing in the DOM said so, which is what made it hard to see.
 */
import { Position } from "@xyflow/react";
import { render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TIER_MEASURED } from "../api";
import { TraceEdge, type TraceEdgeData } from "./TraceEdge";

const ELBOW = "M 0 0 L 0 40 Q 0 49 9 49 L 80 49";
const MOVED = "M 0 0 L 0 60 Q 0 69 9 69 L 80 69";

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

let animate: ReturnType<typeof vi.fn>;

beforeEach(() => {
  // jsdom has neither, and both are load-bearing here. It also does not expose
  // `SVGPathElement` as a global, so the prototype is reached through an
  // element rather than named.
  const proto = Object.getPrototypeOf(
    document.createElementNS("http://www.w3.org/2000/svg", "path"),
  ) as { getTotalLength?: () => number };
  proto.getTotalLength = () => 100;
  // jsdom implements no Web Animations API at all, so this is an assignment
  // rather than a spy — there is nothing there to spy on.
  animate = vi.fn(() => ({
    cancel: vi.fn(),
    finished: Promise.resolve(),
  }));
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
    // Two dash animations (core and halo) and the group's decay.
    expect(animate).toHaveBeenCalledTimes(3);
  });

  /**
   * The regression. Same token, new geometry: the branch is being *moved*, not
   * redrawn, and re-arming would hide a line the reader is already looking at.
   */
  it("does not re-arm when the branch moves under it", () => {
    const { rerender } = render(draw(data()));
    animate.mockClear();
    rerender(draw(data({ d: MOVED })));
    expect(animate).not.toHaveBeenCalled();
  });

  it("arms again for a new token, which is a real second draw", () => {
    const { rerender } = render(draw(data()));
    animate.mockClear();
    rerender(draw(data({ drawToken: 2 })));
    expect(animate).toHaveBeenCalledTimes(3);
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
