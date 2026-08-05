/**
 * Turn a fetched drawing into markup this app is willing to inline.
 *
 * `Silhouette.tsx` says why the markup is inlined at all: through `<img src>`
 * an SVG is an opaque image, `fill: currentColor` cannot reach inside it, and
 * every mirrored file bakes `fill="#000000"` — so the intended behaviour draws
 * a black silhouette on a near-black canvas, i.e. nothing. Inlining is the fix,
 * and it is the app's only `dangerouslySetInnerHTML` path. What this function
 * returns is the whole of what stands between a fetched file and the DOM.
 *
 * **It is an allow-list over a tag scan, not a chain of deletions**, and that
 * is the design decision here. A deny-list is only ever as good as the last
 * vector somebody thought of: the previous version deleted `<script>`,
 * `<foreignObject>` and `on*` handlers, and passed `<style>`, `<set>`,
 * `<animate>` and `xlink:href="javascript:…"` through untouched. An allow-list
 * is wrong only about things it has not heard of, and being wrong there means
 * dropping them. The lists below are a census of the 12,863-file mirror — the
 * whole corpus speaks nine elements and twenty-two attributes — plus the inert
 * neighbours a second image source would plausibly arrive with.
 *
 * No DOMParser and no dependency. The mirror is ours and its payloads are
 * immutable per build, so a 20 kB sanitiser buys nothing the census does not;
 * and staying a pure string function is what lets the whole of it be tested in
 * the `node` environment this suite runs in, which is most of what this file is
 * for.
 *
 * Two things it must not get wrong, both of them tested:
 *
 * - **`width`/`height` come off the root element and off nothing else.** The
 *   old strip was global over the document, so `<rect x="0" y="0" width="40"
 *   height="20"/>` came out as `<rect x="0" y="0"/>` while the caller only ever
 *   re-attached the *root's*. That is live, not theoretical: three mirrored
 *   drawings are a raster inside an `<image>` and one clips against a `<rect>`,
 *   between them the picture 7,837 nodes inherit — *Eilema* at 7,753,
 *   *Macropodus opercularis* at 77, *Ateles paniscus* at 7.
 * - **`<style>` is dropped rather than kept.** Inlined markup puts its rules
 *   into the page's one cascade, where `.cls-1 { … }` is a global selector a
 *   drawing has no business declaring — a correctness problem before it is a
 *   security one. Four files carry one, all four `fill:#231f20` on a class that
 *   `styles.css`'s `.silhouette svg path` already outranks, so the whole cost
 *   is a sub-pixel stroke on one fern (*Botrypus virginianus*, one node).
 */

/** Elements that may reach the DOM. Lower-cased; the tag keeps its own case. */
const ELEMENTS = new Set([
  "svg",
  "g",
  "defs",
  "clippath",
  "mask",
  "path",
  "rect",
  "circle",
  "ellipse",
  "line",
  "polyline",
  "polygon",
  "image",
]);

/**
 * Attributes that may reach the DOM, `href` aside — it has its own rule below.
 * Lower-cased, and matched case-insensitively, so `viewBox` is `viewbox` here
 * and is re-emitted with the case the file gave it.
 */
const ATTRIBUTES = new Set([
  "class",
  "clip-path",
  "clip-rule",
  "clippathunits",
  "color",
  "cx",
  "cy",
  "d",
  "display",
  "fill",
  "fill-opacity",
  "fill-rule",
  "height",
  "id",
  "mask",
  "maskunits",
  "opacity",
  "points",
  "preserveaspectratio",
  "r",
  "rx",
  "ry",
  "stroke",
  "stroke-dasharray",
  "stroke-linecap",
  "stroke-linejoin",
  "stroke-miterlimit",
  "stroke-opacity",
  "stroke-width",
  "style",
  "transform",
  "version",
  "viewbox",
  "width",
  "x",
  "x1",
  "x2",
  "xml:space",
  "xmlns",
  "xmlns:svg",
  "xmlns:xlink",
  "y",
  "y1",
  "y2",
]);

const HREF = new Set(["href", "xlink:href"]);

/**
 * What an `href` may point at: somewhere in this same document, or a raster
 * carried inside the file. Three mirrored drawings are a base64 jpeg or png in
 * an `<image>`, so refusing `data:` outright would cost real pictures.
 * `data:image/svg+xml` is deliberately not on the list — that is a document,
 * and a document can carry script.
 */
