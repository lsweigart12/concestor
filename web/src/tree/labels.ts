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
  isLeaf: boolean;
  /** The taxon name. Wraps when it must. */
  name: string;
  /** Short trailing figure kept on the name's line — "≤ 96 Ma". */
  trailing: string;
  /** Secondary row: rank, and what an inherited silhouette actually depicts. */
  meta: string;
  hasSilhouette: boolean;
  /** Placed in descending order, so the most important labels get first pick. */
  priority: number;
}

export interface LabelBox {
  side: "left" | "right";
  /** Vertical offset of the label's centre from the node's centre. */
  dy: number;
  width: number;
  height: number;
  /** CSS max-width for the text block; what actually drives the wrapping. */
  textMaxWidth: number;
  /** True when no candidate was clear and we took the least-bad one. */
  overlapped: boolean;
}

/** A drawn edge, as the orthogonal pair of runs `orthPath` emits. */
export interface TraceRun {
  ax: number;
  ay: number;
  bx: number;
  by: number;
}

// Must match `.mark-name` / `.mark-meta` in styles.css. A label measured at
// one size and rendered at another is a label placed against the wrong box.
const NAME_FONT = "12.5px ui-sans-serif, -apple-system, sans-serif";
const META_FONT = "9.5px ui-monospace, monospace";

const SIL = 34; // silhouette box
const SIL_GAP = 9;
const DOT_GAP = 13; // node centre → nearest label edge
const NAME_LINE = 16;
const META_LINE = 13;
const TRACE_HALF = 5; // traces are 1.6px cores with a 7px halo; keep clear of both
const DOT_HALF = 8;
const MIN_TEXT_W = 88;
const WRAP_LEVELS = 3;

// CSS `letter-spacing`, in em, for the two rows. See `textWidth`.
const NAME_TRACKING = 0.005;
const META_TRACKING = 0.06;
/**
 * Bias every measurement slightly wide.
 *
 * The model and the browser will never agree exactly — font fallback, subpixel
 * advances, the margin on the age. The errors are not symmetric in cost: an
 * over-estimate reserves a few pixels too many and nothing looks wrong, while
 * an under-estimate flips a row count and puts text through a line. So round
 * against ourselves.
 */
const SLACK = 1.06;

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

function metricsFor(n: LabelInput, wrap: number, cap: number): Metrics {
  const nameW = textWidth(n.name, NAME_FONT, NAME_TRACKING) * SLACK;
  const trailW = n.trailing ? textWidth(n.trailing, META_FONT) * SLACK + 8 : 0;
  const metaW = textWidth(n.meta, META_FONT, META_TRACKING) * SLACK;
  const naturalText = Math.max(nameW + trailW, metaW);

  const textMaxWidth = Math.max(
    MIN_TEXT_W,
    Math.min(cap, naturalText / (wrap + 1)),
  );
  const nameRows = Math.max(1, Math.ceil((nameW + trailW) / textMaxWidth));
  const metaRows = n.meta ? Math.max(1, Math.ceil(metaW / textMaxWidth)) : 0;

  const textW = Math.min(naturalText, textMaxWidth);
  const textH = nameRows * NAME_LINE + metaRows * META_LINE;
  const silW = n.hasSilhouette ? SIL + SIL_GAP : 0;

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
 * Leaves want to sit beside their point on the open margin side, so they try
 * right, then vertical dodges, and only then the crowded interior. Clades
 * default above-left — nothing is ever routed there, since the parent arrives
 * horizontally at the node's own y and its vertical drop is back at the
 * parent's x — and fall through to above-right, below-left, below-right. That
 * ordering is what makes a blocked clade label step sideways into open space
 * rather than downward through its own subtree.
 */
function candidatesFor(n: LabelInput, h: number, rowH: number): Candidate[] {
  const near = h / 2 + 10;
  const step = Math.max(rowH * 0.34, 22);

  if (n.isLeaf) {
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
  return {
    x: c.side === "right" ? n.x + DOT_GAP : n.x - DOT_GAP - m.width,
    y: n.y + c.dy - m.height / 2,
    w: m.width,
    h: m.height,
  };
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
  for (const n of inputs) {
    occupied.push({
      x: n.x - DOT_HALF,
      y: n.y - DOT_HALF,
      w: DOT_HALF * 2,
      h: DOT_HALF * 2,
    });
  }

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
    const x = b.side === "right" ? n.x + DOT_GAP : n.x - DOT_GAP - b.width;
    minX = Math.min(minX, x);
    maxX = Math.max(maxX, x + b.width);
    minY = Math.min(minY, n.y + b.dy - b.height / 2);
    maxY = Math.max(maxY, n.y + b.dy + b.height / 2);
  }
  if (!Number.isFinite(minX)) return null;
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
}
