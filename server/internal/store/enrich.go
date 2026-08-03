package store

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
)

// ImageRef is the silhouette shown for a node. SourceIdx names the node the
// image is actually *of* — the closest drawn relative, which is usually neither
// an ancestor nor a descendant but a cousin. CladeIdx is the smallest clade
// containing both the node and the drawing, so its tip_count is the size of the
// claim the picture makes: 3,153 tips at the median. That number is what decides
// whether drawing the image would misinform, and Climb is hops up to the clade,
// not to the source — climb 0 does not imply an exact match.
type ImageRef struct {
	PhylopicID string
	SourceIdx  *int
	CladeIdx   *int
	Climb      *int
	Method     string
}

// Images resolves silhouettes for a batch of node indices. Returns an empty
// map when no node_image table exists yet.
func (s *Store) Images(ctx context.Context, idxs []int) (map[int]ImageRef, error) {
	out := map[int]ImageRef{}
	ni := s.Schema.NodeImage
	if ni == nil || len(idxs) == 0 {
		return out, nil
	}
	src, clade := colOrNull(ni.SourceIdx), colOrNull(ni.CladeIdx)
	climb, method := colOrNull(ni.Climb), colOrNull(ni.Method)
	for start := 0; start < len(idxs); start += metaChunk {
		end := min(start+metaChunk, len(idxs))
		chunk := idxs[start:end]
		q := fmt.Sprintf("SELECT %q, %q, %s, %s, %s, %s FROM %q WHERE %q IN (%s)",
			ni.Idx, ni.ID, src, clade, climb, method, ni.Table, ni.Idx, placeholders(len(chunk)))
		args := make([]any, len(chunk))
		for i, v := range chunk {
			args[i] = v
		}
		rows, err := s.DB.QueryContext(ctx, q, args...)
		if err != nil {
			return out, err
		}
		for rows.Next() {
			var idx int
			var id, meth sql.NullString
			var source, cladeVal, climbVal sql.NullInt64
			if err := rows.Scan(&idx, &id, &source, &cladeVal, &climbVal, &meth); err != nil {
				_ = rows.Close()
				return out, err
			}
			if !id.Valid || id.String == "" {
				continue
			}
			ref := ImageRef{PhylopicID: id.String, Method: meth.String}
			if source.Valid {
				v := int(source.Int64)
				ref.SourceIdx = &v
			}
			// -1 is the pipeline's "unresolved", and a negative index would
			// address nothing; leave it nil rather than pass it on.
			if cladeVal.Valid && cladeVal.Int64 >= 0 {
				v := int(cladeVal.Int64)
				ref.CladeIdx = &v
			}
			if climbVal.Valid {
				v := int(climbVal.Int64)
				ref.Climb = &v
			}
			out[idx] = ref
		}
		err = rows.Err()
		_ = rows.Close()
		if err != nil {
			return out, err
		}
	}
	return out, nil
}

// WitnessRef is the second silhouette a divergence may carry: a fossil taxon
// from below the fork whose stratigraphic bracket puts it at that divergence.
//
// It is **not a node**, which is the difference from ImageRef and from what
// this type used to be. A witness names a `fossil.pbdb_taxon_no`, and the
// claim it makes is correspondingly weaker: not *this taxon is inside the
// group* but *this taxon belongs somewhere below this fork* (architecture
// §3.4). AttachIdx is the deepest node it is known to sit below and AttachWalk
// is how many PBDB `parent_no` hops it took to get there — zero means PBDB's
// own taxon is in the synthesis tree, eleven means the placement is a statement
// about a family. A caller must not present the two alike.
//
// Name, Oldest and Youngest travel with the row rather than being joined for.
// The dates are the entire difference between a witness and an unlabelled
// shape, so there is no way to read the picture without them.
//
// SourceIdx is set only by a build predating the rename, where the witness was
// a node index and the fossil fields are empty.
type WitnessRef struct {
	PhylopicID  string
	PbdbTaxonNo int
	Name        string
	Rank        *string
	AttachIdx   int
	AttachWalk  int
	Oldest      *float64 // fea
	Youngest    *float64 // lla
	GapMa       *float64

	SourceIdx *int
}

