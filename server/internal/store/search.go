package store

import (
	"context"
	"database/sql"
	"fmt"
	"math"
	"sort"
	"strings"
	"unicode"
)

// Search ranking: exact match first, then tip_count descending, then
// has-silhouette, then has-measured-age. Candidate generation uses node_fts
// where it exists; the fallback is an indexed prefix range over node.name (once
// per plausible capitalisation, since the collation is BINARY and LIKE cannot
// use the index).

// SearchResult is one row of /v1/search.
type SearchResult struct {
	Kind       string  `json:"kind"` // "node" | "broken"
	Key        string  `json:"key"`
	Idx        *int    `json:"idx"`
	OttID      *int64  `json:"ott_id"`
	Name       *string `json:"name"`
	Vernacular *string `json:"vernacular"`
	Rank       *string `json:"rank"`
	TipCount   *int64  `json:"tip_count"`
	HasAge     bool    `json:"has_age"`
	HasImage   bool    `json:"has_image"`
	MatchedOn  string  `json:"matched_on"` // "name" | "vernacular" | "fts"
	// The name that actually matched, when it is not one the row already shows.
	// A synonym or abbreviation is the only field containing what the reader
	// typed; without it the row is an unexplained answer (and for *Homo
	// floresiensis* an unexplained answer about a different species).
	MatchedName *string `json:"matched_name,omitempty"`

	// Where this row sits in the ranking that covers both corpora (see Interleave).
	// Set by /v1/search and nil elsewhere.
	Order *int `json:"order,omitempty"`

	// The silhouette, for callers that draw one. CladeTips is the deciding field:
	// a silhouette stands for the smallest clade holding both hit and drawing, and
	// one spanning a kingdom misinforms where blank withholds, so the palette
	// needs the clade's size to apply the same rule as the canvas.
	PhylopicID           *string `json:"phylopic_id,omitempty"`
	SilhouetteSourceIdx  *int    `json:"silhouette_source_idx,omitempty"`
	SilhouetteSourceTips *int64  `json:"silhouette_source_tips,omitempty"`
	SilhouetteCladeTips  *int64  `json:"silhouette_clade_tips,omitempty"`

	// Broken taxa are not nodes, so idx and tip_count are null for them. These
	// two extra fields give the UI something to act on.
	MRCAIdx           *int `json:"mrca_idx,omitempty"`
	NAttachmentPoints *int `json:"n_attachment_points,omitempty"`

	// sort keys, not serialised
	band int
	// The best band reached by a name the *taxonomy* gives this taxon — its
	// scientific name, a generated abbreviation, a synonym. Kept apart from
	// `band` because only a vernacular's exactness can be withdrawn: see
	// decorate. A taxon whose scientific name is the query is never demoted.
	bandOwn int
	// Set by decorate when this row's exactness rests on a common name the
	// taxon is not headlined by, and so has to answer to clade size.
	withdrawable bool
	// Set by decorate when the query is the title of English Wikipedia's
	// article about this taxon — the one piece of evidence that says which
	// taxon a word denotes rather than how well it matches. See decorate.
	denotes bool
	// Whether the name matched is one the taxon still goes by. Derived from
	// MatchedOn unless tierSet, because MatchedOn answers "which name should I
	// report?" and this answers "is that name deprecated?" — a node can match
	// both a synonym and a current name, and reporting the former must not cost
	// it the latter's standing. See searchFTS.
	tier     int
	tierSet  bool
	score    float64
	rankTip  int64
	hasMeas  bool
	hasVern  bool
	sortName string
}

// resultTier is the ranking tier, preferring one computed across every name a
// node matched over one inferred from the single name picked for display.
func resultTier(r *SearchResult) int {
	if r.tierSet {
		return r.tier
	}
	return matchTier(r.MatchedOn)
}

const (
	maxSearchLimit     = 50
	defaultSearchLimit = 20
	// Candidates kept per prefix variant before the final ranking. Headroom for
	// de-duplication across variants; tip_count dominates the sort, so any value
	// at or above maxSearchLimit yields the same page.
	candidatesPerVariant = 128
	// Below this token length the FTS prefix enumeration costs more than the
	// hot-name cache, which answers the same query from memory.
	minFTSToken = 3
	// How much larger a clade has to be before a head-word match on it withdraws
	// an exact match's exactness (see decorate). The corpus fixes the bounds two
	// orders of magnitude apart: must not fire for "cow" (Bos taurus vs Sirenia's
	// "sea cows", ratio 7) but must for "butterfly" (an alias on a reef fish vs
	// Papilionidae, ratio ~1,080).
	outrankRatio = 100
)

func longestToken(q string) int {
	n := 0
	for _, t := range tokens(q) {
		n = max(n, len(t))
	}
	return n
}

// Scope restricts a search to one clade: the preorder interval [Lo, Hi), which
// is `[idx, subtree_out[idx])` for the clade's own node. One interval is the
// whole representation because ancestry *is* interval containment here
// (architecture §3.1), so "inside Homo" costs each candidate two comparisons.
// A nil *Scope means the whole tree, and every path below treats it so.
type Scope struct {
	Lo, Hi int
}

// contains is nil-safe: no scope holds everything.
func (sc *Scope) contains(idx int) bool {
	return sc == nil || (idx >= sc.Lo && idx < sc.Hi)
}

// sql returns a WHERE fragment fencing an idx-valued column to the scope, with
// its two arguments — or adds nothing, so call sites read the same unscoped.
func (sc *Scope) sql(col string) (string, []any) {
	if sc == nil {
		return "", nil
	}
	return fmt.Sprintf(" AND %s >= ? AND %s < ?", col, col), []any{sc.Lo, sc.Hi}
}

// Search runs the typeahead query over the whole tree.
func (s *Store) Search(ctx context.Context, q string, limit int) ([]SearchResult, error) {
	return s.SearchIn(ctx, q, limit, nil)
}

