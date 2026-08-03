package store

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"sort"
	"strings"
)

// Fossils attach to segments; they are not placed in the tree (architecture
// §3.4). Each PBDB taxon carries the deepest synthesis node that is an
// ancestor-or-self of it, so a segment query is one index scan over
// fossil(attach_idx, n_occs DESC).
//
// The claim being made is deliberately weak: *this taxon belongs somewhere
// below node X, and existed between these dates.* Not *this taxon is the
// sister of that one.* Both appearance brackets are returned uncollapsed so
// the UI can draw the double bracket — faded envelope fea→lla for the maximal
// possible extent, solid bar fla→lea for the minimal certain one. Anything
// else misrepresents PBDB's uncertainty model, and ~21% of taxa have no
// interval at all and must get an explicit "no range recorded" treatment
// rather than a zero-width bar.

// FossilSchema is the resolved shape of the fossil table.
type FossilSchema struct {
	Table      string `json:"table"`
	AttachIdx  string `json:"attach_idx"`
	Name       string `json:"name"`
	NOccs      string `json:"n_occs"`
	Rank       string `json:"rank,omitempty"`
	Difference string `json:"difference,omitempty"`
	IsExtant   string `json:"is_extant,omitempty"`
	IsPrimary  string `json:"is_primary,omitempty"`
	AcceptedNo string `json:"accepted_no,omitempty"`
	// TaxonNo is the PBDB primary key. It is the only stable identity a fossil
	// has — it is not a node, so it has no `node_key` and no OTT id — and a
	// graft cannot go in a shareable URL without one.
	TaxonNo string `json:"taxon_no,omitempty"`
	// AttachWalk is how many PBDB parent_no hops the resolution took, and so
	// how loose the placement is. Zero means the taxon is itself in the tree.
	AttachWalk string `json:"attach_walk,omitempty"`
	Brackets   bool   `json:"brackets"`
	// YoungEnd is whether phase 4's reading of the last-appearance young end is
	// present: `lla_identified`, `young_end_occs` and `lla_drawn` together. A
	// build predating them serves `lla` alone and the UI draws as it always
	// did, so the three travel as one flag rather than three.
	YoungEnd   bool   `json:"young_end"`
	MethodName string `json:"attach_method_table,omitempty"`
	// ImageTable maps a PBDB taxon to a drawing. A fossil is not a node, so
	// node_image cannot reach it and this is the only join that can.
	ImageTable string `json:"image_table,omitempty"`
	ImageKey   string `json:"image_key,omitempty"`
	ImageID    string `json:"image_id,omitempty"`
	// FTSTable is the FTS5 index over `name`, whose rowid is TaxonNo. Empty on
	// a build predating it, where {@link SearchFossils} falls back to the scan.
	//
	// It is only ever set by {@link verifyFossilFTS}, which *checks* the rowid
	// identity against the table rather than inferring it from the name of the
	// index. The same assumption made about `node_fts` — that a rowid must be
	// the key it looks like — did not error, it joined cleanly to unrelated
	// nodes and returned confident nonsense, and here the nonsense would be a
	// fossil card describing a different animal.
	FTSTable string `json:"fts_table,omitempty"`
}

func (s *Schema) resolveFossil() {
	t := s.firstTable("fossil", "fossils")
	if t == "" {
		return
	}
	attach := s.col(t, "attach_idx", "attach", "idx")
	name := s.col(t, "name", "accepted_name")
	occs := s.col(t, "n_occs", "occurrences", "n_occurrences")
	if attach == "" || name == "" || occs == "" {
		s.Skipped[t] = "no attach_idx/name/n_occs columns could be resolved"
		return
	}
	f := &FossilSchema{
		Table: t, AttachIdx: attach, Name: name, NOccs: occs,
		Rank:       s.col(t, "rank", "accepted_rank"),
		Difference: s.col(t, "difference"),
		IsExtant:   s.col(t, "is_extant"),
		IsPrimary:  s.col(t, "is_primary"),
		AcceptedNo: s.col(t, "accepted_no"),
		TaxonNo:    s.col(t, "pbdb_taxon_no", "taxon_no"),
		AttachWalk: s.col(t, "attach_walk"),
	}
	f.Brackets = s.col(t, "fea") != "" && s.col(t, "fla") != "" &&
		s.col(t, "lea") != "" && s.col(t, "lla") != ""
	f.YoungEnd = f.Brackets && s.col(t, "lla_identified") != "" &&
		s.col(t, "young_end_occs") != "" && s.col(t, "lla_drawn") != "" &&
		s.col(t, "lea_drawn") != ""
	if it := s.firstTable("fossil_image"); it != "" && f.AcceptedNo != "" {
		key, id := s.col(it, "accepted_no"), s.col(it, "phylopic_id")
		if key == "" || id == "" {
			s.Skipped[it] = "no accepted_no/phylopic_id column pair could be resolved"
		} else {
			f.ImageTable, f.ImageKey, f.ImageID = it, key, id
		}
	}
	s.Fossil = f
}