// Witnesses resolves divergence silhouettes for a batch of node indices.
// Returns an empty map against a build with no witness table, which is the
// normal state for anything built before phase 5a grew one.
func (s *Store) Witnesses(ctx context.Context, idxs []int) (map[int]WitnessRef, error) {
	out := map[int]WitnessRef{}
	w := s.Schema.Witness
	if w == nil || len(idxs) == 0 {
		return out, nil
	}
	// Two shapes, one query. The fossil form names a PBDB taxon and carries its
	// own name and bracket; the pre-rename form names a node and carries
	// neither, and the caller looks those up as it always did.
	var sel string
	if w.Fossil() {
		sel = fmt.Sprintf("%q, %s, %q, %q, %q, %q, %q",
			w.PbdbTaxonNo, colOrNull(w.TaxonRank), w.TaxonName,
			w.AttachIdx, w.AttachWalk, w.Fea, w.Lla)
	} else {
		sel = fmt.Sprintf("%q, NULL, NULL, NULL, NULL, NULL, NULL", w.SourceIdx)
	}
	for start := 0; start < len(idxs); start += metaChunk {
		end := min(start+metaChunk, len(idxs))
		chunk := idxs[start:end]
		q := fmt.Sprintf("SELECT %q, %q, %s, %s FROM %q WHERE %q IN (%s)",
			w.Idx, w.ID, sel, colOrNull(w.GapMa), w.Table, w.Idx,
			placeholders(len(chunk)))
		args := make([]any, len(chunk))
		for i, v := range chunk {
			args[i] = v
		}
		rows, err := s.DB.QueryContext(ctx, q, args...)
		if err != nil {
			return out, err
		}
		for rows.Next() {
			var idx int
			var id, name, rank sql.NullString
			var key, attach, walk sql.NullInt64
			var fea, lla, gap sql.NullFloat64
			if err := rows.Scan(&idx, &id, &key, &rank, &name, &attach, &walk,
				&fea, &lla, &gap); err != nil {
				_ = rows.Close()
				return out, err
			}
			// Both are load-bearing: the picture is meaningless without the
			// taxon it is of, since naming that taxon and its dates is the
			// only thing distinguishing a witness from an ordinary borrow.
			if !id.Valid || id.String == "" || !key.Valid || key.Int64 < 0 {
				continue
			}
			ref := WitnessRef{PhylopicID: id.String, Rank: nullStr(rank)}
			if gap.Valid {
				v := gap.Float64
				ref.GapMa = &v
			}
			if !w.Fossil() {
				v := int(key.Int64)
				ref.SourceIdx = &v
				out[idx] = ref
				continue
			}
			// A fossil witness with no name or no bracket is refused outright
			// rather than sent on for the client to refuse: an unlabelled
			// silhouette at a fork is the thing this whole layer replaced.
			if !name.Valid || name.String == "" || !fea.Valid || !lla.Valid {
				continue
			}
			ref.PbdbTaxonNo = int(key.Int64)
			ref.Name = name.String
			ref.AttachIdx = int(attach.Int64)
			ref.AttachWalk = int(walk.Int64)
			ref.Oldest, ref.Youngest = nullF(fea), nullF(lla)
			out[idx] = ref
		}
		err = rows.Err()
		_ = rows.Close()
		if err != nil {
			return out, err
		}
	}
	return out, nil
}

// SVGPath returns the mirrored SVG for a PhyloPic id, absolute, or "" when the
// image has not been fetched yet. The mirror is being populated in the
// background, so "known but not on disk" is a normal state.
func (s *Store) SVGPath(ctx context.Context, id string) string {
	if s.SilhouetteDir == "" || id == "" {
		return ""
	}
	if sl := s.Schema.Silhouette; sl != nil && sl.SVGPath != "" {
		var rel sql.NullString
		q := fmt.Sprintf("SELECT %q FROM %q WHERE %q = ?", sl.SVGPath, sl.Table, sl.ID)
		if err := s.DB.QueryRowContext(ctx, q, id).Scan(&rel); err == nil && rel.Valid && rel.String != "" {
			p := filepath.Join(s.SilhouetteDir, filepath.Clean("/"+rel.String))
			if withinDir(s.SilhouetteDir, p) && fileExists(p) {
				return p
			}
		}
	}
	// Fall back to the mirror's own sharded convention, then a flat layout.
	if len(id) >= 2 {
		if p := filepath.Join(s.SilhouetteDir, "svg", id[:2], id+".svg"); fileExists(p) {
			return p
		}
	}
	if p := filepath.Join(s.SilhouetteDir, id+".svg"); fileExists(p) {
		return p
	}
	return ""
}

