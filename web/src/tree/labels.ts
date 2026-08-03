/**
 * Label placement.
 *
 * Positions in this app are computed, never simulated — and until now that
 * applied to the *nodes* while their labels were pinned at fixed offsets and
 * left to collide. With a handful of well-spaced species that reads fine. With
 * a clade whose child sits in the same lane, it does not: the child's trace
 * runs horizontally out of the parent at exactly the parent's y, so a label on
 * that side is drawn straight through a line, and the next node's label is
 * drawn through that.
 *
 * So labels get the same treatment as nodes. Each one measures itself, asks for
 * a place, and takes the first candidate that collides with nothing — nodes,
 * traces, or labels already placed. Failing that it wraps to two or three rows
 * and asks again. Failing *that* it takes the least-bad position and says so,
 * because with enough lineages converging on one divergence point some overlap
 * is genuinely unavoidable and pretending otherwise just hides it.
 *
 * The search is deterministic and order-stable: same inputs, same layout, every
 * time. Nothing here is a physics simulation or an annealing pass.
 */

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface LabelInput {
  idx: number;
  x: number;
  y: number;
  /**
   * The mark ends its line, with the margin to its right open.
   *
   * A question about geometry, not about the topology — which is why it is not
   * spelled `isLeaf`. A chosen leaf is one; so is a **graft**, whose connector
   * arrives from the left and stops at the fossil with nothing beyond it. Giving
   * a graft the divergence ordering, which it had, put every fossil's name and
   * silhouette a half-row above the mark they belong to.
   */
  terminal: boolean;
  /** The taxon name. Wraps when it must. */
  name: string;
  /** What the mark says about time — "≤ 96 Ma", "56–41 Ma". Its own row. */
  trailing: string;
  /**
   * Whether a glyph precedes that figure — the ammonite before a fossil range,
   * which is the only one left. Measured rather than drawn here, so it is a
   * width and not a string.
   */
  trailingGlyph: boolean;
  /** The rank. Its own row, above the name. */
  meta: string;
  hasSilhouette: boolean;
  /**
   * Drawn at `--w-med` rather than `--w-reg`, which is 4.0% wider.
   *
   * A property of the *type*, not of the topology, which is why it is not
   * spelled `isMRCA` even though the MRCA is currently the only mark that
   * carries it. Whatever `.mark.is-mrca .mark-label` grows to cover, the rule
   * to keep is that a label measured in one weight and drawn in another is a
   * label placed against the wrong box.
   */
  medium: boolean;
  /** Placed in descending order, so the most important labels get first pick. */
  priority: number;
}

/**
 * Where a label sits relative to the mark it names — enough of one to say
 * where its box is, and no more.
 *
 * Split out from {@link LabelBox} because three places were computing that box
 * from the same four numbers: the candidate search, the content bounds, and now
 * the viewport's reveal. Three copies of one offset is three chances for a
 * label to be measured a few pixels away from where it is drawn.
 */
export interface LabelPlacement {
  side: "left" | "right";
  /** Vertical offset of the label's centre from the node's centre. */
  dy: number;
  width: number;
  height: number;
}

export interface LabelBox extends LabelPlacement {
  /** CSS max-width for the text block; what actually drives the wrapping. */
  textMaxWidth: number;
  /** True when no candidate was clear and we took the least-bad one. */
  overlapped: boolean;
}

/** The box a placed label occupies, given the mark's own centre. */
export function labelRect(x: number, y: number, b: LabelPlacement): Rect {
  return {
    x: b.side === "right" ? x + DOT_GAP : x - DOT_GAP - b.width,
    y: y + b.dy - b.height / 2,
    w: b.width,
    h: b.height,
  };
}

/** The mark's own dot, which is what a label is placed clear of. */
export function dotRect(x: number, y: number): Rect {
  return { x: x - DOT_HALF, y: y - DOT_HALF, w: DOT_HALF * 2, h: DOT_HALF * 2 };
}

/** A drawn edge, as the orthogonal pair of runs `orthPath` emits. */
export interface TraceRun {
  ax: number;
  ay: number;
  bx: number;
  by: number;
}

/**
 * The two stacks, spelled exactly as `--sans` and `--mono` in styles.css.
 *
 * Exported because four other measurements were each carrying their own
 * abbreviation of them, and an abbreviation is not a shorthand here: canvas
 * resolves `ui-sans-serif, -apple-system, sans-serif` to a different face than
 * the full list, **6.1% narrower** at 12.5px. Every label was measured against
 * that face and drawn in the real one, and `SLACK` was quietly absorbing the
 * whole error — which is why a second mismatch on top of it had nowhere to go.
 */