// verifyFossilFTS wires up `fossil_fts` only after proving its rowid really is
// a `pbdb_taxon_no`.
//
// **The proof has to go through MATCH.** The obvious check — join the index to
// the table on that identity and count the names that disagree — is not a check
// at all: the index is contentless, so selecting a column off it yields NULL,
// `NULL <> 'Eotriceratops'` is NULL rather than true, and the count comes back
// 0 for a correct index and a deliberately corrupted one alike. That is the
// house rule about counting rows not being the same as checking them, arriving
// through a door nobody was watching.
//
// So each sampled taxon is looked up *by its own name*, and the answer must
// contain its own key. A correct index passes; one built against any other key
// fails on the first sample. The sample is taken from both ends of the keyspace
// because a key that merely *overlaps* the right one — the case no amount of
// reading the schema would catch — can agree across a whole region and diverge
// outside it.
//
// Refusal is not fatal. The scan is still there, still correct, and a slow
// search is a better failure than a search that describes the wrong animal.
func (s *Schema) verifyFossilFTS(ctx context.Context, db *sql.DB) {
	f := s.Fossil
	if f == nil {
		return
	}
	t := s.firstTable("fossil_fts")
	if t == "" {
		return
	}
	if f.TaxonNo == "" {
		s.Skipped[t] = "the fossil table carries no pbdb_taxon_no, so the index " +
			"rowid cannot be tied back to a row"
		return
	}
	refuse := func(why string) { s.Skipped[t] = why }

	const perEnd = 16
	type sample struct {
		no   int64
		name string
	}
	var samples []sample
	for _, dir := range []string{"ASC", "DESC"} {
		rows, err := db.QueryContext(ctx, fmt.Sprintf(
			`SELECT %q, %q FROM %q WHERE trim(%q) <> '' ORDER BY %q %s LIMIT %d`,
			f.TaxonNo, f.Name, f.Table, f.Name, f.TaxonNo, dir, perEnd))
		if err != nil {
			refuse("could not be verified against " + f.Table + ": " + err.Error())
			return
		}
		for rows.Next() {
			var sm sample
			if err := rows.Scan(&sm.no, &sm.name); err != nil {
				_ = rows.Close()
				refuse("could not be verified against " + f.Table + ": " + err.Error())
				return
			}
			samples = append(samples, sm)
		}
		err = rows.Err()
		_ = rows.Close()
		if err != nil {
			refuse("could not be verified against " + f.Table + ": " + err.Error())
			return
		}
	}
	if len(samples) == 0 {
		refuse("the fossil table is empty, so the index cannot be verified")
		return
	}

	lookup := fmt.Sprintf(
		`SELECT count(*) FROM %q WHERE %q MATCH ? AND rowid = ?`, t, t)
	for _, sm := range samples {
		expr := ftsPrefixQuery(sm.name)
		if expr == "" {
			// A name with no indexable token at all says nothing either way.
			continue
		}
		var found int
		if err := db.QueryRowContext(ctx, lookup, expr, sm.no).Scan(&found); err != nil {
			refuse("could not be verified against " + f.Table + ": " + err.Error())
			return
		}
		if found == 0 {
			refuse(fmt.Sprintf(
				"%s.%s %d is named %q, and searching the index for that name does "+
					"not return it — so the index rowid is not %s.%s",
				f.Table, f.TaxonNo, sm.no, sm.name, f.Table, f.TaxonNo))
			return
		}
	}
	f.FTSTable = t
}

