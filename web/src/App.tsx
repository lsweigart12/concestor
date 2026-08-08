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
import { pickFrom, randomKind } from "./corpora";
import { Graph } from "./canvas/Graph";
import { isScientificItalic } from "./canvas/NodeMark";
import { Detail } from "./detail/Detail";
import { CardPending } from "./detail/blocks";
import { FossilCard } from "./detail/FossilCard";
import { useCards } from "./detail/cards";
import { idxFromKey, selectionKeyFor } from "./detail/target";
import {
  graftIdx,
  graftKey,
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
  type Suggestions,
} from "./palette/Palette";
import { forgetRecent, loadRecent, rememberRecent } from "./palette/recent";
import { OpeningCarousel } from "./chrome/OpeningCarousel";
import { keysOf, nextOpening, type Opening } from "./openings";
import { Confirm } from "./chrome/Confirm";
import {
  CanvasLeftControls,
  ViewportControls,
  type ViewportAction,
} from "./chrome/CanvasChrome";
import { Sidebar } from "./sidebar/Sidebar";
import { useSidebar } from "./sidebar/useSidebar";
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
 * A table, not ternaries, so the title, subtitle and destination cannot
 * disagree. Order is the chip's own: off → common → scientific → off.
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
 * The line beside the search pill once an opening has finished drawing — one
 * invitation to put something of the reader's own beside the answer, next to the
 * one door that reaches everything.
 */
const TIP_LINE = "Now put something of your own beside it";

/**
 * How long the invitation waits before it is made: long enough for the reader to
 * finish the answer, so the pulse reads as new when they look at it. The two ways
 * of being done both count — the timer, and dismissing the answer (see `tipShown`).
 */
const TIP_DELAY_MS = 5000;