export const SANS =
  'ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif';
export const MONO =
  'ui-monospace, "SF Mono", "JetBrains Mono", Menlo, Consolas, monospace';

/**
 * Must match `.mark-name`, `.mark-age` and `.mark-meta` in styles.css. A label
 * measured at one size and rendered at another is a label placed against the
 * wrong box — and there were two of those.
 *
 * `.mark-age` renders at **11px**, not the 9.5px of `.mark-meta`; measured as
 * meta, "≤ 6.7 Ma" came out 15.8% short and the divergence's own name was
 * wrapped to make room for a figure that then did not fit either. And
 * `.mark.is-mrca .mark-label` sets `font-weight: var(--w-med)`, 560, which
 * `.mark-name` inherits: measured at 400, "Primates" was 9.1% short of the box
 * it was given and broke across two lines as "Primate" / "s". The MRCA is the
 * one label in this app guaranteed to be on screen.
 */
const NAME_FONT = `12.5px ${SANS}`;
const NAME_FONT_MED = `560 12.5px ${SANS}`;
const AGE_FONT = `11px ${MONO}`;
const AGE_FONT_MED = `560 11px ${MONO}`;
const META_FONT = `9.5px ${MONO}`;
const META_FONT_MED = `560 9.5px ${MONO}`;

const SIL = 34; // silhouette box
const SIL_GAP = 9;
const DOT_GAP = 13; // node centre → nearest label edge
const NAME_LINE = 16;
/**
 * The rank row and the age row, which are 9.5px and 11px type respectively.
 *
 * One constant for both, tall enough for the larger, because the difference is
 * a pixel and a half and two constants would have to be kept in step with two
 * CSS rules for it.
 */
const META_LINE = 15;
const TRACE_HALF = 5; // traces are 1.6px cores with a 7px halo; keep clear of both
const DOT_HALF = 8;
const MIN_TEXT_W = 88;
const WRAP_LEVELS = 3;
// `.age-glyph` and its right margin. A glyph that stands in for a word has to
// be reserved like one, or a label measured without it is drawn through
// whatever sits to its right.
const GLYPH_W = 16;

// CSS `letter-spacing`, in em, for the three runs. See `textWidth`. The age's
// is negative and comes from `.num` rather than `.mark-age` — tabular figures
// are set slightly tight — so leaving it out would only ever over-reserve, but
// it costs nothing to be right about.
const NAME_TRACKING = 0.005;
const AGE_TRACKING = -0.01;
const META_TRACKING = 0.06;
/**
 * Bias every measurement slightly wide.
 *
 * The model and the browser will never agree exactly — subpixel advances, the
 * margin on the age, whether a webfont has finished loading. The errors are not
 * symmetric in cost: an over-estimate reserves a few pixels too many and nothing
 * looks wrong, while an under-estimate flips a row count and puts text through a
 * line. So round against ourselves.
 *
 * It is genuine slack now and not a correction. It used to be spending its whole
 * 6% on the truncated font stack above, which left nothing for the real
 * disagreements and made the two size and weight mismatches visible rather than
 * merely present.
 */
const SLACK = 1.06;

/**
 * Everything above that is a claim about styles.css, gathered so a test can
 * hold it to one.
 *
 * "Must match `.mark-name` / `.mark-meta`" was a comment for as long as this
 * file has existed, and three of the numbers under it drifted anyway. A comment
 * cannot fail; `labels.test.ts` reads the stylesheet and compares.
 */
export const TYPE = {
  NAME_FONT,
  NAME_FONT_MED,
  AGE_FONT,
  META_FONT,
  NAME_TRACKING,
  AGE_TRACKING,
  META_TRACKING,
  NAME_LINE,
  META_LINE,
  GLYPH_W,
} as const;

// ---------------------------------------------------------------- measuring --

let ctx: CanvasRenderingContext2D | null | undefined;

function measurer(): CanvasRenderingContext2D | null {
  if (ctx !== undefined) return ctx;
  try {
    ctx = document.createElement("canvas").getContext("2d");
  } catch {
    ctx = null;
  }
  return ctx;
}

/**
 * Width of a run of text.
 *
 * Canvas `measureText` where there is a DOM, and an average-advance estimate
 * where there is not — which keeps this callable from tests and keeps the
 * placement deterministic rather than dependent on when fonts finish loading.
 * The estimate is only ever used to decide *placement*, and a placement chosen
 * from a slightly wrong width is still a placement, not a crash.
 */
