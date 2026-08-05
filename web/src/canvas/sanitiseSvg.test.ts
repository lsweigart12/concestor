/**
 * The one thing that stands between a fetched file and `innerHTML`.
 *
 * `sanitiseSvg` was exported — which in this codebase is the signal that
 * something is tested — and was not. Two things it got wrong were found by
 * running it, and both are pinned here: the first four cases below fail against
 * the regex chain that preceded it, and the failure of the very first is
 * visible on 7,837 nodes.
 *
 * The corpus figures quoted are from the 12,863-file mirror in
 * `snapshot/phylopic/svg`, censused 2026-08-04. They are what the allow-list is
 * sized against, and they are why the list can be this short.
 */

import { describe, expect, it } from "vitest";
import { sanitiseSvg } from "./sanitiseSvg";

/** Wrap a fragment in the root the mirror always sends. */
function doc(inner: string, rootAttrs = ' viewBox="0 0 100 100"'): string {
  return `<?xml version="1.0"?>\n<svg xmlns="http://www.w3.org/2000/svg"${rootAttrs}>${inner}</svg>`;
}

describe("sizing", () => {
  it("takes width and height off the root", () => {
    const out = sanitiseSvg(
      doc("", ' viewBox="0 0 100 100" width="100" height="100"'),
    );
    expect(out).not.toMatch(/width=/);
    expect(out).toMatch(/viewBox="0 0 100 100"/);
  });

  it("leaves inner geometry alone", () => {
    // The old strip was global over the document, so this rect came out as
    // `<rect x="0" y="0"/>` — its size destroyed, and the caller only ever
    // re-attached the root's. One mirrored drawing clips against a rect.
    const out = sanitiseSvg(doc('<rect x="0" y="0" width="40" height="20"/>'));
    expect(out).toContain('<rect x="0" y="0" width="40" height="20"/>');
  });

  it("keeps the size of an inlined raster", () => {
    // Three drawings are a base64 jpeg or png in an `<image>`, between them the
    // picture 7,837 nodes inherit: Eilema at 7,753, Macropodus opercularis at
    // 77, Ateles paniscus at 7. Without width and height the image has no box.
    const out = sanitiseSvg(
      doc(
        '<image width="89.6" height="154.88" xlink:href="data:image/png;base64,iVBORw0K"/>',
      ),
    );
    expect(out).toContain('width="89.6"');
    expect(out).toContain('height="154.88"');
    expect(out).toContain("data:image/png;base64,iVBORw0K");
  });
});

describe("what may not reach the DOM", () => {
  it("refuses a javascript: href", () => {
    const out = sanitiseSvg(doc('<image xlink:href="javascript:alert(1)"/>'));
    expect(out).not.toContain("javascript");
    expect(out).toContain("<image/>");
  });

  it("refuses an href that leaves the document", () => {
    const out = sanitiseSvg(
      doc('<image href="https://example.com/pixel.png"/>'),
    );
    expect(out).not.toContain("example.com");
  });

  it("refuses a data: URL that is itself a document", () => {
    // A raster is a picture; an SVG is a document, and a document can carry
    // script. That is the whole of why the media type is on the list.
    const out = sanitiseSvg(
      doc('<image href="data:image/svg+xml;base64,PHN2Zz4="/>'),
    );
    expect(out).not.toContain("svg+xml");
  });

  it("keeps a fragment reference", () => {
    const out = sanitiseSvg(
      doc(
        '<clipPath id="c"><path d="M0 0"/></clipPath><path clip-path="url(#c)" d="M1 1"/>',
      ),
    );
    expect(out).toContain('<clipPath id="c">');
    expect(out).toContain('clip-path="url(#c)"');
  });

  it("refuses a url() that leaves the document", () => {
    const out = sanitiseSvg(
      doc('<path d="M0 0" fill="url(https://example.com/x#g)"/>'),
    );
    expect(out).not.toContain("example.com");
    expect(out).toContain('<path d="M0 0"/>');
  });

  it("drops style, which would otherwise declare rules for the whole page", () => {
    const out = sanitiseSvg(
      doc('<style>svg{display:none}</style><path d="M0 0"/>'),
    );
    expect(out).not.toContain("display:none");
    expect(out).not.toContain("<style");
    expect(out).toContain('<path d="M0 0"/>');
  });

  it("drops animation elements", () => {
    const out = sanitiseSvg(
      doc(
        '<a><animate attributeName="href" to="javascript:alert(1)"/></a><set attributeName="onload" to="alert(1)"/>',
      ),
    );
    expect(out).not.toContain("animate");
    expect(out).not.toContain("<set");
    expect(out).not.toContain("javascript");
  });

  it("drops script and its content", () => {
    const out = sanitiseSvg(doc('<script>alert(1)</script><path d="M0 0"/>'));
    expect(out).not.toContain("alert");
    expect(out).toContain('<path d="M0 0"/>');
  });

  it("drops foreignObject and its content", () => {
    const out = sanitiseSvg(
      doc("<foreignObject><body><iframe src=x /></body></foreignObject>"),
    );
    expect(out).toBe(
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"></svg>',
    );
  });

  it("drops event handlers", () => {
    const out = sanitiseSvg(
      doc('<path d="M0 0" onload="alert(1)" onclick=alert(2)/>'),
    );
    expect(out).toContain('<path d="M0 0"/>');
    expect(out).not.toContain("alert");
  });

  it("drops an attribute nobody asked for rather than passing it", () => {
    // The point of an allow-list: it is wrong only about things it has not
    // heard of, and being wrong there means dropping them.
    const out = sanitiseSvg(
      doc('<path d="M0 0" formaction="/x" srcdoc="<b>"/>'),
    );
    expect(out).toContain('<path d="M0 0"/>');
  });

  it("drops comments and CDATA", () => {
    const out = sanitiseSvg(
      doc('<!-- note --><![CDATA[raw]]><path d="M0 0"/>'),
    );
    expect(out).not.toContain("note");
    expect(out).not.toContain("raw");
  });
});

