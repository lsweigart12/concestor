/**
 * A node: a small luminous point that blooms on hover and focus.
 *
 * What a mark says is the reader's choice (`chrome/LabelModes.tsx`), not the
 * zoom's: `labels` picks the words (none, scientific, common) and `ages`
 * whether the figure joins them. The silhouette is drawn in every state,
 * including with the words off, when it is the whole label. Where the label
 * goes is decided in `tree/labels.ts`; this component only renders it.
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
import { isPresent, maFigure } from "../ages";
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
import { useTip } from "../chrome/Tooltip";
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
   * The witness, on a divergence that has one. When set it replaces the
   * silhouette rather than joining it. Null on every leaf.
   */
  witness: Witness | null;
  /**
   * Set on a fossil drawn against the tree rather than a node in it. Renders
   * identically to an occurrence-tier node, but captioned by `graftTitle`.
   */
  graft: Graft | null;
  /** Resolved position, from the collision pass. Absent before it runs. */
  label: LabelBox | undefined;
  /** Set only where the taxonomy has no name and we derived one. See naming.ts. */
  divergence: Divergence | null;
  /**
   * The mark's own layout coordinate. Needed because the flare's light is
   * placed in layout space by `gl/renderer.ts`, and a mark otherwise only draws
   * relative to itself.
   */
  x: number;
  y: number;
  biolum: boolean;
}

/** Species, genus and subspecies names are italic; higher taxa are roman. */
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
const PRESENT = "present";

export function ageLabel(age: number | null, tier: Tier): string | null {
  if (!tierHasAge(tier) || age === null || !Number.isFinite(age)) return null;
  if (isPresent(age)) return PRESENT;
  return `${tier === TIER_INTERPOLATED ? "≤ " : ""}${maFigure(age)} Ma`;
}

/**
 * What the rock says, for a node nobody has dated: when the taxon is observed,
 * not when its lineage parted. Always a range, never a point, and `markAge`
 * guarantees it never reaches the canvas without the fossil glyph in front —
 * bare, "84–66 Ma" beside a node drawn at 66 Ma reads as that node's age.
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
 * What a node's label says about time. One function because the canvas has one
 * slot: an age, a fossil range, or nothing, mutually exclusive. Returns parts
 * rather than a sentence so the placement pass can measure a mark it cannot draw.
 */
