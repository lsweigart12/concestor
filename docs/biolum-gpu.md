# Bioluminescence, rebuilt on the GPU

**Shipped.** The mode is WebGL2 now, no new dependency, and the CPU particle
simulation is gone. This is the account of what it does, what it cost, and the
five things that will waste your afternoon if you touch it without reading.

Figures were measured on 2026-08-03: Apple M5, Chrome 148, `gl.finish()` or a
`readPixels` at both ends of every timing.

---

## 1. What changed, and why

The old mode read as *sparkly*. Three effects — a reaction pumped down each
branch, light spilled out of every node, a burst thrown off a plucked branch —
and the second and third were the problem. Light left the tree, drifted through
the volume, and went on shining on its own. That is a second light source
wearing the data's clothes, on a canvas whose whole premise is that the graph is
the only one.

Three changes, and they are one change:

1. **A branch is a river.** A near-transparent tube with some internal
   reflection, carrying thousands of near-pinpoint emitters down it, moving
   along the branch *and across it*. Not a line with an animation on it.
2. **Nothing spills.** No light leaves an organism.
3. **The grid is gone and marine snow replaces it.** The snow **emits nothing**.
   It is barely visible over most of the canvas, and where it drifts near a
   river it catches that light, twinkles with it, and takes more of its hue the
   more of it is nearby.

(3) is the one that makes (2) affordable. The mode did not lose its atmosphere
when the spill went — it got a better one, and one that is a strictly *stronger*
reading of the standing rule: turn a branch off and the snow beside that branch
goes dark.

## 2. The one idea

**"How much light is near this flake" is not a neighbour search. It is a texture
read.**

Every emitter renders once into a full-resolution HDR light buffer. That buffer
is halved three times and blurred: the **vicinity field**. A snowflake samples
it at its own position and gets, in one fetch, both how much light is near it
and what colour that light is. No quadtree, no grid hash, no N×M anything, and
it is also the physically right model — the buffer is irradiance and the flake
multiplies by its albedo.

The same field, sampled mirrored across a branch's centreline, is the internal
reflection in the glass. One buffer, three effects.

## 3. Nothing is simulated

A pinpoint's position is a closed-form function of its index and the clock, and
so is a flake's. No integration, no per-particle state, nothing read back — one
instanced draw call for every branch on the canvas, and the only per-frame
JavaScript is a few hundred floats of per-branch parameters.

That is what buys the count. The old renderer's ceiling was about a hundred
tracers per branch, because each one cost a step of JavaScript, and a hundred
points strung along a line reads as **beads on a wire**. A tentacle lighting up
is *thousands*, dense enough that their haloes merge into a continuous glow with
texture in it.

The bunching survives the change intact. The stream advances uniformly and is
then displaced by a travelling wave, `s' = s + a·sin(2π(k·s − f·t))`; the
derivative is `1 + 2πka·cos(…)` and the density goes as its reciprocal, so it
compresses where the wave slows it and strings out where it does not. Same
physics the 1-D solver computed, written as a displacement instead of a
velocity. A second, slower wave carries *brightness* rather than position, and
that is the band of excitation travelling down the tentacle.

## 4. What it costs

| | elements | ms/frame |
|---|---|---|
| the old 2-D renderer, 1920×1080 | 2,880 sprites | **1.01 – 1.12** |
| this, 1403×1308 | 120,000 pinpoints + 14,000 flakes | **0.89 – 1.03** |

Forty times the elements for the same frame cost, and the second row is the
larger canvas. The GPU's share never exceeded 0.07 ms in any configuration
tested, including at 3840×2160; what the numbers above are mostly measuring is
the CPU-side upload and the driver.

The M5 is fast and these absolute figures do not transfer. What transfers is the
fill: roughly **1.15 screens of cheap blending per frame** — one full-screen
composite, plus the snow and glass quads, plus three eighth-resolution
downsamples that round to nothing. That is the order a browser already pays to
composite an ordinary page.

## 5. Five things that will cost you an afternoon

Each of these was diagnosed wrong at least once first.

**The displacement map folds.** `2πka > 1` and the derivative changes sign:
every particle in the folded interval lands in the same place. That is a
**caustic** — a hard-edged white block sitting on the branch — and it is not a
clipping artefact, so no tone map removes it, because the light really is that
concentrated. It was blamed on the reflection, then the vicinity buffer, then
the tone map. `ampFor` in `gl/tuning.ts` is the bound, held at 0.8 rather than
1 because a derivative merely *approaching* zero already piles up.

