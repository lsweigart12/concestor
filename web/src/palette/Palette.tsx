/**
 * The command surface. `P` is the root and `S` opens the same list filtered to
 * species; the palette *is* the interface, not an accessory to it, and the
 * empty canvas state is the command list rather than an illustration.
 *
 * Row anatomy follows Raycast: icon · title · subtitle · right-aligned
 * accessory metadata, with an inline keybind hint on every row.
 *
 * Two things make this load-bearing rather than convenient:
 *
 * 1. **Vernacular names.** OTT carries no common names, so a palette backed by
 *    scientific names alone returns nothing for "dog", "T. rex" or "shark" —
 *    broken at the front door, not merely incomplete. The search endpoint
 *    covers vernaculars; this component surfaces them as the subtitle so you
 *    can see *why* a row matched.
 *
 * 2. **Broken taxa.** 9,839 taxa are non-monophyletic and are rejected from
 *    synthesis outright. Searching one must explain that, not silently answer
 *    about a substituted MRCA the way the live Open Tree API does. It must not
 *    do it *as a result*, though — see {@link BrokenNote}.
 */

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
import { FOSSIL_BADGE, FOSSIL_BADGE_HINT, rowScore, SPECIES_PHRASE } from "../corpora";
import { AgeGlyph } from "../canvas/AgeGlyph";
import { endedSpanLabel } from "../canvas/Bracket";
import { Silhouette } from "../canvas/Silhouette";
import { PendingLine, usePending } from "../chrome/Pending";
import { fuzzy, highlight, litRanges, recordUse, sessionBoost } from "./fuzzy";

export interface Command {
  id: string;
  title: string;
  subtitle?: string;
  icon: string;
  /**
   * The hover tooltip, when a row needs more than a subtitle can hold.
   *
   * The subtitle is a *line* — it sits under the title in a fixed-height row
   * and has to stay short enough not to wrap. Some commands have a caveat worth
   * a sentence: what a random pick is drawn from, what it will do to the
   * selection as a side effect. Those belong somewhere a reader can go looking
   * for them and nowhere they have to read past.
   *
   * Falls back to the subtitle, so every command has a tooltip without being
   * given one — the same string, which is the honest default when there is
   * nothing more to say.
   */
  hint?: string;
  keys?: string;
  section: string;
  /** Hidden unless a node is focused — the contextual actions menu. */
  contextual?: boolean;
  run: () => void;
}

export interface Scope {
  label: string;
  /** Popped by backspace at cursor position zero. */
  onPop: () => void;
}

/**
 * The palette is answering about taxa only, with the commands put away.
 *
 * It used to mean *this corpus and not the others*, with fossils as the obvious
 * second value — and that was the split this whole surface no longer makes.
 * There is one corpus of living things: taxa. Some are nodes in the synthesis
 * tree, some are only in the fossil record, and which of those a name falls
 * under is not a thing a reader knows before typing it. So `S` now removes the
 * *commands*, which is what a reader pressing a key labelled "Species" was
 * always after: a list where every row is an animal.
 */
export type PaletteFilter = "species";

/** What a reader types to enter a filter, and what the chip then says. */
const FILTER_PREFIX: Record<PaletteFilter, string> = { species: "s" };
const FILTER_LABEL: Record<PaletteFilter, string> = { species: "Species" };

