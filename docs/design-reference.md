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
  `N` steps to the next species, `T` switches the time scale, `L` cycles the labels, `A` the ages,
  `B` the light, `R` adds a random species, `C` clears. The four canvas modes
  hold the letters that name them, which is why the time scale is on `T` and no
  longer on `L`: `l` names the labels, where it only ever named one of the two
  scales it toggled between. Shift is the *variant* of a binding and never a
  second one, so a reader who learns `F` has already guessed `⇧F`. A variant is only earned
  where the two halves are the same action pointed at different scopes: `⇧R`
  drew a random *fossil* until the two corpora became one search, and it was a
  variant of nothing — the two picks differed in which catalogue the animal was
  filed in, which is not a thing a reader knows before pressing a key.
  The rule this replaces was a running negotiation with the browser — `⌘L`
  reaches the URL bar and cannot be prevented, `⌘F` is find, `⌘R` is reload —
  and every mnemonic that survived it was shifted twice and wrong. The canvas
  has no text entry, so the letter keys are ours and the chords stay the
  browser's. `web/src/chrome/bindings.ts` is the one table; `matchKey` refuses
  any press holding ctrl, meta or alt, which is what keeps that promise.
- **`Tab` is not a letter and is not in the table.** It held `step` until it was
  noticed that the handler prevents the default of everything it matches, which
  meant the focus ring never moved and no button in this app could be reached
  without a pointer. "Keyboard operation is first class" was true of the
  *commands* and false of the controls, and the two were being claimed in one
  breath. Stepping is `N` now (`⇧N` back) and `Tab` walks the chrome: the marks
  on the canvas, then the mode panel, the scale, the axis links, the detail card,
  the control bar.
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
  have a name in mind, and nobody browses millions of them. `R` adds a
  random species, for a reader who wants the corpus rather than a curated
  question. It draws only from taxa that carry **a silhouette of their own**,
  which is the whole of the design — a uniform draw returns an unnamed
  `mrcaott…` clade or an undescribed mite, and a surprise that is usually
  nothing to look at is one a reader stops pressing. **One press in five draws
  from the fossil record instead**, and that pick also adds the clade it hangs
  below when the canvas has not got it, because otherwise its usual outcome is
  a refusal notice for something nobody chose by name. A fossil roll that comes
  back empty falls through to a species without saying so: the reader asked to
  be surprised, not for a report on a corpus. `fossil-grafts.md` §9 is why
  there is no second key. Copying a shareable link lost its key in the same
  change that made the letters bare and kept its command — `s` and `l` are the
  two most used letters in the app, and share is the one action nobody reaches
  for mid-flow.
- **A command row may carry a tooltip its subtitle cannot hold.** The subtitle
  is one line in a fixed-height row; a caveat that needs a sentence — what a
  pick is drawn from, what it will do to the selection as a side effect — goes
  in `Command.hint`, which a reader can go looking for and never has to read
  past. It does **not** fall back to the subtitle, and used to: the subtitle is
  printed two lines under the pointer, so the fallback fired on every row in the
  list to repeat text already on screen.
- Inline keybind hints on every row, from the same table the buttons read.
- **The control bar is on the top edge**, under the same fade-to-void the axis
  uses, not a pill and not a panel. The two questions split by edge — the top
  says what you can *do*, the bottom says how to *read* what you see. It
  auto-hides with the rest of the chrome and comes back on hover, because a
  faded control is still a control. An action that cannot run right now is
  **disabled, never hidden**: a bar that reshuffles as the selection changes
  costs the reader the button they were already reaching for, and the tooltip
  on a greyed one says what would make it work.
