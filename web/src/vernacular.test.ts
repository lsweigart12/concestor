/**
 * The casing rule, tested against names this dataset actually holds.
 *
 * Every string in this file is a verbatim row from `build/concestor.db`'s
 * `vernacular` table, drawn on 2026-08-04 from the 162,466 English names in
 * build `854cdfa42f77e78e`. That is the point of it. A rule about capital
 * letters is trivially easy to test into a green state with invented strings —
 * "sea eagles", "t. rex" — and the failures that matter here are all things a
 * corpus does and an author does not think of: an abbreviated binomial carried
 * as a common name, a Zulu noun whose lowercase initial is the word, a name
 * that opens on a quote or a digit or an emoji, twelve names with accented
 * initials, and 62,747 names carrying an interior capital that must survive
 * untouched.
 *
 * {@link SAMPLE} is a reproducible random draw (seed 90, the issue number) and
 * is swept for the invariant rather than for per-string expectations, because
 * the invariant is the whole safety argument: **the result is the same length
 * and differs in at most its first character.** Anything that can be said about
 * "African elephant" surviving follows from that and needs no list.
 */

import { describe, expect, it } from "vitest";
import { normalise } from "./api";
import { displayCommonName, displayCommonNameOrNull } from "./vernacular";

// --------------------------------------------------------- the issue's rows --

/**
 * The three rows one search returns, exactly as the table stores them:
 * `Aardvark` twice and `aardvark` once, on three different taxa. This is the
 * symptom the whole change exists for.
 */
const AARDVARK = ["Aardvark", "aardvark", "Aardvark"];

/** The four names the opening panda tree draws in one column. */
const PANDA_TREE = ["Raccoon", "Giant panda", "lesser panda", "polar bear"];

// ------------------------------------------------------------- a real draw --

/**
 * Sixty rows drawn at random from the English corpus. Not curated: whatever the
 * draw returned is what is here, including the parenthetical scientific forms
 * and the author-and-year strings that the vernacular table carries alongside
 * genuine common names.
 */
const SAMPLE = [
  "map lichen",
  "Chileorebutia krausii",
  "Rio Reventador robber frog",
  "copaifera",
  "Tomigerus turbinatus",
  "ulota moss",
  "Northern Ghost Bat",
  "Antakarana Leaf Chameleon",
  "Kellet's whelk",
  "twistedhair spikemoss",
  "Black sugar palm",
  "Melicope ×mantellii",
  "Snug greenhood",
  "Central Desert Marsupial Mole",
  "Multicoloured Asian lady beetle",
  "Trypauchenopsis intermedius",
  "Orange-tailed Sprite",
  "Dicranomyia (Pseudoglochina) angustapicalis",
  "Grey-striped Brush Finch",
  "Sanford's Niltava",
  "Smaug (genus)",
  "Garden speedwell",
  "Micromeria barosma",
  "pomfret",
  "Blacknose Butterflyfish",
  "yellow-staining mushroom",
  "Tipula (Formotipula) ishana",
  "soft bodied plant beetle",
  "S. oriastra",
  "Japanese glorybower",
  "Chatham Deep-water Triplefin",
  "water arum",
  "Yosemite woolly sunflower",
  "Ancient Barklice",
  "German false tamarisk",
  "anvilhead",
  "Giant Crassula",
  "Scarlet Knight",
  "Mountain Ringlet",
  "Small Scavenger Beetle",
  "rotund boesenbergia",
  "Ortmann's Mudbug",
  "Patle katus",
  "Trimma striata",
  "Vanderhaege's Toad-headed Turtle",
  "Striped clingfish",
  "Dactylolabis (Dactylolabis) grunini",
  "Goias rocket frog",
  "Guadalcanal Uromys",
  "Mountain Treeshrew",
  "Freyastera mortenseni (Madsen, 1956)",
  "Tan leek orchid",
  "Raspailia (Raspailia) kennedyi",
  "partridge pea",
  "White-tailed blue robin",
  "cynodontium moss",
  "Peten Centipede Snake",
  "Woosnam's Broad-headed Mouse",
  "Crescent-tail wrasse",
  "Ophiomitrella sagittata Koehler, 1922",
];

