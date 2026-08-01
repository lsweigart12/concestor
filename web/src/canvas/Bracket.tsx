/**
 * PBDB's uncertainty model, and the only mark in the app that draws it.
 *
 * A fossil taxon does not carry a range. It carries two brackets: it first
 * appears somewhere in `fea…fla` and last appears somewhere in `lea…lla`, ages
 * in Ma so the larger number is the older end. Two marks come out of that, and
 * architecture §7 requires both:
 *
 *   envelope   fea → lla   the maximal possible extent, faded
 *   certain    fla → lea   the minimal extent the record forces, solid
 *
 * Collapsing the four numbers into one bar throws away the distinction the
 * database exists to keep, and a midpoint would be a fabricated estimate
 * wearing an observation's clothes. Neither is reachable from here: the
 * geometry below has no code path that produces a single-point summary.
 *
 * **The solid bar is the exception, not the rule, and §7's phrasing hides
 * that.** The four bounds look like a chain, but the middle link does not
 * hold. Measured over the 410,615 rows of the built `fossil` table carrying
 * all four: `fea ≥ fla`, `lea ≥ lla`, `fea ≥ lea` and `fla ≥ lla` are each
 * true for 100% of rows, and `fla ≥ lea` is true for **39.6%**. A taxon known
 * from one stratigraphic interval has both its appearances inside that
 * interval, so `fla` sits at the interval's young end and `lea` at its old end
 * and the two cross — 99.9% of single-occurrence taxa are like this, against
 * 38.5% of the rest. For the other 60.4% there is no moment at which the taxon
 * is certainly present and **nothing solid may be drawn**.
 *
 * So there are four outcomes rather than two, and the type says so:
 *
 *   extent       fla > lea   — envelope plus solid bar
 *   instant      fla = lea   — the brackets meet at one date, 40,251 rows
 *   overlapping  fla < lea   — envelope only, 247,868 rows
 *   unrecorded   no interval at all — 112,073 rows, 21.4%
 *
 * `instant` draws no bar either. A hairline at a single date reads as
 * precision, which is the opposite of what a zero-duration certain extent
 * means, and the date it would land on is a stage boundary rather than an
 * observation. It stays a distinct case rather than being folded into
 * `overlapping` because the fourth age tier will want to say "the brackets
 * meet at 72.2 Ma" and cannot recover that from a merged flag.
 *
 * **This file is deliberately not part of the drill-down lane.** The fourth
 * age tier (`occurrence`) states the same record beside an extinct node on the
 * main canvas, and it must not invent a second way to say the same thing — it
 * calls `bracketGeom` for the `absent`-versus-`range` decision and
 * `endedSpanLabel` for the words. Anything that needs a range comes through
 * here; nothing else may draw or phrase one.
 */

import { useId } from "react";

/** The four PBDB appearance bounds, uncollapsed. Null where none is recorded. */
export interface Appearance {
  fea: number | null;
  fla: number | null;
  lea: number | null;
  lla: number | null;
}

export interface Span {
  x: number;
  w: number;
}

export type Certainty = "extent" | "instant" | "overlapping" | "unrecorded";

export type BracketGeom =
  | {
      /** No appearance interval at all. The caller owes it a treatment. */
      kind: "absent";
    }
  | {
      kind: "range";
      /** `fea → lla`. Always drawn: it is the whole of what is recorded. */
      envelope: Span;
      /** `fla → lea`, and **only** when that has positive duration. */
      certain: Span | null;
      certainty: Certainty;
      /** Oldest and youngest bound in Ma, for the label and the tooltip. */
      oldest: number;
      youngest: number;
      /**
       * No last-appearance bracket was recorded, so the young end of the
       * envelope is where the record stops rather than where the taxon does.
       * 424 rows of 523,112 are partial in some way; this is most of them.
       */
      openYoung: boolean;
    };

/**
 * The narrowest a mark may be drawn, in px.
 *
 * Any mark has a floor, and on a symlog axis a Cretaceous stage can fall under
 * a pixel. This applies to the *envelope*, which is a real extent that would
 * otherwise vanish. It is deliberately not applied to the certain bar, which
 * is never drawn at zero duration at all — see the header.
 */