// Fossil is one PBDB taxon attached to a segment.
type Fossil struct {
	Name string `json:"name"`
	// PBDB's own primary key, and the only identity this taxon has. Zero on a
	// build whose fossil table predates the column. Nothing may address the
	// *tree* with it — see the warning on `divergence_pbdb_taxon_no`.
	TaxonNo   int64   `json:"pbdb_taxon_no,omitempty"`
	Rank      *string `json:"rank"`
	AttachIdx int     `json:"attach_idx"`
	// PBDB parent_no hops taken to reach AttachIdx. Zero is a materially
	// different claim from eight and the caption may not flatten them.
	AttachWalk *int64  `json:"attach_walk,omitempty"`
	NOccs      int64   `json:"n_occs"`
	IsExtant   *bool   `json:"is_extant"`
	Difference *string `json:"difference,omitempty"`
	// The drawing of this taxon, when PhyloPic has one under the same name.
	// Never a borrow: a fossil has no clade to inherit a picture from, and
	// something else's portrait beside it would say nothing at all.
	PhylopicID *string `json:"phylopic_id,omitempty"`
	// The two appearance brackets, uncollapsed and in Ma. Null when PBDB
	// records no interval at all, which is ~21% of taxa.
	FEA *float64 `json:"fea"`
	FLA *float64 `json:"fla"`
	LEA *float64 `json:"lea"`
	LLA *float64 `json:"lla"`
	// The young end of that last bracket, read for what it is worth. PBDB's
	// `lla` above is its own number and is never overwritten.
	//
	// LLAIdentified is the youngest last appearance an *identified* member of
	// this taxon reaches. When it is older than LLA, the taxon's own young end
	// rests on material catalogued no finer than the taxon itself — a
	// `Stegosaurus sp.` — and says nothing about where the named animal's
	// record ends. That comparison is exact: PBDB aggregates upward, so a young
	// end below every descendant's cannot come from an identified one.
	//
	// LLADrawn is where the taxon may be *drawn*. It equals LLA except on the
	// 4,819 taxa whose alternative is corroborated enough to act on, and it is
	// the value a graft's position must read. Null on a build predating it.
	LLAIdentified *float64 `json:"lla_identified,omitempty"`
	YoungEndOccs  *int64   `json:"young_end_occs,omitempty"`
	LLADrawn      *float64 `json:"lla_drawn,omitempty"`
	// The other end of the same last-appearance bracket, moved with LLADrawn.
	// `[lea, lla]` is one bracket and both of its ends come from the same
	// occurrences, so a consumer that took LLADrawn and PBDB's own LEA would
	// be assembling a bracket out of two different records — for Stegosaurus,
	// a corrected 143.1 against a 100.5 that is the very occurrence refused.
	LEADrawn *float64 `json:"lea_drawn,omitempty"`

	// Where this row sits in the one ranking that covers both corpora. See
	// {@link Interleave}. Set by /v1/search and nil everywhere else.
	Order *int `json:"order,omitempty"`
}

// maxSegmentFossils caps a drill-down lane. A single node has 12,964 children
// and the fossil corpus is similarly lumpy, so the UI needs a bound and an
// explicit "showing N of M".
const maxSegmentFossils = 200

