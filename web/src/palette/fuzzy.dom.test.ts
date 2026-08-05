/**
 * The persistence half of `fuzzy.ts`, which needs a `localStorage` and so lives
 * in the `dom` project — `*.dom.test.ts` is the door `vitest.config.ts` opens
 * for a module test that renders nothing but wants a document anyway.
 *
 * The pure scoring functions are next door in `fuzzy.test.ts` and stay in node.
 *
 * Every test here goes through the real `localStorage` rather than around it,
 * because the bug being guarded lives in the *boundary*: what comes back out of
 * storage is a string this app did not necessarily write, and the whole failure
 * is that the module used to believe it.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const KEY = "concestor.usage.v1";
const DAY = 86_400_000;

/**
 * Seed storage, then import the module fresh.
 *
 * `fuzzy.ts` reads storage exactly once, at module scope, which is correct — a
 * ranking table re-read on every keystroke would be a synchronous parse per
 * frame. It does mean a test cannot arrange the stored value after importing,
 * so `vi.resetModules()` is doing the real work here and every test has to
 * import through this helper rather than at the top of the file.
 */
async function withStored(raw: string | null): Promise<typeof import("./fuzzy")> {
  localStorage.clear();
  if (raw !== null) localStorage.setItem(KEY, raw);
  vi.resetModules();
  return await import("./fuzzy");
}

function stored(): Record<string, { count: number; last: number }> {
  return JSON.parse(localStorage.getItem(KEY) ?? "{}") as Record<
    string,
    { count: number; last: number }
  >;
}

beforeEach(() => {
  localStorage.clear();
});

/**
 * The failure the whole file exists for.
 *
 * A malformed entry made `days` NaN, `recency` NaN and the boost NaN, and NaN
 * in `b.score - a.score` compares as *equal* instead of throwing. So the row
 * did not merely sort to the wrong place — it stopped the rows around it
 * sorting at all, because a comparator that answers "equal" to everything
 * partitions the list at that element. The symptom is search results in subtly
 * the wrong order with nothing in any log, which is close to undiagnosable
 * from the outside.
 */
describe("a malformed stored entry cannot poison the ranking", () => {
  const malformed: [string, string][] = [
    ["a half-written entry with no `last`", '{"n:5":{"count":3}}'],
    ["an entry with no `count`", `{"n:5":{"last":${Date.now()}}}`],
    ["a number where an entry should be", '{"n:5":7}'],
    ["a string where an entry should be", '{"n:5":"three"}'],
    ["a null entry", '{"n:5":null}'],
    ["an array entry", '{"n:5":[1,2]}'],
    ["stringified numbers", '{"n:5":{"count":"3","last":"1754300000000"}}'],
    ["a null `last`", '{"n:5":{"count":3,"last":null}}'],
    ["a NaN that survived a round trip as null", '{"n:5":{"count":null,"last":null}}'],
  ];

  for (const [what, raw] of malformed) {
    it(`ignores ${what}`, async () => {
      const { sessionBoost } = await withStored(raw);
      expect(sessionBoost("n:5")).toBe(0);
    });
  }

  const unusable: [string, string][] = [
    ["a stored null", "null"],
    ["a stored array", "[1,2,3]"],
    ["a stored number", "3"],
    ["a stored string", '"nonsense"'],
    ["truncated JSON", '{"n:5":{"count":3,"la'],
    ["an empty value", ""],
  ];

  for (const [what, raw] of unusable) {
    it(`survives ${what}`, async () => {
      const { sessionBoost } = await withStored(raw);
      // `null` is the sharp one: it parses cleanly and then every read throws
      // on property access, so the palette would not have ranked wrongly — it
      // would not have rendered.
      expect(() => sessionBoost("n:5")).not.toThrow();
      expect(sessionBoost("n:5")).toBe(0);
    });
  }

  it("keeps the good entries beside a bad one", async () => {
    const now = Date.now();
    const { sessionBoost } = await withStored(
      JSON.stringify({
        "n:1": { count: 4, last: now },
        "n:2": { count: 3 },
        "n:3": { count: 1, last: now },
      }),
    );
    // Entry-wise rather than blob-wise: one bad row is not a reason to forget
    // everything this browser has learned about its reader.
    expect(sessionBoost("n:1")).toBeGreaterThan(sessionBoost("n:3"));
    expect(sessionBoost("n:2")).toBe(0);
  });

  it("leaves a section sortable, which is the visible symptom", async () => {
    const now = Date.now();
    const { sessionBoost } = await withStored(
      JSON.stringify({
        "n:top": { count: 9, last: now },
        "n:bad": { count: 3 },
        "n:mid": { count: 1, last: now },
      }),
    );
    // Exactly Palette.tsx's `list.sort((a, b) => b.score - a.score)`, and the
    // order below is the one it produced before this was fixed: `top`, worth
    // more than either of the others, sorted *last*.
    const rows = [
      { id: "n:mid", score: 50 + sessionBoost("n:mid") },
      { id: "n:bad", score: 50 + sessionBoost("n:bad") },
      { id: "n:top", score: 50 + sessionBoost("n:top") },
    ];
    rows.sort((a, b) => b.score - a.score);
    expect(rows.map((r) => r.id)).toEqual(["n:top", "n:mid", "n:bad"]);
  });
});

