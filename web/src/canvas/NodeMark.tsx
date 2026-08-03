/**
 * A node: a small luminous point that blooms on hover and focus.
 *
 * **What a mark says is the reader's choice and no longer the zoom's.** Three
 * semantic-zoom tiers used to decide it — mark and silhouette, then + rank and
 * name at 0.55, then + age at 0.62 — and the idea was sound in the abstract and
 * wrong in this instrument. Zoom here is how you *look* at a tree: pulling back
 * to see the whole shape is the most ordinary thing a reader does, and it took
 * every name with it, while reading one name meant zooming until the tree no
 * longer fitted. Worse, the thresholds were guesses that the fit kept landing
 * either side of — the detail tier sat at 1.15 and the fit lands at 1.144 for
 * six species, so *adding a sixth species* silently stripped a row from every
 * label on screen. The lesson worth keeping is the one that cost the most:
 * nothing load-bearing may hang off a threshold the fit can wander across.
 *
 * So the rows are switched, in `chrome/LabelModes.tsx`, and the switches are
 * two rather than one for the reason the tiering had right — the age is the one
 * row the canvas already states another way, since x is time and there is a
 * ruler under it, and it is therefore the one a reader can spend and still know
 * what they are looking at. `labels` says which words (none, scientific, common)
 * and `ages` says whether the figure joins them.
 *
 * The silhouette is drawn in every state, including with the words off. Pulled
 * back the text was already too small to read and the shape was not, so the
 * image is the only thing still carrying meaning; with the words deliberately
 * off it is the *whole* label, which is most of why that state is worth having.
 *
 * Where the label actually goes is decided in `tree/labels.ts`, against every
 * other label and every trace on the canvas. This component only renders what
 * that pass hands it.
 */

import { memo, useCallback } from "react";
import { Handle, Position, type NodeProps } from "@xyflow/react";
import {
  TIER_INTERPOLATED,
  TIER_OCCURRENCE,
  TIER_STRUCTURAL,
  tierHasAge,
  type PathNode,
  type Tier,
  type Witness,
} from "../api";
import { AgeGlyph, type AgeGlyphKind } from "./AgeGlyph";
import { endedSpanLabel } from "./Bracket";
import { rankIsInformative } from "../detail/classification";
import type { LabelBox } from "../tree/labels";
import {
  branchProse,
  markName,
  UNNAMED,
  type Divergence,
  type LabelMode,
} from "../tree/naming";
import { Silhouette } from "./Silhouette";
import { fossilSpan, type Graft } from "../tree/graft";
import { flareMark } from "./biolum";

export interface MarkData extends Record<string, unknown> {
  node: PathNode;
  hue: number;
  isLeaf: boolean;
  isMRCA: boolean;
  dim: boolean;
  focused: boolean;
  flaring: boolean;
  /** Which words the label carries, and whether the age joins them. */
  labels: LabelMode;
  ages: boolean;
  /** False when the only available image is of too broad a clade to inform. */
  showSilhouette: boolean;
  /**
   * What a borrowed picture speaks for: the smallest clade holding both this
   * node and the drawing. Null when the picture is this node's own.
   */
  silhouetteClade: { name: string | null; tips: number | null } | null;
  /**
   * The witness, on a divergence that has one. When set it *replaces* the
   * silhouette above rather than joining it — see the note on `witnessTitle`.
   * Null on every leaf, because a species you chose is not a divergence.
   */
  witness: Witness | null;
  /**
   * Set on a fossil drawn against the tree rather than a node in it.
   *
   * The mark renders identically — a graft *is* an occurrence-tier node with
   * its own picture, which is why it needed no new tier and no new component —
   * but the picture's caption is a different sentence. A node's silhouette
   * says "something in this clade looks like this"; a fossil's says "this is
   * the taxon, here is when the rock has it, and here is how firmly anyone can
   * place it". `graftTitle` is that sentence.
   */
  graft: Graft | null;
  /** Resolved position, from the collision pass. Absent before it runs. */
  label: LabelBox | undefined;
  /** Set only where the taxonomy has no name and we derived one. See naming.ts. */
  divergence: Divergence | null;
  /**
   * The mark's own layout coordinate, and the mode.
   *
   * Both exist for one thing: pointing at a mark makes it flare, and the light
   * it sheds is placed in layout space by `gl/renderer.ts`. A mark otherwise
   * has no idea where it is — React Flow positions it and the component only
   * ever draws relative to itself — so the one thing it cannot work out for
   * itself is the one thing the flare needs.
   */
  x: number;
  y: number;
  biolum: boolean;
}

