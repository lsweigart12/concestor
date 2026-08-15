/**
 * The four-species hominin view, which is where this was reported.
 *
 * `/?n=770315,83926,417950,3607671` — human, Neanderthal, chimpanzee, *Homo
 * erectus* — drew two nodes both labelled "unnamed divergence", and the split
 * a reader most wants (Neanderthal from human) drawn on top of the human node
 * at zero length. The indices and names below were read back from `/v1/paths`
 * on the 2026-07-31 build, and are kept as a frozen fixture: that build filed
 * Neanderthals as a subspecies inside *Homo sapiens*, a shape the
 * infraspecific collapse has since removed, but the naming and layout rules
 * pinned here must hold for any nested or zero-length divergence.
 */

import { describe, expect, it } from "vitest";
import type { PathNode } from "../api";
import { induced } from "./induced";
import { layout } from "./layout";
import {
  branchProse,
  commonName,
  divergenceFor,
  markName,
  UNNAMED,
} from "./naming";

/** idx → [name, rank]. Everything else on the node is irrelevant here. */
const NAMED: Record<number, [string, string | null]> = {
  594474: ["Homininae", "subfamily"],
  594480: ["Homo", "genus"],
  594485: ["Homo sapiens", "species"],
  594486: ["Homo sapiens neanderthalensis", "no rank"],
  594490: ["Homo erectus", "no rank"],
  594504: ["Pan", "genus"],
  594505: ["Pan troglodytes", "species"],
};

/** Positions on the axis, so the layout assertions are about real geometry. */
const AGE: Record<number, number> = {
  594474: 9.1847,
  594475: 6.7358,
  594480: 3.3679,
  594482: 2.0207,
  594490: 0.7484,
  594504: 2.1508,
};

const HOMO_SAPIENS = 594485;
const NEANDERTHAL = 594486;
const ERECTUS = 594490;
const CHIMP = 594505;
/** `mrcaott83926ott84217` — the human/chimp split. */
const HOMININI = 594475;
/** `mrcaott83926ott3607671` — erectus from the sapiens line. */
const ERECTUS_SPLIT = 594482;

/**
 * The rank-1 common name the server would send, for the nodes that have one.
 *
 * Read off the 2026-07-31 build. *Homo sapiens* is `Human` and not `humans`,
 * which is the phase's own headline; *Homo* the genus has no ranked English
 * name at all, which is why "Homo / Pan" survives a switch to common names.
 */
const COMMON: Record<number, string> = {
  594485: "Human",
  594505: "Chimpanzee",
};

const node = (idx: number): PathNode => {
  const [name, rank] = NAMED[idx] ?? [null, null];
  return {
    idx,
    key: name ? `ott${idx}` : `mrca${idx}`,
    ott_id: null,
    name,
    rank,
    vernacular: COMMON[idx] ?? null,
    age_ma: null,
    age_layout: AGE[idx] ?? 0,
    tier: 2,
    tip_count: 1,
    depth: 0,
    phylopic_id: null,
    silhouette_source_idx: null,
  };
};

// Real ancestor chains, trimmed to Homininae. The unnamed run between the
// human/chimp split and the genus Homo is what makes this the interesting case.
const CHAIN = [
  594474,
  HOMININI,
  594476,
  594477,
  594478,
  594479,
  594480,
  594481,
  594482,
];
const PATHS: Record<number, number[]> = {
  [HOMO_SAPIENS]: [...CHAIN, 594483, 594484, HOMO_SAPIENS],
  [NEANDERTHAL]: [...CHAIN, 594483, 594484, HOMO_SAPIENS, NEANDERTHAL],
  [ERECTUS]: [...CHAIN, ERECTUS],
  [CHIMP]: [594474, HOMININI, 594504, CHIMP],
};

