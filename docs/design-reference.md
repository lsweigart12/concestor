# Frontend Design Language

## Principle

A dark instrument where the graph is the only light source, operated almost
entirely from a command surface.

Visual metaphor is **phosphor persistence** — oscilloscope, radar sweep,
vector display. A trace flares bright as it is drawn, then decays to a dim
persistent line. Brightness encodes recency and selection, never data value.
Secondary reference: bioluminescence. Cool temperature throughout — cyan/teal/
pale green. Not warm-orange heatmap.

Interaction model reference is **Raycast**: the command palette _is_ the
interface, not an accessory to it.

---

## Signature interaction: adding a node

This is the product. The draw originates at the **MRCA** and extends outward to
the new leaf — not from root, not inward from the leaf. The point is to show
_where the new species joins_; the MRCA is the subject.

Sequence, overlapping not sequential. **Every beat is measured from the moment
the viewport comes to rest**, not from the press: an add both moves the canvas
and draws on it, and marks appearing under a moving canvas are marks no eye can
follow.

1. `t=0` — Existing nodes begin sliding to their new positions, alongside the
   reframe. Both are the canvas rearranging, and they settle together just
   before the draw leaves.
2. `t=80` — MRCA node flares. Brief bright pulse.
3. `t=140` — New traces draw from MRCA outward, ~1080ms, ease-out.
4. `t=980` — Each new mark appears under the line that reached it and the taxon
   that was added blooms — a moment before the stroke's nominal end, which its
   easing has all but reached. The traces settle from flare-bright over ~1400ms.

Reflow and draw overlap. If the new path spans multiple segments, draw them
root-ward → leaf-ward, staggered as a wave every ~170ms. **A wave, not a route:**
everything the same number of segments from the MRCA draws together, because
two lineages that parted at one node have to leave it at the same moment. The
MRCA itself is not drawn on — a segment belongs to the node _below_ it.

**The draw is slower than an interface transition wants to be.** It was ~613ms
with a ~96ms stagger, and at that pace the line arrived before the eye had found
where it started, so the tree looked _different_ rather than looking like it had
grown. Acknowledging the press is the toast's job; this has to let an eye follow
one line to a taxon that was not there. The two move together — a longer draw
with the old stagger collapses the waves back into a fade-in.

**Both paths of a trace draw on, not just the core.** The halo is the same
geometry at 7px under a 3.5px blur, so a halo left alone stands at full length
from the first frame and the branch arrives as a soft grey line _before_
anything draws it. That was invisible at 613ms and is not invisible now.

**A mark arrives at the end of its line, not the start.** A node stands for the
segment above it, so new marks stay invisible until the draw reaches them and
the line travels into empty canvas. Showing a mark when its line _leaves_ draws
the destination before the journey. The join point is exempt: it was on screen
before the press.

**Exactly one mark blooms** — the taxon that was added, in its lineage's colour,
as the line lands. _Single_, because a repeating pulse is how an interface says
_something needs attention_, and this is an event that happened once. _Slow_,
because it is the only thing on the canvas that has to be findable without being
pointed at. It fires on the added leaf and never on the MRCA: at the join it
would name a clade the reader never typed. In the bioluminescent mode the same
event is also said in that mode's vocabulary — a much larger, slower version of
the flare a pointed-at mark already gives, lighting the water and the snow.

### The tree makes room

**Adding a taxon moves almost everything**, and it used to move it between two
frames: a new leaf takes a row so every row below shifts down, a new divergence
re-parents a branch so the fork moves in x and both children move in y. The
reader pressed a key and the tree they were reading was replaced by a different
one — and then a line arrived into a picture they had to re-find first.

**Everything drawn here derives from one map of positions** — a mark's
transform, a trace's `d`, a graft's connector, an emitter's place in the water —
so interpolating that map moves all four in step, with no second animation to
keep synchronised with the first.

A node the previous arrangement did not have is placed rather than tweened. It
is invisible until its own line reaches it, so it has no business sliding in
from anywhere.

**A draw belongs to its token, not to its geometry.** `d` was in the draw-on
effect's dependency array, so every branch the rearrangement moved re-ran it,
and one that had already finished re-armed from `stroke-dashoffset: len` and
drew itself on again. Nothing in the DOM said so — only the path data changed —
which is what made it hard to see. `TraceEdge.dom.test.tsx` is the pin.

