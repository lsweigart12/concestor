/**
 * The command surface. `S` opens the same list filtered to species. Row anatomy
 * follows Raycast: icon · title · subtitle · accessory, with a keybind hint.
 *
 * **A command row is one line.** The subtitle is a taxon's, and only a taxon's:
 * a hit row has facts the title cannot hold — the vernacular that explains why
 * "dog" matched, the rank, the size of the subtree — while an action's second
 * line only ever restated its verb. Every command title says what the press
 * does, so a list of them scans as a list rather than as prose.
 *
 * Broken taxa are explained rather than silently answered about with a
 * substituted MRCA — see {@link BrokenNote}.
 */

import type { ReactNode } from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { beacon } from "../analytics/beacon";
import {
  api,
  hitSilhouette,
  type AnyHit,
  type BrokenHit,
  type FossilTaxon,
  type SearchHit,
} from "../api";
import { FOSSIL_BADGE, rowScore, SPECIES_PHRASE } from "../corpora";
import { AgeGlyph } from "../canvas/AgeGlyph";
import { endedSpanLabel } from "../canvas/Bracket";
import { Silhouette } from "../canvas/Silhouette";
import { PendingLine, usePending } from "../chrome/Pending";
import { fuzzy, highlight, litRanges, recordUse, sessionBoost } from "./fuzzy";

export interface Command {
  id: string;
  title: string;
  /**
   * A glyph or a drawn icon, whichever says the thing more plainly.
   *
   * A node rather than a string because the character sets disagree about what
   * they are for: `⌛` carries `Emoji_Presentation`, so a browser renders it in
   * colour, at emoji weight, beside twelve monochrome hairline glyphs. Where
   * Unicode has no honest text-presentation character the icon is drawn — see
   * `DatesGlyph` in `App.tsx`, which matches the chrome's own glyphs.
   */
  icon: ReactNode;
  keys?: string;
  section: string;
  run: () => void;
}

/** The palette answering about taxa only, with the commands put away (`S`). */
export type PaletteFilter = "species";

/** What a reader types to enter a filter, and what the chip then says. */
const FILTER_PREFIX: Record<PaletteFilter, string> = { species: "s" };
const FILTER_LABEL: Record<PaletteFilter, string> = { species: "Species" };

/**
 * A clade the list is fenced to — the drill-down's chip. Held as a stack in
 * `App` beside `filter`: Tab on a group pushes one, backspace at position zero
 * pops the innermost, so the chips read as the path taken in and backspace
 * walks back out of it. Only the innermost fences the search (each scope is
 * inside the one before it), but the outer ones are kept because they are
 * where backspace goes.
 */
export interface CladeScope {
  key: string;
  name: string;
  rank: string | null;
}

/** Rows a reader can step into: groups, not species. The Tab affordance. */
function drillable(hit: SearchHit): boolean {
  return hit.tip_count > 1;
}

interface Props {
  open: boolean;
  onClose: () => void;
  commands: Command[];
  /** Set when the list is restricted to one corpus. */
  filter: PaletteFilter | null;
  onFilter: (f: PaletteFilter | null) => void;
  /** The drill-down path, outermost first. Owned by `App`, like `filter`. */
  scopes: CladeScope[];
  onScopes: (scopes: CladeScope[]) => void;
  onPick: (hit: SearchHit) => void;
  /** A fossil row was chosen: draw it against the tree. */
  onPickFossil: (f: FossilTaxon) => void;
  /** Names already on the canvas, so the palette can say "already added". */
  present: Set<number>;
  /** PBDB taxon numbers already drawn, for the same reason. */
  presentFossils: Set<number>;
  /**
   * What to offer before anything is typed, or null while the prefetch is out.
   * Owned by `App` and requested on boot, so it is a settled memo before `S`.
   */
  suggestions: Suggestions | null;
}

type Row =
  | { kind: "cmd"; cmd: Command; score: number; ranges: [number, number][] }
  | {
      kind: "hit";
      hit: SearchHit;
      score: number;
      /** Highlight on the scientific name… */
      ranges: [number, number][];
      /** …or on the vernacular, when that is what actually matched. */
      vernRanges: [number, number][];
    }
  | {
      kind: "fossil";
      fossil: FossilTaxon;
      score: number;
      ranges: [number, number][];
    };

/** A titled run of rows. Raycast's model, and the one `Command.section` implies. */
interface Section {
  title: string;
  rows: Row[];
}

/**
 * The one section both corpora go in.
 *
 * Nodes and fossils are merged into one list in the server's `order`; what was a
 * "Fossils" section is now a badge on the row (see {@link FossilRow}). `web/`
 * sorts on `order` and computes nothing.
 */
const SPECIES_SECTION = "Species";

/**
 * Credits, provenance and the ranking reset, pinned dead last: otherwise
 * `sessionBoost` lets it climb above Species once the about panel is opened.
 * Still findable — type "about" and it is the only section left.
 */
export const ABOUT_SECTION = "About";

/** The two bands of an empty species list: recents first, then starters. */
const RECENT_SECTION = "Recent";
const STARTERS_SECTION = "Start here";

/**
 * Sections pinned head and tail, everything else floating on its best row's
 * score. The suggestion bands must be pinned because every row in them ties
 * (no query), so left to float they would order arbitrarily.
 */
const HEAD_SECTIONS: readonly string[] = [RECENT_SECTION, STARTERS_SECTION];
const TAIL_SECTIONS: readonly string[] = [ABOUT_SECTION];