// SearchIn runs the typeahead query inside one clade, or everywhere when scope
// is nil. The scope is pushed into candidate generation rather than filtered
// after the fact: every generator caps its candidates (heaps, LIMITs), so a
// post-hoc filter would let a narrow clade starve behind global candidates
// that were about to be discarded — searching "a" inside *Homo* must reach
// *Homo sapiens*, not lose all 128 candidate slots to Aves and Arthropoda.
//
// Broken taxa are not answered under a scope: a broken taxon has no position,
// so "is it inside this clade?" has no honest answer.
func (s *Store) SearchIn(ctx context.Context, q string, limit int, scope *Scope) ([]SearchResult, error) {
	q = strings.Join(strings.Fields(q), " ")
	if limit <= 0 {
		limit = defaultSearchLimit
	}
	limit = min(limit, maxSearchLimit)
	if q == "" {
		return []SearchResult{}, nil
	}
	qFold := strings.ToLower(q)

	byIdx := map[int]*SearchResult{}
	add := func(r *SearchResult) {
		if r.Idx == nil || !scope.contains(*r.Idx) {
			return
		}
		// A node reached by several routes keeps the strongest one: a hit on
		// the scientific name beats an FTS hit beats a vernacular hit.
		if prev, ok := byIdx[*r.Idx]; ok && matchStrength(prev.MatchedOn) >= matchStrength(r.MatchedOn) {
			return
		}
		byIdx[*r.Idx] = r
	}

	// FTS5 enumerates every indexed term with the prefix, so the shortest queries
	// (first keystroke) are answered from the hot-name cache instead, which ranks
	// them identically.
	useFTS := s.Schema.FTS != nil && longestToken(q) >= minFTSToken
	if useFTS {
		rows, err := s.searchFTS(ctx, q, limit*8, scope)
		if err != nil {
			s.log.Warn("FTS query failed, falling back to prefix scan", "err", err)
			useFTS = false
		} else {
			for _, r := range rows {
				add(r)
			}
		}
	}
	if len(byIdx) < limit*2 {
		rows, err := s.searchNamePrefix(ctx, q, scope)
		if err != nil {
			return nil, err
		}
		for _, r := range rows {
			add(r)
		}
	}
	if s.Schema.Vernacular != nil {
		// node_fts already indexes vernaculars (search_name.kind = 3), so the
		// separate prefix scan over the vernacular table is only needed when
		// FTS did not run.
		if !useFTS {
			rows, err := s.searchVernacular(ctx, q, limit*4, scope)
			if err != nil {
				s.log.Warn("vernacular query failed", "err", err)
			} else {
				for _, r := range rows {
					add(r)
				}
			}
		}
		// A node whose common name *is* the query has to be a candidate even
		// if the capped prefix scan missed it. This is candidate generation
		// only — the band it earns is computed in decorate, against every name
		// the node carries, because an exact common name is not on its own
		// enough to say the reader meant this taxon.
		if ev, err := s.exactVernacularMatches(ctx, q, scope); err != nil {
			s.log.Warn("exact vernacular lookup failed", "err", err)
		} else {
			missing := make([]int, 0, len(ev))
			for idx := range ev {
				if _, have := byIdx[idx]; !have {
					missing = append(missing, idx)
				}
			}
			if len(missing) > 0 {
				extra, err := s.resultsForIdxs(ctx, missing, "vernacular")
				if err != nil {
					return nil, err
				}
				for _, r := range extra {
					add(r)
				}
			}
		}
	}

	results := make([]SearchResult, 0, len(byIdx)+8)
	for _, r := range byIdx {
		results = append(results, *r)
	}
	// Broken taxa must be answerable, but only when the query *is* one. There
	// are 9,839 and they live in memory, so this is a linear scan over a small
	// slice. Never under a scope — see SearchIn.
	if scope == nil {
		results = append(results, s.searchBroken(qFold)...)
	}

	if err := s.decorate(ctx, results, qFold); err != nil {
		return nil, err
	}

	sort.SliceStable(results, func(i, j int) bool { return lessResult(&results[i], &results[j]) })
	if len(results) > limit {
		results = results[:limit]
	}
	// The same rank the canvas and card show. After the truncation because it is
	// display-only and no sort reads it.
	for i := range results {
		if results[i].Idx != nil {
			results[i].Rank = s.rankFor(*results[i].Idx, results[i].Rank)
		}
	}
	if err := s.fillVernaculars(ctx, results); err != nil {
		return nil, err
	}
	// Credit the matched name only once the row is finished (the common name now
	// exists), so a row already showing the matched string does not caption it.
	for i := range results {
		if n := results[i].MatchedName; n != nil && showsName(&results[i], *n) {
			results[i].MatchedName = nil
		}
	}
	if results == nil {
		results = []SearchResult{}
	}
	return results, nil
}

// Answer is how good the best row in a ranking is and how many rows there are.
// Returned by Interleave, the one place both corpora are scored on one scale.
// Not serialised and not a ranking signal — it answers "was that any good?"
// (see Answer.Weak). The zero value is inert: zero Band is the best band, zero
// Rows is none.
type Answer struct {
	// The best band any pickable row reached; lower is better, bandNone on empty.
	Band int
	// Pickable rows across both corpora. Broken taxa are not counted: they render
	// as a note and cannot be chosen.
	Rows int
}

// How few rows a weak answer may hold before the query is read as a dead end
// rather than a name someone is part-way through typing. The discriminator is
// how much of the corpus lives under the prefix: a live prefix of a real name
// always returns a full page, so must reach `elefant` (1), `cheeta` (4),
// `mamal` (6) but not `tyrannosau` (10, whose only correction is its own prefix).
const sparseRows = 8

// Weak reports whether this answer is poor enough to ask the spelling index
// about: nothing matched as a whole word (band above bandToken), AND there is
// almost nothing there (a prefix match alone would fire every keystroke). An
// empty list is the same test — bandNone and zero rows.
func (a Answer) Weak() bool {
	return a.Band > bandToken && a.Rows <= sparseRows
}

