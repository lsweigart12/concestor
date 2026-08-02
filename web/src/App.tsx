/**
 * Concestor.
 *
 * Pick species, see the minimal subtree connecting them through their common
 * ancestors, laid out against deep time.
 *
 * Every action has a command and the mouse is a convenience path, never
 * required. Confirmations are brief HUD toasts — no modals, no dialogs, and no
 * settings panel that duplicates something a command already does.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  api,
  ping,
  TIER_OCCURRENCE,
  TIER_STRUCTURAL,
  type About,
  type FossilTaxon,
  type FossilDetail,
  type NodeDetail,
  type PathNode,
  type SearchHit,
  type TimescaleInterval,
} from "./api";
import { bracketGeom, bracketTitle, endedSpanLabel, gapLabel } from "./canvas/Bracket";
import { Graph } from "./canvas/Graph";
import { Silhouette } from "./canvas/Silhouette";
import { mayDrawExemplar, witnessOn } from "./canvas/witness";
import {
  ageLabel,
  DerivedName,
  isScientificItalic,
  placementNote,
} from "./canvas/NodeMark";
import {
  buildGrafts,
  graftIdx,
  isGraftIdx,
  makeGraft,
  parseGraftKey,
  type Graft,
  type GraftRefusal,
} from "./tree/graft";
import { Palette, type Command, type Scope } from "./palette/Palette";
import { resetUsage } from "./palette/fuzzy";
import { useTree } from "./state/store";
import { laneHue } from "./tree/layout";
import {
  branchProse,
  divergenceFor,
  nestedSelections,
  UNNAMED,
  type Divergence,
} from "./tree/naming";

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

const isMac = navigator.platform.toLowerCase().includes("mac");
const mod = isMac ? "⌘" : "Ctrl";

export default function App() {
  const tree = useTree();
  // Closed on load. The canvas is the page; the boot hint says how to open it.
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [scoped, setScoped] = useState(false);
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
    const direct = tree.idxOf.get(k) ?? tree.idxOf.get(`ott${k}`);
    if (direct !== undefined) return direct;
    const n = [...tree.nodes.values()].find(
      (x) => x.key === k || String(x.ott_id) === k,
    );
    return n?.idx ?? null;
  }, [tree.view.selected, focusedTaxonNo, tree.idxOf, tree.nodes]);

  useEffect(() => {
    if (focusedIdx === null || focusedTaxonNo !== null) {
      setDetail(null);
      return;
    }
    const n = tree.nodes.get(focusedIdx);
    if (!n) return;
    let cancelled = false;
    api
      .node(n.key)
      .then((d) => !cancelled && setDetail(d))
      .catch(() => !cancelled && setDetail(null));
    return () => {
      cancelled = true;
    };
  }, [focusedIdx, focusedTaxonNo, tree.nodes]);

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

  const share = useCallback(() => {
    const url = window.location.href;
    navigator.clipboard
      ?.writeText(url)
      .then(() => toast("Link copied — every view is a shareable URL"))
      .catch(() => toast("Could not reach the clipboard", true));
  }, [toast]);

  const commands: Command[] = useMemo(() => {
    const base: Command[] = [
      {
        id: "fit-all",
        title: "Fit all",
        subtitle: "Frame the whole induced subtree",
        icon: "⤢",
        keys: `${mod}0`,
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
        keys: `${mod}⇧L`,
        section: "View",
        run: () => {
          tree.setAxis(tree.view.axis === "log" ? "linear" : "log");
          setPaletteOpen(false);
        },
      },
      {
        id: "share",
        title: "Copy shareable link",
        subtitle: "All view state lives in the URL",
        icon: "↗",
        keys: `${mod}S`,
        section: "View",
        run: () => {
          share();
          setPaletteOpen(false);
        },
      },
      {
        id: "clear",
        title: "Clear the canvas",
        subtitle: "Remove every selection",
        icon: "×",
        keys: `${mod}⇧K`,
        section: "Selection",
        run: () => {
          tree.clear();
          setPaletteOpen(false);
          toast("Canvas cleared");
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
          keys: `${mod}\\`,
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
          keys: `${mod}.`,
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
          ...(open ? { keys: "esc" } : {}),
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
          keys: "⌫",
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
  }, [tree, about, focusedNode, toast, share]);

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

  // Full keyboard operation: search, add, remove, clear, fit, isolate and step
  // through selection are all bound.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const meta = isMac ? e.metaKey : e.ctrlKey;
      const inField =
        e.target instanceof HTMLElement &&
        (e.target.tagName === "INPUT" || e.target.isContentEditable);

      if (meta && e.key.toLowerCase() === "k") {
        e.preventDefault();
        // ⌘K with a node selected opens a contextual actions menu scoped to
        // it. A fossil scope is per-click and never survives into the next
        // ⌘K, or the palette answers about a row nobody is looking at.
        setPickedFossil(null);
        setScoped(e.shiftKey ? false : focusedIdx !== null);
        if (e.shiftKey) {
          tree.clear();
          toast("Canvas cleared");
          return;
        }
        setPaletteOpen((o) => !o);
        return;
      }
      if (inField) return;

      if (meta && e.key === "0") {
        e.preventDefault();
        setFitSignal({ kind: "all", token: Date.now() });
      } else if (meta && e.key === ".") {
        e.preventDefault();
        setFitSignal({ kind: "selection", token: Date.now() });
      } else if (meta && e.key === "\\") {
        e.preventDefault();
        tree.toggleIsolate();
      } else if (meta && e.shiftKey && e.key.toLowerCase() === "l") {
        // ⇧ is load-bearing. Plain ⌘L is the browser's own "focus the URL bar"
        // and a page cannot preventDefault it, so the axis never toggled;
        // adding shift keeps the L-for-log mnemonic and reaches us.
        e.preventDefault();
        tree.setAxis(tree.view.axis === "log" ? "linear" : "log");
      } else if (meta && e.key.toLowerCase() === "s") {
        e.preventDefault();
        share();
      } else if (e.key === "Escape") {
        // One key, innermost thing first — the same order the palette closes
        // in. A drill-down lane is a thing you opened over the canvas, so it
        // goes before the selection does; otherwise dismissing it costs two
        // presses and the first one silently does something else.
        if (tree.view.drill) tree.setDrill(null);
        else tree.select(null);
      } else if ((e.key === "Backspace" || e.key === "Delete") && focusedNode) {
        e.preventDefault();
        if (tree.induced.leaves.includes(focusedNode.idx)) {
          tree.remove(focusedNode.key);
          toast(`Removed ${focusedNode.name ?? focusedNode.key}`);
        }
      } else if (e.key === "Tab" && tree.induced.leaves.length) {
        // Step through the selection without leaving the keyboard.
        e.preventDefault();
        const ls = tree.induced.leaves;
        const at = focusedIdx === null ? -1 : ls.indexOf(focusedIdx);
        const next = ls[(at + (e.shiftKey ? -1 + ls.length : 1)) % ls.length];
        const n = next !== undefined ? tree.nodes.get(next) : undefined;
        if (n) tree.select(n.key);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [tree, focusedIdx, focusedNode, toast, share]);

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
              Press <span className="kbd">{mod}K</span> and search for two
              species. You will get the smallest tree that connects them through
              their common ancestor.
            </p>
          </div>
        </div>
      )}

      {fossilDetail && focusedTaxonNo !== null && (
        <FossilCard
          fossil={fossilDetail}
          hue={laneHue(graftIdx(focusedTaxonNo))}
          graft={grafts.find((g) => g.idx === graftIdx(focusedTaxonNo)) ?? null}
        />
      )}

      {detail && focusedNode && (
        <Detail
          detail={detail}
          hue={laneHue(focusedNode.idx)}
          divergence={divergenceFor(focusedNode.idx, tree.induced, tree.nodes)}
          nested={nestedSelections(focusedNode.idx, tree.induced, tree.nodes)}
          isLeaf={tree.induced.leaves.includes(focusedNode.idx)}
        />
      )}

      <Palette
        open={paletteOpen}
        onClose={() => {
          setPaletteOpen(false);
          setScoped(false);
          setPickedFossil(null);
        }}
        commands={visibleCommands}
        scope={scope}
        onPick={addHit}
        onPickFossil={drawFossil}
        present={present}
        presentFossils={presentFossils}
      />

      <div className="toasts">
        {toasts.map((t) => (
          <div className={`toast${t.warn ? " warn" : ""}`} key={t.id}>
            {t.body}
          </div>
        ))}
      </div>

      <div className={`hintbar${idle ? " idle" : ""}`}>
        <span>
          <span className="kbd">{mod}K</span> commands
        </span>
        <span>
          <span className="kbd">{mod}0</span> fit
        </span>
        <span>
          <span className="kbd">{mod}\</span> isolate
        </span>
        <span>
          <span className="kbd">Tab</span> step
        </span>
        {tree.loading && <span className="mono">resolving…</span>}
      </div>
    </>
  );
}

/**
 * The card for a fossil.
 *
 * The same slot and the same anatomy as {@link Detail}, and deliberately not
 * the same content — because the two are answers to different questions and a
 * card that pretended otherwise would be the borrowed-silhouette mistake in
 * text. A node card leads with an age, a species count and a depth; a fossil
 * has none of those. What it has is a range in the rock, a count of
 * occurrences, and an attachment point whose looseness is the real caveat.
 *
 * Three things it must do that the node card does not:
 *
 *   - **Credit the drawing.** A graft puts a PhyloPic image on the canvas and
 *     CC-BY applies to whatever is on screen. Until this card existed there was
 *     nowhere for that credit to go, which was a licensing gap and not a polish
 *     item.
 *   - **Say it is not a node**, in the reader's language, once and plainly.
 *     Everything else on this canvas has a position in the tree.
 *   - **State the placement and the date as two separate uncertainties.** Where
 *     it hangs and when it lived are independent, and letting one stand in for
 *     the other is what `placementNote` exists to prevent.
 */
