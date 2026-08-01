/**
 * Interaction 3: click a branch, drill into what is on it.
 *
 * A strip beneath the chronogram, sharing its time axis — the whole point of
 * the lane is that a bracket down here and a divergence up there are read
 * against the same scale, so it takes the canvas's own `toScreenX` and moves
 * with the pan and the zoom.
 *
 * Two registers, deliberately not one:
 *
 *   spine    the suppressed OTT nodes, ticked at their `age_layout`. These are
 *            positions in the tree the canvas chose not to draw
 *   rows     PBDB taxa as double brackets. These are *observations from rock*
 *
 * They are annotations on a segment, not resolved positions within it, so
 * nothing here looks like a trace: no luminous core, no halo, no edges to
 * anything, and the marks are rectangles where the canvas uses lines. The
 * distinction the lane exists to protect is that a fossil range is not a
 * divergence age, and it is said in the title, in the key and on every row's
 * tooltip, not left to a difference in ink.
 *
 * The spine costs no round trip. The suppressed nodes are already in memory
 * from the layout pass (architecture §2 and §8) — the store keeps every node
 * of every resolved path — so the lane opens complete and only the fossils
 * arrive late. `/v1/segment` still returns the intermediates, and they are used
 * for anything the client somehow lacks.
 */

import { useEffect, useState } from "react";
import { api, type FossilTaxon, type PathNode, type SegmentResponse } from "../api";
import { Bracket } from "./Bracket";
import { bracketGeom, bracketKey, bracketTitle, maLabel } from "./bracket";
import {
  capNote,
  laneRows,
  spineLabels,
  unplacedNote,
  HEAD_H,
  ROW_H,
  SPINE_H,
  type LaneRows,
} from "./lane";
import { isScientificItalic } from "./NodeMark";

export interface Drill {
  upper: number;
  lower: number;
}

export interface SegmentState {
  data: SegmentResponse | null;
  error: string | null;
  loading: boolean;
}

/**
 * Fetch a segment's fossils, once per segment.
 *
 * `api.segment` is cached for the session — everything the API serves is
 * immutable within a build — so reopening a lane the reader has already seen
 * costs nothing and does not flicker through a loading state.
 */