// notability orders a lane. It is a sum of penalties, smallest first, and it
// exists because ordering on `n_occs` alone put five living wastebasket clades
// at the top of every deep segment.
//
// Measured on Tetrapoda, which has 623 taxa attached: by occurrence count the
// first eight were Tetrapoda itself (211,065 occurrences, `is_extant` true),
// Anthracosauria, Reptiliomorpha, Amphibiosauria, Cotylosauria and three more
// like them, and *Acanthostega gunnari* sat at rank 147. A clade accumulates
// every occurrence of everything inside it, so the *least* specific row always
// wins a count — the ranking was guaranteed to surface the least informative
// thing present. With these penalties the same lane opens on Diplocaulus,
// Diadectes, Diploceraspis and Seymouria.
//
// The three penalties, and why each:
//
//	extant (8)   a living group is not a fossil taxon. PBDB lists Tetrapoda
//	             below Tetrapoda; that is true and useless. Unknown extancy
//	             is 4 — suspected rather than convicted.
//	undrawn (2)  a drawing is the strongest notability signal in the corpus,
//	             because somebody chose to illustrate it, and it is also what
//	             makes the row worth looking at. It outranks specificity so a
//	             drawn family beats an undrawn genus.
//	broad (1)    species and genera are animals a reader can picture; orders
//	             and unranked clades are filing.
//
// `n_occs` still breaks ties and is still a real signal *within* a tier: a
// genus with 400 occurrences is one people have heard of, one with a single
// occurrence is a single paper.
func (s *Store) notability(f *FossilSchema) string {
	terms := []string{}
	if f.IsExtant != "" {
		terms = append(terms, fmt.Sprintf(
			`CASE WHEN t.%q = 1 THEN 8 WHEN t.%q IS NULL THEN 4 ELSE 0 END`,
			f.IsExtant, f.IsExtant))
	}
	if f.ImageTable != "" {
		terms = append(terms, `CASE WHEN img.`+quote(f.ImageID)+` IS NULL THEN 2 ELSE 0 END`)
	}
	if f.Rank != "" {
		terms = append(terms, fmt.Sprintf(
			`CASE WHEN t.%q IN ('species','subspecies','genus','subgenus') THEN 0 ELSE 1 END`,
			f.Rank))
	}
	if len(terms) == 0 {
		return "0"
	}
	return strings.Join(terms, " + ")
}

func quote(s string) string { return fmt.Sprintf("%q", s) }

// fossilRow is the SELECT list and the image LEFT JOIN that every fossil query
// shares, in the order {@link scanFossil} reads them back.
//
// The pair has to travel together, which is why one function returns both: the
// join is what makes the `img` alias in the select list resolve, and a column
// added to one half but not the other is not a compile error — it is a scan
// that silently reads the wrong field into the wrong pointer. There were four
// verbatim copies before this existed.
func fossilRow(f *FossilSchema) (sel, join string) {
	brackets := "NULL, NULL, NULL, NULL"
	if f.Brackets {
		brackets = `t."fea", t."fla", t."lea", t."lla"`
	}
	image := "NULL"
	if f.ImageTable != "" {
		join = fmt.Sprintf(" LEFT JOIN %q img ON img.%q = t.%q",
			f.ImageTable, f.ImageKey, f.AcceptedNo)
		image = "img." + quote(f.ImageID)
	}
	young := "NULL, NULL, NULL, NULL"
	if f.YoungEnd {
		young = `t."lla_identified", t."young_end_occs", t."lla_drawn", t."lea_drawn"`
	}
	cols := []string{
		"t." + quote(f.AttachIdx), "t." + quote(f.Name), "t." + quote(f.NOccs),
		colOrNullT(f.Rank), colOrNullT(f.IsExtant), colOrNullT(f.Difference),
		brackets, image, colOrNullT(f.TaxonNo), colOrNullT(f.AttachWalk), young,
	}
	return strings.Join(cols, ", "), join
}

// scanner is satisfied by both *sql.Rows and *sql.Row, so the single-taxon
// lookup and the list queries can read the same row shape.
type scanner interface{ Scan(dest ...any) error }

// scanFossil reads one row of fossilRow's SELECT list.
func scanFossil(sc scanner) (Fossil, error) {
	var fo Fossil
	var rank, diff, image sql.NullString
	var extant sql.NullInt64
	var fea, fla, lea, lla sql.NullFloat64
	var taxonNo, walk sql.NullInt64
	var identified, drawn, drawnLea sql.NullFloat64
	var endOccs sql.NullInt64
	if err := sc.Scan(&fo.AttachIdx, &fo.Name, &fo.NOccs, &rank, &extant, &diff,
		&fea, &fla, &lea, &lla, &image, &taxonNo, &walk,
		&identified, &endOccs, &drawn, &drawnLea); err != nil {
		return fo, err
	}
	fo.LLAIdentified, fo.LLADrawn = nullF(identified), nullF(drawn)
	fo.LEADrawn = nullF(drawnLea)
	if endOccs.Valid {
		n := endOccs.Int64
		fo.YoungEndOccs = &n
	}
	fo.Rank, fo.Difference = nullStr(rank), nullStr(diff)
	if extant.Valid {
		b := extant.Int64 != 0
		fo.IsExtant = &b
	}
	fo.FEA, fo.FLA, fo.LEA, fo.LLA = nullF(fea), nullF(fla), nullF(lea), nullF(lla)
	fo.PhylopicID = nullStr(image)
	fo.TaxonNo = taxonNo.Int64
	if walk.Valid {
		w := walk.Int64
		fo.AttachWalk = &w
	}
	return fo, nil
}