/**
 * Species and genus names are italic; higher taxa are roman. One rule keyed on
 * rank, and getting it wrong is visible to exactly the audience most likely to
 * share the thing.
 */
export function isScientificItalic(rank: string | null): boolean {
  return rank === "species" || rank === "genus" || rank === "subspecies";
}

/**
 * How an age may be written, which is the whole honesty question.
 *
 *   measured      "96 Ma"     — an estimate of this node
 *   interpolated  "≤ 96 Ma"   — our clade is a strict subset of the dated
 *                               one, so the dated age bounds ours above. Not
 *                               a number with unknown error: a bound.
 *   structural    null        — no number, ever. A dashed spine and an absent
 *                               figure, never a confident age where nobody
 *                               has estimated one.
 *   occurrence    null        — also no age. It has a fossil *range*, which is
 *                               a different kind of claim and is written by
 *                               `occurrenceSpan` below, never here.
 */
export const PRESENT = "present";

export function ageLabel(age: number | null, tier: Tier): string | null {
  if (!tierHasAge(tier) || age === null || !Number.isFinite(age)) return null;
  if (age < 0.05) return PRESENT;
  const n =
    age >= 100 ? Math.round(age) : age >= 10 ? age.toFixed(0) : age.toFixed(1);
  return `${tier === TIER_INTERPOLATED ? "≤ " : ""}${n} Ma`;
}

/**
 * What the rock says, for a node nobody has dated.
 *
 * *T. rex* read as nothing at all before this — no number, because none has
 * been estimated, and that is a poor answer to give someone who came to ask
 * about dinosaurs. This is the weaker claim: not when lineages parted, but
 * when the taxon is observed in the rock.
 *
 * **It is never shown bare, and that is not decoration.** In the slot an age
 * occupies, "84–66 Ma" beside a node drawn at 66 Ma reads as that node's age,
 * which is the exact thing the tier is built not to imply. Saying so first
 * costs a little width and removes the ambiguity entirely; `markAge` is what
 * guarantees this range never reaches the canvas without the fossil glyph in
 * front of it. It is a range and never a point; no midpoint is computed
 * anywhere, here or in the pipeline.
 */
export function occurrenceSpan(
  tier: Tier,
  occ: PathNode["occurrence"],
): string | null {
  if (tier !== TIER_OCCURRENCE || !occ) return null;
  const bounds = [occ.fea, occ.fla, occ.lea, occ.lla].filter(
    (v): v is number => typeof v === "number" && Number.isFinite(v),
  );
  if (bounds.length === 0) return null;
  return endedSpanLabel(Math.max(...bounds), Math.min(...bounds));
}

/**
 * The whole of what a node's label says about time, glyph and figure apart.
 *
 * One function because the canvas has one slot: a node shows an age, or a
 * fossil range, or nothing, and the three are mutually exclusive by
 * construction. It returns the parts rather than a sentence so the renderer
 * can set a mark where the words were — and so the placement pass can measure
 * a mark it cannot draw. Those two reading the same source is what keeps a
 * label from being measured at one width and drawn at another.
 */
export interface MarkAge {
  /** Stands in for a word. `null` where the figure speaks for itself. */
  glyph: AgeGlyphKind | null;
  /** Never empty. A slot holding a glyph and no figure is not an age. */
  text: string;
  /** The glyph in words, on hover. Empty where there is no glyph to explain. */
  title: string;
}

export function markAge(
  age: number | null,
  tier: Tier,
  occ: PathNode["occurrence"],
): MarkAge | null {
  const span = occurrenceSpan(tier, occ);
  if (span !== null) {
    return {
      glyph: "fossil",
      text: span,
      title: `Fossils of this taxon are found through ${span} — where it appears in the rock, not an estimate of when its lineage parted from anything.`,
    };
  }
  const label = ageLabel(age, tier);
  if (label === null || label === PRESENT) return null;
  return { glyph: null, text: label, title: "" };
}