interface Props {
  open: boolean;
  onClose: () => void;
  commands: Command[];
  scope: Scope | null;
  /** Set when the list is restricted to one corpus. */
  filter: PaletteFilter | null;
  onFilter: (f: PaletteFilter | null) => void;
  onPick: (hit: SearchHit) => void;
  /** A fossil row was chosen: draw it against the tree. */
  onPickFossil: (f: FossilTaxon) => void;
  /** Names already on the canvas, so the palette can say "already added". */
  present: Set<number>;
  /** PBDB taxon numbers already drawn, for the same reason. */
  presentFossils: Set<number>;
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
 * There used to be a second, "Fossils", pinned near the tail however well a
 * fossil name matched — on the argument that a species is a node you can build
 * a tree from and a fossil is an observation that hangs off one. That is a true
 * statement about *plumbing* and a poor one about the reader: they are all
 * species, and typing "triceratops" got every species that nearly matches the
 * word before the animal itself, which the tree has never heard of.
 *
 * The two lists are now merged in the order the server ranked them across both,
 * and what used to be a section heading is a badge on the row — see
 * {@link FossilRow}. `docs/handoff.md` §7's rule is unchanged and now covers the
 * merge as well: `web/` sorts on the server's `order` and computes nothing.
 */
const SPECIES_SECTION = "Species";

/**
 * Credits, provenance and the ranking reset. Pinned dead last.
 *
 * Without this it *climbs*, and climbs precisely because it is useful once:
 * every section floats on its best row's score and {@link sessionBoost} adds to
 * whatever the reader has pressed before, so opening the about panel twice
 * parks it above Fit and Species for the rest of the session. These two rows
 * answer a question nobody is in the middle of asking — they belong at the
 * bottom of a list, the way an About menu item does everywhere else.
 *
 * They stay findable: type "about" and every other section stops matching, so
 * the only section left is at the top by default.
 */
export const ABOUT_SECTION = "About";

/**
 * Sections whose position is fixed, in the order they appear at the tail.
 * Everything not listed floats on its best row's score.
 */
const TAIL_SECTIONS: readonly string[] = [ABOUT_SECTION];
const tailRank = (title: string): number => {
  const i = TAIL_SECTIONS.indexOf(title);
  return i < 0 ? 0 : i + 1;
};

const DEBOUNCE_MS = 110;

/**
 * What the list says when it has no rows to show.
 *
 * A pure function because the wrong answer here was shipping: with a query of
 * two or more characters and no hits yet, the list said **"Nothing matched
 * dog"** — for the whole of the debounce and the whole of the round trip,
 * before anything had been asked, let alone answered. On a warm local build
 * that is a flash. Against a cold container it is a flat statement that the
 * corpus does not contain the dog, sitting on screen for as long as the reader
 * cares to look at it, and then quietly replaced by eight rows about dogs.
 *
 * So "nothing matched" is now reachable only from a *settled* search, and the
 * four states are kept apart:
 *
 * - `prompt` — nothing typed yet, or one character. Say what this box is for.
 * - `silent` — a search is out and has not yet earned an indicator. Render
 *   nothing: the answer is arriving inside the time it would take to read a
 *   word about it, and a notice that outlives its own subject is worse than
 *   the wait it describes.
 * - `searching` — the search is genuinely slow. Say so, and say what is being
 *   searched, because the size of the corpus is the reason for the wait.
 * - `no-match` — the search came back empty. The only state entitled to say so.
 *
 * The two-character floor is the effect's, not this function's; both read
 * `MIN_QUERY` so the list cannot describe a search that never ran.
 */
export type EmptyState = "prompt" | "silent" | "searching" | "no-match";

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

/**
 * The synonym that got this row onto the page, or null.
 *
 * **Synonyms only**, and the other three kinds are each excluded for their own
 * reason. A `name` or `vernacular` match is already printed in the row and
 * highlighted where it matched, so crediting it would caption the obvious. An
 * `abbreviation` looked like it belonged here and does not: "T. rex" returns
 * eight rows that all matched the same way, so the line repeats down the whole
 * list without distinguishing anything — and *Tyrannosaurus rex* with `rex`
 * highlighted already explains itself.
 *
 * A synonym is the one case where the typed string appears **nowhere** on the
 * row, so the answer arrives with no visible connection to the question.
 */
function matchedVia(h: SearchHit): string | null {
  if (h.matched_on !== "synonym") return null;
  return h.matched_name ?? null;
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
  scope,
  filter,
  onFilter,
  onPick,
  onPickFossil,
  present,
  presentFossils,
}: Props) {
  const [q, setQ] = useState("");
  const [hits, setHits] = useState<AnyHit[]>([]);
  const [fossils, setFossils] = useState<FossilTaxon[]>([]);
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
        const r = await api.search(q.trim(), 24, inflight.signal);
        // Fed the query the server was actually asked, not the keystroke. The
        // beacon holds a prefix chain to one event, so `w…whale` is recorded
        // once — `analytics/beacon.ts` is the rule and why it is that one.
        beacon.search(q.trim());
        if (!cancelled) {
          setHits(r.results);
          setFossils(r.fossils ?? []);
          setFailed(null);
        }
      } catch (e) {
        if (!cancelled) {
          setHits([]);
          setFossils([]);
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
  }, [q, open]);

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
    const hitRows: Row[] = hits.map((hit, i) => {
      if (hit.kind === "broken") return null;
      const hay = hit.name ?? hit.key;
      return {
        kind: "hit" as const,
        hit,
        score: rowScore(hit.order, i) + sessionBoost(`n:${hit.idx}`),
        // Show the reader why this row is here — on whichever field it is
        // actually true of, and not at all when neither contains what they
        // typed (a synonym or an abbreviation got them here instead).
        ranges: litRanges(needle, hay),
        vernRanges: hit.vernacular ? litRanges(needle, hit.vernacular) : [],
      };
    }).filter((r): r is Extract<Row, { kind: "hit" }> => r !== null);

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

  /**
   * Rows grouped into titled sections, Raycast-style.
   *
   * Sections float on their best row's score so the thing that best matches
   * what was typed leads — except those in {@link TAIL_SECTIONS}, which hold
   * the bottom whatever they score. `Command.section` has carried the grouping
   * the whole time and nothing rendered it; this is where it starts meaning
   * something.
   */
  const sections: Section[] = useMemo(() => {
    const byTitle = new Map<string, Row[]>();
    const push = (title: string, row: Row) => {
      const list = byTitle.get(title);
      if (list) list.push(row);
      else byTitle.set(title, [row]);
    };
    // One section for every taxon, whichever catalogue found it. The rows sort
    // on `score` below, which is the server's merged `order`, so a fossil sits
    // exactly where the ranking put it rather than under a heading of its own.
    for (const r of rows.hitRows) push(SPECIES_SECTION, r);
    for (const r of rows.fossilRows) push(SPECIES_SECTION, r);
    // The filter removes the *commands* and nothing else. The reader pressed a
    // key labelled "Species"; leaving a command row above the answer would make
    // that a suggestion.
    if (filter === null) {
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
      const ra = tailRank(a.title);
      const rb = tailRank(b.title);
      if (ra !== rb) return ra - rb;
      return (b.rows[0]?.score ?? 0) - (a.rows[0]?.score ?? 0);
    });
  }, [rows, filter]);

  /** The sections flattened, which is what the arrow keys actually walk. */
  const flat: Row[] = useMemo(() => sections.flatMap((s) => s.rows), [sections]);

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
      if (!filter && !scope && v === `${FILTER_PREFIX.species} `) {
        onFilter("species");
        setQ("");
        return;
      }
      setQ(v);
    },
    [filter, scope, onFilter],
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
      } else if (
        e.key === "Backspace" &&
        (scope || filter) &&
        e.currentTarget.selectionStart === 0 &&
        e.currentTarget.selectionEnd === 0
      ) {
        // Backspace at position zero pops the scope, per design-reference.md —
        // and now the filter, which is the same gesture on the same chip.
        // Innermost first: a filter is entered from inside a scope, never the
        // other way round.
        e.preventDefault();
        if (filter) onFilter(null);
        else scope?.onPop();
      }
    },
    [flat, active, commit, onClose, scope, filter, onFilter],
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
          {scope && <span className="scope-chip">{scope.label}</span>}
          {filter && <span className="scope-chip">{FILTER_LABEL[filter]}</span>}
          <input
            ref={inputRef}
            className="palette-input"
            value={q}
            onChange={(e) => onChange(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder={
              filter
                ? "Search species — try “dog”"
                : scope
                  ? "Action…"
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

          {!failed &&
            flat.length === 0 &&
            notes.length === 0 &&
            undated.length === 0 &&
            empty !== "silent" && (
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
                    Nothing matched <strong>{needle}</strong>.
                    <br />
                    Scientific names always work; common names depend on the
                    vernacular index having been built.
                  </>
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
          */}
          {(() => {
            let n = -1;
            return sections.map((sec) => (
              <div className="palette-group" key={`s${sec.title}`}>
                {sections.length > 1 && (
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
                    />
                  );
                })}
              </div>
            ));
          })()}

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
}: {
  row: Row;
  active: boolean;
  present: Set<number>;
  presentFossils: Set<number>;
  onHover: () => void;
  onClick: () => void;
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
        title={c.hint ?? c.subtitle}
        onMouseMove={onHover}
        onClick={onClick}
      >
        <span className="row-icon">{c.icon}</span>
        <span className="row-body">
          <span className="row-title">{parts(c.title, row.ranges)}</span>
          {c.subtitle && <span className="row-sub">{c.subtitle}</span>}
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
        {sil ? (
          <Silhouette phylopicId={sil} size={20} fallback="◦" />
        ) : (
          "◦"
        )}
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
          Why this row is here, when nothing else on it says so.

          A synonym or an abbreviation is the only field containing what was
          typed, and the row cannot otherwise show it — so the answer arrives
          looking like the search misheard. OTT files *Homo floresiensis* as a
          synonym of *Homo sapiens*, which makes the unexplained version an
          unexplained answer about a **different species**: the reader types a
          real hominin and is silently handed us.

          Stated as the taxonomy's filing rather than as a fact about the
          animal. "Also known as" is the wording a Wikidata bug once put on this
          exact pair, and it would be no more true coming from OTT — a
          deprecated name is not an alias.
        */}
        {matchedVia(h) && (
          <span className="row-via">
            matched <em className="sci-italic">{matchedVia(h)}</em>, which the
            taxonomy files under this name
          </span>
        )}
      </span>
      <span className="row-accessory">
        {already && <span className="kbd">on canvas</span>}
        {active && !already && <span className="kbd">↵ add</span>}
      </span>
    </div>
  );
}

/**
 * A fossil row.
 *
 * Deliberately shaped like a species row and deliberately not identical to one.
 * Same anatomy — icon, title, subtitle, accessory — because it is the same kind
 * of list item and Raycast's grammar should not change halfway down, and
 * because it now sits *among* the species rows rather than under a heading that
 * separated them. But the icon is the ammonite the canvas uses for a graft
 * rather than a silhouette dot, the subtitle leads with the range instead of a
 * species count, it carries {@link FOSSIL_BADGE}, and the accessory says *draw*
 * rather than *add* — a different verb, because a species joins the tree and
 * this is drawn against it.
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
          <span className="row-badge" title={FOSSIL_BADGE_HINT}>
            {FOSSIL_BADGE}
          </span>
        </span>
        <span className="row-sub">
          {span && <span className="num">{span}</span>}
          {fossil.rank && <> · {fossil.rank}</>}
          {fossil.n_occs > 0 && <> · {fossil.n_occs.toLocaleString()} occurrences</>}
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
          {names.length === 1 && rest === 0 ? "is a fossil" : "are fossils"} with
          no recorded date
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