// Better reports whether this answer is worth offering in place of that one: a
// strictly better band, and rows to show. Trading one junk answer for another is
// a second guess, not a correction.
func (a Answer) Better(than Answer) bool {
	return a.Rows > 0 && a.Band < than.Band
}

// Interleave puts the two corpora in one order, stamps each row with its
// position in place, and reports how good that order is. The server does this
// because it is ranking, which the client may not do (a client that computed the
// order would be the fuzzy-score bug). The rule, in order:
//
//  1. Band — how well the query sits inside the name (matchBand, over both
//     corpora, which is what makes the merge possible).
//  2. Position within the row's own corpus — each corpus scores on signals the
//     other lacks, so compare each row to its own best rather than invent a
//     common scale.
//  3. Node before fossil — the last tiebreak: a row that joins the tree beats
//     one that only hangs off it.
//
// Broken taxa are left unstamped: they cannot be picked.
func Interleave(nodes []SearchResult, fossils []Fossil, q string) Answer {
	qFold := strings.ToLower(q)
	type slot struct {
		band   int
		pos    int
		fossil bool
		i      int
	}
	slots := make([]slot, 0, len(nodes)+len(fossils))
	pos := 0
	for i := range nodes {
		if nodes[i].Kind == "broken" {
			continue
		}
		slots = append(slots, slot{band: nodes[i].band, pos: pos, i: i})
		pos++
	}
	for i := range fossils {
		slots = append(slots, slot{
			band: matchBand(fossils[i].Name, qFold), pos: i, fossil: true, i: i,
		})
	}
	sort.SliceStable(slots, func(a, b int) bool {
		x, y := slots[a], slots[b]
		if x.band != y.band {
			return x.band < y.band
		}
		if x.pos != y.pos {
			return x.pos < y.pos
		}
		return !x.fossil && y.fossil
	})
	out := Answer{Band: bandNone, Rows: len(slots)}
	for n, sl := range slots {
		order := n
		if sl.fossil {
			fossils[sl.i].Order = &order
		} else {
			nodes[sl.i].Order = &order
		}
		out.Band = min(out.Band, sl.band)
	}
	return out
}

func matchStrength(m string) int {
	switch m {
	case "name":
		return 6
	case "abbreviation":
		return 5
	case "synonym":
		return 4
	// Below a synonym: OTT's own filing is the better thing to credit when both
	// matched equally well, because it is a statement about the name the reader
	// typed rather than about a second catalogue's usage.
	case "fossil-name":
		return 3
	case "fts":
		return 2
	case "vernacular":
		return 1
	}
	return 0
}

// matchTier splits "a name this taxon goes by" from "a name it used to go by".
// A fossil-record name is the second: PBDB is where the name is current, and
// the tree prints something else.
func matchTier(m string) int {
	if m == "synonym" || m == "fossil-name" {
		return 1
	}
	return 0
}

func lessResult(a, b *SearchResult) bool {
	// How well the query sits inside the name comes before everything else:
	// exact string, then whole-word, then prefix-of-word. Without this band a
	// query like "dog" falls straight through to tip_count, and Apocynaceae
	// ("dogbane family", 7,050 tips) beats Canidae ("dog family", 211).
	if a.band != b.band {
		return a.band < b.band
	}
	// A hit on a deprecated synonym is weaker than one on a name the taxon
	// actually goes by. Without this, "Can" surfaces Elateroidea — whose
	// synonym is Cantharoidea — above Cantharellales, because Elateroidea has
	// the larger subtree. A vernacular hit is *not* demoted: for a lay
	// audience a common name is as good a way in as a scientific one.
	if at, bt := resultTier(a), resultTier(b); at != bt {
		return at < bt
	}
	// Nodes outrank broken taxa on a non-exact match. A broken taxon has no
	// subtree of its own, so the only size signal available is its substituted
	// MRCA's — which is by construction *larger* than the taxon, because the
	// MRCA is what swallowed the intruders. Ranking on that would let 9,839
	// broken taxa crowd out 2.4M real names on every short prefix. Ask for one
	// by name and it still comes first, via the exact band.
	if aBroken, bBroken := a.Kind == "broken", b.Kind == "broken"; aBroken != bBroken {
		return bBroken
	}
	// When two taxa are both called exactly what was typed, size is the wrong
	// tiebreak (for `human`, the genus *Homo* beat *Homo sapiens*). English
	// Wikipedia's article title says which taxon the word denotes. It settles
	// ties only, never bands, and does not fire where no candidate holds the
	// title (`shark`, `dog`, `whale`, and most contested names).
	if a.denotes != b.denotes {
		return a.denotes
	}
	if a.score != b.score {
		return a.score > b.score
	}
	if a.rankTip != b.rankTip {
		return a.rankTip > b.rankTip
	}
	if a.HasImage != b.HasImage {
		return a.HasImage
	}
	if a.hasMeas != b.hasMeas {
		return a.hasMeas
	}
	// One tiebreak past architecture §4's list, and it earns its place: having
	// a common name at all is the strongest available proxy for "a curious
	// person has heard of this". It is what separates Tyrannosaurus rex from
	// the nine other species whose abbreviation is also "T. rex" and which are
	// identical on every other signal.
	if a.hasVern != b.hasVern {
		return a.hasVern
	}
	if a.sortName != b.sortName {
		return a.sortName < b.sortName
	}
	return a.Kind < b.Kind
}

