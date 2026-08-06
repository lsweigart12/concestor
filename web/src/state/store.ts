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
import type { AxisMode } from "../tree/layout";
import type { LabelMode } from "../tree/naming";
import { plan, remaining, step, type Sequence } from "./sequence";

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
  /** An opening being drawn one taxon at a time, or null. See `sequence.ts`. */
  const [sequence, setSequence] = useState<Sequence | null>(null);
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

  // Resolve anything in the view we do not already hold.
  useEffect(() => {
    const missing = view.keys.filter((k) => !paths.has(k) && !idxOf.has(k));
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
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [view.keys, paths, idxOf, ingest]);

  // Resolve any fossil in the view we do not already hold. Separate from the
  // path fetch: a fossil has no path, and a failure must cost that fossil rather
  // than the tree it annotates.
  useEffect(() => {
    const missing = view.fossils.filter((n) => !fossils.has(n));
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
      // Dropped rather than retried forever, like a broken taxon.
      if (lost.length) {
        setView((v) => ({
          ...v,
          fossils: v.fossils.filter((n) => !lost.includes(n)),
        }));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [view.fossils, fossils]);

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
      }
    }
    prevInduced.current = ind;
  }, [ind, selectionIdx]);

  const add = useCallback((key: string) => {
    const k = toUrlKey(key);
    cause.current = "add";
    setView((v) => (v.keys.includes(k) ? v : { ...v, keys: [...v.keys, k] }));
  }, []);

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
   * Open on a selection — an opening's first frame. Replaces rather than
   * appends and resets the rest of the view (`isolate`, `drill`), because an
   * opening is only true of its own set of taxa. {@link openSequenced} then
   * steps the rest in through `add`.
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
   * Resolve keys without drawing them — a sequence's whole network cost, paid
   * once on the press, so every step after the first is a pure state change.
   */
  const prefetch = useCallback(
    async (keys: readonly string[]): Promise<void> => {
      if (keys.length === 0) return;
      const res = (await api.paths(keys.map(toApiKey))).paths;
      for (const k of keys) {
        const r = res[toApiKey(k)] ?? res[k];
        if (r) ingest(toUrlKey(k), r);
      }
    },
    [ingest],
  );

  /**
   * One step of a sequence. Not `add`: a sequenced taxon is one of ours and
   * emits no `add` event. See {@link Cause}.
   */
  const drawStep = useCallback((key: string) => {
    const k = toUrlKey(key);
    cause.current = "sequence";
    setView((v) => (v.keys.includes(k) ? v : { ...v, keys: [...v.keys, k] }));
  }, []);

  /**
   * Draw an opening, one taxon at a time (see `sequence.ts`). Returns whether a
   * sequence started; false with reduced motion or an opening too short to
   * order, when this is a single `open()`. Never called on boot.
   */
  const openSequenced = useCallback(
    (
      keys: readonly string[],
      axis: AxisMode | undefined,
      reduced: boolean,
    ): boolean => {
      const p = plan(keys, reduced);
      open(p.first, axis);
      if (p.rest.length === 0) return false;
      setSequence({
        keys: [...keys],
        drawn: p.first.length,
        since: Date.now(),
        settled: false,
      });
      // `finally`, not `then`: a failed batch still settles the sequence, or a
      // dead API leaves the canvas mid-animation forever.
      void prefetch(p.rest)
        .catch(() => {})
        .finally(() => setSequence((s) => (s ? { ...s, settled: true } : s)));
      return true;
    },
    [open, prefetch],
  );

  /**
   * End a sequence at the finished tree, now — adding the remaining keys rather
   * than stopping, since the reader interrupted the telling, not the argument.
   * Idempotent, because every interaction is wired to it.
   */
  const cutSequence = useCallback(() => {
    if (!sequence) return;
    const rest = remaining(sequence).map(toUrlKey);
    setSequence(null);
    if (rest.length === 0) return;
    cause.current = "sequence-cut";
    setView((v) => ({
      ...v,
      keys: [...v.keys, ...rest.filter((k) => !v.keys.includes(k))],
    }));
  }, [sequence]);

  /**
   * The driver. `sequence.ts` makes the decisions; this holds the clock, the
   * arrival test and the timer. Two wake-ups, no polling: `paths` changing is
   * the arrival, and a timer is armed only when waiting on the floor.
   */
  useEffect(() => {
    if (!sequence) return;
    const now = Date.now();
    const next = step(sequence, now, (k) => paths.has(toUrlKey(k)));
    if (next.kind === "done") {
      setSequence(null);
      return;
    }
    // Keyed on which taxon landed, not a count, so applying twice is applying
    // once — `StrictMode` double-invokes the effect and two `drawn + 1` updates
    // would step past a taxon never drawn.
    const land = (key: string, at: number) => {
      drawStep(key);
      setSequence((s) =>
        s && s.keys[s.drawn] === key
          ? { ...s, drawn: s.drawn + 1, since: at }
          : s,
      );
    };
    if (next.kind === "draw") {
      land(next.key, now);
      return;
    }
    if (next.after === null) return;
    // Draws directly when it fires: arrival is monotone, so the only condition
    // left is the one the timer was armed for.
    const t = window.setTimeout(() => land(next.key, Date.now()), next.after);
    return () => window.clearTimeout(t);
  }, [sequence, paths, drawStep]);

  /**
   * The age the axis is held out to while a sequence runs, or null: the oldest
   * `age_layout` in the whole opening's induced subtree, so the axis is pinned
   * to its final extent rather than tweening. See `tree/layout.ts`.
   */
  const holdMaxAge = useMemo(() => {
    if (!sequence?.settled) return null;
    const byIdx = new Map<number, number[]>();
    const sel: number[] = [];
    for (const k of sequence.keys) {
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
    return oldest;
  }, [sequence, idxOf, paths, nodes]);

  /**
   * Draw a fossil against the tree. Additive but not a selection: `keys` is
   * untouched, so no MRCA moves.
   */
  const addFossil = useCallback((taxonNo: number) => {
    setView((v) =>
      v.fossils.includes(taxonNo)
        ? v
        : { ...v, fossils: [...v.fossils, taxonNo] },
    );
  }, []);

  const removeFossil = useCallback((taxonNo: number) => {
    setView((v) => ({ ...v, fossils: v.fossils.filter((n) => n !== taxonNo) }));
  }, []);

  // Clears taxa but not the lighting, like `open`.
  const clear = useCallback(() => {
    // A running sequence would otherwise redraw the opening onto the emptied
    // canvas one taxon at a time.
    setSequence(null);
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
  const consumeDelta = useCallback(() => setDelta(null), []);

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
    selectionIdx,
    idxOf,
    delta,
    loading,
    /** Grafts in the view whose PBDB rows have not arrived. Never `loading`. */
    fossilsLoading,
    broken,
    unresolved,
    error,
    /** An opening is drawing itself one taxon at a time. */
    sequencing: sequence !== null,
    /** The age the axis is held at while it does. See `tree/layout.ts`. */
    holdMaxAge,
    add,
    open,
    openSequenced,
    cutSequence,
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
  };
}

/** What a component holds when it holds the tree. Inferred, not declared. */
export type Tree = ReturnType<typeof useTree>;
