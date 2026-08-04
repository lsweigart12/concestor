/**
 * What a shared link and a search result say, against the things they claim.
 *
 * None of this metadata is reachable from the running app: no component
 * renders it, no test exercises it, and it is wrong only where somebody looks
 * at a card on someone else's phone. Every failure mode here is silent by
 * construction, which is the whole reason for the file.
 *
 * Four are worth naming, because not one of them fails anywhere else:
 *
 *   - a `<title>` and an `og:title` that drifted apart, so the tab and the
 *     unfurled card named the product differently;
 *   - an `og:image` still declaring 1200×630 after the image behind it was
 *     redrawn at another size, which every scraper obeys and letterboxes;
 *   - a relative `og:image`, which most scrapers do not resolve at all;
 *   - a domain move that left absolute URLs pointing at the old apex, where
 *     the card kept working until the DNS record went.
 *
 * So each assertion below reads the *other* artifact — the deploy config, the
 * stylesheet, the generator, the PNG's own header — rather than a second copy
 * of the number. `icons.test.ts` is the same idea for the icon.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

const read = (p: string) => readFileSync(new URL(p, import.meta.url), "utf8");
const bytes = (p: string) => readFileSync(new URL(p, import.meta.url));

const HTML = read("../index.html");
const CSS = read("./styles.css");
const WRANGLER = read("../wrangler.jsonc");
const PY = read("../../scripts/make-icons.py");
const LAYOUT = read("./tree/layout.ts");
const ROBOTS = read("../public/robots.txt");

/** `<meta name="x" content="y">` or `property="x"`, either attribute order. */
function meta(key: string): string | undefined {
  const attr = key.startsWith("og:") ? "property" : "name";
  const forward = new RegExp(
    `<meta\\s+${attr}="${key}"\\s+content="([^"]*)"`,
    "s",
  ).exec(HTML);
  if (forward) return forward[1];
  // A long tag is wrapped onto its own lines in the document, so the two
  // attributes may be separated by a newline and any amount of indentation.
  const wrapped = new RegExp(
    `<meta\\s*\\n\\s*${attr}="${key}"\\s*\\n\\s*content="([^"]*)"`,
    "s",
  ).exec(HTML);
  return wrapped?.[1];
}

const title = /<title>([^<]+)<\/title>/.exec(HTML)?.[1];
const canonical = /<link rel="canonical" href="([^"]+)"/.exec(HTML)?.[1];

/** The apex this app is deployed on, from the one file that decides it. */
const HOST = /"pattern":\s*"([^"]+)"/.exec(WRANGLER)?.[1];

describe("the document describes itself", () => {
  /**
   * Every check below looks for a *mismatch* and so passes for free if a read
   * silently returned nothing. Count first, the way `icons.test.ts` and
   * `styles.test.ts` do.
   */
  it("is reading the document, the stylesheet and the deploy config at all", () => {
    expect(HTML.length).toBeGreaterThan(500);
    expect(CSS.length).toBeGreaterThan(1000);
    expect(HOST).toBe("concestor.com");
    expect(PY).toContain("def card(");
  });

  it("names the product the same way in the tab and on the card", () => {
    expect(title).toBeTruthy();
    expect(title).toContain("Concestor");
    expect(meta("og:title")).toBe(title);
  });

  /**
   * One sentence, said once. A search result truncates around 160 characters
   * and a card is not much kinder, so a description that runs past it is a
   * sentence whose end nobody reads — and the two copies must be the same
   * string, because a card and a search result disagreeing about what this is
   * would be exactly the drift this file exists to catch.
   */
  it("says what this is, in one sentence, in both places", () => {
    const description = meta("description");
    expect(description).toBeTruthy();
    expect(description!.length).toBeLessThanOrEqual(160);
    expect(description).toContain("common ancestor");
    expect(meta("og:description")).toBe(description);
  });

  /**
   * **It does not invite a pair.**
   *
   * This card read "Pick any two species…" while `openings.ts` refused to ship
   * a two-taxon opening and said why: *a pair draws one number. Three or more
   * draw an argument — the nesting itself is the proof.* So the most-repeated
   * sentence about this product sold the version the product had already
   * decided was the weaker one, and it is the sentence nothing renders and
   * nobody re-reads.
   *
   * Asserted as an absence rather than a phrasing, because the copy should be
   * free to change and the count should not.
   */
  it("invites more than two species, the way every opening does", () => {
    expect(meta("description")).not.toMatch(/\btwo species\b/);
  });

  it("paints the browser's own chrome in the canvas's void", () => {
    const void_ = /--void:\s*([^;]+);/.exec(CSS)?.[1]?.trim();
    expect(void_).toBeTruthy();
    expect(meta("theme-color")).toBe(void_);
  });
});