describe("displayCommonName", () => {
  it("settles the three rows one search returns", () => {
    expect(AARDVARK.map(displayCommonName)).toEqual([
      "Aardvark",
      "Aardvark",
      "Aardvark",
    ]);
    expect(new Set(AARDVARK.map(displayCommonName)).size).toBe(1);
  });

  it("puts the opening tree's four labels in one case", () => {
    expect(PANDA_TREE.map(displayCommonName)).toEqual([
      "Raccoon",
      "Giant panda",
      "Lesser panda",
      "Polar bear",
    ]);
  });

  it("settles the rows the issue reported for `dog` and `tiger`", () => {
    // All six are real rows. The interior capitals in "Glassy-Winged Tiger"
    // survive, which is the half of sentence case this rule deliberately
    // refuses — see the table in `vernacular.ts`.
    expect(["Dog", "dog family", "prairie dog"].map(displayCommonName)).toEqual(
      ["Dog", "Dog family", "Prairie dog"],
    );
    expect(
      ["Tiger", "Glassy-Winged Tiger", "striped tiger"].map(displayCommonName),
    ).toEqual(["Tiger", "Glassy-Winged Tiger", "Striped tiger"]);
  });

  it("leaves an abbreviated binomial alone", () => {
    // Both are real vernacular rows. "T. Rex" would be the single most visible
    // way this rule could go wrong, and it cannot: the initial is already
    // uppercase, and nothing here touches a character it did not capitalise.
    expect(displayCommonName("T. rex")).toBe("T. rex");
    expect(displayCommonName("S. oriastra")).toBe("S. oriastra");
  });

  it("keeps the interior of a Title Cased name and of a proper noun", () => {
    for (const n of [
      "Sea eagles",
      "Pedunculate Oak",
      "Puerto Rican calisto",
      "Rocky Mountain arctic",
      "Florida Keys blackbead",
      "Western Australian golden wattle",
      "Beet Webworm Moth",
    ]) {
      expect(displayCommonName(n)).toBe(n);
    }
  });

  it("capitalises an accented initial", () => {
    // Twelve rows in the corpus have one.
    expect(displayCommonName("árbol de baquetas")).toBe("Árbol de baquetas");
    expect(displayCommonName("ñame")).toBe("Ñame");
    expect(displayCommonName("élaphode")).toBe("Élaphode");
  });

  it("refuses a lowercase initial followed by a capital", () => {
    // The corpus holds exactly one, and "UMgugudo" is not a word.
    expect(displayCommonName("uMgugudo")).toBe("uMgugudo");
  });

  it("leaves a name that does not begin with a letter", () => {
    for (const n of [
      "88 Butterfly",
      "89 butterfly",
      "4-spot Green Sailor",
      "'Hyposmochoma'",
      "🐀",
      "🦉",
    ]) {
      expect(displayCommonName(n)).toBe(n);
    }
  });

  it("does not cut an astral initial in half", () => {
    // `"🐀"[0]` is a lone surrogate; a slice built from its length would split
    // the pair and yield a replacement character rather than the emoji.
    expect([...displayCommonName("🦏")].length).toBe(1);
  });

  it("is idempotent", () => {
    for (const n of SAMPLE) {
      expect(displayCommonName(displayCommonName(n))).toBe(
        displayCommonName(n),
      );
    }
  });

  it("changes at most the first character, over a real sample", () => {
    for (const n of SAMPLE) {
      const out = displayCommonName(n);
      expect(out).toHaveLength(n.length);
      // The tail is untouched, character for character. This is what protects
      // every proper noun in the corpus without a lexicon holding any of them.
      expect(out.slice(1)).toBe(n.slice(1));
    }
  });

  it("leaves nothing in the sample lowercase-initial", () => {
    const stillLower = SAMPLE.map(displayCommonName).filter((n) => {
      const c = n.slice(0, 1);
      return c === c.toLowerCase() && c !== c.toUpperCase();
    });
    expect(stillLower).toEqual([]);
  });

  it("handles the empty string", () => {
    expect(displayCommonName("")).toBe("");
  });
});

