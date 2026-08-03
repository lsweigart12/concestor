import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AGES_DEFAULT,
  decode,
  encode,
  LABELS_DEFAULT,
  loadAges,
  loadBiolum,
  loadLabels,
  toUrlKey,
} from "./store";

/**
 * `encode` and `decode` each name the *non-default* axis explicitly, in
 * opposite directions, so flipping the default means editing both. Getting one
 * and not the other is silent and expensive: every shared link would either
 * carry a redundant `axis=` or, worse, drop the caller's choice and open on the
 * other scale. These pin the pair together.
 */
describe("axis in the URL", () => {
  it("omits the default so a plain link is the default view", () => {
    expect(encode({ ...decode(""), axis: "linear" })).toBe("/");
  });

  it("names the non-default", () => {
    expect(encode({ ...decode(""), axis: "log" })).toBe("?axis=log");
  });

  it("reads an absent axis as the default", () => {
    expect(decode("").axis).toBe("linear");
    expect(decode("?n=770315").axis).toBe("linear");
  });

  it("round-trips both modes", () => {
    for (const axis of ["linear", "log"] as const) {
      const v = { ...decode("?n=770315,417950"), axis };
      expect(decode(encode(v)).axis, axis).toBe(axis);
    }
  });

  it("keeps bioluminescence out of the link entirely", () => {
    // The inverse of the axis rule above, and deliberately so. Every other
    // member of ViewState is a claim about taxa and belongs in a link; the
    // lighting is a claim about nothing, and a reader who shares a tree should
    // not be imposing a moving canvas on whoever opens it. So it is not in
    // ViewState, `encode` cannot write it, and `decode` will not read it back —
    // including from an old link that still carries `bio=1`.
    expect(encode(decode("?bio=1"))).toBe("/");
    expect(encode(decode("?n=770315&bio=1"))).toBe("?n=770315");
    expect("biolum" in decode("?bio=1")).toBe(false);
  });

  it("keeps the selection across the round trip", () => {
    const v = decode("?n=770315,773491,688328&axis=log&sel=770315&iso=1");
    const back = decode(encode(v));
    expect(back.keys).toEqual(["770315", "773491", "688328"]);
    expect(back.axis).toBe("log");
    expect(back.selected).toBe("770315");
    expect(back.isolate).toBe(true);
  });
});

/**
 * The two label switches stay out of the link, like the light.
 *
 * The rule is what a setting is *about*. Everything `encode` writes is a claim
 * about taxa; these two are claims about the reader — which name they read a
 * taxon by, whether they want the figure — and a link carrying them imposes one
 * person's habits on somebody who did not ask. The louder half of that: a link
 * made while the labels were **off** would open on a canvas of unnamed dots,
 * with nothing on screen saying why.
 */
describe("the canvas modes are not in the link", () => {
  it("writes neither, whatever the reader chose", () => {
    expect(encode(decode(""))).toBe("/");
    expect(encode(decode("?n=770315"))).toBe("?n=770315");
  });

  it("reads neither back, including from a link that carries them", () => {
    // A link from the build that did put them there, or a hand-written one.
    // Both are answered the same way: the parameters are dropped, the taxa are
    // kept. Same treatment `bio=1` gets.
    expect(encode(decode("?names=common&ages=0"))).toBe("/");
    expect(encode(decode("?n=770315&names=off&ages=0&bio=1"))).toBe("?n=770315");
    expect("labels" in decode("?names=common")).toBe(false);
    expect("ages" in decode("?ages=0")).toBe(false);
  });
});

/**
 * A key has one spelling once it is in the store, and these pin it there.
 *
 * `ott770315` and `770315` are the same taxon, and the canvas never noticed the
 * difference because `idxOf` is asked under both. Every *mutator* did: `add`,
 * `remove` and `select` normalise their argument through `toUrlKey` and then
 * compare, so a view decoded from `?n=ott770315` could not be removed from —
 * the filter matched nothing, the mark stayed, and the card stayed open over
 * it. The invariant that fixes it is the one asserted here: a decoded key is
 * already what `toUrlKey` would make of it, so no consumer has to remember.
 */
describe("keys have one spelling", () => {
  it("strips the ott prefix off everything it reads", () => {
    expect(decode("?n=ott770315,247341&sel=ott770315")).toMatchObject({
      keys: ["770315", "247341"],
      selected: "770315",
    });
  });

  it("leaves every key that is not a bare ott id alone", () => {
    // A graft and a node we hold no key for. Both are real `sel=` values, and
    // neither is an OTT id — `pbdb108454` cannot collide with one, and
    // `idx:5` is a position in this build's arrays.
    expect(decode("?n=pbdb108454,idx:5").keys).toEqual(["pbdb108454", "idx:5"]);
    expect(decode("?sel=pbdb108454").selected).toBe("pbdb108454");
    expect(decode("?sel=idx:5").selected).toBe("idx:5");
    // Not a bare id under the prefix, so not a prefix.
    expect(decode("?n=ottelia").keys).toEqual(["ottelia"]);
  });

  it("collapses the two spellings of one taxon into one entry", () => {
    expect(decode("?n=ott770315,247341,770315").keys).toEqual(["770315", "247341"]);
  });

  it("reads an empty selection as none, rather than as the empty string", () => {
    expect(decode("?sel=").selected).toBe(null);
    expect(decode("").selected).toBe(null);
  });

  it("hands every consumer a key that is already normalised", () => {
    // The property itself, stated as `add`/`remove`/`select` state it. If this
    // holds, `keys.filter((x) => x !== toUrlKey(pressed))` cannot miss.
    const v = decode("?n=ott770315,247341,pbdb108454,idx:5&sel=ott247341");
    for (const k of v.keys) expect(toUrlKey(k), k).toBe(k);
    expect(toUrlKey(v.selected!)).toBe(v.selected);
  });

  it("round-trips a hand-written link into the compact form", () => {
    // Decoding is where the normalisation happens, so `encode` writes what the
    // app itself would have written and the second pass changes nothing.
    const once = encode(decode("?n=ott770315,ott247341&sel=ott770315&iso=1"));
    expect(once).toBe("?n=770315%2C247341&sel=770315&iso=1");
    expect(encode(decode(once))).toBe(once);
  });
});

