/**
 * A PhyloPic silhouette, inlined into the DOM.
 *
 * architecture §7 says silhouettes are monochrome so `fill: currentColor`
 * drops them straight into the dark instrument and lets them take the trace
 * colour, bloom included. That is true of the *shape* but not of the files:
 * every mirrored SVG hardcodes `fill="#000000"` on its top-level `<g>`.
 * Through `<img src>` or `background-image` an SVG is an opaque image and
 * nothing in the page can recolour it — so the intended behaviour renders a
 * black silhouette on a near-black canvas, i.e. nothing at all.
 *
 * So the markup is fetched and inlined, with the baked fill stripped. Once the
 * paths are real DOM nodes, `fill: currentColor` works as designed and the
 * silhouette inherits the lane hue and the selection bloom.
 *
 * The mirror is ours and the payloads are immutable per build, so this is a
 * one-time fetch per image, shared across every node that inherited it — and
 * with a mean climb of 27 hops, a handful of images cover most of a view.
 *
 * **`tip` is the accessible name as well as the tooltip, and a drawing without
 * one is hidden.** A silhouette is content and not decoration — on a canvas of
 * dots and dates it is the only thing saying what an animal *looks like* — so
 * blanket `aria-hidden` was answering the wrong question. But the answer is not
 * "label them all" either, because almost none of these are portraits: the
 * corpus is 12,863 drawings against 2.7M nodes, and what the picture actually
 * claims is `borrowedTitle`'s sentence — *not Cetacea itself, a drawing from
 * within Delphinidae, the smallest group holding both (95 species)*. That claim
 * is the number `docs/handoff.md` §5 says the UI must render, and until now it
 * was rendered to whoever could hold a pointer still.
 *
 * So the rule is the one the callers already follow without knowing it: a
 * drawing that has something to say passes a `tip`, and it now says it to
 * everybody; a drawing that would only repeat the name printed beside it — the
 * detail card under its own `h2`, a palette row beside its own label — passes
 * none and stays out of the tree entirely. One prop, one sentence, and no way
 * to get one half of it right.
 *
 * It has to be attached out here, on the wrapper, and that is not a
 * preference. `sanitiseSvg` is an allow-list: `title` and `desc` are not
 * elements it emits and `aria-*` is not an attribute it keeps, so the fetched
 * markup cannot carry a name of its own — and writing one *into* the string
 * would interpolate a taxon name into `dangerouslySetInnerHTML`, which is the
 * hazard the `<title>` child was removed for in the first place. `role="img"`
 * on the wrapper also prunes the drawing's own nodes from the tree, so the
 * paths cannot report themselves as anything.
 */

import { useEffect, useState } from "react";
import { useTip } from "../chrome/Tooltip";
import { sanitiseSvg } from "./sanitiseSvg";

const cache = new Map<string, Promise<string | null>>();

async function load(url: string): Promise<string | null> {
  const hit = cache.get(url);
  if (hit) return hit;
  const p = (async () => {
    try {
      const res = await fetch(url);
      if (!res.ok) return null;
      return sanitiseSvg(await res.text());
    } catch {
      return null;
    }
  })();
  cache.set(url, p);
  return p;
}

/**
 * The markup for one drawing, or null until it arrives — and for good if it
 * never does.
 *
 * The two components below differ in their wrapper and in what they do with a
 * miss, and in nothing else; this is the whole of what they share, and it was
 * previously written out twice. `live` guards a component unmounted mid-flight
 * rather than the fetch itself, which is shared through `cache` and is somebody
 * else's to wait for.
 */
function useSilhouette(phylopicId: string): string | null {
  const [markup, setMarkup] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    load(`/v1/silhouette/${phylopicId}.svg`).then((m) => {
      if (live) setMarkup(m);
    });
    return () => {
      live = false;
    };
  }, [phylopicId]);
  return markup;
}

/**
 * How a drawing announces itself: by its own sentence, or not at all.
 *
 * Spread rather than branched at each call site, because the two wrappers below
 * are the same decision drawn in HTML and in SVG, and a rule written twice is
 * one that can be half-changed. `role="img"` is what makes the name stick to
 * something, and it prunes the fetched paths from the tree with it.
 */
function describe(tip: string | undefined): React.AriaAttributes & {
  role?: string;
} {
  return tip === undefined
    ? { "aria-hidden": true }
    : { role: "img", "aria-label": tip };
}

/**
 * The same drawing, inside an `<svg>` rather than beside one.
 *
 * The drill-down lane is a single SVG — brackets, spine and names are all
 * drawn in one coordinate space against the canvas's time axis — so the HTML
 * `<span>` below cannot go in it. Nested `<svg>` is valid and the fetched
 * markup carries its own `viewBox`, so re-attaching the width and height that
 * `sanitiseSvg` strips is the whole of the difference. Same fetch, same cache:
 * a lane full of fossils and a canvas full of nodes share one download each.
 */
export function SilhouetteSvg({
  phylopicId,
  x,
  y,
  size,
  tip,
}: {
  phylopicId: string;
  x: number;
  y: number;
  size: number;
  /**
   * What the drawing is of, on hover — and, since it is the only sentence
   * anywhere that says what this picture claims, its accessible name too. See
   * the note at the head of this file for why the two are one prop.
   *
   * It used to be an SVG `<title>` child, which is the platform's tooltip by
   * another route and inherits every one of its faults — including being
   * written into the markup this component sets with
   * `dangerouslySetInnerHTML`, where a fossil name carrying an angle bracket
   * would have been interpolated straight into the DOM.
   */
  tip?: string;
}) {
  const markup = useSilhouette(phylopicId);
  const hover = useTip(tip);

  if (!markup) return null;
  const sized = markup.replace("<svg", `<svg width="${size}" height="${size}"`);
  return (
    <g
      className="silhouette"
      transform={`translate(${x},${y})`}
      {...describe(tip)}
      {...hover}
      dangerouslySetInnerHTML={{ __html: sized }}
    />
  );
}

export function Silhouette({
  phylopicId,
  size = 34,
  tip,
  fallback = null,
}: {
  phylopicId: string;
  size?: number;
  /** What the drawing is of, and its name. See {@link SilhouetteSvg}'s note. */
  tip?: string | undefined;
  /**
   * What to render before the markup arrives, and if it never does — the
   * mirror is populated in the background, so "known but not yet on disk" is
   * an ordinary state and a 404 has to look like something.
   *
   * Defaults to nothing, which is what the canvas wants: a placeholder box
   * there would be chrome, and the canvas is the page. A palette row wants the
   * opposite, because its icon sits in a fixed slot that would otherwise blink
   * empty and shift the rows below it.
   */
  fallback?: React.ReactNode;
}) {
  const markup = useSilhouette(phylopicId);
  const hover = useTip(tip);

  if (!markup) return <>{fallback}</>;

  return (
    <span
      className="silhouette"
      style={{ width: size, height: size }}
      {...describe(tip)}
      {...hover}
      dangerouslySetInnerHTML={{ __html: markup }}
    />
  );
}
