# The sidebar

**Shipped.** One docked column on the left, at one fixed width, holds everything
that is not the tree. What is left outside it is the canvas, the timeline flush
along the bottom, two small clusters in the canvas's own corners, and the detail
card flying out from the right.

---

## 1. What it replaced, and why the pieces were fine

The chrome used to sit on four edges at once:

| Where | What |
|---|---|
| top | a captioned button bar: **Concestor**, **Add species**, **Canvas**, **Navigate** |
| bottom left | a stack of mode chips: labels, ages, bioluminescence |
| bottom, on the axis footer | the time-scale switch |
| top right | the detail card |
| bottom right, under 620px | one round button standing in for all of it |

Every one of those placements had an argument and several were good ones. *A
control belongs on the thing it changes* is why the scale switch was under the
ruler it redraws. *Chrome auto-hides; the canvas is the page* is why the bar
faded after four still seconds. *A thumb has no hover* is why the phone layout
was a swap rather than a squeeze.

The sum is what failed. A canvas with a hole in each corner asks the reader's
eye to go somewhere different for every kind of thing they might want to do,
and none of the four surfaces can say what it has in common with the others.
The tree is the product, and it was the thing with least of the screen to
itself.

**The strongest local argument is the one that lost.** The time scale really
does belong on the ruler it redraws. But it is also one of four controls that
change *how the canvas is drawn rather than what is on it*, and a set is only
legible when its members are beside each other. Under the ruler it was a switch
on its own that happened to wear the panel's anatomy.

---

## 2. The layout contract is one custom property

`--sidebar-w` is written to the document element by `sidebar/useSidebar.ts`.
The canvas is `left: var(--sidebar-w)`, and because the axis, the drill lane
and every mark are positioned *inside* the canvas, they follow for free. There
is no second place that has to be told the panel got wider.

Two consequences worth knowing:

- **`canvas/viewport.ts` is correct for nothing.** React Flow measures the
  canvas element, so `vw` is already the canvas's own width. Every threshold in
  that file — including `MIN_FREE_W`, the narrowest strip worth reframing a
  tree into — is measured against the strip the tree actually has, which makes
  the card reserve's refusal *sharper* rather than looser: a wide panel and an
  open card can leave too little to reframe into, and the reserve is refused
  exactly there.
- **It must be written before the first paint.** `main.tsx` calls
  `primeSidebarWidth()` before `createRoot().render()`, and the hook keeps it
  true afterwards with `useLayoutEffect`. Under a passive effect the first
  painted frame is a full-width canvas, React Flow measures *that*, and the fit
  frames the tree against a viewport a panel's width wider than the one it ends
  up in — so a shared link opens with its right-hand lineages hanging off the
  edge. That is not a flicker; it is a wrong fit that persists.
- **The panel's own `width` is a CSS constant and not the variable.** The
  variable is what the panel *costs the canvas* and goes to `0px` the moment it
  shuts; the panel keeps its width and slides out on a transform. Reading the
  variable there would collapse the panel to nothing before it had finished
  leaving.

### One rhythm down the column, and it scales

The panel is five blocks — the wordmark, the search pill's slot, the taxa list,
the canvas modes, the footer strip — with **four gaps between them, all the same
measurement, all scaling with the window**.

```
--side-gap: clamp(14px, 2.4vh, 30px)
```

It is a single `gap` on the flex column, which is exactly four gaps and exactly
the four the eye counts. Two things had to change for those four to actually be
equal:

- **The sections carry no padding and no rules between them.** Each used to have
  `var(--s3)` above and `var(--s2)` below plus a hairline to its neighbour.
  Under one shared gap that is what makes the four *unequal*: the two around the
  pill's slot are the gap alone, and the two around the sections would be the
  gap plus two paddings. The captions are the section markers and at this much
  whitespace they are enough.