func fileExists(p string) bool {
	st, err := os.Stat(p)
	return err == nil && !st.IsDir()
}

func withinDir(dir, p string) bool {
	rel, err := filepath.Rel(dir, p)
	return err == nil && rel != ".." && !strings.HasPrefix(rel, ".."+string(filepath.Separator))
}

// Vernacular is one common name for a node.
type Vernacular struct {
	Name      string  `json:"name"`
	Lang      *string `json:"lang,omitempty"`
	Preferred bool    `json:"preferred,omitempty"`
}

// Vernaculars returns every common name for one node, most used first.
//
// The order is the pipeline's and this does not recompute it. `usage_rank` is
// measured against English Wikipedia's title and redirect graph — the name that
// is the taxon's article title, then the names that reach it, then the ones it
// is merely filed under — and the client is told not to re-sort it either. A
// consumer that re-ranks a ranking silently overrides evidence it does not
// have; that already cost this project once on /v1/search, where a fuzzy score
// in the browser outweighed four server ranks.
//
// Without the column — a build older than the `names` phase — this falls back
// to the boolean, which puts the headline first and says nothing about the
// rest. That is worse but not wrong, and it is why the column is optional.
func (s *Store) Vernaculars(ctx context.Context, idx int) ([]Vernacular, error) {
	out := []Vernacular{}
	v := s.Schema.Vernacular
	if v == nil {
		return out, nil
	}
	lang, pref := "NULL", "0"
	if v.Lang != "" {
		lang = fmt.Sprintf("%q", v.Lang)
	}
	if v.Preferred != "" {
		pref = fmt.Sprintf("%q", v.Preferred)
	}
	// NULLs last: an unranked row is one the pipeline never reached, and it
	// belongs below every row it did. SQLite sorts NULL first by default.
	order := ""
	if v.Rank != "" {
		order = fmt.Sprintf(" ORDER BY %q IS NULL, %q", v.Rank, v.Rank)
	}
	q := fmt.Sprintf("SELECT %q, %s, %s FROM %q WHERE %q = ?%s",
		v.Name, lang, pref, v.Table, v.Idx, order)
	rows, err := s.DB.QueryContext(ctx, q, idx)
	if err != nil {
		return out, err
	}
	defer rows.Close() //nolint:errcheck
	for rows.Next() {
		var name sql.NullString
		var lg sql.NullString
		var pf sql.NullInt64
		if err := rows.Scan(&name, &lg, &pf); err != nil {
			return out, err
		}
		if !name.Valid {
			continue
		}
		e := Vernacular{Name: name.String, Preferred: pf.Valid && pf.Int64 != 0}
		if lg.Valid {
			s := lg.String
			e.Lang = &s
		}
		out = append(out, e)
	}
	// Only where the pipeline gave no order at all. With `usage_rank` the SQL
	// has already sorted, and re-sorting on the boolean would flatten every
	// distinction below rank 1 back into a coin toss.
	if v.Rank == "" {
		sort.SliceStable(out, func(i, j int) bool { return out[i].Preferred && !out[j].Preferred })
	}
	return out, rows.Err()
}