/**
 * A `last` in the future is a fact about the reader's clock, not their reading.
 *
 * It passes every shape check there is — it is a perfectly finite number — so
 * validation cannot catch it and the clamp in the decay has to. Unclamped, a
 * timestamp a year ahead is worth 29 million points against a real entry's 208,
 * which pins that one row to the top of every search until the date passes; far
 * enough ahead and `2 ** big` is `Infinity`, and `Infinity - Infinity` is NaN,
 * which lands back in the bug above. This is the same shape as the negative
 * `now - lastClosed` that `Tooltip.test.tsx` had to coldStart around.
 */
describe("a clock that disagrees", () => {
  it("does not let a future timestamp outrank a fresh entry", async () => {
    const now = Date.now();
    const { sessionBoost } = await withStored(
      JSON.stringify({
        "n:future": { count: 1, last: now + 400 * DAY },
        "n:now": { count: 12, last: now },
      }),
    );
    expect(Number.isFinite(sessionBoost("n:future"))).toBe(true);
    expect(sessionBoost("n:future")).toBeLessThan(sessionBoost("n:now"));
  });

  it("does not produce Infinity from a wildly future timestamp", async () => {
    const { sessionBoost } = await withStored(
      JSON.stringify({ "n:1": { count: 1, last: Date.now() + 40_000 * DAY } }),
    );
    expect(Number.isFinite(sessionBoost("n:1"))).toBe(true);
  });
});

describe("the boost itself", () => {
  it("rises with count and falls with age", async () => {
    const now = Date.now();
    const { sessionBoost } = await withStored(
      JSON.stringify({
        "n:often": { count: 8, last: now },
        "n:once": { count: 1, last: now },
        "n:old": { count: 8, last: now - 42 * DAY },
      }),
    );
    expect(sessionBoost("n:often")).toBeGreaterThan(sessionBoost("n:once"));
    expect(sessionBoost("n:often")).toBeGreaterThan(sessionBoost("n:old"));
    expect(sessionBoost("n:old")).toBeGreaterThan(0);
  });

  it("is zero for something never used", async () => {
    const { sessionBoost } = await withStored(null);
    expect(sessionBoost("n:nothing")).toBe(0);
  });
});

