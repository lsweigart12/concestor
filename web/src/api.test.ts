import { describe, expect, it, vi } from "vitest";

import { api, normalise, SEARCH_MEMO_LIMIT } from "./api";

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
 *
 * The names below read capitalised because this boundary also *cases* them —
 * `vernacular.ts` is the rule and `vernacular.test.ts` is its own test. That is
 * a change to each string's first letter and to nothing else, so every claim
 * this block makes about **order** is untouched by it, which is why the
 * fixtures were left as the server sends them rather than pre-capitalised.
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
      "Human",
      "Humans",
      "Human being",
      "Man",
      "Men",
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
    expect(out.vernaculars[0]).toBe("Carnivorans");
  });

  it("flattens objects to strings, so no card ever renders [object Object]", () => {
    const out = normalise("/v1/node/x", {
      idx: 1,
      vernaculars: [{ name: "dog", lang: "en", preferred: true }],
      synonyms: [],
    }) as { vernaculars: string[] };
    expect(out.vernaculars).toEqual(["Dog"]);
  });

  it("still accepts a bare list of strings", () => {
    const out = normalise("/v1/node/x", {
      idx: 1,
      vernaculars: ["insect", "insects", "bug"],
      synonyms: [],
    }) as { vernaculars: string[] };
    expect(out.vernaculars).toEqual(["Insect", "Insects", "Bug"]);
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
    expect(out.vernaculars).toEqual(["Insect", "Insects", "Bug"]);
  });

  it("survives a malformed row rather than dropping the list", () => {
    const out = normalise("/v1/node/x", {
      idx: 1,
      vernaculars: ["dog", null, { lang: "en" }, { name: "domestic dog" }],
      synonyms: [],
    }) as { vernaculars: string[] };
    expect(out.vernaculars).toEqual(["Dog", "Domestic dog"]);
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

  /**
   * What a joiner inherits, pinned because the comment used to say otherwise.
   *
   * `get` hands a second caller for the same URL the first caller's promise.
   * So an abort by the originator rejects everyone waiting on it, including a
   * caller that passed no signal and asked for none of this. The twelve lines
   * of comment that used to sit above `get` asserted the reverse — that a
   * signal cancels only a request "this call started" — and no code anywhere
   * implemented it.
   *
   * The comment was corrected rather than the code, and this test is why that
   * is safe to leave: the property is now written down where it can fail. If
   * somebody later builds the subscriber ledger that would make the old
   * assertion true, this test is what tells them the behaviour they changed was
   * deliberate, and it is the test they must rewrite to say so.
   */
  it("hands a joiner the originator's cancellation, which is the sharp edge", async () => {
    let calls = 0;
    vi.stubGlobal("fetch", (_u: string, init?: RequestInit) => {
      calls += 1;
      const signal = init?.signal;
      return new Promise<Response>((_resolve, reject) => {
        signal?.addEventListener("abort", () =>
          reject(new DOMException("aborted", "AbortError")),
        );
      });
    });

    const ac = new AbortController();
    const originator = api.search("joined-abort", 24, ac.signal);
    // No signal of its own: this caller joins the promise above rather than
    // starting a request, which is the whole of why it is affected at all.
    const joiner = api.search("joined-abort", 24);
    expect(calls).toBe(1);

    ac.abort();
    await expect(originator).rejects.toThrow();
    await expect(joiner).rejects.toThrow();
    vi.unstubAllGlobals();
  });
});

/**
 * Two memos, because two kinds of URL.
 *
 * `/v1/node` and `/v1/path` are keyed on identifiers the build assigned, so
 * their URL space is a function of the dataset and remembering every answer for
 * the life of the tab is what architecture §2 asks for. `/v1/search` is keyed
 * on a string the reader typed, and with typeahead every prefix of every query
 * is a key — so the same rule made the tab hold a log of everything anybody
 * ever searched for. One rule had been written for two different kinds of
 * endpoint, and the distinction that fixes it is the endpoint rather than the
 * mechanism.
 */