**Node positions may not be animated through React Flow, and that is why the
rearrangement is split in two.** Handing it a new `nodes` array on every
animation frame makes it drop _every edge on the canvas_ for the length of the
tween — measured at 60fps, 580ms of a tree with no branches in it. So the marks
are given their settled positions once and glide on a CSS `transition`; only
the traces, whose geometry is ours, are interpolated per frame. One curve and
one duration serve both, in `canvas/reflow.ts`, and `reflow.test.ts` reads the
stylesheet to hold them together: a dot is the end of a line, and eased
differently the branch would come away from the mark it arrives at.

**The animation is a courtesy; arriving is not.** `requestAnimationFrame` is no
promise that anything will happen — a background tab, a pane the compositor is
not painting — so a timer lands the final arrangement whether a single frame is
drawn or not. Under `prefers-reduced-motion` the rearrangement is refused
outright rather than slowed: its whole content is _where things went_, and a
reader who asked for no motion is better served by the answer.

### Taxa queue, and draw one at a time

**A taxon may be asked for at any moment; it is drawn when the canvas is free.**
Adds go into a queue — an opening's remaining taxa, a press of `R`, a palette
row, **a fossil**, all the same queue — and the head is released when its lineage
has arrived _and_ the previous draw has landed. Holding `R` down therefore draws
every species it rolls, in turn, instead of each press cutting the last animation
off at the knees.

**A fossil is a taxon here.** It waits its turn, it draws itself on, and its mark
blooms where the line arrives, exactly as a species does — the only differences
are what its *connector* is allowed to claim (`fossil-grafts.md` §3). It used to
appear the moment its row was fetched, which meant reflowing whatever was drawing
at the time; a graft that simply materialises is both a worse arrival and the
cause of a real rendering bug.

**Nothing outside the canvas knows how long a draw takes.** The canvas reports
each one as it lands and the queue follows; there is no step interval to keep
equal to the draw's own constants. That is what the pacing above replaces — a
`STEP_MS` floor that had to be kept in step with three numbers in another file
by hand, and was wrong the moment any of them moved.

An opening therefore needs no clock of its own. It presses the first taxon,
queues the rest, and watches for the queue to drain before it pays its answer.
Any interaction ends it at the _finished_ tree: the reader interrupted the
telling, not the argument.

Implementation: React Flow edges are SVG paths — use `getTotalLength()` with
`stroke-dasharray` / `stroke-dashoffset`. Decay is a separate opacity or filter
tween on the same element. The marks' entrance and bloom are CSS animations with
`animation-delay` off the same clock and `animation-fill-mode: backwards`, so no
timer decides when a mark becomes visible.

---

## Command surface

- **Every binding is a bare letter, and nothing holds a modifier**, with `/` the
  one exception. `/` opens search, `S` toggles the sidebar, `A` adds a taxon, `F`
  fits (`⇧F` fit selection), `I` isolates, `N` steps to next species (`⇧N`
  previous), `L` cycles labels, `D` flips dates, `B` the light, `R` adds a
  random species, `C` clears, `E` fills the screen. The three canvas modes hold
  the letters that name them. `T` is unclaimed — it switched the time scale, and
  nothing took it when the second scale went. Shift is the _variant_ of a
  binding, never a second one. `web/src/chrome/bindings.ts` is the one table;
  `matchKey` refuses any press holding ctrl, meta or alt.
- **`/` opens search**, matching what `/` does everywhere else. It is the root of
  the command surface.
- **`Tab` is the browser's and is not in the table.** It walks the chrome: the
  panel's switch, the search pill, the sidebar's contents top to bottom, the
  resize separator, the marks on the canvas, the detail card, the view cluster.
- **Every action has a command, a key, and a control.** Keyboard operation is
  first class and not exclusive; mouse is a convenience path, never required.
  `App.test.tsx` walks `bindings.ts` against the rendered palette so a control
  with no command cannot exist.
- Palette rows follow Raycast anatomy: icon · title · subtitle · right-aligned
  accessory metadata.