describe("recording a use", () => {
  it("persists, and is there on the next visit", async () => {
    const first = await withStored(null);
    first.recordUse("n:7");
    first.recordUse("n:7");
    expect(first.sessionBoost("n:7")).toBeGreaterThan(0);

    // Same storage, fresh module: this is a reload.
    vi.resetModules();
    const second = await import("./fuzzy");
    expect(second.sessionBoost("n:7")).toBeCloseTo(first.sessionBoost("n:7"), 6);
    expect(stored()["n:7"]?.count).toBe(2);
  });

  it("writes only finite numbers, whatever was there before", async () => {
    const { recordUse } = await withStored('{"n:7":{"count":3}}');
    recordUse("n:7");
    const entry = stored()["n:7"];
    expect(entry?.count).toBe(1);
    expect(Number.isFinite(entry?.last)).toBe(true);
  });

  it("clears on resetUsage", async () => {
    const { recordUse, resetUsage, sessionBoost } = await withStored(null);
    recordUse("n:7");
    resetUsage();
    expect(sessionBoost("n:7")).toBe(0);
    expect(localStorage.getItem(KEY)).toBeNull();
  });
});

/**
 * The store is bounded, and it is bounded by a count.
 *
 * The 21-day half-life decays the *score* and never the *key*, so before this
 * the record grew monotonically for the life of the browser profile and every
 * write got slower — a full copy plus a full `JSON.stringify` of the whole
 * history, on the interaction path, once per pick.
 */
describe("the store is capped", () => {
  it("keeps at most MAX_USAGE_ENTRIES, in memory and in storage", async () => {
    const { MAX_USAGE_ENTRIES, recordUse, sessionBoost } = await withStored(null);
    // A day between picks, so the boosts are strictly ordered and which entry
    // the cap drops is not a question about tie-breaking. Recorded live it is:
    // 240 calls land in one or two milliseconds, every boost ties, and the
    // stable sort keeps whichever the loop wrote first — correct, since a tie
    // means neither is worth more, but not something to assert against.
    const start = Date.now();
    try {
      for (let i = 0; i < MAX_USAGE_ENTRIES + 40; i++) {
        vi.setSystemTime(start + i * DAY);
        recordUse(`n:${i}`);
      }
      expect(Object.keys(stored())).toHaveLength(MAX_USAGE_ENTRIES);
      expect(sessionBoost(`n:${MAX_USAGE_ENTRIES + 39}`)).toBeGreaterThan(0);
      expect(sessionBoost("n:0")).toBe(0);
      expect(sessionBoost(`n:39`)).toBe(0);
      expect(sessionBoost(`n:40`)).toBeGreaterThan(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("evicts the entry worth least, not the oldest key", async () => {
    const now = Date.now();
    const { MAX_USAGE_ENTRIES } = await withStored(null);
    const seed: Record<string, { count: number; last: number }> = {
      // Written first, and returned to often: this is the one a
      // first-in-first-out rule would have thrown away.
      "n:treasured": { count: 12, last: now - 2 * DAY },
    };
    for (let i = 0; i < MAX_USAGE_ENTRIES + 40; i++) {
      seed[`n:${i}`] = { count: 1, last: now - 200 * DAY };
    }
    const { sessionBoost } = await withStored(JSON.stringify(seed));
    expect(sessionBoost("n:treasured")).toBeGreaterThan(0);
  });

  it("caps on read as well as on write", async () => {
    const now = Date.now();
    const { MAX_USAGE_ENTRIES } = await withStored(null);
    const seed: Record<string, { count: number; last: number }> = {};
    // Descending recency, so which entries the cap should keep is unambiguous.
    for (let i = 0; i < MAX_USAGE_ENTRIES * 2; i++) {
      seed[`n:${i}`] = { count: 1, last: now - i * DAY };
    }
    // A blob written under a larger cap — or by an older build that had none —
    // is trimmed the moment it is read, on `recent.ts`'s precedent. Without
    // this the store would only ever shrink on a write.
    const { sessionBoost } = await withStored(JSON.stringify(seed));
    expect(sessionBoost("n:0")).toBeGreaterThan(0);
    expect(sessionBoost(`n:${MAX_USAGE_ENTRIES * 2 - 1}`)).toBe(0);
  });
});
