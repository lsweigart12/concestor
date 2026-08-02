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
  ping,
  type About,
  type FossilTaxon,
  type FossilDetail,
  type NodeDetail,
  type PathNode,
  type SearchHit,
  type TimescaleInterval,
} from "./api";
import { Graph } from "./canvas/Graph";
import { isScientificItalic } from "./canvas/NodeMark";
import { Detail } from "./detail/Detail";
import { FossilCard } from "./detail/FossilCard";
import { idxFromKey, selectionKeyFor } from "./detail/target";
import {
  buildGrafts,
  graftIdx,
  isGraftIdx,
  makeGraft,
  parseGraftKey,
  type GraftRefusal,
} from "./tree/graft";
import { Palette, type Command, type PaletteFilter, type Scope } from "./palette/Palette";
import { Confirm } from "./chrome/Confirm";
import { Controls, type ControlAction } from "./chrome/Controls";
import { kbd, matchKey } from "./chrome/bindings";
import { resetUsage } from "./palette/fuzzy";
import { toApiKey, useTree } from "./state/store";
import { laneHue } from "./tree/layout";
import { divergenceFor, nestedSelections } from "./tree/naming";

interface Toast {
  id: number;
  body: React.ReactNode;
  warn?: boolean;
}

/**
 * How long a graft refusal must persist before it is worth saying, in ms.
 *
 * Long enough to outlast a path fetch on a local API and short enough that a
 * real refusal still feels like a response to the click that caused it.
 */
const REFUSAL_SETTLE_MS = 700;
const REFUSAL_REASONS: GraftRefusal[] = ["off-tree", "no-range", "no-identity"];

/**
 * How many candidates a random pick asks for.
 *
 * One would do almost always. The extras cost a few hundred bytes and buy the
 * one thing a single pick cannot have: the certainty that the confirmation is
 * true. Adding a species already on the canvas changes nothing, and a toast
 * reading "Added Pallas's cat" over an unchanged canvas is worse than no
 * command at all.
 */
const RANDOM_CANDIDATES = 12;

