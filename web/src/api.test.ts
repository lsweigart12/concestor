import { describe, expect, it } from "vitest";

import { normalise } from "./api";

/**
 * The client does not rank.
 *
 * A taxon's common names arrive from `/v1/node` most-used first, ordered by
 * the pipeline's `usage_rank` — evidence gathered from English Wikipedia's
 * title and redirect graph, which the browser has no access to and cannot
 * reconstruct. `Detail.tsx` reads that list *positionally*: `[0]` is the
 * subtitle, `slice(1, 9)` is "Also called". So any reordering at this boundary
 * changes what the card claims a thing is mostly called.
 *
 * This is the same failure `docs/handoff.md` records against `/v1/search`,
 * where a fuzzy score computed in the browser outweighed four server ranks and
 * put a sea snail above the butterflies. It is written down here because the
 * flattening step is exactly where somebody would reach for a sort next time.
 */
describe("vernacular order at the API boundary", () => {
  const homoSapiens = {
    idx: 594485,
    vernaculars: [
      { name: "human", lang: "en", preferred: true },
      { name: "humans", lang: "en" },
      { name: "human being", lang: "en" },
      { name: "man", lang: "en" },
      { name: "men", lang: "en" },
    ],
    synonyms: ["Homo sapiens Linnaeus 1758"],
  };

  it("keeps the server's order exactly", () => {
    const out = normalise("/v1/node/ott770315", { ...homoSapiens }) as {
      vernaculars: string[];
    };
    expect(out.vernaculars).toEqual([
      "human",
      "humans",
      "human being",
      "man",
      "men",
    ]);
  });

  it("does not float a `preferred` flag to the front", () => {
    // The server orders by rank, so a preferred row is already first. If it
    // ever is not, the server is what should be fixed — hoisting it here would
    // hide the discrepancy and demote whatever the rank actually chose.
    const out = normalise("/v1/node/x", {
      idx: 1,
      vernaculars: [
        { name: "carnivorans", lang: "en" },
        { name: "Ferae", lang: "en", preferred: true },
      ],
      synonyms: [],
    }) as { vernaculars: string[] };
    expect(out.vernaculars[0]).toBe("carnivorans");
  });

  it("flattens objects to strings, so no card ever renders [object Object]", () => {
    const out = normalise("/v1/node/x", {
      idx: 1,
      vernaculars: [{ name: "dog", lang: "en", preferred: true }],
      synonyms: [],
    }) as { vernaculars: string[] };
    expect(out.vernaculars).toEqual(["dog"]);
  });

  it("still accepts a bare list of strings", () => {
    const out = normalise("/v1/node/x", {
      idx: 1,
      vernaculars: ["insect", "insects", "bug"],
      synonyms: [],
    }) as { vernaculars: string[] };
    expect(out.vernaculars).toEqual(["insect", "insects", "bug"]);
  });

  it("drops duplicates without disturbing the survivors' order", () => {
    const out = normalise("/v1/node/x", {
      idx: 1,
      vernaculars: [
        { name: "insect", lang: "en" },
        { name: "insects", lang: "en" },
        { name: "insect", lang: "en" },
        { name: "bug", lang: "en" },
      ],
      synonyms: [],
    }) as { vernaculars: string[] };
    expect(out.vernaculars).toEqual(["insect", "insects", "bug"]);
  });

  it("survives a malformed row rather than dropping the list", () => {
    const out = normalise("/v1/node/x", {
      idx: 1,
      vernaculars: ["dog", null, { lang: "en" }, { name: "domestic dog" }],
      synonyms: [],
    }) as { vernaculars: string[] };
    expect(out.vernaculars).toEqual(["dog", "domestic dog"]);
  });
});
