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
3. `t=120` — New traces draw from MRCA outward, ~613ms, ease-out.
4. `t=733` — Each decays from flare-bright to steady state over ~1400ms.

Reflow and draw must overlap. Sequential feels laggy; overlapping feels
alive. If the new path spans multiple segments, draw them in order
root-ward → leaf-ward, lightly staggered, a wave every ~96ms. All-at-once
reads as a fade-in; staggered reads as travel.

**A wave, not a route.** Everything the same number of segments from the
MRCA draws together. Two lineages that parted at one node have to leave it
at the same moment, because that is what the node *says*. Staggering by
distance-along-one-path instead is invisible while a single species is being
added — the new segments are a chain then — but on a restored selection,
where every segment is new, it picks one arbitrary leaf, unspools the tree
down its ancestry, and leaves every other branch to appear beside it with no
animation at all. Breadth-first is the general case; the chain is a special
case of it.

The MRCA itself is not drawn on. A segment belongs to the node *below* it,
and the MRCA has nothing above it inside the subtree — it is where the first
wave leaves from. Giving it a wave of its own spends the first beat of the
sequence on nothing and delays the whole draw past `t=120`.

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
- **A species row's icon is its silhouette**, the same one the node will wear
  once it lands — so the row previews the result rather than only naming it. A
  shape is recognised before a name is read, which matters most where the names
  are unfamiliar, and that is the whole corpus for this audience.
  The canvas's suppression rule applies unchanged: an image borrowed from a
  kingdom-sized ancestor is worse than none, so those rows keep the plain `◦`.
  So does a row whose silhouette has not been mirrored yet — the slot never
  blinks empty, because rows must not shift under a moving cursor.
- Fuzzy search with highlighted match ranges. Results rank on recency and
  frequency, not alphabetically.
- Commands accept typed arguments inline (species name, clade, node id).
- `⌘K` with a node selected opens a **contextual actions menu** — nested
  palette scoped to that node or branch.
- The search field carries a breadcrumb of current scope. Backspace at
  position zero pops the scope.
- Inline keybind hints on every row. Persistent hint bar on the **top edge**,
  flat text under the same fade-to-void the axis uses, not a pill. It was
  pinned bottom-right until the axis footer had something to say; the two
  questions now split by edge — the top says what you can *do*, the bottom says
  how to *read* what you see.
- Confirmations are brief HUD toasts. No modals, no dialogs.

---

## Canvas

- Near-black base (#0A0A0B–#101012). Faint grid in the void, barely
  perceptible, no parallax.
- Traces are luminous: 1–2px core with a soft additive bloom halo.
- Selected path burns bright; unselected lineages recede to dim and
  desaturated. Contrast does the wayfinding, not labels.
- Nodes are small luminous points that bloom on hover and focus.
- Dash pattern is the one thing on the canvas a reader cannot infer, and it
  carries the provenance claim, so it is stated as a **key on the axis footer**
  — one line, key left, units right, flat text at the same size. A key, never
  an explanation: the sentences belong in the node card, one click from the
  node being asked about. It names only the patterns actually drawn, so a fully
  dated tree shows no key at all. It is the narrow exception to "no onboarding
  overlays", not a licence for more chrome — and it is **not** a panel. Two
  drafts made it one, a card and then a pill, and both were a third floating
  object on an edge that already had two. The line it belongs on existed.

## Hit targets

**The pointer follows the ink.** What is painted is what can be clicked; a gap
between painted things belongs to whatever is drawn underneath it. Everything
below is that one rule applied to the three things that overlap on the canvas.

- **A label selects its node — the whole label, not the dot.** The name, the
  rank row and the silhouette are what a reader aims at; the dot is 10px, which
  is below every pointing guideline there is, and for a long time it was the
  only target a node had. `onNodeClick` fires for any descendant of the React
  Flow node wrapper that takes pointer events, so this is a CSS reach and not
  new wiring.
- **The transparent parts of a label box do not take the pointer.** The box
  carries an explicit width from the placement pass and is mostly empty; a
  one-word name in a 168px box would otherwise cover 140px of canvas with
  nothing. `pointer-events` is granted to `.mark-text` and the silhouette, never
  to `.mark-label`. `.mark-text` is also exactly the rectangle the crowded scrim
  paints, so the scrim and its target are the same box by construction.
- **A label may cover a trace, and where it does, the label wins.** The loss is
  not symmetric: a trace is a long run and keeps every other point along it,
  while a label is one small box and, having lost it, its node is back to a
  10px dot. In practice the case is rare — the placement pass tests every
  candidate against the traces, so it only arises when nothing is clear, which
  is the same condition that draws the scrim. Measured on a twelve-carnivoran
  canvas at the lowest zoom tier, 2,249 points sampled along every drawn trace:
  **no point of any trace was taken by a label**, and 92.9% of trace centreline
  stayed reachable both before and after labels became clickable. The 7.1% that
  is not reachable is covered by the node dots at the segment endpoints, which
  has always been true.
- **The placement pass reserves 5px either side of a trace; the click target is
  8px.** So a label placed legitimately clear of a trace can still sit inside
  its hit stroke — measured worst case, a label came within 3px of a centreline
  and took 5 of the 8px on that side. It narrows the segment there and never
  blocks it. Widening the model to 8px would push labels around to buy back
  three pixels of a sixteen-pixel target, which is not a trade worth making.
- **A silhouette's target is the box the layout reserved, not the box the
  transform paints.** `--icon-scale` grows the drawing as the canvas pulls back,
  and a transform moves hit-testing with it: at the 1.6 cap the picture claims
  54.4px where the placement pass reserved 34, and those extra 10.2px on every
  side have been tested against nothing, because the model does not know they
  exist. Letting them take the pointer cost one segment 45% of its clickable
  length and made one label answer for a *different* node. A counter-scaled
  overlay pins the target back to the reserved box. **At every zoom of 1:1 or
  closer the scale is 1, so the drawing and its target are the same box** — the
  two only diverge as you pull back, which is a survey view, not an aiming one.
- **Every target belongs to exactly one node.** That is the property to hold on
  to, and the one worth re-measuring after any change here: sampled on a grid
  over all 42 targets of a crowded canvas at the lowest tier, 1,841 points, none
  resolved to the wrong node and none to nothing. Selecting a neighbour is worse
  than a missed click, because a missed click is visibly nothing and a wrong
  selection looks like an answer.
- **Dimmed is not disabled.** Unselected lineages recede to 0.26 opacity, and
  clicking one is how a reader focuses it. Opacity, the crowded scrim and the
  hover bloom all leave the target alone.
- **Both silhouette and name carry a tooltip, and both were unreachable until
  the label took the pointer.** The silhouette's says what an inherited drawing
  actually depicts — the smallest clade holding both the node and the picture,
  and its size. That claim is the whole justification for keeping the provenance
  text off the canvas label, so a label that cannot be hovered silently deletes
  it. The name's explains a derived `Homo / Pan` divergence name, which is the
  only place on the canvas that construction is spelled out.

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