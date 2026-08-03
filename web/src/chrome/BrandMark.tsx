/**
 * The app's own mark, drawn inline.
 *
 * It is the favicon's glyph — the MRCA, a bright core inside a ring standing
 * off it — and it is here because the control bar's first group needed a name.
 * That group holds one button, the command palette, and a palette is not a
 * feature of the product so much as the door to all of them; the honest caption
 * over it is therefore the product itself. So the top-left corner of the canvas
 * says what this is and gives you the one control that reaches everything else,
 * in that order.
 *
 * The same mark is the whole of {@link PaletteFab} on a narrow window, which is
 * the through-line that makes the swap legible: the glyph that heads the
 * commands on a desktop *is* the commands on a phone.
 *
 * **Two things it does not copy from `public/favicon.svg`.** It carries no
 * plate — the icon bakes a rounded black square in because a thin cyan ring is
 * invisible on a white tab strip, and here the bar's own fade-to-void is
 * already that plate. And it takes no literal colours: the icon cannot read a
 * custom property and this can, so the whole glyph is `currentColor` and the
 * caller decides. What it *does* copy is the geometry, exactly, and
 * `src/icons.test.ts` pins the three circles to the icon's — a third copy of a
 * drawing is a third thing that can drift, and that file already exists because
 * there were two.
 */

export function BrandMark({ size = 13 }: { size?: number }) {
  return (
    <svg
      className="brand-mark"
      viewBox="0 0 32 32"
      width={size}
      height={size}
      aria-hidden="true"
      focusable="false"
    >
      <g fill="none" stroke="currentColor">
        {/* The bloom, drawn outward from the ring so it never spends the gap
            between core and ring — that gap is what carries the shape when this
            is 13px tall. A `filter` would be the faithful way and only fogs it
            at this size; a wide stroke at low alpha rasterises the same
            everywhere. */}
        <circle cx="16" cy="16" r="11.2" strokeWidth="3.2" opacity=".13" />
        <circle cx="16" cy="16" r="9.6" strokeWidth="2.6" />
      </g>
      <circle cx="16" cy="16" r="4.3" fill="currentColor" />
    </svg>
  );
}
