/**
 * Concestor.
 *
 * Pick species, see the minimal subtree connecting them through their common
 * ancestors, laid out against deep time.
 *
 * Every action has a command *and* a button. The keyboard is first class and no
 * longer exclusive: `chrome/bindings.ts` holds every key, the control bar draws
 * the same rows as buttons with their keys printed on them, and both paths run
 * the same callback. Confirmations are brief HUD toasts — the single exception
 * is clearing the canvas, which asks first; `chrome/Confirm.tsx` says why.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  api,
  ApiError,
  type FossilTaxon,
  type NodeDetail,
  type PathNode,
  type RandomPool,
  type SearchHit,
} from "./api";
import { pickFrom, randomKind, SPECIES_PHRASE } from "./corpora";
import { Graph } from "./canvas/Graph";
import { isScientificItalic } from "./canvas/NodeMark";
import { Detail } from "./detail/Detail";
import { CardPending } from "./detail/blocks";
import { FossilCard } from "./detail/FossilCard";
import { useCards } from "./detail/cards";
import { idxFromKey, selectionKeyFor } from "./detail/target";
import {
  buildGrafts,
  graftIdx,
  isGraftIdx,
  makeGraft,
  parseGraftKey,
} from "./tree/graft";
import { useGraftRefusals } from "./tree/refusals";
import {
  Palette,
  ABOUT_SECTION,
  type Command,
  type PaletteFilter,
  type Scope,
  type Suggestions,
} from "./palette/Palette";
import { forgetRecent, loadRecent, rememberRecent } from "./palette/recent";
import { OpeningCarousel } from "./chrome/OpeningCarousel";
import { keysOf, nextOpening, type Opening } from "./openings";
import { Confirm } from "./chrome/Confirm";
import { Controls, type ControlGroup, type ControlId } from "./chrome/Controls";
import { PendingLine, usePending } from "./chrome/Pending";
import { kbd, matchKey } from "./chrome/bindings";
import { FULLSCREEN_AVAILABLE, useFullscreen } from "./chrome/fullscreen";
import { useIdle } from "./chrome/idle";
import { useWindowKeys } from "./chrome/keys";
import { useToasts } from "./chrome/toasts";
import { prefersReduced } from "./chrome/motion";
import { goAbout } from "./route";
import { NextOpening } from "./chrome/NextOpening";
import { resetUsage } from "./palette/fuzzy";
import { useBoot } from "./state/boot";
import { useTree } from "./state/store";
import type { LabelMode } from "./tree/naming";
import { laneHue } from "./tree/layout";
import { divergenceFor, nestedSelections } from "./tree/naming";

/**
 * What the label command switches to next, and how each state describes itself.
 *
 * A table rather than a chain of ternaries, because three states in one row
 * means the title, the subtitle and the destination all have to agree about
 * where the press lands — and the palette prints the first two while the
 * handler follows the third. Written once, they cannot disagree.
 *
 * The order is the chip's own, left to right: **off → common → scientific →
 * off**. Pressing `L` walks the segments the way they are drawn, so the control
 * is a picture of what the key does rather than a second thing to learn — and
 * with the default sitting in the middle, no state is more than two presses
 * from home whichever way the reader went.
 */
const LABEL_TURN: Record<
  LabelMode,
  { next: LabelMode; title: string; subtitle: string }
> = {
  off: {
    next: "common",
    title: "common names",
    subtitle: "The name people use, for species, genera and subspecies",
  },
  common: {
    next: "scientific",
    title: "scientific names",
    subtitle: "The name in the taxonomy, on every mark that has one",
  },
  scientific: {
    next: "off",
    title: "no labels",
    subtitle: "The tree as a shape: marks, traces and silhouettes",
  },
};

/**
 * There is no `RANDOM_CANDIDATES` any more, and what it was for is now free.
 *
 * A random pick used to ask the server for twelve and use one. The extras
 * bought the one thing a single server-side pick could not have — the certainty
 * that the confirmation is true, because adding a species already on the canvas
 * changes nothing and a toast reading "Added Pallas's cat" over an unchanged
 * canvas is worse than no command at all — and they bought it by guessing that
 * twelve would be enough.
 *
 * The guess is gone rather than widened. The pool is here now, so the filter
 * runs over all 13,918 before anything is chosen: a pick is drawn from what is
 * *not* on the canvas, so it cannot be a no-op, and there is no number to get
 * wrong. That is the whole reason the draw belongs on this side — which taxa
 * are already drawn is a fact about this canvas that no request ever carried.
 */

/**
 * Which controls are pointed at once an opening has finished drawing, and what
 * the tray under them says.
 *
 * The three ways to put something of your own on the canvas, which is exactly
 * the bar's whole `lead` slot — and it has to stay exactly that, because
 * `Controls` outlines a contiguous run of *groups* whose every action is marked
 * here. A fourth button in either group would silently take the outline off
 * both. That grouping is the claim: it is **one** invitation with three doors,
 * and three separately decorated buttons said there were three invitations.
 *
 * The line was a sentence on the end of the answer's own toast once — "press S
 * to search, or R for a surprise" — and both halves of that were wrong. It
 * competed with the reply to the question the reader had actually asked, and it
 * named keys, when what a reader who has only ever pressed a carousel card is
 * missing is *where*. Under the buttons it needs neither: the badges are
 * directly above it, so the copy can be the invitation and nothing else.
 *
 * **The line goes to two surfaces and `TIPPED` only to one.** Below 620px there
 * are no three doors — the bar is not drawn and `chrome/PaletteFab.tsx` is the
 * whole of the chrome — so the outline has nothing to go round and the sentence
 * comes out the left of that button instead. It is the same string sent the same
 * way to both, which is deliberate: an invitation worded differently depending
 * on the window is two invitations.
 */
const TIPPED: ControlId[] = ["palette", "species", "random-species"];
const TIP_LINE = "Now put something of your own beside it";

/**
 * How long the invitation waits before it is made.
 *
 * It used to arrive on the same frame as the answer, at the top of a screen
 * whose bottom had just been given two lines of prose the reader had *asked
 * for*, above a tree that had just finished moving. Everything worth looking
 * at was somewhere else, so the one moment the outline was new — the only
 * moment a pulse actually reads as new — was spent while nobody was looking at
 * it. By the time they were, it had been breathing long enough to have become
 * part of the furniture.
 *
 * So it waits for the reader to be done with the answer, and **the two ways of
 * being done both count** — see `tipShown`. The timer is the one for a reader
 * who is still reading; dismissing the answer is the one for a reader who has
 * finished early and has told us so.
 *
 * The dismissal clause is not just a courtesy to fast readers: without it this
 * offer could land *after* the flyout's, and `Afterglow` above is why that
 * order matters. With it the two arrive together at worst, and the flyout is
 * small and in a corner while this is a pulsing outline under the reader's
 * eyes, so "offered second" survives on prominence where it stops being true
 * on time.
 *
 * Long enough to read the reveal without racing, and no longer. The carousel
 * spends 10.6–13.6 s on two lines of the same prose — `rotation.ts`'s
 * `dwellFor`, which is reading time plus a reach — but that is paced for
 * somebody who has not started reading yet; here the reader has been reading
 * since the tree settled.
 */
const TIP_DELAY_MS = 5000;

/**
 * What is being offered after an opening, and which one it was about.
 *
 * Two beats rather than one, and they never overlap: `reveal` is the answer to
 * the question, pinned until the reader is done with it, and `next` is the
 * offer of another question, which is only made once they are. Asking somebody
 * what to do next while they are still reading what just happened is how a
 * conversion moment becomes an interruption.
 *
 * The controls are tipped through both, because the invitation this holds is
 * not the one the flyout makes: `next` offers another of ours, the tips offer
 * the reader their own, and the second stands whether or not they want the
 * first.
 */
type Afterglow = { at: "reveal" | "next"; opening: Opening };

