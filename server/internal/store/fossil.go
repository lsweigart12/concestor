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
	Brackets   bool   `json:"brackets"`
	MethodName string `json:"attach_method_table,omitempty"`
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
	}
	f.Brackets = s.col(t, "fea") != "" && s.col(t, "fla") != "" &&
		s.col(t, "lea") != "" && s.col(t, "lla") != ""
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

// Fossils returns the fossil taxa attached anywhere on a segment, most
// notable first. n_occs is a real signal: a genus with 400 occurrences is one
// people have heard of; a genus with 1 is a single paper.
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

	// Distinct names, because the rows are de-duplicated below: PBDB carries a
	// row per taxon_no and synonyms collapse onto one accepted name. Counting
	// raw rows would make "showing 75 of 10,421" compare two different things.
	countQ := fmt.Sprintf("SELECT count(DISTINCT %q) FROM %q WHERE %q IN (%s)",
		f.Name, f.Table, f.AttachIdx, in)
	if err := s.DB.QueryRowContext(ctx, countQ, args...).Scan(&total); err != nil {
		return nil, 0, err
	}

	brackets := "NULL, NULL, NULL, NULL"
	if f.Brackets {
		brackets = `"fea", "fla", "lea", "lla"`
	}
	sel := []string{
		fmt.Sprintf("%q", f.AttachIdx), fmt.Sprintf("%q", f.Name), fmt.Sprintf("%q", f.NOccs),
		colOrNull(f.Rank), colOrNull(f.IsExtant), colOrNull(f.Difference), brackets,
	}
	q := fmt.Sprintf("SELECT %s FROM %q WHERE %q IN (%s) ORDER BY %q DESC, %q LIMIT %d",
		strings.Join(sel, ", "), f.Table, f.AttachIdx, in, f.NOccs, f.Name, limit)

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
		if err := rows.Scan(&fo.AttachIdx, &fo.Name, &fo.NOccs, &rank, &extant, &diff,
			&fea, &fla, &lea, &lla); err != nil {
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
		list = append(list, fo)
	}
	return list, total, rows.Err()
}

func nullF(v sql.NullFloat64) *float64 {
	if !v.Valid {
		return nil
	}
	f := v.Float64
	return &f
}