- **The bar's buttons are grouped, and a group wears the mode panel's
  anatomy** — a small-caps mono caption over a recessed track. It is the same
  argument three free-floating chips lost above the axis: a reader has to see
  where the pressable thing starts *without reading any of the words in it*,
  and a row of bare buttons on scrim gave them nothing to see. Four groups.
  **Concestor** carries the app's own mark and the one door that reaches every
  other, because a palette is not a feature and the honest caption over it is
  the product. **Add species** holds `S` and `R` as **search** and **random** —
  the caption is the action and the two buttons are the two ways to take it,
  where they used to read "Species" and "Random", which spent both words on the
  noun and neither on the difference. **Canvas** is fullscreen, clear and share,
  opposite corner, paired on acting on the whole of it rather than on anything
  selected in it — the two one-way members stay adjacent at the far right, and
  `E` **fullscreen** leads because it is the reversible one and a pointer landing
  on the near edge of that group should not find `clear` there. It is the second
  button whose word is not the word its letter came from, after `P` **commands**:
  a badge teaches the key, a label teaches the action, and *expand* named the
  gesture on a canvas where expanding already means something about a clade. **Navigate** takes the second
  row: fit, isolate, next are how you look at what you built, which is what you
  reach for after there is something to look at.
- **A control keeps its word at every width the bar is drawn at.** There was a
  narrow layout once — below 720px the labels went and the badges stayed, on the
  argument that `ADD SPECIES` over `S R` still names the group. What it shipped
  was a row reading `S R C F / Tab`, in a window that is far more often a laptop
  than a phone, asking a reader to know the table the bar exists to teach them.
  Share then needed an exception to avoid being a button with nothing in it, and
  the exception is the tell: the rule was hiding the only thing every control
  has. The bar has **one** width rule now and it is a swap rather than a
  shortening — see the next bullet. Between 620 and 720 it wraps to a second
  row, which costs a row of pixels and no meaning.
- **Below 620px there is no chrome but one round button.** The bar, the
  canvas-mode panel and the scale switch are all gone, and a 54px circle
  wearing the app's mark sits bottom right, above the timeline and under a
  thumb, opening the palette. It is a swap and not a removal, and what makes it
  one is a rule this app already kept: every control has a command, and the
  palette's own field searches every species in the tree as well as the command list,
  so nothing is behind two taps that was behind one. What it buys is the
  canvas — at 375px the bar is two wrapped rows and the panel is a stack in the
  corner, over a tree with about 500px of height to draw itself in, and every
  one of those controls is a target sized for a mouse being hit by a thumb.
  **One thing is genuinely lost and it is the right one**: `step` has no
  command, because stepping a selection with no keyboard to step from is
  meaningless. The button also carries the post-opening invitation, since the
  bar that would otherwise pulse is not on screen. **The empty canvas's key
  column goes at the same width and for the same reason** — three badges naming
  presses a thumb cannot make — which leaves *Learn more about Concestor*
  centred on its own as the last line of that screen, with no rule beside it to
  divide it from anything.
- **The one link off the empty canvas carries an arrow.** It was a hairline, a
  line of prose and nothing else, which is the failure the openings card already
  had before it was given a border, except here there is not even a box to
  notice. The arrow is quiet and deliberately *not* the accent: `.carousel-go`'s
  is the one lit mark on that canvas and there may only be one, so this borrows
  the link's own colour and earns its difference by moving under the pointer.
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
- **A taxon still living is an arrow into the present, in the dot's own
  footprint.** x is time and it runs to the right, so the shape is the lineage
  continuing past the last thing we can date rather than a symbol for aliveness.
  The footprint is not a detail: the margin right of a terminal mark is where
  its label goes, and on an internal node an arrow beside the dot would lie
  along the branch leaving it. Fill and glow stay orthogonal — filled means *you
  chose it*, the double ring means *MRCA*; this channel says *is it still here*.
- **It rides on chosen taxa only, and reads extinction off the tier.** A
  divergence is a moment and a moment is neither alive nor extinct, so a fork
  keeps a plain dot — the same line that gives a chosen clade its exemplar and a
  fork its witness. `occurrence` is the tier applied only where nothing below
  the node is alive, and so the one place a node's extinction is recorded.
