import { describe, expect, it } from "vitest";
import { OPENINGS, keysOf } from "../openings";
import { flush, plan, releasable, type Queued } from "./sequence";

const KEYS = ["ott770315", "ott688328", "ott554297", "ott721252"];

const queued = (keys: readonly string[]): Queued[] =>
  keys.map((key) => ({ key, cause: "sequence" }));

/** Everything resolved. The ordinary case once `/v1/paths` has answered. */
const all = () => true;
/** Nothing resolved. A cold container, or a cache that has never seen these. */
const none = () => false;

/**
 * A driver with the store's shape and none of its React, so what these tests
 * pin is the composition of `plan`, `releasable` and `flush` rather than three
 * functions in isolation.
 *
 * **There is no clock in here**, and that is the point of the design it
 * exercises: the loop advances when a draw *lands*, which is what `Graph.tsx`
 * reports and what `landAfter` stands in for. The version this replaced paced
 * on a `STEP_MS` floor that had to be kept equal to three constants in another
 * file by hand.
 *
 * `arrivals` says at which tick each key's path lands. `cutAfter` is the
 * interaction — the moment somebody presses something.
 */
function run(opts: {
  keys?: readonly string[];
  reduced?: boolean;
  /** Tick at which each key's lineage arrives. Absent means never. */
  arrivals?: Record<string, number>;
  /** Ticks a draw takes to land. Default 1: one turn of the loop. */
  landAfter?: number;
  cutAfter?: number;
  until?: number;
}): { drawn: string[]; at: number[]; cut: boolean } {
  const keys = opts.keys ?? KEYS;
  const arrivals = opts.arrivals ?? Object.fromEntries(keys.map((k) => [k, 0]));
  const landAfter = opts.landAfter ?? 1;
  const until = opts.until ?? 1000;

  const p = plan(keys, opts.reduced ?? false);
  const drawn = [...p.first];
  const at = p.first.map(() => 0);
  if (p.rest.length === 0) return { drawn, at, cut: false };

  let queue = queued(p.rest);
  let drawingSince: number | null = null;

  for (let now = 0; now <= until; now++) {
    if (opts.cutAfter !== undefined && now === opts.cutAfter) {
      for (const k of flush(queue)) {
        drawn.push(k);
        at.push(now);
      }
      return { drawn, at, cut: true };
    }
    if (drawingSince !== null && now - drawingSince >= landAfter) {
      drawingSince = null;
    }
    if (queue.length === 0 && drawingSince === null) break;
    const head = releasable(
      queue,
      drawingSince !== null,
      (k) => now >= (arrivals[k] ?? Infinity),
    );
    if (!head) continue;
    queue = queue.slice(1);
    drawn.push(head.key);
    at.push(now);
    drawingSince = now;
  }
  return { drawn, at, cut: false };
}

/**
 * Rule 2. Reduced motion is the *single* `open()` this feature replaced, not a
 * faster sequence — and `plan` is the only place that is decided, so a caller
 * cannot get it half right.
 */
describe("prefers-reduced-motion", () => {
  it("puts every taxon in the opening press, leaving nothing to queue", () => {
    const p = plan(KEYS, true);
    expect(p.first).toEqual(KEYS);
    expect(p.rest).toEqual([]);
  });

  it("draws the whole set at once, at t=0", () => {
    const r = run({ reduced: true });
    expect(r.drawn).toEqual(KEYS);
    expect(r.at).toEqual([0, 0, 0, 0]);
  });

  it("queues one taxon at a time otherwise", () => {
    const p = plan(KEYS, false);
    expect(p.first).toEqual([KEYS[0]]);
    expect(p.rest).toEqual(KEYS.slice(1));
  });

  /**
   * An opening of one has no ordering to show and no nesting to prove, so it
   * takes the same path as reduced motion. `openings.test.ts` already refuses
   * to ship one, which is why this is stated here rather than relied on there.
   */
  it("does not queue an opening too short to have an argument", () => {
    expect(plan(["ott770315"], false).rest).toEqual([]);
    expect(plan([], false).rest).toEqual([]);
  });
});

/**
 * Rule 1: **a taxon waits on its lineage, and then on the canvas.** Arrival is
 * the gate and the draw is the pace, in that order, so a cold cache delays the
 * queue rather than desynchronising it from what is on screen.
 */
describe("releasable", () => {
  it("holds while the path is out, however long it has waited", () => {
    expect(releasable(queued(KEYS), false, none)).toBe(null);
  });

  it("holds while the canvas is mid-draw, however resolved the path is", () => {
    expect(releasable(queued(KEYS), true, all)).toBe(null);
  });

  it("releases the head when both are true", () => {
    expect(releasable(queued(KEYS), false, all)).toEqual({
      key: KEYS[0],
      cause: "sequence",
    });
  });

  it("asks about the head, not about the set", () => {
    // The second key's path is the one that has landed; the head's has not.
    expect(releasable(queued(KEYS), false, (k) => k === KEYS[1])).toBe(null);
  });

  it("has nothing to release from an empty queue", () => {
    expect(releasable([], false, all)).toBe(null);
  });
});

describe("the queue drains", () => {
  it("draws one taxon per landing, in the opening's order", () => {
    const r = run({});
    expect(r.drawn).toEqual(KEYS);
    expect(r.at).toEqual([0, 0, 1, 2]);
  });

  /**
   * The property the `STEP_MS` version could not have: the pace *is* the
   * animation's. A slower draw spaces the taxa further apart with nothing
   * restated anywhere, where before it desynchronised the two.
   */
  it("follows the draw's own pace rather than a constant", () => {
    expect(run({ landAfter: 7 }).at).toEqual([0, 0, 7, 14]);
    expect(run({ landAfter: 20 }).at).toEqual([0, 0, 20, 40]);
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

/**
 * Rule 1 of the two that survived: any interaction ends it at the *finished*
 * tree. The reader interrupted the telling, not the argument.
 */
describe("flush", () => {
  it("returns everything still waiting, in order", () => {
    expect(flush(queued(KEYS.slice(1)))).toEqual(KEYS.slice(1));
  });

  it("is empty once the queue has drained", () => {
    expect(flush([])).toEqual([]);
  });

  /**
   * The queue is fed by `R`, by the palette and by an opening at once, and
   * `enqueue` refuses a duplicate — but this is the last line of defence, and a
   * key added twice would spend a whole beat drawing nothing.
   */
  it("collapses a key queued twice", () => {
    expect(flush(queued([KEYS[1]!, KEYS[2]!, KEYS[1]!]))).toEqual([
      KEYS[1],
      KEYS[2],
    ]);
  });

  it("draws the whole remainder at the moment of the interruption", () => {
    const r = run({ landAfter: 20, cutAfter: 5 });
    expect(r.cut).toBe(true);
    expect(r.drawn).toEqual(KEYS);
    // The first two landed on their own; the rest arrive together, on the press.
    expect(r.at).toEqual([0, 0, 5, 5]);
  });
});

/**
 * Every shipped opening survives the queue: the whole set lands, in the order
 * `openings.ts` wrote it. Read from the real table rather than a fixture,
 * because the ordering is the opening's own argument.
 */
describe("every opening", () => {
  it("draws its taxa in order, one at a time", () => {
    for (const o of OPENINGS) {
      const keys = keysOf(o);
      const r = run({ keys, landAfter: 3 });
      expect(r.drawn, o.id).toEqual([...keys]);
    }
  });
});
