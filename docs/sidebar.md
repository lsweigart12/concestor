# The sidebar

**Shipped.** One docked column on the left, at one fixed width, holds everything
that is not the tree: the wordmark, the search field, the Taxa list, the canvas
modes, and a footer strip. Outside it are the canvas, the timeline flush along
the bottom, two small clusters in the canvas's corners, and the detail card
flying out from the right.

---

## 1. The layout contract is one custom property

`--sidebar-w` is written to the document element by `sidebar/useSidebar.ts`. The
canvas is `left: var(--sidebar-w)`, and because the axis, drill lane and every
mark are positioned *inside* the canvas, they follow for free.

- **`canvas/viewport.ts` measures the canvas element**, not the window, so its
  thresholds (including `MIN_FREE_W`) are already against the strip the tree
  actually has.
- **It must be written before the first paint.** `main.tsx` calls
  `primeSidebarWidth()` before `createRoot().render()`, and the hook keeps it
  true with `useLayoutEffect`. Under a passive effect the first painted frame is
  a full-width canvas, React Flow measures *that*, and a shared link opens with
  its right-hand lineages hanging off the edge — a wrong fit that persists.
- **The panel's own `width` is a CSS constant, not the variable.** The variable
  is what the panel *costs the canvas* and goes to `0px` the moment it shuts; the
  panel keeps its width and slides out on a transform.

**`--chrome-left`** is a second number: where the panel's right edge *is on
screen*. Docked and open they are equal; floating over the canvas below `DOCK_W`,
`--sidebar-w` is zero and `--chrome-left` is the drawer's width. The toggle and
search pill ride `--chrome-left`.

### One rhythm down the column

Five blocks with four equal gaps that scale with the window:

```
--side-gap: clamp(14px, 2.4vh, 30px)
```

A single `gap` on the flex column. The sections carry **no padding and no rules**
between them (a padding would make the four gaps unequal), and the search pill is
in a fixed layer so its `top` reproduces the flow: `--side-pad-t + --brand-h +
--side-gap`. **`vh`, not a flex spacer** — the Taxa list is the scroller that
absorbs slack, so a spacer competing for free height would shrink the list on a
tall window.

### Two resize signals the water and the tree need

- **`canvas/Water.tsx` sizes its buffer from a `ResizeObserver` on the element**,
  not `window.resize`. The canvas is `left: var(--sidebar-w)`, so toggling the
  panel changes the element's width and origin without the window changing; a
  `window.resize`-only renderer drew every river a fifth of a screen off, silently.
  The `window.resize` listener stays beside the observer because the observer
  reports a *size* and `resize()` also reads the origin.
- **`Graph.tsx` keeps the tree from sliding when the panel moves.** At the fit it
  refits (a reader on the fit is looking at the whole tree); off the fit the
  viewport takes the opposite shift and the picture stays put. It runs off `vw`,
  reported by React Flow's own `ResizeObserver`, so the correction arrives in the
  same increments as the slide and a plain window resize (which changes `vw` but
  not the offset) does nothing.

---

## 2. One width

| Constant | Value | Why |
|---|---|---|
| `WIDTH` | 264 | the **narrowest** the column's contents read at, set by the `labels` switch (`off · common · scientific`) |
| `DOCK_W` | 940 | a docked panel must leave the canvas more than `MIN_FREE_W` (420). 264 + 420 = 684; the room to 940 is the margin between *a tree fits* and *a tree fits beside an open card* |
| `FLOAT_GAP` | 56 | canvas a floating drawer leaves showing beside it |

**It is the narrowest width that reads, not a comfortable one.** The panel's rows
are names, captions and switches — none rewards a wider measure; narrower buys
canvas that `S` already gives away and wraps captions. There is no width a reader
would rather be at, so the states are **open and shut** (a toggle, instant,
reversible, keyboard-reachable) rather than a drag handle.

`sidebar/layout.test.ts` holds `DOCK_W − WIDTH ≥ 420` and pins the stylesheet's
`width` and the drawer's `max-width` to the module's constants.

---

## 3. The search and the switch

- **The search is a field in the column**, at the column's inset, when the panel
  is open; when shut, it is a button in the top-left cluster.
