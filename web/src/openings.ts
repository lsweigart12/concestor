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
 * **Every opening proves itself by nesting**, and there is no exception. One
 * was tried — see the note on *T. rex* below — and taken out again precisely
 * because its proof was a horizontal position instead.
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
 * Each was verified against the baked arrays rather than against the internet.
 *
 * **The array order is the running order**, on both surfaces that use it — the
 * carousel on the empty canvas starts at the first and auto-advances through
 * the rest, and the one in the about panel opens on the same first question.
 * The command palette does not carry them at all: an opening *replaces* the
 * canvas where every command there adds to it, and the carousel is already
 * showing these same questions, larger and with their silhouettes, on the one
 * surface where the palette could safely have offered them. It is ranked
 * by **pull on a first-time visitor**, which is emphatically not the same axis
 * as how cleanly one verifies or draws: the woodlouse and the pangolin are two
 * of the best-drawn openings here and sit near the bottom, because both ask the
 * reader to already care about the animal in the question.
 *
 * What earns a place near the top, in the order the weights actually fell:
 *
 * 1. **The reader is in the picture.** *Are you a fish?* is first and stays
 *    first. A question about *you* needs no other hook, which is also why the
 *    chimp and the mushroom sit above better-drawn openings below them.
 * 2. **Every animal is nameable without help.** A tile is glanced at, not
 *    studied. Hyena, lion, dog, bat, moose, mouse cost the reader nothing; hyrax,
 *    manatee and pangolin cost them a beat, and that beat is where a rotating
 *    carousel loses people.
 * 3. **It contradicts something they already believe.** Better than filling a
 *    blank. *Is a termite a kind of ant?* beats a question the reader has no
 *    opinion about, and it is why the koala is **last**: almost everyone
 *    already knows a koala is not a bear, so it is the one opening here whose
 *    answer confirms rather than surprises. It is the first to drop if this
 *    list is ever shortened.
 *
 * One tie-break was applied on top of that ranking and is worth knowing before
 * re-sorting: the crocodile is lifted above the panda purely to break a run of
 * four mammals at positions two to five. Pull is near-identical across that
 * band and the rotation reads better with a reptile in it. Nothing else in the
 * order is aesthetic.
 *
 * **Rung positions below are quoted as a share of the span**, `age / deepest
 * rung`. That model reproduces this file's own recorded fish figures — 5.0 /
 * 19.2 / 12.6 %, and 7.3 % with the outgroups pulled — so a new opening can be
 * measured without opening the app, and then looked at anyway.
 *
 * **Three constraints decided more picks here than the facts did**, and all
 * three cost hours to find rather than to apply:
 *
 * 1. **`node_image.climb` must be 0.** Phase 5 resolves an image for all 2.7M
 *    nodes by climbing to a relative, so "has an image" is true of everything
 *    and means nothing. This is the cheap check and it is not the hard one.
 * 2. **Look at every silhouette at thirty pixels**, the size the carousel
 *    draws. Most of this corpus is drawn to be read large, and the failures are
 *    not subtle once seen: gliding and roosting poses go to blobs, stipple
 *    shading goes to grey, hairline antennae and tentacles dissolve. This test
 *    rejected more candidate taxa than every other rule combined, and one whole
 *    opening — see the barnacle below.
 * 3. **A clade-rank taxon is drawn at its crown age, not at the present.** A
 *    genus is a legal selection and its mark lands mid-plot, which reads as a
 *    living group that stopped. Prefer a species wherever one exists at `climb`
 *    0; the hyrax is the single considered exception and says why in place.
 *
 * A fourth is worth knowing but did not change a pick: **a `structural`-tier
 * tip draws a dashed branch.** Only *Canis lupus familiaris* is one here. The
 * dash is correct — nobody dated the subspecies — and the hyena and pangolin
 * openings resolve it in opposite directions, each explaining why.
 *
 * **Four candidates were verified true and are still not here.** They are worth
 * as much as the ones that shipped, because each fails for a reason that will
 * recur:
 *
 * - **A horseshoe crab is a spider's kin, not a crab's.** Chelicerata is 542.8
 *   Ma and Arthropoda 546.6, so the two rungs land **0.7 %** apart: the nesting
 *   is real and invisible. No third taxon helps, because the outer node is
 *   Arthropoda whichever one you pick, and the log axis makes it worse rather
 *   than better — log expands the recent end, and both rungs are at the far one.
 * - **A snake is a kind of lizard.** The same failure at **3.0 %**, and the
 *   iguana and the gecko are the same silhouette besides.
 * - **A barnacle is a crustacean rather than a shellfish.** The geometry is
 *   fine. Every barnacle drawing in the corpus fails at thirty pixels — the
 *   goose barnacle is a vertical squiggle, `Cirripedia` a feathery fan — and
 *   the limpet foil is drawn from above, which is the *Aurelia* failure this
 *   file already records. The one acorn barnacle in OTT is `climb` 16.
 * - **An elephant shrew is nearer an elephant than a shrew.** The best hook of
 *   the lot and there is no drawing to hang it on: all the Macroscelidea
 *   artwork sits on clade nodes, *Elephantulus* is `climb` 1 and *Macroscelides
 *   proboscideus* `climb` 2. It needs a new PhyloPic, not a new argument.
 *
 * **"*T. rex* lived closer to us than to *Stegosaurus*" is not here, and the
 * reason is not the data.** It was cut once as false — *Stegosaurus*'s last
 * appearance read 93.9 Ma, not the textbook ~150, so the gap was 27.9 against
 * 66. That was a `Stegosaurus sp.` occurrence in the Mussentuchit Member
 * carrying the genus 50 Myr into the Cenomanian, and it is fixed: `lla_drawn`
 * is 143.1 against *T. rex*'s uncorrected 66.0, the gap is 77.1 against 66.0,
 * and the claim is **true**. It was built, verified on build
 * `45ada2238ded2c93`, and removed anyway.
 *
 * It was removed because it is **not a claim about phylogeny**. It compares two
 * species' ages, which this app can show but is not for — handoff.md §1 puts
 * the time axis behind identifying an MRCA and drawing the tree, and every
 * other opening here answers *who is related to whom*. It also draws badly: the
 * proof is three dots at different points on one line, with none of the nesting
 * that makes the others legible at a glance.
 *
 * So do not re-derive it. The data supports it, the product does not, and those
 * are different questions. What is worth keeping is the near miss: **a claim is
 * only as stable as the column it rests on** — this one is true on `lla_drawn`
 * and false on raw `lla`, which still holds PBDB's 93.9 by design and always
 * will.
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
   * The selection, in order — and **the order is the running order.**
   *
   * The pair that makes the point goes first and the taxon that loses the
   * argument goes last, with any ruler after that. `state/sequence.ts` draws
   * them one at a time in exactly this order, so the nesting arrives as an
   * argument rather than as a finished shape: you and the salmon meet, and only
   * then does the shark arrive outside both. Reordering these is reordering
   * what the canvas says, not just which mark the add animation leaves from.
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
    // The best-drawn opening in the file, and worth reading before adding one.
    //
    // Three rungs at 40.3 / 26.1 / 33.6 % of the span, all three `measured`, so
    // all three print a real number rather than a bound. The app's own derived
    // name for the outer fork is *Caniformia / Feliformia* — dog-form against
    // cat-form — so the canvas states the claim in Latin without being asked.
    //
    // The meerkat is not an outgroup and is not decoration: it is the rest of
    // the real fact. Hyenas are nearer mongooses and civets than they are to
    // anything canine, and with the meerkat on screen the staircase has a rung
    // *below* the lion as well as above it.
    //
    // **The dog is the domestic subspecies on purpose, and it costs a dashed
    // branch.** *Canis lupus familiaris* is `structural` — it carries no
    // chronogram date — so its terminal edge renders as `guessed` beside four
    // solid ones. *Canis lupus* is `measured`, gives identical MRCAs and draws
    // uniformly, and is what the pangolin opening below uses. It is refused
    // here because here the dog *is* the question: "is a hyena a kind of wolf"
    // is not a thing anybody wonders. The dash is the app being accurate about
    // a subspecies nobody dated, which is a different thing from a defect.
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
    // The tightest key rung here — 17.9 % against the fish opening's 5.0 % — and
    // still comfortable. Both picks took work and neither is the obvious one.
    //
    // **Every species-rank flying fox is drawn roosting or mid-flap**, so it is
    // a hanging blob at carousel size; the only spread-wing bat in *Pteropus*
    // belongs to the genus. *Desmodus rotundus* is a species, sits at the
    // present, and is drawn wings-out. That it is the vampire bat is a bonus
    // rather than the reason.
    //
    // **The moose is standing in for the horse**, which is the version of this
    // fact that circulates. The horse is out for a hard reason: the only horse
    // artwork at `climb` 0 belongs to *Equus ferus*, which OTT headlines
    // **"Tarpan"**, so the canvas would caption a horse with a word the reader
    // has never seen — the same mistake the coelacanth made in the fish
    // opening. The moose is the only taxon in this file picked partly for the
    // sound of it, and it earns the place anyway: at carousel size the antlers
    // make it the one animal here that cannot be mistaken for another, where
    // the cow it replaced was a second dark quadruped.
    //
    // It carries a smaller version of the Tarpan problem and is kept regardless.
    // OTT headlines *Alces alces* **"Elk"** — which in Europe *is* the moose and
    // in North America is a different deer entirely — so a reader who follows
    // the joke as far as the detail card meets a name that is ambiguous rather
    // than unknown, which is the survivable half of that failure. *Alces
    // americanus* is the one OTT calls "moose", and it is `climb` 1 carrying
    // this same borrowed drawing, so rule 1 at the top of this file rules it
    // out. The question and the tile both say moose, and that is where the joke
    // has to work.
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
    // The *two-pair* shape at its best: two brackets at clearly different
    // depths that join once. Rungs at 39.5 / 31.6 / 28.9 %, the most even
    // spread in the file. The pangolin below is the same shape and shows what
    // this one is avoiding — there the two brackets sit 6.8 % apart and read as
    // a single depth, which still proves the claim but stops illustrating it.
    //
    // The polar bear rather than the brown bear, and the reason is the drawing
    // rather than the animal. Both give the identical Ursidae MRCA. At the size
    // this is drawn the brown bear and the raccoon are the same dark lump, and
    // an opening whose whole argument is *which two of these four go together*
    // cannot afford two of them to be indistinguishable.
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
    // The best-spread geometry in the file — 28.1 / 71.9 % — and the weakest
    // preview, which is the trade being made knowingly.
    //
    // All three are dark torpedoes, and at thirty pixels the orca and the
    // bottlenose are the same picture. There is no fix in the corpus: a
    // dolphin drawn in profile is a dolphin shape. It survives because the
    // claim is *the orca is one of these*, so two identical silhouettes are
    // closer to an illustration of the answer than to a collision — and
    // because on the canvas, which is where the argument is actually settled,
    // the marks are labelled.
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
    // Three insects that stay distinguishable at thirty pixels — spindly ant,
    // long termite, broad flat roach — which is rarer in this corpus than it
    // sounds and is why these three species and not the famous ones.
    //
    // *Blaberus giganteus* rather than *Periplaneta americana*, which is the
    // cockroach everybody can picture and gives the identical MRCAs. The
    // American roach is drawn with hairline antennae that go to grey fuzz at
    // carousel size; the *Blaberus* is a solid oval and survives it. The same
    // test rejected the two commonest termites: *Reticulitermes* is `climb` 5
    // and *Macrotermes* `climb` 4, so neither is its own drawing at all.
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
    // The rhino is the foil rather than an outgroup — it is the animal the
    // reader expects to win — and it sets the deep end at Atlantogenata either
    // way, so the hyrax rung is free. Rungs at 40.4 / 8.6 / 51.0 %: the last
    // gap is the claim, and the tight one between hyrax and manatee is only the
    // order of two things that are both already on the winning side.
    //
    // **Do not restore *Loxodonta africana*.** It is `climb` 0, it is the
    // African elephant, and its drawing is a front-on view with the tusks
    // flared that reads as an insect totem at every size tried. *Elephas
    // maximus* is a clean profile elephant and is also its own drawing. If the
    // copy ever needs the African one, the `Loxodonta` genus has a usable
    // drawing; the species does not.
    //
    // **The hyrax is the one clade-rank taxon in the file**, and it is a
    // deliberate exception to the note above about crown ages. *Procavia
    // capensis* is the only hyrax *species* whose drawing is its own, and that
    // drawing is stipple-shaded — fine at tip size on the canvas, grey mush in
    // a thirty-pixel carousel tile. *Dendrohyrax* is a clean silhouette. The
    // trade is legibility in the preview against a mark that sits at the
    // genus's crown age rather than at the present.
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
    // Rungs at 72.5 / 27.5 %, three unmistakable shapes, no crowding. This one
    // drew the cleanest of anything measured for this batch.
    //
    // *Oniscus asellus* rather than *Armadillidium vulgare*, and it is the one
    // place here where the better-known animal lost. The roly-poly is what a
    // reader has actually turned over, and it is `climb` 0 with the same MRCAs
    // — but it is drawn curled, so at carousel size it is a featureless oval
    // that could be a seed. The common woodlouse is drawn flat and segmented
    // and still reads as an animal with legs.
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
    // Two pairs again, and here the pairs sit only 6.8 % apart — close enough
    // that they read as one depth rather than as a comparison. That is fine,
    // because the comparison is not the claim: *which two of these go together*
    // is, and the brackets say it. The outer gap that does carry the claim is
    // 40.5 %.
    //
    // *Manis gigantea* rather than the *Manis* genus, which carries the same
    // drawing: a species sits at the present, the genus at its crown age.
    //
    // The wolf rather than the dog, which is the opposite of the choice made in
    // the hyena opening and for the same reason read the other way. Here the
    // canid is a supporting taxon, not the question, so there is nothing to buy
    // with the domestic subspecies' dashed branch.
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
    // Last on purpose. It verifies cleanly — 34.6 / 65.4 %, every taxon its own
    // drawing, the kangaroo and the bear unmistakable — and it is the only
    // opening here whose answer most readers already have. It earns its place
    // as the gentlest one in the rotation rather than as a surprise, and it is
    // the first thing to drop if the list ever needs shortening.
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
 * What to offer once one has been drawn.
 *
 * The array order again, wrapping — the same running order the carousel
 * advances through, so a reader who arrives by the front door and a reader who
 * keeps pressing *Next* meet these in the same sequence and neither is shown
 * the question they have just answered. It lives here rather than in the
 * flyout that renders it because the order is this file's claim, ranked by pull
 * on a first-time visitor, and a second surface deciding its own order would be
 * a second ranking nobody wrote down.
 *
 * Returns null only for a list too short to have a next, which this one is not.
 */
export function nextOpening(o: Opening): Opening | null {
  const at = OPENINGS.findIndex((x) => x.id === o.id);
  if (at < 0 || OPENINGS.length < 2) return null;
  return OPENINGS[(at + 1) % OPENINGS.length] ?? null;
}