- **A species row's icon is its silhouette** — the same one the node will wear
  once it lands. A borrowed image from a kingdom-sized ancestor is suppressed
  (the canvas rule); those rows keep the plain `◦`, as does a row whose
  silhouette is not yet mirrored — the slot never blinks empty.
- Fuzzy search with highlighted match ranges. Results rank on recency and
  frequency, not alphabetically.
- A node's own actions are a **contextual section** of the palette, not a
  separate mode.
- **A fossil clicked in the drill-down lane opens its card**, the same `sel=` as
  clicking a mark. The card carries the range, the occurrence count, the
  encyclopedia entry, the drawing's credit, and its own draw/remove control and
  links. The lane stays open beneath the card.
- The search field carries a breadcrumb chip for the current filter; backspace
  at position zero pops it. **The species filter (`S`) is the only chip.** It
  drops commands and fossils from the list entirely. Inside the palette it is
  also reachable by typing `s` then space — live only on an empty field.
- **There is a way in that does not require having thought of a species.** The
  empty canvas is an **openings carousel** — one question at a time, taxa
  previewed as silhouettes, auto-advancing until the reader takes control. `R`
  adds a random species, drawing only from taxa that carry a silhouette of their
  own. **One press in five draws from the fossil record instead**, and that pick
  also adds the clade it hangs below when the canvas lacks it; an empty fossil
  roll falls through to a species silently.
- **A command row is a title and a subtitle and nothing more.** There is no
  longer sentence behind it: what a row cannot say in a subtitle belongs on the
  card or in the about page, where a reader goes looking for it.
- Inline keybind hints on every row, from the same table the buttons read.
- **Every control lives in the sidebar**, in the order a session takes them:
  wordmark (the door to the about page), the way in, what is on the canvas, how
  it is drawn, then the things done once building has stopped. An action that
  cannot run right now is **disabled, never hidden**, and is `aria-disabled` (not
  `disabled`) so it keeps its place in the tab order.
- **Sections are captioned in small-caps mono.** `TAXA` carries a count, absent
  at zero.
- **The way in is a pill that hangs out over the canvas**, spanning the panel
  and ending in a round cap under the panel's toggle. Shut, that cap is all that
  remains. It **glows** — the one piece of chrome that does apart from the light
  — steady, never breathing.
- **It is a button styled as a field, not a field.** No rotating placeholder
  hint; the palette opens on ten pressable examples instead.
- **The Taxa list is the layers panel.** A row is a target that never moves and
  says the whole name; clicking one does what clicking its mark does. The add
  row is at the top and is a row.
- **Two clusters stay on the canvas corners.** Top left, the panel's switch (it
  rides the panel's edge and stays put when the panel goes). Top right, fit,
  isolate and fullscreen — the controls that act on the viewport. The top-right
  cluster fades after four still seconds; the panel's switch does not.
- **`step` has no button; it keeps its key (`N`) and its palette row**, since the
  panel now draws every mark as a row.
- **Below `DOCK_W` (940px) the panel floats rather than docking** — an overlay
  with a scrim, starting shut, leaving a strip of canvas beside it.
- **The one link off the empty canvas carries an arrow**, quiet and deliberately
  not the accent (`.carousel-go` is the one lit mark there); it borrows the
  link's colour and moves under the pointer.
- Confirmations are brief HUD toasts. **One dialog exists**: clearing the canvas
  asks first, because it is the only action that can destroy an hour of work.

---

## Canvas

