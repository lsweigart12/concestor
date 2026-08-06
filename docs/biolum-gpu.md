# Bioluminescence on the GPU

**Shipped.** The mode is WebGL2, no new dependency, no CPU particle simulation.
This is what it does and the gotchas that will cost you an afternoon.

---

## 1. What it draws

The rule is **the thing on the canvas is the light source** — nothing else glows.

1. **A branch is a river.** A near-transparent glass tube with internal
   reflection, carrying thousands of near-pinpoint emitters that move down the
   branch *and across it*.
2. **Nothing spills.** No light leaves an organism.
3. **Marine snow, not a grid.** The snow **emits nothing**; where it drifts near
   a river it catches that light, twinkles, and takes more of its hue the more
   light is nearby. Turn a branch off and the snow beside it goes dark.

## 2. The one idea

**"How much light is near this flake" is a texture read, not a neighbour
search.** Every emitter renders once into a full-resolution HDR light buffer;
that buffer is halved three times and blurred into the **vicinity field**. A
flake samples it at its own position and gets both the amount and colour of
nearby light in one fetch — physically an irradiance buffer, multiplied by the
flake's albedo. The same field sampled mirrored across a branch's centreline is
the internal reflection in the glass. One buffer, three effects.

## 3. Nothing is simulated

A pinpoint's position is a closed-form function of its index and the clock, and
so is a flake's. No integration, no per-particle state, nothing read back — one
instanced draw call per branch, and the only per-frame JavaScript is a few
hundred floats of per-branch parameters. That is what lets a tentacle light up
with *thousands* of merged haloes instead of ~100 beads on a wire.

The bunching is a displacement, not a velocity: `s' = s + a·sin(2π(k·s − f·t))`,
whose derivative `1 + 2πka·cos(…)` sets a density that compresses where the wave
slows and strings out where it does not. A second, slower wave carries
*brightness* — the band of excitation travelling down the tentacle.

## 4. Cost

Roughly **120,000 pinpoints + 14,000 flakes at ~1 ms/frame** on an M5, most of
it CPU-side upload and driver rather than the GPU (whose share stayed under
0.07 ms in every configuration tested, up to 3840×2160). The transferable figure
is the fill: ~**1.15 screens of cheap blending per frame** — one full-screen
composite, the snow and glass quads, and three eighth-resolution downsamples that
round to nothing. `SNOW_COUNT` scales with viewport area, or a large display is a
quarter as dense.

## 5. Five things that will cost you an afternoon

- **The displacement map folds.** `2πka > 1` flips the derivative's sign and
  every particle in the folded interval lands in one place — a **caustic**, a
  hard-edged white block, not a clipping artefact, so no tone map removes it.
  `ampFor` in `gl/tuning.ts` bounds it at **0.8**, not 1, because a derivative
  merely approaching zero already piles up.
- **The vicinity field must be built by halving.** A single blur from full
  resolution to an eighth is five taps over eight columns: a pinpoint on a tap
  contributes fully, one between taps contributes nothing, and bilinear filtering
  spreads that texel as a **hard bright square**. Three 2×2 box passes account
  for every source pixel exactly once.
- **`fract(p * k)` is not a hash.** Positions derive from a *sequential* instance
  id, on which the multiply-and-fract family has visible structure (snow comes
  out in blobs). Use PCG3D.
- **Every term in the glass must vary across the tube.** Anything constant across
  the tube has no shape, and shape is the only thing that reads a transparent
  object as a tube rather than a smudge (a constant wash drew a **bar**). The
  reflection must peak *inside* the wall, not at the boundary, or a neighbour's
  river caught in this glass comes out with a straight edge.
- **Do not lose the context in `dispose()`.** `canvas.getContext` hands back the
  same object every time, and React 19 runs an effect, tears it down, and re-runs
  it on the same element — so the first mount's cleanup kills the context the
  second is drawing with. Development only. Symptom: white page,
  `getError()` returns `CONTEXT_LOST_WEBGL`.

## 6. The entrance

The neutral canvas draws its traces on from the MRCA outward by sweeping a
`stroke-dashoffset`. The river inside each branch is gated on the same clock — a
per-branch `reveal` in the meta texture, feathered at the leading edge, read by
the river *and* the glass — so tube, wall and light grow together instead of a
lamp switching on inside an already-lit line.