describe("the fill rewrite, which is why any of this is inlined", () => {
  it("rewrites the baked fill on a group", () => {
    const out = sanitiseSvg(
      doc('<g fill="#000000" stroke="none"><path d="M0 0"/></g>'),
    );
    expect(out).toContain('fill="currentColor"');
    expect(out).toContain('stroke="none"');
  });

  it("rewrites every spelling of black", () => {
    for (const black of ["#000000", "#000", "black", "BLACK"]) {
      expect(sanitiseSvg(doc(`<path d="M0 0" fill="${black}"/>`))).toContain(
        'fill="currentColor"',
      );
    }
  });

  it("leaves a fill that is not the baked one", () => {
    expect(sanitiseSvg(doc('<path d="M0 0" fill="#231f20"/>'))).toContain(
      'fill="#231f20"',
    );
  });

  it("rewrites it in a style attribute too", () => {
    const out = sanitiseSvg(
      doc('<path d="M0 0" style="fill:#000;stroke-width:0.26"/>'),
    );
    expect(out).toContain('style="fill:currentColor;stroke-width:0.26"');
  });
});

describe("the shape of the output", () => {
  it("is null when there is no SVG in it", () => {
    expect(sanitiseSvg("<html><body>404</body></html>")).toBeNull();
    expect(sanitiseSvg("")).toBeNull();
  });

  it("drops the XML preamble and the doctype", () => {
    const out = sanitiseSvg(
      '<?xml version="1.0"?>\n<!DOCTYPE svg PUBLIC "-//W3C//DTD SVG 20010904//EN" "http://www.w3.org/TR/2001/REC-SVG-20010904/DTD/svg10.dtd">\n<svg viewBox="0 0 1 1"></svg>',
    );
    expect(out?.startsWith("<svg")).toBe(true);
  });

  it("closes what a truncated file left open", () => {
    // This string goes to innerHTML. A file cut off mid-download must not
    // adopt the rest of the page.
    const out = sanitiseSvg(
      '<svg viewBox="0 0 1 1"><g fill="#000"><path d="M0 0"/>',
    );
    expect(out).toBe(
      '<svg viewBox="0 0 1 1"><g fill="currentColor"><path d="M0 0"/></g></svg>',
    );
  });

  it("ignores a close tag matching nothing open", () => {
    const out = sanitiseSvg(
      '<svg viewBox="0 0 1 1"></g><path d="M0 0"/></svg>',
    );
    expect(out).toBe('<svg viewBox="0 0 1 1"><path d="M0 0"/></svg>');
  });

  it("escapes a quote smuggled through a single-quoted value", () => {
    const out = sanitiseSvg(doc("<path d='M0 0\" onload=\"alert(1)'/>"));
    expect(out).not.toContain('onload="');
    expect(out).toContain("&quot;");
  });

  it("keeps the case of an element and an attribute", () => {
    const out = sanitiseSvg(
      '<svg viewBox="0 0 1 1"><clipPath clipPathUnits="userSpaceOnUse" id="c"><path d="M0 0"/></clipPath></svg>',
    );
    expect(out).toContain("<clipPath ");
    expect(out).toContain("</clipPath>");
    expect(out).toContain('clipPathUnits="userSpaceOnUse"');
  });

  it("passes a real potrace file through with its geometry intact", () => {
    // 12,819 of the 12,863 mirrored files have exactly this shape.
    const out = sanitiseSvg(
      '<?xml version="1.0" standalone="no"?>\n' +
        '<!DOCTYPE svg PUBLIC "-//W3C//DTD SVG 20010904//EN" "http://www.w3.org/TR/2001/REC-SVG-20010904/DTD/svg10.dtd">\n' +
        '<svg version="1.0" xmlns="http://www.w3.org/2000/svg"\n' +
        ' width="982.000000pt" height="352.000000pt" viewBox="0 0 982.000000 352.000000"\n' +
        ' preserveAspectRatio="xMidYMid meet">\n' +
        "<metadata>\nCreated by potrace 1.16, written by Peter Selinger 2001-2019\n</metadata>\n" +
        '<g transform="translate(0.000000,352.000000) scale(0.100000,-0.100000)"\n' +
        'fill="#000000" stroke="none">\n' +
        '<path d="M3775 3489 c-49 -37 -120 -40 -172 -8z"/>\n' +
        "</g>\n</svg>\n",
    );
    expect(out).toContain('viewBox="0 0 982.000000 352.000000"');
    expect(out).toContain('preserveAspectRatio="xMidYMid meet"');
    expect(out).toContain('fill="currentColor"');
    expect(out).toContain(
      'transform="translate(0.000000,352.000000) scale(0.100000,-0.100000)"',
    );
    expect(out).toContain('<path d="M3775 3489 c-49 -37 -120 -40 -172 -8z"/>');
    expect(out).not.toMatch(/\swidth=/);
    expect(out).not.toContain("potrace");
  });
});
