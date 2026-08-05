import { describe, expect, it } from "vitest";
import { OPENINGS, keysOf } from "../openings";
import { plan, remaining, step, STEP_MS, type Sequence } from "./sequence";

const KEYS = ["ott770315", "ott688328", "ott554297", "ott721252"];

function armed(over: Partial<Sequence> = {}): Sequence {
  return { keys: KEYS, drawn: 1, since: 0, settled: false, ...over };
}

/** Everything resolved. The ordinary case once `/v1/paths` has answered. */
const all = () => true;
/** Nothing resolved. A cold container, or a cache that has never seen these. */
const none = () => false;

/**
 * A driver with the store's shape and none of its React: the same loop
 * `useTree` runs, so what these tests pin is the composition of `plan`, `step`
 * and `remaining` rather than three functions in isolation.
 *
 * `arrivals` says when each key's path lands. `cutAt` is the interaction —
 * `stop` is the wall-clock moment somebody presses something.
 */
function run(opts: {
  keys?: readonly string[];
  reduced?: boolean;
  arrivals?: Record<string, number>;
  settleAt?: number;
  cutAfter?: number;
  until?: number;
}): { drawn: string[]; at: number[]; cut: boolean } {
  const keys = opts.keys ?? KEYS;
  const arrivals = opts.arrivals ?? Object.fromEntries(keys.map((k) => [k, 0]));
  const settleAt = opts.settleAt ?? 0;
  const until = opts.until ?? 60_000;

  const p = plan(keys, opts.reduced ?? false);
  const drawn = [...p.first];
  const at = p.first.map(() => 0);
  if (p.rest.length === 0) return { drawn, at, cut: false };

  let seq: Sequence | null = {
    keys,
    drawn: p.first.length,
    since: 0,
    settled: false,
  };
  // One millisecond at a time, which is what a real clock does and what makes
  // "waits on its path" distinguishable from "waits 1300ms".
  for (let now = 0; now <= until; now++) {
    if (seq === null) break;
    if (opts.cutAfter !== undefined && now === opts.cutAfter) {
      for (const k of remaining(seq)) {
        drawn.push(k);
        at.push(now);
      }
      return { drawn, at, cut: true };
    }
    if (now >= settleAt) seq = { ...seq, settled: true };
    const next = step(seq, now, (k) => now >= (arrivals[k] ?? Infinity));
    if (next.kind === "done") {
      seq = null;
      break;
    }
    if (next.kind === "draw") {
      drawn.push(next.key);
      at.push(now);
      seq = { ...seq, drawn: seq.drawn + 1, since: now };
    }
  }
  return { drawn, at, cut: false };
}

/**
 * Rule 3. Reduced motion is the *single* `open()` this feature replaced, not a
 * faster sequence — and `plan` is the only place that is decided, so a caller
 * cannot get it half right.
 */
describe("prefers-reduced-motion", () => {
  it("puts every taxon in the opening press, leaving nothing to sequence", () => {
    const p = plan(KEYS, true);
    expect(p.first).toEqual(KEYS);
    expect(p.rest).toEqual([]);
  });

  it("draws the whole set at once, at t=0", () => {
    const r = run({ reduced: true });
    expect(r.drawn).toEqual(KEYS);
    expect(r.at).toEqual([0, 0, 0, 0]);
  });

  it("sequences one taxon at a time otherwise", () => {
    const p = plan(KEYS, false);
    expect(p.first).toEqual([KEYS[0]]);
    expect(p.rest).toEqual(KEYS.slice(1));
  });

  /**
   * An opening of one has no ordering to show and no nesting to prove, so it
   * takes the same path as reduced motion. `openings.test.ts` already refuses
   * to ship one, which is why this is stated here rather than relied on there.
   */
  it("does not sequence an opening too short to have an argument", () => {
    expect(plan(["ott770315"], false).rest).toEqual([]);
    expect(plan([], false).rest).toEqual([]);
  });
});

/**
 * Rule 1, and the one worth the most: **a step waits on its lineage, not on the
 * clock.** Every assertion here would pass a wall-clock implementation except
 * the ones that hold a path back, which is exactly the failure the rule exists
 * to prevent — a canvas running ahead of the data it is drawing.
 */