// nameVariants covers the capitalisations a user actually types against a
// BINARY-collated index. Scientific names capitalise the genus only, so
// "homo sapiens" must reach "Homo sapiens".
func nameVariants(q string) []string {
	upperFirst := func(s string) string {
		r := []rune(s)
		if len(r) == 0 {
			return s
		}
		r[0] = unicode.ToUpper(r[0])
		return string(r)
	}
	lower := strings.ToLower(q)
	cands := []string{q, upperFirst(q), upperFirst(lower), lower}
	seen := map[string]bool{}
	out := cands[:0:0]
	for _, c := range cands {
		if c == "" || seen[c] {
			continue
		}
		seen[c] = true
		out = append(out, c)
	}
	return out
}

// prefixBound returns an exclusive upper bound for a BINARY prefix range.
// U+10FFFF is the largest code point, so no realistic taxon name sorts above
// prefix+"\U0010FFFF" while still starting with prefix.
func prefixBound(p string) string { return p + "\U0010FFFF" }

// searchNamePrefix is the fallback used until node_fts exists.
//
// ORDER BY tip_count in SQL forces a primary-key seek per candidate row, so the
// ranking happens here instead: take idx index-only, read tip_count from the
// mmap'd array, keep the best K in a bounded heap, fetch full rows for only
// those. Same answer, an order of magnitude cheaper.
func (s *Store) searchNamePrefix(ctx context.Context, q string, scope *Scope) ([]*SearchResult, error) {
	seen := make(map[int]struct{})
	var idxs []int
	add := func(list []int) {
		for _, idx := range list {
			if !scope.contains(idx) {
				continue
			}
			if _, dup := seen[idx]; dup {
				continue
			}
			seen[idx] = struct{}{}
			idxs = append(idxs, idx)
		}
	}

	// The hot set holds the globally largest subtrees. If it alone yields a
	// full page of prefix matches, no node outside it can outrank them on
	// tip_count, so the SQL scan is provably unnecessary — which is what keeps
	// a one-character query from touching 268,281 index entries. Under a scope
	// the shortcut is judged on the matches *inside* it: the global page proves
	// nothing about a clade it barely intersects.
	hot := 0
	hotList := s.hotPrefixMatches(q, candidatesPerVariant)
	for _, idx := range hotList {
		if scope.contains(idx) {
			hot++
		}
	}
	add(hotList)
	if hot < candidatesPerVariant {
		for _, v := range nameVariants(q) {
			top, err := s.topByTipCount(ctx, v, candidatesPerVariant, scope)
			if err != nil {
				return nil, err
			}
			add(top)
		}
	}
	// An exact match can be a one-species node far outside the hot set, and it
	// has to rank first. One indexed equality lookup per capitalisation.
	exact, err := s.exactNameMatches(ctx, q, scope)
	if err != nil {
		return nil, err
	}
	add(exact)

	if len(idxs) == 0 {
		return nil, nil
	}
	return s.resultsForIdxs(ctx, idxs, "name")
}

func (s *Store) exactNameMatches(ctx context.Context, q string, scope *Scope) ([]int, error) {
	var out []int
	fence, fenceArgs := scope.sql("idx")
	for _, v := range nameVariants(q) {
		rows, err := s.DB.QueryContext(ctx,
			`SELECT idx FROM node WHERE name = ?`+fence, append([]any{v}, fenceArgs...)...)
		if err != nil {
			return nil, err
		}
		for rows.Next() {
			var idx int
			if err := rows.Scan(&idx); err != nil {
				_ = rows.Close()
				return nil, err
			}
			out = append(out, idx)
		}
		err = rows.Err()
		_ = rows.Close()
		if err != nil {
			return nil, err
		}
	}
	return out, nil
}