- **The pill has to be told where the flow would have put it.** It is in a fixed
  layer so it cannot inherit the column, and its `top` is
  `--side-pad-t + --brand-h + --side-gap` — the same three properties the flow
  uses. Its slot in the column is exactly `--search-h`, with the gap supplying
  the space on both sides.

**`vh` rather than a flex spacer**, and that is the interesting half. The taxa
list is the thing that takes the slack — it is the scroller — so a spacer
competing with it for free height would *shrink the list on a tall window*,
which is backwards. Making the gaps a function of the window and letting the
list absorb whatever is left is what keeps them equal once the list is full and
scrolling, which is the case the rhythm has to hold in.

Measured: 23px at a 950px window and 15px at 640px, identical across all four
gaps in both, with the list scrolling at the second.

### `--chrome-left` is a second number, and the difference is the drawer

`--sidebar-w` is what the panel takes *off the canvas*. `--chrome-left` is where
the panel's right edge *is on screen*. Docked and open they are the same; floating
over the canvas below `DOCK_W` the first is zero and the second is the drawer's
width. The toggle and the search pill ride the second. Collapsing them into one
was the first version and it drew both of them on top of the drawer's own
wordmark at every width below the threshold.

### The bioluminescent water had to be told the canvas resized

`canvas/Water.tsx` sized its drawing buffer from a `window.resize` listener, and
for this file's whole life that caught everything: `.canvas` was `position:
fixed; inset: 0`, so its box and the window's changed together.

It is `left: var(--sidebar-w)` now. Toggling the panel changes the element's
width and its origin, the window is untouched, and the buffer keeps whatever
size it was last given — measured, a 1020px canvas still holding a 756px
buffer, stretched over it by CSS. **Every river was drawn a fifth of a screen to
the right of the branch it belongs to**, and nothing errored: the mode simply
looked broken.

A `ResizeObserver` on the element is the honest signal — it is this element's
own box that matters, not the window's — and it fires on every frame of the
panel's transition, so the buffer tracks the slide rather than snapping at the
end of it. The `window.resize` listener stays beside it, because the observer
reports a *size* and `resize()` also reads the origin, which a window change can
move without the size changing.

The file's own header predicted half of this. It read the canvas origin even
though the value was always zero, "because … a renderer that assumed the two
origins coincide would be wrong silently and only on the day somebody insets the
canvas." That day arrived and the origin was already handled; what it did not
anticipate was the element resizing without the window resizing.

### The tree does not move when the panel does

React Flow's transform is relative to the canvas, so every pixel the panel's
edge moves is a pixel the whole tree slides sideways on screen. Toggling the
panel threw the tree a quarter of a window to one side under the reader's eyes.

`Graph.tsx` answers it with the same split the card reserve already uses:

- **At the fit**, it refits. A reader sitting on the fit is looking at *the
  whole tree*, and the honest response to a canvas that changed size is to frame
  the whole tree in the new one — so the tree is never left behind the panel
  that just opened over it.
- **Off the fit**, the viewport takes the opposite shift and the picture stays
  exactly where it was. A reader who zoomed into a corner is looking at
  *something*, and refitting would take it away from them.

It runs off `vw`, which is the only signal there is: a left-hand panel cannot
change the canvas's offset without changing its width, and React Flow reports
width from a `ResizeObserver`, so the correction arrives in the same increments
the slide does and the refit is debounced into one. A window resize changes `vw`
and *not* the offset, so the delta is zero and nothing happens — which is right,
because that is the browser moving the canvas rather than us.

---

## 3. One width, and the drag that was built and removed

| Constant | Value | Why |
|---|---|---|
| `WIDTH` | 264 | the **narrowest** the column's contents read at, set by the `labels` switch — `off · common · scientific` in a recessed track under a caption and a badge |
| `DOCK_W` | 940 | a docked panel still has to leave the canvas more than `MIN_FREE_W` (420), which `viewport.ts` measured as the narrowest strip worth reframing a tree into. 264 + 420 is 684; the room to 940 is the margin between *a tree fits* and *a tree fits beside an open card as well* |
| `FLOAT_GAP` | 56 | how much canvas a floating drawer leaves showing beside it |

**It is the narrowest width that reads, not a comfortable one**, and that
distinction is why the number changed. The panel was 336 while the detail card
lived inside it, sized so the card's prose kept the measure it was written for.
The card moved out to the right-hand edge (§6) and took the only argument for
the extra 72px with it — every pixel past 264 was a mode track stretching to say
nothing extra, bought with canvas.

**A drag handle was built first, to the full WAI-ARIA window-splitter contract**
— a focusable separator, `aria-valuenow` as a percentage with the pixels in
`aria-valuetext`, arrow keys, `Home`/`End`, `Enter` to toggle, double-click to
reset, a 24px coarse-pointer target, a 40px hit area while the pointer was down,
a 5px threshold separating a click from a drag, and a snap past the minimum that
closed the panel. All of it worked and all of it is gone.

The reason is that **there is no width a reader would rather be at.** The
panel's contents do not reward one: every row in it is a name, a caption or a
switch, and none of them is a document that gets easier to read wider. Narrower
buys canvas that `S` already gives away for free, and gives back a panel whose
captions have started to wrap. Wider buys nothing and costs the tree.

What the drag was really offering was a way to trade panel for canvas. The
toggle already is one — instantly, reversibly, and from the keyboard — so the
two states are **open and shut**, which is a control anybody can find and nobody
has to discover.

`sidebar/layout.test.ts` holds `DOCK_W − WIDTH ≥ 420`, and holds the stylesheet's
own `width` and the drawer's `max-width` against the module's constants, because
those are the two numbers stated in both places.

---

## 4. The search is a field in the column, and the switch is in the header

Both of these were clever and both read as loud, which is the same mistake made
twice.

**The search was a pill that bulged out over the canvas.** It spanned the panel
and kept going past its right edge, ending in a round cap that was all that
remained when the panel shut — one element in two states, with the collapsed
diameter falling out of `--search-out − --rail-pad = --search-h`. The arithmetic
worked and the transition was the width animating. It still read as a bulge: a
lozenge poking out of a straight edge is the one shape in this layout that
nothing else explains, and it pulled the eye to the panel's border rather than
to the field. It also glowed, on the argument that it is the way in and a reader
who does not find it has no way to reach anything.

**The switch was a bordered, backdrop-blurred tile floating at the panel's
edge.** That is where every shipped sidebar puts it, and while the panel is
*open* it is a control announcing a thing the reader is already looking at.

What replaced them:

| | Open | Shut |
|---|---|---|
| switch | in the panel's header, beside the wordmark | in a cluster on the canvas, top left |
| search | a field in the column, at the column's inset | the second button in that cluster |

**The cluster is drawn by the same component as the three viewport actions in
the opposite corner** — same anatomy, same badges, same 16px from its own
corner — and that parity is what makes the trade honest. It is two controls
where there was one, and what it buys is that the collapsed state is a *family*
rather than one clever object and one bordered tile.

The glow went with the pill. The standing rule is that the graph is the only
light source, with the bioluminescence switch as the single exception because
glowing is what *it* does; the search's exception was earned by being a lit
object floating half over the canvas with nothing else to find it by. In a
column under the app's own name, above a section captioned TAXA, a field that
looks like a field is found.

### Two mount points for one control, and focus has to follow

Pressing the switch unmounts it. Left alone, a reader closing the panel from the
keyboard is dropped on `body` and has to tab from the top of the document to get
back to the button they were standing on.

`App.tsx` moves the ring to whichever instance survives, and only when the press
*came from* a toggle — the same callback is what `S` runs from anywhere on the
canvas, and a key press must not move focus to somewhere the reader was not.

**It happens in an effect and not in a `requestAnimationFrame`.** The first
version used a frame and silently did nothing: React commits on a task of its
own, so the frame fired while the surviving instance did not exist yet and the
query matched nothing. An effect runs after the commit, which is the only moment
both facts are true — the old button gone, the new one in the document.

### One consequence for the bioluminescent lights

`canvas/bootLight.ts` measures elements with `getBoundingClientRect` and brings
them back into canvas space through the canvas's own left offset — which is the
panel's width while the panel is docked and open. **An element inside the panel
therefore resolves to a negative x and lights nothing**, and the panel is opaque
and beside the canvas anyway, so there would be nothing to see at x = 0 either.

That had been quietly true of the wordmark since it moved into the column, and
it is why `SOURCES` is down to two: the carousel card, and the copy of the
search that is genuinely over the water — the one in the left-hand cluster,
drawn only while the panel is shut, which is exactly when a light there can be
seen.

## 5. The two one-way actions live in captions, not in buttons

Share and clear were two bordered buttons under a captioned section — glyph,
word, key badge — and they were the loudest object in a panel whose whole
register is quiet, spent on the two actions a reader reaches for *least*. The
section had one line of content and three lines of chrome around it.

They are verbs in a caption's row now, in the caption's own face: small-caps
mono, the vocabulary this app already uses for a field label. The anatomy is
`SourceLinks`'s — `about | source` has sat at the foot of this panel in exactly
that voice from the beginning and has never needed a box, which is the evidence
these rows needed none either.

**And they ended up in different places, which is the placement rather than a
symmetry.**

```
TAXA                    3   CLEAR
…
────────────────────────────────
about | source           🔗 share
```

Clear empties *the list*, so it belongs beside that list's own count — and at
the far right of the header, which is exactly where every row in the list puts
its own remove control. The list-level action lines up with the row-level ones.

Share went the other way, into the footer strip opposite `about | source`, and
the `This tree` section went with it: one caption over one control, for the
action a reader reaches for last, is three lines of chrome for a link. In the
footer it reads as what it actually is — a small link at the bottom of the page.
The strip is **two groups rather than three links**, and the space between them
is what says so: the left pair answers *where did this come from*, the right one
sends it on.

**The chain glyph is doing real work and the word alone would not.** "Share" is
the most overloaded verb in software — *post this*, *send this to a person*,
*open a sheet of destinations* — and none of those is what this does. What it
does is put a URL on the clipboard, and a link glyph says that before the word
is read. It is drawn rather than typed for `SearchGlyph`'s reason: `🔗` and `⛓`
are emoji on most platforms and arrive in somebody else's colour at somebody
else's weight.

While that moved, `.axis-links` / `.axis-link` were renamed `.side-links` /
`.side-link`. Nothing they name has been on the axis since `SourceLinks` left
the footer, and a class that says where an element used to be is a comment that
cannot go stale out loud.

**Both the count and CLEAR are absent at zero, and that is the one place this
app's *disabled rather than hidden* rule gives way.** The rule exists so a
control does not move out from under a hand reaching for it, and so a greyed one
can say what would make it work. Neither applies here: nothing reaches for clear
on an empty canvas, and the sentence a tooltip would carry — *the canvas is
already empty* — is the empty list itself, said louder. The palette drops
`fit-all` and `step` on the same canvas for the same reason.

Three things that went with the boxes:

- **The glyphs.** `↗` and `×` were doing nothing two words were not, and `×`
  beside a section caption can fairly be read as *close this section*.
- **The key badge.** `C` is still bound, still printed on the palette's own row,
  and now named in the tooltip here. That is the right place for it: clear is
  the one action in this app that asks before it acts, so it is nobody's
  mid-flow keystroke, and a small box beside two words that are deliberately not
  boxes would be the only thing in the row breaking its own register.
- **The warm border.** Clear's danger colour is now ink only, and appears only
  under a pointer that has already arrived on it.

Focus is an **underline** rather than a colour, because resting and hovered are
already the only two colours in the row and a third would have to be told apart
from both at 9.5px. Disabled is `aria-disabled` and stays focusable, so the
sentence saying what would make it work is reachable.

---

## 6. The Taxa list

**It is the only thing in the column that scrolls.** One scroll region over both
sections is the obvious arrangement and the wrong one: the list grows without
bound, and the four canvas modes are a fixed set a reader wants in the same
place every time — so under one scroller a tenth species pushed `LABELS` off the
bottom of the panel, a control moving because of something that has nothing to
do with it. `.side-taxa` takes the free height and its rows scroll inside it;
`Canvas` and the footer strip sit under it at their natural height.

### The header is three cells, and the middle one is centred

```
TAXA                 6                CLEAR ⌨C
```

The count and CLEAR used to sit together at the right end and read as one
object — a number that looked like part of the button beside it. Equal outer
columns put the count on the row's own midline whatever the words either side
are doing, which is the same trick the axis footer uses to centre its key.

That also gives CLEAR the whole right-hand end, which is what lets it carry its
key badge again. The badge came off while this row held *two* verbs, where a
small box beside two words that were deliberately not boxes was the only thing
breaking the row's register. Alone at the end of the row it is the thing that
gives the one destructive control in the panel an identity — and `C` is a key
nobody learns from a tooltip.

**The count's cell is always rendered and its contents are what go at zero.**
`Legend.tsx` made that rule on the axis footer for the same reason: an absent
middle cell lets a three-column grid collapse, so the count would stop being
centred the moment it appeared.

### The two doors are drawn at one of two sizes

Under `SPACIOUS_UPTO` (2) taxa they are **square tiles**: a glyph, a title, a
line saying what is behind the door, and the key. Past it they collapse to a
single compact row.

The rule is about *vertical space* rather than about expertise. A short list
leaves this column mostly empty, and an empty column under two small buttons is
the product failing to say what it is for at the one moment a reader has not
decided yet. A tile is also a target you hit without aiming, which is the half
that matters on a first visit. Past the threshold the list is what the column is
for, and tiles would be pushing rows off the bottom to fill space that is no
longer empty.

Two is not arbitrary: it is one short of the smallest tree this product will
draw an argument from. `openings.ts` refuses to ship a two-taxon opening because
*a pair draws one number, and three or more draw an argument* — so the tiles are
up for exactly as long as the canvas cannot yet make the case for itself, and
they collapse on the add that finally does.

Both states are the same two controls with the same two keys, which is what
makes the change a *size* rather than a reshuffle: nothing appears, nothing
goes, and the badges do not move relative to what they label. What the tiles
carry that the row cannot is the second line — "Add a taxon" says what the
button does, and *any species, living or fossil* says what is behind it, which
is the fact this app is least able to assume a reader knows.

The section is **Taxa**, not **Species**: the list holds species and it also
holds *Cetacea*, which is not one, and *Tyrannosaurus*, which is a genus.
"Species" was accurate about the search and never about the result.

Rows are derived from `induced.leaves` rather than from `view.keys`, so the
panel and the canvas cannot disagree about what is drawn — the same reason
`graftSet` is rebuilt from the induced subtree rather than stored.

Four things not to redo:

1. **The row and its remove control are siblings, never nested.** A `<button>`
   inside a `<button>` is invalid markup browsers resolve differently, and the
   failure mode is the worst available: pressing *remove* also selects, so the
   card opens on the taxon that has just been taken off the canvas.
2. **`off` falls back to the scientific name.** The list follows the canvas's
   labels setting, with that one exception. `off` is a statement about the
   *canvas*, where the shape of the tree is the subject and the names are in the
   way; a list of blank rows is not the quieter version of this list.
3. **A fossil row's badge reads *on a branch*.** Not "extinct" — the two
   catalogues overlap and *T. rex* is in the tree. `fossil-grafts.md` §9 is the
   argument, and the sentence a reader is asked to hold is *a fossil row is a
   species the tree has no lineage for*.
4. **The range comes from `drawnBounds`**, so it reads `lla_drawn` and never
   `lla`. PBDB's young end can be a fact about the catalogue rather than the
   animal, and every surface that prints the pair has to read the corrected one.
   The figure goes through `ages.ts`'s `maFigure` — `ages.test.ts` sweeps the
   corpus for a second rounding ladder and found one here on the first run.

The remove control is hidden until the row is hovered **or focused within**, and
`@media (hover: none)` shows it always. A control only a pointer can summon is
unreachable from a keyboard and does not exist for a thumb.

---

## 7. The card stayed on the right

It was moved into the panel for one iteration, as an overlay sheet on the scroll
region, on the argument that one column should hold everything that is not the
tree. **That was wrong and was reverted.** A card is about one taxon *on the
canvas*, and reading it from the same column as the list means looking left,
then right, then left again — while the panel it covered was the list you were
choosing from.

So it flies out from the right, opposite the panel, and `canvas/viewport.ts`'s
reserve is what makes that safe: the fit is computed against the canvas minus
the card, so the tree reframes into the strip *between* the two rather than
sliding under either. The panel keeps the list; the card keeps the answer; the
tree stays between them.

Its `top` is 58px rather than the window's own margin, because the view cluster
is in the same corner and a card starting at 16 lands on it.

---

## 8. One route to the about page, and the wordmark is it

The panel's footer had an `About Concestor →` row sitting directly above
`SourceLinks`, whose *first link is the about page* — same `goAbout`, same
destination. Two controls, one place, stacked, in the corner where a reader is
deciding whether either is worth a press.

The row is gone and three things carry what it was doing, each where it is
actually useful:

- **The wordmark is the door, and the tagline is inside it.** Clicking
  `C⊙NCEST⊙R` — or *Everything alive is related* under it — opens the about
  page, which is what a wordmark does everywhere else on the web. It costs no
  pixels, needs no caption, and turns the one inert block in the panel into a
  control. The tagline belongs in the target rather than beside it because it is
  the *claim*, and the about page is where the claim is made good; it also makes
  the target a block rather than a word, which is the difference between a link
  somebody finds and one they hit. It is not styled as a button — a border round
  the product's own name would make it look like a control rather than a mark;
  what says *pressable* is a track appearing under the pointer and the two ring
  glyphs lighting to the accent.

  Two markup facts that are easy to get wrong. The `<button>` sits **inside**
  the `<h1>`, because a button's content model is phrasing content and a heading
  is not — two `<span>`s are, so both lines fit in the button and the heading
  keeps its outline. And there is **no `aria-label` on it**: the visible text is
  two lines, and a label naming only the first would fail WCAG 2.5.3, which asks
  that a control's accessible name contain what it visibly says. The name comes
  from the contents instead — the ring glyphs are `aria-hidden` and a
  `.visually-hidden` span supplies the word they stand in for, leaving
  *Concestor. Everything alive is related.* What pressing it **gets you** is the
  tooltip, which arrives as a description rather than as a name.
- **The empty canvas's last line is the first-time driver**, and it was lifted a
  rung of ink and given a track under the pointer for it. That is where a
  stranger actually is: it is the final line of the one screen they are
  certainly looking at, directly under the question that just persuaded them,
  with no tree to lose. It still does not take the carousel's accent — that is
  the lit mark on that canvas and there may only be one.
- **`about | source` stays exactly as it was**, quiet, pinned below the scroll,
  for the reader who goes looking later.

---

## 9. What is left on the canvas

**Top left: the panel's switch.** It rides `--chrome-left`, so it slides with
the panel's edge as it is dragged and stays exactly where the hand left it when
the panel goes. A toggle inside the thing it hides has to be duplicated or
animated out. It is the ARIA **disclosure** pattern — `aria-expanded`,
`aria-controls` — and focus deliberately does *not* move into the panel when it
opens, so a second press closes what the first press opened.

**Top right: fit, isolate, fullscreen.** What they have in common is the
argument for the cluster existing: none of them changes the tree, they change
*your view of it*. They fade after four still seconds; the panel's switch does
not, because a control that puts the whole panel back has to be findable by
somebody who has just realised they want it.

**`step` did not come.** It walked the selection because the marks are small
targets on a crowded canvas — and the panel now draws every one of them as a row
you cannot miss, which is a strictly better version of the same idea. It keeps
its key and its palette row.

---

## 10. The keymap moved, and every move was an upgrade

| Key | Was | Is |
|---|---|---|
| `/` | isolate | **search** |
| `S` | species search | **sidebar** |
| `A` | ages | **add taxon** |
| `I` | — | **isolate** |
| `D` | — | **dates** (was `ages` on `A`) |
| `P` | palette | *unbound* |

`/` is the only row in `bindings.ts` whose letter needed no argument at all: it
is what `/` does in every application a reader has already used. Taking it cost
`isolate` a key that named nothing, and `i` names isolate exactly.

The knock-on runs one further step and each hop lands on a better mnemonic than
the one before. `s` went to the **sidebar** the search now lives in — so a finger
that remembers the old `S` lands on the panel holding the thing it was reaching
for rather than on nothing. That sent *add* to `a`, and `ages` to `d` under the
name it always should have had: **Dates**. An age is a duration in ordinary
English and a position here, which is the one confusion this canvas can least
afford. The store, the URL and every gate still say `ages`.

`P` is unbound rather than kept as an alias. Two keys for one action is two
things to learn and one of them is printed on nothing.

**The badge/label census went from two exceptions to one.** `P` printed
**Commands** because `p` named the palette and the word named what opening one
is for; the row is `/` and **Search** now, which is not a letter and so is not in
the census. Fullscreen on `E` is the only survivor. `bindings.test.ts` holds it
at one.

---

## 11. Below `DOCK_W`

The panel becomes an overlay drawer with a scrim, the canvas keeps the whole
window, and the drawer starts shut whatever the stored flag says — the flag is
about the docked column, and opening a drawer over the canvas before the reader
has asked for anything hides the one thing they came for.

`max-width: calc(100vw − 56px)` leaves a strip of canvas showing, so a reader
can see what they are standing in front of.

The old `@media (max-width: 620px)` swap block is gone. It hid the bar, the mode
panel and the scale switch and drew one round button; none of those four things
exists now, and the search pill is the same object at every width rather than a
stand-in for a bar that is not drawn. What survives of that argument is
`DOCK_W`, and §3 is why it is measured rather than picked.

---

## 12. Accessibility

- The panel is an `<aside>` — `complementary`, supporting content beside the
  main region. Not `<nav>`: nothing in it navigates anywhere and half of it acts
  on the canvas, one destructively. The same call `Controls` made when it
  refused `nav` and took `banner`.
- **A shut panel is `inert`.** Hidden by `transform` alone it stays in the tab
  order, which is an off-screen focus trap and the single most common bug in
  this pattern.
- Disabled controls are `aria-disabled` and stay focusable, so the sentence
  saying what would make them work is reachable by pointer *and* by keyboard.
- Every control in the panel has a command in the palette. `App.test.tsx` walks
  `bindings.ts` against the rendered palette with a named exemption per row.

---

## 13. Where the code is

```
web/src/sidebar/useSidebar.ts     open, docked, storage, the two properties
web/src/sidebar/Sidebar.tsx       the shell, the sections, the landmark
web/src/sidebar/SearchEntry.tsx   the pill, in its own fixed layer
web/src/sidebar/TaxaList.tsx      the layers panel
web/src/chrome/CanvasChrome.tsx   the toggle and the view cluster
web/src/canvas/capability.ts      `BIOLUM_AVAILABLE`, asked once
```

Gates: `sidebar/layout.test.ts` (the stylesheet and the derived widths),
`sidebar/TaxaList.test.tsx` (rows, badges, brackets), and `App.test.tsx` /
`App.bare.test.tsx` for the whole app on a browser with and without the two
capabilities.