export function useSegment(drill: Drill | null): SegmentState {
  const [state, setState] = useState<SegmentState>({
    data: null,
    error: null,
    loading: false,
  });
  const upper = drill?.upper ?? null;
  const lower = drill?.lower ?? null;

  useEffect(() => {
    if (upper === null || lower === null) {
      setState({ data: null, error: null, loading: false });
      return;
    }
    let cancelled = false;
    setState({ data: null, error: null, loading: true });
    api
      .segment(upper, lower)
      .then((data) => {
        if (!cancelled) setState({ data, error: null, loading: false });
      })
      .catch((e: unknown) => {
        if (!cancelled) {
          setState({
            data: null,
            error: e instanceof Error ? e.message : String(e),
            loading: false,
          });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [upper, lower]);

  return state;
}

/** What the lane calls each end of the segment it is annotating. */
export interface LaneEndpoint {
  name: string;
  italic: boolean;
}

interface Props {
  upper: LaneEndpoint;
  lower: LaneEndpoint;
  /** Suppressed nodes, root-first. Resolved by the caller from memory. */
  intermediates: PathNode[];
  rows: LaneRows;
  segment: SegmentState;
  /** False when this build has no fossil table at all. */
  available: boolean;
  toScreenX: (ma: number) => number;
  width: number;
  onClose: () => void;
}

const BAR_H = 9;
/** Node centre → nearest edge of its name, in px. */
const TEXT_GAP = 7;

export function DrillLane({
  upper,
  lower,
  intermediates,
  rows,
  segment,
  available,
  toScreenX,
  width,
  onClose,
}: Props) {
  const fieldH = SPINE_H + Math.max(rows.placed.length, 1) * ROW_H;
  const brackets = rows.placed.map((f) => bracketGeom(f, toScreenX));
  // The key names the marks that are drawn *and* the absence that is stated,
  // so the unplaced line has a swatchless row of its own.
  const key = bracketKey([
    ...brackets,
    ...(rows.unplaced.length ? [{ kind: "absent" as const }] : []),
  ]);
  const cap = capNote(rows);
  const unplaced = unplacedNote(rows.unplaced);
  const labels = spineLabels(intermediates, (ma) => toScreenX(ma), { width });

  return (
    <div className="drill" style={{ height: HEAD_H + fieldH + FOOT_PAD }}>
      <div className="drill-head">
        <span className="drill-title">
          Fossil occurrences along{" "}
          <span className={upper.italic ? "sci-italic" : undefined}>{upper.name}</span>
          {" → "}
          <span className={lower.italic ? "sci-italic" : undefined}>{lower.name}</span>
        </span>
        {cap && <span className="drill-cap num">{cap}</span>}
        <button type="button" className="drill-close" onClick={onClose}>
          close <span className="kbd">esc</span>
        </button>
      </div>

      <svg
        className="drill-field"
        width="100%"
        height={fieldH}
        role="img"
        aria-label="fossil occurrences along the selected branch"
      >
        <Spine
          intermediates={intermediates}
          upperX={toScreenX(upperAge(intermediates, rows))}
          toScreenX={toScreenX}
          labels={labels}
          lowerX={toScreenX(0)}
        />

        {rows.placed.map((f, i) => {
          const geom = brackets[i]!;
          if (geom.kind === "absent") return null;
          const y = SPINE_H + i * ROW_H;
          const right = geom.envelope.x + geom.envelope.w;
          const roomRight = width - right > 190;
          return (
            <g key={f.name} className="drill-row">
              <Bracket
                geom={geom}
                y={y + (ROW_H - BAR_H) / 2 - 4}
                height={BAR_H}
                title={bracketTitle(f.name, geom)}
              />
              <text
                className="drill-row-name"
                x={roomRight ? right + TEXT_GAP : geom.envelope.x - TEXT_GAP}
                y={y + ROW_H / 2 - 1}
                textAnchor={roomRight ? "start" : "end"}
              >
                <tspan className={isScientificItalic(f.rank) ? "sci-italic" : undefined}>
                  {f.name}
                </tspan>
                <tspan className="drill-row-occs" dx="7">
                  {f.n_occs.toLocaleString()}
                </tspan>
                <tspan className="drill-row-span" dx="7">
                  {maLabel(geom.oldest)}–{maLabel(geom.youngest)} Ma
                </tspan>
              </text>
            </g>
          );
        })}

        {rows.placed.length === 0 && (
          <text className="drill-empty" x={16} y={SPINE_H + 12}>
            {!available
              ? "the fossil layer is not in this build, so nothing can be said about this branch either way"
              : segment.loading
                ? "reading the fossil record…"
                : segment.error
                  ? "the fossil record could not be read for this branch"
                  : rows.unplaced.length > 0
                    ? "every fossil taxon here is listed below — none carries an interval that can be placed in time"
                    : "no fossil taxon in the Paleobiology Database resolves to this branch"}
          </text>
        )}
      </svg>

      <div className="drill-foot">
        <span className="drill-key">
          {key.map((r) => (
            <span className="drill-key-row" key={r.id}>
              <svg className="drill-key-swatch" width="24" height="9" aria-hidden="true">
                {r.id === "absent" ? (
                  <g className="bracket is-absent">
                    <rect className="bracket-cap" x={1} y={0} width={1} height={9} />
                    <rect className="bracket-cap" x={22} y={0} width={1} height={9} />
                  </g>
                ) : (
                  <g className="bracket">
                    <rect className="bracket-envelope" x={1} y={0} width={22} height={9} />
                    <rect className="bracket-cap" x={1} y={0} width={1} height={9} />
                    <rect className="bracket-cap" x={22} y={0} width={1} height={9} />
                    {r.id === "certain" && (
                      <rect className="bracket-certain" x={7} y={2} width={10} height={5} />
                    )}
                  </g>
                )}
              </svg>
              {r.text}
            </span>
          ))}
        </span>
        {unplaced && <span className="drill-unplaced">{unplaced}</span>}
        <span className="drill-caption">
          observed in rock · not divergence ages
        </span>
      </div>
    </div>
  );
}

/** Room under the field for the footer, which wraps on a narrow viewport. */
const FOOT_PAD = 26;

/**
 * The oldest thing the lane has to reach.
 *
 * The upper endpoint is not in `intermediates` — the API excludes both ends —
 * so the spine starts at the oldest intermediate. Where the segment suppressed
 * nothing at all, it starts at the oldest fossil bound instead, which is the
 * only other thing on the strip.
 */
function upperAge(intermediates: readonly PathNode[], rows: LaneRows): number {
  const ages = intermediates.map((n) => n.age_layout);
  for (const f of rows.placed) {
    for (const v of [f.fea, f.fla, f.lea, f.lla]) {
      if (typeof v === "number" && Number.isFinite(v)) ages.push(v);
    }
  }
  return ages.length ? Math.max(...ages) : 0;
}

function Spine({
  intermediates,
  upperX,
  lowerX,
  toScreenX,
  labels,
}: {
  intermediates: readonly PathNode[];
  upperX: number;
  lowerX: number;
  toScreenX: (ma: number) => number;
  labels: ReturnType<typeof spineLabels>;
}) {
  const named = new Set(labels.map((l) => l.idx));
  return (
    <g className="drill-spine">
      <line x1={Math.min(upperX, lowerX)} y1={11} x2={Math.max(upperX, lowerX)} y2={11} />
      {intermediates.map((n) => (
        <rect
          key={n.idx}
          className={`drill-tick${named.has(n.idx) ? " is-named" : ""}`}
          x={toScreenX(n.age_layout) - 1}
          y={6}
          width={2}
          height={10}
        >
          {/* Every tick is a real node with a real name, whether or not the
              crowding let it print one. */}
          <title>
            {n.name ?? "unnamed divergence"}
            {n.rank && n.rank !== "no rank" ? ` · ${n.rank}` : ""} ·{" "}
            {n.tip_count.toLocaleString()} species below
          </title>
        </rect>
      ))}
      {labels.map((l) => (
        <text key={l.idx} className="drill-spine-name" x={l.x} y={26} textAnchor="middle">
          {l.text}
        </text>
      ))}
    </g>
  );
}

/** Resolve a fossil's four bounds without exposing the row itself. */
export type { FossilTaxon };