describe("a step waits on its path", () => {
  it("holds indefinitely while the path is out, however long it has waited", () => {
    const s = step(armed(), STEP_MS * 100, none);
    expect(s.kind).toBe("hold");
    // Nothing to time. The arrival is the wake-up, so arming a timer here would
    // be polling for something a state change already reports.
    expect(s.kind === "hold" && s.after).toBe(null);
  });

  it("holds for what is left of the floor once the path is in", () => {
    const s = step(armed(), 300, all);
    expect(s.kind).toBe("hold");
    expect(s.kind === "hold" && s.after).toBe(STEP_MS - 300);
  });

  it("draws when both are true", () => {
    expect(step(armed(), STEP_MS, all)).toEqual({ kind: "draw", key: KEYS[1] });
  });

  it("asks about the next key, not about the set", () => {
    const seq = armed({ drawn: 2 });
    const s = step(seq, STEP_MS, (k) => k === KEYS[1]);
    // KEYS[1] is already drawn and its path is the one that has landed; the
    // step being held is KEYS[2]'s.
    expect(s).toEqual({ kind: "hold", key: KEYS[2], after: null });
  });

  it("delays the sequence on a cold cache rather than outrunning it", () => {
    const r = run({
      arrivals: {
        [KEYS[0]!]: 0,
        [KEYS[1]!]: 4000,
        [KEYS[2]!]: 4000,
        [KEYS[3]!]: 4000,
      },
      settleAt: 4000,
    });
    expect(r.drawn).toEqual(KEYS);
    // The second taxon lands with its path and not at the floor, and the rest
    // pace out behind it. A wall-clock sequence would have drawn all three
    // before any of them had a lineage.
    expect(r.at).toEqual([0, 4000, 4000 + STEP_MS, 4000 + STEP_MS * 2]);
  });

  it("paces on the floor when everything is already resident", () => {
    expect(run({}).at).toEqual([0, STEP_MS, STEP_MS * 2, STEP_MS * 3]);
  });

  /**
   * A key that resolves to nothing never appears in `paths`, so arrival alone
   * would stall the sequence for ever on one stale id. Once the batch has
   * answered, absent is absent — and the step goes through to draw nothing,
   * which is what a single `open()` of the same set does today.
   */
  it("does not stall on a key that never resolves", () => {
    const r = run({
      arrivals: { [KEYS[0]!]: 0, [KEYS[1]!]: 0, [KEYS[3]!]: 0 },
      settleAt: 900,
    });
    // KEYS[2] never arrives and costs the sequence nothing: once the batch has
    // settled the floor is the only gate left, so the run paces out exactly as
    // if every lineage were resident.
    expect(r.drawn).toEqual(KEYS);
    expect(r.at).toEqual([0, STEP_MS, STEP_MS * 2, STEP_MS * 3]);
  });

  it("is finished once every key is drawn", () => {
    expect(step(armed({ drawn: KEYS.length }), 10_000, all)).toEqual({
      kind: "done",
    });
  });
});

/**
 * Rule 2. Any interaction ends it, immediately, **at the finished tree** — the
 * reader interrupted the telling of the argument, not the argument. Half an
 * opening left on the canvas would answer "are you a fish?" with two species
 * and no shark.
 */
describe("an interaction ends the sequence", () => {
  it("draws every remaining taxon, in one beat", () => {
    const r = run({ cutAfter: 1500 });
    expect(r.cut).toBe(true);
    expect(r.drawn).toEqual(KEYS);
    expect(r.at).toEqual([0, STEP_MS, 1500, 1500]);
  });

  it("finishes the tree even when cut before the first step", () => {
    const r = run({ cutAfter: 10 });
    expect(r.drawn).toEqual(KEYS);
  });

  it("names exactly the undrawn keys, in order", () => {
    expect(remaining(armed())).toEqual(KEYS.slice(1));
    expect(remaining(armed({ drawn: 3 }))).toEqual(KEYS.slice(3));
    expect(remaining(armed({ drawn: KEYS.length }))).toEqual([]);
  });
});

/**
 * The reason the feature exists: `openings.ts` authors its taxa in a deliberate
 * order — the pair that makes the point first, the taxon that loses the
 * argument last, the rulers after that — and drawing the set at once discarded
 * it. The running order is the authored order, unreversed and unsorted.
 */
describe("the authored order is the running order", () => {
  it("steps every opening through its own taxa in file order", () => {
    for (const o of OPENINGS) {
      const keys = keysOf(o);
      expect(run({ keys }).drawn, o.id).toEqual(keys);
    }
  });

  it("opens on the taxon the file put first", () => {
    for (const o of OPENINGS) {
      expect(plan(keysOf(o), false).first, o.id).toEqual([o.taxa[0]!.key]);
    }
  });
});