// WikidataQID returns the Wikidata item this node is, or "" if none is known.
//
// It is read off the vernacular crawl because that is where it was gathered,
// and it is worth more than the names it arrived with: it is a *stable
// identifier for the taxon*, so a link built from it lands on an article about
// this node rather than on a search for its name. The difference matters
// exactly where a reader is most likely to be misled — *Ivesia* is both an
// Ediacaran rangeomorph and a rose-family plant, and a name-shaped link cannot
// tell them apart.
//
// The claim it carries is only as strong as the crawl's own check, and that
// check is the strongest one available: phase 6 refuses any item whose own
// `wdt:P225` names a different taxon from OTT's. Items carrying no P225 at all
// are kept, there and here, because absent evidence of a bad claim is not
// evidence of one — and re-testing that at request time would query the same
// missing triple and learn nothing.
//
// Rows are ordered so a node claimed by more than one item (six of 108,293)
// answers the same way on every request rather than at the whim of the query
// planner.
func (s *Store) WikidataQID(ctx context.Context, idx int) (string, error) {
	v := s.Schema.Vernacular
	if v == nil || v.SourceID == "" {
		return "", nil
	}
	// A source column is not required — a table carrying only Wikidata rows
	// needs no filter — but where it exists it is what keeps PBDB's `txn:N`
	// identifiers out. The `Q%` test does that unaided, and both run.
	src := "1=1"
	if v.Source != "" {
		src = fmt.Sprintf("%q LIKE 'wikidata%%'", v.Source)
	}
	q := fmt.Sprintf(
		"SELECT %q FROM %q WHERE %q = ? AND %s AND %q LIKE 'Q%%' ORDER BY %q LIMIT 1",
		v.SourceID, v.Table, v.Idx, src, v.SourceID, v.SourceID)
	var qid sql.NullString
	err := s.DB.QueryRowContext(ctx, q, idx).Scan(&qid)
	if errors.Is(err, sql.ErrNoRows) {
		return "", nil
	}
	if err != nil {
		return "", err
	}
	if !qid.Valid {
		return "", nil
	}
	return qid.String, nil
}

// BestVernaculars returns one common name per node for a batch — the name a
// search row is captioned with, and the name a scientific/common switcher on
// the canvas would draw.
//
// The best name is the lowest `usage_rank`, which is the same answer
// Vernaculars puts first, computed the same way. Where the column is absent it
// falls back to the boolean and then to the first row seen; a caller cannot
// tell which happened, and does not need to.
func (s *Store) BestVernaculars(ctx context.Context, idxs []int) (map[int]string, error) {
	out := map[int]string{}
	v := s.Schema.Vernacular
	if v == nil || len(idxs) == 0 {
		return out, nil
	}
	pref := "0"
	if v.Preferred != "" {
		pref = fmt.Sprintf("%q", v.Preferred)
	}
	rank := "NULL"
	if v.Rank != "" {
		rank = fmt.Sprintf("%q", v.Rank)
	}
	q := fmt.Sprintf("SELECT %q, %q, %s, %s FROM %q WHERE %q IN (%s)",
		v.Idx, v.Name, pref, rank, v.Table, v.Idx, placeholders(len(idxs)))
	args := make([]any, len(idxs))
	for i, x := range idxs {
		args[i] = x
	}
	rows, err := s.DB.QueryContext(ctx, q, args...)
	if err != nil {
		return out, err
	}
	defer rows.Close() //nolint:errcheck
	// Per node, the best evidence seen so far: a finite rank beats any
	// unranked row, a lower rank beats a higher one, and the boolean only
	// decides between rows that carry no rank at all.
	bestRank := map[int]int64{}
	bestPref := map[int]bool{}
	for rows.Next() {
		var idxVal sql.NullInt64
		var name sql.NullString
		var pf sql.NullInt64
		var rk sql.NullInt64
		if err := rows.Scan(&idxVal, &name, &pf, &rk); err != nil {
			return out, err
		}
		if !name.Valid || !idxVal.Valid {
			continue
		}
		idx := int(idxVal.Int64)
		isPref := pf.Valid && pf.Int64 != 0
		_, seen := out[idx]
		if seen && !betterVernacular(rk, isPref, bestRank[idx], bestPref[idx]) {
			continue
		}
		out[idx] = name.String
		bestPref[idx] = isPref
		if rk.Valid {
			bestRank[idx] = rk.Int64
		} else {
			bestRank[idx] = 0 // 0 is not a rank; ranks are 1-based.
		}
	}
	return out, rows.Err()
}

