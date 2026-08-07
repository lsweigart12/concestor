/**
 * A PhyloPic silhouette, inlined into the DOM.
 *
 * Silhouettes are monochrome so `fill: currentColor` gives them the lane hue and
 * bloom — but the mirrored SVGs hardcode `fill="#000000"`, and through `<img>`
 * that cannot be recoloured, so it would render black on near-black. So the
 * markup is fetched and inlined with the baked fill stripped. Payloads are
 * immutable per build, so this is a one-time fetch per image, shared across
 * every node that inherited it.
 *
 * `name` is the accessible name and nothing else — a drawing that says
 * something (`borrowedTitle`'s clade sentence) passes one and is announced; a
 * drawing that would repeat an adjacent label passes none and is hidden. It is
 * attached on the wrapper, not in the markup: `sanitiseSvg` strips `title`,
 * `desc` and `aria-*`, and writing a name into the string would interpolate it
 * into `dangerouslySetInnerHTML`. Nothing here draws on hover: a silhouette is
 * a picture, and a picture that grows a paragraph when the pointer crosses it
 * is the reason none of this app's tooltips survive.
 */

import { useEffect, useState } from "react";
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
function describe(name: string | undefined): React.AriaAttributes & {
  role?: string;
} {
  return name === undefined
    ? { "aria-hidden": true }
    : { role: "img", "aria-label": name };
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
  name,
}: {
  phylopicId: string;
  x: number;
  y: number;
  size: number;
  /**
   * What the drawing is of, for a screen reader. Never drawn — see the note at
   * the head of this file.
   *
   * It used to be an SVG `<title>` child, which is the platform's tooltip by
   * another route and inherits every one of its faults — including being
   * written into the markup this component sets with
   * `dangerouslySetInnerHTML`, where a fossil name carrying an angle bracket
   * would have been interpolated straight into the DOM.
   */
  name?: string;
}) {
  const markup = useSilhouette(phylopicId);

  if (!markup) return null;
  const sized = markup.replace("<svg", `<svg width="${size}" height="${size}"`);
  return (
    <g
      className="silhouette"
      transform={`translate(${x},${y})`}
      {...describe(name)}
      dangerouslySetInnerHTML={{ __html: sized }}
    />
  );
}

export function Silhouette({
  phylopicId,
  size = 34,
  name,
  fallback = null,
}: {
  phylopicId: string;
  size?: number;
  /** What the drawing is of, for a screen reader. See {@link SilhouetteSvg}. */
  name?: string | undefined;
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

  if (!markup) return <>{fallback}</>;

  return (
    <span
      className="silhouette"
      style={{ width: size, height: size }}
      {...describe(name)}
      dangerouslySetInnerHTML={{ __html: markup }}
    />
  );
}
