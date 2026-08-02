/**
 * The command surface. ⌘K is the root, and the palette *is* the interface —
 * not an accessory to it. Opening the app opens the palette, and the empty
 * canvas state is the command list rather than an illustration.
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
import {
  api,
  hitSilhouette,
  type AnyHit,
  type BrokenHit,
  type FossilTaxon,
  type SearchHit,
} from "../api";
import { AgeGlyph } from "../canvas/AgeGlyph";
import { endedSpanLabel } from "../canvas/Bracket";
import { Silhouette } from "../canvas/Silhouette";
import { fuzzy, highlight, litRanges, recordUse, sessionBoost } from "./fuzzy";

export interface Command {
  id: string;
  title: string;
  subtitle?: string;
  icon: string;
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

interface Props {
  open: boolean;
  onClose: () => void;
  commands: Command[];
  scope: Scope | null;
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
 * The fossil section's title, and the one section whose position is fixed.
 *
 * Every other section floats on its best row's score. This one is pinned last
 * however well a fossil name matches, because the two corpora answer different
 * questions: a species is a node you can build a tree from, a fossil is an
 * observation that hangs off one. Typing "dimetrodon" should not bury the
 * species list under eight PBDB rows, and a reader who wants the fossil will
 * find it — it is the only section with that name.
 */
const FOSSIL_SECTION = "Fossils";
const SPECIES_SECTION = "Species";

const DEBOUNCE_MS = 110;

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

  useEffect(() => {
    if (open) {
      setQ("");
      setActive(0);
      setFailed(null);
      // Focus after paint so the caret lands in an element that exists.
      requestAnimationFrame(() => inputRef.current?.focus());
    }
  }, [open]);

  useEffect(() => {
    if (!open || q.trim().length < 2) {
      setHits([]);
      setFossils([]);
      setSearching(false);
      return;
    }
    let cancelled = false;
    setSearching(true);
    const t = window.setTimeout(async () => {
      try {
        const r = await api.search(q.trim(), 24);
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
    // cannot — subtree size, silhouette coverage, age quality. Preserve that
    // order and layer the session signal on top rather than re-sorting from
    // scratch, which would throw away the better signal of the two.
    //
    // Broken taxa are excluded here rather than styled differently: they are
    // not answers, they cannot be added, and anything in this list is
    // something Enter will act on. They render as a note below the list.
    const hitRows: Row[] = hits.map((hit, i) => {
      if (hit.kind === "broken") return null;
      const hay = hit.name ?? hit.key;
      const m = fuzzy(needle, hay) ?? fuzzy(needle, hit.vernacular ?? "");
      return {
        kind: "hit" as const,
        hit,
        score: 4000 - i * 10 + sessionBoost(`n:${hit.idx}`) + (m?.score ?? 0) / 40,
        // Show the reader why this row is here — on whichever field it is
        // actually true of, and not at all when neither contains what they
        // typed (a synonym or an abbreviation got them here instead).
        ranges: litRanges(needle, hay),
        vernRanges: hit.vernacular ? litRanges(needle, hit.vernacular) : [],
      };
    }).filter((r): r is Extract<Row, { kind: "hit" }> => r !== null);

    // Ranked by the server on match tier then notability. Undated taxa are
    // dropped here, not styled differently: a fossil with no appearance
    // interval has no position in time and cannot be drawn, so offering one is
    // offering a dead end — the same reason broken taxa are not rows. They
    // become a note below.
    const fossilRows: Row[] = fossils
      .filter((f) => hasInterval(f) && (f.pbdb_taxon_no ?? 0) > 0)
      .map((f, i) => ({
        kind: "fossil" as const,
        fossil: f,
        score: 2000 - i * 10 + sessionBoost(`f:${f.pbdb_taxon_no}`),
        ranges: litRanges(needle, f.name),
      }));

    return { cmdRows, hitRows, fossilRows };
  }, [q, commands, hits, fossils]);

  /**
   * Rows grouped into titled sections, Raycast-style.
   *
   * Sections float on their best row's score so the thing that best matches
   * what was typed leads — except {@link FOSSIL_SECTION}, which is pinned last
   * whatever it scores. `Command.section` has carried the grouping the whole
   * time and nothing rendered it; this is where it starts meaning something.
   */
  const sections: Section[] = useMemo(() => {
    const byTitle = new Map<string, Row[]>();
    const push = (title: string, row: Row) => {
      const list = byTitle.get(title);
      if (list) list.push(row);
      else byTitle.set(title, [row]);
    };
    for (const r of rows.hitRows) push(SPECIES_SECTION, r);
    for (const r of rows.cmdRows) {
      if (r.kind === "cmd") push(r.cmd.section, r);
    }
    for (const r of rows.fossilRows) push(FOSSIL_SECTION, r);

    const out: Section[] = [];
    for (const [title, list] of byTitle) {
      list.sort((a, b) => b.score - a.score);
      out.push({ title, rows: list });
    }
    return out.sort((a, b) => {
      if (a.title === FOSSIL_SECTION) return 1;
      if (b.title === FOSSIL_SECTION) return -1;
      return (b.rows[0]?.score ?? 0) - (a.rows[0]?.score ?? 0);
    });
  }, [rows]);

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
        scope &&
        e.currentTarget.selectionStart === 0 &&
        e.currentTarget.selectionEnd === 0
      ) {
        // Backspace at position zero pops the scope, per design-reference.md.
        e.preventDefault();
        scope.onPop();
      }
    },
    [flat, active, commit, onClose, scope],
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
          <input
            ref={inputRef}
            className="palette-input"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder={
              scope ? "Action…" : "Search a species, or type a command — try “dog”"
            }
            spellCheck={false}
            autoComplete="off"
            aria-label="Search or command"
          />
          {searching && <span className="kbd">…</span>}
        </div>

        <div className="palette-list" ref={listRef}>
          {failed && (
            <div className="palette-empty">
              Search is unreachable — <span className="mono">{failed}</span>
              <br />
              Start the read API with{" "}
              <span className="kbd">go run ./server -build ./build</span>.
            </div>
          )}

          {!failed && flat.length === 0 && notes.length === 0 && undated.length === 0 && (
            <div className="palette-empty">
              {q.trim().length >= 2 ? (
                <>
                  Nothing matched <strong>{q.trim()}</strong>.
                  <br />
                  Scientific names always work; common names depend on the
                  vernacular index having been built.
                </>
              ) : (
                <>Type to search 2.4 million species, or pick a command.</>
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
 * of list item and Raycast's grammar should not change halfway down. But the
 * icon is the ammonite the canvas uses for a graft rather than a silhouette
 * dot, the subtitle leads with the range instead of a species count, and the
 * accessory says *draw* rather than *add*, because that is a different verb: a
 * species joins the tree, a fossil is drawn against it.
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
        <span className={`row-title${italic ? " sci-italic" : ""}`}>
          {parts(fossil.name, ranges)}
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