/** Where a section sits: negative pins to the head, positive to the tail, zero floats. */
const sectionRank = (title: string): number => {
  const h = HEAD_SECTIONS.indexOf(title);
  if (h >= 0) return h - HEAD_SECTIONS.length;
  const t = TAIL_SECTIONS.indexOf(title);
  return t < 0 ? 0 : t + 1;
};

const DEBOUNCE_MS = 110;

/**
 * What the list says when it has no rows. A pure function, and "nothing matched"
 * is reachable only from a settled search — otherwise it flashes "Nothing
 * matched dog" during the round trip, before anything was asked. Four states:
 *
 * - `prompt` — nothing typed yet, or one character.
 * - `silent` — a search is out but too young for an indicator; render nothing.
 * - `searching` — the search is genuinely slow; say what is being searched.
 * - `no-match` — the search came back empty. The only state entitled to say so.
 */
type EmptyState = "prompt" | "silent" | "searching" | "no-match";

/** Below this the palette does not search at all, and must not report on one. */
export const MIN_QUERY = 2;

export function emptyState(s: {
  /** Already trimmed — the caller trims once and everything below reads it. */
  query: string;
  /** A request is out, or a debounce is about to send one. */
  searching: boolean;
  /** That request has outlived {@link PENDING_DELAY_MS}. */
  slow: boolean;
}): EmptyState {
  if (s.query.length < MIN_QUERY) return "prompt";
  if (!s.searching) return "no-match";
  return s.slow ? "searching" : "silent";
}

/** What the palette holds before anything is typed. See {@link suggestionBands}. */
export interface Suggestions {
  /** This browser's own picks, newest first. Empty on a first visit. */
  recent: SearchHit[];
  /** The curated list, dressed by `/v1/hits`. Empty until the prefetch lands. */
  starters: SearchHit[];
}

/**
 * The titled bands an empty species list shows, or none. Four refusals: only
 * under the species filter (the root palette's command list is its own empty
 * state), never inside a drill-down (a scoped empty list shows the clade's own
 * children instead — recents from the whole tree would mostly be outside the
 * fence), only below {@link MIN_QUERY} (once a search can run it owns the
 * list), and never both bands holding the same taxon (recents win, keeping the
 * curated order intact in the survivor).
 */
export function suggestionBands(s: {
  filter: PaletteFilter | null;
  /** True inside a drill-down, whose empty state is the children list. */
  scoped?: boolean;
  /** Already trimmed. */
  query: string;
  suggestions: Suggestions | null;
}): [string, SearchHit[]][] {
  if (s.filter !== "species" || s.scoped || !s.suggestions) return [];
  if (s.query.length >= MIN_QUERY) return [];
  const { recent, starters } = s.suggestions;
  const taken = new Set(recent.map((h) => h.key));
  const bands: [string, SearchHit[]][] = [];
  if (recent.length > 0) bands.push([RECENT_SECTION, recent]);
  const fresh = starters.filter((h) => !taken.has(h.key));
  if (fresh.length > 0) bands.push([STARTERS_SECTION, fresh]);
  return bands;
}

/**
 * The name that got this row onto the page when the row shows it nowhere else.
 *
 * Two kinds qualify. A `vernacular` match can also hide the typed word, but
 * crediting it re-asserts an `elsewhere` claim phase 6b measured as false. A
 * `name` match is the string the row prints; an `abbreviation` is lit
 * word-by-word by {@link litRanges} and repeats identically down every row.
 * These two are where the word is absent *and* crediting it tells one row from
 * the next.
 *
 * `who` is why they are not one case. A synonym is the taxonomy's own filing;
 * a `fossil-name` is what the Paleobiology Database calls the same taxon, which
 * is a claim about a second catalogue and not about the tree. Saying "the
 * taxonomy files it under this name" of a PBDB spelling would be false — and
 * these are exactly the rows where the reader typed a name the tree does not
 * print, so the caption is the only thing that explains the row.
 */
function matchedVia(
  h: SearchHit,
): { name: string; who: "taxonomy" | "fossils" } | null {
  const who =
    h.matched_on === "synonym"
      ? "taxonomy"
      : h.matched_on === "fossil-name"
        ? "fossils"
        : null;
  if (who === null || !h.matched_name) return null;
  return { name: h.matched_name, who };
}

/** Whether PBDB gives this taxon anywhere to stand on a time axis. */
function hasInterval(f: FossilTaxon): boolean {
  return [f.fea, f.fla, f.lea, f.lla].some(
    (v) => typeof v === "number" && Number.isFinite(v),
  );
}