// Fossils returns the fossil taxa attached anywhere on a segment, most
// notable first — see `notability`, which is where the ordering is decided.
func (s *Store) Fossils(ctx context.Context, attach []int, limit int) (list []Fossil, total int, err error) {
	f := s.Schema.Fossil
	if f == nil || len(attach) == 0 {
		return []Fossil{}, 0, nil
	}
	if limit <= 0 || limit > maxSegmentFossils {
		limit = maxSegmentFossils
	}
	args := make([]any, len(attach))
	for i, v := range attach {
		args[i] = v
	}
	in := placeholders(len(attach))

	// Accepted taxa only where the column exists. PBDB carries a row per
	// taxon_no and synonyms collapse onto one accepted name, so without this
	// the same animal arrives several times and the dedup below silently
	// spends lane rows on it.
	where := fmt.Sprintf("t.%q IN (%s)", f.AttachIdx, in)
	if f.IsPrimary != "" {
		where += fmt.Sprintf(" AND t.%q = 1", f.IsPrimary)
	}

	// Distinct names, because the rows are de-duplicated below. Counting raw
	// rows would make "showing 8 of 10,421" compare two different things.
	countQ := fmt.Sprintf("SELECT count(DISTINCT t.%q) FROM %q t WHERE %s",
		f.Name, f.Table, where)
	if err := s.DB.QueryRowContext(ctx, countQ, args...).Scan(&total); err != nil {
		return nil, 0, err
	}

	sel, join := fossilRow(f)
	q := fmt.Sprintf("SELECT %s FROM %q t%s WHERE %s ORDER BY %s, t.%q DESC, t.%q LIMIT %d",
		sel, f.Table, join, where, s.notability(f), f.NOccs, f.Name, limit)

	rows, err := s.DB.QueryContext(ctx, q, args...)
	if err != nil {
		return nil, 0, err
	}
	defer rows.Close() //nolint:errcheck

	list = []Fossil{}
	seen := map[string]struct{}{}
	for rows.Next() {
		fo, err := scanFossil(rows)
		if err != nil {
			return nil, 0, err
		}
		// PBDB carries a row per taxon_no, and synonyms collapse onto the same
		// accepted name; showing "Lepidosauromorpha" three times in a lane is
		// noise, not information.
		if _, dup := seen[fo.Name]; dup {
			continue
		}
		seen[fo.Name] = struct{}{}
		list = append(list, fo)
	}
	return list, total, rows.Err()
}

// FossilByTaxonNo returns one PBDB taxon by its own key, or nil when there is
// no such row.
//
// This exists for exactly one reason: a graft is view state, so it goes in the
// URL, so a cold load has to be able to rebuild it from an id alone. The
// segment query cannot serve that — it is keyed on the branch, and a shared
// link may arrive with no lane open and no segment to ask about.
//
// Deliberately not filtered by `is_primary`. The segment listing shows accepted
// taxa only, but a link already made against a row is a row the reader saw, and
// silently resolving it to nothing would break the share rather than correct it.
func (s *Store) FossilByTaxonNo(ctx context.Context, taxonNo int64) (*Fossil, error) {
	f := s.Schema.Fossil
	if f == nil || f.TaxonNo == "" {
		return nil, nil
	}
	sel, join := fossilRow(f)
	q := fmt.Sprintf("SELECT %s FROM %q t%s WHERE t.%q = ?", sel, f.Table, join, f.TaxonNo)

	fo, err := scanFossil(s.DB.QueryRowContext(ctx, q, taxonNo))
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &fo, nil
}

// maxFossilSearch caps a palette query.
//
// It used to be 8, and the small number was doing a job that no longer exists:
// fossils were pinned to a section at the tail of the list, so a long tail of
// near-matches would push the species a reader actually asked for off the
// bottom. They are now ranked against nodes by the same band, so a fossil is
// only high in the list when it is a better answer than the nodes above it —
// and the number that has to be generous is the *candidate* count, or a taxon
// that would have led the page is cut before the merge ever sees it.
const maxFossilSearch = 24

