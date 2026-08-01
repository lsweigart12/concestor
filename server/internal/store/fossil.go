package store

import (
	"context"
	"database/sql"
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
	Name       string  `json:"name"`
	Rank       *string `json:"rank"`
	AttachIdx  int     `json:"attach_idx"`
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
//   extant (8)   a living group is not a fossil taxon. PBDB lists Tetrapoda
//                below Tetrapoda; that is true and useless. Unknown extancy
//                is 4 — suspected rather than convicted.
//   undrawn (2)  a drawing is the strongest notability signal in the corpus,
//                because somebody chose to illustrate it, and it is also what
//                makes the row worth looking at. It outranks specificity so a
//                drawn family beats an undrawn genus.
//   broad (1)    species and genera are animals a reader can picture; orders
//                and unranked clades are filing.
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
		brackets, image,
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
		if err := rows.Scan(&fo.AttachIdx, &fo.Name, &fo.NOccs, &rank, &extant, &diff,
			&fea, &fla, &lea, &lla, &image); err != nil {
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
		list = append(list, fo)
	}
	return list, total, rows.Err()
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
