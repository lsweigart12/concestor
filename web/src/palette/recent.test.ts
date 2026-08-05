/**
 * The recents band, and the one failure it exists to prevent.
 *
 * Storing whole rows rather than keys is what makes this band draw on the first
 * frame with no request — and it is also what makes it capable of being
 * *confidently wrong*. `idx` and `tip_count` belong to one build; a rebuilt
 * dataset renumbers them, and an old `idx` resolves cleanly against the new one
 * and describes a different animal. Nothing throws, nothing looks broken, and
 * the reader is handed a row that lies.
 *
 * So the tests that matter here are the ones about the build stamp. The rest —
 * order, de-duplication, the cap — is ordinary list behaviour and is pinned
 * because it is cheap to pin, not because it is dangerous.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import type { SearchHit } from "../api";
import { forgetRecent, loadRecent, rememberRecent } from "./recent";
import { RECENT_LIMIT } from "./starters";

const BUILD = "854cdfa42f77e78e";

function hit(over: Partial<SearchHit> = {}): SearchHit {
  return {
    kind: "node",
    key: "ott770315",
    idx: 594485,
    ott_id: 770315,
    name: "Homo sapiens",
    vernacular: "human",
    rank: "species",
    tip_count: 1,
    has_age: true,
    has_image: true,
    matched_on: "key",
    ...over,
  };
}

/** A live localStorage over a plain object, so a write is readable back. */
function stub(seed: Record<string, string> = {}) {
  const store = { ...seed };
  vi.stubGlobal("localStorage", {
    getItem: (k: string) => store[k] ?? null,
    setItem: (k: string, v: string) => {
      store[k] = v;
    },
    removeItem: (k: string) => {
      delete store[k];
    },
  });
  return store;
}

afterEach(() => vi.unstubAllGlobals());

describe("recents belong to the build they were written against", () => {
  it("returns what this build stored", () => {
    stub();
    rememberRecent(hit(), BUILD);
    expect(loadRecent(BUILD).map((h) => h.key)).toEqual(["ott770315"]);
  });

  it("drops the whole list when the dataset has been rebuilt", () => {
    // The one that matters. A stored `idx` from another build is not a stale
    // label on the right animal — it is a correct-looking label on the wrong
    // one. Six lost rows is the cheap outcome here.
    stub();
    rememberRecent(hit(), BUILD);
    expect(loadRecent("a-different-build")).toEqual([]);
  });

  it("has nothing to say before /v1/about has landed", () => {
    // No build id means no way to know whether what is stored is still true,
    // and the honest answer to that is silence rather than the benefit of the
    // doubt.
    stub();
    rememberRecent(hit(), BUILD);
    expect(loadRecent(null)).toEqual([]);
  });

  it("refuses to store against a build it does not know", () => {
    const store = stub();
    rememberRecent(hit(), null);
    expect(Object.keys(store)).toEqual([]);
  });
});

describe("recents are a history", () => {
  it("puts the newest first", () => {
    stub();
    rememberRecent(hit({ key: "ott1", idx: 1 }), BUILD);
    rememberRecent(hit({ key: "ott2", idx: 2 }), BUILD);
    expect(loadRecent(BUILD).map((h) => h.key)).toEqual(["ott2", "ott1"]);
  });

  it("moves a repeat pick up rather than doubling it", () => {
    stub();
    rememberRecent(hit({ key: "ott1", idx: 1 }), BUILD);
    rememberRecent(hit({ key: "ott2", idx: 2 }), BUILD);
    rememberRecent(hit({ key: "ott1", idx: 1 }), BUILD);
    expect(loadRecent(BUILD).map((h) => h.key)).toEqual(["ott1", "ott2"]);
  });

  it("keeps only the most recent few", () => {
    stub();
    for (let i = 0; i < RECENT_LIMIT + 4; i++) {
      rememberRecent(hit({ key: `ott${i}`, idx: i }), BUILD);
    }
    expect(loadRecent(BUILD)).toHaveLength(RECENT_LIMIT);
  });

  it("trims a blob written under a larger cap", () => {
    // The cap is a display decision and may fall. Enforcing it only on write
    // would leave an old blob overflowing the band until the reader happened
    // to pick something new.
    const hits = Array.from({ length: RECENT_LIMIT + 5 }, (_, i) =>
      hit({ key: `ott${i}`, idx: i }),
    );
    stub({ "concestor.recent": JSON.stringify({ v: 1, build: BUILD, hits }) });
    expect(loadRecent(BUILD)).toHaveLength(RECENT_LIMIT);
  });
});

/**
 * The palette has had a "forget my history" command since before this band
 * existed, and it promised more than it cleared the moment this band arrived.
 *
 * The bug this guards is a *copy* bug with a storage cause: `resetUsage` clears
 * `fuzzy.ts`'s ranking table, which nobody can see, while a list captioned
 * **Recent** stayed on screen. The store the reader is looking at is the one
 * that must not survive a command that says it forgets.
 */
describe("clearing search history clears the visible half too", () => {
  it("forgets every stored pick", () => {
    stub();
    rememberRecent(hit({ key: "ott1", idx: 1 }), BUILD);
    rememberRecent(hit({ key: "ott2", idx: 2 }), BUILD);
    expect(loadRecent(BUILD)).toHaveLength(2);

    forgetRecent();
    expect(loadRecent(BUILD)).toEqual([]);
  });

  it("is safe to call with nothing stored, and where storage throws", () => {
    stub();
    expect(() => forgetRecent()).not.toThrow();
    vi.stubGlobal("localStorage", {
      removeItem: () => {
        throw new Error("SecurityError");
      },
    });
    expect(() => forgetRecent()).not.toThrow();
  });

  it("clears the same store rememberRecent writes", () => {
    // Named keys drift. This pins the pair to each other rather than to a
    // string either one of them could change alone.
    const store = stub();
    rememberRecent(hit(), BUILD);
    expect(Object.keys(store)).toHaveLength(1);
    forgetRecent();
    expect(store[Object.keys(store)[0] ?? ""]).toBeUndefined();
  });
});

describe("recents survive everything that can go wrong with storage", () => {
  it("is empty where nothing was ever stored", () => {
    stub();
    expect(loadRecent(BUILD)).toEqual([]);
  });

  it("is empty where storage throws", () => {
    // Private browsing and blocked-storage settings throw on access rather
    // than returning null. This band is optional; the starters below it still
    // answer the reader.
    vi.stubGlobal("localStorage", {
      getItem: () => {
        throw new Error("SecurityError");
      },
      setItem: () => {
        throw new Error("SecurityError");
      },
    });
    expect(loadRecent(BUILD)).toEqual([]);
    expect(() => rememberRecent(hit(), BUILD)).not.toThrow();
  });

  it("is empty for a blob this app did not write", () => {
    for (const raw of [
      "",
      "null",
      "[]",
      "{}",
      '{"v":99,"build":"x","hits":[]}',
    ]) {
      stub({ "concestor.recent": raw });
      expect(loadRecent(BUILD), raw).toEqual([]);
    }
  });

  it("drops rows that could not be added even if drawn", () => {
    // Every row in this list is one Enter will act on, so a row with no `idx`
    // is worse than a missing row: it is a dead press in the band the reader
    // trusts most. A broken taxon has no idx and should never have been here.
    const hits = [
      hit(),
      { ...hit({ key: "ott2" }), idx: null },
      hit({ key: "ott3" }),
    ];
    stub({ "concestor.recent": JSON.stringify({ v: 1, build: BUILD, hits }) });
    expect(loadRecent(BUILD).map((h) => h.key)).toEqual(["ott770315", "ott3"]);
  });
});