// notInTree refuses a PBDB taxon that is itself a node in the synthesis tree.
//
// This is the line the whole search rests on, so it is drawn once here rather
// than restated at each call site. `attach_walk` is how many PBDB `parent_no`
// hops phase 3 took to reach a node; zero means it took none, which means this
// taxon *is* that node. 32,386 accepted PBDB taxa are in that position —
// *Tyrannosaurus*, *Tyrannosaurus rex* and *Stegosaurus* among them — and
// before this they arrived twice on one query, once as something that joins the
// tree and once as something that hangs off it, with nothing on either row
// saying why the same animal was being offered two different futures.
//
// The node wins that duplicate every time, and not on a preference: phase 4
// already writes the taxon's PBDB bracket onto the node as its `occurrence`
// row, so the node row carries the fossil's dates *and* an ancestry, *and* the
// ability to induce an MRCA. There is nothing the graft was adding.
//
// So the exclusion is what makes the corpus mean something a reader can hold:
// **a fossil row is a taxon the tree does not contain.** Not "a taxon that is
// extinct" — the tree is full of extinct taxa — and not "a taxon in PBDB",
// which is 93,686 living things. Cost: 8.9% of the accepted corpus, all of it
// reachable by the same name through `/v1/search`'s node path.
//
// Name equality is deliberately *not* also required. 1,320 of these rows differ
// from their node's name — PBDB's `Animalia` against OTT's `Metazoa`,
// `Haplorhini` against `Haplorrhini` — and those are the same taxon spelled
// twice, which is precisely the case a graft has nothing to add to. OTT carries
// the alternatives as synonyms, so the node path answers them.
func notInTree(f *FossilSchema) string {
	if f.AttachWalk == "" {
		// A build predating the column cannot tell the two apart. Serving the
		// whole corpus is the old behaviour and the honest degradation; the
		// duplicate is visible and a silently empty list is not.
		return ""
	}
	return fmt.Sprintf("t.%q <> 0", f.AttachWalk)
}