- **The `labels` switch** is in the panel's header beside the wordmark when open;
  in the top-left cluster when shut.

The collapsed cluster is drawn by the **same component as the three viewport
actions** in the opposite corner — same anatomy, same badges, same 16px from its
corner — so the collapsed state is a family rather than one clever object. Neither
control glows: the standing rule is that the graph is the only light source, with
bioluminescence the single exception.

**Two mount points for one control, so focus must follow.** Pressing a toggle
unmounts it, so `App.tsx` moves the focus ring to whichever instance survives —
and **only when the press came from a toggle** (the same callback `S` runs, and a
key press must not move focus somewhere the reader was not). It happens in an
**effect, not a `requestAnimationFrame`** — React commits on its own task, so a
frame fires before the surviving instance exists.

**One consequence for `bootLight.ts`:** an element inside a docked, open panel
resolves to a negative x in canvas space and lights nothing (and the panel is
opaque anyway). So `SOURCES` is the carousel card and the copy of the search that
is genuinely over the water — the left-hand cluster's, drawn only while the panel
is shut.

---

## 4. The footer strip: two one-way actions

Share and clear are verbs in a caption's row (small-caps mono), not filled
buttons — the register `SourceLinks` (`about | source`) has always used at the
foot of this panel. They sit in different places:

```
TAXA 3               ⌜CLEAR │ C⌟
…
────────────────────────────────
about | source           🔗 share
```

- **Clear** empties the list, so it sits on that list's own caption, at the far
  right of the header where every row puts its own remove control. It is one
  **ghost button**: the word and its key badge inside a single hairline (the
  same border every `.kbd` badge wears), with a thin rule between them — the
  badge used to sit *beside* the word as a second boxed object, two things
  where the reader was being offered one. Hover fills it with the row remove
  control's own warm tint, because it is the same verb at list scale.
- **Share** goes into the footer strip opposite `about | source` — two groups,
  not three links: the left pair answers *where did this come from*, the right one
  *sends it on*. The **chain glyph** is load-bearing because "share" is
  overloaded and this only puts a URL on the clipboard; it is drawn, not typed,
  because `🔗`/`⛓` render in the platform's colour and weight.

**The count and CLEAR are absent at zero** — the one place this app's *disabled
rather than hidden* rule gives way, because nothing reaches for clear on an empty
canvas and the empty list already says it. `C` is still bound and printed on the
palette row, and CLEAR prints it too. Focus is an
**underline** (resting and hovered are already the row's only two colours);
disabled is `aria-disabled` and stays focusable. `.axis-links`/`.axis-link` were
renamed `.side-links`/`.side-link` — nothing they name is on the axis.

---

## 5. The Taxa list

**It is the only thing in the column that scrolls.** One scroller over both the
list and the canvas modes would push a fixed control (e.g. `LABELS`) off-screen
when the list grows; `.side-taxa` takes the free height and scrolls inside
itself, with `Canvas` and the footer under it at natural height.

The header is two ends: the noun and its number together on the left — "TAXA 3"
is one fact, read left to right — and the verb alone on the right. The count
used to float mid-row to keep it from crowding the verb; the ghost button's own
border does that work now, and a number floating between the ends read as
attached to neither.

Rows come from `induced.leaves`, not `view.keys`, so the panel and canvas cannot
disagree about what is drawn (the same reason `graftSet` is rebuilt from the
induced subtree). The section is **Taxa**, not Species — the list holds
*Cetacea* and the genus *Tyrannosaurus*, which are not species.

**Two sizes.** Under `SPACIOUS_UPTO` (2) taxa the two add-doors are **square
tiles** (glyph, title, a line saying what is behind the door, key); past it they
collapse to a single compact row. The rule is about *vertical space*: a short
list leaves the column empty at the moment a reader has not yet decided what the
app is for, and a tile is a target you hit without aiming. Two is one short of the
smallest tree that draws an argument (`openings.ts` refuses a two-taxon opening),
so the tiles are up exactly until the canvas can make its own case. Both states
are the same two controls with the same two keys — a size change, not a reshuffle.

Four invariants:

1. **The row and its remove control are siblings, never nested.** A `<button>`
   inside a `<button>` resolves so that *remove* also selects, opening the card on
   the taxon just removed.
2. **`off` falls back to the scientific name** — the list follows the canvas
   labels setting, but a list of blank rows is not the quieter version of a list.
3. **A fossil row's badge reads *on a branch*** (not "extinct"; the catalogues
   overlap and *T. rex* is in the tree). `fossil-grafts.md` §9 is the argument.