/**
 * Is this taxon still living?
 *
 * The canvas used to answer this in the age slot, with a clock standing in for
 * the word — and `caption.test.ts` had already written down why that slot was
 * the wrong home: *"'present' is a position, not a quantity"*. Every other thing
 * in that row is a figure. This one was a fact about the taxon wearing a
 * figure's clothes, and it took the space a figure would have used.
 *
 * The first attempt at relocating it kept the clock's own condition — `age_ma`
 * under 0.05, so "drawn at the present" — and that was wrong twice over.
 * *Cetacea* and *Homo* are as alive as *Homo sapiens* is, and neither is drawn
 * at the present: a clade sits at its **crown age**, which is when it began, not
 * when it ended. And a mark meaning "this is at x ≈ 0" says only what the
 * reader can already see, which is the same objection that took the date off the
 * label in the first place.
 *
 * The signal that answers the real question is the **tier**. `occurrence` is
 * applied only where nothing below the node is alive — that is what makes it a
 * range in the rock rather than a divergence age — so it is the one place in
 * this dataset where extinction is recorded about a *node*. Everything else in
 * the synthesis tree descends to living species.
 *
 * Which is also why this is asked of chosen taxa alone (see `NodeMark`). A flag
 * true of nearly every node distinguishes nothing; asked of the handful of
 * things the reader named, it answers the question they came with. **The known
 * limit**: an OTT taxon that is extinct but carries no occurrence range reads as
 * living, because nothing in the build says otherwise. Only 0.5% of extinct OTT
 * taxa are in the synthesis tree at all, and the fossil layer is where the rest
 * of them live.
 */
export function isExtant(tier: Tier): boolean {
  return tier !== TIER_OCCURRENCE;
}

/**
 * What the picture beside a node is actually a picture of.
 *
 * Almost none of them are portraits — the corpus is 12,863 drawings against
 * 2.7M nodes — so the ordinary case is a drawing of a relative, and the honest
 * statement of that is the smallest group containing both. Naming the group
 * and its size is what earns the right to draw the picture at all: "a beetle
 * from within Elminae (987 species)" is a fact about this beetle, and the
 * reader can weigh it. The caption this replaced said "the nearest clade with
 * an image", which described our search rather than their answer.
 */
export function borrowedTitle(
  name: string,
  clade: { name: string | null; tips: number | null } | null,
): string {
  if (!clade) return `Silhouette of ${name}`;
  const size = clade.tips
    ? `${clade.tips.toLocaleString()} species`
    : "many species";
  if (!clade.name) {
    return `Not ${name} itself — a drawing of the closest relative anyone has drawn`;
  }
  // A clade of the same name is the ordinary case for an unillustrated group:
  // nobody drew Selachii, but somebody drew a shark inside it. Reading that
  // back as "from within Selachii" for a node *called* Selachii is true and
  // clumsy, so it gets its own sentence.
  if (clade.name === name) {
    return `Not ${name} itself — a drawing of one of its ${size}`;
  }
  return `Not ${name} itself — a drawing from within ${clade.name}, the smallest group holding both (${size})`;
}

/**
 * How firmly the fossil is placed, in words, or "" when there is nothing to say.
 *
 * `attachWalk` counts PBDB `parent_no` hops from the taxon to the deepest node
 * anyone can put it below. Zero is a different quality of claim from eight and
 * the caption may not flatten them: at zero the taxon is itself in the tree, so
 * the picture sits where the data says it sits; at eight the only honest
 * statement is that it belongs somewhere inside a much larger group.
 *
 * Three bands rather than a number, because the number means nothing to a
 * reader and the distinction does. Kept short — this runs inside a tooltip that
 * already carries two dates and a taxon name.
 */
export function placementNote(attachWalk: number | null): string {
  if (attachWalk === null) return "";
  if (attachWalk === 0) return " It is placed exactly here in the tree.";
  if (attachWalk <= 2) return " It is placed just below this point.";
  return " Its exact position is not known — only that it belongs below here.";
}