interface MarkAge {
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
 * Is this taxon still living? Keyed on the tier, not on position: `occurrence`
 * is the one tier that records extinction about a node, since it is applied
 * only where nothing below is alive. Asked of chosen taxa alone, where it
 * distinguishes something. Known limit: an extinct OTT taxon with no occurrence
 * range reads as living.
 */
export function isExtant(tier: Tier): boolean {
  return tier !== TIER_OCCURRENCE;
}

/**
 * What the picture beside a node is a picture of. Most are drawings of a
 * relative, so the honest statement names the smallest group holding both the
 * node and the drawing, and its size.
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
    return `Not ${name} itself — a drawing of the closest relative PhyloPic has`;
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
 * How firmly the fossil is placed, in words, or "" when there is nothing to
 * say. `attachWalk` counts PBDB `parent_no` hops to the deepest node it can sit
 * below; three bands, since the number means nothing to a reader.
 */
export function placementNote(attachWalk: number | null): string {
  if (attachWalk === null) return "";
  if (attachWalk === 0) return " It is placed exactly here in the tree.";
  if (attachWalk <= 2) return " It is placed just below this point.";
  return " PBDB's classification places it below here, but no closer.";
}

/**
 * What the picture beside a divergence is: a witness fossil, sitting somewhere
 * below the fork and dated to about when it happened. The dates are the whole
 * claim. Three forms, because a witness that spans the split, one that merely
 * nears it, and one on an undated fork are different strengths of claim.
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
    return `${who} —${when}. The chronogram carries no date for this split, so this is the nearest fossil to where it sits on the axis, not to a known date.${where}`;
  }
  return w.spans
    ? `${who} —${when}, so it was around when these lineages parted, and this split is dated ${dated}.${where}`
    : `${who} —${when}, the closest fossil PhyloPic has drawn to when these lineages parted, and this split is dated ${dated}.${where}`;
}

/**
 * What the picture beside a fossil is: the taxon itself (a graft never inherits
 * a drawing), so only its placement needs qualifying. Date first, then
 * `placementNote`'s three bands, shared with the witness so a fossil describes
 * itself the same way in a lane and on the canvas.
 */
function graftTitle(g: Graft): string {
  const span = fossilSpan(g.fossil);
  const when = span
    ? ` is found in the rock through ${endedSpanLabel(span.oldest, span.youngest)}`
    : " has no appearance interval recorded";
  const where = placementNote(g.fossil.attach_walk ?? null);
  // The two clamped join cases point in opposite directions, so they cannot
  // share a sentence. See `Graft.joinAt`.
  const join =
    g.joinAt === "first-appearance"
      ? " The line meets the branch at its first appearance, which is the latest its lineage can have parted."
      : g.joinAt === "anchor"
        ? " It first appears later than the point it hangs from, so its lineage parted somewhere below there, off the branches drawn here."
        : " It is older than the whole branch it hangs on, so its lineage parted earlier than anything drawn here.";
  return `${g.fossil.name}${when}. It is not a node in the tree: the Open Tree synthesis has no lineage for it.${where}${join}`;
}

/**
 * The secondary row: rank only. What an inherited silhouette depicts belongs on
 * the image (the tooltip and the card watermark), not spelled out beside it.
 * `rankIsInformative` is shared with the card so both filter `no rank` and
 * `no rank - terminal` alike.
 */
export function metaLine(rank: string | null, show: boolean): string {
  if (!show || !rank || !rankIsInformative(rank)) return "";
  return rank.toUpperCase();
}

/**
 * What stands in the rank row on a node whose name we derived. A derived name
 * like `Homo / Pan` sits where a real taxon name would, so it must declare that
 * it is not one.
 */
export const DIVERGENCE_META = "DIVERGENCE";

/** The hover tooltip that spells the derived name out. */
function derivedTitle(divergence: Divergence): string {
  return `The last common ancestor of ${branchProse(divergence.branches)}. The Open Tree taxonomy has no name for this node.`;
}

/**
 * A derived name, rendered as its runs — each taxon run italicised on its own
 * rank. Shared with the detail card so the typography cannot disagree.
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
  // The present-arrow rides on a chosen taxon (a leaf), never a divergence: a
  // divergence is a moment, neither alive nor extinct. A graft is excluded — it
  // already wears the ammonite.
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
  // The rank travels with the name (no switch of its own): it carries
  // `DIVERGENCE_META`, the only mark saying a derived name is derived, so it may
  // never lag the name it qualifies.
  const showText = d.labels !== "off";
  const showAge = d.ages;
  const div = d.divergence;
  // `describeLabel` in Graph.tsx measures against this same call — a name
  // resolved twice is a label reserved at one width and drawn at another.
  const display = markName(n, d.labels);
  const name = display?.text ?? div?.text ?? UNNAMED;
  // Two pictures, one slot, never both: a chosen clade draws its exemplar, a
  // fork draws its witness or nothing. `Graph.mayDrawExemplar` decides.
  const witness = d.witness;
  const withSilhouette =
    witness !== null || (d.showSilhouette && Boolean(n.phylopic_id));
  const meta = div && showText ? DIVERGENCE_META : metaLine(n.rank, showText);

  // `--hue` is carried separately from `color`: on a leaf the label column is
  // `--ink` (near-white), so a glow taken from `currentColor` would lose the
  // lane. The hue says which lineage; the fill says whether you chose it.
  const markStyle = { color, "--hue": d.hue } as React.CSSProperties;

  // Hooks run unconditionally; both are `undefined` on most marks, which
  // `useTip` answers with an empty props object.
  const nameTip = useTip(div ? derivedTitle(div) : undefined);
  const ageTip = useTip(showAge && age ? age.title : undefined);

  // Pointing at a mark makes it flare in place (not shed drifting particles: the
  // snow reads the mark's own light).
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
        A fossil gets the ammonite, not a dot: a graft is not a position in the
        topology, and the glyph already means "fossils" in its own age slot.
      */}
      {d.graft ? (
        <span className={`mark-fossil${d.flaring ? " flaring" : ""}`}>
          <AgeGlyph kind="fossil" />
        </span>
      ) : alive ? (
        /*
          A lineage that runs to today, drawn as an arrow into the present in the
          dot's own footprint (where nothing can cover it). x is time running
          right, so the arrow reads literally: the lineage continuing off the end
          of what we can date. Fill and glow stay the dot's — this says *when*.
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
              tip={witnessTitle(witness, n.age_ma, n.tier)}
            />
          ) : (
            withSilhouette &&
            n.phylopic_id && (
              <Silhouette
                phylopicId={n.phylopic_id}
                tip={
                  d.graft
                    ? graftTitle(d.graft)
                    : borrowedTitle(name, d.silhouetteClade)
                }
              />
            )
          )}
          {/*
            Three rows, each on its own line so the label is as wide as its
            widest row: rank, name, age. `metricsFor` reserves them the same way.
          */}
          {showText && (
            <span className="mark-text" style={{ maxWidth: box?.textMaxWidth }}>
              {meta && <span className="mark-meta">{meta}</span>}
              <span className="mark-name" {...nameTip}>
                {div ? (
                  <DerivedName divergence={div} />
                ) : (
                  <span
                    className={
                      // Rank of the displayed string — null on a common name,
                      // so "Human" is roman where "Homo sapiens" is italic.
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
                <span className="mark-age num" {...ageTip}>
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
