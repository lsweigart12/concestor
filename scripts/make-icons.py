#!/usr/bin/env python3
"""
The raster icons, from the same geometry as web/public/favicon.svg.

The SVG is the icon. These are the two places it cannot go:

  - **apple-touch-icon.png** — iOS uses it for a home-screen bookmark and
    Safari for surfaces of its own, and takes no SVG for either.
  - **favicon.ico** — a browser that does not read an SVG favicon, and any
    browser at all before it has parsed the document, asks for `/favicon.ico`
    at the root whatever the markup says. Without a real file that request
    reaches the SPA fallback and is answered with `index.html` at 200, which is
    harmless and is also a lie. Two sizes go in it: 16 is where a favicon is
    actually looked at, and rendering it directly beats letting anything
    downsample a 32.

**Why a generator rather than committed binaries with no source.** A PNG in the
tree that nobody can regenerate stops matching the SVG the first time the icon
changes, and nothing in the repository can tell. This script is the source;
`--check` makes that testable, and `web/src/icons.test.ts` pins the numbers
below to the SVG in the other direction.

**Why the standard library and nothing else.** Rasterising this glyph is two
circles, a disc and a rounded rect. Every alternative — cairosvg,
rsvg-convert, ImageMagick, headless Chrome — is a system dependency or a wheel
with a C library under it, for images whose entire content is *distance from
centre*. `zlib` and `struct` are enough, the bytes are identical on every
machine, and CI needs nothing installed.

Two differences between the touch icon and the others, both required by iOS:

  - **Square corners, full bleed.** iOS applies its own squircle mask. An icon
    that arrives pre-rounded is rounded twice and shows the seam.
  - **No alpha channel.** Apple's guidance is an opaque image, and the void is
    opaque anyway. The `.ico` keeps its alpha, because there the rounded
    corners have to be transparent against whatever the tab strip is.

Usage:
    scripts/make-icons.py            write both files into web/public/
    scripts/make-icons.py --check    fail if either file on disk is not what
                                     this script would write
"""

from __future__ import annotations

import struct
import sys
import zlib
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


def png(size: int, rgba: bytearray, *, alpha: bool) -> bytes:
    """A minimal 8-bit PNG. No ancillary chunks, so the bytes are stable."""

    def chunk(tag: bytes, data: bytes) -> bytes:
        return (
            struct.pack(">I", len(data))
            + tag
            + data
            + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)
        )

    stride = 4 if alpha else 3
    raw = bytearray()
    for y in range(size):
        raw.append(0)  # PNG filter type 0: none.
        row = rgba[y * size * 4 : (y + 1) * size * 4]
        if alpha:
            raw += row
        else:
            for i in range(0, len(row), 4):
                raw += row[i : i + 3]
    assert len(raw) == size * (1 + size * stride)

    header = struct.pack(">IIBBBBB", size, size, 8, 6 if alpha else 2, 0, 0, 0)
    return (
        b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", header)
        + chunk(b"IDAT", zlib.compress(bytes(raw), 9))
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


def build() -> dict[str, bytes]:
    """Every file this script owns, keyed by name under web/public/."""
    return {
        "apple-touch-icon.png": png(
            TOUCH_SIZE, render(TOUCH_SIZE, 0.0), alpha=False
        ),
        "favicon.ico": ico(
            [
                (s, png(s, render(s, CORNER_R), alpha=True))
                for s in ICO_SIZES
            ]
        ),
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
        print(f"icons are current: {', '.join(sorted(want))}")
        return 0

    public.mkdir(parents=True, exist_ok=True)
    for name, data in want.items():
        (public / name).write_bytes(data)
        print(f"wrote {public / name} ({len(data)} bytes)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