/**
 * What the picture beside a *divergence* is, which is a different sentence.
 *
 * `borrowedTitle` above says "not this node itself — something from within the
 * group", because that is the honest description of a borrowed exemplar. A
 * witness makes a different claim, and the caption has to carry it exactly: the
 * rock has this taxon at about the time the fork happened, and the taxon sits
 * *somewhere below* the fork. The dates are the whole of it. Without them the
 * shape is just another unlabelled silhouette, and with them a reader can see
 * that *Sahelanthropus* at 7.2–5.3 Ma sits across a split dated 6.7 — which is
 * the thing worth showing them.
 *
 * **"Below this fork", not "inside this group", and that is a real weakening.**
 * A witness used to be a node in the synthesis tree, so "one lineage from
 * inside it" was literally true. It is now a PBDB taxon that is not in the tree
 * at all, placed by walking PBDB's own classification up until something
 * resolves — architecture §3.4's *this taxon belongs somewhere below node X,
 * and existed between these dates*, and no more than that. `placementNote`
 * carries how far the walk went.
 *
 * Three forms for the time claim. Spanning the split and merely nearing it are
 * different strengths and the wording must not flatten them — but the third
 * matters more: **many witnesses sit on a fork nobody has dated.** The rule
 * falls back to where the fork is *drawn* when there is no estimate, which is
 * what makes Carnivora draw something instead of nothing. Saying "the closest
 * to when these lineages parted" there would imply we know when that was. We do
 * not, and the sentence says so instead.
 */
export function witnessTitle(
  w: Witness,
  splitAge: number | null,
  tier: Tier,
): string {
  const who = w.name ?? "A taxon from below this fork";
  const when =
    w.oldest !== null && w.youngest !== null
      ? ` known from ${endedSpanLabel(w.oldest, w.youngest)}`
      : "";
  const where = placementNote(w.attachWalk);
  const dated = ageLabel(splitAge, tier);
  if (!dated) {
    return `${who} —${when}. Nobody has dated this split, so this is the nearest fossil to where it sits on the axis, not to a known date.${where}`;
  }
  return w.spans
    ? `${who} —${when}, so it was around when these lineages parted, and this split is dated ${dated}.${where}`
    : `${who} —${when}, the closest fossil anyone has drawn to when these lineages parted, and this split is dated ${dated}.${where}`;
}

/**
 * What the picture beside a *fossil* is, which is the third of these sentences
 * and the only one that is not hedged about whose portrait it is.
 *
 * `borrowedTitle` has to explain that the drawing is of a relative;
 * `witnessTitle` has to explain that the taxon merely sits below the fork. A
 * graft's drawing is of the taxon itself — `fossil_image` matches PBDB and
 * PhyloPic on the same name and never inherits, because a fossil has no clade
 * to borrow from. So the only thing left to qualify is the *placement*, and
 * that is the whole of what this says.
 *
 * The date comes first because it is the strong claim and it is what the reader
 * came for. `placementNote` then concedes the weak one, in the same three bands
 * a witness uses — one function, so a fossil cannot describe itself one way in
 * a lane and another way on the canvas.
 */
export function graftTitle(g: Graft): string {
  const span = fossilSpan(g.fossil);
  const when = span
    ? ` is found in the rock through ${endedSpanLabel(span.oldest, span.youngest)}`
    : " has no appearance interval recorded";
  const where = placementNote(g.fossil.attach_walk ?? null);
  // Where the line meets the tree is a claim of its own and has to be read as
  // one — and the two clamped cases point in *opposite* directions, so they
  // cannot share a sentence. See `Graft.joinAt`.
  const join =
    g.joinAt === "first-appearance"
      ? " The line meets the branch at its first appearance, which is the latest its lineage can have parted."
      : g.joinAt === "anchor"
        ? " It first appears later than the point it hangs from, so its lineage parted somewhere below there, off the branches drawn here."
        : " It is older than the whole branch it hangs on, so its lineage parted earlier than anything drawn here.";
  return `${g.fossil.name}${when}. It is not a node in the tree: nobody has resolved where its lineage branches.${where}${join}`;
}

/**
 * The secondary row. Rank only.
 *
 * What an inherited silhouette actually depicts belongs on the image, not
 * beside it: as the mark's tooltip, and as a watermark over the enlarged
 * silhouette in the detail card. Spelling it out on the canvas made a label
 * wide enough to cross a whole lane and a neighbour's trace — "Carnivora ORDER
 * silhouette: Mammalia Canis lupus familiaris" was one continuous run of text —
 * in order to caption something the reader is already looking at.
 */
/*
  One predicate for "is this word a rank", shared with the card.

  This used to carry its own test, and it knew about `no rank` but not about
  `no rank - terminal` — the other string the Open Tree taxonomy files an
  unranked row under, and the one on **78,696** nodes. So the row that says what
  kind of thing this is could say `NO RANK - TERMINAL`, in small caps, above the
  name. The card's `rankIsInformative` had the full set from the day it was
  written; the canvas had a copy of half of it.
*/
export function metaLine(rank: string | null, show: boolean): string {
  if (!show || !rank || !rankIsInformative(rank)) return "";
  return rank.toUpperCase();
}