// HeadlineVernaculars returns, per node, the name ranked first by use — and
// nothing at all where no name was ranked.
//
// It is the canvas's question rather than the card's, and the difference is the
// missing fallback. BestVernaculars degrades to `is_primary` and then to
// whatever row the planner yielded first, which is right for a caption sitting
// beside the scientific name it is captioning: some name is better than none
// there, because the reader can see what it belongs to. On the canvas the
// common name *replaces* the scientific one, so an unranked guess is not a
// weaker answer but a different taxon's word in the only slot that says which
// taxon this is. Where the ranking has nothing to say, the canvas draws the
// scientific name, which is never wrong.
//
// A build predating the `names` phase therefore returns an empty map and every
// label stays scientific. That is the intended degradation and not an outage:
// `docs/name-ranking.md` §3 is what makes rank 1 mean "the name English
// Wikipedia's own title and redirect graph puts first", and without that column
// there is no such claim to make.
//
// Restricting *which* nodes to ask about is the caller's business — see
// api.entries, which asks only for genus, species and subspecies.
func (s *Store) HeadlineVernaculars(ctx context.Context, idxs []int) (map[int]string, error) {
	out := map[int]string{}
	v := s.Schema.Vernacular
	if v == nil || v.Rank == "" || len(idxs) == 0 {
		return out, nil
	}
	for start := 0; start < len(idxs); start += metaChunk {
		end := min(start+metaChunk, len(idxs))
		chunk := idxs[start:end]
		q := fmt.Sprintf("SELECT %q, %q FROM %q WHERE %q IN (%s) AND %q = 1",
			v.Idx, v.Name, v.Table, v.Idx, placeholders(len(chunk)), v.Rank)
		args := make([]any, len(chunk))
		for i, x := range chunk {
			args[i] = x
		}
		rows, err := s.DB.QueryContext(ctx, q, args...)
		if err != nil {
			return out, err
		}
		for rows.Next() {
			var idx sql.NullInt64
			var name sql.NullString
			if err := rows.Scan(&idx, &name); err != nil {
				_ = rows.Close()
				return out, err
			}
			// One rank-1 row per node is the pipeline's invariant and a gate
			// checks it, so no tiebreak is needed here. If one ever slipped
			// through, first-seen is as good an answer as any and silence
			// would be worse than either.
			if idx.Valid && name.Valid {
				if _, seen := out[int(idx.Int64)]; !seen {
					out[int(idx.Int64)] = name.String
				}
			}
		}
		err = rows.Err()
		_ = rows.Close()
		if err != nil {
			return out, err
		}
	}
	return out, nil
}

// betterVernacular reports whether a candidate should displace the incumbent.
// A rank of 0 means "unranked", since usage_rank is 1-based and a real rank is
// therefore always truthy.
func betterVernacular(rk sql.NullInt64, pref bool, haveRank int64, havePref bool) bool {
	if rk.Valid && rk.Int64 > 0 {
		return haveRank == 0 || rk.Int64 < haveRank
	}
	if haveRank > 0 {
		return false
	}
	return pref && !havePref
}

// Synonyms returns alternative names for a node, if a synonym table exists.
func (s *Store) Synonyms(ctx context.Context, m NodeMeta) ([]string, error) {
	out := []string{}
	sy := s.Schema.Synonym
	if sy == nil {
		return out, nil
	}
	var arg any
	if sy.ByOtt {
		if m.OttID == nil {
			return out, nil
		}
		arg = *m.OttID
	} else {
		arg = m.Idx
	}
	q := fmt.Sprintf("SELECT %q FROM %q WHERE %q = ?", sy.Name, sy.Table, sy.Key)
	rows, err := s.DB.QueryContext(ctx, q, arg)
	if err != nil {
		return out, err
	}
	defer rows.Close() //nolint:errcheck
	for rows.Next() {
		var n sql.NullString
		if err := rows.Scan(&n); err != nil {
			return out, err
		}
		if n.Valid && n.String != "" {
			out = append(out, n.String)
		}
	}
	return out, rows.Err()
}

