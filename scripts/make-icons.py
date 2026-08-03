#!/usr/bin/env python3
"""
The generated images: the raster icons, and the card a shared link shows.

The icons come from the same geometry as web/public/favicon.svg, which is the
icon. These are the two places it cannot go:

  - **apple-touch-icon.png** — iOS uses it for a home-screen bookmark and
    Safari for surfaces of its own, and takes no SVG for either.
  - **favicon.ico** — a browser that does not read an SVG favicon, and any
    browser at all before it has parsed the document, asks for `/favicon.ico`
    at the root whatever the markup says. Without a real file that request
    reaches the SPA fallback and is answered with `index.html` at 200, which is
    harmless and is also a lie. Two sizes go in it: 16 is where a favicon is
    actually looked at, and rendering it directly beats letting anything
    downsample a 32.

And **og.png** is the third: the 1200×630 image every surface that unfurls a
link puts above the title — Slack, iMessage, X, Discord, WhatsApp. A shared
`/?sel=…` is this app's unit of sharing, so the picture beside it is not
decoration; it is what most people will see of the product before they see the
product. `docs/design-reference.md` §"The share card" is the design.

**Why a generator rather than committed binaries with no source.** A PNG in the
tree that nobody can regenerate stops matching the SVG the first time the icon
changes, and nothing in the repository can tell. This script is the source;
`--check` makes that testable, and `web/src/icons.test.ts` pins the numbers
below to the SVG in the other direction.

**Why the standard library and nothing else.** Rasterising this glyph is two
circles, a disc and a rounded rect; the card adds line segments and a radial
ramp. Every alternative — cairosvg, rsvg-convert, ImageMagick, headless Chrome
— is a system dependency or a wheel with a C library under it, for images whose
entire content is *distance from something*. `zlib`, `struct` and `math` are
enough, the bytes are identical on every machine, and CI needs nothing
installed.

Two differences between the touch icon and the others, both required by iOS:

  - **Square corners, full bleed.** iOS applies its own squircle mask. An icon
    that arrives pre-rounded is rounded twice and shows the seam.
  - **No alpha channel.** Apple's guidance is an opaque image, and the void is
    opaque anyway. The `.ico` keeps its alpha, because there the rounded
    corners have to be transparent against whatever the tab strip is.

Usage:
    scripts/make-icons.py            write every generated image into web/public/
    scripts/make-icons.py --check    fail if any file on disk is not what this
                                     script would write
"""

from __future__ import annotations

import math
import struct
import sys
import zlib
from array import array
from pathlib import Path

# --- the geometry, in favicon.svg's 32-unit box ------------------------------
#
# Mirrors web/public/favicon.svg exactly. `web/src/icons.test.ts` reads both
# files and fails if they drift, so this is a copy that cannot go stale
# silently.

BOX = 32.0
CENTRE = 16.0
CORNER_R = 7.0
RING_R, RING_W = 9.6, 2.6
BLOOM_R, BLOOM_W = 11.2, 3.2
BLOOM_A = 0.13
CORE_R = 4.3

VOID = (0x0A, 0x0A, 0x0B)
ACCENT = (0x58, 0xD6, 0xE4)
CORE = (0x8E, 0xE2, 0xEB)

# Apple's largest touch icon, and the only size worth shipping: every smaller
# one iOS wants, it downsamples from this.
TOUCH_SIZE = 180
ICO_SIZES = (16, 32)

# 4×4 per pixel. Everything drawn here is an arc, so subsampling is the only
# antialiasing there is, and 16 samples put the worst case below one 8-bit step
# even at 16px where a single pixel spans a tenth of the ring.
SUB = 4


