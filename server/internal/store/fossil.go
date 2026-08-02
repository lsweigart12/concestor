package store

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
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
	MethodName string `json:"attach_method_table,omitempty"`
	// ImageTable maps a PBDB taxon to a drawing. A fossil is not a node, so
	// node_image cannot reach it and this is the only join that can.
	ImageTable string `json:"image_table,omitempty"`
	ImageKey   string `json:"image_key,omitempty"`
	ImageID    string `json:"image_id,omitempty"`
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

	brackets := "NULL, NULL, NULL, NULL"
	if f.Brackets {
		brackets = `t."fea", t."fla", t."lea", t."lla"`
	}
	join, image := "", "NULL"
	if f.ImageTable != "" {
		join = fmt.Sprintf(" LEFT JOIN %q img ON img.%q = t.%q",
			f.ImageTable, f.ImageKey, f.AcceptedNo)
		image = "img." + quote(f.ImageID)
	}
	sel := []string{
		"t." + quote(f.AttachIdx), "t." + quote(f.Name), "t." + quote(f.NOccs),
		colOrNullT(f.Rank), colOrNullT(f.IsExtant), colOrNullT(f.Difference),
		brackets, image, colOrNullT(f.TaxonNo), colOrNullT(f.AttachWalk),
	}
	q := fmt.Sprintf("SELECT %s FROM %q t%s WHERE %s ORDER BY %s, t.%q DESC, t.%q LIMIT %d",
		strings.Join(sel, ", "), f.Table, join, where, s.notability(f),
		f.NOccs, f.Name, limit)

	rows, err := s.DB.QueryContext(ctx, q, args...)
	if err != nil {
		return nil, 0, err
	}
	defer rows.Close() //nolint:errcheck

	list = []Fossil{}
	seen := map[string]struct{}{}
	for rows.Next() {
		var fo Fossil
		var rank, diff sql.NullString
		var extant sql.NullInt64
		var fea, fla, lea, lla sql.NullFloat64
		var image sql.NullString
		var taxonNo, walk sql.NullInt64
		if err := rows.Scan(&fo.AttachIdx, &fo.Name, &fo.NOccs, &rank, &extant, &diff,
			&fea, &fla, &lea, &lla, &image, &taxonNo, &walk); err != nil {
			return nil, 0, err
		}
		// PBDB carries a row per taxon_no, and synonyms collapse onto the same
		// accepted name; showing "Lepidosauromorpha" three times in a lane is
		// noise, not information.
		if _, dup := seen[fo.Name]; dup {
			continue
		}
		seen[fo.Name] = struct{}{}
		fo.Rank = nullStr(rank)
		fo.Difference = nullStr(diff)
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
	brackets := "NULL, NULL, NULL, NULL"
	if f.Brackets {
		brackets = `t."fea", t."fla", t."lea", t."lla"`
	}
	join, image := "", "NULL"
	if f.ImageTable != "" {
		join = fmt.Sprintf(" LEFT JOIN %q img ON img.%q = t.%q",
			f.ImageTable, f.ImageKey, f.AcceptedNo)
		image = "img." + quote(f.ImageID)
	}
	sel := []string{
		"t." + quote(f.AttachIdx), "t." + quote(f.Name), "t." + quote(f.NOccs),
		colOrNullT(f.Rank), colOrNullT(f.IsExtant), colOrNullT(f.Difference),
		brackets, image, colOrNullT(f.TaxonNo), colOrNullT(f.AttachWalk),
	}
	q := fmt.Sprintf("SELECT %s FROM %q t%s WHERE t.%q = ?",
		strings.Join(sel, ", "), f.Table, join, f.TaxonNo)

	var fo Fossil
	var rank, diff sql.NullString
	var extant sql.NullInt64
	var fea, fla, lea, lla sql.NullFloat64
	var img sql.NullString
	var no, walk sql.NullInt64
	err := s.DB.QueryRowContext(ctx, q, taxonNo).Scan(
		&fo.AttachIdx, &fo.Name, &fo.NOccs, &rank, &extant, &diff,
		&fea, &fla, &lea, &lla, &img, &no, &walk)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	fo.Rank, fo.Difference = nullStr(rank), nullStr(diff)
	if extant.Valid {
		b := extant.Int64 != 0
		fo.IsExtant = &b
	}
	fo.FEA, fo.FLA, fo.LEA, fo.LLA = nullF(fea), nullF(fla), nullF(lea), nullF(lla)
	fo.PhylopicID = nullStr(img)
	fo.TaxonNo = no.Int64
	if walk.Valid {
		w := walk.Int64
		fo.AttachWalk = &w
	}
	return &fo, nil
}