// Attribution is a silhouette's credit. Creator and Uploader are separate
// fields on purpose: they differ 31% of the time, and conflating them credits
// the wrong person.
type Attribution struct {
	PhylopicID  string  `json:"phylopic_id"`
	Creator     *string `json:"creator"`
	Uploader    *string `json:"uploader"`
	LicenseURL  *string `json:"license_url"`
	LicenseName *string `json:"license_name,omitempty"`
	// Available says whether the SVG is actually in the mirror. The mirror is
	// fetched over ~12,863 calls to a small service, so "known but not yet on
	// disk" is a normal state and the UI must not render a broken image.
	Available bool   `json:"available"`
	URL       string `json:"url,omitempty"`

	// What the picture is actually of. Resolution finds the closest drawn
	// relative rather than the nearest drawn ancestor, so the source is usually
	// a cousin and naming it alone would not say how far the likeness stretches.
	SourceIdx      *int    `json:"source_idx"`
	SourceName     *string `json:"source_name"`
	SourceRank     *string `json:"source_rank"`
	SourceTipCount *int64  `json:"source_tip_count"`

	// The clade the picture therefore stands for: the smallest one containing
	// both this node and the drawing. Its tip count is the size of the claim —
	// 3,153 at the median — and the detail card is where the app names that
	// clade out loud, so it needs the number to say how big a claim it is.
	// CladeName is null for `mrcaott…` nodes, which have no name to give.
	CladeIdx      *int    `json:"clade_idx"`
	CladeName     *string `json:"clade_name"`
	CladeTipCount *int64  `json:"clade_tip_count"`

	// Climb is hops from the node up to the clade, not to the source. Mean is
	// 4.24, and climb 0 does not imply an exact match: an unseeded genus holding
	// a drawn species sits at 0.
	Climb  *int   `json:"climb"`
	Method string `json:"method,omitempty"`
}

// SilhouetteAttribution looks up the credit for one PhyloPic id.
func (s *Store) SilhouetteAttribution(ctx context.Context, id string) (*Attribution, error) {
	sl := s.Schema.Silhouette
	if sl == nil || id == "" {
		return nil, nil //nolint:nilnil // absence is the normal answer here
	}
	sel := []string{colOrNull(sl.Creator), colOrNull(sl.Uploader), colOrNull(sl.License), colOrNull(sl.LicenseName)}
	q := fmt.Sprintf("SELECT %s FROM %q WHERE %q = ?", strings.Join(sel, ", "), sl.Table, sl.ID)
	var creator, uploader, license, licenseName sql.NullString
	err := s.DB.QueryRowContext(ctx, q, id).Scan(&creator, &uploader, &license, &licenseName)
	if err == sql.ErrNoRows {
		return &Attribution{PhylopicID: id}, nil
	}
	if err != nil {
		return nil, err
	}
	a := &Attribution{
		PhylopicID:  id,
		Creator:     nullStr(creator),
		Uploader:    nullStr(uploader),
		LicenseURL:  nullStr(license),
		LicenseName: nullStr(licenseName),
	}
	if s.SVGPath(ctx, id) != "" {
		a.Available = true
		a.URL = "/v1/silhouette/" + id + ".svg"
	}
	return a, nil
}

func colOrNull(c string) string {
	if c == "" {
		return "NULL"
	}
	return fmt.Sprintf("%q", c)
}

// VernacularName is one common name with the evidence search ranks it on.
// Evidence is "" both where the build predates the `names` phase and where
// that phase could not ask the question — the two are indistinguishable here
// and mean the same thing to every caller: no evidence, fall through.
type VernacularName struct {
	Name     string
	Evidence string
}

// wikiTitle is the one `wiki_evidence` value search reads: the name is the
// title of English Wikipedia's article about this taxon. See decorate.
const wikiTitle = "title"

