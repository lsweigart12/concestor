/**
 * Application state. Any view must be a shareable link, so the URL is the
 * store's serialisation and everything visible round-trips through
 * `encode`/`decode`:
 *
 *   /?n=770315,153563,664349&axis=log&sel=770315&iso=1
 *
 * The three canvas modes (bioluminescence, labels, ages) live in
 * `sessionStorage` and never in a link, because they are claims about the reader
 * rather than about taxa. See {@link BIOLUM_KEY}.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { beacon, type Cause } from "../analytics/beacon";
import { api, type FossilTaxon, type PathNode, type Resolved } from "../api";
import {
  addDelta,
  induced,
  type AddDelta,
  type Induced,
} from "../tree/induced";
import {
  buildGrafts,
  fossilSpan,
  graftIdx,
  graftKey,
  graftYoungest,
  parseGraftKey,
  type GraftSet,
} from "../tree/graft";
import type { AxisMode } from "../tree/layout";
import type { LabelMode } from "../tree/naming";
import { releasable } from "./queue";

// Re-exported from the modules that own them (the layout and naming), so there
// is one definition of each union.
export type { AxisMode, LabelMode };

export interface ViewState {
  /** OTT ids or node keys, in selection order (which is *not* render order). */
  keys: string[];
  axis: AxisMode;
  selected: string | null;
  isolate: boolean;
  /**
   * The segment whose drill-down lane is open, as two node indices (what
   * `/v1/segment` takes). `seg=upper-lower` in the URL.
   */
  drill: { upper: number; lower: number } | null;
  /**
   * Fossils drawn against the tree, as PBDB taxon numbers. `f=108454,91487`.
   * Separate from `keys` so a graft induces no subtree and cannot move an MRCA.
   */
  fossils: number[];
}

/**
 * The three canvas modes: the light, the labels and the ages. Not in
 * {@link ViewState}, so not in the URL and not in history — they are claims
 * about the reader, not about taxa. `sessionStorage` (not `localStorage`), so a
 * shared link opens at the defaults in a fresh tab while a reader who chose
 * something keeps it across reloads in their own tab.
 */
const BIOLUM_KEY = "concestor.biolum";
const LABELS_KEY = "concestor.labels";
const AGES_KEY = "concestor.ages";

/** Every value the labels mode may take, so the loader can validate a stored one. */
const LABEL_MODES = ["off", "scientific", "common"] as const;

/**
 * Defaults, for the stranger who arrives having chosen nothing: common names
 * (this product is for curious people, not biologists), ages on (deep time is
 * what the app is for), light off (the plain instrument). Exported because the
 * chips read them to know which way is the default.
 */
const BIOLUM_DEFAULT = false;
export const LABELS_DEFAULT: LabelMode = "common";
export const AGES_DEFAULT = true;

/**
 * Read one stored mode, or the default. Blocked storage (private browsing)
 * throws on access, so this must swallow and fall back.
 */
function readMode<T>(
  key: string,
  parse: (raw: string) => T | null,
  fallback: T,
): T {
  try {
    const raw = sessionStorage.getItem(key);
    return raw === null ? fallback : (parse(raw) ?? fallback);
  } catch {
    return fallback;
  }
}

/** Write one, or clear it where it is back at its default. */
function writeMode(key: string, value: string | null): void {
  try {
    if (value === null) sessionStorage.removeItem(key);
    else sessionStorage.setItem(key, value);
  } catch {
    /* private browsing; the mode still works, it just will not outlive a reload */
  }
}

export function loadBiolum(): boolean {
  // Only an exact "1" is on. Anything else is a value this app did not write,
  // and the benefit of the doubt goes to the plain instrument.
  return readMode(BIOLUM_KEY, (raw) => raw === "1", BIOLUM_DEFAULT);
}

/**
 * Exported for the about page's offer: `/about` unmounts the app, so it writes
 * the `sessionStorage` value and the canvas reads it on the next mount.
 */
export function saveBiolum(on: boolean): void {
  writeMode(BIOLUM_KEY, on ? "1" : null);
}

export function loadLabels(): LabelMode {
  return readMode(
    LABELS_KEY,
    (raw) => LABEL_MODES.find((m) => m === raw) ?? null,
    LABELS_DEFAULT,
  );
}