function FossilCard({
  fossil,
  hue,
  graft,
}: {
  fossil: FossilDetail;
  hue: number;
  /** Present when it is actually drawn; absent when the card is open cold. */
  graft: Graft | null;
}) {
  const bounds = [fossil.fea, fossil.fla, fossil.lea, fossil.lla].filter(
    (v): v is number => typeof v === "number" && Number.isFinite(v),
  );
  const span = bounds.length
    ? endedSpanLabel(Math.max(...bounds), Math.min(...bounds))
    : null;
  const sil = fossil.silhouette ?? null;
  const host = fossil.attach ?? null;
  const walk = fossil.attach_walk ?? null;
  return (
    <aside className="detail" style={{ color: `hsl(${hue} 60% 62%)` }}>
      {sil && (
        <div className="detail-image">
          <Silhouette phylopicId={sil.phylopic_id} size={110} />
          {/* No watermark. On a node card it says whose portrait this really
              is, because the drawing is nearly always of a relative. Here it
              is of this taxon — `fossil_image` matches PBDB and PhyloPic on the
              same name and never inherits — so a watermark would repeat the
              heading. */}
        </div>
      )}
      <h2
        className={
          fossil.rank === "species" || fossil.rank === "genus"
            ? "sci-italic"
            : undefined
        }
        style={{ color: "var(--ink)" }}
      >
        {fossil.name}
      </h2>
      <div className="rank">{fossil.rank ? `fossil · ${fossil.rank}` : "fossil"}</div>

      <dl>
        {/* No `age` row, and its absence is the point rather than an omission.
            Every age in this app comes from a chronogram of living species and
            an extinct taxon has no counterpart in one. */}
        <dt>fossils</dt>
        <dd className="num">{span ?? "no range recorded"}</dd>
        {fossil.n_occs > 0 && (
          <>
            <dt>occurrences</dt>
            <dd className="num">{fossil.n_occs.toLocaleString()}</dd>
          </>
        )}
        <dt>below</dt>
        <dd>{host?.name ?? `node ${fossil.attach_idx}`}</dd>
        <dt>PBDB</dt>
        <dd className="num">{fossil.pbdb_taxon_no}</dd>
      </dl>

      <p className="note">
        This is a fossil taxon, not a node in the tree. Nobody has resolved
        where its lineage branches, so it has no position of its own and no
        divergence age — what is known is where it turns up in the rock, which
        is an observation rather than an estimate.
        {walk !== null && placementNote(walk)}
      </p>

      {graft && span && (
        <p className="note">
          It is drawn hanging from{" "}
          <strong>{host?.name ?? "the branch above it"}</strong>, at its own
          date. The line meets the branch{" "}
          {graft.joinAt === "first-appearance" ? (
            <>
              at its first appearance, which is the latest its lineage can have
              parted from the rest.
            </>
          ) : graft.joinAt === "anchor" ? (
            <>
              at that point because it first appears later — its lineage parted
              somewhere below there, off the branches drawn here.
            </>
          ) : (
            <>
              as far back as the branch is drawn, because it is older than all
              of it.
            </>
          )}
        </p>
      )}

      {sil && (
        <p className="credit">
          Silhouette{sil.attribution ? ` by ${sil.attribution}` : ""}
          {sil.contributor && sil.contributor !== sil.attribution
            ? `, uploaded by ${sil.contributor}`
            : ""}{" "}
          ·{" "}
          <a href={sil.license_url} target="_blank" rel="noreferrer noopener">
            licence
          </a>{" "}
          · PhyloPic
        </p>
      )}
    </aside>
  );
}

