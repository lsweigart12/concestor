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
 * tooltip rather than left to a difference in ink.
 *
 * The spine costs no round trip. The suppressed nodes are already in memory
 * from the layout pass (architecture §2 and §8) — the store keeps every node of
 * every resolved path — so the lane opens complete and only the fossils arrive
 * late. `/v1/segment` returns the intermediates too, and those are the fallback
 * for anything the client somehow lacks.
 */

import { useEffect, useMemo, useState } from "react";
import {
  api,
  type FossilTaxon,
  type PathNode,
  type SegmentResponse,
} from "../api";
import {
  Bracket,
  bracketGeom,
  bracketKey,
  bracketTitle,
  spanLabel,
} from "./Bracket";
import {
  capNote,
  laneHeight,
  rankIntermediates,
  spineLabels,
  unplacedNote,
  ROW_H,
  SPINE_H,
  type LaneRows,
} from "./lane";
import { isScientificItalic } from "./NodeMark";
import { MONO, SANS, textWidth } from "../tree/labels";
import { usePending } from "../chrome/Pending";
import { SilhouetteSvg } from "./Silhouette";

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
 * costs nothing and does not flicker back through a loading state.
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

/** What the lane calls each end of the segment, and where that end sits. */
export interface LaneEndpoint {
  name: string;
  italic: boolean;
  /** `age_layout`, so the spine spans exactly the segment the canvas drew. */
  age: number;
}

interface Props {
  upper: LaneEndpoint;
  lower: LaneEndpoint;
  /** Suppressed nodes, root-first. Resolved by the caller. */
  intermediates: PathNode[];
  rows: LaneRows;
  segment: SegmentState;
  /** False when this build has no fossil table at all. */
  available: boolean;
  /**
   * Opens the action menu for a row. A fossil is not a node — it has no
   * ancestor path and cannot go on the canvas — so the actions are about the
   * clade it hangs from, and only the app knows what those are.
   */
  onPick: (f: FossilTaxon) => void;
  toScreenX: (ma: number) => number;
  width: number;
  onClose: () => void;
}

const BAR_H = 9;
/** Side of a row's silhouette, in px. Sits inside ROW_H with room to spare. */
const ICON = 13;
/** Envelope end → nearest edge of the name, in px. */
const TEXT_GAP = 7;
/** Room a name and its two trailing figures need to the right of a bar. */
const TEXT_ROOM = 210;

const NAME_FONT = `11px ${SANS}`;
const FIG_FONT = `9.5px ${MONO}`;
/** The two `dx="8"` gaps between the three runs of a row's label. */
const RUN_GAP = 8;

/**
 * How wide a row's written part actually is.
 *
 * Same measurer the label placement pass uses, so the lane and the canvas
 * agree about type metrics rather than each guessing.
 */