const SELECTION = [HOMO_SAPIENS, NEANDERTHAL, ERECTUS, CHIMP];
const ind = induced(SELECTION, (i) => PATHS[i]);
const nodes = new Map(
  ind.rendered.concat(...Object.values(PATHS)).map((i) => [i, node(i)]),
);

describe("naming a divergence the taxonomy does not name", () => {
  it("reads the names off the suppressed run, not off the leaves", () => {
    // `Homo` and `Pan` are both degree-2 nodes, dropped from the rendered set.
    // Taking the rendered children instead would answer "Homo sapiens / Pan
    // troglodytes" for a node that separates the two genera entire.
    const d = divergenceFor(HOMININI, ind, nodes);
    expect(d?.text).toBe("Homo / Pan");
    expect(d?.branches).toEqual(["Homo", "Pan"]);
  });

  it("abbreviates a genus it has already spelled out", () => {
    const d = divergenceFor(ERECTUS_SPLIT, ind, nodes);
    expect(d?.text).toBe("Homo sapiens / H. erectus");
    // The card still gets both in full — abbreviation is a canvas-width
    // concession, not the fact.
    expect(d?.branches).toEqual(["Homo sapiens", "Homo erectus"]);
  });

  it("italicises each run on its own rank", () => {
    const d = divergenceFor(HOMININI, ind, nodes);
    expect(d?.parts).toEqual([
      { text: "Homo", rank: "genus" },
      { text: " / ", rank: null },
      { text: "Pan", rank: "genus" },
    ]);
  });

  it("derives nothing for a node that has a name", () => {
    expect(divergenceFor(HOMO_SAPIENS, ind, nodes)).toBeNull();
  });

  it("derives nothing from a single branch", () => {
    // One name describes a lineage, not a split, and putting "Homo" over a node
    // that is not Homo is the false identity this whole module avoids.
    const solo = induced([HOMO_SAPIENS, NEANDERTHAL], (i) => PATHS[i]);
    for (const v of solo.rendered) {
      const d = divergenceFor(v, solo, nodes);
      if (d) expect(d.branches.length).toBeGreaterThanOrEqual(2);
    }
  });

  it("falls back to the honest placeholder rather than inventing one", () => {
    const bare = new Map([[HOMININI, node(HOMININI)]]);
    expect(divergenceFor(HOMININI, ind, bare)?.text ?? UNNAMED).toBe(UNNAMED);
  });
});

describe("the name a mark shows", () => {
  const at = (idx: number) => nodes.get(idx)!;

  it("keeps the scientific name unless asked for the other one", () => {
    expect(markName(at(HOMO_SAPIENS), "scientific")).toEqual({
      text: "Homo sapiens",
      rank: "species",
    });
  });

  it("gives a species the name people use, and drops the italics with it", () => {
    // `rank: null` is the italic channel. A common name set in italics claims
    // to be a scientific one, which on a canvas that is always a mixture of the
    // two is the only thing telling a reader which they are looking at.
    expect(markName(at(HOMO_SAPIENS), "common")).toEqual({
      text: "Human",
      rank: null,
    });
  });

  it("falls back silently where nothing was ranked", () => {
    // Most of a deep tree. 110,794 nodes of 2.7M carry an English name, so a
    // marker on every fallback would decorate the whole canvas.
    expect(markName(at(594480), "common")).toEqual({
      text: "Homo",
      rank: "genus",
    });
  });

  it("refuses a common name above genus, however good the name is", () => {
    // The server does not send one either; this is the second of the two
    // refusals, and it is what keeps "animals" off Metazoa when a build's
    // payload predates the first.
    const subfamily = {
      name: "Homininae",
      rank: "subfamily",
      vernacular: "great apes",
    };
    expect(commonName(subfamily)).toBeNull();
    expect(markName(subfamily, "common")).toEqual({
      text: "Homininae",
      rank: "subfamily",
    });
  });

  it("refuses a common name that is the scientific name again", () => {
    // PBDB's ColDP files the binomial itself as a vernacular for thousands of
    // taxa, which would print *Tyrannosaurus rex* in roman and call it English.
    expect(
      commonName({
        name: "Tyrannosaurus rex",
        rank: "species",
        vernacular: "Tyrannosaurus rex",
      }),
    ).toBeNull();
  });
});

