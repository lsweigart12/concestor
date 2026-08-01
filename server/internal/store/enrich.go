package store

import (
	"context"
	"database/sql"
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

// WitnessRef is the second silhouette an internal node may carry: a drawn taxon
// from inside the clade whose fossil record puts it at that node's divergence.
// SourceIdx is always strictly inside the node, so unlike ImageRef there is no
// clade to report — the node itself is the whole of the claim. GapMa is the
// distance from the split to the taxon's observed range, and 0 means the range
// spans it outright.
type WitnessRef struct {
	PhylopicID string
	SourceIdx  int
	GapMa      *float64
}

// Witnesses resolves divergence silhouettes for a batch of node indices.
// Returns an empty map against a build with no node_divergence_image table,
// which is the normal state for anything built before phase 5a grew one.
func (s *Store) Witnesses(ctx context.Context, idxs []int) (map[int]WitnessRef, error) {
	out := map[int]WitnessRef{}
	w := s.Schema.Witness
	if w == nil || len(idxs) == 0 {
		return out, nil
	}
	for start := 0; start < len(idxs); start += metaChunk {
		end := min(start+metaChunk, len(idxs))
		chunk := idxs[start:end]
		q := fmt.Sprintf("SELECT %q, %q, %q, %s FROM %q WHERE %q IN (%s)",
			w.Idx, w.ID, w.SourceIdx, colOrNull(w.GapMa), w.Table, w.Idx,
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
			var id sql.NullString
			var src sql.NullInt64
			var gap sql.NullFloat64
			if err := rows.Scan(&idx, &id, &src, &gap); err != nil {
				_ = rows.Close()
				return out, err
			}
			// Both are load-bearing: the picture is meaningless without the
			// taxon it is of, since naming that taxon and its dates is the
			// only thing distinguishing a witness from an ordinary borrow.
			if !id.Valid || id.String == "" || !src.Valid || src.Int64 < 0 {
				continue
			}
			ref := WitnessRef{PhylopicID: id.String, SourceIdx: int(src.Int64)}
			if gap.Valid {
				v := gap.Float64
				ref.GapMa = &v
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

// Vernaculars returns every common name for one node, preferred first.
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
	q := fmt.Sprintf("SELECT %q, %s, %s FROM %q WHERE %q = ?", v.Name, lang, pref, v.Table, v.Idx)
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
	sort.SliceStable(out, func(i, j int) bool { return out[i].Preferred && !out[j].Preferred })
	return out, rows.Err()
}

// BestVernaculars returns one common name per node for a batch, for search
// results. Preferred rows win; otherwise the first row seen.
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
	q := fmt.Sprintf("SELECT %q, %q, %s FROM %q WHERE %q IN (%s)",
		v.Idx, v.Name, pref, v.Table, v.Idx, placeholders(len(idxs)))
	args := make([]any, len(idxs))
	for i, x := range idxs {
		args[i] = x
	}
	rows, err := s.DB.QueryContext(ctx, q, args...)
	if err != nil {
		return out, err
	}
	defer rows.Close() //nolint:errcheck
	best := map[int]bool{}
	for rows.Next() {
		var idxVal sql.NullInt64
		var name sql.NullString
		var pf sql.NullInt64
		if err := rows.Scan(&idxVal, &name, &pf); err != nil {
			return out, err
		}
		if !name.Valid || !idxVal.Valid {
			continue
		}
		idx := int(idxVal.Int64)
		isPref := pf.Valid && pf.Int64 != 0
		if _, seen := out[idx]; seen && !(isPref && !best[idx]) {
			continue
		}
		out[idx] = name.String
		best[idx] = isPref
	}
	return out, rows.Err()
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

// allVernacularNames returns every common name for a batch of nodes. Search
// ranking needs all of them, not just the primary one: Canidae's primary name
// is "canid", but the whole-word match for "dog" is in "dog family".
func (s *Store) allVernacularNames(ctx context.Context, idxs []int) (map[int][]string, error) {
	out := map[int][]string{}
	v := s.Schema.Vernacular
	if v == nil || len(idxs) == 0 {
		return out, nil
	}
	for start := 0; start < len(idxs); start += metaChunk {
		end := min(start+metaChunk, len(idxs))
		chunk := idxs[start:end]
		q := fmt.Sprintf("SELECT %q, %q FROM %q WHERE %q IN (%s)",
			v.Idx, v.Name, v.Table, v.Idx, placeholders(len(chunk)))
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
			if idx.Valid && name.Valid {
				out[int(idx.Int64)] = append(out[int(idx.Int64)], name.String)
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