function rowTextWidth(
  f: FossilTaxon,
  geom: { oldest: number; youngest: number },
): number {
  return (
    textWidth(f.name, NAME_FONT) +
    RUN_GAP +
    textWidth(spanLabel(geom.oldest, geom.youngest), FIG_FONT) +
    RUN_GAP +
    textWidth(`${f.n_occs.toLocaleString()}×`, FIG_FONT)
  );
}

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
  onPick,
}: Props) {
  const fieldH = SPINE_H + Math.max(rows.placed.length, 1) * ROW_H;
  const brackets = rows.placed.map((f) => bracketGeom(f, toScreenX));
  // The key names the marks that are drawn *and* the absence that is stated,
  // so the unplaced line earns a row of its own.
  const key = bracketKey([
    ...brackets,
    ...(rows.unplaced.length ? [{ kind: "absent" as const }] : []),
  ]);
  const cap = capNote(rows);
  const unplaced = unplacedNote(rows.unplaced);
  const ranked = useMemo(
    () => rankIntermediates(intermediates),
    [intermediates],
  );
  const labels = spineLabels(ranked, toScreenX, { width });
  // Delayed, like everywhere else. `api.segment` is memoised for the session,
  // so a lane the reader has opened before answers in the frame it opens in —
  // and a lane that flashes "reading the fossil record" before drawing eleven
  // brackets has invented a wait to report on.
  const waiting = usePending(segment.loading);

  // A minimum rather than a height: the footer wraps at narrow widths, and a
  // fixed box would take the extra line out of the field and clip the last
  // bracket. The reserve `Graph.tsx` frames the tree against is the same
  // figure, so growing past it costs a few pixels of overlap and never a row.
  return (
    <div className="drill" style={{ minHeight: laneHeight(rows) }}>
      <div className="drill-head">
        <span className="drill-title">
          Fossil occurrences along{" "}
          <span className={upper.italic ? "sci-italic" : undefined}>
            {upper.name}
          </span>
          {" → "}
          <span className={lower.italic ? "sci-italic" : undefined}>
            {lower.name}
          </span>
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
        role="group"
        aria-label="fossil occurrences along the selected branch"
      >
        <Spine
          intermediates={intermediates}
          x1={toScreenX(upper.age)}
          x2={toScreenX(lower.age)}
          toScreenX={toScreenX}
          labels={labels}
        />

        {rows.placed.map((f, i) => {
          const geom = brackets[i]!;
          if (geom.kind === "absent") return null;
          const y = SPINE_H + i * ROW_H;
          const right = geom.envelope.x + geom.envelope.w;
          const toTheRight = width - right > TEXT_ROOM;
          // The drawing sits just past the end of the written row, so it reads
          // bracket → name → dates → picture outward and nothing ever comes
          // between a bar and the label naming it. Measured rather than
          // reserved: a fixed offset leaves a hole after a short name and
          // collides with a long one, and both were visible.
          const textX = toTheRight
            ? right + TEXT_GAP
            : geom.envelope.x - TEXT_GAP;
          const runW = rowTextWidth(f, geom);
          const silX = toTheRight ? textX + runW + 6 : textX - runW - 6 - ICON;
          return (
            <g
              key={f.name}
              className="drill-row is-actionable"
              role="button"
              tabIndex={0}
              aria-label={`${f.name} — open actions`}
              onClick={() => onPick(f)}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  onPick(f);
                }
              }}
            >
              {/* The hit area. Without it only the ink is clickable and a
                  one-pixel bracket is an unusable target. */}
              <rect
                className="drill-row-hit"
                x={Math.min(silX, geom.envelope.x) - 6}
                y={y}
                width={Math.abs(textX - silX) + geom.envelope.w + ICON + 12}
                height={ROW_H}
              />
              <Bracket
                geom={geom}
                y={y + (ROW_H - BAR_H) / 2 - 3}
                height={BAR_H}
                title={bracketTitle(f.name, geom)}
              />
              {f.phylopic_id && (
                <SilhouetteSvg
                  phylopicId={f.phylopic_id}
                  x={silX}
                  y={y + (ROW_H - ICON) / 2}
                  size={ICON}
                  title={`${f.name}, drawn`}
                />
              )}
              <text
                className="drill-row-name"
                x={textX}
                y={y + ROW_H / 2 + 1}
                textAnchor={toTheRight ? "start" : "end"}
              >
                <tspan
                  className={
                    isScientificItalic(f.rank) ? "sci-italic" : undefined
                  }
                >
                  {f.name}
                </tspan>
                <tspan className="drill-row-span" dx="8">
                  {spanLabel(geom.oldest, geom.youngest)}
                </tspan>
                <tspan className="drill-row-occs" dx="8">
                  {f.n_occs.toLocaleString()}×
                </tspan>
              </text>
            </g>
          );
        })}

        {rows.placed.length === 0 && (
          /*
           * The empty lane, and the order of these tests is the whole of it.
           *
           * `segment.loading` selects the branch and `waiting` decides only
           * whether to put words in it — never the other way round. Reading it
           * the other way is the palette's old bug in a second place: a lane
           * still fetching would fall through to *"no fossil taxon in the
           * Paleobiology Database resolves to this branch"*, which is a denial,
           * and is wrong about roughly every branch that has any.
           *
           * So a fast lane draws an empty line for a frame or two and then the
           * brackets, and a slow one says what it is doing. `pending` rides
           * only on the sentence that is not yet an answer — the other four are
           * answers, and an answer that breathes reads as still arriving.
           */
          <text
            className={waiting ? "drill-empty pending" : "drill-empty"}
            x={16}
            y={SPINE_H + 12}
          >
            {!available
              ? "the fossil layer is not in this build, so nothing can be said about this branch either way"
              : segment.loading
                ? waiting
                  ? "reading the fossil record…"
                  : ""
                : segment.error
                  ? "the fossil record could not be read for this branch"
                  : rows.unplaced.length > 0
                    ? "every fossil taxon here is named below — none carries an interval that can be placed in time"
                    : "no fossil taxon in the Paleobiology Database resolves to this branch"}
          </text>
        )}
      </svg>

      <div className="drill-foot">
        <span className="drill-key">
          {key.map((r) => (
            <span className="drill-key-row" key={r.id}>
              <svg
                className="drill-key-swatch"
                width="24"
                height="9"
                aria-hidden="true"
              >
                <g className="bracket">
                  {r.id !== "absent" && (
                    <rect
                      className="bracket-envelope"
                      x={1}
                      y={0}
                      width={22}
                      height={9}
                    />
                  )}
                  <rect
                    className="bracket-cap"
                    x={1}
                    y={0}
                    width={1}
                    height={9}
                  />
                  <rect
                    className="bracket-cap"
                    x={22}
                    y={0}
                    width={1}
                    height={9}
                  />
                  {r.id === "certain" && (
                    <rect
                      className="bracket-certain"
                      x={7}
                      y={2}
                      width={10}
                      height={5}
                    />
                  )}
                </g>
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

function Spine({
  intermediates,
  x1,
  x2,
  toScreenX,
  labels,
}: {
  intermediates: readonly PathNode[];
  x1: number;
  x2: number;
  toScreenX: (ma: number) => number;
  labels: ReturnType<typeof spineLabels>;
}) {
  const named = new Set(labels.map((l) => l.idx));
  return (
    <g className="drill-spine">
      <line x1={Math.min(x1, x2)} y1={11} x2={Math.max(x1, x2)} y2={11} />
      {intermediates.map((n) => (
        <rect
          key={n.idx}
          className={`drill-tick${named.has(n.idx) ? " is-named" : ""}`}
          x={toScreenX(n.age_layout) - 1}
          y={6}
          width={2}
          height={11}
        >
          {/* Every tick is a real node with a real position, whether or not
              the crowding let it print a name. */}
          <title>
            {n.name ?? "unnamed divergence"}
            {n.rank && n.rank !== "no rank" ? ` · ${n.rank}` : ""} ·{" "}
            {n.tip_count.toLocaleString()} species below
          </title>
        </rect>
      ))}
      {labels.map((l) => (
        <text
          key={l.idx}
          className="drill-spine-name"
          x={l.x}
          y={27}
          textAnchor="middle"
        >
          {l.text}
        </text>
      ))}
    </g>
  );
}