export default function App() {
  const tree = useTree();
  /** Everything this app says in words — see `chrome/toasts.ts`. */
  const { toasts, toast } = useToasts();
  /**
   * The three requests made before a reader has asked for anything.
   *
   * `setAbout` is here because a random pick may have to re-read `build_id`
   * past the memo when a deploy lands mid-session; `state/boot.ts` is the
   * account, and it is the only write to it from outside that hook.
   */
  const { about, setAbout, reachable, timescale, starters } = useBoot();
  // Closed on load. The canvas is the page; the boot hint says how to open it.
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [scoped, setScoped] = useState(false);
  /** Non-null when the palette is answering about one corpus only. */
  const [filter, setFilter] = useState<PaletteFilter | null>(null);
  const [confirmClear, setConfirmClear] = useState(false);
  const [fitSignal, setFitSignal] = useState<{
    kind: "all" | "selection";
    token: number;
  } | null>(null);
  /**
   * A fossil row the reader clicked in the drill-down lane.
   *
   * Kept apart from `focusedIdx` because a fossil is not a node: it has no
   * ancestor path, so it cannot be selected, added, isolated or linked to, and
   * pretending otherwise would offer four commands that do nothing. What it
   * has is an attachment point, and the actions are about that.
   */
  const [pickedFossil, setPickedFossil] = useState<FossilTaxon | null>(null);
  /**
   * Whether the canvas is already showing the fit, reported by the graph.
   *
   * Starts false so the command exists before the first report lands; a
   * momentarily-offered Fit is a smaller error than a permanently missing one
   * if the graph never mounts.
   */
  const [viewFit, setViewFit] = useState(false);
  /**
   * A random pick is out.
   *
   * This used to be the app's one guaranteed wait: `/v1/random` was fetched
   * `no-store` — or every press would have returned the first press's answer —
   * so it was the single request that could never be memoised, and measured
   * against production it cost **1.2 s**. Both halves of that are gone. The
   * pool is fetched once and cached like everything else, and the lookup after
   * a draw is an immutable URL the edge can answer.
   *
   * The state stays, because the first press of a session still pays for the
   * pool and a fossil roll still pays for `drawFossil`. A press that is usually
   * instant and occasionally not is exactly the case a pending flag is for.
   */
  const [picking, setPicking] = useState(false);

  /**
   * The focused fossil, when `sel` names one.
   *
   * A graft is selectable exactly like a node — same click, same `sel=` in the
   * URL, same card slot — and the key namespaces keep the two apart without a
   * second parameter: `pbdb108454` cannot collide with an OTT id or a node key.
   */
  const focusedTaxonNo = useMemo(
    () => (tree.view.selected ? parseGraftKey(tree.view.selected) : null),
    [tree.view.selected],
  );

  const focusedIdx = useMemo(() => {
    if (!tree.view.selected) return null;
    // A focused graft's canvas index, so the mark highlights and the lineage
    // dims around it exactly as a node's would. Negative, so nothing that
    // walks the topology can act on it.
    if (focusedTaxonNo !== null) return graftIdx(focusedTaxonNo);
    const k = tree.view.selected;
    // `idx:N` is what a link into a node we hold no key for produces. It is a
    // real key the API answers, and resolving it here is what keeps a link into
    // something already on the canvas from opening the card while leaving every
    // mark unlit — which reads as the click having half worked.
    const byIdx = idxFromKey(k);
    if (byIdx !== null) return tree.nodes.has(byIdx) ? byIdx : null;
    const direct = tree.idxOf.get(k) ?? tree.idxOf.get(`ott${k}`);
    if (direct !== undefined) return direct;
    const n = [...tree.nodes.values()].find(
      (x) => x.key === k || String(x.ott_id) === k,
    );
    return n?.idx ?? null;
  }, [tree.view.selected, focusedTaxonNo, tree.idxOf, tree.nodes]);

  /**
   * The key the node card is about — which is the selection itself, and no
   * longer whatever the canvas managed to resolve it to.
   *
   * The card used to be fetched through `focusedIdx`, so it could only open on
   * something already in `tree.nodes` — something drawn, or on the path of
   * something drawn. That was invisible while the only way to select was to
   * click a mark. It is the whole question now that a classification rung is a
   * link: *Carnivora* is three rungs above *Felidae* and is not on the canvas,
   * and under the old rule clicking it changed the URL and nothing else.
   *
   * So the two are decoupled. `focusedIdx` still means "which mark to light",
   * and is null for a taxon that has none; this means "which card to show", and
   * asks the API directly.
   */
  const selectedNodeKey = focusedTaxonNo === null ? tree.view.selected : null;

  /**
   * Both cards: which one is open, what is on it, and what is still coming.
   *
   * `detail/cards.ts` holds the two fetches and the two placeholder gates. The
   * one value that has to come back out to this level rather than staying with
   * the card is `cardOpen`, because the *canvas* reads it — it reframes into the
   * strip beside an open card, and answering "is there a panel over the top
   * right" from a second expression is how the two start to disagree.
   */
  const { detail, fossilDetail, cardPending, fossilCardPending, cardOpen } =
    useCards(selectedNodeKey, focusedTaxonNo);

  /**
   * A shared link whose lineages have not arrived.
   *
   * Gated on `tree.loading` and not merely on "nothing is drawn yet", because
   * the second is also true of a link every one of whose keys resolved to
   * nothing — a stale id, a link made against an older build. That view has
   * already been explained by a toast and is not waiting for anything, so it
   * gets the front door back rather than a line that breathes for the rest of
   * the session.
   */
  const linkPending = usePending(
    tree.loading &&
      tree.view.keys.length > 0 &&
      tree.induced.rendered.length === 0,
  );

  /**
   * Anything at all is in flight, for the control bar.
   *
   * Not the card fetches: those have a placeholder of their own in the place
   * the answer will appear, and saying it twice puts the reader's attention in
   * the corner furthest from where they are looking.
   */
  const busy = usePending(tree.loading || tree.fossilsLoading || picking);

  // A broken taxon reaching the canvas means a link made before the palette
  // stopped offering them. Say what happened in the reader's language — the
  // audience is curious people, not systematists — and say that the lineage
  // was dropped, because the store has just removed it from the selection.
  useEffect(() => {
    for (const b of tree.broken) {
      toast(
        <>
          <strong>{b.name ?? b.key}</strong> is not monophyletic — its members
          sit in {b.attachmentPoints} separate{" "}
          {b.attachmentPoints === 1 ? "place" : "places"} on the tree rather
          than one, so there is no single branch to draw for it. It has been
          left out of this view; everything else in the link is unaffected.
        </>,
        true,
      );
      tree.dismissBroken(b.key);
    }
  }, [tree.broken, toast, tree.dismissBroken]);

  // A key in the URL that resolves to nothing — a mistyped id, or one from a
  // link made against a different build. Say which, and carry on drawing the
  // rest of the selection.
  useEffect(() => {
    for (const key of tree.unresolved) {
      toast(
        <>
          Nothing in this build matches <span className="mono">{key}</span>. It
          may be from a link made against an older release; the rest of the
          selection is unaffected.
        </>,
        true,
      );
      tree.dismissUnresolved(key);
    }
  }, [tree.unresolved, toast, tree]);

  const focusedNode =
    focusedIdx !== null ? tree.nodes.get(focusedIdx) : undefined;

  const addHit = useCallback(
    (hit: SearchHit) => {
      tree.add(hit.key);
      // Remembered here rather than inside the palette, because this is the one
      // place every add arrives — a search row, a starter row and a recent row
      // all land on this callback, and a reader who picks the same species
      // twice should see it move to the top rather than be recorded once.
      // Stamped with the build so a rebuilt dataset drops the list instead of
      // resurrecting six rows whose `idx` now names something else.
      rememberRecent(hit, about?.build_id ?? null);
      setPaletteOpen(false);
      toast(
        <>
          Added{" "}
          <strong
            className={isScientificItalic(hit.rank) ? "sci-italic" : undefined}
          >
            {hit.name ?? hit.key}
          </strong>
        </>,
      );
    },
    [tree, toast, about?.build_id],
  );

  /**
   * What an empty species palette offers.
   *
   * Recomputed when the palette *opens* rather than held in state, because the
   * recents change underneath it: a reader adds a species, closes the palette
   * and reopens it, and the row they just picked has to be at the top. Reading
   * `localStorage` is cheap enough to do on a keypress and is the only way to
   * be right without a second copy of the list living in React state.
   *
   * Null while closed so nothing is computed for a panel nobody is looking at.
   */
  const suggestions = useMemo<Suggestions | null>(
    () =>
      paletteOpen
        ? { recent: loadRecent(about?.build_id ?? null), starters }
        : null,
    [paletteOpen, about?.build_id, starters],
  );

  /**
   * What a link on a card selects.
   *
   * A string is already a key. A number is a **node index**, and is turned into
   * the nicest key that addresses it: the node's own if we hold it, `idx:N`
   * otherwise. Both open the same card, so this is entirely about what the URL
   * a reader copies says — `ott244265` names a taxonomy, `idx:588427` names a
   * position in this build's arrays and means nothing outside it.
   */
  const selectTaxon = useCallback(
    (target: string | number) =>
      tree.select(selectionKeyFor(target, tree.nodes)),
    [tree],
  );

  const addNode = useCallback(
    (d: NodeDetail) => {
      tree.add(d.key);
      toast(
        <>
          Added{" "}
          <strong
            className={isScientificItalic(d.rank) ? "sci-italic" : undefined}
          >
            {d.name ?? d.key}
          </strong>
        </>,
      );
    },
    [tree, toast],
  );

  const removeNode = useCallback(
    (d: NodeDetail) => {
      // `remove` clears the selection when it removes the selected key, so the
      // card closes on the press that emptied it. That is right: the card is
      // about a lineage on the canvas, and there is no longer one.
      tree.remove(d.key);
      toast(
        <>
          Removed{" "}
          <strong
            className={isScientificItalic(d.rank) ? "sci-italic" : undefined}
          >
            {d.name ?? d.key}
          </strong>
        </>,
      );
    },
    [tree, toast],
  );

  /**
   * The opening whose answer is still owed, held until its tree is finished.
   *
   * A ref because nothing renders from it and setting it must not cost a
   * render: it is written on the press and read once, on the frame the
   * sequence ends.
   */
  const owedReveal = useRef<Opening | null>(null);

  /**
   * The two beats after an opening finishes, or null.
   *
   * One piece of state for the pinned answer, the flyout and the tipped
   * controls, because they are one moment and not three. Splitting them was the
   * first draft and it went wrong immediately: three booleans admit states the
   * design does not have — an answer pinned under a flyout offering the next
   * one, tips lit hours after the reader started building their own tree — and
   * each would have needed its own rule for every way out of here.
   */
  const [afterglow, setAfterglow] = useState<Afterglow | null>(null);

  /**
   * The reader has taken it from here, so stop pointing.
   *
   * Called from every action the tips advertise and from anything that puts the
   * reader in charge of the canvas — searching, rolling a die, clearing,
   * drawing a different opening. Not from a *pointless* press: moving the
   * selection or switching the axis is looking at the tree they were given, not
   * making one, and an invitation withdrawn for that is one nobody got to take.
   */
  const settle = useCallback(() => setAfterglow(null), []);

  /**
   * Draw an opening, and get out of its way.
   *
   * Both surfaces that offer one — the empty canvas and the about panel — close
   * on the press, and the toast names the claim rather than the taxa. "Added
   * Human, Gombessa, Great White Shark" is a list of what was pressed; the
   * reader pressed it to find out whether they are a fish.
   *
   * **Which sentence, and when, is decided by whether the taxa arrive in
   * sequence.** Drawn all at once there is nothing to wait for, so the reveal
   * goes up with the tree exactly as it always did. Drawn one at a time the
   * reveal would be answering the question before the canvas does — and the
   * canvas stating the claim itself is the whole of `state/sequence.ts`'s
   * argument — so the question goes up instead and the answer is held until the
   * last taxon has landed.
   *
   * Per-step copy is a different and much larger piece of work: fifteen
   * openings times three to five beats, every line still bound by
   * `openings.ts`'s rule that the copy claims relationships and never dates.
   * The `sequence` / `sequence-cut` causes in the beacon exist to settle
   * whether it is worth writing.
   */
  const openOpening = useCallback(
    (o: Opening) => {
      setPaletteOpen(false);
      // Whatever the last opening left on screen goes with the press, including
      // a flyout offering this very question.
      setAfterglow(null);
      if (tree.openSequenced(keysOf(o), o.axis, prefersReduced())) {
        owedReveal.current = o;
        toast(o.question);
        return;
      }
      setAfterglow({ at: "reveal", opening: o });
    },
    [tree, toast],
  );

  /**
   * The sequence has ended: pay the answer.
   *
   * The falling edge rather than a completion callback, because a sequence ends
   * two ways and both owe the reader the answer — one that ran to the end, and
   * one they interrupted, which was interrupted in the *telling* and still
   * finished the tree. Withholding it from the second would punish somebody for
   * taking the wheel.
   */
  const wasSequencing = useRef(false);
  useEffect(() => {
    if (wasSequencing.current && !tree.sequencing) {
      const o = owedReveal.current;
      owedReveal.current = null;
      if (o) setAfterglow({ at: "reveal", opening: o });
    }
    wasSequencing.current = tree.sequencing;
  }, [tree.sequencing]);

  /**
   * Done reading the answer — so offer another question.
   *
   * The answer is **pinned and not timed**, which is the one thing about it
   * worth arguing over. Every other toast in this app reports something the
   * reader did and can be missed without cost: they pressed add, the thing was
   * added, the canvas says so. This one is the *reply* to a question they asked
   * and it is the only place the reply is written down — a five-second window on
   * two lines of prose, arriving at the exact moment a reader is looking at a
   * tree that has just finished moving, is a reply nobody reads.
   *
   * So it stays until it is dismissed, and dismissing it is what says the reader
   * is ready for something else. That is the whole reason the flyout waits for
   * this rather than arriving with it.
   */
  const dismissAnswer = useCallback(() => {
    setAfterglow((a) => {
      if (a?.at !== "reveal") return a;
      const next = nextOpening(a.opening);
      return next ? { at: "next", opening: next } : null;
    });
  }, []);

  /**
   * When the control bar makes its offer — see {@link TIP_DELAY_MS}.
   *
   * Two clocks, whichever finishes first, because "the reader is done with the
   * answer" has two tells and only one of them is a timer. `at: "next"` means
   * they dismissed it, which is the tell they gave us themselves; the delay is
   * for everyone who is still reading and has told us nothing.
   *
   * `usePending` is borrowed here for its contract rather than its subject —
   * *held true continuously for this long* — and the borrowed half that
   * matters is the **reset on the falling edge**. A reader who draws a second
   * opening while the first tip is still pending gets the new tree's clock and
   * not the leftover of the tree they replaced, which is exactly the bug the
   * hook's own doc describes for two round trips in a row.
   */
  const tipDue = usePending(afterglow !== null, TIP_DELAY_MS);
  const tipShown = afterglow !== null && (tipDue || afterglow.at === "next");

  /**
   * Rule 2: any interaction ends the sequence, at the finished tree.
   *
   * Capture phase and on `window`, so this runs before the handler the press
   * was actually for — a reader pressing `S` mid-sequence gets the palette
   * *and* the rest of their tree, rather than one of the two. The press is
   * never swallowed: aborting is a side effect of interacting, not a mode the
   * first press is spent leaving.
   *
   * Three events cover it: a key, a pointer going down anywhere (a mark, a
   * control-bar button, the carousel), and a wheel, which is how the canvas is
   * panned and zoomed and reaches no handler of ours at all.
   */
  useEffect(() => {
    if (!tree.sequencing) return;
    const cut = () => tree.cutSequence();
    const opts = { capture: true } as const;
    window.addEventListener("keydown", cut, opts);
    window.addEventListener("pointerdown", cut, opts);
    window.addEventListener("wheel", cut, { capture: true, passive: true });
    return () => {
      window.removeEventListener("keydown", cut, opts);
      window.removeEventListener("pointerdown", cut, opts);
      window.removeEventListener("wheel", cut, opts);
    };
  }, [tree.sequencing, tree.cutSequence]);

  const share = useCallback(() => {
    const url = window.location.href;
    navigator.clipboard
      ?.writeText(url)
      .then(() => toast("Link copied — it opens on this exact tree"))
      .catch(() => toast("Could not reach the clipboard", true));
  }, [toast]);

  // The window, not the tree. A refusal comes back as a toast rather than as
  // silence — see `chrome/fullscreen.ts` for why the browser is allowed to say
  // no to a press it was asked for by a press.
  // Warned rather than announced, like the clipboard's own failure above: the
  // reader asked for something and did not get it. The inline arrow is safe
  // because the hook holds it in a ref — nothing downstream re-renders on it.
  const fullscreen = useFullscreen((why) => toast(why, true));

  const present = useMemo(
    () => new Set(tree.induced.leaves),
    [tree.induced.leaves],
  );
  const presentFossils = useMemo(
    () => new Set(tree.view.fossils),
    [tree.view.fossils],
  );

  /**
   * A fossil chosen from the palette.
   *
   * Draws it, and adds the clade it hangs below when that clade is not on the
   * canvas — because otherwise the one thing the reader asked for produces no
   * visible change and a notice explaining why. Searching a fossil by name is a
   * statement that you want to see it; the branch it needs to hang from is
   * machinery, and making the reader work that out for themselves would be
   * offering a puzzle instead of an answer.
   *
   * Adding the host is a real change to the selection, so it is named in the
   * toast rather than done silently.
   */
  const drawFossil = useCallback(
    async (f: FossilTaxon) => {
      const taxonNo = f.pbdb_taxon_no ?? 0;
      if (taxonNo <= 0) return;
      tree.addFossil(taxonNo);
      setPaletteOpen(false);

      const placeable =
        tree.induced.rendered.length > 0 &&
        makeGraft(f, tree.induced, tree.nodes) !== "off-tree";
      if (placeable) {
        toast(
          <>
            Drew <strong>{f.name}</strong>
          </>,
        );
        return;
      }
      // The attach node is by definition *not* on the canvas here, so it is not
      // in `tree.nodes` either and there is no key to add. `/v1/fossil` carries
      // the resolved node for exactly this; the request is already cached by
      // the time the store's own resolve runs.
      let host: PathNode | null = null;
      try {
        host = (await api.fossil(taxonNo)).attach ?? null;
      } catch {
        // Falls through to the plain confirmation; the graft is in the URL
        // either way and the refusal notice will explain what to do.
      }
      if (!host) {
        toast(
          <>
            Drew <strong>{f.name}</strong>
          </>,
        );
        return;
      }
      tree.add(host.key);
      toast(
        <>
          Drew <strong>{f.name}</strong>, and added{" "}
          <strong>{host.name ?? "the clade it hangs below"}</strong> so it has a
          branch to hang from
        </>,
      );
    },
    [tree, toast],
  );

  /**
   * Put something on the canvas without being asked what.
   *
   * The empty canvas is a command list, and every other command on it assumes
   * you have already thought of a species. Nobody browses millions of them,
   * and for an audience of curious people rather than systematists the first
   * move is the hard one — so there has to be an action that answers "show me
   * *something*".
   *
   * The pool holds only taxa that carry their own drawing. That filter is the
   * whole design: a uniform draw over the corpus returns an unnamed `mrcaott…`
   * clade or an undescribed mite, and a surprise that is mostly nothing to look
   * at is one a reader stops pressing. `store/random.go` has the two node
   * filters, the five fossil ones, and the counts.
   *
   * **The draw is here and not on the server**, and the reason is `present`.
   * Which taxa are on this canvas is a fact no request ever carried, so a
   * server-side pick had to over-ask twelve candidates and hope one was unused.
   * With the pool in hand the exclusion happens before the choice, so a pick is
   * always usable and always exactly one lookup. It also deleted the API's only
   * uncacheable response — `store/random.go` is the account.
   *
   * **One command, two corpora**, weighted by {@link RANDOM_FOSSIL_CHANCE}.
   * There is no second key and no second row in the palette, because the thing
   * a second key would let the reader choose — which catalogue the animal is
   * filed in — is not something they can know in advance and not something they
   * asked about. A fossil roll that comes back with nothing falls through to a
   * species rather than reporting a failure: the reader pressed *surprise me*,
   * and "the pool you did not pick was empty" is an answer to a question they
   * never asked.
   */
  const randomPick = useCallback(async () => {
    setPaletteOpen(false);
    settle();
    setPicking(true);
    try {
      // `about` has landed by the time a human can press this, but not by
      // construction — and `api.about()` is memoised, so the fallback joins the
      // boot request already in flight rather than making a second one.
      //
      // The retry is for the one case that cannot be recovered from by asking
      // the same question twice: a deploy landing mid-session. `build_id` was
      // read once at boot and remembered, the pool for that build is no longer
      // served, and the 404 says so — so the id is re-read past the memo before
      // asking again, and a reader who left a tab open across a release gets a
      // pick rather than an error they can only clear by reloading.
      let build = about ?? (await api.about());
      let pool: RandomPool;
      try {
        pool = await api.randomPool(build.build_id);
      } catch (e) {
        if (!(e instanceof ApiError) || e.status !== 404) throw e;
        build = await api.about(true);
        setAbout(build);
        pool = await api.randomPool(build.build_id);
      }

      if (randomKind(Math.random()) === "fossil") {
        const no = pickFrom(
          pool.fossils,
          (n) => presentFossils.has(n),
          Math.random(),
        );
        if (no !== null) {
          // `/v1/fossil` returns a `FossilDetail`, which *is* a `FossilTaxon`
          // with the card's extras on top — so this is the graft's own input
          // and needs no conversion. `drawFossil` does the rest, including
          // adding the clade the fossil hangs below when it is not on the
          // canvas. That is not an extra, it is the whole of the pick: a fossil
          // the tree does not contain almost always attaches to a branch nobody
          // has drawn yet, so without it the usual outcome would be a refusal
          // for something never chosen by name.
          await drawFossil(await api.fossil(no));
          return;
        }
        // Fall through to a species. Nothing is said about the roll — the
        // reader asked for something to look at, not for a report on a corpus.
      }

      if (pool.nodes.length === 0) {
        toast(
          "This build has no silhouette resolution, so there is no pool of drawn species to pick from.",
          true,
        );
        return;
      }
      const idx = pickFrom(pool.nodes, (n) => present.has(n), Math.random());
      if (idx === null) {
        // Only reachable with the entire pool already on screen, which needs a
        // canvas of 13,918 species. Saying so beats a confirmation that lies.
        toast("Every species in the pool is already on the canvas.", true);
        return;
      }
      // `idx:N` is a real key the API answers, and the response carries the
      // canonical one — so the canvas is keyed the way a link or a search would
      // have keyed it, rather than by an index that means nothing across builds.
      const hit = await api.node(`idx:${idx}`);
      tree.add(hit.key);
      toast(
        <>
          Added{" "}
          <strong
            className={isScientificItalic(hit.rank) ? "sci-italic" : undefined}
          >
            {hit.name ?? hit.key}
          </strong>
          {hit.vernacular ? <> — {hit.vernacular}</> : null}
        </>,
      );
    } catch {
      toast("Could not reach the search API for a random pick", true);
    } finally {
      setPicking(false);
    }
  }, [tree, toast, about, present, presentFossils, drawFossil, settle]);

  /**
   * Nothing is drawn, which is the condition the empty canvas answers.
   *
   * Two surfaces read it and they may not disagree: this decides whether the
   * invitation is on screen, and it is handed to the canvas to decide whether
   * the mode panel is. The panel sits bottom-left and the invitation is a
   * centred column, and on a short window the two were drawn through each
   * other — so a second expression saying nearly this would not error, it would
   * put a key badge back on top of the `LABELS` chip. `canvas/Graph.tsx` has
   * the rest of why the panel is the one that goes.
   */
  const nothingDrawn = tree.induced.rendered.length === 0;

  /**
   * Nothing on the canvas at all.
   *
   * Declared here rather than beside its other user further down, because the
   * command list needs it too and two copies of "is the canvas empty" is how
   * the two surfaces start disagreeing.
   *
   * A stricter question than `nothingDrawn`: a graft hangs off a drawn branch,
   * so the two only ever part while a fossil add is in flight — and the command
   * list would rather be a beat late offering `clear` than offer it over
   * nothing.
   */
  const empty = nothingDrawn && tree.view.fossils.length === 0;

  /**
   * Walk the selection, forward or back.
   *
   * Sits above the command list rather than beside the other handlers because
   * the list now holds a row for it, and a `const` referenced in a `useMemo`'s
   * dependency array has to be initialised before that array is read. Dropping
   * it from the deps instead would leave the row's closure holding whichever
   * `focusedIdx` was current when the list was last rebuilt.
   */
  const stepSelection = useCallback(
    (back: boolean) => {
      const ls = tree.induced.leaves;
      if (ls.length === 0) return;
      const at = focusedIdx === null ? -1 : ls.indexOf(focusedIdx);
      const next = ls[(at + (back ? -1 + ls.length : 1)) % ls.length];
      const n = next !== undefined ? tree.nodes.get(next) : undefined;
      if (n) tree.select(n.key);
    },
    [tree, focusedIdx],
  );

  const commands: Command[] = useMemo(() => {
    const base: Command[] = [
      // Absent while the canvas is already showing the fit, and absent on an
      // empty one. A command that would visibly do nothing is worse than a
      // missing command: the reader presses it, watches for a change, and
      // learns that this palette answers some presses and not others.
      // `viewFit` is asked of the live viewport rather than remembered — see
      // `reportFit` in `canvas/Graph.tsx`.
      ...(empty || viewFit
        ? []
        : [
            {
              id: "fit-all",
              title: "Fit all",
              subtitle: "Frame the whole induced subtree",
              icon: "⤢",
              keys: kbd("fit"),
              section: "View",
              run: () => {
                setFitSignal({ kind: "all", token: Date.now() });
                setPaletteOpen(false);
              },
            },
          ]),
      {
        id: "axis",
        title: `Switch time axis to ${tree.view.axis === "log" ? "linear" : "logarithmic"}`,
        // Each names what you would be switching *to*, and neither disparages
        // the other. The old copy called linear the one that "puts every recent
        // divergence in one pixel", which was a fair warning while symlog was
        // the default and is a poor way to describe the default now.
        subtitle:
          tree.view.axis === "log"
            ? "True proportions; recent splits crowd the present"
            : "Symlog: linear to 1 Ma, logarithmic above — room for recent splits",
        icon: "⇄",
        keys: kbd("axis"),
        section: "View",
        run: () => {
          tree.setAxis(tree.view.axis === "log" ? "linear" : "log");
          setPaletteOpen(false);
        },
      },
      {
        // The label switch, as a command. One row that cycles rather than three
        // rows that set, because the palette is a list of *actions* and "set
        // labels to scientific" is not one when they already are — the axis row
        // above makes the same call and names what you would be switching to.
        // `LABEL_TURN` is what keeps this row's title, its subtitle and the
        // key's handler agreeing about where the press lands.
        id: "labels",
        title: `Switch labels to ${LABEL_TURN[tree.labels].title}`,
        subtitle: LABEL_TURN[tree.labels].subtitle,
        hint:
          "The canvas used to decide this from how far you had zoomed, which meant pulling back " +
          "to see the whole tree took every name with it. It is yours now. Common names exist " +
          "for species, genera and subspecies only — about 4% of the tree — so that setting is a " +
          "mixture, and the italics are what tell you which name you are reading.",
        icon: "Aa",
        keys: kbd("labels"),
        section: "View",
        run: () => {
          tree.setLabels(LABEL_TURN[tree.labels].next);
          setPaletteOpen(false);
        },
      },
      {
        id: "ages",
        title: tree.ages ? "Hide ages" : "Show ages",
        subtitle: tree.ages
          ? "Leave the dates to the axis"
          : "Print each mark's date, bound or fossil range",
        icon: "⌛",
        keys: kbd("ages"),
        section: "View",
        run: () => {
          tree.setAges(!tree.ages);
          setPaletteOpen(false);
        },
      },
      {
        // "Every action has a command *and* a button" — the button is the
        // switch above the axis, and this is the command. Worth a row in its
        // own right: it is the one thing in this app a reader would never guess
        // exists, and the palette is where you go to find out what does.
        id: "biolum",
        title: tree.biolum
          ? "Turn bioluminescence off"
          : "Turn bioluminescence on",
        subtitle: tree.biolum
          ? "Back to the plain instrument"
          : "Light the canvas like the deep sea",
        hint:
          "Additive bloom on the branches, light travelling down each lineage, and a drifting " +
          "field of plankton behind the tree. Nothing about the data changes: every dash, every " +
          "tier and every figure is identical in both states. It is yours for this tab only — " +
          "a tree you share arrives unlit, however you are reading it.",
        icon: "✷",
        keys: kbd("biolum"),
        section: "View",
        run: () => {
          tree.toggleBiolum();
          setPaletteOpen(false);
        },
      },
      // Gated on the browser, like the button — the two surfaces answer the
      // same question and a command for a thing that cannot happen is worse
      // here than on the bar, because a palette row gives no state to read.
      ...(FULLSCREEN_AVAILABLE
        ? [
            {
              id: "fullscreen",
              // Says which way the press goes, where the button only lights.
              // The bar has a state to show and one word to show it with, so it
              // says **Fullscreen** and goes bright; a palette row is read once,
              // in a list, with nothing beside it to compare against, and
              // "Fullscreen" there would not say whether it takes you in or out.
              title: fullscreen.on ? "Leave fullscreen" : "Go fullscreen",
              subtitle: fullscreen.on
                ? "Give the browser its chrome back"
                : "Spend the tab strip and the URL bar on the time axis",
              hint:
                "A tree is wide, and the browser's own chrome is the easiest few centimetres of " +
                "it to buy back. Nothing about the layout changes beyond the width it is drawn " +
                "against — the canvas reframes the way it does on any window resize, and a " +
                "reader who has zoomed into a corner keeps their view. Escape leaves it too, " +
                "and the browser takes that key before this app sees it.",
              icon: "⛶",
              keys: kbd("fullscreen"),
              section: "View",
              run: () => {
                fullscreen.toggle();
                setPaletteOpen(false);
              },
            },
          ]
        : []),
      {
        // No key of its own, and that is the cost of a modifier-free surface
        // rather than an oversight: the letters that would be honest here — `s`
        // for share, `l` for link — are the two most-used bindings in the app.
        // It is one of the few actions nobody reaches for mid-flow.
        id: "share",
        title: "Copy shareable link",
        // **Not "all view state lives in the URL"**, which is what this said
        // and which the bioluminescence row four entries above already
        // contradicted: *a tree you share arrives unlit, however you are
        // reading it.* `store.ts` puts the tree, the axis, the selection, the
        // isolate and the drill in the link and holds the light, the labels
        // and the ages in `sessionStorage` on purpose — a setting that is a
        // claim about the **reader** may not ride in a link, and one made with
        // the labels off would open on a canvas of unnamed dots.
        //
        // So the subtitle promises the thing that does travel, and the hint
        // says what does not. Both matter to the same reader: somebody who
        // sends a bioluminescent canvas and is told it is "the exact view"
        // finds out otherwise from whoever opens it.
        subtitle: "It opens on this exact tree",
        hint:
          "The tree, the time scale, the selection, any fossil you have pinned to a branch, " +
          "and anything you have isolated or drilled " +
          "into are all in the address bar. The canvas settings are not: labels, ages and the " +
          "light belong to how you are reading, not to what you found, so they stay in this tab.",
        icon: "↗",
        section: "View",
        run: () => {
          share();
          setPaletteOpen(false);
        },
      },
      // Filed under Selection rather than under a section of its own: what it
      // does is add to the selection, and the reader who wants it is the reader
      // looking at an empty canvas wondering what to put on it.
      //
      // One row where there were two. The second read "Draw a random fossil",
      // and having both in a list is how the palette taught the split the rest
      // of this change removes — a reader scanning two rows has to work out
      // which of two catalogues holds the animal they have not met yet.
      {
        id: "random-species",
        title: "Add a random species",
        subtitle: "Something illustrated, picked for you",
        hint:
          "Draws from the ~14,000 taxa that have a silhouette of their own, so the pick " +
          "always arrives with a picture rather than a bare name. Roughly one in five comes " +
          "from the fossil record instead, pinned to its branch at its own date. Press again " +
          "to keep going — each one joins the tree through its common ancestors with " +
          "whatever is already here.",
        icon: "✦",
        keys: kbd("random-species"),
        section: "Selection",
        run: () => void randomPick(),
      },
      // The row the sub-620px layout was already relying on. The bar is not
      // drawn on a phone, and the licence for that is that every control on it
      // has a command here — `step` had a key and a button and no row, so on a
      // touch device it could not be reached at all. `App.test.tsx` walks
      // `bindings.ts` now rather than trusting the claim.
      //
      // Absent rather than disabled on an empty canvas, which is the same rule
      // `fit-all` above states: the bar can grey a button and say why in a
      // tooltip, and a palette row has nothing beside it to read.
      //
      // One row, where the bar draws one button and the keyboard has two
      // halves. `stepSelection` wraps — `% ls.length` — so going forward alone
      // reaches every leaf, and `⇧N` is a shortcut round the cycle rather than
      // anywhere the reader cannot otherwise get.
      ...(tree.induced.leaves.length === 0
        ? []
        : [
            {
              id: "step",
              title: "Go to the next species",
              subtitle: "Opens each card in turn, and wraps at the end",
              hint:
                "On a crowded canvas the marks are small targets, and this reaches every one of " +
                "them in order without asking you to hit any of them. It walks the species you " +
                "have added, in the order they are drawn, and comes back round to the first.",
              icon: "→",
              keys: kbd("step"),
              section: "Selection",
              run: () => {
                stepSelection(false);
                setPaletteOpen(false);
              },
            },
          ]),
      {
        id: "clear",
        title: "Clear the canvas",
        subtitle: "Remove every selection",
        icon: "×",
        keys: kbd("clear"),
        section: "Selection",
        run: () => {
          setPaletteOpen(false);
          setConfirmClear(true);
        },
      },
      // The openings are deliberately *not* here. They live on the empty canvas
      // and in the about panel, and that is enough of them.
      //
      // An opening is not additive: `tree.open` *replaces* the selection, the
      // fossils and the axis, because the claim it makes is only true of its
      // own set of taxa. Every other command in this list adds to, or acts on,
      // what is already drawn. Hiding them once the canvas was non-empty made
      // the rule safe but not coherent — a `Start here` section that appears
      // and disappears is a list the reader cannot learn — and on an empty
      // canvas the carousel is already showing the same questions, larger,
      // with their silhouettes, two feet from the palette that repeated them.
      {
        id: "about",
        title: "About Concestor",
        subtitle:
          "What this is, where the data comes from, what the dashes mean",
        icon: "i",
        section: ABOUT_SECTION,
        run: () => {
          setPaletteOpen(false);
          goAbout();
        },
      },
      {
        /*
          One command over two stores, and the title changed when the second
          one arrived.

          It said "Reset search ranking / Forget recency and frequency history",
          which was true of `fuzzy.ts` alone and became a half-truth the moment
          the species palette grew a band captioned **Recent**. Clearing the
          invisible half while a list of the reader's own picks stayed on screen
          would be the worst possible split: the store nobody can see gets
          forgotten, and the one they are looking at appears to ignore them.

          The id is unchanged on purpose — `sessionBoost` is keyed on it, so
          renaming it would silently discard the ranking anyone had built up for
          this row.
        */
        id: "reset-ranking",
        title: "Clear search history",
        subtitle: "Forgets your recent species and the ranking they feed",
        hint:
          "This browser remembers which species you have added, to list them " +
          "first and to rank what you search for. Both are stored here and " +
          "sent nowhere. This clears them together.",
        icon: "↺",
        section: ABOUT_SECTION,
        run: () => {
          resetUsage();
          forgetRecent();
          setPaletteOpen(false);
          toast("Search history cleared");
        },
      },
    ];

    if (focusedNode) {
      const nm = focusedNode.name ?? focusedNode.key;
      base.unshift(
        {
          id: "ctx-isolate",
          title: `Isolate the path to ${nm}`,
          subtitle: "Dim every other lineage",
          icon: "◎",
          keys: kbd("isolate"),
          section: "This node",
          contextual: true,
          run: () => {
            tree.toggleIsolate();
            setPaletteOpen(false);
          },
        },
        {
          id: "ctx-fit",
          title: `Fit to ${nm}`,
          icon: "⊹",
          keys: kbd("fit-selection"),
          section: "This node",
          contextual: true,
          run: () => {
            setFitSignal({ kind: "selection", token: Date.now() });
            setPaletteOpen(false);
          },
        },
      );
      // The branch *above* the focused node is the segment it arrived on, and
      // it is the only one a single node identifies unambiguously. The induced
      // root has none, which is why this is conditional rather than disabled.
      const anc = tree.induced.segments.get(focusedNode.idx)?.anc ?? null;
      if (anc !== null) {
        const open =
          tree.view.drill?.upper === anc &&
          tree.view.drill.lower === focusedNode.idx;
        base.unshift({
          id: "ctx-drill",
          title: open
            ? "Close the fossil lane"
            : `Show fossil occurrences along the branch to ${nm}`,
          subtitle: open
            ? "The lane below the chronogram"
            : "Intermediate clades, and what the rock records on this segment",
          icon: "⌗",
          ...(open ? { keys: kbd("escape") } : {}),
          section: "This node",
          contextual: true,
          run: () => {
            tree.setDrill(open ? null : { upper: anc, lower: focusedNode.idx });
            setPaletteOpen(false);
          },
        });
      }
      if (tree.induced.leaves.includes(focusedNode.idx)) {
        base.unshift({
          id: "ctx-remove",
          title: `Remove ${nm}`,
          icon: "−",
          keys: kbd("remove"),
          section: "This node",
          contextual: true,
          run: () => {
            tree.remove(focusedNode.key);
            setPaletteOpen(false);
            toast(`Removed ${nm}`);
          },
        });
      }
    }
    return base;
  }, [
    tree,
    about,
    focusedNode,
    toast,
    share,
    randomPick,
    stepSelection,
    empty,
    viewFit,
    fullscreen,
  ]);

  /**
   * What a fossil offers, which is short and deliberately so.
   *
   * It has no ancestor path, so there is no lineage to draw and nothing to
   * select. Every honest action is about the node it attaches to — architecture
   * §3.4's claim is "this taxon belongs somewhere below X", and X is the only
   * thing on the canvas the reader can act on.
   */
  /**
   * The fossils currently drawn against the tree.
   *
   * Rebuilt from the induced subtree rather than stored, because *where* a
   * fossil hangs is a fact about the current selection and not about the
   * fossil: adding a species can promote a suppressed node to a rendered one
   * and move the branch a graft belongs to. Deriving it means the picture
   * cannot go stale, which is the same reason `Graph` re-checks the open drill
   * lane against the segments instead of trusting the URL.
   */
  const graftSet = useMemo(
    () =>
      buildGrafts(
        tree.view.fossils
          .map((n) => tree.fossils.get(n))
          .filter((f): f is FossilTaxon => f !== undefined),
        tree.induced,
        tree.nodes,
      ),
    [tree.view.fossils, tree.fossils, tree.induced, tree.nodes],
  );
  const grafts = graftSet.grafts;

  // And say so when one of them is not drawn. `tree/refusals.tsx` is the notice
  // and the two rules that keep it from firing into every ordinary flow.
  useGraftRefusals(graftSet, tree.loading, tree.induced.rendered.length, toast);

  const fossilCommands: Command[] = useMemo(() => {
    const f = pickedFossil;
    if (!f) return [];
    const host = tree.nodes.get(f.attach_idx);
    const hostName = host?.name ?? "the clade it attaches to";
    const taxonNo = f.pbdb_taxon_no ?? 0;
    const drawn = taxonNo > 0 && tree.view.fossils.includes(taxonNo);
    const out: Command[] = [];
    // Offered first, because it is now the thing a reader most wants from a
    // fossil row and the thing they came here believing was impossible.
    if (taxonNo > 0) {
      out.push(
        drawn
          ? {
              id: "fossil-undraw",
              title: `Remove ${f.name} from the tree`,
              subtitle: "Stop drawing it against the lineage",
              icon: "−",
              section: "This fossil",
              contextual: true,
              run: () => {
                tree.removeFossil(taxonNo);
                setPaletteOpen(false);
                setScoped(false);
                toast(
                  <>
                    Removed <strong>{f.name}</strong>
                  </>,
                );
              },
            }
          : {
              id: "fossil-draw",
              title: `Draw ${f.name} on the tree`,
              subtitle:
                "Placed at its own date, hanging off the branch it belongs to",
              icon: "◇",
              section: "This fossil",
              contextual: true,
              run: () => {
                tree.addFossil(taxonNo);
                setPaletteOpen(false);
                setScoped(false);
                toast(
                  <>
                    Drew <strong>{f.name}</strong>
                  </>,
                );
              },
            },
      );
    }
    out.push({
      id: "fossil-host",
      title: `Show ${hostName}`,
      subtitle: `${f.name} is known from somewhere below it`,
      icon: "◎",
      section: "This fossil",
      contextual: true,
      run: () => {
        if (host) tree.select(host.key);
        setPaletteOpen(false);
        setScoped(false);
      },
    });
    if (host && !tree.induced.leaves.includes(f.attach_idx)) {
      out.push({
        id: "fossil-add-host",
        title: `Add ${hostName} to the canvas`,
        subtitle: "Draw the branch this fossil sits on",
        icon: "+",
        section: "This fossil",
        contextual: true,
        run: () => {
          tree.add(host.key);
          setPaletteOpen(false);
          setScoped(false);
          toast(
            <>
              Added <strong>{hostName}</strong>
            </>,
          );
        },
      });
    }
    return out;
  }, [pickedFossil, tree, toast]);

  const visibleCommands = useMemo(
    () =>
      scoped
        ? pickedFossil
          ? fossilCommands
          : commands.filter((c) => c.contextual)
        : commands,
    [commands, fossilCommands, pickedFossil, scoped],
  );

  const scope: Scope | null = !scoped
    ? null
    : pickedFossil
      ? {
          label: pickedFossil.name,
          onPop: () => {
            setScoped(false);
            setPickedFossil(null);
          },
        }
      : focusedNode
        ? {
            label: focusedNode.name ?? focusedNode.key,
            onPop: () => setScoped(false),
          }
        : null;

  /** Open the palette on the whole surface, from a key or from a button. */
  const openPalette = useCallback(() => {
    // A fossil scope is per-click and never survives into the next opening, or
    // the palette answers about a row nobody is looking at.
    setPickedFossil(null);
    setScoped(false);
    setFilter(null);
    setPaletteOpen(true);
    settle();
  }, [settle]);

  /**
   * The same palette, answering about species only.
   *
   * Its own key because searching for a species is not one command among
   * twenty — it is the thing the app is for, and the reader who presses `S` has
   * already decided what kind of answer they want. Filtering rather than
   * opening a second surface keeps one list, one set of arrow keys and one
   * Enter, and the filter is poppable with backspace exactly like a scope.
   */
  const openSpecies = useCallback(() => {
    setPickedFossil(null);
    setScoped(false);
    setFilter("species");
    setPaletteOpen(true);
    settle();
  }, [settle]);

  const clearCanvas = useCallback(() => {
    tree.clear();
    setConfirmClear(false);
    settle();
    toast("Canvas cleared");
  }, [tree, toast, settle]);

  /**
   * Full keyboard operation, on bare letters.
   *
   * Three guards come before any binding is matched, and each is answering a
   * real failure rather than being defensive. Typing in a field must never
   * reach here, or every search box would fire commands as it was filled. An
   * open palette owns the keyboard even when focus has slipped out of its input
   * — clicking the scrim used to leave the list up and the letters live under
   * it. And an open dialog owns it outright: the whole point of asking is that
   * the next keystroke is an answer to the question, not another command.
   *
   * This is rebuilt as often as its dependencies like, and that costs nothing:
   * `useWindowKeys` subscribes **once** and calls through a ref. That split is
   * the fix for a real bug rather than tidiness, and `chrome/keys.ts` is the
   * account of it.
   */
  const onKey = useCallback(
    (e: KeyboardEvent) => {
      const inField =
        e.target instanceof HTMLElement &&
        (e.target.tagName === "INPUT" ||
          e.target.tagName === "TEXTAREA" ||
          e.target.isContentEditable);
      if (inField) return;

      if (confirmClear) {
        // Enter is the focused button's own; only the escape hatch is ours.
        if (e.key === "Escape") {
          e.preventDefault();
          setConfirmClear(false);
        }
        return;
      }
      if (paletteOpen) {
        if (e.key === "Escape") {
          e.preventDefault();
          setPaletteOpen(false);
          setScoped(false);
          setFilter(null);
          setPickedFossil(null);
        }
        return;
      }

      // Global scope, which is what makes the `preventDefault` below safe.
      // Enter is in the table too and is deliberately not visible here: this
      // handler prevents the default of everything it matches, and doing that
      // to Enter would take keyboard activation off every button in the app.
      // `bindings.ts`'s `Scope` is the whole of that argument, and `Tab` — which
      // this line used to match, and so used to prevent — is the rest of it:
      // nothing in the table claims it any more, so the focus ring moves.
      const action = matchKey(e);
      if (action === null) return;
      // Everything below is ours, so nothing below reaches the browser. `/`
      // opens quick-find in Firefox, which is the reason this line survives a
      // table holding nothing but bare letters.
      e.preventDefault();

      switch (action) {
        case "palette":
          openPalette();
          break;
        case "species":
          openSpecies();
          break;
        case "fit":
          setFitSignal({ kind: "all", token: Date.now() });
          break;
        case "fit-selection":
          // Falls back to framing everything rather than doing nothing: the
          // reader asked to be shown something, and with no selection the
          // whole tree is the honest answer to "here".
          setFitSignal({
            kind: focusedIdx === null ? "all" : "selection",
            token: Date.now(),
          });
          break;
        case "isolate":
          tree.toggleIsolate();
          break;
        case "step":
          stepSelection(false);
          break;
        case "step-back":
          stepSelection(true);
          break;
        case "axis":
          tree.setAxis(tree.view.axis === "log" ? "linear" : "log");
          break;
        case "labels":
          tree.setLabels(LABEL_TURN[tree.labels].next);
          break;
        case "ages":
          tree.setAges(!tree.ages);
          break;
        case "biolum":
          tree.toggleBiolum();
          break;
        case "fullscreen":
          // No availability guard here, and none is wanted: the hook refuses a
          // browser that cannot do it, so a reader on one gets nothing from the
          // key exactly as they get no button. Guarding in both places is how
          // the two answers start to differ.
          fullscreen.toggle();
          break;
        case "random-species":
          void randomPick();
          break;
        case "clear":
          if (!empty) setConfirmClear(true);
          break;
        case "remove":
          if (focusedNode && tree.induced.leaves.includes(focusedNode.idx)) {
            tree.remove(focusedNode.key);
            toast(`Removed ${focusedNode.name ?? focusedNode.key}`);
          }
          break;
        case "escape":
          // One key, innermost thing first — the same order the palette closes
          // in. A drill-down lane is a thing you opened over the canvas, so it
          // goes before the selection does; otherwise dismissing it costs two
          // presses and the first one silently does something else.
          //
          // The two afterglow surfaces come before both, in the order they
          // arrived: the pinned answer is the newest thing on screen and the
          // flyout replaces it, so `esc` walks back out of an opening the same
          // way it walks out of everything else. Neither may swallow the press
          // when it is not there — the key still has to reach the lane and the
          // selection for a reader who never pressed an opening at all.
          if (afterglow?.at === "reveal") dismissAnswer();
          else if (afterglow?.at === "next") settle();
          else if (tree.view.drill) tree.setDrill(null);
          else tree.select(null);
          break;
      }
    },
    [
      tree,
      focusedIdx,
      focusedNode,
      toast,
      randomPick,
      openPalette,
      openSpecies,
      stepSelection,
      paletteOpen,
      confirmClear,
      empty,
      afterglow,
      dismissAnswer,
      settle,
      fullscreen,
    ],
  );

  // Registered once, and called through a ref. `chrome/keys.ts` is the whole of
  // that fix and the account of the bug it is for.
  useWindowKeys(onKey);

  /**
   * The control bar's rows, which are the bindings with their callbacks bound.
   *
   * Contextual actions stay in the bar and go grey, rather than appearing and
   * disappearing as the selection changes: a bar that reshuffles under a
   * reader's hand costs them the button they were reaching for, and the
   * tooltip on a disabled one says what would make it work.
   */
  const controls: ControlGroup[] = useMemo(() => {
    const groups: ControlGroup[] = [
      // The wordmark, and under it the one door that reaches every other. The
      // caption is the product rather than the feature because a palette is not
      // a feature: `Commands` is what the button does and `Concestor` is what
      // you are in. See `BrandMark.tsx`.
      {
        name: "Concestor",
        slot: "lead",
        brand: true,
        actions: [{ id: "palette", run: openPalette }],
      },
      // The caption is the whole action and the two buttons are the two ways to
      // take it — which is the shape this pair actually has: `S` and `R` both
      // put a species on the canvas and differ only in who chooses it. Naming
      // the corpus twice, as "Species" and "Random" side by side once did,
      // spent both words on the noun and neither on the difference.
      {
        name: "Add species",
        slot: "lead",
        actions: [
          { id: "species", label: "Search", run: openSpecies },
          { id: "random-species", run: () => void randomPick() },
        ],
      },
      // Opposite the lead group, and the pairing is what these have in common
      // rather than what they do: every one of them acts on the canvas as a
      // whole rather than on anything selected on it.
      //
      // Two of the three are also one-way — the kind of thing you reach for
      // when you have stopped building, one to send it and one to start over —
      // and they stay adjacent at the far right so that reading remains
      // available. Fullscreen leads instead of joining them: it is the
      // reversible one, and a reader whose pointer lands on the near edge of
      // this group should not find `clear` there.
      {
        name: "Canvas",
        slot: "trail",
        actions: [
          // Absent outright where the browser has no fullscreen — not disabled.
          // `chrome/fullscreen.ts` is the argument, and it is the same one
          // `BIOLUM_AVAILABLE` makes: a greyed button explaining that this
          // browser will never do it tells the reader nothing they can act on.
          ...(FULLSCREEN_AVAILABLE
            ? [
                {
                  id: "fullscreen" as const,
                  run: fullscreen.toggle,
                  active: fullscreen.on,
                },
              ]
            : []),
          {
            id: "clear",
            run: () => setConfirmClear(true),
            ...(empty
              ? { disabledBecause: "The canvas is already empty" }
              : {}),
          },
          {
            // The one control with no key, so it carries its own words —
            // `chrome/Controls.tsx` is why they are required rather than
            // optional, and `bindings.ts` is why there is no letter to print.
            id: "share",
            label: "Share",
            // **Not "every view of this app is a URL"**, which is what this
            // said and which is the same false claim the palette row carried,
            // in the same words, on the more visible of the two surfaces — a
            // mouse user hovers this button, where the row needs `P` first.
            // Fixing one and leaving the other is how a claim survives being
            // corrected. See the palette's `share` row for what does travel.
            hint: "Copy a link that opens on this exact tree — the labels, ages and light stay with you",
            run: share,
          },
        ],
      },
      // The second row: not what you put on the canvas but how you look at it.
      {
        name: "Navigate",
        slot: "rest",
        actions: [
          {
            id: "fit",
            run: () => setFitSignal({ kind: "all", token: Date.now() }),
            ...(empty
              ? { disabledBecause: "Nothing on the canvas to frame yet" }
              : viewFit
                ? { disabledBecause: "The whole tree is already framed" }
                : {}),
          },
          {
            id: "isolate",
            run: () => tree.toggleIsolate(),
            active: tree.view.isolate,
            ...(focusedIdx === null
              ? {
                  disabledBecause:
                    "Select a node first — isolate dims everything off its path",
                }
              : {}),
          },
          {
            id: "step",
            run: () => stepSelection(false),
            ...(tree.induced.leaves.length === 0
              ? {
                  disabledBecause:
                    "Add a species and this steps through the selection",
                }
              : {}),
          },
        ],
      },
    ];
    // Pointed at once an opening's answer has been read rather than the moment
    // it lands — `tipShown` is the whole of that timing — and read from {@link
    // TIPPED} rather than set row by row, so the bar cannot light a button the
    // invitation never meant. The rows themselves are untouched: the tip is a
    // state of the moment, not of the action.
    //
    // This and the tray below must read the *same* value. They are the outline
    // and the line inside it, and gating them apart draws a box around three
    // buttons with nothing to say about why.
    if (!tipShown) return groups;
    return groups.map((g) => ({
      ...g,
      actions: g.actions.map((a) =>
        TIPPED.includes(a.id) ? { ...a, tip: true } : a,
      ),
    }));
  }, [
    openPalette,
    openSpecies,
    randomPick,
    share,
    stepSelection,
    tree,
    focusedIdx,
    empty,
    viewFit,
    tipShown,
    fullscreen,
  ]);

  /**
   * The mode, on the document as well as on the canvas.
   *
   * The canvas carries its own class and always will — it is the element the
   * effect is *about*, and it has to be right on the first painted frame. This
   * exists for the chrome that is not inside it: the control bar is `position:
   * fixed` on the top edge and fades to `--void`, which is the neutral
   * instrument's black and a visibly lighter grey than the water. Left alone it
   * drew a pale band across the top of the abyss.
   *
   * One class, read by one rule. It is not a second source of truth — nothing
   * branches on it, and it cannot disagree with the canvas because both are
   * written from the same boolean on the same render.
   */
  useEffect(() => {
    document.body.classList.toggle("biolum", tree.biolum);
    return () => document.body.classList.remove("biolum");
  }, [tree.biolum]);

  // Chrome auto-hides. The canvas is the page. `chrome/idle.ts` is the timer;
  // whether the bar is *allowed* to go is decided at the `Controls` call below,
  // because an afterglow holds it open.
  const idle = useIdle();

  if (reachable === false) {
    return (
      // The whole document in this state, so it is `main` rather than the
      // overlay `.boot` is everywhere else — there is no canvas underneath it
      // to be the page.
      <main className="boot">
        <div className="boot-inner">
          <h1>Concestor</h1>
          <p>
            The read API is not answering. It serves the baked artifacts — the
            topology arrays, the age tiers and the search index — and the app
            cannot resolve a species without it.
          </p>
          {/*
            Two audiences, and until the probe was fixed this screen only ever
            had one. It could not be shown in production — `/healthz` answered
            `200` off the static host whether or not the API was up — so the
            copy was written for whoever was running the server themselves, and
            a reader on the web would have been handed a Go command. The
            reader's line goes first because there are more of them and because
            the only useful thing they can do is wait.
          */}
          <p>
            Nothing is wrong with your browser and there is nothing to fix at
            your end — try again in a few minutes.
          </p>
          <p>
            Running this locally? Start the server with{" "}
            <code>go run ./server -build ./build</code> from the repository
            root, then reload.
          </p>
        </div>
      </main>
    );
  }

  return (
    <>
      {/*
        The one landmark this app owes a reader, drawn round two elements
        rather than one.

        *The canvas is the page* is this project's own sentence and it decides
        which element gets `main`. But the empty canvas's invitation is a
        sibling of the canvas rather than a child of it, and both are `position:
        fixed; inset: 0`, so neither can be moved inside the other without
        moving it on screen. A wrapper covers both and costs nothing: a static
        box with two out-of-flow children has no size, opens no stacking context
        of its own, and leaves the paint order the DOM order it already was.

        Leaving the invitation outside would be the worse half of the trade. It
        is the `h1`, the lede and every way in, on the one view where there is
        nothing else to find.
      */}
      <main>
        <Graph
          induced={tree.induced}
          nodes={tree.nodes}
          delta={tree.delta}
          onDeltaPlayed={tree.consumeDelta}
          focusedIdx={focusedIdx}
          onFocus={(idx) => {
            if (idx === null) {
              tree.select(null);
              return;
            }
            // A graft is not in `tree.nodes` and never will be — its index is
            // negative precisely so that lookup misses. It carries its own key,
            // which is what goes in `sel` and what opens the fossil card.
            if (isGraftIdx(idx)) {
              tree.select(grafts.find((g) => g.idx === idx)?.key ?? null);
              return;
            }
            const n = tree.nodes.get(idx);
            tree.select(n ? n.key : null);
          }}
          isolate={tree.view.isolate}
          axisMode={tree.view.axis}
          onAxisMode={tree.setAxis}
          labels={tree.labels}
          onLabels={tree.setLabels}
          ages={tree.ages}
          onAges={tree.setAges}
          intervals={timescale}
          fitSignal={fitSignal}
          onFitState={setViewFit}
          cardOpen={cardOpen}
          drill={tree.view.drill}
          onDrill={tree.setDrill}
          grafts={grafts}
          holdMaxAge={tree.holdMaxAge}
          biolum={tree.biolum}
          onBiolum={(v) => {
            if (v !== tree.biolum) tree.toggleBiolum();
          }}
          // The same expression that puts the invitation on screen below, because
          // the mode panel is not drawn under it. See `canvas/Graph.tsx`.
          empty={nothingDrawn}
          onPickFossil={(f) => {
            setPickedFossil(f);
            setScoped(true);
            setPaletteOpen(true);
          }}
          // The narrow window's one control, drawn inside the canvas because that
          // is where `--lane-h` is published — see `chrome/PaletteFab.tsx`. It
          // takes the invitation too, since the bar that would otherwise carry it
          // is not on screen at that width — and it takes the same `TIP_LINE`,
          // spread the same way, so the two surfaces cannot be made to say
          // different things about the same moment.
          onPalette={openPalette}
          {...(tipShown ? { tip: TIP_LINE } : {})}
        />

        {/*
        The empty canvas asks a question rather than giving an instruction.

        It used to say "press S and search for two species", which needs the one
        thing a curious reader has not got — two species, chosen, for a reason —
        and then described the mechanism rather than the payoff. Nobody wants a
        minimal subtree. They want to find out they are a fish.

        Each row draws a *triple*, and `openings.ts` explains why that is the
        whole design: a pair yields a number, a triple yields an argument you
        can see. Search and the random pick stay, demoted to the line below,
        because they are now the second and third ways in rather than the first.
      */}
        {nothingDrawn && !paletteOpen && (
          <div className="boot">
            <div className="boot-inner">
              <h1>Concestor</h1>
              {/*
              A shared link arrives here, and used to be answered with the
              carousel.

              Nothing is drawn until `/v1/paths` comes back, and "nothing is
              drawn" was the only condition this panel tested — so someone
              opening a link to the whale, the hippo and the cow was shown the
              front door and three other questions to look at instead, for the
              whole of the round trip. On a cold container that is seconds, and
              a reader who clicks an opening in the meantime has replaced the
              view they were sent.

              The frame stays; only the invitation is held back until it is
              true that there is nothing on the way.
            */}
              {linkPending ? (
                <PendingLine className="boot-pending">
                  Resolving the lineages in this link…
                </PendingLine>
              ) : (
                <>
                  {/*
                  **A few, not two**, and the carousel underneath is the reason.

                  `openings.ts` refuses to ship a two-taxon opening and says why
                  in its own words: *a pair draws one number. Three or more draw
                  an argument — the nesting itself is the proof.* Every question
                  below this line therefore has three taxa or more, and this
                  line was inviting the reader to the weaker version of the
                  product, directly above fifteen demonstrations of the stronger
                  one. It said it on the shared card and in the README too.

                  "Name" rather than "pick" because the about page's own subhead
                  already says *name the species you care about*, and because
                  picking is what you do from a list somebody else wrote.

                  **And it opens on the payoff rather than the mechanism**,
                  which took two tries. "See where their lineages meet, in deep
                  time" is a description of what the canvas *does*, and this
                  file's own predecessor was thrown out for exactly that —
                  `openings.ts` records it: the empty canvas used to say "press
                  S and search for two species", which "described the mechanism
                  … rather than the payoff, and nobody wants a minimal subtree.
                  They want to find out they are a fish." A lineage meeting
                  another lineage is a minimal subtree wearing a nicer coat.

                  So the first clause is the fact that makes the rest worth
                  doing, and it is the one claim here big enough to be worth a
                  stranger's next thirty seconds. The second is what they do
                  about it. "How — and when" is the whole product in three
                  words, and it is the question the app was built to answer.
                */}
                  <p className="boot-lede">
                    Everything alive is related. Name a few species and see
                    exactly how — and when.
                  </p>
                  {/*
                  `keyToOpen` was `!aboutOpen`, because the carousel stayed
                  mounted behind the about *panel* and a bare Enter would have
                  redrawn the canvas under a modal the reader was reading. The
                  panel is a page now and `main.tsx` unmounts this whole tree to
                  show it, so there is nothing left to be behind. Every other
                  surface that can sit on top is handled structurally by the
                  carousel's own `OWNS_ENTER` test — the palette holds focus in
                  an `input`, the clear dialog on a `button`, and both are in
                  that list.
                */}
                  <OpeningCarousel onOpen={openOpening} keyToOpen />
                  {/*
                  Two columns, because the three keys and the about link are
                  two different offers and the sentence they used to share made
                  them one. Run together — "or press S …, R …, or P …" — a
                  reader has to parse the whole line to find the one way in
                  they want, and the badges are the thing the eye lands on, so
                  the line reads as a list that has been written out longhand.
                  A row each puts the badge in a column of its own and the
                  payoff beside it, which is what the palette rows already do.

                  The link is the second column rather than a fourth row: it
                  goes somewhere else, and the three above it stay here. That
                  split is also what makes the narrow window honest: below
                  620px the keys column is **not drawn**, on the same reasoning
                  that takes the control bar off a phone — three badges naming
                  presses a reader has no keyboard to make. The link is the
                  offer that survives, and it centres, so the last line of the
                  empty canvas is the one thing on it that still works.
                */}
                  <div className="boot-alt">
                    <ul className="boot-keys">
                      <li>
                        <span className="kbd">{kbd("species")}</span>
                        <span>Search {SPECIES_PHRASE}</span>
                      </li>
                      <li>
                        <span className="kbd">{kbd("random-species")}</span>
                        <span>Add one picked at random</span>
                      </li>
                      <li>
                        <span className="kbd">{kbd("palette")}</span>
                        <span>Everything this can do</span>
                      </li>
                    </ul>
                    {/*
                    A `button`, on `SourceLinks`'s reasoning: `goAbout` pushes
                    history and swaps the root, so an `href` would offer a
                    middle-click that reloads the app.
                  */}
                    <button
                      type="button"
                      className="boot-more"
                      onClick={goAbout}
                    >
                      Learn more about Concestor
                      {/*
                      The one mark saying this is a door.

                      It was a hairline, a line of prose and nothing else — the
                      same failure the carousel card had before it was given a
                      border, and here there is not even a box to notice. An
                      arrow is what a link that goes *somewhere else* carries,
                      and it is decoration to a screen reader, which already
                      has the words and the button role.

                      Quiet, and deliberately not the carousel's accent: that
                      one is the lit mark on this canvas and there may only be
                      one. This borrows the link's own colour and earns its
                      difference from the prose around it by moving under the
                      pointer.
                    */}
                      <span className="boot-more-arrow" aria-hidden="true">
                        →
                      </span>
                    </button>
                  </div>
                </>
              )}
            </div>
          </div>
        )}
      </main>

      {/*
        A placeholder rather than the last fossil's card. `fossilCardPending`
        is already delayed, so this is only ever reached by a request that is
        genuinely making somebody wait — see `chrome/Pending.tsx`.
      */}
      {focusedTaxonNo !== null && fossilCardPending && (
        <CardPending>Looking up this fossil…</CardPending>
      )}

      {fossilDetail && focusedTaxonNo !== null && !fossilCardPending && (
        <FossilCard
          fossil={fossilDetail}
          hue={laneHue(graftIdx(focusedTaxonNo))}
          graft={grafts.find((g) => g.idx === graftIdx(focusedTaxonNo)) ?? null}
          onSelect={selectTaxon}
          drawn={tree.view.fossils.includes(focusedTaxonNo)}
          // `drawFossil` rather than `tree.addFossil`, because a fossil card is
          // now routinely open on something whose host branch is nowhere near
          // the canvas — a witness reached from a divergence, a search hit — and
          // the bare add would put it in the URL and draw nothing.
          onDraw={() => void drawFossil(fossilDetail)}
          onRemove={() => {
            tree.removeFossil(focusedTaxonNo);
            toast(
              <>
                Removed <strong>{fossilDetail.name}</strong>
              </>,
            );
          }}
        />
      )}

      {/*
        Gated on the payload, not on the canvas. `focusedNode` is the mark to
        light and is absent for every taxon reached by a link, which is most of
        them now — see `selectedNodeKey`. The hue comes from the node's own
        index, so a lineage keeps its colour whether or not it is drawn.
      */}
      {focusedTaxonNo === null && cardPending && (
        <CardPending>Looking up this taxon…</CardPending>
      )}

      {detail && focusedTaxonNo === null && !cardPending && (
        <Detail
          detail={detail}
          hue={laneHue(detail.idx)}
          divergence={divergenceFor(detail.idx, tree.induced, tree.nodes)}
          nested={nestedSelections(detail.idx, tree.induced, tree.nodes)}
          // "A clade the reader chose" — which a taxon reached by a link is,
          // just as much as one they searched for. The rule this feeds is
          // `witness.ts`'s: a *divergence* draws its witness because its own
          // exemplar would be a crown group younger than the split, while a
          // clade somebody picked keeps its exemplar. A node that is not drawn
          // at all is not a divergence between anything — nobody arrived at it,
          // they named it — so without the second clause every link into an
          // undrawn clade answered "what does a carnivoran look like" with a
          // fossil from below the fork it is not sitting at.
          isLeaf={
            tree.induced.leaves.includes(detail.idx) ||
            !tree.induced.rendered.includes(detail.idx)
          }
          onSelect={selectTaxon}
          inSelection={tree.selectionIdx.includes(detail.idx)}
          isDrawn={tree.induced.rendered.includes(detail.idx)}
          onAdd={() => addNode(detail)}
          onRemove={() => removeNode(detail)}
        />
      )}

      <Palette
        open={paletteOpen}
        onClose={() => {
          setPaletteOpen(false);
          setScoped(false);
          setFilter(null);
          setPickedFossil(null);
        }}
        commands={visibleCommands}
        scope={scope}
        filter={filter}
        onFilter={setFilter}
        onPick={addHit}
        onPickFossil={drawFossil}
        present={present}
        presentFossils={presentFossils}
        suggestions={suggestions}
      />

      {confirmClear && (
        <Confirm
          title="Clear the canvas?"
          body={
            <>
              This takes <strong>{tree.induced.leaves.length}</strong> species
              {tree.view.fossils.length > 0 && (
                <>
                  {" "}
                  and <strong>{tree.view.fossils.length}</strong>{" "}
                  {tree.view.fossils.length === 1 ? "fossil" : "fossils"}
                </>
              )}{" "}
              off the tree. Nothing else is affected, and your browser's back
              button restores this view — every one of them is a URL.
            </>
          }
          confirmLabel="Clear"
          onConfirm={clearCanvas}
          onCancel={() => setConfirmClear(false)}
        />
      )}

      {/*
        The column is the live region, and it is the whole column.

        Everything this app says in words it says here — added, removed, drew,
        link copied, this fossil is not drawn and why — and none of it was
        reaching anybody who is not watching the bottom of the screen. A toast
        is a receipt, so `polite` rather than `assertive`: it reports something
        the reader has just done and must never cut across what they are
        reading. `aria-atomic` is off because a toast is added beside its
        neighbours rather than replacing them, and re-reading the two that are
        already up is how a confirmation becomes a paragraph.

        One region, at the top, rather than one per toast. The pinned answer
        below used to carry its own `role="status"` and no longer needs to —
        nested live regions are two announcements for one arrival on some
        readers, and the thing that decides an answer is announced is that it
        appears in this column, which is the same thing that decides it for
        every other line here.
      */}
      <div className="toasts" aria-live="polite" aria-atomic="false">
        {toasts.map((t) => (
          <div className={`toast${t.warn ? " warn" : ""}`} key={t.id}>
            {t.body}
          </div>
        ))}
        {/*
          The answer, in the toast column and outside the toast queue.

          It borrows the look because it belongs to the same place on screen —
          the strip above the axis is where this app says things — but it is not
          a toast and must not be one: a toast is a receipt for something the
          reader did, and this is the reply to something they asked. It has no
          timer, it holds the column while it is up, and it goes when it is
          dismissed. Last in the stack, so a warning that arrives underneath it
          is still the newest thing at the bottom.
        */}
        {afterglow?.at === "reveal" && (
          <div className="toast toast-pinned">
            <span className="toast-pinned-body">
              {afterglow.opening.reveal}
            </span>
            <button
              type="button"
              className="toast-dismiss"
              onClick={dismissAnswer}
              aria-label="Dismiss"
            >
              <span className="kbd">{kbd("escape")}</span>
            </button>
          </div>
        )}
      </div>

      {afterglow?.at === "next" && (
        <NextOpening
          opening={afterglow.opening}
          onOpen={openOpening}
          onClose={settle}
        />
      )}

      {/*
        One signal for "something is in flight", not three. The bar is the
        app's only always-visible chrome, so it is where a wait with no other
        home belongs — a random pick, a graft's PBDB row — and a reader does
        not need to be told which of them it is. `usePending` keeps the
        instant ones out of it entirely.
      */}
      {/*
        The bar does not fade while it is pointing at something.

        Chrome auto-hides after four still seconds, which is right for a bar
        nobody is looking at and wrong for the one moment it is asking to be
        looked at — a reader reading the answer to their question is exactly the
        reader holding still. It fades again the moment the invitation is taken
        or dismissed.

        **This stays keyed on `afterglow` and not on `tipShown`, and the two
        are no longer the same instant.** Auto-hide is four seconds and
        `TIP_DELAY_MS` is five, so a bar that waited for the tip before
        refusing to idle would fade out at second four and the invitation
        would arrive one second later on chrome nobody can see. The bar holds
        open for the whole afterglow; only the outline inside it waits.
      */}
      <Controls
        groups={controls}
        idle={idle && afterglow === null}
        busy={busy}
        {...(tipShown ? { tip: TIP_LINE } : {})}
      />
    </>
  );
}

// `showCredits` and `showAbout` used to live here as five-second toasts. Both
// are now `chrome/About.tsx`, which says why one panel replaced two notices.
