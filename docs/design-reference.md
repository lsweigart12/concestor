# Frontend Design Language

## Principle

A dark instrument where the graph is the only light source, operated almost
entirely from a command surface.

Visual metaphor is **phosphor persistence** — oscilloscope, radar sweep,
vector display. A trace flares bright as it is drawn, then decays to a dim
persistent line. Brightness encodes recency and selection, never data value.
Secondary reference: bioluminescence (deep-sea, mycelial networks). Cool
temperature throughout — cyan/teal/pale green. Explicitly not warm-orange
heatmap.

Interaction model reference is **Raycast**: the command palette *is* the
interface, not an accessory to it.

Graph craft references: Sublime Merge's commit graph, Dagster's asset graph,
Nuke's node editor. Flashy the way a well-lit instrument is flashy. Never
decorative.

---

## Signature interaction: adding a node

This is the product. Everything else is plumbing in service of it. Get this
right before polishing anything else.

The draw originates at the **MRCA** and extends outward to the new leaf.
Not from root. Not inward from the leaf. The point of the animation is to
show *where the new species joins* — the MRCA is the subject.

Sequence, overlapping not sequential:

1. `t=0` — Existing nodes begin spring reflow to new positions.
2. `t=80` — MRCA node flares. Brief bright pulse. The connection beat.
3. `t=120` — New trace draws from MRCA outward, ~350ms, ease-out.
4. `t=470` — Trace decays from flare-bright to steady state over ~800ms.

Reflow and draw must overlap. Sequential feels laggy; overlapping feels
alive. If the new path spans multiple segments, draw them in order
root-ward → leaf-ward, lightly staggered. All-at-once reads as a fade-in;
staggered reads as travel.

Implementation: React Flow edges are SVG paths — use `getTotalLength()` with
`stroke-dasharray` / `stroke-dashoffset`. Decay is a separate opacity or
filter tween on the same element.

---

## Command surface

- `⌘K` is the root. Opening the app opens the palette. The empty canvas
  state is the command list, not an illustration.
- Every action has a command. Mouse is a convenience path, never required.
- Palette rows follow Raycast anatomy: icon · title · subtitle ·
  right-aligned accessory metadata.
- Fuzzy search with highlighted match ranges. Results rank on recency and
  frequency, not alphabetically.
- Commands accept typed arguments inline (species name, clade, node id).
- `⌘K` with a node selected opens a **contextual actions menu** — nested
  palette scoped to that node or branch.
- The search field carries a breadcrumb of current scope. Backspace at
  position zero pops the scope.
- Inline keybind hints on every row. Persistent hint bar pinned bottom-right.
- Confirmations are brief HUD toasts. No modals, no dialogs.

---

## Canvas

- Near-black base (#0A0A0B–#101012). Faint grid in the void, barely
  perceptible, no parallax.
- Traces are luminous: 1–2px core with a soft additive bloom halo.
- Selected path burns bright; unselected lineages recede to dim and
  desaturated. Contrast does the wayfinding, not labels.
- Nodes are small luminous points that bloom on hover and focus.

## Layout

- Deterministic hierarchical layout. Positions computed, never simulated.
- **No force-directed layout.** Non-deterministic, wobbles between loads,
  and destroys the reading of ancestry. Not negotiable.
- Layout pass via d3-hierarchy / ELK / dagre. Nodes are not user-draggable.

## Edges

- Orthogonal routing, small consistent corner radius. No bezier — curves
  make convergent branches ambiguous.
- Stable lane assignment; a lane keeps its hue across renders.
- Uniform stroke weight. Encode meaning in luminance and hue, never width.

## Zoom

- Semantic zoom, not scale zoom. Nodes change *what* they render at each
  level, not just their size.
- Three tiers: glowing point → point + label → full detail card.
- `⌘0` fit all · `⌘.` fit selection · `⌘\` isolate path to root.

## Motion

- Motion preserves object identity across state changes and rewards the add
  action. Nothing animates purely for delight.
- Spring physics, interruptible, 200–300ms for reflow.
- Bloom intensity animates on selection change. No slide, no scale-bounce.
- Enter/exit is fade plus draw-on. Never slide.
- Respect `prefers-reduced-motion`: cut to final state, keep glow static.

## Typography

- One geometric or grotesque sans for UI. One mono for identifiers,
  coordinates, and all numerics.
- Two weights maximum. Hierarchy from size, opacity, and glow — not weight.
- Labels never rotate. Truncate with ellipsis before you tilt text.
- Numerics are tabular-figure mono. Confident, unapologetic.

## Color

- Monochrome dark base. Cool accent for selection and focus.
- Lane hues are a tight, low-saturation cool set — distinguishable, never
  candy.
- Light theme is out of scope. This is a dark-only instrument.

## Density

- Assume the user wants more on screen, not less. Tight spacing scale.
- Hairline borders at low opacity. No drop shadows for hierarchy — use glow
  and background steps.
- Chrome auto-hides. The canvas is the page.

## State

- All view state is URL-encoded. Any view is a shareable link.
- Full keyboard operation: search, add, remove, clear, fit, isolate, and
  step through selection are all bound.

---

## Explicit non-goals

- Not Mermaid. Not a static diagram renderer.
- No glassmorphism, no gradient meshes, no ambient background animation.
  The glow comes from the data, nowhere else.
- No onboarding overlays or empty-state illustrations — the palette is the
  empty state.
- No settings panel that duplicates something a command already does.
- No warm-orange heatmap palette.

## Stack

React Flow / xyflow v12 for interaction and edge rendering, with positions
driven by our own layout pass and node dragging disabled.

Bloom via a post-process pass or layered blur — verify cost early and drop
to flat strokes at low zoom if it costs frames. Frame budget beats glow
every time.

Move to Canvas 2D or WebGL if React Flow's DOM overhead becomes the
bottleneck.