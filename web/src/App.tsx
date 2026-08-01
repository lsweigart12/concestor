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
  silhouetteIsInformative,
  TIER_STRUCTURAL,
  type About,
  type NodeDetail,
  type SearchHit,
  type TimescaleInterval,
} from "./api";
import { Graph } from "./canvas/Graph";
import { Silhouette } from "./canvas/Silhouette";
import { ageLabel, isScientificItalic } from "./canvas/NodeMark";
import { Palette, type Command, type Scope } from "./palette/Palette";
import { resetUsage } from "./palette/fuzzy";
import { useTree } from "./state/store";
import { laneHue } from "./tree/layout";

interface Toast {
  id: number;
  body: React.ReactNode;
  warn?: boolean;
}

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
  const [fitSignal, setFitSignal] = useState<{
    kind: "all" | "selection";
    token: number;
  } | null>(null);
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

  const focusedIdx = useMemo(() => {
    if (!tree.view.selected) return null;
    const k = tree.view.selected;
    const direct = tree.idxOf.get(k) ?? tree.idxOf.get(`ott${k}`);
    if (direct !== undefined) return direct;
    const n = [...tree.nodes.values()].find(
      (x) => x.key === k || String(x.ott_id) === k,
    );
    return n?.idx ?? null;
  }, [tree.view.selected, tree.idxOf, tree.nodes]);

  useEffect(() => {
    if (focusedIdx === null) {
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
  }, [focusedIdx, tree.nodes]);

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
        keys: `${mod}L`,
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

  const visibleCommands = useMemo(
    () => (scoped ? commands.filter((c) => c.contextual) : commands),
    [commands, scoped],
  );

  const scope: Scope | null =
    scoped && focusedNode
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
        // ⌘K with a node selected opens a contextual actions menu scoped to it.
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
      } else if (meta && e.key.toLowerCase() === "l") {
        e.preventDefault();
        tree.setAxis(tree.view.axis === "log" ? "linear" : "log");
      } else if (meta && e.key.toLowerCase() === "s") {
        e.preventDefault();
        share();
      } else if (e.key === "Escape") {
        tree.select(null);
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
          const n = idx === null ? null : tree.nodes.get(idx);
          tree.select(n ? n.key : null);
        }}
        isolate={tree.view.isolate}
        axisMode={tree.view.axis}
        intervals={timescale}
        fitSignal={fitSignal}
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

      {detail && focusedNode && (
        <Detail
          detail={detail}
          hue={laneHue(focusedNode.idx)}
          sourceTipCount={
            detail.silhouette
              ? tree.nodes.get(detail.silhouette.source_idx)?.tip_count
              : undefined
          }
        />
      )}

      <Palette
        open={paletteOpen}
        onClose={() => {
          setPaletteOpen(false);
          setScoped(false);
        }}
        commands={visibleCommands}
        scope={scope}
        onPick={addHit}
        present={present}
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

function Detail({
  detail,
  hue,
  sourceTipCount,
}: {
  detail: NodeDetail;
  hue: number;
  sourceTipCount: number | undefined;
}) {
  const age = ageLabel(detail.age_ma, detail.tier);
  // An image borrowed from a kingdom-sized ancestor tells the reader nothing
  // and implies something false. Withhold rather than mislead.
  const sil = silhouetteIsInformative(detail, sourceTipCount)
    ? detail.silhouette
    : null;
  return (
    <aside className="detail" style={{ color: `hsl(${hue} 60% 62%)` }}>
      {sil && (
        <div className="detail-image">
          <Silhouette phylopicId={sil.phylopic_id} size={110} />
          {sil.source_name && sil.source_idx !== detail.idx && (
            // Watermarked onto the image rather than captioned beside it: the
            // claim is about *this picture*, and on the canvas the same fact
            // was wide enough to run across a neighbouring lineage.
            <span className="detail-watermark" title="The nearest clade with an image">
              {sil.source_name}
            </span>
          )}
        </div>
      )}
      <h2
        className={isScientificItalic(detail.rank) ? "sci-italic" : undefined}
        style={{ color: "var(--ink)" }}
      >
        {detail.name ?? "unnamed divergence"}
      </h2>
      {detail.rank && <div className="rank">{detail.rank}</div>}

      <dl>
        <dt>age</dt>
        <dd className="num">{age ?? "not estimated"}</dd>
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

      {detail.tier === TIER_STRUCTURAL && (
        <p className="note">
          No age is shown because none has been estimated for this node. Its
          position on the axis is ordinal — it sits between its nearest dated
          ancestor and descendant, and in this region the horizontal axis means
          nesting depth rather than time.
        </p>
      )}
      {detail.tier === 1 && age && (
        <p className="note">
          This clade is a subset of the one the chronogram dates, so{" "}
          <span className="num">{age}</span> is an upper bound on its true age,
          not an estimate of it.
        </p>
      )}

      {detail.vernaculars.length > 0 && (
        <p className="note">Also known as {detail.vernaculars.slice(0, 6).join(", ")}.</p>
      )}

      {sil && (
        <div className="credit">
          Silhouette{" "}
          {sil.source_name && sil.source_idx !== detail.idx ? (
            <>
              of <em>{sil.source_name}</em>, the nearest clade with an image —{" "}
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
