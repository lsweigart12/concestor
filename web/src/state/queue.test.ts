import { describe, expect, it } from "vitest";
import { releasable } from "./queue";

const KEYS = ["ott770315", "ott688328", "ott554297", "ott721252"];

/** Everything resolved. The ordinary case once `/v1/paths` has answered. */
const all = () => true;
/** Nothing resolved. A cold container, or a cache that has never seen these. */
const none = () => false;

/**
 * A driver with the store's shape and none of its React, so what these tests
 * pin is `releasable` in a loop rather than one call of it.
 *
 * **There is no clock in here**, and that is the point of the design it
 * exercises: the loop advances when a draw *lands*, which is what `Graph.tsx`
 * reports and what `landAfter` stands in for.
 *
 * `arrivals` says at which tick each key's path lands.
 */
function run(opts: {
  keys?: readonly string[];
  /** Tick at which each key's lineage arrives. Absent means never. */
  arrivals?: Record<string, number>;
  /** Ticks a draw takes to land. Default 1: one turn of the loop. */
  landAfter?: number;
  until?: number;
}): { drawn: string[]; at: number[] } {
  const keys = opts.keys ?? KEYS;
  const arrivals = opts.arrivals ?? Object.fromEntries(keys.map((k) => [k, 0]));
  const landAfter = opts.landAfter ?? 1;
  const until = opts.until ?? 1000;

  const drawn: string[] = [];
  const at: number[] = [];
  let queue = [...keys];
  let drawingSince: number | null = null;

  for (let now = 0; now <= until; now++) {
    if (drawingSince !== null && now - drawingSince >= landAfter) {
      drawingSince = null;
    }
    if (queue.length === 0 && drawingSince === null) break;
    const head = releasable(
      queue,
      drawingSince !== null,
      (k) => now >= (arrivals[k] ?? Infinity),
    );
    if (head === null) continue;
    queue = queue.slice(1);
    drawn.push(head);
    at.push(now);
    drawingSince = now;
  }
  return { drawn, at };
}

/**
 * **A taxon waits on its lineage, and then on the canvas.** Arrival is the gate
 * and the draw is the pace, in that order, so a cold cache delays the queue
 * rather than desynchronising it from what is on screen.
 */
describe("releasable", () => {
  it("holds while the path is out, however long it has waited", () => {
    expect(releasable(KEYS, false, none)).toBe(null);
  });

  it("holds while the canvas is mid-draw, however resolved the path is", () => {
    expect(releasable(KEYS, true, all)).toBe(null);
  });

  it("releases the head when both are true", () => {
    expect(releasable(KEYS, false, all)).toBe(KEYS[0]);
  });

  it("asks about the head, not about the set", () => {
    // The second key's path is the one that has landed; the head's has not.
    expect(releasable(KEYS, false, (k) => k === KEYS[1])).toBe(null);
  });

  it("has nothing to release from an empty queue", () => {
    expect(releasable([], false, all)).toBe(null);
  });
});

describe("the queue drains", () => {
  it("draws one taxon per landing, in the order it was given", () => {
    const r = run({});
    expect(r.drawn).toEqual(KEYS);
    expect(r.at).toEqual([0, 1, 2, 3]);
  });

  /**
   * The property a `STEP_MS` floor could not have: the pace *is* the
   * animation's. A slower draw spaces the taxa further apart with nothing
   * restated anywhere.
   */
  it("follows the draw's own pace rather than a constant", () => {
    expect(run({ landAfter: 7 }).at).toEqual([0, 7, 14, 21]);
    expect(run({ landAfter: 20 }).at).toEqual([0, 20, 40, 60]);
  });

  it("delays on a cold cache rather than outrunning it", () => {
    const r = run({
      arrivals: {
        [KEYS[0]!]: 0,
        [KEYS[1]!]: 40,
        [KEYS[2]!]: 40,
        [KEYS[3]!]: 40,
      },
      landAfter: 5,
    });
    expect(r.drawn).toEqual(KEYS);
    // The second taxon lands with its path, and the rest pace out behind it. A
    // wall-clock queue would have drawn all three before any had a lineage.
    expect(r.at).toEqual([0, 40, 45, 50]);
  });

  /**
   * A key that resolves to nothing never appears in `paths`, so arrival alone
   * would stall the queue for ever on one stale id. The store answers this with
   * its `answered` set — once we have asked, absent is absent — and the step
   * goes through to draw nothing, which is what adding it directly would do.
   */
  it("does not stall on a key that never resolves", () => {
    const r = run({
      arrivals: { [KEYS[0]!]: 0, [KEYS[1]!]: 0, [KEYS[3]!]: 0 },
      until: 40,
    });
    // KEYS[2] never arrives and blocks everything behind it, which is exactly
    // why the store's gate is "answered", not "resolved".
    expect(r.drawn).toEqual([KEYS[0], KEYS[1]]);
  });
});
