import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  Beacon,
  FLUSH_MS,
  longer,
  SEARCH_IDLE_MS,
  supersedes,
  treeKey,
  TREE_IDLE_MS,
  type Event,
} from "./beacon";

/** A beacon whose transport is a list, so a test can read what was sent. */
function harness() {
  const sent: Event[][] = [];
  const b = new Beacon((events) => sent.push([...events]));
  return { b, sent, flat: () => sent.flat() };
}

const IDLE = Math.max(SEARCH_IDLE_MS, TREE_IDLE_MS) + FLUSH_MS + 1;

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

/**
 * A tree is a *set*. Two readers who built the same canvas in opposite orders
 * built the same tree, and the whole value of the `tree` event is that it
 * groups — so anything that lets one tree occupy two rows in the answer defeats
 * it.
 */
describe("treeKey", () => {
  it("is order-independent", () => {
    expect(treeKey(["770315", "153563"])).toBe(treeKey(["153563", "770315"]));
  });

  it("drops a duplicate rather than counting it twice", () => {
    expect(treeKey(["770315", "770315", "153563"])).toBe("153563,770315");
  });

  it("is empty for an empty selection", () => {
    expect(treeKey([])).toBe("");
  });
});

/**
 * The palette searches on every keystroke, so recording what it ran would
 * answer "what do people search for" with `w`, `wh`, `wha`, `whal`, `whale`.
 * The prefix chain is one reach for one word.
 */
describe("what counts as one search", () => {
  it("holds a prefix chain to a single event", () => {
    const { b, flat } = harness();
    for (const q of ["do", "dog"]) b.search(q);
    vi.advanceTimersByTime(IDLE);
    expect(flat().map((e) => e.subject)).toEqual(["dog"]);
  });

  it("keeps the longest, so backspacing still records what was typed", () => {
    const { b, flat } = harness();
    for (const q of ["do", "dog", "dogs", "dog"]) b.search(q);
    vi.advanceTimersByTime(IDLE);
    expect(flat().map((e) => e.subject)).toEqual(["dogs"]);
  });

  it("starts a new one when the word changes", () => {
    const { b, flat } = harness();
    b.search("dog");
    b.search("cat");
    vi.advanceTimersByTime(IDLE);
    expect(flat().map((e) => e.subject)).toEqual(["dog", "cat"]);
  });

  it("records the query a reader pressed Enter on inside the idle window", () => {
    const { b, flat } = harness();
    b.search("axolotl");
    b.endSearch();
    vi.advanceTimersByTime(IDLE);
    expect(flat().map((e) => e.subject)).toEqual(["axolotl"]);
  });

  it("ignores anything the server would not have searched", () => {
    const { b, flat } = harness();
    b.search("d");
    b.search(" ");
    vi.advanceTimersByTime(IDLE);
    expect(flat()).toEqual([]);
  });

  it("does not repeat a query the reader returned to", () => {
    const { b, flat } = harness();
    b.search("dog");
    vi.advanceTimersByTime(IDLE);
    b.search("dog");
    vi.advanceTimersByTime(IDLE);
    expect(flat()).toHaveLength(1);
  });
});

/**
 * Three adds in a row are one tree. Recording each intermediate state would
 * make every three-species canvas look like three trees, two of which nobody
 * ever meant to build.
 */
describe("what counts as one tree", () => {
  it("records the selection that was on screen when the reader stopped", () => {
    const { b, flat } = harness();
    b.tree(["770315", "153563"], "add");
    b.tree(["770315", "153563", "247333"], "add");
    vi.advanceTimersByTime(IDLE);
    expect(flat().map((e) => e.tree)).toEqual(["153563,247333,770315"]);
  });

  it("refuses a selection of one, which has no divergence in it", () => {
    const { b, flat } = harness();
    b.tree(["770315"], "add");
    vi.advanceTimersByTime(IDLE);
    expect(flat()).toEqual([]);
  });

  it("does not record the same tree twice", () => {
    const { b, flat } = harness();
    b.tree(["770315", "153563"], "add");
    vi.advanceTimersByTime(IDLE);
    b.tree(["153563", "770315"], "back");
    vi.advanceTimersByTime(IDLE);
    expect(flat()).toHaveLength(1);
  });

  it("says what put it there, so a received tree is not a made one", () => {
    const { b, flat } = harness();
    b.tree(["770315", "153563"], "link");
    vi.advanceTimersByTime(IDLE);
    expect(flat()[0]).toMatchObject({ kind: "tree", cause: "link" });
  });
});

describe("delivery", () => {
  it("batches a burst into one request", () => {
    const { b, sent } = harness();
    b.add("770315");
    b.add("153563");
    vi.advanceTimersByTime(IDLE);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toHaveLength(2);
  });

  it("sends nothing when nothing happened", () => {
    const { b, sent } = harness();
    b.flush();
    vi.advanceTimersByTime(IDLE);
    expect(sent).toEqual([]);
  });

  it("gives up what it holds when the page goes away", () => {
    const { b, flat } = harness();
    b.search("whale");
    b.tree(["770315", "153563"], "add");
    // No timer runs: the tab was hidden a keystroke after the last event.
    b.flush();
    expect(flat().map((e) => e.kind)).toEqual(["search", "tree"]);
  });
});

describe("the prefix rule itself", () => {
  it("holds in both directions", () => {
    expect(supersedes("dog", "do")).toBe(true);
    expect(supersedes("do", "dog")).toBe(true);
    expect(supersedes("dog", "cat")).toBe(false);
  });

  it("prefers the fuller reach", () => {
    expect(longer("do", "dog")).toBe("dog");
    expect(longer("dog", "do")).toBe("dog");
  });
});