export function textWidth(text: string, font: string, tracking = 0): number {
  if (!text) return 0;
  const px = Number.parseFloat(font) || 13;
  // `measureText` knows nothing about CSS letter-spacing, and `.mark-meta`
  // carries 0.06em — eleven pixels across a twenty-character rank. Under-
  // measuring a row is how a label the placement pass believed was clear ends
  // up one row taller than modelled and drawn straight through a trace.
  const tracked = text.length * px * tracking;
  const m = measurer();
  if (m) {
    m.font = font;
    return m.measureText(text).width + tracked;
  }
  return text.length * px * 0.52 + tracked;
}

interface Metrics {
  width: number;
  height: number;
  textMaxWidth: number;
}

/**
 * Three rows: what kind of thing this is, which thing it is, and when.
 *
 * The age used to ride on the name's line, and on a left-hand label that line is
 * right-aligned — so the figure took the space nearest the mark and the *name*
 * was pushed away from the thing it names. `Boreoeutheria ≤ 96 Ma` reserved 139
 * units where the name needs 85, and every one of those units is distance
 * between a label and its own point.
 *
 * On rows of their own the label is as wide as its widest row rather than the
 * sum of them, which is the whole gain, and the three read in the order a
 * stranger needs: the rank says what kind of thing is being named before the
 * name arrives, and the age is the fact you go looking for once you know.
 */
function metricsFor(n: LabelInput, wrap: number, cap: number): Metrics {
  const nameFont = n.medium ? NAME_FONT_MED : NAME_FONT;
  const ageFont = n.medium ? AGE_FONT_MED : AGE_FONT;
  const metaFont = n.medium ? META_FONT_MED : META_FONT;

  const nameW = textWidth(n.name, nameFont, NAME_TRACKING) * SLACK;
  const ageW =
    n.trailing || n.trailingGlyph
      ? textWidth(n.trailing, ageFont, AGE_TRACKING) * SLACK +
        (n.trailingGlyph ? GLYPH_W : 0)
      : 0;
  const rankW = n.meta ? textWidth(n.meta, metaFont, META_TRACKING) * SLACK : 0;
  const naturalText = Math.max(nameW, ageW, rankW);

  const textMaxWidth = Math.max(
    MIN_TEXT_W,
    Math.min(cap, naturalText / (wrap + 1)),
  );
  const rows = (w: number) =>
    w ? Math.max(1, Math.ceil(w / textMaxWidth)) : 0;
  const metaRows = rows(ageW) + rows(rankW);

  // A label with no words at all is a real state now that the reader can turn
  // them off, and it must reserve nothing rather than the 88px floor and the
  // name's line: the silhouette is the whole label, and a box padded out to
  // where the text would have been pushes every neighbouring label aside to
  // keep room for a string nobody asked to see.
  const textW = naturalText ? Math.min(naturalText, textMaxWidth) : 0;
  const textH = rows(nameW) * NAME_LINE + metaRows * META_LINE;
  const silW = n.hasSilhouette ? SIL + (textW ? SIL_GAP : 0) : 0;

  return {
    width: silW + textW,
    height: Math.max(textH, n.hasSilhouette ? SIL : 0),
    textMaxWidth,
  };
}

// --------------------------------------------------------------- candidates --

interface Candidate {
  side: "left" | "right";
  dy: number;
}

/**
 * Where a label is willing to go, best first.
 *
 * Terminal marks want to sit beside their point on the open margin side, so
 * they try right, then vertical dodges, and only then the crowded interior.
 * Clades default above-left — nothing is ever routed there, since the parent
 * arrives horizontally at the node's own y and its vertical drop is back at the
 * parent's x — and fall through to above-right, below-left, below-right. That
 * ordering is what makes a blocked clade label step sideways into open space
 * rather than downward through its own subtree.
 *
 * The split is `terminal`, not `isLeaf`, and the difference is not cosmetic: the
 * clade list never offers `dy: 0` until its ninth candidate, so anything sent
 * down it that *is* a terminal mark is displaced by half a row even when the
 * space beside it is completely clear. That is what happened to every graft.
 */