describe("every absolute URL points at the host this app deploys to", () => {
  /**
   * A scraper is not reading this document from the origin the reader is on,
   * so `og:image` and `og:url` cannot be relative — and being absolute, they
   * carry a hostname that nothing else in the build would notice going stale.
   * `wrangler.jsonc`'s route is where the apex is actually decided.
   */
  const absolute = [...HTML.matchAll(/(?:content|href)="(https?:\/\/[^"]+)"/g)].map(
    (m) => m[1]!,
  );

  it("found the absolute URLs it means to check", () => {
    expect(absolute.length).toBeGreaterThanOrEqual(3);
  });

  it("uses https on the apex in wrangler.jsonc, and no other host", () => {
    for (const url of absolute) {
      expect(new URL(url).protocol, url).toBe("https:");
      expect(new URL(url).host, url).toBe(HOST);
    }
  });

  /**
   * The canonical URL is the bare apex, and `og:url` agrees with it.
   *
   * Every view of this app is `/?sel=…` of one shell — the query string is
   * read by the client and the document served is byte-identical — so there is
   * one page here however many links exist. Pointing the canonical at the apex
   * says that; leaving it off would offer a search engine an unbounded set of
   * URLs serving identical HTML.
   */
  it("is canonical at the apex, and og:url says the same", () => {
    expect(canonical).toBe(`https://${HOST}/`);
    expect(meta("og:url")).toBe(canonical);
  });
});

describe("the card the tags promise is the card that ships", () => {
  const src = meta("og:image") ?? "";
  // Not `new URL(src)`: a relative og:image is the failure this file is here
  // for, and parsing one would throw during collection and report itself as a
  // broken test rather than as the broken tag it is.
  const path = src.replace(/^https?:\/\/[^/]+/, "");
  const png = bytes(`../public${path}`);

  /**
   * A PNG's IHDR is at a fixed offset — an 8-byte signature and an 8-byte
   * chunk header precede it — so the size needs no decoder, only four bytes
   * big-endian at 16 and at 20.
   */
  const u32 = (at: number) =>
    ((png[at]! << 24) | (png[at + 1]! << 16) | (png[at + 2]! << 8) | png[at + 3]!) >>>
    0;
  const declared = { w: u32(16), h: u32(20) };

  it("links an image that public/ actually holds, absolutely", () => {
    // Absolute because a scraper resolves nothing: it has the tag and no page
    // context. Most simply drop a relative og:image and unfurl with no picture
    // at all, which looks exactly like having written no tag.
    expect(src).toMatch(/^https:\/\//);
    expect(path).toBe("/og.png");
    expect(String.fromCharCode(...png.slice(1, 4))).toBe("PNG");
  });

  /**
   * The dimensions are read from the file rather than restated, because a
   * scraper believes the tags: declaring the old size after a redraw does not
   * fail anywhere, it just letterboxes the card in every feed that ever shows
   * it. `make-icons.py --check` pins the bytes; this pins what the document
   * says about them.
   */
  it("declares the size the file actually is", () => {
    expect(Number(meta("og:image:width"))).toBe(declared.w);
    expect(Number(meta("og:image:height"))).toBe(declared.h);
  });

  it("is the 1200×630 every unfurler asks for", () => {
    expect([declared.w, declared.h]).toEqual([1200, 630]);
    const py = /^CARD_W, CARD_H = (\d+), (\d+)/m.exec(PY);
    expect(py, "make-icons.py has no CARD_W, CARD_H").toBeTruthy();
    expect([Number(py![1]), Number(py![2])]).toEqual([declared.w, declared.h]);
  });

  /**
   * Without this, X serves a 1200×630 picture in a small square thumbnail.
   * There is no `og:` equivalent for the card format, so it is the one Twitter
   * tag this document carries — everything else X reads from `og:`.
   */
  it("asks for the large card, and describes it for anyone who cannot see it", () => {
    expect(meta("twitter:card")).toBe("summary_large_image");
    expect(meta("og:image:alt")?.length).toBeGreaterThan(30);
  });

  /**
   * The card is painted in the app's palette, not in colours that merely look
   * like it. `LANE_HUES` is the tight cool set design-reference.md specifies,
   * and a card drawn outside it would be a picture of a different product —
   * which nobody would catch, because nothing renders both.
   */
  it("draws its lineages in the app's own lane hues", () => {
    const lanes = /const LANE_HUES = \[([^\]]+)\]/.exec(LAYOUT)?.[1];
    expect(lanes, "layout.ts has no LANE_HUES").toBeTruthy();
    const allowed = new Set(lanes!.split(",").map((h) => Number(h.trim())));
    expect(allowed.size).toBeGreaterThan(3);

    const used = [
      ...[...PY.matchAll(/\(TIP_X, [\d.]+, (\d+)\)/g)].map((m) => Number(m[1])),
      ...(/^HUE_U, HUE_L, HUE_MRCA = (\d+), (\d+), (\d+)/m
        .exec(PY)
        ?.slice(1, 4)
        .map(Number) ?? []),
    ];
    expect(used.length).toBe(7);
    for (const hue of used) expect(allowed, `hue ${hue}`).toContain(hue);
  });
});

describe("robots.txt is a real file", () => {
  /**
   * The point of it is not the directives — everything is allowed — but that
   * the path exists. `not_found_handling: single-page-application` answers an
   * absent `/robots.txt` with the app shell at 200, and a crawler handed HTML
   * where a directive list belongs reads a document of syntax errors.
   */
  it("is served as itself rather than as the app shell", () => {
    expect(ROBOTS).not.toContain("<!doctype html>");
    expect(ROBOTS).toMatch(/^User-agent: \*$/m);
    expect(ROBOTS).toMatch(/^Disallow: \/v1\/$/m);
  });
});