export default function App() {
  const tree = useTree();
  // Closed on load. The canvas is the page; the boot hint says how to open it.
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [scoped, setScoped] = useState(false);
  /** Non-null when the palette is answering about one corpus only. */
  const [filter, setFilter] = useState<PaletteFilter | null>(null);
  const [confirmClear, setConfirmClear] = useState(false);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [about, setAbout] = useState<About | null>(null);
  const [timescale, setTimescale] = useState<TimescaleInterval[] | null>(null);
  const [detail, setDetail] = useState<NodeDetail | null>(null);
  const [fossilDetail, setFossilDetail] = useState<FossilDetail | null>(null);
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
  const [reachable, setReachable] = useState<boolean | null>(null);
  const [idle, setIdle] = useState(false);
  const toastId = useRef(0);

  const toast = useCallback((body: React.ReactNode, warn = false) => {
    const id = ++toastId.current;
    setToasts((t) => [...t, { id, body, warn }]);
    window.setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 5200);
  }, []);

  // Boot. The API is a hard dependency for search; say so plainly rather than
  // rendering an empty canvas that looks like it worked.
  useEffect(() => {
    (async () => {
      const ok = await ping();
      setReachable(ok);
      if (!ok) return;
      api.about().then(setAbout).catch(() => {});
      api
        .timescale()
        .then((t) => setTimescale(t.intervals))
        .catch(() => {
          // The geologic band is a reference scale, not the subject. Its
          // absence costs legibility, not correctness.
        });
    })();
  }, []);

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

  useEffect(() => {
    if (!selectedNodeKey) {
      setDetail(null);
      return;
    }
    let cancelled = false;
    api
      .node(toApiKey(selectedNodeKey))
      .then((d) => {
        // `/v1/node` explains a broken taxon rather than 404ing, and that
        // payload has no `idx` — rendering it as a card would print `undefined`
        // against every figure. The canvas already announces broken taxa in the
        // reader's language; here the card simply does not open.
        if (!cancelled) setDetail(typeof d.idx === "number" ? d : null);
      })
      .catch(() => !cancelled && setDetail(null));
    return () => {
      cancelled = true;
    };
  }, [selectedNodeKey]);

  // The fossil card's own payload. A separate fetch from the node card's and a
  // separate piece of state, because the two cards show different things: this
  // one carries the drawing's credit and the attachment point's name, and has
  // no age, no tip count and no ancestry to show.
  useEffect(() => {
    if (focusedTaxonNo === null) {
      setFossilDetail(null);
      return;
    }
    let cancelled = false;
    api
      .fossil(focusedTaxonNo)
      .then((d) => !cancelled && setFossilDetail(d))
      .catch(() => !cancelled && setFossilDetail(null));
    return () => {
      cancelled = true;
    };
  }, [focusedTaxonNo]);

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

  const focusedNode = focusedIdx !== null ? tree.nodes.get(focusedIdx) : undefined;

  const addHit = useCallback(
    (hit: SearchHit) => {
      tree.add(hit.key);
      setPaletteOpen(false);
      toast(
        <>
          Added{" "}
          <strong className={isScientificItalic(hit.rank) ? "sci-italic" : undefined}>
            {hit.name ?? hit.key}
          </strong>
        </>,
      );
    },
    [tree, toast],
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
    (target: string | number) => tree.select(selectionKeyFor(target, tree.nodes)),
    [tree],
  );

  const addNode = useCallback(
    (d: NodeDetail) => {
      tree.add(d.key);
      toast(
        <>
          Added{" "}
          <strong className={isScientificItalic(d.rank) ? "sci-italic" : undefined}>
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
          <strong className={isScientificItalic(d.rank) ? "sci-italic" : undefined}>
            {d.name ?? d.key}
          </strong>
        </>,
      );
    },
    [tree, toast],
  );

  const share = useCallback(() => {
    const url = window.location.href;
    navigator.clipboard
      ?.writeText(url)
      .then(() => toast("Link copied — every view is a shareable URL"))
      .catch(() => toast("Could not reach the clipboard", true));
  }, [toast]);

  const present = useMemo(() => new Set(tree.induced.leaves), [tree.induced.leaves]);
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
   * you have already thought of a species. Nobody browses 2.4 million of them,
   * and for an audience of curious people rather than systematists the first
   * move is the hard one — so there has to be an action that answers "show me
   * *something*".
   *
   * Both picks come from `/v1/random`, which draws only from taxa that carry
   * their own drawing. That filter is the whole design: a uniform draw over the
   * corpus returns an unnamed `mrcaott…` clade or an undescribed mite, and a
   * surprise that is mostly nothing to look at is one a reader stops pressing.
   * The server-side note on `RandomNodes` has the pools and the counts.
   *
   * Over-asking and filtering here is what keeps the confirmation honest.
   * Adding something already on the canvas is a no-op, and a toast saying
   * "Added X" over a canvas that did not change is a false statement about the
   * one thing the reader was watching for.
   */
  const randomSpecies = useCallback(async () => {
    setPaletteOpen(false);
    try {
      const r = await api.random("species", RANDOM_CANDIDATES);
      if (!r.available) {
        toast(
          "This build has no silhouette resolution, so there is no pool of drawn species to pick from.",
          true,
        );
        return;
      }
      const hit = r.results.find((h) => !present.has(h.idx));
      if (!hit) {
        // Only reachable with the whole draw already on screen, which needs a
        // canvas of thousands. Saying so beats a confirmation that lies.
        toast("Every pick this round is already on the canvas — try again.", true);
        return;
      }
      tree.add(hit.key);
      toast(
        <>
          Added{" "}
          <strong className={isScientificItalic(hit.rank) ? "sci-italic" : undefined}>
            {hit.name ?? hit.key}
          </strong>
          {hit.vernacular ? <> — {hit.vernacular}</> : null}
        </>,
      );
    } catch {
      toast("Could not reach the search API for a random pick", true);
    }
  }, [tree, toast, present]);

  const randomFossil = useCallback(async () => {
    setPaletteOpen(false);
    try {
      const r = await api.random("fossil", RANDOM_CANDIDATES);
      if (!r.available) {
        toast(
          "This build has no fossil drawings, so there is no pool of illustrated fossils to pick from.",
          true,
        );
        return;
      }
      const f = r.fossils.find((x) => !presentFossils.has(x.pbdb_taxon_no ?? -1));
      if (!f) {
        toast("Every pick this round is already drawn — try again.", true);
        return;
      }
      // `drawFossil` does the rest, including adding the clade the fossil hangs
      // below when it is not on the canvas. That is not an extra here, it is
      // the whole command: a random fossil almost always attaches to a branch
      // nobody has drawn yet, so without it the usual outcome would be a
      // refusal notice for something the reader never chose by name.
      await drawFossil(f);
    } catch {
      toast("Could not reach the search API for a random pick", true);
    }
  }, [drawFossil, toast, presentFossils]);

  const commands: Command[] = useMemo(() => {
    const base: Command[] = [
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
      {
        id: "axis",
        title: `Switch time axis to ${tree.view.axis === "log" ? "linear" : "logarithmic"}`,
        subtitle:
          tree.view.axis === "log"
            ? "Linear puts every recent divergence in one pixel"
            : "Symlog: linear to 1 Ma, logarithmic above",
        icon: "⇄",
        keys: kbd("axis"),
        section: "View",
        run: () => {
          tree.setAxis(tree.view.axis === "log" ? "linear" : "log");
          setPaletteOpen(false);
        },
      },
      {
        // No key of its own, and that is the cost of a modifier-free surface
        // rather than an oversight: the letters that would be honest here — `s`
        // for share, `l` for link — are the two most-used bindings in the app.
        // It is one of the few actions nobody reaches for mid-flow.
        id: "share",
        title: "Copy shareable link",
        subtitle: "All view state lives in the URL",
        icon: "↗",
        section: "View",
        run: () => {
          share();
          setPaletteOpen(false);
        },
      },
      // Filed under Selection rather than under a section of their own: what
      // they do is add to the selection, and the reader who wants one is the
      // reader looking at an empty canvas wondering what to put on it.
      {
        id: "random-species",
        title: "Add a random species",
        subtitle: "Something illustrated, picked for you",
        hint:
          "Draws from the ~14,000 taxa that have a silhouette of their own, so the pick " +
          "always arrives with a picture rather than a bare name. Press again to keep going " +
          "— each one joins the tree through its common ancestors with whatever is already here.",
        icon: "✦",
        keys: kbd("random-species"),
        section: "Selection",
        run: () => void randomSpecies(),
      },
      {
        id: "random-fossil",
        title: "Draw a random fossil",
        subtitle: "An illustrated extinct taxon, at its own date",
        hint:
          "Picked from PBDB taxa that are drawn, extinct, and carry a stratigraphic range — " +
          "the three things it takes to place one on the axis. It hangs off the branch it " +
          "belongs below, and the clade it needs is added if the canvas has not got it yet.",
        icon: "◈",
        keys: kbd("random-fossil"),
        section: "Selection",
        run: () => void randomFossil(),
      },
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
      {
        id: "credits",
        title: "Credits and sources",
        subtitle: "Silhouette artists, data provenance, licences",
        icon: "©",
        section: "About",
        run: () => {
          setPaletteOpen(false);
          showCredits(about, toast);
        },
      },
      {
        id: "about",
        title: "What this is made of",
        subtitle: about ? `build ${about.build_id}` : "Build provenance",
        icon: "i",
        section: "About",
        run: () => {
          setPaletteOpen(false);
          showAbout(about, toast);
        },
      },
      {
        id: "reset-ranking",
        title: "Reset search ranking",
        subtitle: "Forget recency and frequency history",
        icon: "↺",
        section: "About",
        run: () => {
          resetUsage();
          setPaletteOpen(false);
          toast("Search ranking reset to corpus signals only");
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
          tree.view.drill?.upper === anc && tree.view.drill.lower === focusedNode.idx;
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
  }, [tree, about, focusedNode, toast, share, randomSpecies, randomFossil]);

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

  /**
   * Say when a fossil in the view is not being drawn, and why.
   *
   * A graft that silently fails to appear is indistinguishable from a broken
   * canvas — the same reasoning the broken-taxon and unresolved-key notices
   * above are built on. `off-tree` is the one that happens in ordinary use, and
   * it is recoverable rather than fatal: removing the species a fossil hung
   * from takes its branch off the canvas, and putting one back brings the
   * fossil with it. So the fossil stays in the URL and the notice says what to
   * do, instead of the view quietly dropping it.
   *
   * Announced once per fossil per reason, and only once the view has held
   * still. Both halves of that are load-bearing. Without the dedup the message
   * repeats on every unrelated add; without the settle delay it fires into
   * every ordinary flow, because `off-tree` is *transiently true* twice over —
   * on a cold load before the paths land, and in the gap between drawing a
   * fossil and adding the clade it needs. Both were seen: `Dimetrodon` was
   * announced undrawable one frame before being drawn, twice, for two
   * different reasons. A graft that becomes drawable clears its mark, so
   * removing its clade later says so again.
   */
  const announce = useCallback(
    (f: FossilTaxon, reason: GraftRefusal) => {
      toast(
        reason === "off-tree" ? (
          <>
            <strong>{f.name}</strong> is not drawn: the branch it attaches to is
            not on the canvas. Add the clade it sits in and it will appear.
          </>
        ) : reason === "no-range" ? (
          <>
            <strong>{f.name}</strong> has no appearance interval recorded, so
            there is nowhere in time to put it. PBDB records none for about a
            fifth of its taxa.
          </>
        ) : (
          <>
            <strong>{f.name}</strong> cannot be drawn: this build's fossil table
            carries no identifier for it.
          </>
        ),
        true,
      );
    },
    [toast],
  );

  const announcedRefusals = useRef(new Set<string>());
  useEffect(() => {
    for (const g of grafts) {
      for (const reason of REFUSAL_REASONS) {
        announcedRefusals.current.delete(`${g.fossil.pbdb_taxon_no}:${reason}`);
      }
    }
    if (tree.loading || tree.induced.rendered.length === 0) return;
    if (graftSet.refused.length === 0) return;
    // The cleanup is what makes the delay work: any change to the refusal set
    // cancels the pending notice, so a refusal that is being resolved never
    // reaches the screen. Nobody is waiting on this message, so waiting for the
    // set to settle costs nothing.
    const t = window.setTimeout(() => {
      for (const { fossil: f, reason } of graftSet.refused) {
        const seen = `${f.pbdb_taxon_no ?? f.name}:${reason}`;
        if (announcedRefusals.current.has(seen)) continue;
        announcedRefusals.current.add(seen);
        announce(f, reason);
      }
    }, REFUSAL_SETTLE_MS);
    return () => window.clearTimeout(t);
  }, [graftSet.refused, grafts, tree.loading, tree.induced.rendered.length, announce]);

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
              subtitle: "Placed at its own date, hanging off the branch it belongs to",
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
    out.push(
      {
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
      },
    );
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
          toast(<>Added <strong>{hostName}</strong></>);
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
  }, []);

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
  }, []);

  const clearCanvas = useCallback(() => {
    tree.clear();
    setConfirmClear(false);
    toast("Canvas cleared");
  }, [tree, toast]);

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

  const empty = tree.induced.rendered.length === 0 && tree.view.fossils.length === 0;

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
   */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
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

      const action = matchKey(e);
      if (action === null) return;
      // Everything below is ours, so nothing below reaches the browser. Tab
      // would otherwise walk the focus ring and `/` opens quick-find in Firefox.
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
        case "random-species":
          void randomSpecies();
          break;
        case "random-fossil":
          void randomFossil();
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
          if (tree.view.drill) tree.setDrill(null);
          else tree.select(null);
          break;
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [
    tree,
    focusedIdx,
    focusedNode,
    toast,
    randomSpecies,
    randomFossil,
    openPalette,
    openSpecies,
    stepSelection,
    paletteOpen,
    confirmClear,
    empty,
  ]);

  /**
   * The control bar's rows, which are the bindings with their callbacks bound.
   *
   * Contextual actions stay in the bar and go grey, rather than appearing and
   * disappearing as the selection changes: a bar that reshuffles under a
   * reader's hand costs them the button they were reaching for, and the
   * tooltip on a disabled one says what would make it work.
   */
  const controls: ControlAction[] = useMemo(
    () => [
      { id: "palette", run: openPalette },
      { id: "species", run: openSpecies },
      { id: "random-species", run: () => void randomSpecies() },
      { id: "random-fossil", run: () => void randomFossil() },
      {
        id: "fit",
        run: () => setFitSignal({ kind: "all", token: Date.now() }),
        ...(empty ? { disabledBecause: "Nothing on the canvas to frame yet" } : {}),
      },
      {
        id: "isolate",
        run: () => tree.toggleIsolate(),
        active: tree.view.isolate,
        ...(focusedIdx === null
          ? { disabledBecause: "Select a node first — isolate dims everything off its path" }
          : {}),
      },
      {
        id: "step",
        run: () => stepSelection(false),
        ...(tree.induced.leaves.length === 0
          ? { disabledBecause: "Add a species and this steps through the selection" }
          : {}),
      },
      {
        id: "clear",
        run: () => setConfirmClear(true),
        ...(empty ? { disabledBecause: "The canvas is already empty" } : {}),
      },
    ],
    [
      openPalette,
      openSpecies,
      randomSpecies,
      randomFossil,
      stepSelection,
      tree,
      focusedIdx,
      empty,
    ],
  );

  // Chrome auto-hides. The canvas is the page.
  useEffect(() => {
    let t = window.setTimeout(() => setIdle(true), 4000);
    const wake = () => {
      setIdle(false);
      window.clearTimeout(t);
      t = window.setTimeout(() => setIdle(true), 4000);
    };
    window.addEventListener("mousemove", wake);
    window.addEventListener("keydown", wake);
    return () => {
      window.clearTimeout(t);
      window.removeEventListener("mousemove", wake);
      window.removeEventListener("keydown", wake);
    };
  }, []);

  if (reachable === false) {
    return (
      <div className="boot">
        <div className="boot-inner">
          <h1>Concestor</h1>
          <p>
            The read API is not answering. It serves the baked artifacts — the
            topology arrays, the age tiers and the search index — and the app
            cannot resolve a species without it.
          </p>
          <p>
            Start it with <code>go run ./server -build ./build</code> from the
            repository root, then reload.
          </p>
        </div>
      </div>
    );
  }

  return (
    <>
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
        intervals={timescale}
        fitSignal={fitSignal}
        drill={tree.view.drill}
        onDrill={tree.setDrill}
        grafts={grafts}
        onPickFossil={(f) => {
          setPickedFossil(f);
          setScoped(true);
          setPaletteOpen(true);
        }}
      />

      {tree.induced.rendered.length === 0 && !paletteOpen && (
        <div className="boot">
          <div className="boot-inner">
            <h1>Concestor</h1>
            <p>
              Press <span className="kbd">{kbd("species")}</span> and search for
              two species. You will get the smallest tree that connects them
              through their common ancestor.
            </p>
            <p className="boot-alt">
              Or press <span className="kbd">{kbd("random-species")}</span> for a
              species picked for you — every key here is also a button along the
              top.
            </p>
          </div>
        </div>
      )}

      {fossilDetail && focusedTaxonNo !== null && (
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
      {detail && focusedTaxonNo === null && (
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
      />

      {confirmClear && (
        <Confirm
          title="Clear the canvas?"
          body={
            <>
              This takes <strong>{tree.induced.leaves.length}</strong>{" "}
              species
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

      <div className="toasts">
        {toasts.map((t) => (
          <div className={`toast${t.warn ? " warn" : ""}`} key={t.id}>
            {t.body}
          </div>
        ))}
      </div>

      <Controls actions={controls} idle={idle} busy={tree.loading} />
    </>
  );
}

/** The credits view is a command, not a settings panel. */
function showCredits(about: About | null, toast: (b: React.ReactNode) => void) {
  toast(
    <>
      <strong>Sources.</strong> Topology from the Open Tree of Life synthesis
      v16.1 and OTT 3.7.3. Ages from Duke et al. 2026 (CC-BY, Zenodo
      10.5281/zenodo.19049120). Silhouettes from PhyloPic, credited per image in
      the node card. Geologic timescale from ICS. Fossil occurrences from the
      Paleobiology Database. Descriptions from Wikipedia (CC BY-SA), fetched as
      you open a card and credited on it.
      {about?.build_id ? (
        <>
          {" "}
          Build <span className="mono">{about.build_id}</span>.
        </>
      ) : null}
    </>,
  );
}

function showAbout(about: About | null, toast: (b: React.ReactNode, warn?: boolean) => void) {
  if (!about) {
    toast("Build provenance is unavailable — the API did not answer.", true);
    return;
  }
  toast(
    <>
      <strong>Build {about.build_id}.</strong>{" "}
      {about.age?.headline ??
        `${(about.counts.nodes ?? 0).toLocaleString()} nodes.`}{" "}
      Ages come from {about.age?.source_tree ?? "an unrecorded tree"}
      {about.age?.phase2_accepted === false
        ? " and have NOT passed validation — they are provisional."
        : "."}
    </>,
  );
}
