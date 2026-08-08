/**
 * The ways in, for a reader with nothing in mind: a short list of openings, each
 * a question and one press that draws the answer.
 *
 * Design rules that hold for every entry:
 *
 * - **No opening is a pair.** Three or more taxa draw an argument the nesting
 *   itself proves, which two never can. An opening may also carry outgroups that
 *   take no part in the claim and are there to give scale — never named in the
 *   copy, and not free, since the deepest sets `maxAge`.
 * - **The copy claims relationships, never dates**, because topology is exact
 *   while the ages are tiered. Say what the tree does; let the axis say when.
 * - **The array order is the running order** on both surfaces that use it. The
 *   palette does not carry openings (they replace the canvas; every palette
 *   command adds), and `palette/starters.ts`'s single-species list is chosen on
 *   different criteria — the two lists disagree on purpose.
 * - Ordered by pull on a first-time visitor: reader-in-the-picture, nameable at
 *   a glance, contradicts a belief. Not by how cleanly one draws.
 *
 * Picking constraints that cost hours to find: `node_image.climb` must be 0
 * (phase 5 gives every node an image by climbing, so "has an image" means
 * nothing); every silhouette must read at 30px; and a clade-rank taxon draws at
 * its crown age, so prefer a species at `climb` 0.
 */

import type { AxisMode } from "./tree/layout";

/**
 * One taxon in an opening: what to select and what to draw. Key and art live in
 * one object so they cannot drift. `art` is a PhyloPic id served off
 * `/v1/silhouette/{id}.svg`, so the preview needs no round trip.
 */
