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

const cache = new Map<string, Promise<string | null>>();

/**
 * Strip the baked fill, and anything active.
 *
 * These files come from our own mirror of a public upload site. The fill
 * rewrite is the point; dropping `<script>`, foreignObject and `on*` handlers
 * is ordinary hygiene for markup that is about to be inlined, and costs one
 * pass over a few kilobytes.
 */
export function sanitiseSvg(raw: string): string | null {
  const start = raw.indexOf("<svg");
  if (start < 0) return null;
  let svg = raw.slice(start);
  svg = svg.replace(/<script[\s\S]*?<\/script>/gi, "");
  svg = svg.replace(/<foreignObject[\s\S]*?<\/foreignObject>/gi, "");
  svg = svg.replace(/\son\w+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, "");
  // The whole reason this component exists.
  svg = svg.replace(/\sfill\s*=\s*("|')#?(000000|000|black)\1/gi, ' fill="currentColor"');
  svg = svg.replace(/fill\s*:\s*#?(000000|000|black)\s*;?/gi, "fill:currentColor;");
  // Let CSS size it rather than the file's intrinsic attributes.
  svg = svg.replace(/\s(width|height)\s*=\s*("[^"]*"|'[^']*')/gi, "");
  return svg;
}

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

export function Silhouette({
  phylopicId,
  size = 34,
  title,
  fallback = null,
}: {
  phylopicId: string;
  size?: number;
  title?: string | undefined;
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

  if (!markup) return <>{fallback}</>;

  return (
    <span
      className="silhouette"
      style={{ width: size, height: size }}
      title={title}
      aria-hidden="true"
      dangerouslySetInnerHTML={{ __html: markup }}
    />
  );
}
