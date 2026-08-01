/**
 * A node: a small luminous point that blooms on hover and focus.
 *
 * Semantic zoom, not scale zoom — the mark changes *what* it renders at each
 * level rather than just its size. Three tiers, per design-reference.md:
 *
 *   point        dot + silhouette
 *   label        + name (and the age, when there is one we may show)
 *   detail       + rank
 *
 * **The silhouette is in every tier, including the furthest.** The obvious
 * reading of design-reference.md puts it in the "full detail card" tier only,
 * and that is backwards for this element: pulled back, the text is already too
 * small to read and the shape is not, so the image is the *only* thing still
 * carrying meaning. Dropping it at low zoom removed information exactly when
 * it was the last information left.
 *
 * What it cost in practice: the detail threshold sat at 1.15 and the fit lands
 * at 1.144 for six species, so adding a sixth silently stripped every image
 * from the default view. Text tiers off with zoom; images do not.
 *
 * Where the label actually goes is decided in `tree/labels.ts`, against every
 * other label and every trace on the canvas. This component only renders what
 * that pass hands it.
 */

import { memo } from "react";
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
import type { LabelBox } from "../tree/labels";
import { branchProse, UNNAMED, type Divergence } from "../tree/naming";
import { Silhouette } from "./Silhouette";

export type ZoomTier = "point" | "label" | "detail";

export interface MarkData extends Record<string, unknown> {
  node: PathNode;
  hue: number;
  isLeaf: boolean;
  isMRCA: boolean;
  dim: boolean;
  focused: boolean;
  flaring: boolean;
  zoom: ZoomTier;
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
  /** Resolved position, from the collision pass. Absent before it runs. */
  label: LabelBox | undefined;
  /** Set only where the taxonomy has no name and we derived one. See naming.ts. */
  divergence: Divergence | null;
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
  const n = age >= 100 ? Math.round(age) : age >= 10 ? age.toFixed(0) : age.toFixed(1);
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
  /** Empty only for the present, which is a position and not a quantity. */
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
  if (label === null) return null;
  if (label === PRESENT) {
    return { glyph: "present", text: "", title: "Reaches the present day." };
  }
  return { glyph: null, text: label, title: "" };
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
  const size = clade.tips ? `${clade.tips.toLocaleString()} species` : "many species";
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
 * What the picture beside a *divergence* is, which is a different sentence.
 *
 * `borrowedTitle` above says "not this node itself — something from within the
 * group", because that is the honest description of a borrowed exemplar. A
 * witness makes a stronger and more interesting claim, and the caption has to
 * carry it: this taxon is inside the clade *and* the rock has it at about the
 * time the clade split. The dates are the whole of it. Without them the shape
 * is just another unlabelled silhouette, and with them a reader can see that
 * *Sahelanthropus* at 7.2–5.3 Ma sits across a split dated 6.7 — which is the
 * thing worth showing them.
 *
 * Two forms, because spanning the split and merely nearing it are different
 * strengths of claim and the wording should not flatten them.
 */
export function witnessTitle(
  w: Witness,
  splitAge: number | null,
  tier: Tier,
): string {
  const who = w.name ?? "A taxon inside this group";
  const when =
    w.oldest !== null && w.youngest !== null
      ? ` known from ${endedSpanLabel(w.oldest, w.youngest)}`
      : "";
  const dated = ageLabel(splitAge, tier);
  const at = dated ? `, and this split is dated ${dated}` : "";
  return w.spans
    ? `${who} —${when}, so it was around when these lineages parted${at}.`
    : `${who} —${when}, the closest anyone has drawn to when these lineages parted${at}.`;
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
export function metaLine(rank: string | null, detail: boolean): string {
  if (!detail || !rank || rank === "no rank") return "";
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
        <span key={i} className={isScientificItalic(p.rank) ? "sci-italic" : undefined}>
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
  const showText = d.zoom !== "point";
  const showDetail = d.zoom === "detail";
  const div = d.divergence;
  const name = n.name ?? div?.text ?? UNNAMED;
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
  const withSilhouette = witness !== null || (d.showSilhouette && Boolean(n.phylopic_id));
  const meta = div && showDetail ? DIVERGENCE_META : metaLine(n.rank, showDetail);

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
        d.focused ? "is-focus" : "",
        d.dim ? "dimmed" : "",
      ]
        .filter(Boolean)
        .join(" ")}
      style={{ color }}
    >
      <Handle type="target" position={Position.Left} />
      <Handle type="source" position={Position.Right} />

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
                title={borrowedTitle(name, d.silhouetteClade)}
              />
            )
          )}
          {showText && (
            <span className="mark-text" style={{ maxWidth: box?.textMaxWidth }}>
              <span className="mark-name" title={div ? derivedTitle(div) : undefined}>
                {div ? (
                  <DerivedName divergence={div} />
                ) : (
                  <span className={isScientificItalic(n.rank) ? "sci-italic" : undefined}>
                    {name}
                  </span>
                )}
                {age && (
                  <span className="mark-age num" title={age.title || undefined}>
                    {age.glyph && <AgeGlyph kind={age.glyph} />}
                    {age.text}
                  </span>
                )}
              </span>
              {meta && <span className="mark-meta">{meta}</span>}
            </span>
          )}
        </span>
      )}
    </div>
  );
});