- Near-black base (#0A0A0B–#101012). Faint grid in the void, no parallax.
- Traces are luminous: 1–2px core with a soft additive bloom halo.
- Selected path burns bright; unselected lineages recede to dim and desaturated.
  Contrast does the wayfinding, not labels.
- Nodes are small luminous points that bloom on hover and focus.
- **A taxon still living is an arrow into the present, in the dot's own
  footprint.** x is time and runs right, so the shape is the lineage continuing
  past the last thing we can date. Fill means _you chose it_, the double ring
  means _MRCA_; this channel says _is it still here_.
- **It rides on chosen taxa only, and reads extinction off the tier.** A
  divergence is a moment and keeps a plain dot. `occurrence` is the tier applied
  only where nothing below the node is alive.
- **A label is three rows: rank, name, age**, each on its own line so the label
  is as wide as its widest row, and each pinning its own font-size and
  line-height so the placement pass can predict its height. The age never rides
  on the name's line.
- **The age row is `age_ma` and nothing else.** It is a divergence age, so a
  taxon drawn at the present has no figure — "present" is a position, not a
  quantity, and marks the taxon instead.
- **The dash key is stated bottom-left over the canvas, on the shelf above the
  ruler** — one line of flat text at the axis's size, riding `--axis-h` plus any
  open drill lane. A key, not an explanation (the sentences live in the node
  card). It names only the patterns actually drawn, so a fully dated tree shows
  no key. It is not a panel.
- **There is one time scale, and it is proportional.** No switch, no second
  ruler, no knee. A symlog view was offered beside it for a long time — linear
  to 1 Ma and logarithmic above, so a hominin divergence and the Cambrian could
  share a screen — and it was removed: a reader who has to ask which scale they
  are on cannot read a position off the axis at all, which is the one thing the
  axis is for. Room for recent splits is bought by zooming, which is honest
  because the ruler zooms with it.
- **The fit gives time as much room as the frame has, up to roughly square.** A
  tall selection makes a tree far taller than it is wide, and a transform can
  only shrink it into a strip down the middle of an empty frame. So the fit
  re-lays the tree out instead: it solves the plot width whose tree matches the
  frame's shape (`plotWidthToFill`) and reframes, with a screen-px margin on
  every side so the outermost labels never sit flush against the window. The
  plot has hard bounds — `MIN_PLOT_W` for legibility, six designed widths at the
  far end — and between them the tree, not the zoom, absorbs the difference.
- **A tree is drawn to a shape, not to a display.** The frame is a letterbox and
  a large one is a long letterbox, so matching it exactly draws a handful of
  leaves as lines the width of the desk with two thirds of the canvas empty
  under them. `MAX_FILL_ASPECT` stops the fill at roughly square: a frame
  squarer than that is still matched exactly, a wider one gets a tree of that
  shape, centred, and the surplus stays margin. What a selection looks like is
  then the reader's business and not their monitor's — the same tree on a laptop
  and on a 27" is the same drawing, larger. Trees with too few rows to reach it
  bottom out at `MIN_PLOT_W` and are as square as their own labels allow.
- **The stretch control sits at the ruler's right end, on the thing it
  rescales.** Two small presses — arrows meeting, arrows parting — that give
  time less or more room than the fit chose. A press redraws the tree at the new
  width and reframes at once; the preference is kept as a *bias on the fill*, so
  the next fit, resize or add solves "the fill, times what the reader asked for"
  rather than solving the press away. At the end of its run a press is disabled,
  not swallowed. The glyphs carry the strip; `aria-label` carries the words.

## Hit targets

**The pointer follows the ink.** What is painted is what can be clicked; a gap
between painted things belongs to whatever is drawn underneath it.

- **A label selects its node — the whole label, not the dot.** The name, rank row
  and silhouette are the target; the dot alone is 10px. `onNodeClick` fires for
  any pointer-taking descendant of the React Flow node wrapper, so this is CSS.
- **The transparent parts of a label box do not take the pointer.**
  `pointer-events` is granted to `.mark-text` and the silhouette, never to
  `.mark-label`. `.mark-text` is also exactly the rectangle the crowded scrim
  paints.
- **A label may cover a trace, and where it does, the label wins.** The placement
  pass tests every candidate against the traces, so this only arises when nothing
  is clear. A trace losing one box keeps every other point along it.
- **The placement pass reserves 5px either side of a trace; the click target is
  8px**, so a legitimately-placed label can sit inside a trace's hit stroke. It
  narrows the segment there and never blocks it.
- **A silhouette's target is the box the layout reserved, not the box the
  transform paints.** `--icon-scale` grows the drawing as the canvas pulls back;
  a counter-scaled overlay pins the target to the reserved box. At every zoom of
  1:1 or closer the scale is 1, so drawing and target are the same box.
- **Every target belongs to exactly one node.** Selecting a neighbour is worse
  than a missed click, because a wrong selection looks like an answer.
- **Dimmed is not disabled.** Unselected lineages recede to 0.26 opacity, and
  clicking one is how a reader focuses it.
- **A silhouette carries a name, not a caption.** What an inherited drawing
  depicts — the smallest clade holding both node and picture, and its size — is
  the picture's `aria-label` and the card's watermark. It is never drawn beside
  the mark and never appears on hover.

## Nothing explains itself on hover

- **There are no tooltips, and there is no `title` attribute.** A test enforces
  the second; the first is a decision about how much this app is allowed to say
  unasked. The native tooltip cannot be styled, arrives late, cannot be
  dismissed, never appears on touch, and is placed against the pointer rather
  than the control — and the app's own version, which fixed all of that, was
  worse in the way that mattered: it put a paragraph over the graph every time
  the pointer crossed a picture. The SVG `<title>` child is banned with it.
- **A control says what it does by being drawn well.** A glyph that needs a
  sentence is a glyph that needs redrawing, or a control that needs a caption
  printed beside it — the doors, the mode chips and the palette rows all carry
  their words on the face.
- **What genuinely needs a paragraph goes on the node card**, which is one press
  away and is the surface built to hold prose. The provenance disclosure there
  is where the caveats live.
- **An unavailable control keeps its place** — `aria-disabled`, not `disabled`,
  so it stays focusable and in the tab order.
- **Screen readers still get the words.** `aria-label` on every glyph-only
  control and on every drawing that makes a claim. That is a name, not an
  explanation, and it is never rendered.

## Layout

- **One column on the left holds every control; the canvas gets everything
  else** — the timeline flush along the bottom, the panel's toggle top-left,
  three viewport actions top-right, the detail card flying out from the right.
- **`--sidebar-w` is the whole contract.** The canvas is inset by it and
  everything drawn on the canvas is positioned inside it. It must be written
  before the first paint.
- **The tree does not move when the panel does.** At the fit the canvas refits
  into its new size; off the fit the viewport takes the opposite shift and the
  picture stays where it was.
- **The panel is one fixed width, collapsible, and not draggable.** The toggle
  already trades panel for canvas — instantly, reversibly, from the keyboard.
- Deterministic hierarchical layout. Positions computed, never simulated.
- **No force-directed layout.** Non-deterministic and destroys the reading of
  ancestry. Nodes are not user-draggable.
- **A row belongs to a lineage that ends there.** A node with rendered
  descendants sits _on_ the lineage that continues past it, at the midpoint of
  its children — even when chosen by name. The single exception is a branch with
  no length on the axis, where the parent keeps a row and the trace becomes a
  visible drop. **No ladderizing by clade size** — rows ascending `idx` (preorder)
  are what make adding a species insert in place rather than permute the canvas.

## Edges

- Orthogonal routing, small consistent corner radius. No bezier.
- Stable lane assignment; a lane keeps its hue across renders.
- Uniform stroke weight. Encode meaning in luminance and hue, never width.

## Zoom

- **Zoom is scale and nothing else.** A mark renders the same rows at 0.12 as at
  3.0; only their size changes. Semantic zoom is gone — nothing load-bearing may
  hang off a threshold the fit can cross on its own.
- Which label rows are drawn is chosen by two controls, not by zoom: the **age**
  is a row a reader can spend, because x is time and there is a ruler under it, so
  ages switch separately from the words. The **rank** does not switch — it is what
  says a derived name is derived, and a control whose only honest setting is on
  is not a control.
- `F` fit all · `⇧F` fit selection · `I` isolate path to root.

## What a label says

Four controls in the sidebar's **Canvas** section, one set: **things that change
how the canvas is drawn rather than what is on it.** The Taxa list above owns the
other half of that split.

**They are drawn as one panel, not as chips**, sharing a `subgrid` so caption and
switch line up down a column of fixed width:

- **No border, and the rows line up down a column of fixed width.**
- **The caption stacks above its own switch**, on its own line.
- **The caption is not one of the options** — it is small-caps mono, and the
  options sit in a **recessed track** so the boundary of what is pressable is
  visible before the words are read.
- **The switches are one width, the narrowest available.** An option grows from
  its own word (`flex: 1 1 auto`), so the three-option row sets the common width
  (164px) and the two-option rows spread into it. Horizontal padding is 6px.
- **The panel clears the epoch band.**
- **It is not a card and does not announce itself.** No border, no fill; 0.9
  opacity until hovered or focused; the chosen option is `--ink-2` on the
  faintest well that still reads as a container. Recession belongs to the ink
  ramp, whose four rungs each clear WCAG AA on `--void` (16.7, 9.6, 7.6, 6.0).
- **A choice away from the default is not lit, and exactly one control is.**
  **Bioluminescence is the exception**: it glows in the mode's own cyan, because
  glowing is what it does and the chip is the only preview of the mode.
- **The set is drawn at every width**, and behind the panel's own toggle below
  `DOCK_W`.
- **labels: off · common · scientific**, with **common the default** and in the
  middle. The audience is curious people rather than biologists, so `Human` tells
  a stranger what they are looking at where `Homo sapiens` tells a specialist
  what they knew. Ordered by how much each takes away from the canvas; `L` walks
  the segments left to right.
- `off` is a real state — the marks, traces and silhouettes stay; the words go.
- **common names are for genus, species and subspecies only**, and are the name
  ranked _first_ by use (see `name-ranking.md`). Above genus a common name names
  a group rather than a kind of animal. Enforced in the server and again in
  `markName`.
- **The canvas is mixed in common mode and that is the design.** 110,794 nodes
  of 2,725,682 carry an English name, so most of a deep tree falls back, and a
  divergence falls back more often than a leaf. **Italics say which**: a
  scientific name is italic at genus and below, a common name never is.
- **ages: on · off.** On by default.
- **None of the three is in the URL.** They join bioluminescence in
  `sessionStorage`, per-tab: everything in the link is a claim about taxa, and
  these are claims about the reader. A shared link would otherwise impose one
  person's habits and could open on a canvas of unnamed dots.
- `L` cycles labels, `D` flips dates, `B` the light. Cycling is legible on `L`
  because the chip beside it shows where the press landed and what the next one
  will do.

## The detail card

The only surface in the product that is _read_ rather than scanned. Opened by a
click, closed by `esc`.

**Selecting a taxon pans the canvas and never zooms it.** A click on a mark or a
Taxa row says which taxon the reader is looking at and nothing about the scale,
so the scale survives it: read the card, click the next name on it, and the tree
is still where you put it.

**And the pan is rare, because there is a band.** The viewport moves only when
the subject is not _comfortably_ in view — inside the free region but hard
against its frame counts as not comfortable — and then only far enough to seat
it inside that band. This is `scrolloff`: vim's, and the margin an editor keeps
between the caret and the edge. Both alternatives are worse. Revealing against
the free region alone fires for a mark a pixel outside and not one a pixel
inside, then leaves it flush against the frame with its branch cut in half.
Centring on every click moves the tree half a screen to answer a click on
something already visible.

**The card never covers what it is about.** It flies out from the right-hand
edge, opposite the sidebar, and the free region the band is taken from excludes
its footprint — so a subject under the card is uncomfortable by definition and
gets moved out.

**Its footprint is still an edge to a _fit_.** `F`, an add, a resize — anything
that reframes the tree deliberately — frames into what is left beside the card,
exactly as when the window narrows. That is refused where too little canvas is
left for a legible tree. What a selection changed is only _when_ the reserve is
taken: taking it re-lays out the tree, and a selection is not a request for
that.

Its order is the design:

1. **The silhouette**, watermarked with what it is actually of when that is not
   this taxon.
2. **The scientific name**, then the common name under it, then the rank. Under,
   not instead of — the canvas label, palette row and URL all identify a taxon by
   its scientific name. An unranked clade shows no rank rather than "no rank".
3. **One control: put it on the canvas, or take it off.** One button in two
   states, directly under the name.
4. **A description**, from Wikipedia, clamped to seven lines with the rest one
   click away, credited and linked. Fetched when the card opens; the card is
   complete without it.
5. **The classification** — the major Linnaean rungs present, the absent ones
   named rather than skipped, and the complete named ancestry folded into a
   disclosure as one wrapped chain.
6. **The figures** — age, ranges, counts, identifiers. Mono, right-aligned.
7. **The other names** it goes by.
8. **"Sources and caveats"**, collapsed: every caveat about tier, placement and
   what the picture depicts. **Each caveat names a source and a method and calls
   nothing a guess** — _not specified in dataset X, so it was placed by method Y_:
   the Duke et al. chronogram carries no date for this node; the Open Tree
   synthesis has no lineage for this fossil; PhyloPic has no drawing of this
   taxon. Where a node's position is spread between two dated relatives, the card
   names both (both are links). Where the nearest dated relative is at the present,
   it says the chronogram covers living species only.

**Provenance is secondary and identity is not.** What decides which side of the
disclosure a sentence falls on is whether it tells the reader what the thing
_is_. A divergence's derived name — "the last common ancestor of X and Y" — is the
only name an `mrcaott…` node has, so it stays on the face of the card.

**Every name on the card that names a taxon opens that taxon's card**, so the
card is the second navigation surface. Three rules:

- **A link goes to what the name names.** A witness opens a _fossil_ card, not the
  clade it hangs below.
- **Selection does not require the thing to be drawn.** Most of these ancestors
  are suppressed from the induced subtree; the card opens on them anyway, and the
  control at the top puts them on the canvas.
- **A link with nothing to point at is plain text**, never a dead control.

A link is a dotted underline in the surrounding ink, not an accent colour, since
most of the nouns are clickable. The two real anchors — Wikipedia and the licence
— leave the app and look different because they do.

## Motion

- Motion preserves object identity across state changes and rewards the add
  action. Nothing animates purely for delight.
- Spring physics, interruptible, 200–300ms for reflow.
- Bloom intensity animates on selection change. No slide, no scale-bounce.
- **The flare is written in `drop-shadow`, not `box-shadow`**, so it fits every
  shape a mark can be; its size animates as `scale`, not `transform`.
- Enter/exit is fade plus draw-on. Never slide.
- Respect `prefers-reduced-motion`: cut to final state, keep glow static.

## Waiting

Everything the API serves is immutable within a build and memoised for the
session, so most requests answer in the frame the click happened in and the
default rendering of a wait is nothing at all. The failure mode is chrome
flashing over facts the app already holds.

- **A sentence, never a spinner.** `.pending` is a dim line of text, breathing on
  a 1.8 s cycle, naming _what_ is being waited for. **One number, not two** — the
  reader has no use for the "N species and M fossil taxa" seam.
- **The number is `SPECIES_PHRASE`, the count of `rank='species'`** — not the node
  total (a third are groups) and not the tip count (includes subspecies and
  group-rank terminals). Every surface reads `corpora.ts`, and `corpora.test.ts`
  refuses any hardcoded "N million species" outside that file.
- **No skeletons.** A grey bar predicts a shape and a wrong prediction reads as
  the layout settling.
- **Delayed by `PENDING_DELAY_MS`, and the delay is the component's.** `usePending`
  in `web/src/chrome/Pending.tsx` is the only place a wait becomes visible; a
  cached node, a warm search and a reopened lane say nothing.
- **A pending state is never a denial.** "No results", "no fossils on this branch"
  and an empty card are _answers_, reachable only from a settled request.
  `emptyState` in `Palette.tsx` and the branch order in `DrillLane.tsx` enforce
  it; `empty.test.ts` is the invariant.
- **Stale content is dimmed, not cleared.** Dim says _these answer the previous
  question_. The exception is anything whose stale version is plausible: the
  detail card is replaced by a placeholder, because a confidently-numbered card
  about the wrong animal does not look wrong.
- **`role="status"`** on every pending line.

## Typography

- One geometric or grotesque sans for UI. One mono for identifiers, coordinates
  and all numerics.
- Two weights maximum. Hierarchy from size, opacity and glow — not weight.
- Labels never rotate. Truncate with ellipsis before you tilt text.
- Numerics are tabular-figure mono.
- **The age slot holds figures. Its two non-figures are marks, not words.** A
  node label says "96 Ma", "≤ 96 Ma", a fossil range, or nothing; `fossils`
  before a range and `present` where there is no number are an ammonite and a
  clock, stroked at 13px in `web/src/canvas/AgeGlyph.tsx`.
  - Stroked, never filled: a filled shape beside a node is a silhouette.
  - Beside a node drawn at 66 Ma, a bare "84–66 Ma" reads as that node's age —
    the one thing the `occurrence` tier exists not to imply — so the range never
    renders without the mark. `markAge` guarantees this.
  - The words survive as each mark's accessible name, and the node card spells
    both out in full.
  - Running prose is unaffected: the drill-down lane writes "382 Ma – present".

## Color

- Monochrome dark base. Cool accent for selection and focus.
- Lane hues are a tight, low-saturation cool set — distinguishable, never candy.
- Light theme is out of scope. This is a dark-only instrument.

## Density

- Assume the user wants more on screen, not less. Tight spacing scale.
- Hairline borders at low opacity. No drop shadows for hierarchy — use glow and
  background steps.
- Chrome auto-hides. The canvas is the page.

## State

- **The tree is URL-encoded; how you are reading it is not.** Any tree is a
  shareable link — the selection, isolate and drill all ride in it. The
  labels, ages and light are `sessionStorage`, per-tab, because a setting that is
  a claim about the reader may not travel in a link.
- Full keyboard operation: search, add, remove, clear, fit, isolate and step
  through selection are all bound.

## The tab

- **The icon is the MRCA mark**: a bright core with a ring standing off it, on the
  void, in the accent — `NodeMark.tsx`'s `is-mrca`, a filled dot then `0 0 0 3px`
  of the same hue at low alpha. Concentric circles are the shape that survives
  16px; a branching fork becomes a `<` there.
- **The void is baked in, not transparent**, because a thin cyan ring on a white
  light-mode tab strip is not there at all.
- **The gap between core and ring is the shape** and stays empty. At 16px the ring
  is 1.3px and the gap 2px; the bloom is drawn outward from the ring.
- `web/public/favicon.svg` is the design; `scripts/make-icons.py` generates the
  `.ico` and touch icon from the same geometry. `web/src/icons.test.ts` pins the
  generator and palette to the SVG, and `make-icons.py --check` pins the
  committed bytes to the generator.

## The share card

Every view is a URL and the sidebar copies it, so a link is how anyone arrives
who did not type the domain. It unfurls via `web/index.html`'s metadata and
`web/public/og.png`.

- **The card is the fork the icon could not be.** At 1200×630 it draws what the
  product does: four lineages running toward the present, converging through two
  divergences onto one bright common ancestor wearing the icon's mark at scale.
  Tab and card are one glyph from one script.
- **It is the instrument, not a picture of one.** Stroke weights, elbows, dot
  sizes, lane hues, the radial backdrop and the 56px lattice are `styles.css`,
  `layout.ts` and `TraceEdge.tsx`'s own figures at a single scale. `meta.test.ts`
  pins the card's hues to `LANE_HUES`.
- **No word and no number on the image.** Every surface prints `og:title` and
  `og:description` beside it; text on the card would go stale silently and a
  figure would break the rule that the app prints no age it cannot stand behind.
- **Every branch is solid.** The dash channel means "the chronogram carries no
  date"; a card that claims no dates has nothing for it to be about.
- **The tags are static, deliberately.** A per-selection card would put a
  container hop on the critical path of a cold human load and needs a render path
  the layout, labels and silhouettes do not run today.
- **`robots.txt` is a real file**, because `not_found_handling:
single-page-application` would otherwise answer it with the app shell at 200.
  There is one page to index — every view is `/?sel=…` of one shell — which the
  canonical link says, and why there is no sitemap.

---

## Explicit non-goals

- Not Mermaid. Not a static diagram renderer.
- No glassmorphism, no gradient meshes, no ambient background animation. The glow
  comes from the data, nowhere else.
- No onboarding overlays, and no _decorative_ empty state. Everything on an empty
  canvas must be a live control over real data — which the openings carousel
  meets.
- No settings panel that duplicates something a command already does.
- No warm-orange heatmap palette.

## Stack

React Flow / xyflow v12 for interaction and edge rendering, with positions driven
by our own layout pass and node dragging disabled.

Bloom via a post-process pass or layered blur — verify cost early and drop to flat
strokes at low zoom if it costs frames. Frame budget beats glow every time.

Move to Canvas 2D or WebGL if React Flow's DOM overhead becomes the bottleneck.
