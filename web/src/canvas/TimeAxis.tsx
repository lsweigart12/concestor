/**
 * The time axis, and the geologic band beneath it.
 *
 * Two scales, and the toggle really switches them. Symlog is the default —
 * linear from the present to 1 Ma, logarithmic above — and it is what makes
 * the app work at all, because linear time puts every hominin divergence
 * inside one pixel next to the Cambrian. Linear is offered so a reader can see
 * that for themselves. The knee is marked, because a scale that bends without
 * saying so misleads.
 *
 * **Everything here is generated from the range actually on screen**, not from
 * the extent of the tree. That is the difference between an axis and a
 * decoration: zoom into the Pliocene and the ticks become Pliocene ticks and
 * the band becomes Ages, rather than the whole apparatus sliding off the edge
 * and leaving the reader a bare rule.
 *
 * The axis runs from the present to the Big Bang and belongs to the canvas
 * rather than to the selection. Every edge on it is named — "present" rather
 * than "0", the formation of the Earth where the geologic band starts, and the
 * beginning where the axis itself stops — because an edge a reader cannot
 * account for is worse than one that runs off the screen.
 *
 * The ICS band keeps the official hue *relationships* and drops the official
 * saturation and luminance (architecture §6). It is a reference scale, not
 * data. Nothing in it glows. Level of detail is driven by pixels-per-Ma —
 * **per region, not per axis**, because one rank across a log axis cannot be
 * right anywhere. Picking a single rank by its median width meant either the
 * Cenozoic said "Phanerozoic" across two thirds of the screen, or the
 * Precambrian was a row of unreadable slivers. The band is now grown down the
 * ICS containment tree and stops wherever the children stop being legible, so
 * the same strip can read Quaternary at one end and Precambrian at the other.
 *
 * The strip ends in a footer line that carries everything the reader needs in
 * order to *read a position*: what the units are, whether the scale is bent,
 * and what a dashed trace means. Those are one statement, so they get one
 * line — flat text on the axis, not a floating panel beside it.
 */

import { useMemo } from "react";
import type { TimescaleInterval } from "../api";
import { useTip } from "../chrome/Tooltip";
import { LANDMARK_TICKS, SYMLOG_T0, type AxisMode } from "../tree/layout";

interface Props {
  maxAge: number;
  width: number;
  /** Maps an age to a screen x, accounting for the current pan and zoom. */
  toScreenX: (age: number) => number;
  /** Inverse of {@link Props.toScreenX} — what age sits under a screen x. */
  toAge: (x: number) => number;
  intervals: TimescaleInterval[] | null;
  axisMode: AxisMode;
  /**
   * The stretch control, at the ruler's right end: one press gives time more
   * room (`1`) or less (`-1`). It is the *tree* that changes — the plot is
   * relaid wider or narrower and the fit reframes it — so it lives on the
   * ruler it rescales, the way the drill lane lives on the segment it opens.
   */
  onStretch: (dir: 1 | -1) => void;
  canWiden: boolean;
  canNarrow: boolean;
  /**
   * REMOVED — the key is drawn by `Graph.tsx` now, bottom-left over the canvas.
   *
   * It rode a footer line under the ruler for as long as that line had three
   * cells in it; the other two moved into the sidebar and left a caption row
   * holding the strip 26px off the bottom of the window for one centred phrase.
   * The strip is the ruler now and sits flush; the key is chrome on the canvas,
   * on the shelf the mode panel used to occupy.
   */
}

const MIN_BAND_PX = 46;
/** How much of a band's width its legible children must cover before it splits. */
const SPLIT_SHARE = 0.7;
/** Clear space wanted between two tick labels, on top of their own widths. */
const MIN_TICK_GAP_PX = 30;
/** Roughly how far apart ticks should sit before density is traded for range. */
const TARGET_TICK_PX = 96;
/** Tick text is mono 10.5px; a mono advance is 0.6em. */
const TICK_CHAR_PX = 6.3;

/**
 * Where the axis ends, and the only non-arbitrary place it could.
 *
 * The axis used to stop at `maxAge` — the deepest node in the *current
 * selection* — so it began abruptly, unlabelled, wherever that selection's root
 * happened to fall, and moved every time a species was added. Time before
 * present does not end there; it ends at the beginning. 13.787 Ga is Planck
 * 2018's ΛCDM figure, quoted in Ma to match the rest of the axis.
 */
