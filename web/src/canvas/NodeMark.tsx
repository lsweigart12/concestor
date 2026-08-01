/**
 * A node: a small luminous point that blooms on hover and focus.
 *
 * Semantic zoom, not scale zoom — the mark changes *what* it renders at each
 * level rather than just its size. Three tiers, per design-reference.md:
 *
 *   point        a glowing dot, no text
 *   label        dot + name (+ age, when there is one we are allowed to show)
 *   detail       dot + silhouette + name + rank + age
 *
 * A silhouette *is* the full-detail tier for a clade, and for a well-known one
 * it earns a place at the label tier too — for a curious non-specialist an
 * image is what makes a clade mean anything.
 */

import { memo } from "react";
import { Handle, Position, type NodeProps } from "@xyflow/react";
import { TIER_INTERPOLATED, TIER_STRUCTURAL, type PathNode, type Tier } from "../api";
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
  const n = age >= 100 ? Math.round(age) : age >= 10 ? age.toFixed(0) : age.toFixed(1);
  if (age < 0.05) return tier === TIER_INTERPOLATED ? "present" : "present";
  return `${tier === TIER_INTERPOLATED ? "≤ " : ""}${n} Ma`;
}

export const NodeMark = memo(function NodeMark({ data }: NodeProps) {
  const d = data as unknown as MarkData;
  const n = d.node;
  const color = `hsl(${d.hue} ${n.tier === TIER_STRUCTURAL ? 24 : 70}% ${d.focused || d.isMRCA ? 74 : 60}%)`;
  const age = ageLabel(n.age_ma, n.tier);
  const showText = d.zoom !== "point";
  const showDetail = d.zoom === "detail";
  const name = n.name ?? "unnamed divergence";
  const withSilhouette =
    showDetail && d.isLeaf && d.showSilhouette && Boolean(n.phylopic_id);

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

      {/* Internal nodes label to the left of the point so the label sits over
          the deep-time side and never collides with the trace running right. */}
      {showText && !d.isLeaf && (
        <span className="mark-label leading">
          <span className={isScientificItalic(n.rank) ? "sci-italic" : undefined}>
            {name}
          </span>
          {age && <span className="mark-age num">{age}</span>}
        </span>
      )}

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

      {withSilhouette && n.phylopic_id && (
        <Silhouette phylopicId={n.phylopic_id} title={d.silhouetteOf ?? undefined} />
      )}

      {showText && d.isLeaf && (
        <span className={`mark-label${withSilhouette ? " has-silhouette" : ""}`}>
          <span className={isScientificItalic(n.rank) ? "sci-italic" : undefined}>
            {name}
          </span>
          {showDetail && n.rank && <span className="mark-rank">{n.rank}</span>}
          {showDetail && d.silhouetteOf && (
            <span className="silhouette-of"> silhouette: {d.silhouetteOf}</span>
          )}
        </span>
      )}
    </div>
  );
});
