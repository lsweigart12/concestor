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

- **Every binding is a bare letter, and nothing here holds a modifier.** `P`
  opens the palette, `S` opens it filtered to species, `F` fits, `/` isolates,
  `Tab` steps, `L` switches the time scale, `R` adds a random species, `⇧R`
  draws a random fossil, `C` clears. Shift is the *variant* of a binding and
  never a second one, so a reader who learns `R` has already guessed `⇧R`.
  The rule this replaces was a running negotiation with the browser — `⌘L`
  reaches the URL bar and cannot be prevented, `⌘F` is find, `⌘R` is reload —
  and every mnemonic that survived it was shifted twice and wrong. The canvas
  has no text entry, so the letter keys are ours and the chords stay the
  browser's. `web/src/chrome/bindings.ts` is the one table; `matchKey` refuses
  any press holding ctrl, meta or alt, which is what keeps that promise.
- `P` is the root of the command surface. The empty canvas state is the
  command list, not an illustration.
- **Every action has a command, a key, and a button.** Keyboard operation is
  first class and not exclusive; the second half of that is new. The control
  bar on the top edge draws the bindings as real buttons with the key printed
  on each one — badge first, word second, because the button is how you do it
  now and the key is how you will do it in a minute. Mouse is a convenience
  path, never a required one, and the reverse is now also true.
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
- A node's own actions are a **contextual section** of the palette rather than
  a separate mode; a fossil clicked in the drill-down lane still opens a menu
  scoped to it, because a fossil's actions are all about the node it attaches
  to and none of the general ones apply.
- The search field carries a breadcrumb of current scope. Backspace at
  position zero pops it.
- **A filter is a scope over one corpus, and `S` is the one that exists.** It
  drops commands and fossils from the list entirely rather than demoting them:
  the reader pressed a key naming a corpus, and leaving a command row above the
  answer would make the filter a suggestion. Inside the palette it is also
  reachable by typing `s` then space — live only on an empty field, so
  *Sus* and *Salmo* are never intercepted. It pops with backspace like any
  other chip.
- **There is a way in that does not require having thought of a species.**
  The empty canvas is an **openings carousel** — one question at a time, its
  taxa previewed as silhouettes, arrows and dots to move, auto-advancing until
  the reader hovers or takes control. Every other way in assumes you already
  have a name in mind, and nobody browses 2.4 million of them. `R` adds a
  random species and `⇧R` draws a random fossil, for a reader who wants the
  corpus rather than a curated question. Both draw only from taxa that
  carry **a silhouette of their own**, which is the whole of the design — a
  uniform draw returns an unnamed `mrcaott…` clade or an undescribed mite, and
  a surprise that is usually nothing to look at is one a reader stops pressing.
  A random fossil also adds the clade it hangs below when the canvas has not
  got it, because otherwise the command's usual outcome is a refusal notice for
  something nobody chose by name.
  The two share a letter, which is the pairing `⌘⇧S`/`⌘⇧F` could never have
  had: `⌘⇧R` is hard-reload in every browser. Copying a shareable link lost its
  key in the same change and kept its command — `s` and `l` are the two most
  used letters in the app, and share is the one action nobody reaches for
  mid-flow.
- **A command row may carry a tooltip its subtitle cannot hold.** The subtitle
  is one line in a fixed-height row; a caveat that needs a sentence — what a
  pick is drawn from, what it will do to the selection as a side effect — goes
  in `Command.hint`, which a reader can go looking for and never has to read
  past. It falls back to the subtitle, so every row has one.
- Inline keybind hints on every row, from the same table the buttons read.
- **The control bar is on the top edge**, under the same fade-to-void the axis
  uses, not a pill and not a panel. The two questions split by edge — the top
  says what you can *do*, the bottom says how to *read* what you see. It
  auto-hides with the rest of the chrome and comes back on hover, because a
  faded control is still a control. An action that cannot run right now is
  **disabled, never hidden**: a bar that reshuffles as the selection changes
  costs the reader the button they were already reaching for, and the tooltip
  on a greyed one says what would make it work. Below 720px the labels go and
  the badges stay; below 620px the two bindings a touch reader cannot use
  anyway — step, and a random fossil — go with them.
- Confirmations are brief HUD toasts. **One dialog exists**, and only one:
  clearing the canvas asks first. It is a single unshifted letter beside two
  other single unshifted letters, it is the only action that can destroy an
  hour of work, and a toast reading "Canvas cleared" reports the accident
  rather than preventing it. Everything else is additive or one keystroke from
  being undone, and confirms after the fact as before.

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
  — one line, key left, scale right, flat text at the same size. A key, never
  an explanation: the sentences belong in the node card, one click from the
  node being asked about. It names only the patterns actually drawn, so a fully
  dated tree shows no key at all. It is the narrow exception to "no onboarding
  overlays", not a licence for more chrome — and it is **not** a panel. Two
  drafts made it one, a card and then a pill, and both were a third floating
  object on an edge that already had two. The line it belongs on existed.
- **The right end of that line is both scales and their key, and it is the
  switch.** It reads `L | linear | log` as a segmented control: both options
  always legible, the live one lit. It replaced "millions of years before
  present · symlog", which spent the line on a unit every tick and node label
  already carries and buried the two facts that matter — that there is a second
  scale, and that you can have it. A middle draft named only the live scale,
  which fixed the first fact and not the second: `linear` alone never says an
  alternative exists, and one word on a button cannot distinguish *what you are
  on* from *what you would get*. Showing both answers all of it, and going back
  is pressing the one you want rather than knowing the button reverses.

  `symlog` stays out of it — the name of a transform, not of anything on
  screen; the knee is labelled on the axis where it happens, and the tooltip
  carries the units and the full word "logarithmic". It wears the control bar's
  anatomy — badge, then the control — because it is the one binding not drawn
  on the bar, and this is where the thing it changes lives. The badge sits
  outside both segments because `L` toggles rather than selects. A first pass
  styled the whole thing as flat text on the "no third floating object"
  argument above; that argument is about panels, and reading as prose cost a
  small control the only job it has, which is to look pressable.