describe("the response memo is bounded where the reader writes the URL", () => {
  const ok = (body: unknown) =>
    ({ ok: true, status: 200, json: async () => body }) as Response;

  /** Counts a fetch per URL, so "was this a memo hit" is answerable. */
  function counting(body: (url: string) => unknown) {
    const calls = new Map<string, number>();
    vi.stubGlobal("fetch", async (u: string) => {
      calls.set(u, (calls.get(u) ?? 0) + 1);
      return ok(body(u));
    });
    return (needle: string) =>
      [...calls]
        .filter(([u]) => u.includes(needle))
        .reduce((n, [, c]) => n + c, 0);
  }

  const searched = async (q: string) => api.search(q, 24);

  it("evicts the oldest search once the bound is passed", async () => {
    const count = counting((u) => ({ query: u, results: [] }));
    // One past the bound, so exactly one query — the first — must be gone.
    for (let i = 0; i <= SEARCH_MEMO_LIMIT; i++) await searched(`bound-${i}`);
    expect(count("bound-0")).toBe(1);

    await searched(`bound-${SEARCH_MEMO_LIMIT}`);
    expect(count(`bound-${SEARCH_MEMO_LIMIT}&`)).toBe(1);

    await searched("bound-0");
    expect(count("bound-0&")).toBe(2);
    vi.unstubAllGlobals();
  });

  it("keeps a re-read query, because recency means used and not fetched", async () => {
    const count = counting((u) => ({ query: u, results: [] }));
    await searched("lru-keep");
    // Fill to exactly the bound, leaving `lru-keep` the oldest entry.
    for (let i = 0; i < SEARCH_MEMO_LIMIT - 1; i++) {
      await searched(`lru-fill-${i}`);
    }

    // Reading it is what moves it. Without the touch this is the entry the
    // next insert throws away, and backspacing to a query the reader has been
    // editing all along would cost a round trip on the half-vCPU container.
    await searched("lru-keep");
    expect(count("lru-keep&")).toBe(1);

    await searched("lru-evictor");
    await searched("lru-keep");
    expect(count("lru-keep&")).toBe(1);
    // And the entry that went instead is the one nobody has looked at since.
    await searched("lru-fill-0");
    expect(count("lru-fill-0&")).toBe(2);
    vi.unstubAllGlobals();
  });

  it("does not bound the URLs the dataset bounds", async () => {
    const count = counting(() => ({ idx: 1, vernaculars: [], synonyms: [] }));
    await api.node("ott770315");
    // Far more traffic than the search bound, on the memo that has none. A
    // reader clicking through a tree generates exactly this, and losing the
    // first path they opened is losing the MRCA computed from it.
    for (let i = 0; i < SEARCH_MEMO_LIMIT + 8; i++) await api.node(`idx:${i}`);

    await api.node("ott770315");
    expect(count("ott770315")).toBe(1);
    vi.unstubAllGlobals();
  });

  /**
   * Eviction gave the failure memo a way to go wrong that it never had.
   *
   * An in-flight entry used to be undisplaceable: a second caller for the same
   * URL joined it rather than starting one, so the promise that rejects is
   * always the promise in the memo. Once entries can be evicted, a slow request
   * pushed out by later searches — then asked again and *answered* — would on
   * its own rejection delete the newer entry, and the memo would quietly forget
   * the answer it had just been given. So the cleanup deletes this promise, not
   * merely this URL.
   */
  it("a late rejection cannot delete the answer that replaced it", async () => {
    let calls = 0;
    vi.stubGlobal("fetch", (u: string, init?: RequestInit) => {
      calls += 1;
      const signal = init?.signal;
      if (signal) {
        return new Promise<Response>((_r, reject) => {
          signal.addEventListener("abort", () =>
            reject(new DOMException("aborted", "AbortError")),
          );
        });
      }
      return Promise.resolve(ok({ query: u, results: [] }));
    });

    const ac = new AbortController();
    const stranded = api.search("displaced", 24, ac.signal);
    for (let i = 0; i < SEARCH_MEMO_LIMIT; i++) await searched(`displace-${i}`);

    // Its entry is gone, so this starts a second request and remembers it.
    await searched("displaced");
    expect(calls).toBe(SEARCH_MEMO_LIMIT + 2);

    ac.abort();
    await expect(stranded).rejects.toThrow();
    await Promise.resolve();

    await searched("displaced");
    expect(calls).toBe(SEARCH_MEMO_LIMIT + 2);
    vi.unstubAllGlobals();
  });
});