function saveLabels(mode: LabelMode): void {
  writeMode(LABELS_KEY, mode === LABELS_DEFAULT ? null : mode);
}

export function loadAges(): boolean {
  // Spelled as the negative, because on is the default: only an exact "0"
  // turns them off, so a stored value we did not write leaves them on.
  return readMode(AGES_KEY, (raw) => raw !== "0", AGES_DEFAULT);
}

function saveAges(on: boolean): void {
  writeMode(AGES_KEY, on ? null : "0");
}

/**
 * `axis: "linear"` is the default: linear is the honest one about scale (log
 * flatters recent divergences), and deep time being vast is what the app is
 * for. The switch and one opening still reach symlog.
 */
const DEFAULT: ViewState = {
  keys: [],
  axis: "linear",
  selected: null,
  isolate: false,
  drill: null,
  fossils: [],
};

/**
 * A URL back into a view. Every key is normalised through {@link toUrlKey} on
 * the way in, so `view.keys` has one spelling by construction — `add`, `remove`
 * and `select` all compare against the compact form.
 */
export function decode(search: string): ViewState {
  const p = new URLSearchParams(search);
  const raw = p.get("n");
  const sel = p.get("sel");
  const seg = (p.get("seg") ?? "").split("-").map(Number);
  const fossils = (p.get("f") ?? "")
    .split(",")
    .map(Number)
    .filter((n) => Number.isInteger(n) && n > 0);
  return {
    // Deduplicated after normalising: two spellings of one taxon are two React
    // keys for one mark.
    keys: [...new Set(raw ? raw.split(",").filter(Boolean).map(toUrlKey) : [])],
    axis: p.get("axis") === "log" ? "log" : "linear",
    // Normalised with `keys`, so `remove` can clear it. Empty `sel=` is null.
    selected: sel ? toUrlKey(sel) : null,
    isolate: p.get("iso") === "1",
    drill:
      seg.length === 2 && Number.isInteger(seg[0]) && Number.isInteger(seg[1])
        ? { upper: seg[0]!, lower: seg[1]! }
        : null,
    fossils: [...new Set(fossils)],
  };
}

export function encode(v: ViewState): string {
  const p = new URLSearchParams();
  if (v.keys.length) p.set("n", v.keys.join(","));
  if (v.axis !== "linear") p.set("axis", v.axis);
  if (v.selected) p.set("sel", v.selected);
  if (v.isolate) p.set("iso", "1");
  if (v.drill) p.set("seg", `${v.drill.upper}-${v.drill.lower}`);
  if (v.fossils.length) p.set("f", v.fossils.join(","));
  const q = p.toString();
  return q ? `?${q}` : "/";
}

/** A key the API accepts: bare OTT ids in the URL become `ott…` on the wire. */
export function toApiKey(key: string): string {
  return /^\d+$/.test(key) ? `ott${key}` : key;
}

/** The compact form we put in URLs. */
export function toUrlKey(key: string): string {
  return key.startsWith("ott") && /^\d+$/.test(key.slice(3))
    ? key.slice(3)
    : key;
}

export interface Broken {
  key: string;
  name: string | null;
  mrcaKey: string;
  mrcaIdx: number | null;
  attachmentPoints: number;
}