export const MIN_MARK_PX = 2;

function finite(v: number | null | undefined): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

function span(toX: (ma: number) => number, a: number, b: number): Span {
  const x1 = toX(a);
  const x2 = toX(b);
  let x = Math.min(x1, x2);
  let w = Math.abs(x1 - x2);
  if (w < MIN_MARK_PX) {
    x -= (MIN_MARK_PX - w) / 2;
    w = MIN_MARK_PX;
  }
  return { x, w };
}

/**
 * Pixel geometry for one taxon's appearance record.
 *
 * `toX` maps an age in Ma to a screen x — the same symlog mapping the axis and
 * the chronogram use, so a bracket in the lane is comparable with a node above
 * it. Nothing here knows about the scale beyond that.
 */
export function bracketGeom(a: Appearance, toX: (ma: number) => number): BracketGeom {
  const bounds = [a.fea, a.fla, a.lea, a.lla].filter(finite);
  if (bounds.length === 0) return { kind: "absent" };

  // Widest available, rather than `fea` and `lla` by name: a partial row is
  // still a real observation and its envelope is whatever it does record.
  const oldest = Math.max(...bounds);
  const youngest = Math.min(...bounds);

  let certainty: Certainty = "unrecorded";
  let certain: Span | null = null;
  if (finite(a.fla) && finite(a.lea)) {
    certainty = a.fla > a.lea ? "extent" : a.fla === a.lea ? "instant" : "overlapping";
    if (certainty === "extent") certain = span(toX, a.fla, a.lea);
  }

  return {
    kind: "range",
    envelope: span(toX, oldest, youngest),
    certain,
    certainty,
    oldest,
    youngest,
    openYoung: !finite(a.lea) && !finite(a.lla),
  };
}

/** How an age reads in the lane. Ma throughout, so the unit is said once. */
export function maLabel(ma: number): string {
  if (ma < 0.05) return "present";
  if (ma >= 100) return String(Math.round(ma));
  if (ma >= 10) return ma.toFixed(0);
  return ma.toFixed(1);
}

/**
 * A bracket's extent in words.
 *
 * The unit binds to the older figure when the younger one is not a figure:
 * "239–present Ma" parses as a number of Ma called "present", and a third of
 * the deepest clades in the tree have a last appearance of zero because they
 * are still alive.
 */
export function spanLabel(oldest: number, youngest: number): string {
  if (youngest < 0.05) return `${maLabel(oldest)} Ma – present`;
  return `${maLabel(oldest)}–${maLabel(youngest)} Ma`;
}

/**
 * The same span, for a lineage that is known to have ended.
 *
 * `maLabel` renders anything under 0.05 Ma as "present", which is right in the
 * drill-down lane — a third of the deepest clades really do have fossils
 * running to now. It is wrong by construction for the `occurrence` age tier,
 * which is only ever applied where nothing below the node is alive: *Homo
 * erectus* has a last appearance of 0.0117 Ma and rendered as "5.3 Ma –
 * present", which is a plain false statement about an extinct species.
 *
 * So this never says "present", and it keeps a significant figure below the
 * threshold instead of rounding a real bound to 0.0.
 */
export function endedSpanLabel(oldest: number, youngest: number): string {
  const y = youngest < 0.05 ? youngest.toPrecision(1) : maLabel(youngest);
  return `${maLabel(oldest)}–${y} Ma`;
}

/**
 * What one row claims, in words.
 *
 * The difference between an empty certain extent and a real one has to survive
 * without the key — it is the difference between "we know it was here" and "we
 * know it was somewhere in here" — so every row carries it in full on hover,
 * not only as a difference in ink.
 */