describe("displayCommonNameOrNull", () => {
  it("passes absence through", () => {
    expect(displayCommonNameOrNull(null)).toBeNull();
    expect(displayCommonNameOrNull(undefined)).toBeUndefined();
    expect(displayCommonNameOrNull("polar bear")).toBe("Polar bear");
  });
});

// ------------------------------------------------------- applied at the door --

/**
 * The rule is applied at `api.ts`'s boundary rather than at the six places that
 * print a common name, so what needs pinning is that every response shape
 * carrying one goes through it. These are the shapes; a seventh surface added
 * later inherits the rule for free, which is the reason for the placement.
 */
describe("normalise cases every vernacular it carries", () => {
  it("cases a path node", () => {
    const body = normalise("/v1/path/ott770315", {
      path: [
        {
          idx: 1,
          name: "Ursus maritimus",
          rank: "species",
          tier: 0,
          vernacular: "polar bear",
        },
      ],
    }) as { path: { vernacular: string }[] };
    expect(body.path.map((n) => n.vernacular)).toEqual(["Polar bear"]);
  });

  it("cases a search row", () => {
    const body = normalise("/v1/search?q=panda", {
      results: [
        { key: "ott1", vernacular: "lesser panda" },
        { key: "ott2", vernacular: "Giant panda" },
        { key: "ott3", vernacular: null },
      ],
    }) as { results: { vernacular: string | null }[] };
    expect(body.results.map((r) => r.vernacular)).toEqual([
      "Lesser panda",
      "Giant panda",
      null,
    ]);
  });

  it("cases the card's own name and its `also called` list", () => {
    const body = normalise("/v1/node/ott770315", {
      idx: 1,
      name: "Ursus maritimus",
      tier: 0,
      vernacular: "polar bear",
      vernaculars: [
        { name: "polar bear", lang: "en", preferred: true },
        { name: "ice bear", lang: "en", preferred: false },
      ],
    }) as { vernacular: string; vernaculars: string[] };
    expect(body.vernacular).toBe("Polar bear");
    expect(body.vernaculars).toEqual(["Polar bear", "Ice bear"]);
  });

  it("drops a duplicate the casing itself creates", () => {
    // No node in the current build carries two names differing only in the case
    // of the first letter — 0 of 110,794 — so this removes nothing today. It is
    // pinned because this rule is what makes the collision possible at all, and
    // "Aardvark · Aardvark" under one card would be a fault of its own making.
    const body = normalise("/v1/node/ott1", {
      idx: 1,
      tier: 0,
      vernaculars: [
        { name: "Aardvark", lang: "en", preferred: true },
        { name: "aardvark", lang: "en", preferred: false },
        { name: "antbear", lang: "en", preferred: false },
      ],
    }) as { vernaculars: string[] };
    expect(body.vernaculars).toEqual(["Aardvark", "Antbear"]);
  });

  it("keeps the server's order", () => {
    // The order is `usage_rank` and is decided three layers away, in the
    // pipeline. Casing must not be an excuse to touch it.
    const body = normalise("/v1/node/ott1", {
      idx: 1,
      tier: 0,
      vernaculars: [
        { name: "zebu", lang: "en", preferred: true },
        { name: "Domestic Cattle", lang: "en", preferred: false },
        { name: "aurochs", lang: "en", preferred: false },
      ],
    }) as { vernaculars: string[] };
    expect(body.vernaculars).toEqual(["Zebu", "Domestic Cattle", "Aurochs"]);
  });
});