def render(size: int, corner: float) -> bytearray:
    """
    The icon at `size`, as RGBA bytes, top-left to bottom-right.

    `corner` is the corner radius in the 32-unit box; 0 draws the full square.
    Alpha is the rounded rect's own coverage and nothing else — the glyph sits
    well inside it, so no shape is ever partly outside the plate and the
    corners never have to composite anything but void.
    """
    scale = size / BOX
    cx = cy = CENTRE * scale
    rad = corner * scale

    # Squared radii, so the inner loop compares distance-squared and never
    # takes a square root.
    ring_in2 = ((RING_R - RING_W / 2) * scale) ** 2
    ring_out2 = ((RING_R + RING_W / 2) * scale) ** 2
    bloom_in2 = ((BLOOM_R - BLOOM_W / 2) * scale) ** 2
    bloom_out2 = ((BLOOM_R + BLOOM_W / 2) * scale) ** 2
    core2 = (CORE_R * scale) ** 2
    rad2 = rad * rad

    step = 1.0 / SUB
    offsets = [(i + 0.5) * step for i in range(SUB)]
    n = SUB * SUB

    out = bytearray()
    for py in range(size):
        ys = [py + o for o in offsets]
        for px in range(size):
            xs = [px + o for o in offsets]
            hit_core = hit_ring = hit_bloom = plate = 0
            for y in ys:
                dy2 = (y - cy) ** 2
                # Distance past the straight edge of the rounded rect, per axis.
                oy = max(rad - y, y - (size - rad), 0.0)
                for x in xs:
                    ox = max(rad - x, x - (size - rad), 0.0)
                    if ox * ox + oy * oy <= rad2:
                        plate += 1
                    else:
                        continue  # Outside the plate: nothing is drawn there.
                    d2 = (x - cx) ** 2 + dy2
                    if d2 <= core2:
                        hit_core += 1
                    elif ring_in2 <= d2 <= ring_out2:
                        hit_ring += 1
                    elif bloom_in2 <= d2 <= bloom_out2:
                        hit_bloom += 1

            r, g, b = (float(c) for c in VOID)
            # Painter's order, matching the SVG: bloom, ring, core. The three
            # do not overlap by construction, so the order only settles ties on
            # their shared edges — but keeping it means the two renderers agree
            # there by intent rather than by luck.
            for coverage, colour, alpha in (
                (hit_bloom, ACCENT, BLOOM_A),
                (hit_ring, ACCENT, 1.0),
                (hit_core, CORE, 1.0),
            ):
                if not coverage:
                    continue
                a = alpha * coverage / n
                r += (colour[0] - r) * a
                g += (colour[1] - g) * a
                b += (colour[2] - b) * a
            out += bytes((round(r), round(g), round(b), round(255 * plate / n)))
    return out


def png(width: int, height: int, rgba: bytearray, *, alpha: bool) -> bytes:
    """
    A minimal 8-bit PNG from RGBA input. No ancillary chunks, so the bytes are
    stable.

    The image is filtered twice — every row `None`, then every row `Up` — and
    the smaller of the two compressed results ships. That is two zlib passes
    and about a third of a second, for images generated once and then served
    for the life of the deploy.

    **The textbook alternative loses here, measured.** libpng's heuristic picks
    a filter per row by minimum sum of absolute differences, which optimises
    each row's entropy in isolation; but what carries these images is LZ77
    matching *across* rows, and the icon is mostly void — long identical runs
    that a delta turns into different runs of zeros with different edges in
    them. On the touch icon: `None` 3,016 bytes, per-row adaptive 4,824, all-Up
    5,082. On the card, whose backdrop is a smooth radial ramp: `None` 47,549,
    all-Up 42,758. Neither filter wins both, and the choice is per image
    because that is what the measurement says rather than per row because that
    is what the specification suggests.
    """

    def chunk(tag: bytes, data: bytes) -> bytes:
        return (
            struct.pack(">I", len(data))
            + tag
            + data
            + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)
        )

    stride = 4 if alpha else 3
    # The image with the alpha channel dropped where it is not wanted, so the
    # filters below run over exactly the bytes that ship.
    flat = bytearray()
    for i in range(0, len(rgba), 4):
        flat += rgba[i : i + stride]

    idats = []
    for mode in (0, 2):  # None, Up.
        raw = bytearray()
        prev = bytes(width * stride)
        for y in range(height):
            row = flat[y * width * stride : (y + 1) * width * stride]
            raw.append(mode)
            if mode == 0:
                raw += row
            else:
                raw += bytes((row[i] - prev[i]) & 0xFF for i in range(len(row)))
            prev = row
        assert len(raw) == height * (1 + width * stride)
        idats.append(zlib.compress(bytes(raw), 9))
    # `min` is stable, so a tie keeps `None` and the choice never depends on
    # anything but the pixels.
    idat = min(idats, key=len)

    header = struct.pack(">IIBBBBB", width, height, 8, 6 if alpha else 2, 0, 0, 0)
    return (
        b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", header)
        + chunk(b"IDAT", idat)
        + chunk(b"IEND", b"")
    )