export function bracketTitle(name: string, b: BracketGeom): string {
  if (b.kind === "absent") {
    return `${name} — the Paleobiology Database records no appearance interval, so this taxon has no position in time here.`;
  }
  const extent = spanLabel(b.oldest, b.youngest);
  const head = b.openYoung
    ? `${name} — first appears within ${extent}; no last appearance is recorded`
    : `${name} — somewhere within ${extent}`;
  switch (b.certainty) {
    case "extent":
      return `${head}. Certainly present through the solid bar; the faded band is the widest the record allows.`;
    case "instant":
      return `${head}. The first- and last-appearance brackets meet at a single date, so no extent is certainly occupied.`;
    case "overlapping":
      return `${head}. The first- and last-appearance brackets overlap, so no part of this range is certainly occupied — only the possible extent is known.`;
    default:
      return `${head}. Only part of the appearance record is present.`;
  }
}

export interface BracketKeyRow {
  id: "certain" | "envelope" | "absent";
  text: string;
}

/**
 * The key for a set of brackets, naming only what is on screen.
 *
 * Same rule as the trace legend: a row never explains a mark the reader cannot
 * point at, so a lane where nothing is certainly occupied does not offer
 * "certainly present" for them to go looking for. The words are the key's
 * whole job; the sentence-length version is on each row's own tooltip.
 */
export function bracketKey(brackets: readonly BracketGeom[]): BracketKeyRow[] {
  const rows: BracketKeyRow[] = [];
  if (brackets.some((b) => b.kind === "range" && b.certain !== null)) {
    rows.push({ id: "certain", text: "certainly present" });
  }
  if (brackets.some((b) => b.kind === "range")) {
    rows.push({ id: "envelope", text: "possible extent" });
  }
  if (brackets.some((b) => b.kind === "absent")) {
    rows.push({ id: "absent", text: "no range recorded" });
  }
  return rows;
}

interface Props {
  /** From `bracketGeom`. `absent` draws nothing — the caller owes it words. */
  geom: BracketGeom;
  y: number;
  /** Height of the envelope band. The core sits centred inside it. */
  height: number;
  /** Fraction of `height` the solid core takes. */
  coreRatio?: number;
  title?: string;
  className?: string;
}

/**
 * The mark itself: a faded envelope with a solid core inside it.
 *
 * A reader has to be able to tell "certainly present through here" from "no
 * part of this is certain" without reading a key, and for 60.4% of taxa it is
 * the second. So the envelope carries end caps whether or not a core is drawn:
 * a capped band with nothing inside reads as a complete, deliberate mark,
 * where a bare fade reads as something that failed to render.
 */
export function Bracket({ geom, y, height, coreRatio = 0.52, title, className }: Props) {
  // A partial record's open end fades out rather than terminating at a
  // definite time, which is the vocabulary `.trace-unbounded` already uses on
  // the canvas for a position with no bound below it. Scoped per instance
  // rather than to a shared <defs>, so a second caller cannot inherit a
  // gradient that is not on its page.
  const gid = useId();
  if (geom.kind === "absent") return null;

  const coreH = Math.max(2, Math.round(height * coreRatio));
  const coreY = y + (height - coreH) / 2;
  const e = geom.envelope;

  return (
    <g className={["bracket", className].filter(Boolean).join(" ")}>
      {title && <title>{title}</title>}
      {geom.openYoung && (
        <defs>
          <linearGradient id={gid}>
            <stop offset="0%" stopColor="currentColor" stopOpacity="0.34" />
            <stop offset="100%" stopColor="currentColor" stopOpacity="0" />
          </linearGradient>
        </defs>
      )}
      <rect
        className="bracket-envelope"
        x={e.x}
        y={y}
        width={e.w}
        height={height}
        {...(geom.openYoung ? { fill: `url(#${gid})` } : {})}
      />
      {/* End caps, always. They are what makes an envelope with no core read
          as a whole mark rather than a missing one. The young cap is dropped
          where the record simply stops: capping it would claim a last
          appearance nobody recorded. */}
      <rect className="bracket-cap" x={e.x} y={y} width={1} height={height} />
      {!geom.openYoung && (
        <rect
          className="bracket-cap"
          x={e.x + e.w - 1}
          y={y}
          width={1}
          height={height}
        />
      )}
      {geom.certain && (
        <rect
          className="bracket-certain"
          x={geom.certain.x}
          y={coreY}
          width={geom.certain.w}
          height={coreH}
        />
      )}
    </g>
  );
}
