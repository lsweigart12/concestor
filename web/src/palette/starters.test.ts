/**
 * The empty species palette: which bands it shows, and when it shows none.
 *
 * The bands themselves are curated content and the gate that checks they are
 * *true* is in Go — `TestStartersAreDrawableAndNamed` reads `starters.ts` and
 * puts every key against the built database, because "make sure every
 * suggestion actually has good results" cannot be asked anywhere the dataset is
 * not. What is checkable here is the shape of the list and the rules about when
 * a suggestion may be on screen at all, and the second of those is where the
 * real failures live: a band that outlives the first keystroke is a band
 * competing with the answer.
 */

import { describe, expect, it } from "vitest";
import type { SearchHit } from "../api";
import { MIN_QUERY, suggestionBands, type Suggestions } from "./Palette";
import { RECENT_LIMIT, STARTERS } from "./starters";

function hit(key: string): SearchHit {
  return {
    kind: "node",
    key,
    idx: Number(key.replace("ott", "")),
    ott_id: Number(key.replace("ott", "")),
    name: key,
    vernacular: null,
    rank: "species",
    tip_count: 1,
    has_age: true,
    has_image: true,
    matched_on: "key",
  };
}

const suggestions = (recent: string[], starters: string[]): Suggestions => ({
  recent: recent.map(hit),
  starters: starters.map(hit),
});

const bands = (over: Partial<Parameters<typeof suggestionBands>[0]> = {}) =>
  suggestionBands({
    filter: "species",
    query: "",
    suggestions: suggestions([], ["ott1", "ott2"]),
    ...over,
  });

describe("the curated list", () => {
  it("is ten distinct OTT keys", () => {
    // Ten is a display decision — Baymard puts the desktop ceiling for a
    // suggestion list at ten — and the count is pinned so that adding an
    // eleventh is a decision somebody makes rather than one that happens.
    expect(STARTERS).toHaveLength(10);
    expect(new Set(STARTERS).size).toBe(STARTERS.length);
    for (const key of STARTERS) expect(key).toMatch(/^ott\d+$/);
  });

  it("leads with the reader", () => {
    // `openings.ts` puts "Are you a fish?" first and stays first for this
    // reason: a row about *you* needs no other hook. Same argument, same
    // position, and it is the one row here whose place is not a judgement call.
    expect(STARTERS[0]).toBe("ott770315"); // Homo sapiens
  });

  it("offers fewer recents than starters", () => {
    // Not arithmetic for its own sake. The recents band sits above the starters
    // and is the reader's own history; if it could fill the panel on its own,
    // the curated list — the only part that covers branches the reader has not
    // thought of — would never be seen again after the first few visits.
    expect(RECENT_LIMIT).toBeLessThan(STARTERS.length);
  });
});

describe("suggestions appear only where there is nothing to search", () => {
  it("fills an empty species palette", () => {
    expect(bands().map(([title]) => title)).toEqual(["Start here"]);
  });

  it("leads with the reader's own picks when there are any", () => {
    const got = bands({ suggestions: suggestions(["ott9"], ["ott1"]) });
    expect(got.map(([title]) => title)).toEqual(["Recent", "Start here"]);
  });

  it("stops the moment a search can run", () => {
    // The same floor the search itself uses, read from the same constant. A
    // band still standing beside real results is competing with them.
    for (let n = MIN_QUERY; n <= MIN_QUERY + 2; n++) {
      expect(bands({ query: "d".repeat(n) }), `${n} chars`).toEqual([]);
    }
  });

  it("survives the characters below that floor", () => {
    // One character searches nothing, so the list would otherwise be empty —
    // this is the state that used to say "Nothing matched d" before the empty
    // states were separated, and it is still the state a reader passes through
    // on the way to every query they type.
    for (const q of ["", "d"]) {
      expect(bands({ query: q }).length, JSON.stringify(q)).toBeGreaterThan(0);
    }
  });

  it("stays out of the root palette", () => {
    // `P` already opens on the full command list, which is a useful empty state
    // and the one this surface was modelled on. Ten species above it would bury
    // the commands to fix a problem the root palette does not have.
    expect(bands({ filter: null })).toEqual([]);
  });

  it("says nothing while the prefetch is out", () => {
    expect(bands({ suggestions: null })).toEqual([]);
    expect(bands({ suggestions: suggestions([], []) })).toEqual([]);
  });
});

describe("a taxon is never offered twice", () => {
  it("drops a starter the reader has already picked", () => {
    // Two rows that do the same thing under different headings reads as a bug
    // in a list whose whole job is to look considered.
    const got = bands({ suggestions: suggestions(["ott2"], ["ott1", "ott2"]) });
    expect(got.map(([title, rows]) => [title, rows.map((h) => h.key)])).toEqual(
      [
        ["Recent", ["ott2"]],
        ["Start here", ["ott1"]],
      ],
    );
  });

  it("drops the starters band entirely when it has nothing left", () => {
    // An empty band would still draw its heading, and "Start here" over no rows
    // is an offer with nothing behind it.
    const got = bands({ suggestions: suggestions(["ott1"], ["ott1"]) });
    expect(got.map(([title]) => title)).toEqual(["Recent"]);
  });

  it("keeps the curated order in whatever survives", () => {
    const got = bands({
      suggestions: suggestions(["ott2"], ["ott1", "ott2", "ott3"]),
    });
    expect(got[1]?.[1].map((h) => h.key)).toEqual(["ott1", "ott3"]);
  });
});