const SAFE_HREF =
  /^\s*(?:#[^\s"'<>]+|data:image\/(?:png|jpeg|gif|webp);base64,[A-Za-z0-9+/=\s]*)\s*$/i;

/**
 * A value may name something in this document and may not reach out of it.
 * `clip-path="url(#clipPath374)"` is ordinary and stays; anything else in a
 * `url()` is a request to a third party made by a file we are inlining.
 */
const FOREIGN_REF = /url\(\s*["']?\s*(?!#)/i;

/**
 * Schemes that do something rather than name something. The leading boundary
 * is load-bearing: without it `metadata:` matches `data:`.
 */
const ACTIVE_SCHEME = /(?:^|[^\w-])(?:javascript|vbscript|data)\s*:/i;

/** The whole reason `Silhouette.tsx` exists, as an attribute and in a rule. */
const BAKED_FILL = /^\s*#?(?:000000|000|black)\s*$/i;
const BAKED_FILL_DECL = /fill\s*:\s*#?(?:000000|000|black)\s*(;|$)/gi;

/**
 * Comment, CDATA, processing instruction, close tag, open tag — in that order,
 * so that a `<!--` is never read as an element called `!--`. The attribute run
 * steps over quoted values so a `>` inside one does not end the tag.
 */
const TOKEN =
  /<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>|<[!?][\s\S]*?>|<\/\s*([A-Za-z][\w:.-]*)\s*>|<([A-Za-z][\w:.-]*)((?:"[^"]*"|'[^']*'|[^>"'])*?)(\/?)>/g;

const ATTRIBUTE = /([A-Za-z_:][\w:.-]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/g;

/** `&` that does not already open an entity, which is the only one to escape. */
const BARE_AMP = /&(?!#\d+;|#x[0-9a-f]+;|[a-z][a-z0-9]*;)/gi;

function escapeValue(value: string): string {
  return value
    .replace(BARE_AMP, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * One element's attributes, filtered and rewritten.
 *
 * `root` is the only place `width` and `height` are dropped: the root is sized
 * by CSS (`.silhouette svg`) or re-attached by the caller, and every inner
 * element's geometry is its own business.
 */
function attributes(raw: string, root: boolean): string {
  let out = "";
  ATTRIBUTE.lastIndex = 0;
  for (let m = ATTRIBUTE.exec(raw); m; m = ATTRIBUTE.exec(raw)) {
    const written = m[1] ?? "";
    const name = written.toLowerCase();
    let value = m[2] ?? m[3] ?? m[4] ?? "";

    if (HREF.has(name)) {
      if (!SAFE_HREF.test(value)) continue;
    } else {
      if (!ATTRIBUTES.has(name)) continue;
      if (root && (name === "width" || name === "height")) continue;
      if (FOREIGN_REF.test(value) || ACTIVE_SCHEME.test(value)) continue;
      if (name === "fill" && BAKED_FILL.test(value)) value = "currentColor";
      if (name === "style") value = value.replace(BAKED_FILL_DECL, "fill:currentColor$1");
    }

    out += ` ${written}="${escapeValue(value)}"`;
  }
  return out;
}

/** An element that is open. `kept` is false for everything being discarded. */
interface Frame {
  name: string;
  kept: boolean;
}

/**
 * Rewrite fetched SVG into something safe to inline, or null if it is not SVG.
 *
 * The output is balanced whatever the input was: an unmatched close tag is
 * ignored and anything still open at the end is closed, because this string
 * goes to `innerHTML` and a truncated file must not adopt the rest of the page.
 */
export function sanitiseSvg(raw: string): string | null {
  const opening = /<svg[\s/>]/i.exec(raw);
  if (!opening) return null;
  const src = raw.slice(opening.index);

  const out: string[] = [];
  const stack: Frame[] = [];
  // How many enclosing elements are being discarded. Text and tags are emitted
  // only at zero, and a kept element can never sit inside a discarded one.
  let dropped = 0;
  let text = 0;

  TOKEN.lastIndex = 0;
  for (let m = TOKEN.exec(src); m; m = TOKEN.exec(src)) {
    if (dropped === 0) out.push(src.slice(text, m.index));
    text = TOKEN.lastIndex;

    const closing = m[1];
    const opened = m[2];

    if (closing !== undefined) {
      const name = closing.toLowerCase();
      let at = stack.length - 1;
      while (at >= 0 && stack[at]?.name.toLowerCase() !== name) at--;
      // A close tag matching nothing open is noise; dropping it is what keeps
      // the output balanced.
      if (at < 0) continue;
      for (let i = stack.length - 1; i >= at; i--) {
        const frame = stack[i];
        if (!frame) continue;
        if (frame.kept) out.push(`</${frame.name}>`);
        else dropped--;
      }
      stack.length = at;
      continue;
    }

    if (opened === undefined) continue; // comment, CDATA, doctype

    const root = stack.length === 0;
    const keep = dropped === 0 && ELEMENTS.has(opened.toLowerCase());
    const empty = m[4] === "/";
    if (keep) {
      out.push(`<${opened}${attributes(m[3] ?? "", root)}${empty ? "/>" : ">"}`);
    }
    if (!empty) {
      stack.push({ name: opened, kept: keep });
      if (!keep) dropped++;
    }
  }

  if (dropped === 0) out.push(src.slice(text));
  for (let i = stack.length - 1; i >= 0; i--) {
    const frame = stack[i];
    if (frame?.kept) out.push(`</${frame.name}>`);
  }

  const svg = out.join("");
  return svg.startsWith("<svg") ? svg : null;
}