const BIG_BANG_MA = 13787;

/**
 * Where the geologic band ends, which is not where the axis ends.
 *
 * ICS `chart.ttl` starts at the Hadean's `begin_ma`, so the coloured strip stops
 * at 4567 and 9,220 Ma of bare axis runs on beyond it. That stretch is the point
 * rather than a gap — it is most of the diagram — and both of its ends are named
 * so a reader can account for what they are looking at.
 */
const EARTH_MA = 4567;

/** A tick, and how much the axis wants to keep it when space runs out. */
interface Tick {
  age: number;
  /** Lower survives longer: 0 the present, 1 landmarks and the knee, then decades. */
  rank: number;
}

/** The 1–2–5 ladder, which is what makes a log decade readable. */
function decadeTicks(lo: number, hi: number): Tick[] {
  const out: Tick[] = [];
  const from = Math.floor(Math.log10(Math.max(lo, 1e-6)));
  const to = Math.ceil(Math.log10(Math.max(hi, 1e-6)));
  for (let k = from; k <= to; k++) {
    const p = 10 ** k;
    // A power of ten reads as a rounder number than 5× it, which reads rounder
    // than 2×; that ordering is what the cull spends its budget on.
    for (const [m, rank] of [
      [1, 2],
      [5, 3],
      [2, 4],
    ] as const) {
      const age = m * p;
      if (age >= lo && age <= hi) out.push({ age, rank });
    }
  }
  return out;
}

/** Evenly spaced ticks on a nice step, for the linear scale and below the knee. */
function linearTicks(lo: number, hi: number, approxCount: number): Tick[] {
  const span = hi - lo;
  if (!(span > 0) || !Number.isFinite(span)) return [];
  const rough = span / Math.max(approxCount, 1);
  const p = 10 ** Math.floor(Math.log10(rough));
  const m = rough / p;
  const step = (m <= 1 ? 1 : m <= 2 ? 2 : m <= 5 ? 5 : 10) * p;
  const out: Tick[] = [];
  for (let i = Math.ceil(lo / step); i * step <= hi + step * 1e-9; i++) {
    // Every fifth step is the one to keep if the row has to thin out.
    out.push({ age: i * step, rank: i % 5 === 0 ? 2 : 3 });
  }
  return out;
}

/**
 * Ticks for what is on screen.
 *
 * Built as a *prioritised* candidate list rather than a set, then placed
 * greedily: the present first, then the boundaries a reader recognises, then
 * powers of ten, and so on down. Placing by priority rather than by position
 * is what stops 50 Ma crowding out the K–Pg.
 */
export function buildTicks(
  lo: number,
  hi: number,
  mode: AxisMode,
  toScreenX: (age: number) => number,
  width: number,
): number[] {
  const candidates: Tick[] = [];
  const push = (t: Tick) => {
    if (t.age >= lo && t.age <= hi) candidates.push(t);
  };

  push({ age: 0, rank: 0 });
  if (mode === "log") {
    for (const age of LANDMARK_TICKS) push({ age, rank: 1 });
    // The knee is a fact about the scale, so it earns a number under it.
    push({ age: SYMLOG_T0, rank: 1 });
    if (hi > SYMLOG_T0) {
      candidates.push(...decadeTicks(Math.max(lo, SYMLOG_T0), hi));
    }
    // Below the knee the scale is linear, so a log ladder would bunch there.
    if (lo < SYMLOG_T0) {
      const linHi = Math.min(hi, SYMLOG_T0);
      const px = Math.abs(toScreenX(lo) - toScreenX(linHi));
      for (const t of linearTicks(lo, linHi, px / TARGET_TICK_PX)) {
        // Ranked below the decades, so a view spanning the knee spends its
        // room on deep time rather than on the last 200,000 years.
        candidates.push({ age: t.age, rank: t.rank + 3 });
      }
    }
  } else {
    candidates.push(...linearTicks(lo, hi, width / TARGET_TICK_PX));
  }

  // Collision is measured between the label *boxes*, not between the positions.
  // A flat centre-to-centre gap was fine while every tick was a short number and
  // stopped being fine the moment one of them read "present".
  const placed: { age: number; x: number; half: number }[] = [];
  const order = [...candidates].sort(
    (a, b) => a.rank - b.rank || a.age - b.age,
  );
  for (const t of order) {
    if (placed.some((p) => p.age === t.age)) continue;
    const x = toScreenX(t.age);
    // A tick nobody can put anywhere is not a tick. `toScreenX` projects
    // through the live viewport transform, and a transform that is not a
    // number makes every x NaN — at which point this loop does something
    // worse than draw badly, because the comparison below is a *range* test
    // and NaN fails every comparison it is given. `Math.abs(NaN) >= gap` is
    // false, so the first candidate is placed and every later one is judged to
    // collide with it: the axis silently collapses to a single tick, and that
    // tick is then drawn at `x="NaN"`, which the DOM rejects per-attribute and
    // replaces with zero. So "present" ends up printed hard against the left
    // edge of a canvas whose present is on the right. Refusing here rather
    // than at the point of render is what keeps the two failures together:
    // there is no separate rule deciding what to draw, only a list of ticks
    // that can be placed, which for a degenerate projection is empty.
    if (!Number.isFinite(x)) continue;
    const half = (tickLabel(t.age).length * TICK_CHAR_PX) / 2;
    const clear = placed.every(
      (p) => Math.abs(p.x - x) >= MIN_TICK_GAP_PX + p.half + half,
    );
    if (clear) placed.push({ age: t.age, x, half });
  }
  return placed.map((p) => p.age).sort((a, b) => a - b);
}