- **Quiet at the default, accented away from it.** Linear is the default scale,
  so on linear the lit segment is plain ink and the control announces nothing.
  Logarithmic is a departure — pressed, or arrived at through a link carrying
  `axis=log`, or asked for by an opening — and the whole control takes the
  accent at low alpha. This is ordinary filter-chip grammar, and it earns its
  place here for a specific reason: **a reader who followed someone else's link
  did not choose that scale and would otherwise have no way to know the view
  was set for them**, and a log axis is the reading that most flatters recent
  divergences. The segment that is *not* lit stays legible in that state, or
  the accent marks a trap rather than a state. This is the one place chrome may
  carry the accent for something other than hover or focus; the canvas keeps
  every bright pixel it had.

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
- `F` fit all · `⇧F` fit selection · `/` isolate path to root.

## The detail card

The third zoom tier, and the only surface in the product that is *read* rather
than scanned. Its order is the design:

1. **The silhouette**, watermarked with what it is actually of when that is not
   this taxon.
2. **The scientific name**, then the common name under it, then the rank. Under,
   not instead of — the canvas label, the palette row and the URL all identify a
   taxon by its scientific name, and a card that answered to "cat" where the
   canvas says *Felidae* would make a reader check they had clicked the right
   thing. An unranked clade shows no rank rather than the words "no rank".
3. **One control: put it on the canvas, or take it off.** Directly under the
   name, above anything a reader might scroll past. One button in two states,
   not a pair with one greyed out.
4. **A description**, from Wikipedia, clamped to seven lines with the rest one
   click away, credited and linked. It is fetched when the card opens and the
   card is complete without it.
5. **The classification** — the major Linnaean rungs present, the ones absent
   named rather than skipped, and the complete named ancestry folded into a
   disclosure as one wrapped chain rather than a column of rows. Twenty rows of
   one word each is a list of twenty things; a chain is one thing, which is what
   a lineage is.
6. **The figures** — age, ranges, counts, identifiers. Mono, right-aligned.
7. **The other names** it goes by.
8. **"Why it is drawn this way"**, collapsed: every caveat about tier,
   placement, and what the picture depicts.

**Provenance is secondary and identity is not.** The rule that decides which
side of the disclosure a sentence falls on is whether it tells the reader what
the thing *is*. A divergence's derived name — "the last common ancestor of X and
Y" — is the only name an `mrcaott…` node has, so it stays on the face of the
card while everything around it folds away.

**Every name on the card that names a taxon opens that taxon's card**, and the
card is therefore the second navigation surface — the first being the canvas.
Classification rungs, the full lineage, the silhouette's subject and the clade
it speaks for, a witness, a fossil's attachment point. Three rules hold it
together:

- **A link goes to what the name names.** A witness opens a *fossil* card, not
  the node it hangs below — that node is a clade thousands of times its size and
  is not what the reader clicked.
- **Selection does not require the thing to be drawn.** Most of these ancestors
  are suppressed from the induced subtree; the card opens on them anyway, and
  the control at the top is how they get onto the canvas. A lineage you can
  click through is a lineage you can walk up and pull from.
- **A link with nothing to point at is plain text**, never a dead control. Half
  the targets are optional fields — a clade is null for the unnamed `mrcaott…`
  nodes, a witness on an older build carries no PBDB number.

A link is a dotted underline in the surrounding ink, not an accent colour: on
this card most of the nouns are clickable, and colouring them all would make the
classification read as a menu with a taxon hidden in it. The two real anchors —
Wikipedia and the licence — leave the app, and look different because they do.

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
- **The age slot holds figures. Its two non-figures are marks, not words.** A
  node label says "96 Ma", "≤ 96 Ma", a fossil range, or nothing; the two cases
  that were spelled out — `fossils` before a range and `present` where there is
  no number — set a word in the widest slot of a label whose whole placement
  problem is width, and read as part of the quantity rather than as a change of
  register. They are an ammonite and a clock, stroked at 13px, defined in
  `web/src/canvas/AgeGlyph.tsx`.
  - Stroked, never filled: a *filled* shape beside a node is a silhouette on
    this canvas, and a silhouette is a claim about what a taxon looks like.
  - The fossil mark is load-bearing, not decoration. Beside a node drawn at
    66 Ma a bare "84–66 Ma" reads as that node's age, which is the one thing the
    `occurrence` tier exists not to imply, so the range never renders without
    it. `markAge` is the single place that guarantees this.
  - The words survive as each mark's accessible name and its tooltip, and the
    node card still spells both out in full. A distinction available only to
    someone who can see it is not a distinction the product has made.
  - Running prose is unaffected: the drill-down lane still writes "382 Ma –
    present", where the word is one end of a range rather than a label.

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
- No onboarding overlays, and no *decorative* empty state. The bar this sets is
  that everything on an empty canvas must be a live control over real data —
  which the openings carousel meets and a spot illustration would not. It
  replaced "the palette is the empty state", which was true while the empty
  canvas was a command list and stopped being true when the openings landed.
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