import { describe, expect, it, vi } from "vitest";

import { api, normalise } from "./api";

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

/**
 * A superseded search must stop costing something.
 *
 * `/v1/search` is served by a single container instance with half a vCPU, so a
 * request the reader has already typed past is not idle waiting — it holds the
 * only CPU there is while the keystroke they *are* waiting on queues behind it.
 * The 110 ms debounce only ever stopped a request being sent; one already in
 * flight ran to completion and had its answer discarded.
 */
describe("an abandoned search is cancelled", () => {
  const ok = (body: unknown) =>
    ({ ok: true, status: 200, json: async () => body }) as Response;

  it("passes the caller's signal through to fetch", async () => {
    const seen: (AbortSignal | null | undefined)[] = [];
    vi.stubGlobal("fetch", async (_u: string, init?: RequestInit) => {
      seen.push(init?.signal);
      return ok({ query: "q", results: [] });
    });
    const ac = new AbortController();
    await api.search("signal-probe", 24, ac.signal);
    expect(seen).toHaveLength(1);
    expect(seen[0]).toBe(ac.signal);
    vi.unstubAllGlobals();
  });

  it("rejects on abort and remembers nothing, so the query can be asked again", async () => {
    let calls = 0;
    vi.stubGlobal("fetch", (_u: string, init?: RequestInit) => {
      calls += 1;
      return new Promise<Response>((resolve, reject) => {
        const signal = init?.signal;
        if (signal) {
          signal.addEventListener("abort", () =>
            reject(new DOMException("aborted", "AbortError")),
          );
        }
        // Never resolves on its own: this is the in-flight request.
        if (!signal) resolve(ok({ query: "q", results: [] }));
      });
    });

    const ac = new AbortController();
    const first = api.search("abandoned", 24, ac.signal);
    ac.abort();
    await expect(first).rejects.toThrow();
    expect(calls).toBe(1);

    // The aborted entry must not be left in the memo cache, or backspacing to
    // the same query would rediscover its cancellation instead of asking.
    vi.stubGlobal("fetch", async () => ok({ query: "abandoned", results: [] }));
    const second = await api.search("abandoned", 24);
    expect(second.query).toBe("abandoned");
    vi.unstubAllGlobals();
  });
});