def ico(images: list[tuple[int, bytes]]) -> bytes:
    """
    An `.ico` wrapping one PNG per size.

    PNG-in-ICO rather than the older DIB: every browser's ICO decoder reads it,
    it needs no upside-down bitmap and no separate 1-bit AND mask, and the
    alpha the rounded corners want comes for free. The format's own rule that
    PNG payloads are for 256px entries is a Windows *shell* constraint, and
    nothing here is ever loaded by the shell.
    """
    header = struct.pack("<HHH", 0, 1, len(images))
    offset = len(header) + 16 * len(images)
    entries, payloads = b"", b""
    for size, data in images:
        entries += struct.pack(
            "<BBBBHHII",
            size if size < 256 else 0,
            size if size < 256 else 0,
            0,  # palette size: not paletted
            0,  # reserved
            1,  # colour planes
            32,  # bits per pixel
            len(data),
            offset + len(payloads),
        )
        payloads += data
    return header + entries + payloads


# --- the share card ----------------------------------------------------------
#
# 1200×630 is the size every unfurler asks for and the only one worth shipping:
# it satisfies X's 2:1-ish `summary_large_image`, Facebook's 1.91:1, and
# LinkedIn's minimum, and each of them downsamples from it.
#
# What is drawn is the fork the favicon could not be. `design-reference.md`
# rejected a branching glyph for the tab on measurement — at 16px a stem with
# two arms is a `<` — while noting it "says more about the product". At 1200px
# that constraint is gone, so the card takes the fork back: four lineages
# running toward the present, converging through two divergences onto one
# bright common ancestor, which wears the icon's own mark at scale.
#
# **It carries no word and no number.** Every surface prints og:title and
# og:description beside the image, so text here would be the second copy of a
# sentence that lives in index.html — the copy that goes stale silently. A
# figure would be worse: this tree is drawn rather than derived, and this
# project does not print ages it cannot stand behind. With nothing printed,
# nothing on the card can be wrong.

CARD_W, CARD_H = 1200, 630

# Card pixels per app pixel. The card is a crop of the instrument at ~2.75×, so
# stroke weights, the mark and the grid are the app's own figures scaled by it
# rather than numbers chosen to look right here.
CARD_SCALE = 2.75

VOID_2 = (0x0E, 0x0E, 0x10)
# styles.css's `--grid` and `--hairline-strong` inks. The alphas are the app's
# lifted — 0.045 and 0.2 there — because both of these are meant to be *barely*
# perceptible on a screen the reader is sitting at, and a feed shows this image
# at a third of its size on a phone. Lifted, not doubled: they still have to
# lose to every lineage on the card.
GRID_RGB, GRID_A = (120, 190, 200), 0.055
HAIR_RGB, HAIR_A = (150, 200, 210), 0.30

# The canvas backdrop: `radial-gradient(ellipse 120% 90% at 62% 45%, --void-2
# 0%, --void 72%)`, verbatim from `.canvas`.
BG_CENTRE = (0.62, 0.45)
BG_RADII = (1.20, 0.90)
BG_STOP = 0.72

# `.canvas::before`'s 56px lattice, at card scale.
GRID_STEP = 56.0 * CARD_SCALE
GRID_W = 2.0  # 1px would not survive the halving a feed does to this image.

# TraceEdge.tsx: core 1.6px, halo 7px at 0.16 under a 3.5px blur. The halo is a
# falloff here rather than a blurred stroke — same read, and no blur pass.
TRACE_W = 1.6 * CARD_SCALE
GLOW_R = 9.5 * CARD_SCALE
GLOW_A = 0.16

