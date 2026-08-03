import { describe, expect, it } from "vitest";
import { spreadProse } from "./spread";
import type { LayoutSpread } from "../api";

const bound = (
  over: Partial<LayoutSpread["above"] & object> = {},
): NonNullable<LayoutSpread["above"]> => ({
  idx: 42,
  key: "ott1",
  name: "Hominidae",
  rank: "family",
  age_ma: 15.8,
  ...over,
});

describe("spreadProse", () => {
  // The 2.8%. Brunelliaceae is the worked example: an mrcaott… node at 112.6 Ma
  // above it, Brunellia at 82.6 below.
  it("names both ends where a dated descendant really exists", () => {
    const p = spreadProse({
      above: bound({ name: null, key: "mrcaott2ott520300", age_ma: 112.5877 }),
      below: bound({ key: "ott862531", name: "Brunellia", age_ma: 82.5603 }),
    });
    expect(p?.kind).toBe("between");
    if (p?.kind !== "between") throw new Error("wrong kind");
    expect(p.above.age).toBe("113 Ma");
    expect(p.above.name).toBeNull();
    expect(p.below.name).toBe("Brunellia");
    expect(p.below.age).toBe("83 Ma");
  });

  // The 70.4%, and the case the old copy was silently wrong about: every age
  // comes from a chronogram of living species, so there is usually nothing
  // dated below and the span runs to the present.
  it("says the span reaches the present when nothing below is dated", () => {
    const p = spreadProse({ above: bound({ age_ma: 6.9 }), below: null });
    expect(p?.kind).toBe("toPresent");
    if (p?.kind !== "toPresent") throw new Error("wrong kind");
    expect(p.above.name).toBe("Hominidae");
    expect(p.above.age).toBe("6.9 Ma");
  });

  // The 26.4%. `layout_ages` collapses onto the bound rather than inventing
  // room, so a card claiming the node was placed "between" two things would be
  // describing an interpolation that never ran.
  it("does not claim a span when the nearest dated relative is at the present", () => {
    const p = spreadProse({
      above: bound({ name: "Tetratheca aphylla", rank: "species", age_ma: 0 }),
      below: null,
    });
    expect(p?.kind).toBe("collapsed");
    if (p?.kind !== "collapsed") throw new Error("wrong kind");
    expect(p.above.age).toBe("the present");
  });

  // A name is not required to link, and 24.4% of upper bounds have none. The
  // key is what the link needs, so an mrcaott… bound is still reachable.
  it("keeps an unnamed bound, because it is still a node the reader can open", () => {
    const p = spreadProse({
      above: bound({ name: null, rank: null, key: "mrcaott9" }),
      below: null,
    });
    expect(p?.kind).toBe("toPresent");
    if (p?.kind !== "toPresent") throw new Error("wrong kind");
    expect(p.above.key).toBe("mrcaott9");
    expect(p.above.name).toBeNull();
  });

  it("says nothing at all when the build sends nothing", () => {
    expect(spreadProse(null)).toBeNull();
    expect(spreadProse(undefined)).toBeNull();
    expect(spreadProse({ above: null, below: null })).toBeNull();
    // No ancestor is no sentence: there is no "between" with one end.
    expect(spreadProse({ above: null, below: bound() })).toBeNull();
  });

  // Cannot happen — the layout's monotonicity sweep forbids it — but the
  // sentence built from it would read "between 40 Ma above and 90 Ma below",
  // and the card is not where an invariant should be discovered broken.
  it("refuses a lower bound older than the upper one", () => {
    const p = spreadProse({
      above: bound({ age_ma: 40 }),
      below: bound({ key: "ott9", name: "Impossible", age_ma: 90 }),
    });
    expect(p?.kind).toBe("toPresent");
  });

  // The same threshold the age label uses. A bound the canvas prints as
  // "present" must not appear in this paragraph as "0.0 Ma".
  it("writes a near-zero bound the way the label does", () => {
    const p = spreadProse({ above: bound({ age_ma: 0.04 }), below: null });
    expect(p?.kind).toBe("collapsed");
    const q = spreadProse({ above: bound({ age_ma: 0.06 }), below: null });
    if (q?.kind !== "toPresent") throw new Error("wrong kind");
    expect(q.above.age).toBe("0.1 Ma");
  });
});
