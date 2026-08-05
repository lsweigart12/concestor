/**
 * Both lineages below are the real `/v1/path` responses, read back from the
 * 2026-08-02 build. They are chosen as the two ends of the range a card has to
 * survive: *Felis catus* has a complete ladder and *Homo sapiens* has a hole in
 * the middle of one, and it is the hole the display exists to be honest about.
 */

import { describe, expect, it } from "vitest";
import type { PathNode } from "../api";
import { lineageOf, rankIsInformative, rankProse } from "./classification";

/** Everything a `PathNode` carries beyond the name and rank is irrelevant here. */
function n(idx: number, name: string | null, rank: string | null): PathNode {
  return {
    idx,
    key: `idx:${idx}`,
    ott_id: null,
    name,
    rank,
    age_ma: null,
    age_layout: 0,
    tier: 2,
    tip_count: 1,
    depth: 0,
    phylopic_id: null,
    silhouette_source_idx: null,
  };
}

/**
 * The human lineage as the synthesis tree actually holds it.
 *
 * *Primates* is `no rank`, and there is **no Hominidae node** — it did not
 * survive synthesis. So this path has a domain, a kingdom, a phylum, a class
 * and a genus, and no order and no family between them.
 */
const HUMAN: PathNode[] = [
  n(0, "cellular organisms", "no rank"),
  n(1, "Eukaryota", "domain"),
  n(588405, null, null),
  n(588406, "Opisthokonta", "no rank"),
  n(588409, "Metazoa", "kingdom"),
  n(588413, "Bilateria", "no rank"),
  n(588416, "Chordata", "phylum"),
  n(588418, "Craniata", "subphylum"),
  n(588419, "Vertebrata", "subphylum"),
  n(588425, "Tetrapoda", "superclass"),
  n(588427, "Mammalia", "class"),
  n(588428, "Theria", "subclass"),
  n(594032, "Primates", "no rank"),
  n(594035, "Simiiformes", "infraorder"),
  n(594474, "Homininae", "subfamily"),
  n(594479, null, null),
  n(594480, "Homo", "genus"),
  n(594485, "Homo sapiens", "species"),
];

/** *Felidae* — the same trunk, and every rung present down to family. */
const CAT: PathNode[] = [
  n(0, "cellular organisms", "no rank"),
  n(1, "Eukaryota", "domain"),
  n(588409, "Metazoa", "kingdom"),
  n(588416, "Chordata", "phylum"),
  n(588427, "Mammalia", "class"),
  n(599794, "Carnivora", "order"),
  n(599795, "Feliformia", "suborder"),
  n(600888, "Felidae", "family"),
];

describe("lineageOf", () => {
  it("gives the ladder in rank order, broad to narrow", () => {
    const { ladder } = lineageOf(CAT);
    expect(ladder.map((x) => x.name)).toEqual([
      "Eukaryota",
      "Metazoa",
      "Chordata",
      "Mammalia",
      "Carnivora",
    ]);
  });

  it("excludes the node itself — a card is not part of its own classification", () => {
    const names = lineageOf(CAT).full.map((x) => x.name);
    expect(names).not.toContain("Felidae");
    expect(lineageOf(HUMAN).full.map((x) => x.name)).not.toContain(
      "Homo sapiens",
    );
  });

  it("drops the unnamed mrcaott nodes and keeps every named one", () => {
    const { full } = lineageOf(HUMAN);
    expect(full.every((x) => x.name)).toBe(true);
    // The clades that are the whole reason the full lineage is offered: none of
    // them carries a Linnaean rank, and all three are names a reader knows.
    expect(full.map((x) => x.name)).toEqual(
      expect.arrayContaining(["Bilateria", "Primates", "Opisthokonta"]),
    );
  });

  it("reports the rungs the human lineage does not have", () => {
    const { ladder, missing } = lineageOf(HUMAN);
    expect(ladder.map((x) => x.name)).toEqual([
      "Eukaryota",
      "Metazoa",
      "Chordata",
      "Mammalia",
      "Homo",
    ]);
    // Not a display quirk: the synthesis tree has no ranked order and no
    // Hominidae node at all on this path. Saying so is the honest alternative
    // to reaching for a second taxonomy to fill them in.
    expect(missing).toEqual(["order", "family"]);
  });

  it("reports nothing missing where the ladder is unbroken", () => {
    // Felidae *is* the family, so the ladder stops at order and `family` is
    // below the bottom rung rather than absent from the middle of it.
    expect(lineageOf(CAT).missing).toEqual([]);
  });

  it("does not report rungs that are off the top or bottom of the lineage", () => {
    const bare = [
      n(1, "Eukaryota", "domain"),
      n(2, "Metazoa", "kingdom"),
      n(3, "X", "phylum"),
    ];
    // `class` through `genus` all sit below the last rung present. Absent from
    // the lineage, not missing from it.
    expect(lineageOf(bare).missing).toEqual([]);
  });

  it("keeps the narrowest node when a rank repeats", () => {
    const dup = [
      n(1, "Broad", "class"),
      n(2, "Narrow", "class"),
      n(3, "Subject", "species"),
    ];
    expect(lineageOf(dup).ladder.map((x) => x.name)).toEqual(["Narrow"]);
  });

  it("has nothing to say about the root, which has no ancestry", () => {
    expect(lineageOf([n(0, "cellular organisms", "no rank")])).toEqual({
      full: [],
      ladder: [],
      missing: [],
    });
  });
});

describe("rankIsInformative", () => {
  it("refuses the Open Tree's placeholders", () => {
    // "NO RANK" beside *Primates* reads as a statement about Primates.
    expect(rankIsInformative("no rank")).toBe(false);
    expect(rankIsInformative("no rank - terminal")).toBe(false);
    expect(rankIsInformative(null)).toBe(false);
    expect(rankIsInformative("")).toBe(false);
  });

  it("accepts a real rank", () => {
    expect(rankIsInformative("family")).toBe(true);
    expect(rankIsInformative("parvorder")).toBe(true);
  });
});

describe("rankProse", () => {
  it("names the ranks rather than counting them", () => {
    // "or", because the sentence it lands in is "has no ranked …".
    expect(rankProse(["order", "family"])).toBe("order or family");
    expect(rankProse(["phylum", "class", "order"])).toBe(
      "phylum, class or order",
    );
    expect(rankProse(["family"])).toBe("family");
    expect(rankProse([])).toBe("");
    expect(rankProse(["order", "family"], "and")).toBe("order and family");
  });
});