# layout.ts `orthPath`'s corner radius, at card scale.
ELBOW_R = 9.0 * CARD_SCALE

# NodeMark.tsx: a 10px dot, and `0 0 7px 1px` of its own colour on a leaf.
DOT_R = 5.0 * CARD_SCALE
DOT_GLOW_R = 9.0 * CARD_SCALE
DOT_GLOW_A = 0.5

# The mark at the fork is favicon.svg's, scaled: same three radii, same alpha
# on the bloom. That is the whole reason the two files sit in one script — the
# tab and the card wear one glyph, and it is written down once.
MARK_SCALE = 3.0

# The composition. `x` is time — the past at the left, the present at the
# right — and every fork sits at the midpoint of its children's rows, which is
# what `layout.ts` does. Hues are `LANE_HUES`, which `web/src/meta.test.ts`
# checks against `tree/layout.ts` so the card cannot drift out of the app's
# palette.
TIP_X = 1048.0
TIPS = (
    (TIP_X, 132.0, 200),
    (TIP_X, 236.0, 186),
    (TIP_X, 372.0, 172),
    (TIP_X, 486.0, 158),
)
FORK_U = (556.0, 184.0)  # (132 + 236) / 2
FORK_L = (676.0, 429.0)  # (372 + 486) / 2
MRCA = (232.0, 306.5)  # (184 + 429) / 2
HUE_U, HUE_L, HUE_MRCA = 194, 172, 186

# The axis strip: a hairline with ticks closing up toward the present, which is
# the shape a symlog time axis has. No labels, for the reason in the header —
# a number here would be a date this picture cannot support.
AXIS_Y = 556.0
AXIS_X0, AXIS_X1 = 72.0, 1128.0
AXIS_TICKS = (1128.0, 1012.0, 878.0, 726.0, 556.0, 368.0, 162.0)
AXIS_TICK_H = 17.0