// SearchFossils finds PBDB taxa the tree does not contain, best match first.
//
// # Candidate generation, and why there are two of them
//
// Where `fossil_fts` exists the name is matched through it; otherwise the
// query falls back to `LIKE '%q%'`, which is a full scan of the 523,112-row
// table because `fossil` is keyed on `(attach_idx, n_occs DESC)` for the
// segment query and has no index on `name`.
//
// That scan used to be the only path, on the reasoning that ~40 ms sits inside
// the palette's 110 ms debounce. The reasoning was sound and the number was
// wrong. Measured through the serving binary it is **100–117 ms**, flat against
// match count — `zzzqqq`, which matches nothing, costs 100 ms — and it was
// roughly 90% of `/v1/search`. The deployed container is a `standard-1`
// instance with **half a vCPU**, several times slower than the laptop those
// figures come from, which is why search felt fine in development and slow in
// production. Through the index the same queries cost 0.1–15 ms, the worst case
// being a two-character prefix, which is the shortest the palette sends.
//
// The two paths do not return quite the same rows, and the difference is
// deliberate. FTS5 matches whole tokens and token prefixes; `LIKE '%q%'` also
// matched inside a word, so "rex" reached *Aulacorexia* along with 525 others.
// The index returns **no row the scan would not** — a pipeline gate asserts
// that — and the rows it drops are exactly the ones {@link matchBand} scores
// `bandNone`, its worst band, which {@link Interleave} then ranks behind every
// node. They could not reach a 24-row page from either path.
//
// # Ranking
//
// SQL orders by a coarse match tier and then `notability` — the same
// extinct/drawn/specific/count ranking a drill-down lane uses. That tier is
// candidate *generation*, not the answer: the rows are re-banded in Go by
// {@link matchBand}, the same function that ranks nodes, because the two lists
// are about to be merged into one and a corpus ranked by its own private scale
// cannot be interleaved with another. `notability` survives as the order
// *within* a band, which is what it was always measuring.
func (s *Store) SearchFossils(ctx context.Context, q string, limit int) ([]Fossil, error) {
	f := s.Schema.Fossil
	if f == nil || f.TaxonNo == "" {
		return []Fossil{}, nil
	}
	q = strings.TrimSpace(q)
	if len(q) < 2 {
		return []Fossil{}, nil
	}
	if limit <= 0 || limit > maxFossilSearch {
		limit = maxFossilSearch
	}
	lower := strings.ToLower(q)
	// LIKE's own wildcards have to be neutralised or a query containing `%`
	// matches the whole corpus.
	esc := strings.NewReplacer("\\", "\\\\", "%", "\\%", "_", "\\_").Replace(lower)

	sel, join := fossilRow(f)
	// No `lower()` around the column. SQLite's LIKE is already case-insensitive
	// over ASCII, nothing here sets `case_sensitive_like`, and the fossil corpus
	// contains **zero** non-ASCII names — so the two are exactly equivalent, and
	// the wrapper was a function call and a string allocation on every one of
	// 523,112 rows. Dropping it takes the fallback scan from 113.7 ms to 79.6 ms.
	// The exact tier keeps its case-insensitivity explicitly, through the
	// collation rather than through a per-row rewrite of the data.
	name := "t." + quote(f.Name)
	tier := fmt.Sprintf(
		"CASE WHEN %s = ? COLLATE NOCASE THEN 0 WHEN %s LIKE ? ESCAPE '\\' THEN 1 ELSE 2 END",
		name, name)

	var where string
	// Bound in the order the placeholders appear in the *text*, which puts the
	// WHERE's argument before ORDER BY's two. Binding them in the order the
	// clauses were written instead sent the bare query to the WHERE, so only an
	// exact name ever matched: "tyrannosaurus" found *Tyrannosaurus* and
	// "georgicus" found nothing at all.
	var args []any
	if expr := ftsPrefixQuery(q); f.FTSTable != "" && expr != "" {
		where = fmt.Sprintf("t.%q IN (SELECT rowid FROM %q WHERE %q MATCH ?)",
			f.TaxonNo, f.FTSTable, f.FTSTable)
		args = append(args, expr)
	} else {
		where = fmt.Sprintf("%s LIKE ? ESCAPE '\\'", name)
		args = append(args, "%"+esc+"%")
	}
	args = append(args, lower, esc+"%")

	if f.IsPrimary != "" {
		where += fmt.Sprintf(" AND t.%q = 1", f.IsPrimary)
	}
	if nit := notInTree(f); nit != "" {
		where += " AND " + nit
	}
	q2 := fmt.Sprintf(
		"SELECT %s FROM %q t%s WHERE %s ORDER BY %s, %s, t.%q DESC, length(t.%q) LIMIT %d",
		sel, f.Table, join, where, tier, s.notability(f),
		f.NOccs, f.Name, limit*4)

	rows, err := s.DB.QueryContext(ctx, q2, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close() //nolint:errcheck

	list := []Fossil{}
	seen := map[string]struct{}{}
	for rows.Next() {
		fo, err := scanFossil(rows)
		if err != nil {
			return nil, err
		}
		// PBDB carries a row per taxon_no and synonyms collapse onto one
		// accepted name; the same animal three times is noise in a list this
		// short. Over-fetching by 4x above is what leaves room for the dedup.
		if _, dup := seen[fo.Name]; dup {
			continue
		}
		seen[fo.Name] = struct{}{}
		list = append(list, fo)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}

	// Re-band, and truncate *after* rather than before. The SQL tier cannot see
	// head position or a plural, so it files "swallowtail" and "oak moss" the
	// same way `matchBand` was written to separate — and truncating on the
	// coarse order would drop the row the fine one was going to promote.
	// Stable, so `notability` still decides inside a band.
	qFold := strings.ToLower(q)
	sort.SliceStable(list, func(i, j int) bool {
		return matchBand(list[i].Name, qFold) < matchBand(list[j].Name, qFold)
	})
	if len(list) > limit {
		list = list[:limit]
	}
	return list, nil
}

// colOrNullT is colOrNull for a column on the aliased fossil table.
func colOrNullT(c string) string {
	if c == "" {
		return "NULL"
	}
	return "t." + quote(c)
}

func nullF(v sql.NullFloat64) *float64 {
	if !v.Valid {
		return nil
	}
	f := v.Float64
	return &f
}