export function useTree() {
  const [view, setView] = useState<ViewState>(() =>
    decode(window.location.search),
  );
  /**
   * The live view, for the two places that must *test* it without depending on
   * it: the queue's duplicate check and its release. Both run inside a setter
   * or an effect gated on the queue, and a dependency on `view.keys` would
   * re-run the release on the very change it just made.
   */
  const viewRef = useRef(view);
  viewRef.current = view;
  // Not part of `view`, and so not in the URL or in history. See `BIOLUM_KEY`.
  const [biolum, setBiolum] = useState<boolean>(loadBiolum);
  const [labels, setLabelsState] = useState<LabelMode>(loadLabels);
  const [ages, setAgesState] = useState<boolean>(loadAges);
  const [nodes, setNodes] = useState<Map<number, PathNode>>(() => new Map());
  const [paths, setPaths] = useState<Map<string, number[]>>(() => new Map());
  const [idxOf, setIdxOf] = useState<Map<string, number>>(() => new Map());
  const [loading, setLoading] = useState(false);
  const [broken, setBroken] = useState<Broken[]>([]);
  const [unresolved, setUnresolved] = useState<string[]>([]);
  /**
   * Keys the resolver has finished asking about, however it answered.
   *
   * The queue's gate is arrival, and arrival alone would stall it for ever on
   * one stale id — a key that resolves to nothing never appears in `paths`, and
   * a key whose request failed appears nowhere at all. Once we have asked, what
   * is absent is absent, and the step goes through to draw nothing, which is
   * what adding that key directly would have done.
   */
  const [answered, setAnswered] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const [error, setError] = useState<string | null>(null);
  const [delta, setDelta] = useState<(AddDelta & { token: number }) | null>(
    null,
  );
  // Resolved fossils, by PBDB taxon number. Like `nodes`, this only grows: the
  // API is immutable within a build, so removing a graft from the view need
  // not throw away the row it was drawn from.
  const [fossils, setFossils] = useState<Map<number, FossilTaxon>>(
    () => new Map(),
  );
  const [fossilsLoading, setFossilsLoading] = useState(false);
  /**
   * Taxa waiting to be drawn, in order. See `queue.ts`.
   *
   * Every add goes through here: the queue exists so that two taxa can never
   * animate on top of each other, and a reader holding `R` down is the case
   * that makes the difference visible.
   */
  const [queue, setQueue] = useState<readonly string[]>([]);
  /**
   * Whether a draw is on screen. The queue's brake: set when a key is released
   * and cleared when the canvas reports the draw *landed* — not when it is
   * fully settled, because a decay is not something the next beat has to wait
   * for.
   */
  const [drawing, setDrawing] = useState(false);
  const prevInduced = useRef<Induced | null>(null);
  const token = useRef(0);

  // URL is the serialisation. Push on change, honour back/forward. The
  // comparison is against `search || pathname` because `encode` returns "/" for
  // an empty view — comparing them independently misses the clear transition.
  //
  // A view that came *from* the URL replaces rather than pushes: `decode`
  // canonicalises, so a hand-written link's serialisation differs from the URL
  // it arrived in, and pushing that would make the back button a no-op.
  const fromUrl = useRef(true);
  useEffect(() => {
    const url = encode(view);
    if (url !== (window.location.search || window.location.pathname)) {
      if (fromUrl.current) window.history.replaceState(null, "", url);
      else window.history.pushState(null, "", url);
    }
    fromUrl.current = false;
  }, [view]);

  // What put the current selection on screen, for the beacon (analytics §2). A
  // ref, because nothing renders from it. Starts "link" — a cold load is a URL
  // somebody sent.
  const cause = useRef<Cause>("link");
  const priorKeys = useRef<string[]>(view.keys);

  useEffect(() => {
    const onPop = () => {
      cause.current = "back";
      // Canonicalise the entry we landed on rather than stacking on it.
      fromUrl.current = true;
      setView(decode(window.location.search));
    };
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  // The one place the beacon is fed the selection. Every mutator sets `cause`
  // and changes `view.keys`, so nothing changes the canvas without this seeing
  // it; an add that changed nothing is not recorded (the diff is real).
  useEffect(() => {
    if (cause.current === "add") {
      for (const k of view.keys) {
        if (!priorKeys.current.includes(k)) beacon.add(toApiKey(k));
      }
    }
    priorKeys.current = view.keys;
    // `toApiKey` so one convention (the `ott…` form) reaches the dataset.
    beacon.tree(view.keys.map(toApiKey), cause.current);
  }, [view.keys]);

  const ingest = useCallback((key: string, r: Resolved): number | null => {
    if (r.broken) {
      setBroken((b) =>
        b.some((x) => x.key === key)
          ? b
          : [
              ...b,
              {
                key,
                name: r.name,
                mrcaKey: r.mrca_node_key,
                mrcaIdx: r.mrca_idx,
                attachmentPoints: r.n_attachment_points,
              },
            ],
      );
      // Drop it from the selection once reported: a broken taxon never enters
      // `paths`, so a key left in the view is re-fetched and re-announced on
      // every add with nothing ever drawn to select and remove.
      setView((v) => ({ ...v, keys: v.keys.filter((x) => x !== key) }));
      return null;
    }
    // A key that resolved to nothing. `/v1/paths` reports these per-key, so one
    // bad id in a pasted URL costs that lineage and not the whole app — reading
    // `r.path` blindly threw during render and blanked everything.
    if (!Array.isArray(r.path)) {
      setUnresolved((u) => (u.includes(key) ? u : [...u, key]));
      return null;
    }
    setNodes((m) => {
      const next = new Map(m);
      for (const n of r.path) next.set(n.idx, n);
      return next;
    });
    setPaths((m) =>
      new Map(m).set(
        key,
        r.path.map((n) => n.idx),
      ),
    );
    setIdxOf((m) => new Map(m).set(key, r.idx));
    return r.idx;
  }, []);

  // Resolve anything in the view — or waiting to enter it — that we do not
  // already hold. The queue's gate is arrival, so a key nobody had asked to
  // resolve until its turn came would stall the queue for a round trip on
  // every step.
  //
  // Graft keys are filtered out and not merely ignored: `pbdb108454` sent to
  // `/v1/paths` is a lookup for a node that does not exist, and the answer
  // would be recorded in `answered` — which is the queue's escape hatch for a
  // key that resolved to nothing. The fossil would be released as unresolvable
  // one tick before its own fetch landed.
  const wanted = useMemo(
    () =>
      [...new Set([...view.keys, ...queue])].filter(
        (k) => parseGraftKey(k) === null,
      ),
    [view.keys, queue],
  );
  useEffect(() => {
    const missing = wanted.filter((k) => !paths.has(k) && !idxOf.has(k));
    if (missing.length === 0) return;
    let cancelled = false;
    setLoading(true);
    (async () => {
      try {
        const res =
          missing.length === 1
            ? { [missing[0]!]: await api.path(toApiKey(missing[0]!)) }
            : (await api.paths(missing.map(toApiKey))).paths;
        if (cancelled) return;
        for (const k of missing) {
          const r = res[toApiKey(k)] ?? res[k];
          if (r) ingest(k, r);
        }
        setError(null);
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      } finally {
        if (!cancelled) {
          setLoading(false);
          setAnswered((a) => new Set([...a, ...missing]));
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [wanted, paths, idxOf, ingest]);

  /**
   * Fossils in the view, or waiting to enter it, whose PBDB rows we want.
   *
   * The queue half is there for the same reason the path fetch reaches into the
   * queue: arrival is the gate, so a fossil nobody had asked to resolve until
   * its turn came would stall the queue for a round trip.
   */
  const wantedFossils = useMemo(() => {
    const out = new Set(view.fossils);
    for (const key of queue) {
      const no = parseGraftKey(key);
      if (no !== null) out.add(no);
    }
    return [...out];
  }, [view.fossils, queue]);

  // Resolve any fossil in the view we do not already hold. Separate from the
  // path fetch: a fossil has no path, and a failure must cost that fossil rather
  // than the tree it annotates.
  useEffect(() => {
    const missing = wantedFossils.filter((n) => !fossils.has(n));
    // Cleared here too: a cancelled run never reaches its own reset.
    if (missing.length === 0) {
      setFossilsLoading(false);
      return;
    }
    let cancelled = false;
    // Its own flag, not a second writer of `loading` (which means the tree is
    // resolving, and gates the graft-refusal announcer).
    setFossilsLoading(true);
    (async () => {
      const got = await Promise.all(
        missing.map((n) => api.fossil(n).catch(() => null)),
      );
      if (cancelled) return;
      setFossilsLoading(false);
      const found = new Map<number, FossilTaxon>();
      const lost: number[] = [];
      missing.forEach((n, i) => {
        const f = got[i];
        if (f) found.set(n, f);
        else lost.push(n);
      });
      if (found.size) setFossils((m) => new Map([...m, ...found]));
      // Dropped rather than retried forever, like a broken taxon — and dropped
      // from the *queue* as well as the view, because arrival is the queue's
      // gate and a fossil that will never arrive would hold the head for good.
      // `answered` does this job for a path; a fossil is refused outright, so
      // there is nothing to release to.
      if (lost.length) {
        setQueue((q) => {
          const next = q.filter((x) => {
            const no = parseGraftKey(x);
            return no === null || !lost.includes(no);
          });
          return next.length === q.length ? q : next;
        });
        setView((v) => ({
          ...v,
          fossils: v.fossils.filter((n) => !lost.includes(n)),
        }));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [wantedFossils, fossils]);

  const selectionIdx = useMemo(
    () =>
      view.keys
        .map((k) => idxOf.get(k))
        .filter((v): v is number => v !== undefined),
    [view.keys, idxOf],
  );

  const ind = useMemo(() => {
    const byIdx = new Map<number, number[]>();
    for (const [k, p] of paths) {
      const i = idxOf.get(k);
      if (i !== undefined) byIdx.set(i, p);
    }
    return induced(selectionIdx, (i) => byIdx.get(i));
  }, [selectionIdx, paths, idxOf]);

  /**
   * Every fossil in the view that can be placed, and every one that cannot.
   *
   * Rebuilt from the induced subtree rather than stored, because *where* a
   * fossil hangs is a fact about the current selection and not about the
   * fossil: adding a species can promote a suppressed node to a rendered one
   * and move the branch a graft belongs to. Deriving it means the picture
   * cannot go stale, which is the same reason `Graph` re-checks the open drill
   * lane against the segments instead of trusting the URL.
   *
   * This is the *whole* answer, including grafts the canvas has not drawn yet.
   * {@link graftSet} is the drawn half. The refusals come off this one, because
   * a reader who asked for a fossil is owed the reason it did not appear at the
   * moment it did not appear, not one animation later.
   */
  const placeable: GraftSet = useMemo(
    () =>
      buildGrafts(
        view.fossils
          .map((n) => fossils.get(n))
          .filter((f): f is FossilTaxon => f !== undefined),
        ind,
        nodes,
      ),
    [view.fossils, fossils, ind, nodes],
  );

  /**
   * Whether a draw is on the canvas — including one requested this very pass.
   *
   * A ref and not `delta !== null`, and that is the whole of what it buys.
   * `setDelta` does not change `delta` until the next render, so two effects in
   * one commit both see the old value: the selection's delta below is set, and
   * the fossil promotion right after it reads `delta === null` and seats a
   * graft into a tree that is about to start drawing. That is a cold load
   * holding `n=` and `f=` — the ordinary case, not a corner.
   */
  const deltaPending = useRef(false);

  // Compute the animation delta whenever the rendered set grows, from paths
  // already in memory (architecture §2).
  const lastCount = useRef(0);
  useEffect(() => {
    const grew = selectionIdx.length > lastCount.current;
    lastCount.current = selectionIdx.length;
    if (grew && ind.rendered.length) {
      const added = selectionIdx[selectionIdx.length - 1];
      const newest = ind.leaves.find(
        (l) => !prevInduced.current?.leaves.includes(l),
      );
      const target = newest ?? added;
      if (target !== undefined) {
        setDelta({
          ...addDelta(prevInduced.current, ind, target),
          token: ++token.current,
        });
        deltaPending.current = true;
      } else {
        // Nothing to animate, so nothing will report a landing. Release the
        // queue here or a key that drew no lineage stalls it for good.
        setDrawing(false);
      }
    }
    prevInduced.current = ind;
  }, [ind, selectionIdx]);

  /**
   * The fossils the canvas has actually drawn.
   *
   * **`view.fossils` is what the reader asked for; this is what is on screen**,
   * and they are not the same thing for the same reason `view.keys` and `ind`
   * are not: a request has to be fetched, and then it has to be *animated on*,
   * and the second of those takes as long as the animation does.
   *
   * A fossil is promoted here only when the canvas is idle, so a graft never
   * appears mid-draw and gets announced a beat later. This cannot be a gate on
   * the queue instead: a cold load holding `f=` never passes the queue at all —
   * the URL seats the fossil directly — and that is precisely the case where
   * the fossil lands on a tree still drawing itself on (#138).
   *
   * **Only placeable fossils are promoted.** `off-tree` is not a permanent
   * answer: adding the clade a fossil hangs below rescues it, and a fossil
   * promoted while refused would be recorded as decided and then appear in
   * silence when the tree changed under it.
   *
   * Declared *after* the selection's delta so it can see `deltaPending` set in
   * the same commit.
   */
  const [shownFossils, setShownFossils] = useState<readonly number[]>([]);
  useEffect(() => {
    setShownFossils((shown) => {
      // Removal is immediate and waits for nothing: taking a fossil off the
      // canvas is not an arrival.
      const kept = shown.filter((n) => view.fossils.includes(n));
      const same = kept.length === shown.length ? shown : kept;
      if (deltaPending.current) return same;
      const ready = placeable.grafts
        .map((g) => -g.idx)
        .filter((n) => view.fossils.includes(n) && !kept.includes(n));
      return ready.length ? [...kept, ...ready] : same;
    });
  }, [view.fossils, placeable, delta]);

  /** The drawn half of {@link placeable}: what is on the canvas right now. */
  const graftSet: GraftSet = useMemo(
    () => ({
      grafts: placeable.grafts.filter((g) => shownFossils.includes(-g.idx)),
      refused: placeable.refused,
    }),
    [placeable, shownFossils],
  );

  /**
   * The same event as the selection's delta, for a fossil: a graft that has
   * reached the canvas is animated on rather than appearing.
   *
   * A graft is one connector and therefore exactly one wave. It is built here
   * rather than by `addDelta`, which walks `after.segments` — and a graft is
   * deliberately not in `Induced`, so there is nothing there to walk.
   *
   * The second half settles the queue's debt. A fossil released by the queue
   * set the brake, and a refusal means nothing will ever report a landing —
   * exactly the case the selection effect handles for a key that drew no
   * lineage. The two are tracked apart because a refusal is not final: a fossil
   * whose brake was released as `off-tree` must still be *announced* if adding
   * a clade later rescues it.
   */
  const announced = useRef<ReadonlySet<number>>(new Set());
  const settled = useRef<ReadonlySet<number>>(new Set());
  useEffect(() => {
    const asked = new Set(view.fossils);
    const shown = new Set(shownFossils);
    // Intersections, not unions: these state what the canvas has now, never
    // what it has ever had, so a fossil removed and added back is drawn again
    // rather than reappearing in silence.
    const known = new Set([...announced.current].filter((n) => shown.has(n)));
    settled.current = new Set([...settled.current].filter((n) => asked.has(n)));

    const fresh = shownFossils.filter((n) => !known.has(n));
    if (fresh.length) {
      if (deltaPending.current) return;
      announced.current = shown;
      settled.current = new Set([...settled.current, ...fresh]);
      const wave = fresh.map(graftIdx);
      const first = placeable.grafts.find((g) => g.idx === wave[0]);
      setDelta({
        // The branch the fossil hangs from: where the connector leaves, and a
        // node that was on screen before the press. Exactly what `addDelta`
        // calls the join.
        flare: first?.anchor ?? wave[0]!,
        leaf: wave[0]!,
        // Several promoted together share the wave, which is what one press
        // would have given them anyway.
        drawOrder: [wave],
        reflowing: ind.rendered,
        token: ++token.current,
      });
      deltaPending.current = true;
      return;
    }
    announced.current = known;

    const refused = placeable.refused
      .map((r) => r.fossil.pbdb_taxon_no ?? 0)
      .filter((n) => n > 0 && !settled.current.has(n));
    if (refused.length) {
      settled.current = new Set([...settled.current, ...refused]);
      setDrawing(false);
    }
  }, [view.fossils, shownFossils, placeable, ind]);

  /**
   * Enqueue taxa for drawing. They enter the view one at a time, as the canvas
   * finishes with each — see `queue.ts`.
   *
   * The duplicate check has to look at both halves: a key already on the canvas
   * and a key already waiting are both "asked for", and letting either through
   * spends a whole beat of the queue on a step that draws nothing.
   */
  const enqueue = useCallback((keys: readonly string[]) => {
    setQueue((q) => {
      // Both halves of the view, because both halves can be queued into: a
      // fossil already drawn is as much "asked for" as a species already on
      // the canvas, and letting one through spends a beat drawing nothing.
      const held = new Set([
        ...q,
        ...viewRef.current.keys,
        ...viewRef.current.fossils.map(graftKey),
      ]);
      const fresh: string[] = [];
      for (const key of keys.map(toUrlKey)) {
        if (held.has(key)) continue;
        held.add(key);
        fresh.push(key);
      }
      return fresh.length ? [...q, ...fresh] : q;
    });
  }, []);

  const add = useCallback((key: string) => enqueue([key]), [enqueue]);

  const remove = useCallback((key: string) => {
    const k = toUrlKey(key);
    cause.current = "remove";
    setView((v) => ({
      ...v,
      keys: v.keys.filter((x) => x !== k),
      selected: v.selected === k ? null : v.selected,
    }));
  }, []);

  /**
   * Open on a selection — the whole of an opening, in one press. Replaces
   * rather than appends and resets the rest of the view (`isolate`, `drill`),
   * because an opening is only true of its own set of taxa. The tree then draws
   * itself on exactly as a cold load does, which is the drawing this app is
   * for.
   */
  const open = useCallback((keys: readonly string[], axis?: AxisMode) => {
    // Reset the animation baseline: `addDelta` splits the new tree into waves
    // relative to the previous one, and an opening shares no leaf with what it
    // replaces — leaving these set would strand nodes in waves whose turn never
    // comes, so their traces never draw. Nulling puts this on the cold-load path.
    prevInduced.current = null;
    lastCount.current = 0;
    // An opening's taxa are never recorded as adds — they are canned comparisons.
    cause.current = "open";
    // `DEFAULT` holds only claims about taxa; the light is untouched.
    setView(() => ({
      ...DEFAULT,
      keys: [...new Set(keys.map(toUrlKey))],
      ...(axis ? { axis } : {}),
    }));
  }, []);

  /**
   * The driver. `queue.ts` decides; this holds the arrival test and the
   * release. **No timer and no clock** — the wake-ups are `paths` and `fossils`
   * changing (a lineage or a PBDB row arrived) and `drawing` clearing (the
   * canvas finished), which is the whole point of the queue: the pace is the
   * animation's, wherever its constants happen to be.
   */
  useEffect(() => {
    const head = releasable(queue, drawing, (k) => {
      // A fossil arrives when its PBDB row does. There is no `answered` half:
      // a row that cannot be fetched is dropped from the queue outright by the
      // resolve effect above, so nothing here has to let a dead one through.
      const no = parseGraftKey(k);
      if (no !== null) return fossils.has(no);
      return paths.has(k) || answered.has(k);
    });
    if (head === null) return;
    setQueue((q) => (q[0] === head ? q.slice(1) : q));
    const no = parseGraftKey(head);
    // Already drawn, so there is nothing to wait for and the brake stays off.
    const already =
      no !== null
        ? viewRef.current.fossils.includes(no)
        : viewRef.current.keys.includes(head);
    if (already) return;
    cause.current = "add";
    setDrawing(true);
    // The two halves of the view are not interchangeable: a graft induces no
    // subtree and may not move an MRCA, which is the whole reason `f=` is a
    // list of its own. See {@link ViewState.fossils}.
    setView((v) =>
      no !== null
        ? v.fossils.includes(no)
          ? v
          : { ...v, fossils: [...v.fossils, no] }
        : v.keys.includes(head)
          ? v
          : { ...v, keys: [...v.keys, head] },
    );
  }, [queue, drawing, paths, answered, fossils]);

  /** The canvas has finished drawing what it was handed. Release the next. */
  const deltaLanded = useCallback(() => setDrawing(false), []);

  /**
   * The age the axis is held out to while the queue drains, or null: the oldest
   * `age_layout` in the subtree the *finished* set induces, so the axis is
   * pinned to its final extent rather than tweening under each arrival. Reads
   * the queue as well as the canvas, since what is coming is what it has to
   * make room for. See `tree/layout.ts`.
   *
   * **Fossils count.** `layout.ts` already puts a graft into the extent — a
   * fossil older than every node on the canvas is exactly the case that widens
   * the axis — so a queued one has to be held out to as well, or the axis
   * settles on the tree and then jumps when the fossil lands. Only the resolved
   * ones: an unresolved fossil has no date to make room for, which is the same
   * position an unresolved path is in two lines above.
   */
  const holdMaxAge = useMemo(() => {
    if (!queue.length) return null;
    const byIdx = new Map<number, number[]>();
    const sel: number[] = [];
    for (const k of [...view.keys, ...queue]) {
      const u = toUrlKey(k);
      const i = idxOf.get(u);
      const p = paths.get(u);
      if (i === undefined || p === undefined) continue;
      sel.push(i);
      byIdx.set(i, p);
    }
    if (sel.length < 2) return null;
    let oldest = 1;
    for (const i of induced(sel, (v) => byIdx.get(v)).rendered) {
      oldest = Math.max(oldest, nodes.get(i)?.age_layout ?? 0);
    }
    for (const n of [...view.fossils, ...queue.map(parseGraftKey)]) {
      const f = n === null ? undefined : fossils.get(n);
      const span = f && fossilSpan(f);
      if (f && span) oldest = Math.max(oldest, graftYoungest(f, span));
    }
    return oldest;
  }, [queue, view.keys, view.fossils, idxOf, paths, nodes, fossils]);

  /**
   * Draw a fossil against the tree. Additive but not a selection: `keys` is
   * untouched, so no MRCA moves.
   *
   * Through the queue, exactly like a species. It used to write straight to the
   * view, and that is what made a fossil a second-class arrival: it landed
   * whenever its fetch landed, which on a busy canvas meant *during* another
   * taxon's draw. It reflowed a tree that was midway through drawing itself on
   * — the tree that was drawing had no idea, and the fossil got no entrance of
   * its own out of it either.
   */
  const addFossil = useCallback(
    (taxonNo: number) => enqueue([graftKey(taxonNo)]),
    [enqueue],
  );

  const removeFossil = useCallback((taxonNo: number) => {
    setView((v) => ({ ...v, fossils: v.fossils.filter((n) => n !== taxonNo) }));
  }, []);

  // Clears taxa but not the lighting, like `open`.
  const clear = useCallback(() => {
    // A draining queue would otherwise redraw onto the emptied canvas, one
    // taxon at a time.
    setQueue([]);
    setDrawing(false);
    cause.current = "clear";
    setView(DEFAULT);
  }, []);
  const setAxis = useCallback(
    (axis: AxisMode) => setView((v) => ({ ...v, axis })),
    [],
  );
  // Written through on the setter, not in an effect, so a render cannot
  // overwrite a choice.
  const setLabels = useCallback((mode: LabelMode) => {
    saveLabels(mode);
    setLabelsState(mode);
  }, []);
  const setAges = useCallback((on: boolean) => {
    saveAges(on);
    setAgesState(on);
  }, []);
  const toggleBiolum = useCallback(
    () =>
      setBiolum((on) => {
        saveBiolum(!on);
        return !on;
      }),
    [],
  );
  const select = useCallback(
    (key: string | null) =>
      setView((v) => ({ ...v, selected: key && toUrlKey(key) })),
    [],
  );
  const toggleIsolate = useCallback(
    () => setView((v) => ({ ...v, isolate: !v.isolate })),
    [],
  );
  const setDrill = useCallback(
    (drill: ViewState["drill"]) => setView((v) => ({ ...v, drill })),
    [],
  );
  const dismissBroken = useCallback(
    (key: string) => setBroken((b) => b.filter((x) => x.key !== key)),
    [],
  );
  const dismissUnresolved = useCallback(
    (key: string) => setUnresolved((u) => u.filter((x) => x !== key)),
    [],
  );
  // The canvas has finished with the delta entirely — flare, draw and settle.
  // `deltaPending` clears with it, which is what lets a fossil held back by it
  // through on the very next pass.
  const consumeDelta = useCallback(() => {
    deltaPending.current = false;
    setDelta(null);
  }, []);

  return {
    view,
    // The three canvas modes: session state, not view state. See `BIOLUM_KEY`.
    biolum,
    labels,
    ages,
    nodes,
    /** Resolved fossil rows, by PBDB taxon number. `view.fossils` is the order. */
    fossils,
    induced: ind,
    /** The fossils drawn against the tree, and the ones that could not be. */
    graftSet,
    selectionIdx,
    idxOf,
    delta,
    loading,
    /** Grafts in the view whose PBDB rows have not arrived. Never `loading`. */
    fossilsLoading,
    broken,
    unresolved,
    error,
    /** The age the axis is held at while the queue drains. See `tree/layout.ts`. */
    holdMaxAge,
    add,
    open,
    remove,
    clear,
    setAxis,
    setLabels,
    setAges,
    select,
    toggleIsolate,
    toggleBiolum,
    setDrill,
    addFossil,
    removeFossil,
    dismissBroken,
    dismissUnresolved,
    consumeDelta,
    deltaLanded,
  };
}

/** What a component holds when it holds the tree. Inferred, not declared. */
export type Tree = ReturnType<typeof useTree>;