def hsl(h: float, s: float, ell: float) -> tuple[float, float, float]:
    """CSS `hsl(h s% l%)` as 0–255 RGB, so app colours can be quoted as written."""
    s, ell = s / 100.0, ell / 100.0
    c = (1 - abs(2 * ell - 1)) * s
    x = c * (1 - abs((h / 60.0) % 2 - 1))
    m = ell - c / 2
    r, g, b = [
        (c, x, 0.0),
        (x, c, 0.0),
        (0.0, c, x),
        (0.0, x, c),
        (x, 0.0, c),
        (c, 0.0, x),
    ][int(h // 60) % 6]
    return (255.0 * (r + m), 255.0 * (g + m), 255.0 * (b + m))


class Plate:
    """
    An opaque RGB canvas in float channels, composited source-over.

    Float rather than bytes because everything drawn here is a stack of low
    alphas — a glow over a grid line over a ramp — and rounding each to 8 bits
    on the way in banded the backdrop visibly.
    """

    def __init__(self, w: int, h: int) -> None:
        self.w, self.h = w, h
        self.px = array("f", [0.0, 0.0, 0.0]) * (w * h)

    def rgba(self) -> bytearray:
        """Top-left to bottom-right, alpha 255 throughout: the card is opaque."""
        out = bytearray()
        px = self.px
        for i in range(0, len(px), 3):
            out += bytes(
                (
                    round(px[i]),
                    round(px[i + 1]),
                    round(px[i + 2]),
                    255,
                )
            )
        return out


def over(px: array[float], i: int, colour: tuple[float, ...], a: float) -> None:
    """One pixel, source-over. `i` is the red channel's index."""
    if a <= 0.0:
        return
    if a > 1.0:
        a = 1.0
    px[i] += (colour[0] - px[i]) * a
    px[i + 1] += (colour[1] - px[i + 1]) * a
    px[i + 2] += (colour[2] - px[i + 2]) * a


def backdrop(p: Plate) -> None:
    """The void, the canvas's radial ramp, and the faint lattice over both."""
    px = p.px
    cx, cy = BG_CENTRE[0] * p.w, BG_CENTRE[1] * p.h
    rx, ry = BG_RADII[0] * p.w, BG_RADII[1] * p.h
    void = tuple(float(c) for c in VOID)
    lit = tuple(float(c) for c in VOID_2)

    i = 0
    for y in range(p.h):
        fy = ((y + 0.5 - cy) / ry) ** 2
        for x in range(p.w):
            t = math.sqrt(((x + 0.5 - cx) / rx) ** 2 + fy) / BG_STOP
            if t > 1.0:
                t = 1.0
            px[i] = lit[0] + (void[0] - lit[0]) * t
            px[i + 1] = lit[1] + (void[1] - lit[1]) * t
            px[i + 2] = lit[2] + (void[2] - lit[2]) * t
            i += 3

    grid = tuple(float(c) for c in GRID_RGB)
    half = GRID_W / 2.0
    for gx in range(1, int(p.w / GRID_STEP) + 1):
        for x in range(round(gx * GRID_STEP - half), round(gx * GRID_STEP + half)):
            if 0 <= x < p.w:
                for y in range(p.h):
                    over(px, (y * p.w + x) * 3, grid, GRID_A)
    for gy in range(1, int(p.h / GRID_STEP) + 1):
        for y in range(round(gy * GRID_STEP - half), round(gy * GRID_STEP + half)):
            if 0 <= y < p.h:
                row = y * p.w * 3
                for x in range(p.w):
                    over(px, row + x * 3, grid, GRID_A)


def _bbox(
    p: Plate, x0: float, y0: float, x1: float, y1: float
) -> tuple[int, int, int, int]:
    """A drawing bound clipped to the plate, so no shape iterates the whole card."""
    return (
        max(0, int(x0)),
        max(0, int(y0)),
        min(p.w, int(x1) + 1),
        min(p.h, int(y1) + 1),
    )


def stroke(
    p: Plate,
    pts: list[tuple[float, float]],
    width: float,
    colour: tuple[float, ...],
    *,
    alpha: float = 1.0,
    glow: float = 0.0,
    glow_alpha: float = 0.0,
) -> None:
    """
    A polyline with round joins and caps, plus its halo.

    Coverage is the distance field itself — `half + 0.5 - d`, clamped — rather
    than supersampling. For a line that is the same antialiasing at a fraction
    of the samples, and it is exact at every join, which a union of separately
    drawn segments is not: overlapping strokes composite twice and leave a
    bright knot at every corner.
    """
    segs = []
    for (x1, y1), (x2, y2) in zip(pts, pts[1:]):
        dx, dy = x2 - x1, y2 - y1
        segs.append((x1, y1, dx, dy, max(dx * dx + dy * dy, 1e-9)))

    reach = max(width / 2.0 + 1.0, glow)
    xs = [q[0] for q in pts]
    ys = [q[1] for q in pts]
    x0, y0, x1, y1 = _bbox(
        p, min(xs) - reach, min(ys) - reach, max(xs) + reach, max(ys) + reach
    )

    px = p.px
    half = width / 2.0
    for y in range(y0, y1):
        fy = y + 0.5
        row = y * p.w * 3
        for x in range(x0, x1):
            fx = x + 0.5
            best = 1e18
            for sx, sy, dx, dy, l2 in segs:
                t = ((fx - sx) * dx + (fy - sy) * dy) / l2
                if t < 0.0:
                    t = 0.0
                elif t > 1.0:
                    t = 1.0
                ex, ey = fx - sx - t * dx, fy - sy - t * dy
                d2 = ex * ex + ey * ey
                if d2 < best:
                    best = d2
            d = math.sqrt(best)
            i = row + x * 3
            if glow > 0.0 and d < glow:
                # Squared falloff: a blurred stroke's profile, near enough, and
                # it reaches zero at `glow` rather than leaving an edge.
                f = 1.0 - d / glow
                over(px, i, colour, glow_alpha * f * f)
            cov = half + 0.5 - d
            if cov > 0.0:
                over(px, i, colour, alpha * (cov if cov < 1.0 else 1.0))


def disc(
    p: Plate,
    cx: float,
    cy: float,
    r: float,
    colour: tuple[float, ...],
    *,
    alpha: float = 1.0,
    glow: float = 0.0,
    glow_alpha: float = 0.0,
) -> None:
    """A filled circle and its halo, on the same distance-field coverage."""
    reach = max(r + 1.0, glow)
    x0, y0, x1, y1 = _bbox(p, cx - reach, cy - reach, cx + reach, cy + reach)
    px = p.px
    for y in range(y0, y1):
        fy2 = (y + 0.5 - cy) ** 2
        row = y * p.w * 3
        for x in range(x0, x1):
            d = math.sqrt((x + 0.5 - cx) ** 2 + fy2)
            i = row + x * 3
            if glow > 0.0 and d < glow:
                f = 1.0 - d / glow
                over(px, i, colour, glow_alpha * f * f)
            cov = r + 0.5 - d
            if cov > 0.0:
                over(px, i, colour, alpha * (cov if cov < 1.0 else 1.0))


def ring(
    p: Plate,
    cx: float,
    cy: float,
    r: float,
    w: float,
    colour: tuple[float, ...],
    *,
    alpha: float = 1.0,
) -> None:
    """A stroked circle: the icon's ring and its bloom."""
    outer = r + w / 2.0 + 1.0
    x0, y0, x1, y1 = _bbox(p, cx - outer, cy - outer, cx + outer, cy + outer)
    px = p.px
    half = w / 2.0
    for y in range(y0, y1):
        fy2 = (y + 0.5 - cy) ** 2
        row = y * p.w * 3
        for x in range(x0, x1):
            cov = half + 0.5 - abs(math.sqrt((x + 0.5 - cx) ** 2 + fy2) - r)
            if cov > 0.0:
                over(px, row + x * 3, colour, alpha * (cov if cov < 1.0 else 1.0))


def elbow(
    a: tuple[float, float], b: tuple[float, float]
) -> list[tuple[float, float]]:
    """
    `layout.ts`'s `orthPath` as a polyline: down the ancestor's x, round the
    corner, out to the descendant's row.

    The corner is that function's own quadratic Bézier, sampled — not an arc of
    a guessed radius. A branch on this canvas leaves its ancestor vertically
    and travels forward in time horizontally, and the card has to draw the same
    L the app does or it is a picture of a different product.
    """
    (x1, y1), (x2, y2) = a, b
    if abs(y1 - y2) < 0.5:
        return [(x1, y1), (x2, y2)]
    dy = 1.0 if y2 > y1 else -1.0
    dx = 1.0 if x2 > x1 else -1.0
    rr = min(ELBOW_R, abs(y2 - y1) / 2.0, abs(x2 - x1) / 2.0)
    p0 = (x1, y2 - dy * rr)
    ctrl = (x1, y2)
    p2 = (x1 + dx * rr, y2)
    pts = [(x1, y1), p0]
    steps = 8
    for k in range(1, steps + 1):
        t = k / steps
        u = 1.0 - t
        pts.append(
            (
                u * u * p0[0] + 2 * u * t * ctrl[0] + t * t * p2[0],
                u * u * p0[1] + 2 * u * t * ctrl[1] + t * t * p2[1],
            )
        )
    pts.append((x2, y2))
    return pts


def card() -> bytearray:
    """The share card, as RGBA bytes."""
    p = Plate(CARD_W, CARD_H)
    backdrop(p)

    # The axis, under everything: it is a ruler, and nothing on this canvas
    # should read as competing with a lineage for attention.
    hair = tuple(float(c) for c in HAIR_RGB)
    stroke(p, [(AXIS_X0, AXIS_Y), (AXIS_X1, AXIS_Y)], 1.5, hair, alpha=HAIR_A)
    for tx in AXIS_TICKS:
        stroke(
            p,
            [(tx, AXIS_Y), (tx, AXIS_Y - AXIS_TICK_H)],
            1.5,
            hair,
            alpha=HAIR_A * 1.6,
        )

    # Branches, ancestor to descendant, each in its descendant's lane hue —
    # `Graph.tsx` colours an edge by the node it arrives at. `traceStroke`'s
    # measured tier: full chroma, no dash. Every branch here is solid because
    # the card claims no date at all; a dash pattern is this app's statement
    # that a date is missing, and there is nothing here for it to be about.
    branches = [
        (MRCA, FORK_U, HUE_U),
        (MRCA, FORK_L, HUE_L),
        (FORK_U, (TIPS[0][0], TIPS[0][1]), TIPS[0][2]),
        (FORK_U, (TIPS[1][0], TIPS[1][1]), TIPS[1][2]),
        (FORK_L, (TIPS[2][0], TIPS[2][1]), TIPS[2][2]),
        (FORK_L, (TIPS[3][0], TIPS[3][1]), TIPS[3][2]),
    ]
    for a, b, hue in branches:
        stroke(
            p,
            elbow(a, b),
            TRACE_W,
            hsl(hue, 68, 62),
            glow=GLOW_R,
            glow_alpha=GLOW_A,
        )

    # The two divergences below the root: a plain dot, no glow. That is
    # NodeMark.tsx exactly — `box-shadow` is `none` on an internal node — and
    # it is what leaves the light on the tips the reader picked and on the
    # ancestor they were shown.
    for (fx, fy), hue in ((FORK_U, HUE_U), (FORK_L, HUE_L)):
        disc(p, fx, fy, DOT_R, hsl(hue, 70, 60))

    for tx, ty, hue in TIPS:
        colour = hsl(hue, 70, 60)
        disc(p, tx, ty, DOT_R, colour, glow=DOT_GLOW_R, glow_alpha=DOT_GLOW_A)

    # The common ancestor, wearing the tab's own mark: bloom, ring, core, in
    # that painter's order, over the wider glow `is-mrca` carries.
    mx, my = MRCA
    accent = hsl(HUE_MRCA, 72, 62)
    # Radius zero: this call is the halo alone, which the ring and core below
    # then sit inside.
    halo = CORE_R * MARK_SCALE * 3.4
    disc(p, mx, my, 0.0, accent, alpha=0.0, glow=halo, glow_alpha=0.34)
    ring(p, mx, my, BLOOM_R * MARK_SCALE, BLOOM_W * MARK_SCALE, accent, alpha=BLOOM_A)
    ring(p, mx, my, RING_R * MARK_SCALE, RING_W * MARK_SCALE, accent)
    disc(p, mx, my, CORE_R * MARK_SCALE, hsl(HUE_MRCA, 70, 74))

    return p.rgba()


def build() -> dict[str, bytes]:
    """Every file this script owns, keyed by name under web/public/."""
    return {
        "apple-touch-icon.png": png(
            TOUCH_SIZE, TOUCH_SIZE, render(TOUCH_SIZE, 0.0), alpha=False
        ),
        "favicon.ico": ico(
            [
                (s, png(s, s, render(s, CORNER_R), alpha=True))
                for s in ICO_SIZES
            ]
        ),
        # Opaque: the void is baked in for the same reason it is in the icon,
        # and an unfurler composites onto white as readily as onto anything.
        "og.png": png(CARD_W, CARD_H, card(), alpha=False),
    }


def main(argv: list[str]) -> int:
    check = "--check" in argv[1:]
    unknown = [a for a in argv[1:] if a != "--check"]
    if unknown:
        print(f"unknown argument: {unknown[0]}", file=sys.stderr)
        return 2

    public = Path(__file__).resolve().parent.parent / "web" / "public"
    want = build()

    if check:
        stale = []
        for name, data in want.items():
            p = public / name
            if not p.exists():
                stale.append(f"missing: {p}")
            elif p.read_bytes() != data:
                stale.append(f"stale:   {p}")
        if stale:
            print("\n".join(stale), file=sys.stderr)
            print(
                "\nRun scripts/make-icons.py and commit the result.",
                file=sys.stderr,
            )
            return 1
        print(f"generated images are current: {', '.join(sorted(want))}")
        return 0

    public.mkdir(parents=True, exist_ok=True)
    for name, data in want.items():
        (public / name).write_bytes(data)
        print(f"wrote {public / name} ({len(data)} bytes)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