/**
 * Each canvas mode is at its default unless this tab's own session says
 * otherwise, and these pin the two halves of that.
 *
 * Worth its own block because the failure is silent and it is the one the whole
 * design is arranged to prevent: a reader who never asked for a mode arriving in
 * it. Nothing here can be satisfied by a value that leaks in from a link, from
 * another tab, or from a previous visit — only from a deliberate
 * `sessionStorage` write in this one.
 */
describe("bioluminescence is off by default", () => {
  const stub = (store: Record<string, string>) =>
    vi.stubGlobal("sessionStorage", {
      getItem: (k: string) => store[k] ?? null,
    });

  afterEach(() => vi.unstubAllGlobals());

  it("is off for a session that has stored nothing", () => {
    stub({});
    expect(loadBiolum()).toBe(false);
  });

  it("is on only for an exact stored '1'", () => {
    // Anything else is a value this app did not write, and the benefit of the
    // doubt goes to the plain instrument rather than to the light show.
    stub({ "concestor.biolum": "1" });
    expect(loadBiolum()).toBe(true);
    for (const v of ["0", "", "true", "yes"]) {
      stub({ "concestor.biolum": v });
      expect(loadBiolum(), v).toBe(false);
    }
  });

  it("is off where storage throws, rather than undefined", () => {
    // Private browsing and blocked-storage settings throw on access. The mode
    // is optional, so losing it is free; guessing `true` here would light the
    // canvas for exactly the readers who have asked for the least.
    vi.stubGlobal("sessionStorage", {
      getItem: () => {
        throw new Error("SecurityError");
      },
    });
    expect(loadBiolum()).toBe(false);
  });
});

describe("the labels and the ages come out of this tab's session", () => {
  const stub = (store: Record<string, string>) =>
    vi.stubGlobal("sessionStorage", {
      getItem: (k: string) => store[k] ?? null,
    });

  afterEach(() => vi.unstubAllGlobals());

  it("puts a stranger on common names, with the ages on", () => {
    // The one place the *value* is pinned rather than the behaviour, because
    // this is a decision rather than a mechanism: the product is for curious
    // people rather than for biologists, so `Human` leads and `Homo sapiens` is
    // one press away. Changing it should mean editing a test that says so.
    expect(LABELS_DEFAULT).toBe("common");
    expect(AGES_DEFAULT).toBe(true);
    stub({});
    expect(loadLabels()).toBe(LABELS_DEFAULT);
    expect(loadAges()).toBe(AGES_DEFAULT);
  });

  it("reads back only the three values it writes", () => {
    for (const m of ["off", "scientific", "common"] as const) {
      stub({ "concestor.labels": m });
      expect(loadLabels(), m).toBe(m);
    }
    // Three states is the failure the booleans cannot have: a stored value this
    // app did not write has somewhere *wrong* to land, so it is looked up in
    // the list rather than compared down a chain. Asserted against the default
    // rather than against a literal — what is under test is that it lands
    // *home*, wherever home is.
    for (const v of ["vernacular", "common names", "1", "", "OFF"]) {
      stub({ "concestor.labels": v });
      expect(loadLabels(), v).toBe(LABELS_DEFAULT);
    }
  });

  it("turns the ages off only for an exact stored '0'", () => {
    // Spelled as the negative because on is the default, which is the same
    // shape as the light's rule read from the other side: a value we did not
    // write leaves the reader where a stranger starts.
    stub({ "concestor.ages": "0" });
    expect(loadAges()).toBe(false);
    for (const v of ["1", "", "off", "false"]) {
      stub({ "concestor.ages": v });
      expect(loadAges(), v).toBe(true);
    }
  });

  it("falls back to the defaults where storage throws", () => {
    // Private browsing and blocked-storage settings throw on access rather than
    // returning null. A mode that is optional by design must not take the app
    // down with it, and the default costs nothing to fall back to.
    vi.stubGlobal("sessionStorage", {
      getItem: () => {
        throw new Error("SecurityError");
      },
    });
    expect(loadLabels()).toBe(LABELS_DEFAULT);
    expect(loadAges()).toBe(AGES_DEFAULT);
  });
});