/**
 * What is being offered after an opening, and which one. Two non-overlapping
 * beats: `reveal` is the answer, pinned until the reader is done, and `next`
 * offers another question, made only once they are.
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
  /**
   * The panel: how wide, whether it is open, and whether it is docked.
   *
   * `sidebar/useSidebar.ts` owns all three and writes `--sidebar-w` to the
   * document, which is the one number the whole layout reads — the canvas is
   * inset by it, and the axis, the drill lane and the toasts are positioned
   * inside the canvas, so they follow for free.
   */
  const sidebar = useSidebar();
  // Closed on load. The canvas is the page; the boot hint says how to open it.
  const [paletteOpen, setPaletteOpen] = useState(false);
  /** Non-null when the palette is answering about one corpus only. */
  const [filter, setFilter] = useState<PaletteFilter | null>(null);
  const [confirmClear, setConfirmClear] = useState(false);
  const [fitSignal, setFitSignal] = useState<{
    kind: "all" | "selection";
    token: number;
  } | null>(null);
  /**
   * Whether the canvas is already showing the fit, reported by the graph.
   *
   * Starts false so the command exists before the first report lands; a
   * momentarily-offered Fit is a smaller error than a permanently missing one
   * if the graph never mounts.
   */
  const [viewFit, setViewFit] = useState(false);
  // A random pick is out. Usually instant (the pool is cached and the lookup is
  // an immutable URL), but the first press of a session pays for the pool and a
  // fossil roll pays for `drawFossil` — the case a pending flag is for.
  const [picking, setPicking] = useState(false);

  /**
   * The focused fossil, when `sel` names one. A graft selects exactly like a
   * node; `pbdb108454` cannot collide with an OTT id or node key.
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
    // `idx:N` is a real key for a node we hold no key for; resolving it here
    // keeps a link to an on-canvas node from opening the card with no mark lit.
    const byIdx = idxFromKey(k);
    if (byIdx !== null) return tree.nodes.has(byIdx) ? byIdx : null;
    const direct = tree.idxOf.get(k) ?? tree.idxOf.get(`ott${k}`);
    if (direct !== undefined) return direct;
    const n = [...tree.nodes.values()].find(
      (x) => x.key === k || String(x.ott_id) === k,
    );
    return n?.idx ?? null;
  }, [tree.view.selected, focusedTaxonNo, tree.idxOf, tree.nodes]);

  // The key the node card is about — the selection itself, decoupled from
  // `focusedIdx` (which mark to light) so a card can open on a taxon not on the
  // canvas, like a classification rung the reader clicked.
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

  // What an empty species palette offers, recomputed on open (not held in state)
  // so a just-added recent is current. Null while closed.
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
   * Draw an opening. Both surfaces close on the press and the toast names the
   * claim, not the taxa. Drawn all at once, the reveal goes up with the tree;
   * drawn in sequence, the question goes up and the answer is held until the
   * last taxon lands, so the canvas states the claim first.
   */
  const openOpening = useCallback(
    (o: Opening) => {
      setPaletteOpen(false);
      // Whatever the last opening left on screen goes with the press, including
      // a flyout offering this very question.
      setAfterglow(null);
      if (tree.openSequenced(keysOf(o), prefersReduced())) {
        owedReveal.current = o;
        toast(o.question);
        return;
      }
      setAfterglow({ at: "reveal", opening: o });
    },
    [tree, toast],
  );

  // The sequence has ended: pay the answer. The falling edge, not a completion
  // callback, so an interrupted sequence (which still finished the tree) is paid too.
  const wasSequencing = useRef(false);
  useEffect(() => {
    if (wasSequencing.current && !tree.sequencing) {
      const o = owedReveal.current;
      owedReveal.current = null;
      if (o) setAfterglow({ at: "reveal", opening: o });
    }
    wasSequencing.current = tree.sequencing;
  }, [tree.sequencing]);

  // Done reading the answer, so offer another question. The answer is pinned,
  // not timed — it is the only place the reply to the reader's question is
  // written down — and dismissing it is what says they are ready for more.
  const dismissAnswer = useCallback(() => {
    setAfterglow((a) => {
      if (a?.at !== "reveal") return a;
      const next = nextOpening(a.opening);
      return next ? { at: "next", opening: next } : null;
    });
  }, []);

  // When the tip is offered (see {@link TIP_DELAY_MS}): whichever of two tells
  // comes first — dismissing the answer (`at: "next"`), or the delay for a
  // reader still reading. `usePending` resets on the falling edge, so a second
  // opening gets its own clock.
  const tipDue = usePending(afterglow !== null, TIP_DELAY_MS);
  const tipShown = afterglow !== null && (tipDue || afterglow.at === "next");

  /**
   * Any interaction ends the sequence at the finished tree. Capture phase on
   * `window`, so it runs before the press's own handler and is never swallowed.
   * Three events: a key, a pointerdown anywhere, and a wheel (the canvas pan/zoom
   * that reaches no handler of ours).
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
   * A fossil chosen from the palette. Draws it, and adds the clade it hangs
   * below when that clade is not on the canvas, or the pick produces no visible
   * change. Adding the host is a real change, so the toast names it.
   */
  const drawFossil = useCallback(
    async (f: FossilTaxon) => {
      const taxonNo = f.pbdb_taxon_no ?? 0;
      if (taxonNo <= 0) return;
      setPaletteOpen(false);

      const placeable =
        tree.induced.rendered.length > 0 &&
        makeGraft(f, tree.induced, tree.nodes) !== "off-tree";
      if (placeable) {
        tree.addFossil(taxonNo);
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
        tree.addFossil(taxonNo);
        toast(
          <>
            Drew <strong>{f.name}</strong>
          </>,
        );
        return;
      }
      /*
        The branch first, then the thing that hangs from it — and that order is
        load-bearing now that both go through the draw queue.

        The fossil used to be added before this request was even made, which was
        harmless while a graft simply appeared. It is not harmless now: the
        queue would release the fossil the moment its PBDB row landed, onto a
        canvas whose attach node is still queued behind it, and `buildGrafts`
        would refuse it `off-tree`. The reader would get the toast promising a
        drawing, and no drawing.
      */
      tree.add(host.key);
      tree.addFossil(taxonNo);
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
   * Put something on the canvas without being asked what — the first move is the
   * hard one. The pool holds only taxa with their own drawing, or a surprise is
   * mostly nothing to look at (`store/random.go`). The draw is here, not on the
   * server, because `present` — which taxa are drawn — is a fact no request
   * carried, so the exclusion happens before the choice. One command over two
   * corpora ({@link RANDOM_FOSSIL_CHANCE}); an empty fossil roll falls through to
   * a species rather than reporting a failure.
   */
  const randomPick = useCallback(async () => {
    setPaletteOpen(false);
    settle();
    setPicking(true);
    try {
      // Memoised, so the fallback joins the boot request rather than making a
      // second one. The 404 retry handles a deploy landing mid-session: the
      // remembered `build_id` is stale, so re-read it past the memo and re-ask.
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
          // `drawFossil` adds the clade the fossil hangs below when it is not on
          // the canvas — the whole of the pick, since a random fossil almost
          // always attaches to a branch nobody has drawn yet.
          await drawFossil(await api.fossil(no));
          return;
        }
        // Fall through to a species; nothing is said about the roll.
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

  // Nothing is drawn, the condition the empty canvas answers. Read by two
  // surfaces (the invitation and the mode panel) that may not disagree.
  const nothingDrawn = tree.induced.rendered.length === 0;

  /**
   * Nothing on the canvas at all — stricter than `nothingDrawn`, since a graft
   * hangs off a drawn branch, so the two only part while a fossil add is in
   * flight. Declared here so both users share one definition.
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
        // The label switch, as a command. One row that cycles rather than three
        // rows that set, because the palette is a list of *actions* and "set
        // labels to scientific" is not one when they already are. The title
        // names what you would be switching *to*, never the current state.
        // `LABEL_TURN` is what keeps this row's title, its subtitle and the
        // key's handler agreeing about where the press lands.
        id: "labels",
        title: `Switch labels to ${LABEL_TURN[tree.labels].title}`,
        subtitle: LABEL_TURN[tree.labels].subtitle,
        icon: "Aa",
        keys: kbd("labels"),
        section: "View",
        run: () => {
          tree.setLabels(LABEL_TURN[tree.labels].next);
          setPaletteOpen(false);
        },
      },
      {
        // **Dates**, which is what the switch says. The internal name is still
        // `ages` — the store, the URL and every gate use it — and this row is
        // the reader's, so it takes the reader's word. `bindings.ts` has why
        // the two parted: `a` went to *add* when the sidebar took `s`, and the
        // control kept a letter that names it by changing which word names it.
        id: "ages",
        title: tree.ages ? "Hide dates" : "Show dates",
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
        // So the subtitle promises the thing that does travel and says nothing
        // about what does not. It matters to the same reader: somebody who
        // sends a bioluminescent canvas and is told it is "the exact view"
        // finds out otherwise from whoever opens it.
        subtitle: "It opens on this exact tree",
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
      // `fit-all` above states: the bar can grey a button and the shape of the
      // chrome says why, and a palette row has nothing beside it to read.
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
   * Derived in the store rather than here, because the *entrance* needs it: a
   * graft becoming drawable is what the canvas animates, and only that memo
   * knows when it happens. The refusal notice stays here — it is a message to
   * the reader, not a fact about the tree.
   */
  const graftSet = tree.graftSet;
  const grafts = graftSet.grafts;

  // And say so when one of them is not drawn. `tree/refusals.tsx` is the notice
  // and the two rules that keep it from firing into every ordinary flow.
  useGraftRefusals(graftSet, tree.loading, tree.induced.rendered.length, toast);

  /** Open the palette on the whole surface, from a key or from a button. */
  const openPalette = useCallback(() => {
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
   * Enter, and the filter is poppable with backspace at position zero.
   */
  const openSpecies = useCallback(() => {
    setFilter("species");
    setPaletteOpen(true);
    settle();
  }, [settle]);

  /**
   * Toggle the panel, moving the focus ring to the control's surviving mount
   * point (the switch unmounts on toggle, else the reader is dropped on `body`).
   * Only when the press came from a toggle, not from `S`. In an effect, not a
   * frame, since the new button exists only after React commits.
   */
  const restoreToggleFocus = useRef(false);
  const toggleSidebar = useCallback(() => {
    restoreToggleFocus.current =
      document.activeElement instanceof HTMLElement &&
      document.activeElement.closest(".side-toggle, .viewport-slot.is-left") !==
        null;
    sidebar.toggle();
  }, [sidebar]);

  useEffect(() => {
    if (!restoreToggleFocus.current) return;
    restoreToggleFocus.current = false;
    document
      .querySelector<HTMLElement>(".side-toggle, .viewport-slot.is-left button")
      ?.focus();
  }, [sidebar.open]);

  const clearCanvas = useCallback(() => {
    tree.clear();
    setConfirmClear(false);
    settle();
    toast("Canvas cleared");
  }, [tree, toast, settle]);

  /**
   * Full keyboard operation on bare letters. Three guards before any binding
   * matches: a text field, an open palette, and an open dialog each own the
   * keyboard. Rebuilt freely — `useWindowKeys` subscribes once and calls through
   * a ref (see `chrome/keys.ts`).
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
          setFilter(null);
        }
        return;
      }

      // Global scope: this prevents the default of everything it matches, which
      // is why Enter and Tab are not in it (see `bindings.ts`'s `Scope`).
      const action = matchKey(e);
      if (action === null) return;
      // `/` opens quick-find in Firefox, so even a bare-letter table needs this.
      e.preventDefault();

      switch (action) {
        case "sidebar":
          toggleSidebar();
          break;
        case "search":
          openPalette();
          break;
        case "add-taxon":
          openSpecies();
          break;
        case "fit":
          setFitSignal({ kind: "all", token: Date.now() });
          break;
        case "fit-selection":
          // Falls back to framing everything when there is no selection.
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
      toggleSidebar,
    ],
  );

  // Registered once, and called through a ref. `chrome/keys.ts` is the whole of
  // that fix and the account of the bug it is for.
  useWindowKeys(onKey);

  /**
   * The three that act on the view (how much you see) rather than the tree, top
   * right. Disabled rather than hidden, so the cluster does not reshuffle under a
   * reader's reach — except fullscreen on a browser without it, which is absent
   * (see `chrome/CanvasChrome.tsx`).
   */
  const viewportActions: ViewportAction[] = useMemo(() => {
    const out: ViewportAction[] = [
      {
        id: "fit",
        glyph: "⤢",
        run: () => setFitSignal({ kind: "all", token: Date.now() }),
        ...(empty
          ? { disabledBecause: "Nothing on the canvas to frame yet" }
          : viewFit
            ? { disabledBecause: "The whole tree is already framed" }
            : {}),
      },
      {
        id: "isolate",
        glyph: "◎",
        run: () => tree.toggleIsolate(),
        active: tree.view.isolate,
        ...(focusedIdx === null
          ? {
              disabledBecause:
                "Select a taxon first — isolate dims everything off its path",
            }
          : {}),
      },
    ];
    if (FULLSCREEN_AVAILABLE) {
      out.push({
        id: "fullscreen",
        glyph: "⛶",
        run: fullscreen.toggle,
        active: fullscreen.on,
      });
    }
    return out;
  }, [tree, empty, viewFit, focusedIdx, fullscreen]);

  // The Taxa list's rows: `induced.leaves` (what the canvas draws), not
  // `view.keys`, so the panel and canvas cannot disagree about what is on screen.
  const taxaRows = useMemo(
    () =>
      tree.induced.leaves
        .map((i) => tree.nodes.get(i))
        .filter((n): n is PathNode => n !== undefined),
    [tree.induced.leaves, tree.nodes],
  );

  const fossilRows = useMemo(
    () =>
      tree.view.fossils
        .map((n) => tree.fossils.get(n))
        .filter((f): f is FossilTaxon => f !== undefined),
    [tree.view.fossils, tree.fossils],
  );

  // The mode on the document body, for the chrome outside the canvas (which
  // carries its own class). Written from the same boolean, so they cannot disagree.
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
          onDeltaLanded={tree.deltaLanded}
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
          labels={tree.labels}
          ages={tree.ages}
          intervals={timescale}
          fitSignal={fitSignal}
          onFitState={setViewFit}
          cardOpen={cardOpen}
          drill={tree.view.drill}
          onDrill={tree.setDrill}
          grafts={grafts}
          holdMaxAge={tree.holdMaxAge}
          biolum={tree.biolum}
          // A lane row selects, exactly as a mark on the canvas does. Same
          // `sel=` in the URL, same card slot — see `focusedTaxonNo`. The lane
          // itself is untouched: `drill` is separate state, so the row stays
          // where it is and the reader can go straight to the next one.
          onPickFossil={(f) => {
            const taxonNo = f.pbdb_taxon_no ?? 0;
            if (taxonNo > 0) tree.select(graftKey(taxonNo));
          }}
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
              {/*
                No wordmark here any more. The panel beside this block carries
                it, three centimetres to the left, at the top of the same
                screen — and an `h1` repeated twice on one view is a second
                document heading as well as a second logo.
              */}
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
                  below this line therefore has three taxa or more.

                  "Name" rather than "pick" because picking is what you do from
                  a list somebody else wrote.

                  **And it opens on the payoff rather than the mechanism**,
                  which took two tries. This file's own predecessor was thrown
                  out for saying "press S and search for two species" — which
                  "described the mechanism … rather than the payoff, and nobody
                  wants a minimal subtree. They want to find out they are a
                  fish." "How — and when" is the whole product in three words.
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
                  show it, so there is nothing left to be behind.
                */}
                  <OpeningCarousel onOpen={openOpening} keyToOpen />
                  {/*
                  **The keys column is gone, and the sidebar is why.**

                  It was three badges — `S` search, `R` random, `P` commands —
                  under the carousel, and it existed because the control bar
                  along the top was a row of small buttons a reader had to
                  notice. The panel beside this block is now showing *Add a
                  taxon* and the die as full-width controls with their letters
                  printed on them, and the search pill above those says `/`. A
                  column repeating all three in the middle of the canvas is the
                  same offer made twice, two feet apart, with the second copy
                  sitting on top of the tree.

                  What survives is the one offer the panel does not make, which
                  is the way *out* of this screen. It centres now that there is
                  nothing beside it.
                */}
                  <div className="boot-alt">
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
                      The one mark saying this is a door. Quiet, and
                      deliberately not the carousel's accent: that one is the
                      lit mark on this canvas and there may only be one.
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
          setFilter(null);
        }}
        commands={commands}
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
        Two clusters in the canvas's own corners, drawn by one component.

        The left pair is the panel's switch and the way into the search, and it
        is drawn **only while the panel is shut** — open, the switch is in the
        panel's header beside the wordmark and the search is a field in the
        column. The right three act on the view.

        They fade together when nobody has moved for four seconds, except that
        the left pair does not: chrome auto-hides because the canvas is the
        page, and that rule was written for a bar of nine buttons — a control
        that puts the whole panel back has to be findable by somebody who has
        just realised they want it. `afterglow` holds even the right-hand fade
        open, because a reader reading the answer to their question is exactly
        the reader holding still.
      */}
      {!sidebar.open && (
        <CanvasLeftControls onToggle={toggleSidebar} onSearch={openPalette} />
      )}
      <div
        className={`viewport-slot${idle && afterglow === null ? " idle" : ""}`}
      >
        <ViewportControls actions={viewportActions} />
      </div>

      {/*
        Undocked, the panel is over the canvas rather than beside it, so it
        needs a way out that is not the toggle underneath it. A scrim is that
        way out and is also what says the canvas is not live: without one, taps
        land on marks the reader cannot see.
      */}
      {!sidebar.docked && sidebar.open && (
        <div
          className="side-scrim"
          onClick={() => sidebar.setOpen(false)}
          aria-hidden="true"
        />
      )}

      <Sidebar
        open={sidebar.open}
        docked={sidebar.docked}
        onToggle={toggleSidebar}
        onSearch={openPalette}
        {...(tipShown ? { tip: TIP_LINE } : {})}
        busy={busy}
        taxa={{
          nodes: taxaRows,
          fossils: fossilRows,
          selectedIdx: focusedTaxonNo === null ? focusedIdx : null,
          selectedTaxonNo: focusedTaxonNo,
          labels: tree.labels,
          onSelectNode: (n) => tree.select(n.key),
          onRemoveNode: (n) => removeNode(n as NodeDetail),
          onSelectFossil: (f) => {
            const no = f.pbdb_taxon_no ?? 0;
            if (no > 0) tree.select(graftKey(no));
          },
          onRemoveFossil: (f) => {
            const no = f.pbdb_taxon_no ?? 0;
            if (no <= 0) return;
            tree.removeFossil(no);
            toast(
              <>
                Removed <strong>{f.name}</strong>
              </>,
            );
          },
          onAdd: openSpecies,
          onRandom: () => void randomPick(),
          onClear: () => setConfirmClear(true),
          picking,
        }}
        labels={tree.labels}
        onLabels={tree.setLabels}
        ages={tree.ages}
        onAges={tree.setAges}
        biolum={tree.biolum}
        onBiolum={(v) => {
          if (v !== tree.biolum) tree.toggleBiolum();
        }}
        onShare={share}
        onAbout={goAbout}
      />
    </>
  );
}

// `showCredits` and `showAbout` used to live here as five-second toasts. Both
// are now `chrome/About.tsx`, which says why one panel replaced two notices.