**A vicinity field must be built by halving.** One separable blur straight from
full resolution to an eighth is five taps spanning eight columns: a pinpoint
landing on a tap contributes its whole self and one landing between taps
contributes nothing. One texel takes a clump, its neighbours take none, and
bilinear filtering spreads that texel across its own footprint as a **hard
bright square**. Three 2×2 box passes account for every source pixel exactly
once.

**`fract(p * k)` is not a hash.** Every position here is derived from a
*sequential* instance id, and the cheap multiply-and-fract family has visible
structure on exactly that input: neighbouring ids land near each other, so the
marine snow came out in irregular blobs with bare canvas between them. PCG3D
costs a handful of ALU per vertex and there is no per-particle state for it to
be amortised against.

**Every term in the glass must vary across the tube.** The first cut gave the
body an even wash and a broad reflection and drew a **bar**: a filled rectangle
with cut ends, sitting behind the river like a rail. Anything constant across
the tube has no shape, and shape is the only thing that makes a transparent
object read as a tube rather than as a smudge. The reflection also has to peak
*inside* the wall — peaking at the boundary put its maximum on the quad's own
edge, so a neighbour's river caught in this glass came out with a straight edge.

**Do not lose the context in `dispose()`.** `canvas.getContext` hands back the
same object every time, and React 19 runs an effect, tears it down, and runs it
again on the same element — so the first mount's cleanup kills the context the
second mount is already drawing with. In development only, which is the worst
place for it to hide. The symptom is a white page and `getError()` returning
`CONTEXT_LOST_WEBGL`.

## 6. The entrance

**It reaches out of the root and then locks in.**

The neutral canvas already draws its traces on from the MRCA outward, a wave at
a time, by sweeping a `stroke-dashoffset`. The river inside each branch is now
gated on the same clock — a per-branch `reveal` in the meta texture, feathered
at the leading edge, read by the river *and* by the glass — so the tube, its
wall and the light in it grow together. Before that the stroke drew on over a
branch that was already fully lit, and it read as two objects: a line being
drawn, and a lamp switched on inside it.

The easing has to match exactly and cannot be read back. There is no way to
sample the browser's eased `stroke-dashoffset` per frame that does not force a
style recalculation on every branch on every frame, so `cubic-bezier(.16,.9,.3,1)`
is evaluated in `tuning.ts` instead — which makes it two spellings of one
number, and `tuning.test.ts` pins them together by parsing the string out of
`TraceEdge`. A mismatch does not throw; the light simply runs ahead of the tip.

When the last wave arrives, every branch **rings at once** — one pluck, harder
than a pointer's and struck at the middle, because what arrived is the branch
rather than a place somebody touched. It is the same `startRing` the pointer
calls, so a landing and a pluck cannot drift into being two animations. Three
things respond and none was told about it: the rivers surge, the glass
brightens because the wall is lit from inside, and the snow brightens because
the vicinity field went up.

Three things not to redo. The landing fires when the **draw** finishes, not
after `DECAY_MS` when the flare has settled — a decay later it reads as a
second, unrelated event. It is deliberately **simultaneous** where the draw is
staggered, because a staggered settle reads as the animation continuing and the
whole point of the beat is that it has stopped. And the mode flag is read from
a **ref**, never a dependency of that effect: the effect is guarded by
`playedToken`, so re-running it for any other reason returns early *after* the
cleanup has cancelled its timers — press `B` mid-draw with the toggle in the
array and `onDeltaPlayed` never fires, leaving the delta open and the flare
stuck on the canvas.

## 6b. The empty canvas

**The mode is on before there is a tree, and the invitation is what lights it.**

The rule this mode is built on was written down as *the graph is the only light
source*, and for one state that was a claim about the graph being read as a
claim about the canvas. The empty canvas is not blank: it carries the wordmark,
an opening card and a row of silhouettes, and those are the thing on the canvas
in the one state where there is no graph. So the rule is stated in its general
form now — **the thing on the canvas is the light source** — and the empty state
emits under it. Draw one species and the invitation unmounts, the light list
goes empty, and the tree is the only light again. **The two lists are never both
non-empty**; that is what keeps this from being a second source.

