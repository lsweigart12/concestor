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
   * What the drawing is of, on hover. It used to be an SVG `<title>` child,
   * which is the platform's tooltip by another route and inherits every one of
   * its faults — including being written into the markup this component sets
   * with `dangerouslySetInnerHTML`, where a fossil name carrying an angle
   * bracket would have been interpolated straight into the DOM.
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
      aria-hidden="true"
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
  /** What the drawing is of, on hover. See {@link SilhouetteSvg}'s note. */
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
      aria-hidden="true"
      {...hover}
      dangerouslySetInnerHTML={{ __html: markup }}
    />
  );
}