describe("a derived name in common names", () => {
  it("translates the branches it can and leaves the rest in Latin", () => {
    // *Homo* and *Pan* are genera with no ranked English name, so the human /
    // chimp split reads the same in both modes. This is the case the switch
    // helps least, and a deep tree is mostly made of it.
    expect(divergenceFor(HOMININI, ind, nodes, "common")?.text).toBe(
      "Homo / Pan",
    );
  });

  it("still prefers the genus, so two species do not make it English", () => {
    // Worth pinning because it is counter-intuitive and it is the *whole*
    // reason the switch touches divergences so rarely. `firstNamed` reads the
    // suppressed run before the leaf, deliberately — a node separating the two
    // genera must not be labelled with two species — and 5,548 genera carry a
    // ranked English name against 99,960 species. Choosing human and chimp
    // alone still gives "Homo / Pan" in both modes.
    const pair = induced([HOMO_SAPIENS, CHIMP], (i) => PATHS[i]);
    expect(divergenceFor(pair.mrca, pair, nodes, "common")?.text).toBe(
      "Homo / Pan",
    );
  });

  it("italicises run by run, so one fork can carry both kinds of name", () => {
    expect(divergenceFor(ERECTUS_SPLIT, ind, nodes, "common")?.parts).toEqual([
      { text: "Human", rank: null },
      { text: " / ", rank: null },
      { text: "Homo erectus", rank: "no rank" },
    ]);
  });

  it("does not abbreviate a genus off a common name", () => {
    // `H. erectus` is a convention of scientific names. Applied to "Human" it
    // would produce "H. uman"; applied *against* it, "Homo erectus" beside
    // "Human" would abbreviate to a genus the label never spelled out.
    const d = divergenceFor(ERECTUS_SPLIT, ind, nodes, "common");
    expect(d?.text).toBe("Human / Homo erectus");
  });
});

describe("branch prose", () => {
  it("reads as a sentence", () => {
    expect(branchProse(["Homo", "Pan"])).toBe("Homo and Pan");
    expect(branchProse(["A", "B", "C"])).toBe("A, B and C");
  });
});

describe("a selection nested inside another selection", () => {
  // A selection can contain another — pick a genus and a species inside it —
  // and then the divergence between them is the outer node itself. This
  // fixture's shape is the case that found the bug: the pre-collapse build
  // filed Neanderthals as a subspecies *of* Homo sapiens, both at age 0, so
  // before the row rule changed they shared an x *and* a y: same pixel,
  // zero-length trace. The topology no longer produces that pair, but the
  // geometry is exactly what any group-plus-member pick produces today.
  it("gives the ancestor selection its own row", () => {
    const lay = layout(ind, nodes);
    const human = lay.placed.get(HOMO_SAPIENS)!;
    const neanderthal = lay.placed.get(NEANDERTHAL)!;
    expect(human.x).toBe(neanderthal.x); // x is time; it must not be nudged
    expect(human.y).not.toBe(neanderthal.y);
  });

  it("still gives every selection exactly one row", () => {
    const lay = layout(ind, nodes);
    const ys = SELECTION.map((v) => lay.placed.get(v)!.y);
    expect(new Set(ys).size).toBe(SELECTION.length);
  });

  it("leaves an ordinary view's midpoint placement alone", () => {
    const flat = induced([ERECTUS, CHIMP], (i) => PATHS[i]);
    const lay = layout(flat, nodes);
    const a = lay.placed.get(ERECTUS)!;
    const b = lay.placed.get(CHIMP)!;
    expect(lay.placed.get(flat.mrca)!.y).toBe((a.y + b.y) / 2);
  });
});