4. **The range comes from `drawnBounds`**, so it reads `lla_drawn`, never `lla`
   — PBDB's young end can be a fact about the catalogue rather than the animal,
   and the figure goes through `ages.ts`'s `maFigure`.

The remove control is hidden until the row is hovered or focused-within, and
`@media (hover: none)` shows it always.

---

## 6. The card stayed on the right

It flies out from the right, opposite the panel. `canvas/viewport.ts`'s reserve
computes the fit against the canvas minus the card, so the tree reframes into the
strip *between* the two rather than sliding under either. Its `top` is 58px (the
view cluster is in the same corner and 16 would land on it).

---

## 7. One route to the about page: the wordmark

Clicking `C⊙NCEST⊙R` — or *Everything alive is related* under it — opens the
about page. Two markup facts:

- The `<button>` sits **inside** the `<h1>` (a button's content model is phrasing
  content; two `<span>`s fit and the heading keeps its outline).
- **No `aria-label`** — a label naming only the first line would fail WCAG 2.5.3.
  The accessible name comes from the contents: ring glyphs are `aria-hidden` and a
  `.visually-hidden` span supplies the word.

The empty canvas's last line is the first-time driver (lifted a rung of ink, a
track under the pointer, but not the carousel's accent — one lit mark per canvas).
`about | source` stays pinned below the scroll for the reader who looks later.

---

## 8. What is left on the canvas

- **Top left:** the panel's toggle (ARIA **disclosure** — `aria-expanded`,
  `aria-controls`; focus does *not* move into the panel, so a second press
  closes it) and the collapsed search/switch cluster. It rides `--chrome-left`
  and does **not** fade, because a control that puts the whole panel back must be
  findable.
- **Top right:** fit, isolate, fullscreen — none changes the tree, they change
  your view of it. They fade after four still seconds.
- **`step`** did not come to the canvas — the panel now draws every mark as a row
  you cannot miss. It keeps its key and its palette row.

---

## 9. The keymap

| Key | Is |
|---|---|
| `/` | search (what `/` does everywhere) |
| `S` | sidebar |
| `A` | add taxon |
| `I` | isolate |
| `D` | dates (the store, URL and gates still say `ages`) |
| `P` | *unbound* — two keys for one action is one printed on nothing |

`bindings.test.ts` holds the badge/label census at one exception (Fullscreen on
`E`); `/` **Search** is not a letter and so is not in the census.

---

## 10. Below `DOCK_W`

The panel becomes an overlay drawer with a scrim, the canvas keeps the whole
window, and **the drawer starts shut** whatever the stored flag says (the flag is
about the docked column). `max-width: calc(100vw − 56px)` leaves a strip of
canvas showing.

---

## 11. Accessibility

- The panel is an `<aside>` (`complementary`), not `<nav>` — nothing in it
  navigates and half of it acts on the canvas, one destructively.
- **A shut panel is `inert`.** Hidden by `transform` alone it stays in the tab
  order — an off-screen focus trap.
- Disabled controls are `aria-disabled` and stay focusable.
- Every control in the panel has a palette command; `App.test.tsx` walks
  `bindings.ts` against the rendered palette with a named exemption per row.

---

## 12. Where the code is

```
web/src/sidebar/useSidebar.ts     open, docked, storage, the two properties
web/src/sidebar/Sidebar.tsx       the shell, the sections, the landmark
web/src/sidebar/SearchEntry.tsx   the pill, in its own fixed layer
web/src/sidebar/TaxaList.tsx      the layers panel
web/src/chrome/CanvasChrome.tsx   the toggle and the view cluster
web/src/canvas/capability.ts      BIOLUM_AVAILABLE, asked once
```

Gates: `sidebar/layout.test.ts`, `sidebar/TaxaList.test.tsx`, and `App.test.tsx`
/ `App.bare.test.tsx`.