interface OpeningTaxon {
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
   * The selection, in reading order: the pair that makes the point first, the
   * taxon that loses the argument last, rulers after. The whole set is drawn in
   * one press, so this is the order of the silhouettes in the preview and of
   * the rows in the Taxa list — not of anything the canvas animates.
   */
  taxa: readonly OpeningTaxon[];
  /**
   * The scale this one reads best on. Omitted means linear (the default). Only
   * the opening whose ages span an order of magnitude sets symlog.
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
    // Two fish everybody can name, and one thing that plainly is not one: you
    // join the salmon at Euteleostomi, the shark only at Gnathostomata. The sea
    // star and jellyfish are outgroups, giving scale to what would otherwise be
    // one tight cluster.
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
        // *Pelagia noctiluca* rather than *Aurelia* (same MRCA): *Aurelia* is
        // drawn from above and reads as a second sea star, and other candidates
        // dissolve to fuzz at 30px. The mauve stinger has a solid bell.
        key: "ott34592",
        art: "9ecd443a-dc7f-48f2-8ecf-33d73f24f1b7",
        label: "mauve stinger",
      },
    ],
  },
  {
    // The meerkat is the rest of the fact, not decoration: hyenas are nearer
    // mongooses and civets than anything canine, so it adds a rung below the
    // lion. The dog is the domestic subspecies on purpose (here the dog *is* the
    // question), which costs the `structural` dashed branch of an undated taxon.
    id: "hyena",
    question: "Is a hyena a kind of dog?",
    reveal:
      "It joins the lion, and the meerkat, while the dog is still outside all three. The dog shape is borrowed; the family is the cats'.",
    taxa: [
      {
        key: "ott397157",
        art: "a160fd31-c6ba-4bd1-b2a1-dbd77014139d",
        label: "spotted hyena",
      },
      {
        key: "ott563151",
        art: "e2015ba3-4f7e-4950-9bde-005e8678d77b",
        label: "lion",
      },
      {
        key: "ott803645",
        art: "71cc5f62-d26d-4ea9-8637-c8ac39ea1533",
        label: "meerkat",
      },
      {
        key: "ott247333",
        art: "4d83a0cd-cf06-4a32-9a5a-0a6b644158c1",
        label: "dog",
      },
    ],
  },
  {
    // *Desmodus rotundus* (vampire bat) is a species at the present drawn
    // wings-out, where every flying fox is a roosting blob at carousel size. The
    // moose stands in for the horse, whose only `climb` 0 artwork is headlined
    // "Tarpan"; the antlers also make it unmistakable at tile size.
    id: "bat",
    question: "Is a bat a flying mouse, or a flying moose?",
    reveal:
      "The moose, absurdly. The bat joins it while the mouse is still outside both of them.",
    taxa: [
      {
        key: "ott238431",
        art: "21180755-3394-40bf-93eb-810954c0f7ba",
        label: "vampire bat",
      },
      {
        key: "ott460509",
        art: "df2d0ad0-adb0-49d7-afe5-edc6cad21064",
        label: "moose",
      },
      {
        key: "ott542509",
        art: "92989e35-4e68-4a2d-b3a2-191ba9da671a",
        label: "house mouse",
      },
    ],
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
    // Two brackets at clearly different depths that join once. Polar bear rather
    // than brown bear: both give the identical Ursidae MRCA, but the brown bear
    // and the raccoon are the same dark lump at this size.
    id: "panda",
    question: "Are the two pandas related?",
    reveal:
      "Barely. The giant panda joins the polar bear; the red panda leaves with the raccoon. One name, two families.",
    taxa: [
      {
        key: "ott872573",
        art: "4b1f7a58-8713-4d6e-a130-4c8a1ac2f749",
        label: "giant panda",
      },
      {
        key: "ott10732",
        art: "c11b4873-aa21-4394-9f5e-6996033c379f",
        label: "polar bear",
      },
      {
        key: "ott872562",
        art: "02990f6d-82d3-45a9-b85e-99deb69d2a96",
        label: "red panda",
      },
      {
        key: "ott348040",
        art: "52193065-f85e-4e4d-a677-11d08aed8c2e",
        label: "raccoon",
      },
    ],
  },
  {
    // The one opening that asks for symlog, whose ages span an order of
    // magnitude (6.7 Ma for us and the chimp against ~83 where the pairs join).
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
    // The orca and bottlenose are the same dark torpedo at 30px, which here
    // illustrates the answer (the orca is one of these) rather than colliding.
    id: "orca",
    question: "Is a killer whale a whale?",
    reveal:
      "It is a dolphin. It joins the bottlenose while the blue whale stays outside — the name is about size, not family.",
    taxa: [
      {
        key: "ott124215",
        art: "880129b5-b78b-40a9-88ad-55f7d1dc823f",
        label: "orca",
      },
      {
        key: "ott124230",
        art: "0b5c6b41-3a44-4c9e-869a-63ed54bf7c65",
        label: "bottlenose dolphin",
      },
      {
        key: "ott226190",
        art: "16969246-31e0-48e3-90ff-cad9a8746073",
        label: "blue whale",
      },
    ],
  },
  {
    // Three insects that stay distinguishable at 30px. *Blaberus giganteus*
    // rather than the familiar American roach (whose hairline antennae go to
    // fuzz) and species-rank termite/ant, both `climb` 0.
    id: "termite",
    question: "Is a termite a kind of ant?",
    reveal:
      "It is a cockroach. The termite and the roach join while the ant is still on the far side of the tree.",
    taxa: [
      {
        key: "ott362113",
        art: "c44be6d9-6398-4753-84db-9609760fd37c",
        label: "termite",
      },
      {
        key: "ott889607",
        art: "5103e59a-304b-454f-b2d5-ded3d64088d2",
        label: "cockroach",
      },
      {
        key: "ott744114",
        art: "efecbd35-8143-40a7-9163-ea3120caa15b",
        label: "wood ant",
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
    // The rhino is the foil the reader expects to win. *Elephas maximus* (a
    // clean profile) rather than *Loxodonta*, whose flared-tusk front view reads
    // as an insect totem. The hyrax is the one clade-rank taxon here, a
    // deliberate exception: the only hyrax species drawing is stipple-shaded and
    // turns to mush at tile size, so a clade with a clean silhouette is used.
    id: "elephant",
    question: "What is an elephant's closest living relative?",
    reveal:
      "Not the rhino. A manatee joins the elephant first, and so does a hyrax — an animal you could hold in two hands.",
    taxa: [
      {
        key: "ott541928",
        art: "7c9ab182-175d-4f02-96d0-09c1e5212bff",
        label: "Asian elephant",
      },
      {
        key: "ott226178",
        art: "12597d6c-9c80-4510-9826-975eabddc597",
        label: "manatee",
      },
      {
        key: "ott285368",
        art: "bae84fd8-937a-4390-b123-0a22bfcd7df7",
        label: "tree hyrax",
      },
      {
        key: "ott1034198",
        art: "55b24c01-3552-4c09-a485-087e4d2c4889",
        label: "white rhino",
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
  {
    // *Oniscus asellus* (common woodlouse, drawn flat and segmented) rather than
    // the roly-poly, which is drawn curled and reads as a featureless oval at
    // tile size.
    id: "woodlouse",
    question: "What is a woodlouse?",
    reveal:
      "Not an insect. It joins the crab first, and the bee meets either of them only much further back — the thing under your flowerpot is a crustacean.",
    taxa: [
      {
        key: "ott731375",
        art: "fbbb6911-b3a4-46fe-96b7-0181abe4f55e",
        label: "woodlouse",
      },
      {
        key: "ott182906",
        art: "7197c71a-0653-4e82-bcbb-b156c150826a",
        label: "blue crab",
      },
      {
        key: "ott461645",
        art: "956cf95f-9cbd-459b-a457-c80ba19877a4",
        label: "honey bee",
      },
    ],
  },
  {
    // *Manis gigantea* rather than the genus (a species sits at the present).
    // The wolf rather than the dog: the canid is a supporting taxon here, so
    // there is nothing to buy with the domestic subspecies' dashed branch.
    id: "pangolin",
    question: "A pangolin looks like an armadillo. Is it one?",
    reveal:
      "No — the pangolin joins the wolf. The armadillo and the anteater are each other's kin, and the scales grew twice.",
    taxa: [
      {
        key: "ott3613427",
        art: "edf21703-0717-4b41-a175-89b55ee7966b",
        label: "giant pangolin",
      },
      {
        key: "ott247341",
        art: "5036f260-5a0d-42c5-a0bd-9eb0729e54e0",
        label: "wolf",
      },
      {
        key: "ott490538",
        art: "d52b48fc-be52-46a1-94b7-ac7790b4730c",
        label: "giant anteater",
      },
      {
        key: "ott796672",
        art: "5d59b5ce-c1dd-40f6-b295-8d2629b9775e",
        label: "armadillo",
      },
    ],
  },
  {
    // Last on purpose: the one opening whose answer most readers already have,
    // so the first to drop if the list is shortened.
    id: "koala",
    question: "Is a koala a bear?",
    reveal:
      "It joins the kangaroo. The bear is on a branch that left before either of them existed.",
    taxa: [
      {
        key: "ott327624",
        art: "8a06d489-024f-4505-8ccb-f86e84e00e75",
        label: "koala",
      },
      {
        key: "ott897696",
        art: "a55461ac-40a5-44ba-a1ce-372df579ca28",
        label: "red kangaroo",
      },
      {
        key: "ott872567",
        art: "8cab53e9-010d-4ee5-8c80-976fbdc7f46c",
        label: "brown bear",
      },
    ],
  },
];

/** The selection an opening draws. */
export function keysOf(o: Opening): string[] {
  return o.taxa.map((t) => t.key);
}

/**
 * What to offer once one has been drawn: the next in array order, wrapping.
 * Here rather than in the flyout so the order stays this file's single claim.
 * Null only for a list too short to have a next.
 */
export function nextOpening(o: Opening): Opening | null {
  const at = OPENINGS.findIndex((x) => x.id === o.id);
  if (at < 0 || OPENINGS.length < 2) return null;
  return OPENINGS[(at + 1) % OPENINGS.length] ?? null;
}
