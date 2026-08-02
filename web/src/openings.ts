/**
 * The ways in, for a reader with nothing in mind.
 *
 * The empty canvas used to say "press S and search for two species", which
 * asks for the one thing a curious reader does not have — two species, already
 * chosen, for a reason. It also described the mechanism (*the smallest tree
 * that connects them*) rather than the payoff, and nobody wants a minimal
 * subtree. They want to find out they are a fish.
 *
 * So the empty state is a short list of **openings**: a question, and one press
 * that draws the answer.
 *
 * **No opening is a pair, and that is the whole design.** A pair draws one
 * number. Three or more draw an *argument* — the nesting itself is the proof,
 * visible without reading anything. You and a salmon join; only then does the
 * shark; therefore any group holding both of those fish holds you. That
 * picture is the thing this app does that nothing else does, and two species
 * can never make it.
 *
 * An opening may also carry taxa that take no part in the claim and are there
 * to be far away. A tree of near neighbours is uniformly tight and gives the
 * reader nothing to judge tightness against; an outgroup or two turns the same
 * picture into a scale. They are never named in the copy, because a thing that
 * is visibly alone on the canvas does not need to be pointed at — and they are
 * not free, since the deepest one sets `maxAge` and compresses every rung
 * nearer the present. Measure before adding another.
 *
 * **The copy claims relationships, never dates.** Every claim below is
 * topological — *X joins Y before Z* — because topology is exact while the
 * dates are tiered: `interpolated` nodes render as `≤ N Ma` and `structural`
 * ones render no number at all. Prose promising "1.1 billion years" beside a
 * canvas drawing "≤ 1314.8 Ma" would be the app calling itself a liar, and the
 * tier system exists precisely to stop that. Say what the tree does; let the
 * axis say when.
 *
 * Each was verified against the baked arrays rather than against the internet,
 * and one popular candidate **failed and was cut**: "*T. rex* lived closer to
 * us than to *Stegosaurus*" was false as this app drew it, because PBDB's last
 * appearance for *Stegosaurus* was 93.9 Ma — not the textbook ~150 — putting
 * the gap at 27.9 Ma against 66.
 *
 * **That number was a bug, and it is fixed.** It came from a `Stegosaurus sp.`
 * occurrence in the Mussentuchit Member carrying the genus 50 Myr into the
 * Cenomanian; `young_ends` now refuses a young end no identified member
 * supports, and `fossil.lla_drawn` for *Stegosaurus* is **143.1 Ma**. *T. rex*
 * is uncorrected at 66.0, having nothing to correct. So the gap is **77.1 Ma
 * against 66.0 and the claim is true.**
 *
 * It is still not here, and the reason is the artifact rather than the fact:
 * the correction lives in phase 4 and the shipped build predates it, so a
 * canvas built today still draws *Stegosaurus* at 93.9 and would contradict
 * the copy. **Add this opening once phase 4 has been re-run** — confirm with
 * `fossil.lla_drawn`, not `fossil.lla`, which still holds PBDB's own 93.9 by
 * design.
 */

import type { AxisMode } from "./tree/layout";

/**
 * One taxon in an opening: what to select, and what to draw for it.
 *
 * The key and its artwork live in one object rather than in two parallel
 * arrays, because parallel arrays drift and the failure is silent — a
 * mismatched pair shows the reader a salmon captioned as a shark and nothing
 * throws. `art` is a PhyloPic id served straight off `/v1/silhouette/{id}.svg`,
 * so the preview needs no API round trip before the canvas has anything on it.
 */
export interface OpeningTaxon {
  key: string;
  /** PhyloPic id. All but the mushroom are the taxon's own drawing. */
  art: string;
  /** Short common name, for the silhouette's alt text. */
  label: string;
}