// topByTipCount returns the k node indices with the largest subtrees whose
// name starts with prefix.
func (s *Store) topByTipCount(ctx context.Context, prefix string, k int, scope *Scope) ([]int, error) {
	fence, fenceArgs := scope.sql("idx")
	rows, err := s.DB.QueryContext(ctx,
		`SELECT idx FROM node WHERE name >= ? AND name < ?`+fence,
		append([]any{prefix, prefixBound(prefix)}, fenceArgs...)...)
	if err != nil {
		return nil, err
	}
	defer rows.Close() //nolint:errcheck

	h := &tipHeap{tip: s.Arrays.TipCount}
	for rows.Next() {
		var idx int
		if err := rows.Scan(&idx); err != nil {
			return nil, err
		}
		if !s.Arrays.Valid(idx) {
			continue
		}
		h.push(idx, k)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return h.sorted(), nil
}

// tipHeap keeps the k largest subtrees seen, as a min-heap on tip_count.
type tipHeap struct {
	tip  []uint32
	item []int
}

func (h *tipHeap) less(i, j int) bool { return h.tip[h.item[i]] < h.tip[h.item[j]] }

func (h *tipHeap) push(idx, k int) {
	if len(h.item) < k {
		h.item = append(h.item, idx)
		h.up(len(h.item) - 1)
		return
	}
	if h.tip[idx] <= h.tip[h.item[0]] {
		return
	}
	h.item[0] = idx
	h.down(0)
}

func (h *tipHeap) up(i int) {
	for i > 0 {
		p := (i - 1) / 2
		if !h.less(i, p) {
			return
		}
		h.item[i], h.item[p] = h.item[p], h.item[i]
		i = p
	}
}

func (h *tipHeap) down(i int) {
	n := len(h.item)
	for {
		l, r, m := 2*i+1, 2*i+2, i
		if l < n && h.less(l, m) {
			m = l
		}
		if r < n && h.less(r, m) {
			m = r
		}
		if m == i {
			return
		}
		h.item[i], h.item[m] = h.item[m], h.item[i]
		i = m
	}
}

func (h *tipHeap) sorted() []int {
	out := append([]int(nil), h.item...)
	sort.Slice(out, func(i, j int) bool { return h.tip[out[i]] > h.tip[out[j]] })
	return out
}

// resultsForIdxs materialises search rows for a already-chosen set of indices.
func (s *Store) resultsForIdxs(ctx context.Context, idxs []int, matchedOn string) ([]*SearchResult, error) {
	var out []*SearchResult
	for start := 0; start < len(idxs); start += metaChunk {
		end := min(start+metaChunk, len(idxs))
		chunk := idxs[start:end]
		q := "SELECT idx, ott_id, node_key, name, rank, tip_count FROM node WHERE idx IN (" +
			placeholders(len(chunk)) + ")"
		args := make([]any, len(chunk))
		for i, v := range chunk {
			args[i] = v
		}
		rows, err := s.DB.QueryContext(ctx, q, args...)
		if err != nil {
			return nil, err
		}
		batch, err := scanNodeResults(rows, matchedOn)
		if err != nil {
			return nil, err
		}
		out = append(out, batch...)
	}
	return out, nil
}

// nameKind maps search_name.kind onto the matched_on value the API reports.
// There is deliberately no entry for kindBrokenName: those rows are filed
// against a node that does not bear the name, so they never become node hits.
//
// Kind 5 is the name the Paleobiology Database uses for a taxon the synthesis
// tree holds. It rides in the `syn` FTS column because it wants a synonym's
// weight, but it is reported separately because it is a different claim: OTT
// filing a name is a statement about the taxonomy, PBDB using one is a
// statement about the fossil record. A build predating the corpus simply never
// emits a 5.
var nameKind = map[int64]string{
	0: "name", 1: "abbreviation", 2: "synonym", 3: "vernacular", 5: "fossil-name",
}

// kindBrokenName is search_name.kind for a broken taxon's name. The row's idx
// is the MRCA that swallowed the taxon, not the taxon — it has no idx, being
// rejected from synthesis. `searchBroken` answers for these.
const kindBrokenName = 4

// ftsScanCap bounds the rows pulled out of the FTS index before de-duplication.
// The index holds one row per *name* — 6.8M rows against 2.7M nodes — so a
// heavily-synonymised taxon can occupy dozens of them. De-duplication has to
// happen before the page is cut, or one taxon fills the whole palette.
const ftsScanCap = 4000

func (s *Store) searchFTS(ctx context.Context, q string, limit int, scope *Scope) ([]*SearchResult, error) {
	expr := ftsPrefixQuery(q)
	if expr == "" {
		return nil, nil
	}
	f := s.Schema.FTS
	kind := "NULL"
	if f.MapKind != "" {
		kind = "m." + fmt.Sprintf("%q", f.MapKind)
	}
	// The fence sits inside the WHERE, before the LIMIT: a scoped query must
	// spend its ftsScanCap on rows inside the clade, not collect a capful of
	// global matches and then discard them.
	fence, fenceArgs := scope.sql("m." + fmt.Sprintf("%q", f.MapIdx))
	// node_fts.rowid is a search_name.id, NOT a node.idx. Joining it straight
	// to node does not error — it joins cleanly to unrelated nodes and returns
	// confident nonsense, which is exactly what it did.
	rows, err := s.DB.QueryContext(ctx, fmt.Sprintf(
		`SELECT m.%q, %s, m.%q FROM %q f JOIN %q m ON m.%q = f.rowid WHERE %q MATCH ?%s LIMIT ?`,
		f.MapIdx, kind, f.MapName, f.Table, f.MapTable, f.MapID, f.Table, fence),
		append(append([]any{expr}, fenceArgs...), ftsScanCap)...)
	if err != nil {
		return nil, err
	}
	defer rows.Close() //nolint:errcheck

	qFold := strings.ToLower(q)
	var order []int
	kinds := map[int]string{}
	// The winning name itself, tracked in lockstep with `kinds` so the two can
	// never disagree about which name is being credited.
	matched := map[int]string{}
	// Best band across every name this node matched through.
	bands := map[int]int{}
	// Best band across only those names the taxonomy itself gives the taxon —
	// scientific, abbreviation, synonym. Only a *vernacular's* exactness can be
	// withdrawn, so decorate has to be able to tell the two apart.
	ownBands := map[int]int{}
	// Best *tier* across them, which is a separate question — see below.
	tiers := map[int]int{}
	for rows.Next() {
		var idxVal sql.NullInt64
		var k sql.NullInt64
		var name sql.NullString
		if err := rows.Scan(&idxVal, &k, &name); err != nil {
			return nil, err
		}
		if !idxVal.Valid {
			continue
		}
		idx := int(idxVal.Int64)
		if !s.Arrays.Valid(idx) {
			continue
		}
		// A `kind = 4` row is a broken taxon's name filed against the *MRCA that
		// swallowed it* — 9,839 of them, and the idx is emphatically not the
		// taxon's, because a broken taxon is rejected from synthesis and is not
		// a node at all. Letting one through here answers a different question
		// than the one asked: searching "Dinosauria" returned a node called
		// *Sauria*, ranked above the explanation, which is precisely the
		// silent substitution `searchBroken` exists to refuse. The names belong
		// in the index so they are findable; finding them is not this path's job.
		if k.Valid && k.Int64 == kindBrokenName {
			continue
		}
		if _, seen := kinds[idx]; !seen {
			order = append(order, idx)
			kinds[idx] = "" // strength 0, so any real kind wins
			bands[idx] = bandNone
			ownBands[idx] = bandNone
			tiers[idx] = 1 // demoted until some current name says otherwise
		}
		kn := ""
		if k.Valid {
			kn = nameKind[k.Int64]
		}
		// "T. rex" is an abbreviation, not a scientific name, so exactness has
		// to be judged against whichever name actually matched. Doing it here
		// also covers synonyms and vernaculars for free, and uses the FTS index
		// rather than a full scan of search_name, which has no index on name.
		band := bandNone
		if name.Valid {
			band = matchBand(name.String, qFold)
		}

		// A node matching through several names tracks three things separately:
		// how well the best name matched (bands), which name to report as the
		// reason (kinds), and the best tier across every matched name (tiers).
		// The reason reported is the name that won the band, not the strongest —
		// else Metazoa credits the synonym *Animalia* over the vernacular that
		// actually put it on the page.
		if band < bands[idx] {
			bands[idx] = band
			kinds[idx] = kn
			matched[idx] = name.String
		} else if band == bands[idx] && matchStrength(kn) > matchStrength(kinds[idx]) {
			kinds[idx] = kn
			matched[idx] = name.String
		}
		if kn != "vernacular" && band < ownBands[idx] {
			ownBands[idx] = band
		}
		// The tier is the best across every name matched, never the tier of the
		// one picked to display.
		if kn != "" {
			if t := matchTier(kn); t < tiers[idx] {
				tiers[idx] = t
			}
		}
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}

	// Cut the candidate list on the same keys the final ranking uses, not on
	// raw tip_count. "can" matches a synonym of Elateroidea (9,651 tips) and
	// dozens like it; truncating by subtree size alone pushed Cantharellales —
	// a genuine whole-name prefix match — off the end before the band and
	// synonym rules ever saw it.
	tip := s.Arrays.TipCount
	sort.SliceStable(order, func(i, j int) bool {
		a, b := order[i], order[j]
		if bands[a] != bands[b] {
			return bands[a] < bands[b]
		}
		if ta, tb := tiers[a], tiers[b]; ta != tb {
			return ta < tb
		}
		return tip[a] > tip[b]
	})
	idxs := order
	if len(idxs) > limit {
		idxs = idxs[:limit]
	}
	if len(idxs) == 0 {
		return nil, nil
	}
	out, err := s.resultsForIdxs(ctx, idxs, "fts")
	if err != nil {
		return nil, err
	}
	for _, r := range out {
		if k, ok := kinds[*r.Idx]; ok && k != "" {
			r.MatchedOn = k
		}
		// Only where the row does not already show it. Repeating the name in
		// the heading back as the reason it matched is noise; a synonym the
		// row has no other way to mention is the whole point. This is the
		// scientific-name half only — the row has no common name yet, so Search
		// runs the same test again once fillVernaculars has given it one.
		if n, ok := matched[*r.Idx]; ok && n != "" && !showsName(r, n) {
			v := n
			r.MatchedName = &v
		}
		if b, ok := bands[*r.Idx]; ok {
			r.band = b
		}
		// Absent a `kind` column every name reads as the taxon's own, so the
		// withdrawal below never fires — which is the safe direction.
		if b, ok := ownBands[*r.Idx]; ok {
			r.bandOwn = b
		}
		// The final ranking calls matchTier on MatchedOn, which reports the
		// strongest name and so can say "synonym" for a node that also matched
		// a current one. Carry the tier the candidate cut computed instead, so
		// both stages agree.
		if t, ok := tiers[*r.Idx]; ok {
			r.tier, r.tierSet = t, true
		}
	}
	return out, nil
}

// showsName reports whether a result already displays this string, in which
// case crediting it as the match adds nothing.
func showsName(r *SearchResult, name string) bool {
	if r.Name != nil && strings.EqualFold(*r.Name, name) {
		return true
	}
	return r.Vernacular != nil && strings.EqualFold(*r.Vernacular, name)
}

// exactVernacularMatches finds nodes whose common name *is* the query. It uses
// the vernacular table's own name index, so "human" reaches Homo rather than
// losing to Pulex ("Human Fleas"), which has a larger subtree and would win a
// pure tip_count ordering.
func (s *Store) exactVernacularMatches(ctx context.Context, q string, scope *Scope) (map[int]struct{}, error) {
	out := map[int]struct{}{}
	v := s.Schema.Vernacular
	if v == nil {
		return out, nil
	}
	fence, fenceArgs := scope.sql(fmt.Sprintf("%q", v.Idx))
	for _, variant := range nameVariants(q) {
		rows, err := s.DB.QueryContext(ctx, fmt.Sprintf(
			`SELECT %q FROM %q WHERE %q = ? AND %q IS NOT NULL%s`,
			v.Idx, v.Table, v.Name, v.Idx, fence),
			append([]any{variant}, fenceArgs...)...)
		if err != nil {
			return out, err
		}
		for rows.Next() {
			var idx sql.NullInt64
			if err := rows.Scan(&idx); err != nil {
				_ = rows.Close()
				return out, err
			}
			if idx.Valid && s.Arrays.Valid(int(idx.Int64)) {
				out[int(idx.Int64)] = struct{}{}
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

// ftsPrefixQuery turns free text into an FTS5 MATCH expression: every token
// double-quoted (so punctuation cannot become an operator) and the last one
// given a prefix star, which is what typeahead needs.
func ftsPrefixQuery(q string) string {
	fields := strings.FieldsFunc(q, func(r rune) bool {
		return !unicode.IsLetter(r) && !unicode.IsDigit(r)
	})
	if len(fields) == 0 {
		return ""
	}
	parts := make([]string, len(fields))
	for i, f := range fields {
		parts[i] = `"` + strings.ReplaceAll(f, `"`, `""`) + `"`
		if i == len(fields)-1 {
			parts[i] += "*"
		}
	}
	return strings.Join(parts, " ")
}

// searchVernacular mirrors searchNamePrefix: pull candidate indices without
// leaving the vernacular table, rank them against the mmap'd tip_count array,
// and only then join back to node. vernacularScanCap bounds the worst case for
// a one-character prefix over a corpus that will run to millions of rows.
const vernacularScanCap = 20000

func (s *Store) searchVernacular(ctx context.Context, q string, limit int, scope *Scope) ([]*SearchResult, error) {
	v := s.Schema.Vernacular
	fence, fenceArgs := scope.sql(fmt.Sprintf("%q", v.Idx))
	h := &tipHeap{tip: s.Arrays.TipCount}
	for _, variant := range nameVariants(q) {
		// idx is NULL for vernaculars whose taxon has not been resolved to a
		// node yet — the vernacular corpus is keyed by ott_id and by PBDB
		// taxon_no, and not all of those land in the synthesis tree.
		rows, err := s.DB.QueryContext(ctx, fmt.Sprintf(
			`SELECT %q FROM %q WHERE %q >= ? AND %q < ? AND %q IS NOT NULL%s LIMIT ?`,
			v.Idx, v.Table, v.Name, v.Name, v.Idx, fence),
			append(append([]any{variant, prefixBound(variant)}, fenceArgs...), vernacularScanCap)...)
		if err != nil {
			return nil, err
		}
		for rows.Next() {
			var idx sql.NullInt64
			if err := rows.Scan(&idx); err != nil {
				_ = rows.Close()
				return nil, err
			}
			if idx.Valid && s.Arrays.Valid(int(idx.Int64)) {
				h.push(int(idx.Int64), limit)
			}
		}
		err = rows.Err()
		_ = rows.Close()
		if err != nil {
			return nil, err
		}
	}
	idxs := h.sorted()
	if len(idxs) == 0 {
		return nil, nil
	}
	return s.resultsForIdxs(ctx, idxs, "vernacular")
}

func scanNodeResults(rows *sql.Rows, matchedOn string) ([]*SearchResult, error) {
	defer rows.Close() //nolint:errcheck
	var out []*SearchResult
	for rows.Next() {
		var idx int
		var ott sql.NullInt64
		var key string
		var name, rank sql.NullString
		var tip int64
		if err := rows.Scan(&idx, &ott, &key, &name, &rank, &tip); err != nil {
			return nil, err
		}
		i := idx
		t := tip
		r := &SearchResult{
			Kind: "node", Key: key, Idx: &i, Name: nullStr(name),
			Rank: nullStr(rank), TipCount: &t, MatchedOn: matchedOn,
			rankTip: tip,
			// bandExact is 0, so an unset band would silently claim the
			// strongest possible match. Every band is earned, never defaulted.
			band: bandNone, bandOwn: bandNone,
		}
		if ott.Valid {
			v := ott.Int64
			r.OttID = &v
		}
		if name.Valid {
			r.sortName = name.String
		}
		out = append(out, r)
	}
	return out, rows.Err()
}

// searchBroken answers only "is the thing I typed a broken taxon?".
//
// Matches the whole name, not a prefix: a broken taxon is an explanation for a
// specific name, not a candidate competing with real nodes, so a prefix match
// would chase every keystroke with noise (typing "nean" would surface
// *Neanuridae*, not the *Neanderthal* the reader meant).
func (s *Store) searchBroken(qFold string) []SearchResult {
	if qFold == "" {
		return nil
	}
	var out []SearchResult
	for i := range s.broken {
		b := &s.broken[i]
		matched := "name"
		switch {
		case b.fold == qFold:
		case b.foldAbbr != "" && b.foldAbbr == qFold:
			// An abbreviated binomial typed in full is a complete name, so it
			// carries the same evidence. Without this "E. coli" answered
			// *Entamoeba coli*, not *Escherichia coli*, the taxon nearly everyone
			// means.
			matched = "abbreviation"
		default:
			continue
		}
		ott := b.OttID
		r := SearchResult{
			Kind: "broken", Key: b.NodeKey, OttID: &ott,
			MatchedOn: matched, MRCAIdx: b.MRCAIdx,
			band: bandExact, bandOwn: bandExact, sortName: b.Name,
		}
		if b.Name != "" {
			n := b.Name
			r.Name = &n
		}
		n := b.NAttachmentPoints
		r.NAttachmentPoints = &n
		// A broken taxon has no tip_count of its own — it is not in the tree.
		// The substituted MRCA's subtree size is used as a ranking signal only,
		// so that a big broken taxon like Reptilia still surfaces; it is
		// deliberately not reported as this taxon's tip_count.
		if b.MRCAIdx != nil && s.Arrays.Valid(*b.MRCAIdx) {
			r.rankTip = int64(s.Arrays.TipCount[*b.MRCAIdx])
		}
		out = append(out, r)
		// A handful of names are borne by more than one broken taxon —
		// "FamilyI" by four. Explaining the same name four times is not four
		// times the explanation.
		if len(out) >= maxBrokenExplanations {
			break
		}
	}
	return out
}

// maxBrokenExplanations caps how many same-named broken taxa are explained.
const maxBrokenExplanations = 2

// decorate fills the ranking signals from the arrays and optional tables: exact
// match, has-image, has-measured-age, baked score.
//
// Exact match is the primary sort key, judged against every name a node has, not
// just the scientific one ("human" must reach Homo, not Pulex the human flea).
// It also decides where exactness is withdrawn, since an exact match settles
// which name the query is, not which taxon the reader means. Two withdrawals,
// both only demoting a row to bandHead (where clade size decides):
//
//   - A lone bare word recorded for a single species is a category label:
//     "eagle" is all that is recorded for a one-species fossil genus, and ranked
//     above Haliaeetus. Restricted to tip_count ≤ 1, which keeps Serpentes
//     ("snake") and Salmo ("salmon").
//   - An alias the taxon is not headlined by, withdrawn only against a head-word
//     match on a clade outrankRatio times larger (keeps Bos taurus for "cow").
//
// A taxon whose scientific name is the query is never withdrawn (that is bandOwn).
//
// And one promotion: where two taxa are equally entitled to a word, clade size
// picked the larger — right for `beetle` (Coleoptera), wrong for `human`
// (*Homo* beat *Homo sapiens*). English Wikipedia's article title is the
// discriminator: `wiki_evidence = 'title'` on the typed name says which taxon
// the word denotes. It only ever promotes; the mirror rule (withdraw on
// `elsewhere`) was refused, because **Whale** and **Rat** are broad-concept
// pages and Cetacea/*Rattus* are the only claimants there are.
func (s *Store) decorate(ctx context.Context, results []SearchResult, qFold string) error {
	idxs := make([]int, 0, len(results))
	for i := range results {
		r := &results[i]
		if r.Name != nil {
			r.bandOwn = min(r.bandOwn, matchBand(*r.Name, qFold))
		}
		r.band = min(r.band, r.bandOwn)
		if r.Idx == nil {
			continue
		}
		idxs = append(idxs, *r.Idx)
		if a := s.Arrays.AgeMa; a != nil {
			v := a[*r.Idx]
			r.HasAge = !math.IsNaN(float64(v)) && !math.IsInf(float64(v), 0)
		}
		if t := s.Arrays.AgeTier; t != nil {
			r.hasMeas = t[*r.Idx] == 0
		} else {
			r.hasMeas = r.HasAge
		}
	}
	if len(idxs) == 0 {
		return nil
	}
	images, err := s.Images(ctx, idxs)
	if err != nil {
		return err
	}
	scores, err := s.bakedScores(ctx, idxs)
	if err != nil {
		return err
	}
	vern, err := s.BestVernaculars(ctx, idxs)
	if err != nil {
		s.log.Warn("vernacular ranking signal unavailable", "err", err)
		vern = map[int]string{}
	}
	// A node's band is judged against every common name it carries: Canidae
	// matches "dog" through "dog family", not its primary vernacular.
	allVern, err := s.allVernacularNames(ctx, idxs)
	if err != nil {
		s.log.Warn("vernacular band signal unavailable", "err", err)
		allVern = map[int][]VernacularName{}
	}
	for i := range results {
		r := &results[i]
		if r.Idx == nil {
			continue
		}
		names := allVern[*r.Idx]
		for _, n := range names {
			if b := matchBand(n.Name, qFold); b < r.band {
				r.band = b
			}
			// The query *is* this name, and this name titles the taxon's own
			// English article. Recorded whatever band the row ends up in, since
			// it is evidence about the taxon rather than about the match.
			if n.Evidence == wikiTitle && matchBand(n.Name, qFold) == bandExact {
				r.denotes = true
			}
		}
		if r.band != bandExact || r.bandOwn == bandExact {
			continue
		}
		// An article titled with the word, about this taxon, blocks both
		// withdrawals: *Allium cepa* looks like a category label offline, but is
		// the subject of the article "Onion".
		if r.denotes {
			continue
		}
		// A lone bare word recorded for a single species is a label, not a name.
		if len(names) < 2 && r.TipCount != nil && *r.TipCount <= 1 {
			r.band = bandHead
			continue
		}
		// Otherwise the taxon's headline name decides. If that name carries the
		// word, the taxon really is called this and keeps its exactness; if it
		// does not, the claim answers to clade size below.
		if h, ok := vern[*r.Idx]; ok && matchBand(h, qFold) <= bandHead {
			continue
		}
		r.withdrawable = true
	}
	// Against head-word matches only, after the pass above so a label demoted
	// there can be what a rival is measured against.
	var headMax int64
	for i := range results {
		if r := &results[i]; r.band == bandHead && r.TipCount != nil {
			headMax = max(headMax, *r.TipCount)
		}
	}
	for i := range results {
		r := &results[i]
		if r.withdrawable && r.TipCount != nil && *r.TipCount*outrankRatio < headMax {
			r.band = bandHead
		}
	}
	for i := range results {
		r := &results[i]
		if r.Idx == nil {
			continue
		}
		if img, ok := images[*r.Idx]; ok {
			r.HasImage = true
			id := img.PhylopicID
			r.PhylopicID = &id
			if src := img.SourceIdx; src != nil {
				v := *src
				r.SilhouetteSourceIdx = &v
				if s.Arrays.TipCount != nil && s.Arrays.Valid(v) {
					t := int64(s.Arrays.TipCount[v])
					r.SilhouetteSourceTips = &t
				}
			}
			if c := img.CladeIdx; c != nil && s.Arrays.TipCount != nil && s.Arrays.Valid(*c) {
				t := int64(s.Arrays.TipCount[*c])
				r.SilhouetteCladeTips = &t
			}
		}
		if v, ok := scores[*r.Idx]; ok {
			r.score = v
		}
		if v, ok := vern[*r.Idx]; ok {
			r.hasVern = true
			n := v
			r.Vernacular = &n
		}
	}
	return nil
}

func (s *Store) bakedScores(ctx context.Context, idxs []int) (map[int]float64, error) {
	out := map[int]float64{}
	rk := s.Schema.Ranking
	if rk == nil {
		return out, nil
	}
	q := fmt.Sprintf("SELECT %q, %q FROM %q WHERE %q IN (%s)",
		rk.Idx, rk.Score, rk.Table, rk.Idx, placeholders(len(idxs)))
	args := make([]any, len(idxs))
	for i, v := range idxs {
		args[i] = v
	}
	rows, err := s.DB.QueryContext(ctx, q, args...)
	if err != nil {
		return out, err
	}
	defer rows.Close() //nolint:errcheck
	for rows.Next() {
		var idx int
		var score sql.NullFloat64
		if err := rows.Scan(&idx, &score); err != nil {
			return out, err
		}
		if score.Valid {
			out[idx] = score.Float64
		}
	}
	return out, rows.Err()
}

func (s *Store) fillVernaculars(ctx context.Context, results []SearchResult) error {
	if s.Schema.Vernacular == nil || len(results) == 0 {
		return nil
	}
	idxs := make([]int, 0, len(results))
	for i := range results {
		if results[i].Idx != nil {
			idxs = append(idxs, *results[i].Idx)
		}
	}
	if len(idxs) == 0 {
		return nil
	}
	best, err := s.BestVernaculars(ctx, idxs)
	if err != nil {
		return err
	}
	for i := range results {
		if results[i].Idx == nil {
			continue
		}
		if v, ok := best[*results[i].Idx]; ok {
			n := v
			results[i].Vernacular = &n
		}
	}
	return nil
}