function Detail({
  detail,
  hue,
  divergence,
  nested,
  isLeaf,
}: {
  detail: NodeDetail;
  hue: number;
  /** Set only where the taxonomy has no name and one was derived. */
  divergence: Divergence | null;
  /** Chosen species classified inside this one. Almost always empty. */
  nested: string[];
  /** A species the reader chose, rather than a divergence they arrived at. */
  isLeaf: boolean;
}) {
  const age = ageLabel(detail.age_ma, detail.tier);
  // Geometry is not wanted here — the card states the span in words — but
  // `bracketGeom` is what decides `absent` from `range`, and having one place
  // make that call keeps the card and the drill-down lane from disagreeing
  // about what a partial row means.
  const occurrence =
    detail.tier === TIER_OCCURRENCE && detail.occurrence
      ? bracketGeom(detail.occurrence, () => 0)
      : null;
  // The card must show what the canvas shows, and by the same rule, or the two
  // disagree about what a node looks like. A divergence draws its witness or
  // nothing; only a clade the reader chose draws its group's exemplar. The
  // ordinary silhouette is therefore not shown *or credited* on a fork, since
  // it is not on screen and crediting an image nobody can see is noise.
  const place = { node: detail, isLeaf };
  const witness = witnessOn(place);
  const witnessCredit = witness ? (detail.divergence_silhouette ?? null) : null;
  const sil = mayDrawExemplar(place) ? detail.silhouette : null;
  // A picture that is not of this node is a picture of something inside the
  // clade, and the card is where that gets said in full rather than in a
  // tooltip. `clade_name` is null for the unnamed `mrcaott…` nodes, and there
  // is nothing useful to name in that case.
  const borrowed = sil && sil.source_idx !== detail.idx ? sil : null;
  // What the watermark says. Normally the clade, because how far the
  // resemblance is being claimed to reach is the thing a reader needs. But an
  // unillustrated group's clade is itself — nobody drew Elminae, somebody drew
  // a riffle beetle inside it — and stamping ELMINAE across the picture on the
  // Elminae card repeats the heading instead of adding to it. There the
  // drawing's own subject is the new fact, and the credit line below carries
  // the group in full either way.
  const watermark = borrowed
    ? borrowed.clade_name && borrowed.clade_name !== detail.name
      ? borrowed.clade_name
      : borrowed.source_name
    : null;
  return (
    <aside className="detail" style={{ color: `hsl(${hue} 60% 62%)` }}>
      {witness && (
        <div className="detail-image">
          <Silhouette phylopicId={witness.phylopicId} size={110} />
          {witness.name && (
            // The witness's own name, for the same reason the borrowed case
            // stamps its clade: the fact the picture adds is what it is *of*.
            <span
              className="detail-watermark"
              title={`What this drawing is of. Not ${detail.name ?? "this node"} itself — a fossil taxon from somewhere below it, dated to about this split.`}
            >
              {witness.name}
            </span>
          )}
        </div>
      )}
      {sil && (
        <div className="detail-image">
          <Silhouette phylopicId={sil.phylopic_id} size={110} />
          {watermark && (
            // Watermarked onto the image rather than captioned beside it: the
            // claim is about *this picture*, and on the canvas the same fact
            // was wide enough to run across a neighbouring lineage.
            <span
              className="detail-watermark"
              title={`What this drawing is of. Not ${detail.name ?? "this node"} itself.`}
            >
              {watermark}
            </span>
          )}
        </div>
      )}
      <h2
        className={
          !divergence && isScientificItalic(detail.rank) ? "sci-italic" : undefined
        }
        style={{ color: "var(--ink)" }}
      >
        {divergence ? (
          <DerivedName divergence={divergence} />
        ) : (
          (detail.name ?? UNNAMED)
        )}
      </h2>
      {divergence ? (
        <div className="rank">divergence</div>
      ) : (
        detail.rank && <div className="rank">{detail.rank}</div>
      )}

      <dl>
        <dt>age</dt>
        <dd className="num">{age ?? "not estimated"}</dd>
        {occurrence && (
          // Its own row, below the age and never in place of it. The two are
          // different kinds of claim — one is when lineages parted, the other
          // is what is in the rock — and putting a range in the `age` slot
          // would say they are the same kind, which is what this tier exists
          // not to say.
          <>
            <dt>fossils</dt>
            <dd className="num" title={bracketTitle(detail.name ?? "This taxon", occurrence)}>
              {occurrence.kind === "range"
                ? endedSpanLabel(occurrence.oldest, occurrence.youngest)
                : "no range recorded"}
            </dd>
          </>
        )}
        {witness && witness.oldest !== null && witness.youngest !== null && (
          // Its own row, and never in the `age` slot. The witness's range is a
          // fact about a *different taxon* from the one this card is about —
          // putting it where this node's age goes would read as this node's
          // age, which is two wrong claims at once.
          <>
            <dt>witness</dt>
            <dd className="num">
              {endedSpanLabel(witness.oldest, witness.youngest)}
            </dd>
          </>
        )}
        <dt>species below</dt>
        <dd className="num">{detail.tip_count.toLocaleString()}</dd>
        <dt>depth</dt>
        <dd className="num">{detail.depth}</dd>
        {detail.ott_id !== null && (
          <>
            <dt>OTT</dt>
            <dd className="num">{detail.ott_id}</dd>
          </>
        )}
      </dl>

      {divergence && (
        <p className="note">
          The Open Tree taxonomy has no name for this node, so it is described
          by what it separates: it is the last common ancestor of{" "}
          {branchProse(divergence.branches)}. That is a statement about the
          tree, not a name anyone has given it.
        </p>
      )}
      {nested.length > 0 && (
        <p className="note">
          {branchProse(nested)}{" "}
          {nested.length === 1 ? "is classified" : "are classified"} inside this
          taxon rather than beside it, so the branch to{" "}
          {nested.length === 1 ? "it" : "them"} leaves from here. This node is
          both a species you chose and the divergence you are looking for.
        </p>
      )}
      {detail.tier === TIER_STRUCTURAL && (
        <p className="note">
          No age is shown because none has been estimated for this node. Its
          position on the axis is ordinal — it sits between its nearest dated
          ancestor and descendant, and in this region the horizontal axis means
          nesting depth rather than time.
        </p>
      )}
      {detail.tier === TIER_OCCURRENCE && (
        <p className="note">
          No age is shown because none has been estimated for this node: every
          age here comes from a tree of <em>living</em> species, and this taxon
          has no counterpart in one. What is known instead is where it turns up
          in the rock, which is an observation rather than an estimate — a
          range, and deliberately never a single date.
        </p>
      )}
      {detail.tier === 1 && age && (
        <p className="note">
          This clade is a subset of the one the chronogram dates, so{" "}
          <span className="num">{age}</span> is an upper bound on its true age,
          not an estimate of it.
        </p>
      )}

      {witness && (
        <p className="note">
          The picture is{" "}
          <em className={isScientificItalic(witness.rank) ? "sci-italic" : undefined}>
            {witness.name ?? "a taxon from below this fork"}
          </em>
          , not this whole group — a fossil taxon from somewhere below this
          fork, and the nearest in time that anyone has drawn. The most
          familiar thing below a split is nearly always a living group that did
          not exist when the split happened, so this shows something that did
          instead. Its dates are observations of where it turns up in the rock,
          never an estimate of when these lineages parted.
          {witness.attachWalk !== null && witness.attachWalk > 0 && (
            // Where the fossil hangs is a separate uncertainty from when it
            // lived, and the card is where both get stated rather than one
            // standing in for the other. It is not in the tree at all — it was
            // placed by walking its own classification upward until something
            // was — so "below this fork" is the strongest true statement.
            <>
              {" "}
              It is not itself in the tree:{" "}
              {witness.attachWalk <= 2
                ? "it is known to sit just below this point"
                : "all that is known is that it belongs somewhere below this point"}
              , not where on the branch.
            </>
          )}
          {age === null ? (
            <>
              {" "}
              This fork has no estimated age, so the match was made against
              where it is <em>drawn</em> on the axis rather than against a date.
              Read the pairing loosely: the picture is the closest available,
              not a claim that the two coincide.
            </>
          ) : witness.spans ? (
            <> Its range does contain this split.</>
          ) : (
            // The gap is spelled out rather than left for the reader to
            // subtract, because at these scales rounding hides it: the
            // horse–rhino fork is dated 56.26 Ma and Eohippus tops out at 56.0,
            // so both figures above read "56" and the sentence looks like a
            // contradiction. Saying "by 0.3 Ma" is the only thing that resolves
            // it, and it is worth saying at every size.
            <>
              {" "}
              Its range does not reach this split
              {witness.gapMa !== null && witness.gapMa > 0 ? (
                <>
                  {" "}
                  — it stops <span className="num">
                    {gapLabel(witness.gapMa)}
                  </span>{" "}
                  short
                </>
              ) : null}
              . Read the picture as the nearest available, not a contemporary.
            </>
          )}
        </p>
      )}
      {detail.vernaculars.length > 0 && (
        <p className="note">Also known as {detail.vernaculars.slice(0, 6).join(", ")}.</p>
      )}

      {witnessCredit && (
        // Credited on its own terms: a different drawing by a different artist
        // from the one `sil` would have carried, and it is the one on screen.
        <div className="credit">
          Silhouette of <em>{witnessCredit.source_name ?? "a taxon from below this fork"}</em>
          {" — "}
          {witnessCredit.attribution
            ? `by ${witnessCredit.attribution}`
            : "creator not recorded"}
          {witnessCredit.contributor &&
          witnessCredit.contributor !== witnessCredit.attribution
            ? `, uploaded by ${witnessCredit.contributor}`
            : ""}
          .
        </div>
      )}
      {sil && (
        <div className="credit">
          Silhouette{" "}
          {borrowed ? (
            <>
              of <em>{borrowed.source_name ?? "a relative"}</em>
              {borrowed.clade_name ? (
                <>
                  , the closest relative anyone has drawn — both are within{" "}
                  <em>{borrowed.clade_name}</em>
                  {borrowed.clade_tip_count
                    ? `, ${borrowed.clade_tip_count.toLocaleString()} species`
                    : ""}
                </>
              ) : (
                ", the closest relative anyone has drawn"
              )}
              {" — "}
            </>
          ) : null}
          {sil.attribution ? `by ${sil.attribution}` : "creator not recorded"}
          {sil.contributor && sil.contributor !== sil.attribution
            ? `, uploaded by ${sil.contributor}`
            : ""}
          .{" "}
          <a href={sil.license_url} target="_blank" rel="noreferrer noopener">
            licence
          </a>
        </div>
      )}
    </aside>
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
      Paleobiology Database.
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