// allVernacularNames returns every common name for a batch of nodes. Search
// ranking needs all of them, not just the primary one: Canidae's primary name
// is "canid", but the whole-word match for "dog" is in "dog family".
func (s *Store) allVernacularNames(ctx context.Context, idxs []int) (map[int][]VernacularName, error) {
	out := map[int][]VernacularName{}
	v := s.Schema.Vernacular
	if v == nil || len(idxs) == 0 {
		return out, nil
	}
	// A build predating phase 6b has no evidence column. Selecting a literal
	// keeps one scan path rather than two, and every row then reads as "not
	// asked", which is what such a build actually knows.
	evidence := "''"
	if v.WikiEvidence != "" {
		evidence = fmt.Sprintf("%q", v.WikiEvidence)
	}
	for start := 0; start < len(idxs); start += metaChunk {
		end := min(start+metaChunk, len(idxs))
		chunk := idxs[start:end]
		q := fmt.Sprintf("SELECT %q, %q, %s FROM %q WHERE %q IN (%s)",
			v.Idx, v.Name, evidence, v.Table, v.Idx, placeholders(len(chunk)))
		args := make([]any, len(chunk))
		for i, x := range chunk {
			args[i] = x
		}
		rows, err := s.DB.QueryContext(ctx, q, args...)
		if err != nil {
			return out, err
		}
		for rows.Next() {
			var idx sql.NullInt64
			var name, ev sql.NullString
			if err := rows.Scan(&idx, &name, &ev); err != nil {
				_ = rows.Close()
				return out, err
			}
			if idx.Valid && name.Valid {
				out[int(idx.Int64)] = append(out[int(idx.Int64)],
					VernacularName{Name: name.String, Evidence: ev.String})
			}
		}
		err = rows.Err()
		_ = rows.Close()
		if err != nil {
			return out, err
		}
	}
	return out, nil
}

// Occurrence is the fossil range shown for a node in the `occurrence` age
// tier. It is not an age and must never be rendered as one.
//
// All four bounds travel, uncollapsed. The *envelope* is Fea→Lla, the maximal
// possible extent; the *certain extent* is Fla→Lea. Two things a caller must
// know before drawing it:
//
//   - There is no midpoint and none may be computed. A single number would be
//     a fabricated estimate wearing an observation's clothes, which is the one
//     thing this tier exists not to produce.
//   - **Fla >= Lea does not hold.** It is true of only 39.6% of PBDB taxa,
//     because a taxon known from one stratigraphic interval has both of its
//     appearances inside it and the two cross. For the other 60.4% the certain
//     extent is empty and the solid bar must be left undrawn rather than drawn
//     zero-width — a hairline at one date reads as precision.
type Occurrence struct {
	Fea *float64 `json:"fea"`
	Fla *float64 `json:"fla"`
	Lea *float64 `json:"lea"`
	Lla *float64 `json:"lla"`
}

// Occurrences resolves fossil ranges for a batch of node indices. Returns an
// empty map when no occurrence table exists yet.
func (s *Store) Occurrences(ctx context.Context, idxs []int) (map[int]Occurrence, error) {
	out := map[int]Occurrence{}
	oc := s.Schema.Occurrence
	if oc == nil || len(idxs) == 0 {
		return out, nil
	}
	for start := 0; start < len(idxs); start += metaChunk {
		end := min(start+metaChunk, len(idxs))
		chunk := idxs[start:end]
		q := fmt.Sprintf("SELECT %q, %s, %s, %s, %s FROM %q WHERE %q IN (%s)",
			oc.Idx, colOrNull(oc.Fea), colOrNull(oc.Fla), colOrNull(oc.Lea),
			colOrNull(oc.Lla), oc.Table, oc.Idx, placeholders(len(chunk)))
		args := make([]any, len(chunk))
		for i, v := range chunk {
			args[i] = v
		}
		rows, err := s.DB.QueryContext(ctx, q, args...)
		if err != nil {
			return out, err
		}
		for rows.Next() {
			var idx int
			var fea, fla, lea, lla sql.NullFloat64
			if err := rows.Scan(&idx, &fea, &fla, &lea, &lla); err != nil {
				_ = rows.Close()
				return out, err
			}
			o := Occurrence{}
			for dst, src := range map[**float64]sql.NullFloat64{
				&o.Fea: fea, &o.Fla: fla, &o.Lea: lea, &o.Lla: lla,
			} {
				if src.Valid {
					v := src.Float64
					*dst = &v
				}
			}
			out[idx] = o
		}
		err = rows.Err()
		_ = rows.Close()
		if err != nil {
			return out, err
		}
	}
	return out, nil
}
