/**
 * The four-species hominin view, which is where this was reported.
 *
 * `/?n=770315,83926,417950,3607671` — human, Neanderthal, chimpanzee, *Homo
 * erectus* — drew two nodes both labelled "unnamed divergence", and the split
 * a reader most wants (Neanderthal from human) drawn on top of the human node
 * at zero length. The indices and names below are the real baked arrays, read
 * back from `/v1/paths` on the 2026-07-31 build.
 */

import { describe, expect, it } from "vitest";
import type { PathNode } from "../api";
import { induced } from "./induced";
import { layout } from "./layout";
import { branchProse, divergenceFor, UNNAMED } from "./naming";

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

const node = (idx: number): PathNode => {
  const [name, rank] = NAMED[idx] ?? [null, null];
  return {
    idx,
    key: name ? `ott${idx}` : `mrca${idx}`,
    ott_id: null,
    name,
    rank,
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
const CHAIN = [594474, HOMININI, 594476, 594477, 594478, 594479, 594480, 594481, 594482];
const PATHS: Record<number, number[]> = {
  [HOMO_SAPIENS]: [...CHAIN, 594483, 594484, HOMO_SAPIENS],
  [NEANDERTHAL]: [...CHAIN, 594483, 594484, HOMO_SAPIENS, NEANDERTHAL],
  [ERECTUS]: [...CHAIN, ERECTUS],
  [CHIMP]: [594474, HOMININI, 594504, CHIMP],
};

const SELECTION = [HOMO_SAPIENS, NEANDERTHAL, ERECTUS, CHIMP];
const ind = induced(SELECTION, (i) => PATHS[i]);
const nodes = new Map(ind.rendered.concat(...Object.values(PATHS)).map((i) => [i, node(i)]));

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

describe("branch prose", () => {
  it("reads as a sentence", () => {
    expect(branchProse(["Homo", "Pan"])).toBe("Homo and Pan");
    expect(branchProse(["A", "B", "C"])).toBe("A, B and C");
  });
});

describe("a selection nested inside another selection", () => {
  // OTT files Neanderthals as a subspecies *of* Homo sapiens, so the divergence
  // between them is the human node itself. Both sit at age 0, so before the row
  // rule changed they shared an x *and* a y: same pixel, zero-length trace.
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