/**
 * What stands in the rank row on a node whose name we derived.
 *
 * Unnamed divergences have no rank, so the row was empty anyway — and a derived
 * name in the position every real taxon name occupies needs to declare itself.
 * `Homo / Pan` is a true description of what the node separates; it is not the
 * node's name, and nothing in the layout would otherwise say so.
 */
export const DIVERGENCE_META = "DIVERGENCE";

/** The hover tooltip that spells the derived name out. */
export function derivedTitle(divergence: Divergence): string {
  return `The last common ancestor of ${branchProse(divergence.branches)}. The Open Tree taxonomy has no name for this node.`;
}

/**
 * A derived name, rendered as its runs.
 *
 * Each taxon run is italicised on its own rank, so "Homo / Pan" gets two
 * italic genus names around a roman separator and "Homininae / Pongo" gets one
 * of each. Shared with the detail card, because the two disagreeing about
 * typography is exactly the sort of thing this audience notices.
 */
export function DerivedName({ divergence }: { divergence: Divergence }) {
  return (
    <>
      {divergence.parts.map((p, i) => (
        <span
          key={i}
          className={isScientificItalic(p.rank) ? "sci-italic" : undefined}
        >
          {p.text}
        </span>
      ))}
    </>
  );
}

export const NodeMark = memo(function NodeMark({ data }: NodeProps) {
  const d = data as unknown as MarkData;
  const n = d.node;
  const color = `hsl(${d.hue} ${n.tier === TIER_STRUCTURAL ? 24 : 70}% ${d.focused || d.isMRCA ? 74 : 60}%)`;
  const age = markAge(n.age_ma, n.tier, n.occurrence);
  /*
    The arrow rides on a taxon the reader **chose**, and never on a divergence.

    That line already exists and is already load-bearing: a leaf of the induced
    subtree is a clade they asked for and draws its own exemplar, while a fork
    draws a witness or nothing (`witness.ts`, handoff §3). It is the same
    distinction here, and it is what makes the mark say anything. *Is this still
    alive* is a question about a **thing**; a divergence is a **moment**, and a
    moment is neither alive nor extinct. Answered for every node it would also be
    true of nearly all of them and so would distinguish nothing — a canvas of
    arrows. Answered for the handful of taxa someone named, it is the question
    they came with.

    A graft is excluded because it already wears the ammonite: a fossil says what
    it is by its shape, and nothing that ended is alive anyway.
  */
  const alive = d.isLeaf && !d.graft && isExtant(n.tier);
  // The dot spells its glow as `box-shadow`, which an SVG has no equivalent of
  // — the same figures as a filter, so the two marks are lit identically.
  const glow = d.focused
    ? `drop-shadow(0 0 5px ${color})`
    : d.isMRCA
      ? `drop-shadow(0 0 4px ${color}) drop-shadow(0 0 2px hsl(${d.hue} 70% 60% / 0.5))`
      : d.isLeaf
        ? `drop-shadow(0 0 3px ${color})`
        : "none";
  /*
    The rank travels with the name rather than switching separately.

    It is one row of three and the only one that says what *kind* of thing is
    being named, and it carries `DIVERGENCE_META` — the only mark on the canvas
    saying that a derived name is derived. Without it `Homo / Pan` sits in
    exactly the position every real taxon name occupies and reads as one, which
    is why it may never be shown a tier behind the name it qualifies. Under the
    old zoom tiering it was, and between the two thresholds the canvas showed a
    made-up name with nothing to say so.

    A third switch for it would be a control whose only honest setting is on.
  */
  const showText = d.labels !== "off";
  const showAge = d.ages;
  const div = d.divergence;
  // One rule, and `describeLabel` in Graph.tsx measures against the same call.
  // A name resolved twice is a label reserved at one width and drawn at
  // another, which is the failure `labels.ts` exists to prevent.
  const display = markName(n, d.labels);
  const name = display?.text ?? div?.text ?? UNNAMED;
  // Two pictures, one slot, and which is allowed depends on how the reader got
  // here — `Graph.mayDrawExemplar` makes that call and this only renders it.
  // A clade a reader *chose* draws its exemplar, which is architecture §7's
  // case and the one a silhouette is best at: a mammal beside Mammalia says
  // something a photograph could not. The same picture beside a *fork* says
  // something false, because a borrow is nearly always a living group and the
  // fork predates it, so a divergence draws its witness or nothing at all.
  //
  // Never both. The label is already the widest thing on the canvas and two
  // images on one mark would double it — and there is nothing to combine
  // anyway, since the two are answers to different questions.
  //
  // Not gated on zoom: see the note at the top of this file.
  const witness = d.witness;
  const withSilhouette =
    witness !== null || (d.showSilhouette && Boolean(n.phylopic_id));
  const meta = div && showText ? DIVERGENCE_META : metaLine(n.rank, showText);

  /*
    The lane hue, carried separately from `color`, because on a leaf the two are
    not the same thing and the light has to follow the lane.

    `.mark.is-leaf .mark-label` sets the label column to `--ink`, so a chosen
    species' silhouette is drawn near-white — deliberately, and it is what makes
    a leaf read as brighter than a divergence. `currentColor` inside the label is
    therefore white, and a glow taken from it blew every leaf out to a white
    smear that said nothing about which lineage it was on. The hue says which
    lineage; the fill says whether you chose it. Two channels, two properties.
  */
  const markStyle = { color, "--hue": d.hue } as React.CSSProperties;

  /*
    Pointing at a mark disturbs it, and it lets go of some light.

    The same gesture already does something on this canvas — the dot scales up,
    which is the hover affordance and says *this is clickable* — so this is that
    affordance answered in the mode's own vocabulary rather than a second one.
    It is also the only thing on the canvas a reader can make happen without
    committing to anything, which for a first look is most of the point.

    It used to puff a burst of particles out into the water. It flares in place
    now, for the reason the whole mode was rebuilt: light that leaves an
    organism and drifts away is a second light source wearing the data's
    clothes. A mark that fires harder lights the snow around it by itself,
    because the snow reads the light rather than being handed any.
  */
  const puff = useCallback(() => {
    if (!d.biolum) return;
    flareMark(String(d.node.idx));
  }, [d.biolum, d.node.idx]);

  const box = d.label;
  const right = box ? box.side === "right" : d.isLeaf;
  const style: React.CSSProperties = {
    ...(right ? { left: 18 } : { right: 18 }),
    top: `calc(50% + ${box?.dy ?? 0}px)`,
    flexDirection: right ? "row" : "row-reverse",
    textAlign: right ? "left" : "right",
    // An explicit width, not a max-width. The label's containing block is the
    // 10px node box, so an absolutely-positioned element with `left: 18` has a
    // negative available width and shrink-to-fit collapses it to min-content —
    // "Canis lupus familiaris" broke onto three lines inside a box with 123px
    // of room. Rendering the exact width the placement pass measured also
    // makes the drawn box identical to the one collisions were tested
    // against, which is the property that keeps this honest.
    ...(box ? { width: box.width } : {}),
  };

  return (
    <div
      className={[
        "mark",
        d.isLeaf ? "is-leaf" : "",
        d.isMRCA ? "is-mrca" : "",
        // A fossil is not a position in the tree, and the dot has to say so
        // before the tooltip gets a chance to. See `.mark.is-graft`.
        d.graft ? "is-graft" : "",
        d.focused ? "is-focus" : "",
        d.dim ? "dimmed" : "",
      ]
        .filter(Boolean)
        .join(" ")}
      style={markStyle}
      onPointerEnter={d.biolum ? puff : undefined}
    >
      <Handle type="target" position={Position.Left} />
      <Handle type="source" position={Position.Right} />

      {/*
        A fossil gets the ammonite, not a dot.

        Every dot on this canvas is a position in the topology, and a graft is
        not one — so it may not wear the same shape, and inventing a *third*
        shape for it would leave the reader with two vocabularies to learn. The
        glyph already means "fossils" in the age slot of every occurrence-tier
        label, including this graft's own; using it as the mark makes the shape
        beside the range and the shape in the range the same shape.

        Stroked, per the note in `AgeGlyph`: a filled form beside a node is a
        silhouette, which is a claim about what the taxon looked like.
      */}
      {d.graft ? (
        <span className={`mark-fossil${d.flaring ? " flaring" : ""}`}>
          <AgeGlyph kind="fossil" />
        </span>
      ) : alive ? (
        /*
          A lineage that runs to today, drawn as an arrow into it.

          It takes the dot's own footprint rather than sitting beside it, and
          that is the constraint that chose the shape. To the right of the mark
          is where the label goes — a terminal mark asks for `right, dy: 0`
          first and gets it — so a tick out into that margin would be arguing
          with the name for the same pixels; on an internal node it would be
          drawn along the branch leaving the node and disappear into it. In the
          footprint, nothing can cover it, because the footprint is the one
          place on this canvas that is already reserved for the node.

          It points at the present, and on this canvas the present is a real
          direction: x is time and it runs to the right. So the arrow is not a
          symbol for aliveness, it is the lineage continuing off the end of what
          we can date — the same literal reading that makes a graft's dashed run
          an observed extent rather than an ornament.

          Fill and glow are the dot's, unchanged: filled means you chose it, the
          double ring means it is the MRCA. This channel is orthogonal to those
          and must stay that way — it says *when*, they say *why it is here*.
        */
        <svg
          className={`mark-alive${d.flaring ? " flaring" : ""}`}
          viewBox="0 0 12 12"
          role="img"
          aria-label="reaches the present day"
          style={{ filter: glow }}
        >
          <path
            d="M2.6 2.6 L9.4 6 L2.6 9.4 Z"
            fill={d.isLeaf || d.isMRCA ? color : "var(--void)"}
            stroke={color}
            strokeWidth={2.4}
            strokeLinejoin="round"
          />
        </svg>
      ) : (
        <span
          className={`mark-dot${d.flaring ? " flaring" : ""}`}
          style={{
            background: d.isLeaf || d.isMRCA ? color : "var(--void)",
            border: `1.5px solid ${color}`,
            // The MRCA outranks the leaves, and it was not in this chain at
            // all: every species you chose bloomed and the common ancestor —
            // the answer, and the thing this app is named after — was a flat
            // dot. The flare compensates for 620 ms and then never returns, so
            // every shared link, every screenshot and every second look showed
            // the answer as the dimmest filled mark on the canvas.
            boxShadow: d.focused
              ? `0 0 12px 3px ${color}`
              : d.isMRCA
                ? `0 0 11px 2px ${color}, 0 0 0 3px hsl(${d.hue} 70% 60% / 0.28)`
                : d.isLeaf
                  ? `0 0 7px 1px ${color}`
                  : "none",
          }}
        />
      )}

      {(showText || withSilhouette) && (
        <span
          className={`mark-label${box?.overlapped ? " crowded" : ""}`}
          style={style}
        >
          {witness ? (
            <Silhouette
              phylopicId={witness.phylopicId}
              title={witnessTitle(witness, n.age_ma, n.tier)}
            />
          ) : (
            withSilhouette &&
            n.phylopic_id && (
              <Silhouette
                phylopicId={n.phylopic_id}
                title={
                  d.graft
                    ? graftTitle(d.graft)
                    : borrowedTitle(name, d.silhouetteClade)
                }
              />
            )
          )}
          {/*
            Three rows, in the order a reader needs them: what kind of thing
            this is, which thing it is, and when.

            The age used to ride on the name's line, and on a left-hand label
            that line is right-aligned — so the figure took the space nearest
            the dot and the *name* was pushed away from the thing it names.
            "Boreoeutheria ≤ 96 Ma" reserved 139 units for a name that needs 85,
            and every one of those units is distance between a label and its own
            point. On rows of their own the label is as wide as its widest row
            instead of the sum of two. `metricsFor` reserves them the same way.
          */}
          {showText && (
            <span className="mark-text" style={{ maxWidth: box?.textMaxWidth }}>
              {meta && <span className="mark-meta">{meta}</span>}
              <span
                className="mark-name"
                title={div ? derivedTitle(div) : undefined}
              >
                {div ? (
                  <DerivedName divergence={div} />
                ) : (
                  <span
                    className={
                      // The rank the *displayed* string carries, which is null
                      // on a common name — so "Human" is roman where "Homo
                      // sapiens" is italic, and the reader can tell at a glance
                      // which kind of name they are being given on a canvas
                      // that will always be a mixture of both.
                      isScientificItalic(display?.rank ?? null)
                        ? "sci-italic"
                        : undefined
                    }
                  >
                    {name}
                  </span>
                )}
              </span>
              {showAge && age && (
                <span className="mark-age num" title={age.title || undefined}>
                  {age.glyph && <AgeGlyph kind={age.glyph} />}
                  {age.text}
                </span>
              )}
            </span>
          )}
        </span>
      )}
    </div>
  );
});