/**
 * How wide a band's name draws: uppercase 9.5px with 0.05em tracking, measured,
 * plus room to breathe.
 *
 * A band is either labelled with its whole name or not labelled at all. Every
 * abbreviation available here is worse than silence — truncating to a fixed
 * three characters put "NEO" on a strip that contains both a Neogene and a
 * Neoproterozoic, and truncating to the shortest unambiguous prefix produces
 * "Jura", "Lowe" and "Upper C". The name is the only useful thing a band says,
 * so the *tiling* is what adapts (see {@link bandTiling}) and the label does not.
 */
function labelPx(name: string): number {
  return name.length * 7.3 + 10;
}

/** Ticks carry real decimals below 1 Ma, and must not carry float noise above. */
export function fmtAge(age: number): string {
  if (age === 0) return "0";
  return String(Number(age.toPrecision(age >= 1 ? 12 : 6)));
}

/**
 * What a tick says. Every one is a number of millions of years except the one
 * that is not — the present is a place on the axis, and "0" made a reader work
 * out which end they were looking at. Lower case, because that is already the
 * word an extant tip carries: *Homo sapiens* reads "present" on the canvas.
 */
export function tickLabel(age: number): string {
  return age === 0 ? "present" : fmtAge(age);
}

/**
 * The intervals to draw: the coarsest tiling of the axis whose bands are legible.
 *
 * Grown down the ICS containment tree from its roots. A node hands over to its
 * children when the children that can *carry their own names* cover most of
 * its width — so the Cenozoic reaches Epoch while the Mesozoic beside it stays
 * an Era, and neither is a row of slivers.
 *
 * Legibility is measured against each name, not against a flat pixel count,
 * because that is what makes "label with the whole name or not at all"
 * affordable: a split that would leave its own children unnameable does not
 * happen. Under a flat threshold the Mesozoic split into an unlabelled
 * Triassic, a "Jura" and a "Lowe".
 *
 * Two cheaper split rules also fail on real intervals. "All children fit" is
 * too strict: one 37-pixel Paleozoic holds the entire Phanerozoic at Eon,
 * which is how the band came to say "PHANEROZOIC" across the whole Cenozoic.
 * Counting children rather than measuring them fails on the Quaternary, whose
 * two children are a screen-wide Pleistocene and an 11,700-year Holocene — one
 * of two is not a majority, so a 470-pixel Pleistocene went unnamed.
 *
 * The result always tiles without gaps or overlaps, because every node is
 * either drawn or replaced by its complete set of children.
 */