- **A label is three rows: rank, name, age.** Each on its own line, so the
  label is as wide as its widest row rather than the sum of them, and each
  pinning its own font-size and line-height so the placement pass can predict
  its height. The age never rides on the name's line — on a left-hand label
  that line is right-aligned, so the figure takes the space nearest the mark
  and pushes the name away from the thing it names.
- **The age row is `age_ma` and nothing else.** It is a divergence age, so a
  taxon drawn at the present has no figure for it: "present" is a position, not
  a quantity, and whether something is still alive is a fact about the taxon.
  That fact marks the taxon instead.
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
  canvas fully pulled back, 2,249 points sampled along every drawn trace:
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

## Tooltips

- **The app draws them; `title` is banned and a test enforces it.** The native
  tooltip cannot be styled, arrives about a second late, wraps where the
  platform chooses, never appears on a touch screen, cannot be dismissed, and is
  placed against the *pointer* rather than the control — which is how a switch
  in the bottom-left corner came to explain itself across the timeline. The SVG
  `<title>` child is the same thing by another route and is banned with it.
  `chrome/tip.ts` and `chrome/Tooltip.tsx` are the implementation and
  `tip.test.ts` is the census.
- **A tooltip is a sentence.** Two where the second is a caveat whose absence
  would cost the reader their trust in the canvas — "Nothing about the data
  changes" on bioluminescence is the case that earns it. What needs a paragraph
  needs the about page. The measure is capped at 260px for the ordinary reason:
  past roughly 45 characters a line the eye loses the return sweep, and this is
  read once, quickly, beside whatever the reader was already doing.
- **It answers "what will pressing this do", never "why is it built this way".**
  The second question is what the component headers and these docs are for, and
  a slot that costs nothing to fill will otherwise fill with it.
- **It never repeats what is already on screen.** A tooltip echoing a visible
  subtitle is noise wearing the costume of help.
- **It goes towards the middle of the window**, away from whichever edge its
  trigger is pinned to — not "below, flipping up when it does not fit", which
  fits happily on top of the timeline.
- **An unavailable control keeps its explanation.** That means `aria-disabled`
  rather than `disabled`, because a disabled button fires no pointer events and
  takes no focus, and the sentence saying what would make a button work is the
  most useful tooltip on the bar.

## Layout

- Deterministic hierarchical layout. Positions computed, never simulated.
- **No force-directed layout.** Non-deterministic, wobbles between loads,
  and destroys the reading of ancestry. Not negotiable.
- Layout pass via d3-hierarchy / ELK / dagre. Nodes are not user-draggable.
- **A row belongs to a lineage that ends there.** A node with rendered
  descendants sits *on* the lineage that continues past it, at the midpoint of
  its children — even when the reader chose it by name. A chosen clade given a
  row of its own is drawn above the animal it contains, because rows go out in
  preorder and preorder puts the ancestor first. The single exception is a
  branch with no length on the axis, where parent and child would otherwise
  share a pixel; there the parent keeps a row and the trace becomes a visible
  drop. **No ladderizing by clade size** — rows ascending `idx` are what make
  adding a species insert in place rather than permute the canvas.

## Edges

- Orthogonal routing, small consistent corner radius. No bezier — curves
  make convergent branches ambiguous.
- Stable lane assignment; a lane keeps its hue across renders.
- Uniform stroke weight. Encode meaning in luminance and hue, never width.

## Zoom

- **Zoom is scale and nothing else.** A mark renders the same rows at 0.12 as
  at 3.0; only their size changes.
- **Semantic zoom was tried here and removed.** Three tiers — mark and
  silhouette → + rank and name at 0.55 → + age at 0.62 — and it was the wrong
  instrument for this canvas. Zoom is how a reader *looks* at a tree: pulling
  back to see the whole shape is the most ordinary thing they do, and it took
  every name with it, while reading one name meant zooming until the tree no
  longer fitted. Neither was ever asked for.
- It also hung meaning off a threshold the fit wanders across. The age tier sat
  at **1.15** and the fit lands at 1.144 for six species, so *adding a sixth
  species* silently stripped a row from every label on screen. The rule worth
  keeping from all of it: **nothing load-bearing may hang off a threshold the
  fit can cross on its own.**
