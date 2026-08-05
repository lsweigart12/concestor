/**
 * What the palette says when it has no rows, and the one thing it must never
 * say.
 *
 * This exists because the wrong answer shipped and looked like the right one.
 * The old list tested a single condition — two or more characters typed and
 * nothing to show — and printed **"Nothing matched dog"**. That condition is
 * also true for the whole of the debounce and the whole of the round trip, so
 * the first thing a reader saw after typing a real name was a flat denial that
 * it exists, replaced a moment later by eight rows about dogs.
 *
 * On a developer's machine that is a flicker, which is exactly why it survived:
 * the API is on localhost, an FTS query is single-digit milliseconds, and the
 * false state is gone before anyone reads it. Against a cold container it is
 * the answer, sitting still, for as long as the reader cares to look.
 *
 * So the invariant below is worth more than the enumeration around it: **a
 * denial requires a settled search.** Everything else here is detail.
 */

import { describe, expect, it } from "vitest";
import { emptyState, MIN_QUERY } from "./Palette";

const state = (query: string, searching: boolean, slow: boolean) =>
  emptyState({ query, searching, slow });

describe("the palette's empty list", () => {
  it("never denies a match while a search is out", () => {
    // Every combination of a searchable query and a search in flight. None of
    // them may reach `no-match`, whether or not the wait has been noticed yet.
    for (const q of ["do", "dog", "tyrannosaurus", "T. rex"]) {
      for (const slow of [false, true]) {
        expect(state(q, true, slow)).not.toBe("no-match");
      }
    }
  });

  it("denies a match only once the search has come back empty", () => {
    expect(state("zzzz", false, false)).toBe("no-match");
  });

  it("says nothing at all while a fast search is out", () => {
    // The state that renders no element, not the state that renders an empty
    // one: a padded panel with nothing in it is a hole where an answer is
    // about to be, and it arrives inside the time it takes to read a word.
    expect(state("dog", true, false)).toBe("silent");
  });

  it("names the wait once it is a wait", () => {
    expect(state("dog", true, true)).toBe("searching");
  });

  /**
   * The floor belongs to the effect that runs the search, and this function
   * reads the same constant. A list that reported on a search below the floor
   * would be describing a request that was never made — and it would breathe
   * forever, because nothing is ever going to come back and clear it.
   */
  it("reports on no search below the length that triggers one", () => {
    expect(MIN_QUERY).toBe(2);
    for (const q of ["", "d"]) {
      expect(state(q, true, true)).toBe("prompt");
      expect(state(q, false, false)).toBe("prompt");
    }
  });

  it("prompts on an empty box rather than denying the empty string", () => {
    expect(state("", false, false)).toBe("prompt");
  });
});
