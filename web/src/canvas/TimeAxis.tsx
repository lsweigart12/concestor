/**
 * The time axis, and the geologic band beneath it.
 *
 * The axis is symlog: linear from the present to 1 Ma, logarithmic above. That
 * is what makes the app work at all — linear time puts every hominin
 * divergence inside one pixel next to the Cambrian, and the point of the scale
 * is to make the last 10 Ma legible without losing the other 4,000. The knee
 * is marked, because a scale that bends without saying so misleads.
 *
 * The ICS band keeps the official hue *relationships* and drops the official
 * saturation and luminance (architecture §6). It is a reference scale, not
 * data. Nothing in it glows. Level of detail is driven by pixels-per-Ma: show
 * Epochs only when they would exceed a legibility threshold, then Periods,
 * then Eras.
 */

import { useMemo } from "react";
import type { TimescaleInterval } from "../api";
import { AXIS_TICKS, LIN_SHARE, symlogFrac } from "../tree/layout";

interface Props {
  maxAge: number;
  width: number;
  /** Maps an age to a screen x, accounting for the current pan and zoom. */
  toScreenX: (age: number) => number;
  intervals: TimescaleInterval[] | null;
  axisMode: "log" | "linear";
}

const RANK_ORDER = ["Eon", "Era", "Period", "Sub-Period", "Epoch", "Age"];
const MIN_BAND_PX = 46;
const MIN_TICK_GAP_PX = 38;

export function TimeAxis({ maxAge, width, toScreenX, intervals, axisMode }: Props) {
  const bandRank = useMemo(() => {
    if (!intervals) return null;
    // Pick the finest rank whose narrowest visible interval still clears the
    // legibility threshold. Falling back a rank is better than a band of
    // unreadable slivers.
    for (const rank of [...RANK_ORDER].reverse()) {
      const rows = intervals.filter(
        (i) => i.rank === rank && i.begin_ma <= maxAge * 1.05,
      );
      if (rows.length < 2) continue;
      const widths = rows.map((i) =>
        Math.abs(toScreenX(i.end_ma) - toScreenX(i.begin_ma)),
      );
      const median = widths.sort((a, b) => a - b)[Math.floor(widths.length / 2)] ?? 0;
      if (median >= MIN_BAND_PX) return rank;
    }
    return "Eon";
  }, [intervals, maxAge, toScreenX]);

  const bands = useMemo(
    () =>
      (intervals ?? [])
        .filter((i) => i.rank === bandRank && i.end_ma <= maxAge)
        .map((i) => {
          const x1 = toScreenX(Math.min(i.begin_ma, maxAge));
          const x2 = toScreenX(i.end_ma);
          return { ...i, x: Math.min(x1, x2), w: Math.abs(x2 - x1) };
        })
        .filter((b) => b.w > 2 && b.x < width && b.x + b.w > 0),
    [intervals, bandRank, maxAge, toScreenX, width],
  );

  // Drop ticks that would collide. The set is deliberately uneven — 66 Ma is
  // the K-Pg, 252 the end-Permian — so on a log axis in a narrow panel several
  // land within a few pixels of each other and overprint into noise. Keeping
  // the first of each cluster preserves the round numbers and the boundaries a
  // reader is most likely to recognise.
  const inRange = AXIS_TICKS.filter((t) => t <= maxAge);
  const ticks: number[] = [];
  for (const t of inRange) {
    const x = toScreenX(t);
    const last = ticks[ticks.length - 1];
    if (last === undefined || Math.abs(toScreenX(last) - x) >= MIN_TICK_GAP_PX) {
      ticks.push(t);
    }
  }
  const kneeX = toScreenX(1);
  const showKneeLabel = width > 560;

  return (
    <div className="axis">
      <svg width="100%" height="84" role="img" aria-label="time axis">
        {/* Geologic band, recessive, drawn first so traces are never behind it. */}
        {bands.length > 0 && (
          <g className="ics-band">
            {bands.map((b) => (
              <g key={b.id}>
                <rect x={b.x} y={0} width={b.w} height={17} fill={b.color} />
                <line x1={b.x} y1={0} x2={b.x} y2={17} />
                {b.w > 58 && (
                  <text
                    x={b.x + b.w / 2}
                    y={12}
                    textAnchor="middle"
                    style={{ pointerEvents: "none" }}
                  >
                    {b.w > 110 ? b.name : b.name.slice(0, 3)}
                  </text>
                )}
              </g>
            ))}
          </g>
        )}

        <line className="axis-line" x1={0} y1={30} x2={width} y2={30} />

        {ticks.map((t) => {
          const x = toScreenX(t);
          if (x < -20 || x > width + 20) return null;
          return (
            <g key={t} className="axis-tick">
              <line className="axis-grid" x1={x} y1={-2000} x2={x} y2={30} />
              <line className="axis-line" x1={x} y1={30} x2={x} y2={36} />
              <text x={x} y={50} textAnchor="middle">
                {t}
              </text>
            </g>
          );
        })}

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

        <text
          x={width / 2}
          y={72}
          textAnchor="middle"
          style={{ fill: "var(--ink-4)", fontSize: 10.5, letterSpacing: "0.08em" }}
        >
          MILLIONS OF YEARS BEFORE PRESENT
          {axisMode === "log" ? " · SYMLOG" : " · LINEAR"}
        </text>
      </svg>
    </div>
  );
}

/** Fraction helper re-exported so the axis and the layout cannot drift apart. */
export { symlogFrac, LIN_SHARE };