- What survives is the *ordering* the tiers had right, now as two controls
  rather than one axis. **The age is the row a reader can spend**, because the
  canvas already states it another way — x is time and there is a ruler under
  it — where everything else on a label is unavailable anywhere else on screen.
  So the ages switch separately from the words. The rank does not: it is what
  says a derived name is derived, and a control whose only honest setting is on
  is not a control.
- `F` fit all · `⇧F` fit selection · `/` isolate path to root.

## What a label says

Three controls on the bottom-left edge, above the axis, one set: **things that
change how the canvas is drawn rather than what is on it.** The control bar at
the top owns the other half of that split.

**They are drawn as one panel and not as three chips**, and the anatomy is worth
stating because the first version got all three parts of it wrong:

- **One border, and two columns the rows share.** Each control drawing its own
  border made a set look like clutter: three widths, three left edges, and the
  columns inside them starting at three different x positions. The rows share
  the panel's grid through `subgrid`, so the badges and the switches line up
  down the stack whatever the words are, and a row with no key leaves its cell
  empty rather than sliding left.
- **The caption stacks above its own switch**, on a line of its own. Given a
  column instead, that column is as wide as the longest word in the *set* —
  `BIOLUMINESCENCE` setting the indent of a row that reads `AGES` — so two of
  three rows carried a run of dead space and the panel was half caption. A line
  costs one row of 9px type and takes the panel from 322px wide to 217.