The easing cannot be read back (sampling the browser's eased
`stroke-dashoffset` per frame forces a style recalc), so
`cubic-bezier(.16,.9,.3,1)` is evaluated in `tuning.ts` and `tuning.test.ts`
pins the two spellings together by parsing the string out of `TraceEdge`. A
mismatch does not throw — the light just runs ahead of the tip.

When the last wave arrives every branch **rings at once** via the same
`startRing` the pointer calls (so a landing and a pluck cannot become two
animations): rivers surge, glass brightens, snow brightens. Three constraints:
the landing fires when the **draw** finishes (a decay later reads as a second
event), it is **simultaneous** (a staggered settle reads as the animation
continuing), and the mode flag is read from a **ref**, never an effect
dependency — the effect is guarded by `playedToken`, so re-running it for any
other reason returns early after cleanup has cancelled its timers.

## 6b. The empty canvas

The mode is on before there is a tree, and the invitation lights it. The empty
canvas carries the wordmark, an opening card and a row of silhouettes, and those
emit under the same rule (**the thing on the canvas is the light source**). Draw
one species and the invitation unmounts, its light list goes empty, and the tree
is the only light. **The two lists are never both non-empty** — that is what
keeps it from being a second source.

**Chrome does not emit** — not the control bar, mode panel, axis, palette, keys
column or about link. Three sources emit, each something the reader is invited
*into*: the wordmark (soft, wide, the app's cyan), each silhouette on the card
(bright, in a lane hue), and the card itself (faintest by a factor of nine,
reaching ~200px past its edge, to give the snow somewhere to be visible over).
They go into the **same HDR buffer** as the rivers, so the snow, bloom and tone
map treat them identically — one extra screen-space elliptical pass in
`shaders.ts` with a radius per light.

Four constraints:

- **The DOM is the contract.** Lights are measured out of the live panel by CSS
  selector; `App.tsx` and `OpeningCarousel.tsx` own that markup and neither knows
  this exists. A renamed class yields no boxes and fails silently, so
  `bootLight.test.ts` reads all three source files and proves every named class
  is still applied.
- **The opening card had to become glass.** Opaque, it hid every light behind a
  silhouette for its own extent — same reading the branches already have.
- **Power is two orders of magnitude below a mark's.** These lights are 60–600px
  across against a mark's 14, so a leaf's 0.8 would be a white panel with a
  straight edge; saturation goes the *other* way (up to the river's 0.82) because
  overlapping area lights sum past white before any one is bright.
- **The panel is one chip, not three** — `labels` and `ages` annotate marks and
  have no business here. Below 620px nothing changes: no panel, no switch, and
  the palette carries `B`.

## 7. What did not change

The dash pattern, tier desaturation, draw-on animation, 16px hit target, and
`mayPump`'s refusal of a fossil tether. Branches are still real SVG paths; the
GPU layer sits behind them. The stroke is dimmer in this mode (the renderer now
draws the branch's own lit walls, and two walls at full strength read as a
doubled line), but `tierBrightness` still dims the river on the tiers that
concede most. A plucked branch **surges** and a pointed-at mark **flares**: one
float brightens the river, the glass around it, and the snow drifting past.

## 8. Where it lives

```
web/src/canvas/gl/tuning.ts    every number, and the pure functions
web/src/canvas/gl/shaders.ts   GLSL, assembled from those constants
web/src/canvas/gl/renderer.ts  the six passes
web/src/canvas/Water.tsx       the mount and the loop
web/src/canvas/flow.ts         the branch registry and tierBrightness
web/src/canvas/bootLight.ts    what the empty canvas emits, and why it may
```

**Shaders may not contain a number not imported from `tuning.ts`.** GLSL cannot
be unit-tested in node — it runs on a device the runner cannot reach and fails by
drawing something slightly wrong. So a shader is a *layout* of tested numbers,
and `gl/shaders.test.ts` asserts the interpolation happened (a mis-named import
reaches the GPU as the literal `undefined` and shows up only as a black canvas).
Without WebGL2 the switch is not offered — a switch that turns the canvas black
is worse than no switch.
