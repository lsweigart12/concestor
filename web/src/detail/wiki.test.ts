/**
 * The payload shapes below are trimmed from real responses. What is being
 * tested is almost entirely the *refusals*: this is the one place in the app
 * that takes text from outside the build and puts it on a card, and the way it
 * goes wrong is not an error, it is a confident paragraph about the wrong
 * organism.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { lookup, resetWikiCache } from "./wiki";

/** A stub that answers by URL substring, and counts what was asked. */
function stubFetch(
  routes: { match: string; body: unknown; status?: number }[],
) {
  const calls: string[] = [];
  const fn = vi.fn(async (url: string) => {
    calls.push(url);
    const r = routes.find((x) => url.includes(x.match));
    if (!r)
      return { ok: false, status: 404, json: async () => ({}) } as Response;
    return {
      ok: (r.status ?? 200) < 400,
      status: r.status ?? 200,
      json: async () => r.body,
    } as Response;
  });
  vi.stubGlobal("fetch", fn);
  return calls;
}

const ITEM_HUMAN = {
  entities: {
    Q15978631: {
      id: "Q15978631",
      descriptions: { en: { language: "en", value: "species of hominid" } },
      sitelinks: { enwiki: { site: "enwiki", title: "Human" } },
    },
  },
};

const SUMMARY_HUMAN = { extract: "Humans are a species of primate." };

beforeEach(() => resetWikiCache());
afterEach(() => vi.unstubAllGlobals());

describe("lookup by QID", () => {
  it("returns the gloss, the extract and both links", async () => {
    stubFetch([
      { match: "wbgetentities", body: ITEM_HUMAN },
      { match: "page/summary", body: SUMMARY_HUMAN },
    ]);
    const got = await lookup({ qid: "Q15978631", name: "Homo sapiens" });
    expect(got).toEqual({
      qid: "Q15978631",
      wikidataUrl: "https://www.wikidata.org/wiki/Q15978631",
      gloss: "species of hominid",
      extract: "Humans are a species of primate.",
      articleTitle: "Human",
      articleUrl: "https://en.wikipedia.org/wiki/Human",
      broaderThanAsked: null,
    });
  });

  it("does not ask for claims — the build already made that check", async () => {
    const calls = stubFetch([
      { match: "wbgetentities", body: ITEM_HUMAN },
      { match: "page/summary", body: SUMMARY_HUMAN },
    ]);
    await lookup({ qid: "Q15978631", name: "Homo sapiens" });
    // Re-fetching P225 here would ask Wikidata the same question phase 6 asked
    // and would cost the largest property on the item to learn nothing.
    expect(calls.find((u) => u.includes("wbgetentities"))).not.toContain(
      "claims",
    );
  });

  it("survives an article that does not exist", async () => {
    stubFetch([
      {
        match: "wbgetentities",
        body: {
          entities: {
            Q1: { id: "Q1", descriptions: { en: { value: "a clade" } } },
          },
        },
      },
    ]);
    const got = await lookup({ qid: "Q1" });
    // A gloss and a Wikidata link is a smaller answer, not a failure.
    expect(got?.gloss).toBe("a clade");
    expect(got?.articleUrl).toBeNull();
    expect(got?.wikidataUrl).toBe("https://www.wikidata.org/wiki/Q1");
  });

  it("keeps the gloss when only the extract fails", async () => {
    stubFetch([
      { match: "wbgetentities", body: ITEM_HUMAN },
      { match: "page/summary", body: {}, status: 500 },
    ]);
    const got = await lookup({ qid: "Q15978631" });
    expect(got?.gloss).toBe("species of hominid");
    expect(got?.extract).toBeNull();
    expect(got?.articleUrl).toBe("https://en.wikipedia.org/wiki/Human");
  });

  it("answers null for an item Wikidata does not have", async () => {
    stubFetch([
      { match: "wbgetentities", body: { entities: { Q9: { missing: "" } } } },
    ]);
    expect(await lookup({ qid: "Q9" })).toBeNull();
  });
});