export interface Opening {
  id: string;
  /** The hook, as a reader would actually wonder it. */
  question: string;
  /**
   * What the drawn tree shows. A claim about branching order, so it stays true
   * whatever tier the ages land in.
   */
  reveal: string;
  /**
   * The selection, in order. Order matters only for the add animation, which
   * originates at the MRCA of what is already there — so the pair that makes
   * the point goes first and the taxon that loses the argument goes last.
   */
  taxa: readonly OpeningTaxon[];
  /**
   * The scale this one reads best on. Omitted means the default, which is
   * linear — see `DEFAULT` in `state/store.ts` for why.
   *
   * Only one opening sets it, and the rule behind that is worth keeping: a
   * comparison is interesting when its two ages are *close*, and linear is
   * where close ages separate. The exception is the opening whose ages span an
   * order of magnitude, where linear crushes the near pair against the tips and
   * symlog is the scale that can hold both ends at once.
   */
  axis?: AxisMode;
}

const HUMAN: OpeningTaxon = {
  key: "ott770315",
  art: "f46f28c7-b3da-485e-9af0-9839b63138e0",
  label: "human",
};

export const OPENINGS: readonly Opening[] = [
  {
    // Two fish everybody can name, and one thing that plainly is not one.
    //
    // An earlier cut ran the textbook version through a coelacanth, which is
    // the cleaner cladistics and the worse hook: it is a fish almost nobody can
    // picture, and OTT headlines it "Gombessa", so the canvas captioned the
    // crux of the argument with a word the reader has never seen. Salmon and
    // shark carry it unaided — you join the salmon at Euteleostomi, the shark
    // only joins at Gnathostomata, so any group holding both fish holds you.
    //
    // The sea star and the jellyfish are the ruler. Without them the picture is
    // one tight cluster with nothing to be tight *against*, and the reader has
    // no way to see that 455 and 491 Ma are near neighbours. Two of them rather
    // than one because they are at different distances, and the four rungs then
    // read as a staircase out: you and the salmon, the shark, the sea star at
    // Deuterostomia, the jellyfish beyond it.
    //
    // Measured on the linear axis, the gaps run 5.0% / 19.2% / 12.6% of the
    // plot width. The 5.0% is the cost — the same rung is 7.3% with no outgroup
    // at all, because the jellyfish sets `maxAge` and everything nearer the
    // present compresses toward it. At a full-width plot that is still about
    // fifty pixels, which is why the trade is worth making; if this opening
    // ever gains a *fifth* rung, re-measure before assuming it still is.
    //
    // Neither is mentioned in the copy. They need no caption — they are visibly
    // alone out there, which is the whole point of drawing rather than
    // explaining.
    id: "fish",
    question: "Are you a fish?",
    reveal:
      "You and the salmon meet before the shark joins either of you. Any group holding both of those fish has to hold you as well.",
    taxa: [
      HUMAN,
      {
        key: "ott688328",
        art: "f6c6590d-8aa1-4d08-a25f-e6c90727c071",
        label: "salmon",
      },
      {
        key: "ott554297",
        art: "545d45f0-0dd1-4cfd-aad6-2b835223ea0d",
        label: "great white shark",
      },
      {
        key: "ott721252",
        art: "a3dd3044-648c-4e45-93f0-21a156247132",
        label: "common sea star",
      },
      {
        // *Pelagia noctiluca* rather than *Aurelia aurita*, and the reason is
        // the drawing rather than the animal. Both are true jellies (Scyphozoa)
        // and both give the identical MRCA — idx 588412, 719.2 Ma — so nothing
        // measured above changes.
        //
        // PhyloPic's *Aurelia* is drawn from **above**: a radial starburst that
        // reads as a flower at 30px, and reads as a *second sea star* next to
        // the one already in this opening. Every other candidate is drawn in
        // profile but hangs on hairline tentacles that dissolve to grey fuzz at
        // this size — *Cyanea*, and both other *Chrysaora*. The mauve stinger
        // is the one with a solid bell and four thick, separated tentacles, so
        // it is still a jellyfish at the size it is actually drawn.
        //
        // Check any replacement at 30px before swapping it in. Most of this
        // corpus is drawn to be read large.
        key: "ott34592",
        art: "9ecd443a-dc7f-48f2-8ecf-33d73f24f1b7",
        label: "mauve stinger",
      },
    ],
  },
  {
    id: "mushroom",
    question: "When was your concestor with a mushroom?",
    reveal:
      "Further back than almost anything alive — and still nearer than the mushroom's own concestor with an oak.",
    taxa: [
      HUMAN,
      {
        key: "ott564405",
        // The one borrowed drawing here, from two hops up. It is still a
        // mushroom, which is all this preview claims.
        art: "afd875a3-815f-443b-9b93-3e5bedd9a7a3",
        label: "mushroom",
      },
      {
        key: "ott239659",
        art: "0cf6da02-014b-4cfe-bbd9-f421c206b381",
        label: "oak",
      },
    ],
  },
  {
    id: "hippo",
    question: "What is a hippo's closest living relative?",
    reveal:
      "Not the pig it looks like. The blue whale joins the hippo long after the pig has branched away.",
    taxa: [
      {
        key: "ott510762",
        art: "3769e205-b10c-4aab-affc-b4f0302f4eaa",
        label: "hippo",
      },
      {
        key: "ott226190",
        art: "16969246-31e0-48e3-90ff-cad9a8746073",
        label: "blue whale",
      },
      {
        key: "ott730013",
        art: "3d8acaf6-4355-491e-8e86-4a411b53b98b",
        label: "wild boar",
      },
    ],
  },
  {
    // The one opening that asks for symlog, and the only one whose ages span an
    // order of magnitude: 6.7 Ma for us and the chimp, 21.7 for the rodents,
    // and ~83 where the two pairs join. Linear sets the axis by that last
    // number and both comparisons land inside the right quarter with the tips.
    id: "chimp",
    question: "Who are closer cousins — you and a chimp, or a rat and a mouse?",
    reveal:
      "You and the chimpanzee. The rodents are the distant pair, by a factor of three.",
    taxa: [
      HUMAN,
      {
        key: "ott417950",
        art: "2f7da8c8-897a-445e-b003-b3955ad08850",
        label: "chimpanzee",
      },
      {
        key: "ott271555",
        art: "828a8d15-6aa9-41ab-85a3-e9e06c0f1945",
        label: "brown rat",
      },
      {
        key: "ott542509",
        art: "92989e35-4e68-4a2d-b3a2-191ba9da671a",
        label: "house mouse",
      },
    ],
    axis: "log",
  },
  {
    id: "crocodile",
    question: "What is a crocodile's nearest living kin?",
    reveal:
      "A sparrow. The Komodo dragon it resembles left the family far earlier — birds are the surviving branch.",
    taxa: [
      {
        key: "ott35864",
        art: "2fa0c118-f96c-407e-91eb-522065829f14",
        label: "Nile crocodile",
      },
      {
        key: "ott745175",
        art: "3b74c3e5-1ffa-4089-95b1-371f1b71fce0",
        label: "house sparrow",
      },
      {
        key: "ott1091028",
        art: "ce6a78bc-3ef1-4d60-ab40-113eb84c7802",
        label: "Komodo dragon",
      },
    ],
  },
  {
    id: "falcon",
    question: "Are falcons a kind of eagle?",
    reveal:
      "No — the falcon leaves alongside the macaw. Eagles and hawks were never its family; the resemblance is borrowed.",
    taxa: [
      {
        key: "ott786435",
        art: "6cebf754-cb71-448d-a5bb-947157205264",
        label: "peregrine falcon",
      },
      {
        key: "ott851014",
        art: "0d19238f-25ca-42a5-a1e2-d108defb75f1",
        label: "scarlet macaw",
      },
      {
        key: "ott263127",
        art: "b2b60a18-fd7d-49b2-a15d-54a62cdcac6b",
        label: "golden eagle",
      },
    ],
  },
];

/** The selection an opening draws. */
export function keysOf(o: Opening): string[] {
  return o.taxa.map((t) => t.key);
}