export function Palette({
  open,
  onClose,
  commands,
  filter,
  onFilter,
  scopes,
  onScopes,
  onPick,
  onPickFossil,
  present,
  presentFossils,
  suggestions,
}: Props) {
  const [q, setQ] = useState("");
  const [hits, setHits] = useState<AnyHit[]>([]);
  const [fossils, setFossils] = useState<FossilTaxon[]>([]);
  /** The innermost chip — the one that fences the list. Null outside a drill. */
  const scope = scopes.length > 0 ? scopes[scopes.length - 1] : null;
  /**
   * The scoped empty state: the clade's own children, so entering a group
   * never lands on a blank list. Null while the fetch is out (render nothing —
   * the response is memoised, so the gap is one round trip per clade per tab).
   */
  const [children, setChildren] = useState<SearchHit[] | null>(null);
  const [childTotal, setChildTotal] = useState(0);
  /**
   * The spelling the rows below are actually for, when it is not what was typed.
   *
   * Held in state beside the rows rather than derived, because it is a property
   * of *this* answer: leaving it up while the next query is in flight would
   * caption one search's rows with another search's correction.
   */
  const [corrected, setCorrected] = useState<string | null>(null);
  /**
   * A better spelling than the typed one, with the typed one's rows still here.
   *
   * The other half of `corrected` and never live at the same time — the server
   * substitutes only where there was nothing to substitute for. Held in state
   * for the identical reason: it is a property of *this* answer, and leaving it
   * up across a keystroke would offer one search's spelling beside another
   * search's rows.
   */
  const [suggested, setSuggested] = useState<string | null>(null);
  const [searching, setSearching] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const needle = q.trim();
  /**
   * The search has been out long enough to be worth mentioning.
   *
   * `searching` itself is true from the keystroke, through the debounce, to the
   * response — which on a warm build is under the time it takes to lift a
   * finger. Driving anything visible off it strobes the panel once per
   * character typed.
   */
  const slowSearch = usePending(searching);
  /**
   * The rows on screen answer a question the reader has already moved on from.
   *
   * Dimmed rather than cleared, and that is the whole of the difference: a list
   * that empties on every keystroke is a list nobody can read while typing, and
   * clearing also collapses the panel to nothing and then reopens it, which
   * moves the pointer's target out from under it. Dim says *these are still the
   * old answers* without taking them away.
   */
  const stale = slowSearch && (hits.length > 0 || fossils.length > 0);
  /** What to put in the list when there is nothing in it. See {@link emptyState}. */
  const empty = emptyState({ query: needle, searching, slow: slowSearch });

  useEffect(() => {
    if (open) {
      setQ("");
      setActive(0);
      setFailed(null);
      // Focus after paint so the caret lands in an element that exists.
      requestAnimationFrame(() => inputRef.current?.focus());
    } else {
      // Closed — on a row taken or on Escape, and the difference does not
      // matter here. What matters is that a reader who types the right word and
      // presses Enter inside the idle window is not recorded as having searched
      // for nothing, which is the search that worked.
      beacon.endSearch();
    }
  }, [open]);

  useEffect(() => {
    if (!open || q.trim().length < MIN_QUERY) {
      setHits([]);
      setFossils([]);
      setCorrected(null);
      setSuggested(null);
      setSearching(false);
      return;
    }
    let cancelled = false;
    // The debounce stops a request being *sent* inside 110 ms; this stops one
    // already sent from being paid for after it stops mattering. `/v1/search`
    // is served by one container instance with half a vCPU, so a superseded
    // request is not idle waiting — it holds the only CPU there is while the
    // keystroke the reader is waiting on queues behind it. Typing steadily is
    // exactly the case that used to leave several in flight at once.
    const inflight = new AbortController();
    setSearching(true);
    const t = window.setTimeout(async () => {
      try {
        const r = await api.search(q.trim(), 24, inflight.signal, scope?.key);
        // Fed the query the server was actually asked, not the keystroke. The
        // beacon holds a prefix chain to one event, so `w…whale` is recorded
        // once — `analytics/beacon.ts` is the rule and why it is that one.
        beacon.search(q.trim());
        if (!cancelled) {
          setHits(r.results);
          setFossils(r.fossils ?? []);
          setCorrected(r.corrected ?? null);
          setSuggested(r.suggested ?? null);
          setFailed(null);
        }
      } catch (e) {
        if (!cancelled) {
          setHits([]);
          setFossils([]);
          setCorrected(null);
          setSuggested(null);
          setFailed(e instanceof Error ? e.message : String(e));
        }
      } finally {
        if (!cancelled) setSearching(false);
      }
    }, DEBOUNCE_MS);
    return () => {
      cancelled = true;
      window.clearTimeout(t);
      // The abort lands as a rejection, and every branch below the await is
      // already guarded by `cancelled` — so nothing renders an aborted request
      // as a failure. That guard is why this is one line rather than a new
      // error path.
      inflight.abort();
    };
  }, [q, open, scope?.key]);

  // The drill-down's opening move: entering a clade lists what is inside it,
  // so there is no blank state to type your way out of. Re-fetched (from the
  // forever memo, usually) whenever the innermost chip changes; cleared when
  // the last chip pops. No AbortController here — the URL is build-bounded
  // and memoised, so a superseded request is next drill's instant answer
  // rather than waste.
  useEffect(() => {
    if (!open || !scope) {
      setChildren(null);
      setChildTotal(0);
      return;
    }
    let cancelled = false;
    setChildren(null);
    api
      .children(scope.key)
      .then((r) => {
        if (!cancelled) {
          setChildren(r.results);
          setChildTotal(r.total);
        }
      })
      .catch((e: unknown) => {
        if (!cancelled) {
          setChildren([]);
          setChildTotal(0);
          setFailed(e instanceof Error ? e.message : String(e));
        }
      });
    return () => {
      cancelled = true;
    };
  }, [open, scope]);

  const rows = useMemo(() => {
    const needle = q.trim();
    const cmdRows: Row[] = commands
      .map((cmd) => {
        const m = fuzzy(needle, cmd.title);
        if (!m) return null;
        return {
          kind: "cmd" as const,
          cmd,
          score: m.score + sessionBoost(cmd.id) + (needle ? 0 : 50),
          ranges: m.ranges,
        };
      })
      .filter((r): r is Extract<Row, { kind: "cmd" }> => r !== null);

    // The server has already ranked on corpus signals it can see and we
    // cannot — subtree size, silhouette coverage, age quality, and how well
    // the query sits inside *every* name the taxon has rather than the two
    // fields on the wire. Preserve that order and layer the session signal on
    // top rather than re-sorting from scratch, which would throw away the
    // better signal of the two.
    //
    // The fuzzy score used to be in here at score/40, and it silently undid
    // the server's answer. It is worth up to 42 points against a server rank
    // step of 10, so it moved rows four places — and its failure mode is
    // one-sided: a row whose match the client cannot see scores 0 while its
    // neighbour scores 32. "butterfly" is the case that showed it. The server
    // ranks Papilionidae first on "swallowtail butterflies"; `fuzzy` cannot
    // find "butterfly" in "butterflies" at all, so Papilionidae scored zero
    // and *Thecosomata*, a sea snail called "sea butterfly", took the top of
    // the palette while the API underneath was answering correctly. Matching
    // is a display question here, not a ranking one: `litRanges` still says
    // why a row is on the page, and says nothing when it cannot tell.
    //
    // Broken taxa are excluded here rather than styled differently: they are
    // not answers, they cannot be added, and anything in this list is
    // something Enter will act on. They render as a note below the list.
    // Both corpora share one scale, because the server ranked them on one —
    // see {@link rowScore}. The two bases used to differ, 4000 for a node and
    // 2000 for a fossil, and that gap was the pinned tail expressed as a
    // number: it outweighed every real signal by design.
    const hitRows: Row[] = hits
      .map((hit, i) => {
        if (hit.kind === "broken") return null;
        const hay = hit.name ?? hit.key;
        return {
          kind: "hit" as const,
          hit,
          score: rowScore(hit.order, i) + sessionBoost(`n:${hit.idx}`),
          // Show the reader why this row is here — on whichever field it is
          // actually true of, and not at all when neither contains what they
          // typed. That set is a **synonym or a vernacular**, and not the
          // "synonym or an abbreviation" this said: an abbreviation always lights
          // its epithet, `rex` on *Tyrannosaurus rex*, while a vernacular match
          // leaves nothing lit on 18.3% of rows, because the row prints the
          // taxon's headline name and any of its names can be what matched.
          // {@link matchedVia} is where the whole set is written down and why
          // only one of the two is credited.
          ranges: litRanges(needle, hay),
          vernRanges: hit.vernacular ? litRanges(needle, hit.vernacular) : [],
        };
      })
      .filter((r): r is Extract<Row, { kind: "hit" }> => r !== null);

    // Undated taxa are dropped here, not styled differently: a fossil with no
    // appearance interval has no position in time and cannot be drawn, so
    // offering one is offering a dead end — the same reason broken taxa are not
    // rows. They become a note below.
    const fossilRows: Row[] = fossils
      .filter((f) => hasInterval(f) && (f.pbdb_taxon_no ?? 0) > 0)
      .map((f, i) => ({
        kind: "fossil" as const,
        fossil: f,
        score:
          rowScore(f.order, hits.length + i) +
          sessionBoost(`f:${f.pbdb_taxon_no}`),
        ranges: litRanges(needle, f.name),
      }));

    return { cmdRows, hitRows, fossilRows };
  }, [q, commands, hits, fossils]);

  // The empty state's bands as rows, through the same {@link RowView} with no
  // highlight ranges. Score counts down from the band's length so the curated
  // order survives the section's `b.score - a.score` sort; `sessionBoost` is not
  // used, or the list would reorder between openings.
  const suggestionRows = useMemo(
    () =>
      suggestionBands({
        filter,
        scoped: scope !== null,
        query: needle,
        suggestions,
      }).map(([title, band]): [string, Row[]] => [
        title,
        band.map((hit, i) => ({
          kind: "hit" as const,
          hit,
          score: band.length - i,
          ranges: [],
          vernRanges: [],
        })),
      ]),
    [filter, scope, needle, suggestions],
  );

  // The scoped empty state as rows: the clade's children, in the server's
  // largest-first order via the same `rowScore` a search answer uses. Live
  // only while there is nothing to search for — one real query and the
  // search's own rows own the list.
  const childRows: Row[] = useMemo(() => {
    if (!scope || needle.length >= MIN_QUERY || !children) return [];
    return children.map((hit, i) => ({
      kind: "hit" as const,
      hit,
      score: rowScore(hit.order, i),
      ranges: [],
      vernRanges: [],
    }));
  }, [scope, needle, children]);

  // Rows grouped into titled sections, floating on their best row's score
  // except {@link TAIL_SECTIONS}, which hold the bottom.
  const sections: Section[] = useMemo(() => {
    const byTitle = new Map<string, Row[]>();
    const push = (title: string, row: Row) => {
      const list = byTitle.get(title);
      if (list) list.push(row);
      else byTitle.set(title, [row]);
    };
    // The empty state, and it is the whole list when it is there at all — a
    // suggestion and a result can never be on screen together, because a
    // suggestion exists only while there is nothing to search for.
    for (const [title, list] of suggestionRows) {
      for (const r of list) push(title, r);
    }
    // The scoped empty state fills the same section a search answer would, so
    // arrows, Enter and Tab work identically on both.
    for (const r of childRows) push(SPECIES_SECTION, r);
    // One section for both catalogues; the rows sort on `score` (the server's
    // merged `order`), so a fossil sits where the ranking put it.
    for (const r of rows.hitRows) push(SPECIES_SECTION, r);
    for (const r of rows.fossilRows) push(SPECIES_SECTION, r);
    // The filter removes the commands and nothing else. A drill-down removes
    // them too: "toggle dates" is not inside Homo.
    if (filter === null && scope === null) {
      for (const r of rows.cmdRows) {
        if (r.kind === "cmd") push(r.cmd.section, r);
      }
    }

    const out: Section[] = [];
    for (const [title, list] of byTitle) {
      list.sort((a, b) => b.score - a.score);
      out.push({ title, rows: list });
    }
    return out.sort((a, b) => {
      const ra = sectionRank(a.title);
      const rb = sectionRank(b.title);
      if (ra !== rb) return ra - rb;
      return (b.rows[0]?.score ?? 0) - (a.rows[0]?.score ?? 0);
    });
  }, [rows, filter, scope, suggestionRows, childRows]);

  /** The sections flattened, which is what the arrow keys actually walk. */
  const flat: Row[] = useMemo(
    () => sections.flatMap((s) => s.rows),
    [sections],
  );

  const notes: BrokenHit[] = useMemo(
    () => hits.filter((h): h is BrokenHit => h.kind === "broken"),
    [hits],
  );

  /**
   * Fossils that matched but cannot be drawn, named rather than offered.
   *
   * PBDB records no appearance interval for 21.4% of its taxa — *Homo naledi*
   * among them — and "nothing matched" would be the wrong answer to someone who
   * typed a real name. Same treatment as a broken taxon: say the true thing,
   * and make it unpickable.
   */
  const undated: FossilTaxon[] = useMemo(
    () => fossils.filter((f) => !hasInterval(f)),
    [fossils],
  );

  useEffect(() => setActive(0), [q]);

  useEffect(() => {
    const el = listRef.current?.querySelector<HTMLElement>(".row.active");
    el?.scrollIntoView({ block: "nearest" });
  }, [active]);

  const commit = useCallback(
    (row: Row | undefined) => {
      if (!row) return;
      if (row.kind === "cmd") {
        recordUse(row.cmd.id);
        row.cmd.run();
      } else if (row.kind === "fossil") {
        recordUse(`f:${row.fossil.pbdb_taxon_no}`);
        onPickFossil(row.fossil);
      } else {
        recordUse(`n:${row.hit.idx}`);
        onPick(row.hit);
      }
    },
    [onPick, onPickFossil],
  );

  /**
   * Step into a group: push its chip and start again inside it, with the
   * field cleared — the query that found the group is not a query about its
   * contents. Not recorded in the session ranking: drilling is navigation,
   * and boosting a row for having been *walked through* would rank it above
   * the rows the reader actually picked.
   */
  const drill = useCallback(
    (hit: SearchHit) => {
      if (!drillable(hit) || hit.key === scope?.key) return;
      onScopes([
        ...scopes,
        { key: hit.key, name: hit.name ?? hit.key, rank: hit.rank },
      ]);
      setQ("");
      setActive(0);
      inputRef.current?.focus();
    },
    [scopes, scope, onScopes],
  );

  /** Backspace at position zero and Shift-Tab: pop the innermost chip. */
  const popChip = useCallback(() => {
    if (scopes.length > 0) {
      onScopes(scopes.slice(0, -1));
      setActive(0);
    } else if (filter) {
      onFilter(null);
    }
  }, [scopes, onScopes, filter, onFilter]);

  /**
   * Typing into the field, and the one thing that is not typing.
   *
   * `s` then space enters the species filter, the same one the `S` key opens
   * from the canvas. It is the shortest path from "I am already in the palette"
   * to "I only want species", and it costs nothing to a reader who does not
   * know it: the trigger is only live on an empty field with nothing else
   * pushed, so a search for *Sus* or *Salmo* is never intercepted — those have
   * a letter after the s, not a space.
   */
  const onChange = useCallback(
    (v: string) => {
      if (!filter && v === `${FILTER_PREFIX.species} `) {
        onFilter("species");
        setQ("");
        return;
      }
      setQ(v);
    },
    [filter, onFilter],
  );

  const onKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      } else if (e.key === "ArrowDown" || (e.key === "n" && e.ctrlKey)) {
        e.preventDefault();
        setActive((a) => Math.min(a + 1, flat.length - 1));
      } else if (e.key === "ArrowUp" || (e.key === "p" && e.ctrlKey)) {
        e.preventDefault();
        setActive((a) => Math.max(a - 1, 0));
      } else if (e.key === "Enter") {
        e.preventDefault();
        commit(flat[active]);
      } else if (e.key === "Tab" && !e.shiftKey) {
        // Tab steps *into* the active group — Raycast's "search in". Swallowed
        // even on a row it cannot enter (a species, a fossil, a command), or
        // the browser's focus walk quietly leaves the field mid-list.
        e.preventDefault();
        const row = flat[active];
        if (row?.kind === "hit") drill(row.hit);
      } else if (e.key === "Tab" && e.shiftKey) {
        // The symmetric step back out, for the hand already on Tab.
        e.preventDefault();
        popChip();
      } else if (
        e.key === "Backspace" &&
        (filter || scopes.length > 0) &&
        e.currentTarget.selectionStart === 0 &&
        e.currentTarget.selectionEnd === 0
      ) {
        // Backspace at position zero pops the innermost chip — the drill-down
        // path first, then the filter, so it retraces the way in exactly.
        e.preventDefault();
        popChip();
      }
    },
    [flat, active, commit, onClose, filter, scopes, drill, popChip],
  );

  if (!open) return null;

  return (
    <div
      className="palette-scrim"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="palette" role="dialog" aria-label="Command palette">
        <div className="palette-input-row">
          {filter && <span className="scope-chip">{FILTER_LABEL[filter]}</span>}
          {scopes.map((s) => (
            // One chip per step of the path in, innermost last — the trail
            // backspace at position zero walks back out of.
            <span className="scope-chip" key={s.key}>
              {s.rank ? `${s.rank}: ` : ""}
              <span
                className={
                  s.rank === "genus" || s.rank === "species"
                    ? "sci-italic"
                    : undefined
                }
              >
                {s.name}
              </span>
            </span>
          ))}
          <input
            ref={inputRef}
            className="palette-input"
            value={q}
            onChange={(e) => onChange(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder={
              scope
                ? `Search inside ${scope.name}`
                : filter
                  ? "Search species — try “dog”"
                  : "Search a species, or type a command — try “dog”"
            }
            spellCheck={false}
            autoComplete="off"
            aria-label="Search or command"
          />
          {/*
            Not a `kbd` any more. The old indicator was an ellipsis in a keycap,
            which in a panel whose whole right-hand column is keycaps reads as a
            key you could press. A word that says what is happening costs the
            same space and can be heard by a screen reader, which the ellipsis
            could not.
          */}
          {slowSearch && <PendingLine>searching…</PendingLine>}
        </div>

        <div
          className={`palette-list${stale ? " is-stale" : ""}`}
          ref={listRef}
        >
          {failed && (
            <div className="palette-empty">
              Search is unreachable — <span className="mono">{failed}</span>
              <br />
              Start the read API with{" "}
              <span className="kbd">go run ./server -build ./build</span>.
            </div>
          )}

          {!failed && corrected && (
            <SpellingNote typed={needle} used={corrected} />
          )}

          {!failed && suggested && (
            <SpellingOffer
              better={suggested}
              onTake={() => {
                setQ(suggested);
                setActive(0);
                inputRef.current?.focus();
              }}
            />
          )}

          {!failed &&
            flat.length === 0 &&
            notes.length === 0 &&
            undated.length === 0 &&
            empty !== "silent" &&
            // The one render of a scoped prompt state: the children fetch is
            // still out. Nothing, rather than "Type to search…" for the frame
            // before a list the reader never asked to be empty.
            !(scope && empty === "prompt" && children === null) && (
              <div className="palette-empty">
                {empty === "searching" ? (
                  // A count rather than "Loading…", because the size of the
                  // thing being read is the reason there is a wait at all, and
                  // a reader who is told what is being searched knows whether
                  // to keep waiting or to type something shorter.
                  //
                  // One number, not two. It named the species count and the
                  // fossil count together, which is the plumbing: both
                  // catalogues are searched on every query and the reader has
                  // no use for the seam between them.
                  //
                  // **Dropping the second number is what lost the first one.**
                  // The survivor was rewritten on the way through to the node
                  // total — the tree's whole size, a third of a million of it
                  // groups rather than species — and the wrong figure then
                  // spread to four more surfaces before anybody read it. It
                  // comes from {@link SPECIES_PHRASE} now, which is the only
                  // place in `web/` allowed to spell a figure of that shape.
                  <PendingLine>Searching {SPECIES_PHRASE}…</PendingLine>
                ) : empty === "no-match" ? (
                  <>
                    Nothing matched <strong>{needle}</strong>
                    {scope && (
                      <>
                        {" "}
                        inside <strong>{scope.name}</strong> — backspace steps
                        back out
                      </>
                    )}
                    .
                    <br />
                    Scientific names always work; common names depend on the
                    vernacular index having been built.
                  </>
                ) : scope ? (
                  <>Type to search inside {scope.name}.</>
                ) : filter ? (
                  <>Type to search {SPECIES_PHRASE}.</>
                ) : (
                  <>Type to search {SPECIES_PHRASE}, or pick a command.</>
                )}
              </div>
            )}

          {/*
            Sections carry a header only when there is more than one of them.
            A single-section list is not a grouping, and titling it "Species"
            above the only rows on screen is a label on the obvious.

            A pinned head section is the exception and always carries its title,
            even when it is the only thing on screen — which on a first visit is
            exactly what "Start here" is. The heading is not a grouping there,
            it is the offer: without it the band is ten species sitting in a
            search field that was never searched, which reads as a list left
            over from something rather than as somewhere to begin.
          */}
          {(() => {
            let n = -1;
            return sections.map((sec) => (
              <div className="palette-group" key={`s${sec.title}`}>
                {(sections.length > 1 || sectionRank(sec.title) < 0) && (
                  <div className="palette-section" role="presentation">
                    {sec.title}
                  </div>
                )}
                {sec.rows.map((row) => {
                  const i = ++n;
                  return (
                    <RowView
                      // The node key, not the idx: it is the only field both
                      // present and unique on every hit the server can send.
                      key={
                        row.kind === "cmd"
                          ? `c${row.cmd.id}`
                          : row.kind === "fossil"
                            ? `f${row.fossil.pbdb_taxon_no}`
                            : `h${row.hit.key}`
                      }
                      row={row}
                      active={i === active}
                      present={present}
                      presentFossils={presentFossils}
                      onHover={() => setActive(i)}
                      onClick={() => commit(row)}
                      onDrill={
                        row.kind === "hit" &&
                        drillable(row.hit) &&
                        row.hit.key !== scope?.key
                          ? () => drill(row.hit)
                          : null
                      }
                    />
                  );
                })}
              </div>
            ));
          })()}

          {scope &&
            children &&
            childRows.length > 0 &&
            childTotal > children.length && (
              // The page was cut, and the cut is named rather than silent: the
              // rows above are the largest groups, not all of them, and the
              // search reaches everything the list does not show.
              <div className="palette-note" role="note">
                <span className="row-icon">…</span>
                <span className="row-body">
                  <span className="row-sub">
                    The {children.length} largest of{" "}
                    {childTotal.toLocaleString()} groups inside {scope.name}.
                    Type to search all of them.
                  </span>
                </span>
              </div>
            )}

          {notes.map((n) => (
            <BrokenNote key={`b${n.key}`} hit={n} />
          ))}

          {undated.length > 0 && <UndatedNote fossils={undated} />}
        </div>
      </div>
    </div>
  );
}

function RowView({
  row,
  active,
  present,
  presentFossils,
  onHover,
  onClick,
  onDrill,
}: {
  row: Row;
  active: boolean;
  present: Set<number>;
  presentFossils: Set<number>;
  onHover: () => void;
  onClick: () => void;
  /** Step into this group, where it is one. Null on species, fossils, commands. */
  onDrill: (() => void) | null;
}) {
  if (row.kind === "fossil") {
    return (
      <FossilRow
        fossil={row.fossil}
        ranges={row.ranges}
        active={active}
        drawn={presentFossils.has(row.fossil.pbdb_taxon_no ?? -1)}
        onHover={onHover}
        onClick={onClick}
      />
    );
  }

  if (row.kind === "cmd") {
    const c = row.cmd;
    return (
      <div
        className={`row${active ? " active" : ""}`}
        onMouseMove={onHover}
        onClick={onClick}
      >
        <span className="row-icon">{c.icon}</span>
        <span className="row-body">
          <span className="row-title">{parts(c.title, row.ranges)}</span>
        </span>
        <span className="row-accessory">
          {c.keys && <span className="kbd">{c.keys}</span>}
        </span>
      </div>
    );
  }

  const h = row.hit;
  const already = present.has(h.idx);
  const italic = h.rank === "species" || h.rank === "genus";
  // A shape is recognised faster than a name is read, and it is the same shape
  // the node will wear once it lands — so the row previews the result rather
  // than merely naming it. Suppression is the canvas rule, unchanged: a picture
  // borrowed from a kingdom-sized ancestor is worse than none.
  const sil = hitSilhouette(h);

  return (
    <div
      className={`row${active ? " active" : ""}`}
      onMouseMove={onHover}
      onClick={onClick}
    >
      <span className="row-icon">
        {sil ? <Silhouette phylopicId={sil} size={20} fallback="◦" /> : "◦"}
      </span>
      <span className="row-body">
        <span className={`row-title${italic ? " sci-italic" : ""}`}>
          {parts(h.name ?? h.key, row.ranges)}
        </span>
        <span className="row-sub">
          {h.vernacular && <>{parts(h.vernacular, row.vernRanges)} · </>}
          {h.rank && <>{h.rank} · </>}
          {h.tip_count.toLocaleString()} species
        </span>
        {/*
          Why this row matched, when the name that got it here appears nowhere
          else on it — otherwise the reader types *Homo floresiensis* and is
          silently handed *Homo sapiens*. Stated as a filing or a usage, never as
          an alias: neither catalogue is claiming the two names mean one animal.
        */}
        {(() => {
          const via = matchedVia(h);
          if (!via) return null;
          return (
            <span className="row-via">
              matched <em className="sci-italic">{via.name}</em>,{" "}
              {via.who === "taxonomy"
                ? "which the taxonomy files under this name"
                : "the name the fossil record uses for this taxon"}
            </span>
          );
        })()}
      </span>
      <span className="row-accessory">
        {already && <span className="kbd">on canvas</span>}
        {active && !already && <span className="kbd">↵ add</span>}
        {active && onDrill && (
          // A button, not a hint: the keycap text teaches Tab, and the same
          // surface answers a pointer — hover sets `active`, so a mouse sees
          // this exactly where a keyboard does. `stopPropagation` because the
          // row underneath adds, and stepping in must not also add.
          <button
            type="button"
            className="kbd row-drill"
            onClick={(e) => {
              e.stopPropagation();
              onDrill();
            }}
          >
            ⇥ browse
          </button>
        )}
      </span>
    </div>
  );
}

/**
 * A fossil row: shaped like a species row (it sits among them) but the icon is
 * the graft ammonite, the subtitle leads with the range, it carries
 * {@link FOSSIL_BADGE}, and the accessory says *draw* rather than *add*.
 */
function FossilRow({
  fossil,
  ranges,
  active,
  drawn,
  onHover,
  onClick,
}: {
  fossil: FossilTaxon;
  ranges: [number, number][];
  active: boolean;
  drawn: boolean;
  onHover: () => void;
  onClick: () => void;
}) {
  const bounds = [fossil.fea, fossil.fla, fossil.lea, fossil.lla].filter(
    (v): v is number => typeof v === "number" && Number.isFinite(v),
  );
  const span = bounds.length
    ? endedSpanLabel(Math.max(...bounds), Math.min(...bounds))
    : null;
  const italic = fossil.rank === "species" || fossil.rank === "genus";
  return (
    <div
      className={`row${active ? " active" : ""}`}
      onMouseMove={onHover}
      onClick={onClick}
    >
      <span className="row-icon row-icon-fossil">
        {fossil.phylopic_id ? (
          <Silhouette phylopicId={fossil.phylopic_id} size={20} fallback="◦" />
        ) : (
          <AgeGlyph kind="fossil" />
        )}
      </span>
      <span className="row-body">
        {/*
          The badge sits in the title rather than in the accessory column, and
          that is placement rather than styling: the accessory is where the
          *verb* lives ("↵ draw", "on canvas"), which changes as the row is
          walked, and a badge sharing a slot with something transient reads as
          transient. It qualifies the name, so it sits beside the name.

          The name gets a wrapper of its own so the ellipsis lands on it. Left
          on the title, a long binomial would truncate through the badge and
          the row would lose the one thing distinguishing it.
        */}
        <span className="row-title has-badge">
          <span className={italic ? "sci-italic" : undefined}>
            {parts(fossil.name, ranges)}
          </span>
          <span className="row-badge">{FOSSIL_BADGE}</span>
        </span>
        <span className="row-sub">
          {span && <span className="num">{span}</span>}
          {fossil.rank && <> · {fossil.rank}</>}
          {fossil.n_occs > 0 && (
            <> · {fossil.n_occs.toLocaleString()} occurrences</>
          )}
        </span>
      </span>
      <span className="row-accessory">
        {drawn && <span className="kbd">on canvas</span>}
        {active && !drawn && <span className="kbd">↵ draw</span>}
      </span>
    </div>
  );
}

/**
 * The rows below this are for a different spelling than the one typed. Shown,
 * never performed: the server corrects only a query that returned nothing, and a
 * silent substitution would be the same mistake as a confident date on an
 * undated node. Both strings are on screen — the typed one named, so the reader
 * can judge whether the answer is theirs. Leads the list, since it qualifies
 * every row below it.
 */
function SpellingNote({ typed, used }: { typed: string; used: string }) {
  return (
    <div className="palette-note is-lead" role="status">
      <span className="row-icon">↳</span>
      <span className="row-body">
        <span className="row-title">
          Showing results for <strong>{used}</strong>
        </span>
        <span className="row-sub">
          Nothing matched <strong>{typed}</strong>, and that looks like a
          misspelling of a name the tree does have.
        </span>
      </span>
    </div>
  );
}

/**
 * A better spelling, offered beside the rows the reader asked for.
 * {@link SpellingNote}'s counterpart, never on screen with it: this one captions
 * nothing, since the rows below are the answer to what was asked and the better
 * spelling is a door. A button, not a link — pressing it types the word into the
 * field and re-runs the search, so nothing navigates or is destroyed.
 */
function SpellingOffer({
  better,
  onTake,
}: {
  better: string;
  onTake: () => void;
}) {
  return (
    <button
      type="button"
      className="palette-note is-lead is-offer"
      onClick={onTake}
    >
      <span className="row-icon">↳</span>
      <span className="row-body">
        <span className="row-title">
          Did you mean <strong>{better}</strong>?
        </span>
        <span className="row-sub">
          What you typed matched only part of a longer name. Press to search for
          this instead.
        </span>
      </span>
    </button>
  );
}

/**
 * Fossils that matched the query but have nowhere to stand in time.
 *
 * A note rather than a row, for the same reason {@link BrokenNote} is: 21.4% of
 * PBDB taxa carry no appearance interval, so there is no x for them and nothing
 * Enter could usefully do. *Homo naledi* is one of these, and "nothing matched"
 * would be a worse answer than this one to somebody who typed a real name.
 */
function UndatedNote({ fossils }: { fossils: FossilTaxon[] }) {
  const names = fossils.slice(0, 4).map((f) => f.name);
  const rest = fossils.length - names.length;
  return (
    <div className="palette-note" role="note">
      <span className="row-icon">!</span>
      <span className="row-body">
        <span className="row-title">
          {names.map((n, i) => (
            <span key={n}>
              {i > 0 && ", "}
              <strong className="sci-italic">{n}</strong>
            </span>
          ))}
          {rest > 0 && ` and ${rest} more`}{" "}
          {names.length === 1 && rest === 0 ? "is a fossil" : "are fossils"}{" "}
          with no recorded date
        </span>
        <span className="row-sub">
          PBDB records no appearance interval for about a fifth of its taxa, so
          there is nowhere on the time axis to put{" "}
          {names.length === 1 && rest === 0 ? "it" : "them"}. Nothing else about
          the search is affected.
        </span>
      </span>
    </div>
  );
}

/**
 * The answer to "you typed the name of something that is not in the tree".
 *
 * Deliberately not a row. A broken taxon cannot be selected, cannot be added
 * and has no position to draw, so offering it in the ranked list was offering
 * a dead end: picking one put a key in the URL that resolved to nothing, and
 * because nothing was ever drawn there was no node to select and remove — the
 * warning came back on every subsequent add with no way to clear it. A note
 * says the same true thing and cannot be picked.
 */
function BrokenNote({ hit }: { hit: BrokenHit }) {
  const n = hit.n_attachment_points;
  return (
    <div className="palette-note" role="note">
      <span className="row-icon">!</span>
      <span className="row-body">
        <span className="row-title">
          <strong className="sci-italic">{hit.name ?? hit.key}</strong> is not
          monophyletic
        </span>
        <span className="row-sub">
          Its members are scattered across the tree
          {n ? ` — ${n.toLocaleString()} separate places` : ""}, so it has no
          single position and is left out of the synthesis. Search for one of
          the groups inside it instead.
        </span>
      </span>
    </div>
  );
}

function parts(text: string, ranges: [number, number][]) {
  return highlight(text, ranges).map((p, i) =>
    p.hit ? (
      <span className="hl" key={i}>
        {p.text}
      </span>
    ) : (
      <span key={i}>{p.text}</span>
    ),
  );
}