// maxFossilSearch caps a palette query. Deliberately small: fossils are the
// *secondary* section and a long tail of near-matches would push the species
// a reader actually asked for off the bottom of the list.
const maxFossilSearch = 8

// SearchFossils finds PBDB taxa by name, best match first.
//
// A full scan of the 523,112-row table, and that is the measured right answer
// rather than a concession: there is no index on `name` — the fossil table is
// keyed on `(attach_idx, n_occs DESC)` for the segment query — and a prefix
// scan comes back in ~40ms, comfortably inside the palette's 110ms debounce.
// Building an in-memory prefix index at startup would cost ~15MB and a slower
// boot to save something nobody can perceive.
//
// The ordering is match quality first, then `notability` — exact name, then
// prefix, then contains, and inside each the same extinct/drawn/specific/count
// ranking a drill-down lane uses. Without the match tier, "homo" returns
// whatever the most-recorded substring match happens to be; with it, *Homo*
// comes first.
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

	brackets := "NULL, NULL, NULL, NULL"
	if f.Brackets {
		brackets = `t."fea", t."fla", t."lea", t."lla"`
	}
	join, image := "", "NULL"
	if f.ImageTable != "" {
		join = fmt.Sprintf(" LEFT JOIN %q img ON img.%q = t.%q",
			f.ImageTable, f.ImageKey, f.AcceptedNo)
		image = "img." + quote(f.ImageID)
	}
	sel := []string{
		"t." + quote(f.AttachIdx), "t." + quote(f.Name), "t." + quote(f.NOccs),
		colOrNullT(f.Rank), colOrNullT(f.IsExtant), colOrNullT(f.Difference),
		brackets, image, colOrNullT(f.TaxonNo), colOrNullT(f.AttachWalk),
	}
	name := "lower(t." + quote(f.Name) + ")"
	tier := fmt.Sprintf(
		"CASE WHEN %s = ? THEN 0 WHEN %s LIKE ? ESCAPE '\\' THEN 1 ELSE 2 END",
		name, name)
	where := fmt.Sprintf("%s LIKE ? ESCAPE '\\'", name)
	if f.IsPrimary != "" {
		where += fmt.Sprintf(" AND t.%q = 1", f.IsPrimary)
	}
	q2 := fmt.Sprintf(
		"SELECT %s FROM %q t%s WHERE %s ORDER BY %s, %s, t.%q DESC, length(t.%q) LIMIT %d",
		strings.Join(sel, ", "), f.Table, join, where, tier, s.notability(f),
		f.NOccs, f.Name, limit*4)

	// Bound in the order the placeholders appear in the *text*, which puts
	// WHERE's substring pattern before ORDER BY's two. Binding them in the
	// order the clauses were written above instead sent the bare query to the
	// WHERE, so only an exact name ever matched: "tyrannosaurus" found
	// *Tyrannosaurus* and "georgicus" found nothing at all.
	rows, err := s.DB.QueryContext(ctx, q2, "%"+esc+"%", lower, esc+"%")
	if err != nil {
		return nil, err
	}
	defer rows.Close() //nolint:errcheck

	list := []Fossil{}
	seen := map[string]struct{}{}
	for rows.Next() {
		var fo Fossil
		var rank, diff, img sql.NullString
		var extant sql.NullInt64
		var fea, fla, lea, lla sql.NullFloat64
		var no, walk sql.NullInt64
		if err := rows.Scan(&fo.AttachIdx, &fo.Name, &fo.NOccs, &rank, &extant, &diff,
			&fea, &fla, &lea, &lla, &img, &no, &walk); err != nil {
			return nil, err
		}
		// PBDB carries a row per taxon_no and synonyms collapse onto one
		// accepted name; the same animal three times is noise in a list this
		// short. Over-fetching by 4x above is what leaves room for the dedup.
		if _, dup := seen[fo.Name]; dup {
			continue
		}
		seen[fo.Name] = struct{}{}
		fo.Rank, fo.Difference = nullStr(rank), nullStr(diff)
		if extant.Valid {
			b := extant.Int64 != 0
			fo.IsExtant = &b
		}
		fo.FEA, fo.FLA, fo.LEA, fo.LLA = nullF(fea), nullF(fla), nullF(lea), nullF(lla)
		fo.PhylopicID = nullStr(img)
		fo.TaxonNo = no.Int64
		if walk.Valid {
			w := walk.Int64
			fo.AttachWalk = &w
		}
		list = append(list, fo)
		if len(list) >= limit {
			break
		}
	}
	return list, rows.Err()
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
