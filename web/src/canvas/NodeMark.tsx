/**
 * A node: a small luminous point that blooms on hover and focus.
 *
 * Semantic zoom, not scale zoom — the mark changes *what* it renders at each
 * level rather than just its size. Three tiers, per design-reference.md:
 *
 *   point        a glowing dot, no text
 *   label        dot + name (+ age, when there is one we are allowed to show)
 *   detail       dot + silhouette + name + rank
 *
 * A silhouette *is* the full-detail tier for a clade, and for a well-known one
 * it earns a place at the label tier too — for a curious non-specialist an
 * image is what makes a clade mean anything.
 *
 * Where the label actually goes is decided in `tree/labels.ts`, against every
 * other label and every trace on the canvas. This component only renders what
 * that pass hands it.
 */

import { memo } from "react";
import { Handle, Position, type NodeProps } from "@xyflow/react";
import { TIER_INTERPOLATED, TIER_STRUCTURAL, type PathNode, type Tier } from "../api";
import type { LabelBox } from "../tree/labels";
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
  /** Name of the clade an inherited silhouette actually depicts, if not this one. */
  silhouetteOf: string | null;
  /** Resolved position, from the collision pass. Absent before it runs. */
  label: LabelBox | undefined;
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
 */
export function ageLabel(age: number | null, tier: Tier): string | null {
  if (tier === TIER_STRUCTURAL || age === null || !Number.isFinite(age)) return null;
  if (age < 0.05) return "present";
  const n = age >= 100 ? Math.round(age) : age >= 10 ? age.toFixed(0) : age.toFixed(1);
  return `${tier === TIER_INTERPOLATED ? "≤ " : ""}${n} Ma`;
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

export const NodeMark = memo(function NodeMark({ data }: NodeProps) {
  const d = data as unknown as MarkData;
  const n = d.node;
  const color = `hsl(${d.hue} ${n.tier === TIER_STRUCTURAL ? 24 : 70}% ${d.focused || d.isMRCA ? 74 : 60}%)`;
  const age = ageLabel(n.age_ma, n.tier);
  const showText = d.zoom !== "point";
  const showDetail = d.zoom === "detail";
  const name = n.name ?? "unnamed divergence";
  // Clades get an image too, not just selections. architecture §7: a
  // silhouette legitimately represents a *clade*, where a photograph can only
  // represent one member — so a mammal beside Mammalia is the case it is best
  // at, and `silhouetteIsInformative` is what keeps a kingdom-sized borrow out.
  const withSilhouette = showDetail && d.showSilhouette && Boolean(n.phylopic_id);
  const meta = metaLine(n.rank, showDetail);

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
          boxShadow: d.focused
            ? `0 0 12px 3px ${color}`
            : d.isLeaf
              ? `0 0 7px 1px ${color}`
              : "none",
        }}
      />

      {showText && (
        <span
          className={`mark-label${box?.overlapped ? " crowded" : ""}`}
          style={style}
        >
          {withSilhouette && n.phylopic_id && (
            <Silhouette
              phylopicId={n.phylopic_id}
              title={
                d.silhouetteOf
                  ? `Silhouette of ${d.silhouetteOf}, the nearest clade with an image`
                  : `Silhouette of ${name}`
              }
            />
          )}
          <span className="mark-text" style={{ maxWidth: box?.textMaxWidth }}>
            <span className="mark-name">
              <span className={isScientificItalic(n.rank) ? "sci-italic" : undefined}>
                {name}
              </span>
              {age && <span className="mark-age num">{age}</span>}
            </span>
            {meta && <span className="mark-meta">{meta}</span>}
          </span>
        </span>
      )}
    </div>
  );
});