- **The caption is not one of the options.** Set in the same face as the
  segments it read as a fourth one — `labels off scientific common` is four
  words in a row and only three are pressable. It is small-caps mono, the
  vocabulary this app already uses for a field label (a mark's rank row), and
  the options sit in a **recessed track** so the boundary of what can be pressed
  is visible before any of the words are read.
- **The switches are one width, and it is the narrowest one available.** An
  option grows from its own word rather than from zero (`flex: 1 1 auto`), so
  the three-option row packs as tight as its words allow and therefore *sets*
  the common width — 164px — while the two-option rows spread into it. Sharing a
  width out equally instead (`flex: 1`) makes the widest word in a row set every
  option in it: `off` as wide as `scientific`, three times over, and a switch
  half again as wide as it needs to be. The horizontal padding is 6px because it
  is multiplied by six across the widest row.
- **The panel clears the epoch band.** Resting a control on the chart it
  annotates reads as one object.
- **It is not a card, and it does not announce itself.** It had a border, a
  filled background and `--ink` on the chosen option, which made it the
  brightest thing on screen — a lit rectangle in the corner of an instrument
  whose whole principle is *the graph is the only light source*. It has no
  border and no fill now, sits at 0.9 opacity until hovered or focused, and
  the chosen option is `--ink-2` on the faintest well that still reads as a
  container. Chrome here recedes; `.controls` along the top edge has done this
  from the beginning.

  **The fade was 0.62 and the recession is not its job.** Four surfaces rest
  under a container opacity — this panel, the idle control bar, the axis links,
  the scale switch — and each was multiplying an already-quiet ink rung by a
  second factor, which is what put this panel's own captions at 1.6:1 and the
  control bar's at 1.2:1. Recession belongs to the **ink ramp**: that is what
  four rungs are for, and every rung now clears WCAG AA on `--void` (16.7, 9.6,
  7.6, 6.0) so that the quiet register is quiet rather than absent. The four
  fades share 0.9 because that is the deepest multiply the floor rung survives.
  The rule this serves is unchanged — the graph reads at 11:1 and up, so it is
  still the only light source; the chrome simply stopped being invisible.
- **A choice away from the default is not lit, and exactly one control is.**
  Every chip used to take the accent when it left its default — a tinted row, an
  accent ring, accent type — and three of those at once is what made the corner
  shout, for a *setting*. The chosen segment already says where the control is;
  that the reader chose it rather than inherited it is not worth a colour.
  **Bioluminescence is the exception and stays the exception**: it glows,
  in the mode's own cyan, because glowing is literally what it does and the chip
  is the only chrome that can preview the mode before a reader commits to it.
  The `modified` prop went with the rule — two of three callers were carrying a
  flag nothing read.
- **The panel is not drawn below 620px**, and neither is the scale switch on the
  axis footer. All four members of this set go together with the control bar,
  replaced by the one palette button — see the command surface above. Shortening
  a control to fit a window it is absent from is not a trade, which is why the
  question of whether a chip can lose its caption stopped arising.
- **Nor is it drawn while the canvas is empty**, at any width. These three
  annotate marks, and with none on screen `labels` and `ages` are switches a
  reader can throw and watch do nothing — the failure the bar already refuses
  when it disables `fit`, `isolate` and `step` on that same canvas, and the
  palette by dropping `fit-all` from the list. Bioluminescence retints the
  chrome but its subject is the light the tree spills, and with nothing on the
  tree the water draws none of it. It is a swap and not a removal on the rule
  the narrow window stands on: `L`, `A` and `B` keep their rows, the palette
  keeps all three commands, and the settings sit in `sessionStorage`, so a
  reader who sets one has it waiting on the canvas the panel comes back to.
  What it also fixes is a collision: the empty canvas's block is centred and
  this panel is pinned bottom-left, so on a window roughly 620–860px wide and
  under about 880 tall the last key row — `P` · *Everything this can do* — was
  drawn through the `LABELS` chip. It arrived with the three-row key column and
  is on production. Reserving the panel's shelf in that block's padding was the
  alternative and is worse twice over — it moves the invitation up on every
  window to clear a panel beside it on none of them, and under about 735px of
  height the block, the bar and that shelf do not fit in the window at any
  centring. One flag drives both surfaces (`App.tsx`'s `nothingDrawn`), because
  a second expression meaning *nearly* "nothing is drawn" puts the badge back on
  the chip and reports nothing; `web/src/App.test.tsx` is what holds that, by
  rendering the app and asking whether the invitation and the panel agree.

- **labels: off · common · scientific**, with **common the default** and sitting
  in the middle. The default follows from the audience and nothing else: this is
  for curious people rather than for biologists, so `Human` and `Chimpanzee`
  tell a stranger what they are looking at where `Homo sapiens` and *Pan
  troglodytes* tell a specialist something they already knew. The formal name is
  one press away and is what a reader who wants it goes looking for. Ordered by
  how much they take away from the canvas, so the two things a reader might want
  next sit either side of where they land, and `L` walks the segments left to
  right — the chip is a picture of what the key does.
- `off` is a real state and not an absence of one — a tree read for its shape is
  a different reading from a tree read for its names, and the words are what
  make the first hard to see; the marks, traces and silhouettes stay.
- **common names are for genus, species and subspecies only**, and are the name
  ranked *first* by use (`docs/name-ranking.md`). Above genus a common name
  names a group rather than a kind of animal and the word's ordinary referent is
  usually something else — `bug`, `man`, `moth`. The restriction is applied in
  the server, which does not send one, and again in `markName`, which would not
  draw one.
- **The canvas is mixed in common mode and that is the design** — which is the
  cost of the default rather than an argument against it: it is free where there
  is no English name and pays where there is. 110,794 nodes
  of 2,725,682 carry an English name, so most of a deep tree falls back — and a
  divergence falls back more often than a leaf, because the derived name reads
  the *genus* off the suppressed run and 5,548 genera have a ranked name against
  99,960 species. **Italics are the channel that says which**: a scientific name
  is italic at genus and below, a common name never is.
- **ages: on · off.** On by default, since deep time is what the app is for.
- **None of the three is in the URL.** They join bioluminescence in
  `sessionStorage`, per-tab, and the line is what a setting is *about*:
  everything in the link is a claim about taxa, and these are claims about the
  reader — which name they read a taxon by, whether they want the figure, how
  they want light drawn. A shared link would otherwise impose one person's
  habits, and in the worst case open on a canvas of unnamed dots. The time
  scale stays in the link, because it is the scale the tree was *read* on.
- `L` cycles the labels, `A` flips the ages, `B` the light, and `T` is the time
  scale — moved off `L` when the labels wanted the letter it named better.
  Cycling is legible on `L` alone because the chip beside it shows where the
  press landed and what the next one will do.

## The detail card

The only surface in the product that is *read* rather than scanned. It was
described here as "the third zoom tier" while the canvas had tiers; it never
was one — it is opened by a click and closed by `esc`, and the zoom has nothing
to do with it.

**The card never covers what it is about.** It hangs in the top-right corner
over a canvas that used to measure itself against the whole window, so opening a
card on a mark near the present routinely hid that mark, its silhouette and its
name. On a desktop window the canvas now treats the card's footprint as an edge:
the tree reframes into what is left, timeline and all, exactly as it does when
the window itself narrows. Where that is refused — too little canvas to draw a
legible tree in, or a reader who has panned to a view of their own that
reframing would destroy — the viewport instead makes the smallest pan that
brings the subject back into the clear. `docs/handoff.md` §3 has the rules and
the two geometries they need.

Its order is the design:

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
8. **"Sources and caveats"**, collapsed: every caveat about tier, placement,
   and what the picture depicts.

   **Each of those caveats names a source and a method, and none of them calls
   anything a guess.** The earlier drafts explained the *drawing* — "no age is
   shown because none has been estimated", "nobody has resolved where its
   lineage branches" — which is a sentence about our predicament rather than an
   answer to the reader's question, and which invites them to distrust the
   branching when the branching is not what is missing. The form that replaced
   it is *not specified in dataset X, so it was placed by method Y*: **the Duke
   et al. chronogram carries no date for this node**, and its position is
   spread between two named taxa; **the Open Tree synthesis has no lineage for
   this fossil**, and it hangs where PBDB's classification resolves; **PhyloPic
   has no drawing of this taxon**, and the closest relative it does have stands
   in. Same length, one more fact, and nothing for the reader to take as doubt
   about the tree.

   **Naming the two taxa is the point, and it is what exposed that the old
   sentence was wrong.** "Between its nearest dated ancestor and descendant"
   survived as long as it did because it named nothing and so could not be
   checked. It is true of **2.8%** of the nodes it appeared on — architecture
   §3.5 has the census — and the card now writes one of four sentences instead:
   both ends named; an ancestor above and *the present* below, which is the
   ordinary case at 70.4% and says outright that the chronogram covers living
   species only; the ancestor named as an unnamed divergence, since 24.4% of
   upper bounds are `mrcaott…` nodes with no name to print; and, where the
   nearest dated relative is at the present too, no span claimed at all,
   because there was no gap to spread into and no interpolation ran. Both ends
   are links, by the same rule every other name on the card follows.

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
- **The flare is one beat for every shape a mark can be**, so it is written in
  `drop-shadow` and not `box-shadow`: a box-shadow follows the *border box*,
  which is only the right shape for a mark whose border box is its shape. Its
  size animates as `scale`, not `transform`, because a mark may already be
  spending its transform on centring itself.
- Enter/exit is fade plus draw-on. Never slide.
- Respect `prefers-reduced-motion`: cut to final state, keep glow static.

## Waiting

Everything the API serves is immutable within a build and memoised for the
session, so **most requests answer in the frame the click happened in** and the
default rendering of a wait is nothing at all. That is the constraint the rest
of this section exists inside: the failure mode here is not an absent spinner,
it is chrome flashing over facts the app already holds.

- **A sentence, never a spinner.** `.pending` is the whole vocabulary — a dim
  line of text, breathing on a 1.8 s cycle, saying *what* is being waited for.
  Named corpora over generic verbs: naming the corpus and its size tells a
  reader whether to keep waiting; "Loading…" does not. **One number, not two.**
  It read "2.4 million species and 523,112 fossil taxa", which named the
  plumbing — both catalogues are searched on every query and the reader has no
  use for the seam. The one exception this file's "no ambient animation" rule
  makes, because it is data arriving.
- **The number is `SPECIES_PHRASE`, and it is the count of `rank='species'`.**
  Dropping the second corpus from the line above is what lost the first figure:
  the survivor was rewritten to the **node** total, a third of a million of
  which are groups, and the wrong number spread to the species key's hint, the
  boot panel, both palette prompts and the about page. Calling a group a species
  is the one error the sentence inviting somebody to search cannot make, since
  telling a clade from a species is most of what the canvas is for.
  **The first correction then reached for the *tip* count**, which is a third
  wrong number — tips include subspecies, varieties, cultivars and 1,615
  group-rank terminals, while 21,977 species are internal nodes with subspecies
  beneath them. Three figures live within 20% of each other and only one of them
  is a species count; `data-sources.md` now states all three and says which
  question each answers. Every surface reads `corpora.ts`, and `corpora.test.ts`
  refuses **any** hardcoded "N million species" outside that file — across
  `web/src`, the stylesheet, `index.html`, the Worker and the README — because
  a guard on the strings that have already been wrong cannot catch the next
  surface writing its own.
- **No skeletons.** A grey bar predicts a shape — an image or not, five ranks or
  twenty — and a wrong prediction reads as the layout settling. It is also a
  promise that something is definitely coming, which for much of this corpus is
  false.
- **Delayed by `PENDING_DELAY_MS`, and the delay is the component's, not the
  caller's.** `usePending` in `web/src/chrome/Pending.tsx` is the only place a
  wait becomes visible. A cached node, a warm search and a reopened drill-down
  lane say nothing; only a request that genuinely made somebody wait announces
  itself. Every call site would otherwise make this decision differently, and
  getting it wrong is invisible on a developer's machine, where the API is on
  localhost and every request is instant.
- **A pending state is never a denial, and this is the rule with teeth.** "No
  results", "no fossils on this branch" and an empty card are *answers*, and are
  reachable only from a settled request. The palette shipped for months printing
  "Nothing matched **dog**" for the whole of every round trip; `emptyState` in
  `Palette.tsx` and the branch order in `DrillLane.tsx` are where that is now
  enforced, and `empty.test.ts` is the invariant.
- **Stale content is dimmed, not cleared.** A list that empties on every
  keystroke cannot be read while typing, and clearing collapses the panel and
  moves the pointer's target. Dim says *these answer the previous question*.
  The exception is anything whose stale version is **plausible**: the detail
  card is replaced by a placeholder rather than left standing, because a
  complete, confidently-numbered card about the wrong animal does not look
  wrong.
- **`role="status"`** on every pending line. A purely visual indicator tells a
  screen reader nothing, and this is exactly what a polite live region is for.

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

- **The tree is URL-encoded; how you are reading it is not.** Any *tree* is a
  shareable link — the selection, the axis, the isolate and the drill all ride
  in it. The labels, the ages and the light are `sessionStorage`, per-tab,
  because a setting that is a claim about the **reader** may not travel in one:
  a link made with the labels off would open on a canvas of unnamed dots. This
  line read "all view state is URL-encoded", which was the source the share
  command's own subtitle was written from, and it is why that subtitle spent a
  release contradicting the bioluminescence command four rows above it.
- Full keyboard operation: search, add, remove, clear, fit, isolate, and
  step through selection are all bound.

## The tab

- **The icon is the MRCA mark**: a bright core with a ring standing off it, on
  the void, in the accent. The app is named after the common ancestor and the
  signature interaction takes it as its subject, so the tab wears the mark that
  means *this is the one* — `NodeMark.tsx`'s `is-mrca`, which is a filled dot
  and then `0 0 0 3px` of the same hue at low alpha.
- **A branching fork was drawn first and rejected on measurement, not taste.**
  It says more about the product — a dot and the two lineages leaving it — and
  at 16px a stem with two arms is a `<`, or a terminal prompt. Three glyphs
  were compared at 64, 32 and 16; the only question a favicon answers is
  legibility at the last of those, and concentric circles are the shape that
  survives it. A second fork, drawn to look more like a tree, was worse again.
- **The void is baked in, not transparent**, because a tab strip is white in
  light mode and a thin cyan ring on white is not there at all. "Light theme is
  out of scope" is a statement about the app; the tab is not ours.
- **The gap between core and ring is the shape**, and stays empty. At 16px the
  ring is 1.3px and the gap 2px, so the canvas's own bloom on the core — the
  obvious embellishment — spends exactly the pixels doing the work. The bloom
  is drawn outward from the ring instead, where it costs nothing small and
  reads at 180.
- `web/public/favicon.svg` is the design and carries the reasoning;
  `scripts/make-icons.py` generates the `.ico` and the touch icon from the same
  geometry, in the standard library and nothing else. Two tests keep the three
  files honest in both directions — `web/src/icons.test.ts` pins the generator
  and the palette to the SVG, and `make-icons.py --check` pins the committed
  bytes to the generator.

## The share card

Every view of this app is a URL and the control bar has a button that copies
it, so a link is how anyone arrives who did not type the domain. What that link
unfurls into is `web/index.html`'s metadata and `web/public/og.png`, and until
both existed a shared tree previewed as the bare word "Concestor" with no
picture and no sentence.

- **The card is the fork the icon could not be.** The tab's mark is concentric
  circles because at 16px a stem with two arms is a `<`; at 1200×630 that
  constraint is gone, so the card draws what the product actually does — four
  lineages running toward the present, converging through two divergences onto
  one bright common ancestor, which wears the icon's own mark at scale. The two
  images come out of one script for exactly that reason: the tab and the card
  are one glyph, written down once.
- **It is the instrument, not a picture of one.** Stroke weights, the elbow a
  branch turns, the dot sizes, the lane hues, the backdrop's radial ramp and
  the 56px lattice are all `styles.css`, `layout.ts` and `TraceEdge.tsx`'s own
  figures at a single scale factor. `meta.test.ts` pins the card's hues to
  `LANE_HUES`, because a card drawn in colours that merely resemble the app is
  a thing nobody would ever catch — nothing renders both.
- **No word and no number on the image.** Every surface prints `og:title` and
  `og:description` beside it, so text on the card would be a second copy of a
  sentence that lives in the document — the copy that goes stale silently. A
  figure would be worse: this tree is drawn rather than derived, and the one
  rule this project does not bend is that it prints no age it cannot stand
  behind. With nothing printed, nothing on the card can be wrong. It is also
  what lets a stdlib rasteriser do the whole job: no font, no text shaping.
- **Every branch is solid**, though the app's own canvas is full of dashes. The
  dash channel is this project's statement that the chronogram carries no date,
  and on a card that claims no dates there is nothing for it to be about. A
  dashed branch here would be decoration wearing the one pattern that carries
  meaning.
- **The tags are static, deliberately.** A per-selection card — resolve `sel=`,
  print the species, draw their tree — is the obvious next thing and it is
  refused on cost, not taste. The document is a static asset; making it dynamic
  means routing `/` through the Worker, which puts a container hop on the
  critical path of a cold *human* load and not just a scraper's, and the image
  would have to be rendered per selection somewhere the layout, the labels and
  the silhouettes do not run today. What would reopen it: a measured demand for
  it (`docs/analytics.md`'s `tree` event is what would show shared links being
  followed), or a rendering path that already exists for another reason.
- **`robots.txt` is a real file** for the same reason `favicon.ico` is: without
  one, `not_found_handling: single-page-application` answers the request with
  the app shell at 200, and a crawler handed HTML where directives belong reads
  a document of syntax errors. There is one page to index — every view is
  `/?sel=…` of one shell — which is what the canonical link says and why there
  is no sitemap.

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