The boundary is that **chrome does not emit**: not the control bar, not the mode
panel holding the switch, not the axis, not the palette, not the keys column or
the about link at the foot of the panel. Three sources, each something the
reader is being invited *into* — the wordmark (soft, wide, the app's own cyan),
each silhouette on the card (the bright ones, each in a lane hue, because these
are animals and animals are what glow here), and the card itself (the faintest
by a factor of nine, reaching two hundred pixels past its own edge, because its
job is not to be seen as a light but to give the marine snow somewhere to be
visible over).

They go into the **same HDR buffer** as the rivers, so nothing downstream was
told they exist: the snow twinkles beside them and takes their hue, the compose
pass blooms them, the tone map rolls them off. One extra pass in `shaders.ts`,
screen-space, elliptical, with a radius per light — a mark is at a place in the
tree and pans with it; a wordmark is at a place on the glass.

Four things not to redo:

- **The DOM is the contract.** The lights are measured out of the live panel by
  CSS selector, because `App.tsx` and `OpeningCarousel.tsx` own that markup and
  neither knows this exists. What it costs is a failure that is silent — a
  renamed class yields no boxes and the canvas is exactly as dark as it was
  before — so `bootLight.test.ts` reads all three source files and proves every
  class named is a class somebody still applies.
- **The opening card had to become glass**, and without that rule none of this
  is visible. It was `var(--void-2)`, fully opaque, sitting on top of the water
  canvas: every light behind a silhouette was computed, blurred into the
  vicinity field, lighting snow *outside* the card, and hidden for the whole of
  its own extent. Same reading the branches already have here, where the tube is
  glass and what you see along it is the stream inside.
- **Power is two orders of magnitude below a mark's, and has to be.** A mark is
  fourteen pixels across and these are sixty to six hundred, so a leaf's 0.8
  here is a white panel with a straight edge where the ellipse ends. Saturation
  went the other way, to the river's 0.82, because four overlapping area lights
  sum past white long before any one of them is bright — at a sensible-looking
  0.66 the whole panel came out grey.
- **The panel is one chip, not three.** `labels` and `ages` annotate marks and
  still have no business here; only the light does. That is a *shorter* panel,
  and its collision with the invitation was re-measured rather than assumed: it
  meets the keys column below about 678px wide and 694 tall, where the keys
  column gives way — the control bar above is already offering the same three
  presses as buttons at that width. Below 620px nothing changes: no panel, no
  switch, and the palette behind the one round button still carries `B`.

## 7. What did not change

The dash pattern, the tier desaturation, the draw-on animation, the 16px hit
target, and `mayPump`'s refusal of a fossil tether. Branches are still real SVG
paths; the GPU layer sits behind them exactly as the 2-D canvas did. The stroke
is dimmer in this mode than it was — the renderer now draws the branch's own lit
walls, and two walls at full strength read as a doubled line — but the channel
is intact and `tierBrightness` still dims the river itself on the tiers that
concede most.

The two interactions kept their responses and got better ones. A plucked branch
**surges** instead of shedding a burst, and a pointed-at mark **flares**. Three
things respond to one float — the river brightens, the glass around it brightens
because the wall is lit from inside, and the snow drifting past brightens
because the vicinity field went up — and none of them was told about the pluck.

## 8. Where it lives

```
web/src/canvas/gl/tuning.ts    every number, and the pure functions
web/src/canvas/gl/shaders.ts   GLSL, assembled from those constants
web/src/canvas/gl/renderer.ts  the six passes
web/src/canvas/Water.tsx       the mount and the loop
web/src/canvas/flow.ts         the branch registry and tierBrightness
web/src/canvas/bootLight.ts    what the empty canvas emits, and why it may
```

**Shaders may not contain a number that is not imported from `tuning.ts`.** GLSL
cannot be unit-tested in node: it runs on a device the runner cannot reach, it
fails by drawing something slightly wrong rather than by throwing, and nobody
reviews a magic constant sitting in a template literal. So a shader here is a
*layout* of tested numbers, and `gl/shaders.test.ts` asserts the interpolation
actually happened — a mis-named import would otherwise reach the GPU as the
literal `undefined` and show up only as a black canvas.

`particles.ts` is deleted. `SNOW_COUNT` scales with viewport area, because a
field sized for a laptop is a quarter as dense on a large display, which is
where a slow rain stops reading as weather and starts reading as dust on the
screen. Below 620px the mode panel is not drawn, so the switch does not exist on
a phone; without WebGL2 it is not offered either, because a switch that turns
the canvas black is worse than no switch. Both of those hold on the empty
canvas too — §6b changes which chips are drawn there, never the terms.