export function bandTiling(
  intervals: TimescaleInterval[],
  widthPx: (i: TimescaleInterval) => number,
): TimescaleInterval[] {
  const kids = new Map<string, TimescaleInterval[]>();
  const roots: TimescaleInterval[] = [];
  for (const i of intervals) {
    if (i.parent === null) roots.push(i);
    else {
      const list = kids.get(i.parent);
      if (list) list.push(i);
      else kids.set(i.parent, [i]);
    }
  }

  const out: TimescaleInterval[] = [];
  const expand = (node: TimescaleInterval): void => {
    const cs = kids.get(node.id);
    if (!cs || cs.length === 0) {
      out.push(node);
      return;
    }
    let total = 0;
    let legible = 0;
    for (const c of cs) {
      const w = widthPx(c);
      total += w;
      if (w >= Math.max(MIN_BAND_PX, labelPx(c.name))) legible += w;
    }
    if (total <= 0 || legible < total * SPLIT_SHARE) {
      out.push(node);
      return;
    }
    for (const c of cs) expand(c);
  };
  for (const r of roots) expand(r);
  return out.sort((a, b) => b.begin_ma - a.begin_ma);
}

export function TimeAxis({
  maxAge,
  width,
  toScreenX,
  toAge,
  intervals,
  axisMode,
  onStretch,
  canWiden,
  canNarrow,
}: Props) {
  const narrowTip = useTip(
    "Less room for time: the tree redraws narrower, and the fit keeps it.",
  );
  const widenTip = useTip(
    "More room for time: the tree redraws wider, and the fit keeps it.",
  );
  /**
   * The age range under the viewport, clamped to the axis itself.
   *
   * Deep time is on the left, so screen x = 0 is the *older* end. The clamps
   * are the two ends of time-before-present and nothing to do with the current
   * selection: right of the present the scale runs into negative time, and past
   * {@link BIG_BANG_MA} there is no before to count back through.
   */
  const [ageLo, ageHi] = useMemo(() => {
    const a = toAge(0);
    const b = toAge(width);
    const lo = Math.max(0, Math.min(a, b));
    const hi = Math.min(BIG_BANG_MA, Math.max(a, b));
    return hi > lo ? [lo, hi] : [0, Math.min(BIG_BANG_MA, maxAge)];
  }, [toAge, width, maxAge]);

  const bands = useMemo(() => {
    if (!intervals) return [];
    // Measured on the *full* interval, not the part on screen, so panning
    // never changes which rank a region is drawn at — only zooming does.
    const geom = (i: TimescaleInterval) => {
      const x1 = toScreenX(i.begin_ma);
      const x2 = toScreenX(i.end_ma);
      return { x: Math.min(x1, x2), w: Math.abs(x2 - x1) };
    };
    return bandTiling(intervals, (i) => geom(i).w)
      .map((i) => {
        const { x, w } = geom(i);
        // A band wider than the viewport still deserves its name, centred on
        // the part a reader can see rather than on a midpoint off-screen.
        const vx1 = Math.max(x, 0);
        const vx2 = Math.min(x + w, width);
        const room = vx2 - vx1;
        return {
          ...i,
          x,
          w,
          labelX: (vx1 + vx2) / 2,
          room,
          label: labelPx(i.name) <= room ? i.name : null,
        };
      })
      .filter((b) => b.w > 2 && b.room > 0);
  }, [intervals, toScreenX, width]);

  const ticks = useMemo(
    () => buildTicks(ageLo, ageHi, axisMode, toScreenX, width),
    [ageLo, ageHi, axisMode, toScreenX, width],
  );

  const kneeX = toScreenX(SYMLOG_T0);
  const showKneeLabel = width > 560;
  // The deep end of the axis. Everything left of it is off the end of time, so
  // the rule stops there too rather than running on into a region it cannot
  // measure — an edge that is drawn and named, not one the reader trips over.
  const originX = toScreenX(BIG_BANG_MA);
  const showOrigin = originX > 0 && originX < width;
  // Where the geologic band starts, 9,220 Ma later. The two labels share the
  // bare stretch between them and so take different rows: the Earth's goes in
  // the band's row, which is empty exactly there, and the beginning's goes
  // under it, where it may overrun to the right without hitting anything.
  const earthX = toScreenX(EARTH_MA);
  const bareFrom = Math.max(originX, 0);
  const showEarth = earthX > bareFrom && earthX < width;
  // Both labels live in the bare stretch and both shorten on the same measure,
  // so they drop their figures together rather than one running under the
  // other's marker. Tick text is mono 10px.
  const bareRoom = Math.min(earthX, width) - bareFrom - 14;
  const shortest = (full: string, short: string) =>
    full.length * 6 <= bareRoom ? full : short;

  return (
    <div className="axis">
      <svg width="100%" height="58" role="img" aria-label="time axis">
        {/* Geologic band, recessive, drawn first so traces are never behind it. */}
        {bands.length > 0 && (
          <g className="ics-band">
            {bands.map((b) => (
              <g key={b.id}>
                <rect x={b.x} y={0} width={b.w} height={17} fill={b.color} />
                <line x1={b.x} y1={0} x2={b.x} y2={17} />
                {b.label && (
                  <text
                    x={b.labelX}
                    y={12}
                    textAnchor="middle"
                    style={{ pointerEvents: "none" }}
                  >
                    {b.label}
                  </text>
                )}
              </g>
            ))}
          </g>
        )}

        <line
          className="axis-line"
          x1={showOrigin ? originX : 0}
          y1={30}
          x2={width}
          y2={30}
        />

        {ticks.map((t) => {
          const x = toScreenX(t);
          if (x < -20 || x > width + 20) return null;
          return (
            <g key={t} className="axis-tick">
              <line className="axis-grid" x1={x} y1={-2000} x2={x} y2={30} />
              <line className="axis-line" x1={x} y1={30} x2={x} y2={36} />
              <text x={x} y={50} textAnchor="middle">
                {tickLabel(t)}
              </text>
            </g>
          );
        })}

        {showEarth && (
          <>
            <line
              className="axis-origin"
              x1={earthX}
              y1={-2000}
              x2={earthX}
              y2={36}
            />
            {/* Right-aligned into the bare stretch, the only place it can go
                without printing over the band. The figure is worth carrying: a
                1–2–5 ladder never lands a tick on 4567, so nothing else on the
                strip says where the geologic record begins. */}
            {bareRoom > 66 && (
              <text
                className="axis-origin-label"
                x={earthX - 7}
                y={12}
                textAnchor="end"
              >
                {shortest("Earth forms · 4567 Ma", "Earth forms")}
              </text>
            )}
          </>
        )}

        {showOrigin && (
          <>
            <line
              className="axis-origin"
              x1={originX}
              y1={-2000}
              x2={originX}
              y2={36}
            />
            {bareRoom > 48 && (
              <text
                className="axis-origin-label"
                x={originX + 7}
                y={26}
                textAnchor="start"
              >
                {shortest("Big Bang · 13787 Ma", "Big Bang")}
              </text>
            )}
          </>
        )}

        {axisMode === "log" && kneeX > 0 && kneeX < width && (
          <>
            <line
              className="axis-knee"
              x1={kneeX}
              y1={-2000}
              x2={kneeX}
              y2={36}
            />
            {showKneeLabel && (
              <text
                x={kneeX - 7}
                y={26}
                textAnchor="end"
                style={{
                  fill: "var(--accent-dim)",
                  fontSize: 10,
                  fontFamily: "var(--mono)",
                }}
              >
                scale bends here · 1 Ma
              </text>
            )}
          </>
        )}
      </svg>
      {/*
        The stretch control, at the ruler's right end — on the thing it
        rescales. Two presses, compress and widen, drawn as arrows meeting or
        parting; the words are in the tooltips because a glyph that needs a
        caption printed beside it would be a caption with a glyph in the way.
      */}
      <div className="axis-stretch">
        <button
          type="button"
          aria-label="Less room for time"
          disabled={!canNarrow}
          onClick={() => onStretch(-1)}
          {...narrowTip}
        >
          <svg width="16" height="10" viewBox="0 0 16 10" aria-hidden="true">
            <path
              d="M1 5h5.4M3.8 2.3 6.4 5 3.8 7.7M15 5H9.6m2.6-2.7L9.6 5l2.6 2.7"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.3"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </button>
        <button
          type="button"
          aria-label="More room for time"
          disabled={!canWiden}
          onClick={() => onStretch(1)}
          {...widenTip}
        >
          <svg width="16" height="10" viewBox="0 0 16 10" aria-hidden="true">
            <path
              d="M6.9 5H1.5m2.6-2.7L1.5 5l2.6 2.7M9.1 5h5.4M11.9 2.3 14.5 5l-2.6 2.7"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.3"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </button>
      </div>
    </div>
  );
}