describe("lookup by name", () => {
  /** The item Wikidata returns for the article titled "Tyrannosaurus". */
  const ITEM_TREX = {
    entities: {
      Q14332: {
        id: "Q14332",
        descriptions: { en: { value: "genus of theropod dinosaur" } },
        sitelinks: { enwiki: { title: "Tyrannosaurus" } },
        claims: {
          P225: [
            {
              mainsnak: {
                datavalue: { value: "Tyrannosaurus", type: "string" },
              },
            },
          ],
        },
      },
    },
  };

  it("accepts an item whose P225 is the taxon asked about", async () => {
    stubFetch([
      { match: "wbgetentities", body: ITEM_TREX },
      { match: "page/summary", body: { extract: "Tyrannosaurus is a genus." } },
    ]);
    const got = await lookup({ name: "Tyrannosaurus" });
    expect(got?.qid).toBe("Q14332");
    expect(got?.extract).toBe("Tyrannosaurus is a genus.");
  });

  it("refuses an article of the same name that is about something else", async () => {
    // *Ares* is a PBDB genus and an Olympian. The article exists, the item is
    // real, and its P225 is absent because it is not a taxon at all — which is
    // the whole signal.
    stubFetch([
      {
        match: "wbgetentities",
        body: {
          entities: {
            Q34201: {
              id: "Q34201",
              descriptions: { en: { value: "ancient Greek god of war" } },
              sitelinks: { enwiki: { title: "Ares" } },
              claims: {},
            },
          },
        },
      },
    ]);
    expect(await lookup({ name: "Ares" })).toBeNull();
  });

  it("refuses a taxon item whose P225 is a different taxon", async () => {
    // The *Ivesia* case: PBDB's is an Ediacaran rangeomorph, and an article of
    // that name may be about the rose-family plant instead.
    stubFetch([
      {
        match: "wbgetentities",
        body: {
          entities: {
            Q157: {
              sitelinks: { enwiki: { title: "Ivesia" } },
              claims: {
                P225: [
                  {
                    mainsnak: {
                      datavalue: { value: "Potentilla", type: "string" },
                    },
                  },
                ],
              },
            },
          },
        },
      },
    ]);
    expect(await lookup({ name: "Ivesia" })).toBeNull();
  });

  it("matches a P225 regardless of case and surrounding space", async () => {
    stubFetch([
      {
        match: "wbgetentities",
        body: {
          entities: {
            Q1: {
              sitelinks: { enwiki: { title: "X" } },
              claims: {
                P225: [
                  { mainsnak: { datavalue: { value: " tyrannosaurus " } } },
                ],
              },
            },
          },
        },
      },
      { match: "page/summary", body: { extract: "..." } },
    ]);
    expect((await lookup({ name: "Tyrannosaurus" }))?.qid).toBe("Q1");
  });

  it("answers null for a title with no item at all", async () => {
    stubFetch([
      { match: "wbgetentities", body: { entities: { "-1": { missing: "" } } } },
    ]);
    expect(await lookup({ name: "Fakeosaurus" })).toBeNull();
  });

  it("falls back to the genus for a binomial, and says that it did", async () => {
    // Wikipedia has no article titled *Tyrannosaurus rex* — it is a redirect,
    // and sitelinks do not follow those.
    const calls = stubFetch([
      {
        match: "titles=Tyrannosaurus%20rex",
        body: { entities: { "-1": { missing: "" } } },
      },
      { match: "titles=Tyrannosaurus&", body: ITEM_TREX },
      { match: "page/summary", body: { extract: "Tyrannosaurus is a genus." } },
    ]);
    const got = await lookup({ name: "Tyrannosaurus rex" });
    expect(got?.qid).toBe("Q14332");
    // Without this the card would print a paragraph about a genus of a dozen
    // species under a heading naming one of them, with nothing saying so.
    expect(got?.broaderThanAsked).toBe("Tyrannosaurus");
    expect(calls.filter((u) => u.includes("wbgetentities")).length).toBe(2);
  });

  it("does not invent a genus out of something that is not a binomial", async () => {
    const calls = stubFetch([
      { match: "wbgetentities", body: { entities: { "-1": {} } } },
    ]);
    // A vernacular, a trinomial and an informal PBDB string all reach here, and
    // none of them has a first word that is a group.
    for (const name of [
      "giant ground sloth",
      "Homo sapiens neanderthalensis",
      "Bombus nr. sp",
    ]) {
      expect(await lookup({ name })).toBeNull();
    }
    expect(calls.length).toBe(3);
  });
});

describe("caching", () => {
  it("makes one request for two cards on the same taxon", async () => {
    const calls = stubFetch([
      { match: "wbgetentities", body: ITEM_HUMAN },
      { match: "page/summary", body: SUMMARY_HUMAN },
    ]);
    await Promise.all([
      lookup({ qid: "Q15978631" }),
      lookup({ qid: "Q15978631" }),
    ]);
    await lookup({ qid: "Q15978631" });
    expect(calls.length).toBe(2); // the item and its summary, once each
  });

  it("does not remember a network failure", async () => {
    // "The network was down when you clicked" is not an answer about a taxon,
    // and caching it as one would blank every card until a reload.
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("Failed to fetch");
      }),
    );
    expect(await lookup({ qid: "Q15978631" })).toBeNull();
    stubFetch([
      { match: "wbgetentities", body: ITEM_HUMAN },
      { match: "page/summary", body: SUMMARY_HUMAN },
    ]);
    expect((await lookup({ qid: "Q15978631" }))?.gloss).toBe(
      "species of hominid",
    );
  });

  it("has nothing to ask when it is given neither a QID nor a name", async () => {
    const calls = stubFetch([]);
    expect(await lookup({})).toBeNull();
    expect(await lookup({ qid: "  ", name: null })).toBeNull();
    expect(calls.length).toBe(0);
  });
});