function candidatesFor(n: LabelInput, h: number, rowH: number): Candidate[] {
  const near = h / 2 + 10;
  const step = Math.max(rowH * 0.34, 22);

  if (n.terminal) {
    const out: Candidate[] = [{ side: "right", dy: 0 }];
    for (const d of [near, -near, near + step, -(near + step)]) {
      out.push({ side: "right", dy: d });
    }
    out.push({ side: "left", dy: 0 });
    for (const d of [near, -near]) out.push({ side: "left", dy: d });
    return out;
  }

  const out: Candidate[] = [];
  for (const d of [-near, near, -(near + step), near + step, 0]) {
    out.push({ side: "left", dy: d }, { side: "right", dy: d });
  }
  for (const d of [-(near + step * 2), near + step * 2]) {
    out.push({ side: "left", dy: d }, { side: "right", dy: d });
  }
  return out;
}

function rectFor(n: LabelInput, c: Candidate, m: Metrics): Rect {
  return labelRect(n.x, n.y, {
    side: c.side,
    dy: c.dy,
    width: m.width,
    height: m.height,
  });
}

// ---------------------------------------------------------------- collision --

function overlapArea(a: Rect, b: Rect): number {
  const dx = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
  if (dx <= 0) return 0;
  const dy = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
  return dy <= 0 ? 0 : dx * dy;
}

function totalOverlap(r: Rect, occupied: readonly Rect[]): number {
  let sum = 0;
  for (const o of occupied) sum += overlapArea(r, o);
  return sum;
}

/** The two orthogonal runs a drawn edge occupies. */
export function traceRects(runs: readonly TraceRun[]): Rect[] {
  const out: Rect[] = [];
  for (const e of runs) {
    // vertical, at the parent's x, spanning the two y values
    out.push({
      x: e.ax - TRACE_HALF,
      y: Math.min(e.ay, e.by) - TRACE_HALF,
      w: TRACE_HALF * 2,
      h: Math.abs(e.by - e.ay) + TRACE_HALF * 2,
    });
    // horizontal, at the child's y, spanning the two x values
    out.push({
      x: Math.min(e.ax, e.bx) - TRACE_HALF,
      y: e.by - TRACE_HALF,
      w: Math.abs(e.bx - e.ax) + TRACE_HALF * 2,
      h: TRACE_HALF * 2,
    });
  }
  return out;
}

// ------------------------------------------------------------------- place --

export function placeLabels(
  inputs: readonly LabelInput[],
  runs: readonly TraceRun[],
  opts: { rowH: number; maxTextWidth: number },
): Map<number, LabelBox> {
  const occupied: Rect[] = traceRects(runs);
  for (const n of inputs) occupied.push(dotRect(n.x, n.y));

  // Most important first: whoever picks first gets the clear space. Ties break
  // on idx so the result never depends on Map iteration order.
  const order = [...inputs].sort(
    (a, b) => b.priority - a.priority || a.idx - b.idx,
  );

  const out = new Map<number, LabelBox>();
  for (const n of order) {
    let chosen: { c: Candidate; m: Metrics; r: Rect } | null = null;
    let fallback: { c: Candidate; m: Metrics; r: Rect; score: number } | null =
      null;

    // Try every position at the natural width before wrapping anything, so a
    // label steps aside in preference to becoming three cramped rows.
    for (let wrap = 0; wrap < WRAP_LEVELS && !chosen; wrap++) {
      const m = metricsFor(n, wrap, opts.maxTextWidth);
      for (const c of candidatesFor(n, m.height, opts.rowH)) {
        const r = rectFor(n, c, m);
        const score = totalOverlap(r, occupied);
        if (score === 0) {
          chosen = { c, m, r };
          break;
        }
        if (!fallback || score < fallback.score) fallback = { c, m, r, score };
      }
    }

    const pick = chosen ?? fallback;
    if (!pick) continue;
    out.set(n.idx, {
      side: pick.c.side,
      dy: pick.c.dy,
      width: pick.m.width,
      height: pick.m.height,
      textMaxWidth: pick.m.textMaxWidth,
      overlapped: chosen === null,
    });
    occupied.push(pick.r);
  }
  return out;
}

/** Bounds of everything drawn, so the fit can frame labels and not just dots. */
export function labelBounds(
  inputs: readonly LabelInput[],
  boxes: ReadonlyMap<number, LabelBox>,
): Rect | null {
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (const n of inputs) {
    const b = boxes.get(n.idx);
    if (!b) continue;
    const r = labelRect(n.x, n.y, b);
    minX = Math.min(minX, r.x);
    maxX = Math.max(maxX, r.x + r.w);
    minY = Math.min(minY, r.y);
    maxY = Math.max(maxY, r.y + r.h);
  }
  if (!Number.isFinite(minX)) return null;
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
}
