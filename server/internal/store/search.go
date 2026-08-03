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

// Search ranking, per architecture §4: exact match first, then tip_count
// descending, then has-silhouette, then has-measured-age. Ranking ambiguous
// prefixes by subtree size is what makes "can" surface Cantharellales before
// a one-species genus.
//
// Candidate generation has two paths. When node_fts exists it is used. Until
// then the fallback is an indexed prefix range over node.name — SQLite's
// default collation is BINARY, so the query is issued once per plausible
// capitalisation rather than relying on LIKE, which cannot use the index.

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
	// The name that actually matched, when it is not one the row already
	// shows. A synonym or an abbreviation is the whole reason a row is on the
	// page and the only field that contains what the reader typed — without it
	// the row is an unexplained answer, and for *Homo floresiensis* it is an
	// unexplained answer about a different species.
	MatchedName *string `json:"matched_name,omitempty"`

	// Where this row sits in the one ranking that covers both corpora. See
	// {@link Interleave}. Set by /v1/search and nil everywhere else — a random
	// pick and a segment listing are not answers to a query and have no
	// position in one.
	Order *int `json:"order,omitempty"`

	// The silhouette, for callers that draw one. HasImage on its own is a
	// ranking signal; these three are what it takes to *show* the thing, and
	// resolution has already happened by the time HasImage is set, so sending
	// them costs nothing beyond the bytes.
	//
	// CladeTips is the deciding field, not a detail. A silhouette stands for the
	// smallest clade holding both the hit and the drawing, and drawing one that
	// spans a kingdom misinforms where blank merely withholds (architecture §7).
	// The caller cannot judge that without the clade's size, and it has no other
	// way to learn it: the clade is usually not itself in the result set. It is
	// sent here so the palette can apply the same rule as the canvas.
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
	// Candidates kept per prefix variant before the final ranking. tip_count
	// is the dominant sort key once exact matches are separated out, so any
	// value at or above maxSearchLimit yields exactly the same page; the
	// headroom is only for de-duplication across variants and against the
	// vernacular and FTS candidate sets.
	candidatesPerVariant = 128
	// Below this token length the FTS prefix enumeration costs more than the
	// hot-name cache, which answers the same query from memory.
	minFTSToken = 3
	// How much larger a clade has to be, in species, before a head-word match
	// on it withdraws an exact match's exactness. See decorate.
	//
	// The corpus fixes the bounds and they are two orders of magnitude apart,
	// which is the whole reason this is a threshold worth having rather than a
	// number fitted to an example. It must NOT fire for "cow": Bos taurus is
	// headlined "Domestic Cattle" and carries "cow" as an alias, against
	// Sirenia's "sea cows" at 7 tips — a ratio of 7, and Bos taurus is the
	// right answer. It MUST fire for "butterfly": Chaetodon capistratus is
	// headlined "Kete" and carries "Butterfly" as one of nine Caribbean
	// aliases, against Papilionidae's 1,080 tips — a ratio of 1,080.
	outrankRatio = 100
)

func longestToken(q string) int {
	n := 0
	for _, t := range tokens(q) {
		n = max(n, len(t))
	}
	return n
}

// Search runs the typeahead query.
func (s *Store) Search(ctx context.Context, q string, limit int) ([]SearchResult, error) {
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
		if r.Idx == nil {
			return
		}
		// A node reached by several routes keeps the strongest one: a hit on
		// the scientific name beats an FTS hit beats a vernacular hit.
		if prev, ok := byIdx[*r.Idx]; ok && matchStrength(prev.MatchedOn) >= matchStrength(r.MatchedOn) {
			return
		}
		byIdx[*r.Idx] = r
	}

	// FTS5 answers a prefix query by enumerating every indexed term with that
	// prefix. Measured against this corpus: '"homo"*' is 0.4 ms, '"can"*' is
	// 2 ms, and '"a"*' is 90 ms. So the shortest queries — the ones a palette
	// fires on the very first keystroke — go to the hot-name cache instead,
	// which answers them from memory and ranks them identically.
	useFTS := s.Schema.FTS != nil && longestToken(q) >= minFTSToken
	if useFTS {
		rows, err := s.searchFTS(ctx, q, limit*8)
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
		rows, err := s.searchNamePrefix(ctx, q)
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
			rows, err := s.searchVernacular(ctx, q, limit*4)
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
		if ev, err := s.exactVernacularMatches(ctx, q); err != nil {
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
	// slice.
	results = append(results, s.searchBroken(qFold)...)

	if err := s.decorate(ctx, results, qFold); err != nil {
		return nil, err
	}

	sort.SliceStable(results, func(i, j int) bool { return lessResult(&results[i], &results[j]) })
	if len(results) > limit {
		results = results[:limit]
	}
	// The same rank the canvas and the card will show, so a row that italicises
	// *Tyrannosaurus rex* in one place italicises it in all three. After the
	// truncation because it is a display field and no sort reads it — filling it
	// earlier would cost the work on rows nobody sees, and filling it in
	// `lessResult`'s reach would be re-ranking, which `/v1/search` may not do.
	for i := range results {
		if results[i].Idx != nil {
			results[i].Rank = s.rankFor(*results[i].Idx, results[i].Rank)
		}
	}
	if err := s.fillVernaculars(ctx, results); err != nil {
		return nil, err
	}
	if results == nil {
		results = []SearchResult{}
	}
	return results, nil
}

// Interleave puts the two corpora in one order and stamps each row with its
// position in it, in place.
//
// # Why the server does this
//
// Because it is ranking, and `web/` may not rank. The client used to receive
// two lists and pin the fossils to a section at the tail however well they
// matched, which is a defensible answer to a question nobody was asking: the
// reader typing "triceratops" does not want the species that nearly match it
// followed, eventually, by the animal. Both lists are answers to one query and
// they belong in one order — but a client that *computed* that order would be
// the fuzzy-score bug again, where a score the client can see outweighs four
// ranks it cannot. So the order is decided here and travels as an integer.
//
// # The rule, and why the parts are in this order
//
//  1. **Band.** How well the query sits inside the name, from {@link
//     matchBand} — the same function, run over both corpora, which is the whole
//     reason a merge is possible at all. It does nearly all the work: there is
//     no node called *Triceratops*, so the fossil takes the exact band and
//     leads; there is a node called *Canidae* headlined "dog family", so "dog"
//     is a head-word match on a node and no PBDB row gets near it.
//
//  2. **Position within the row's own corpus.** Each list arrives ranked by
//     signals the other has no counterpart for — a node has a subtree size and
//     a common name, a fossil has occurrence counts and a stratigraphic
//     record — and inventing a common scale for those would be inventing a
//     number. Comparing *positions* asks each corpus how good this row is
//     relative to its own best, which is a question both can answer.
//
//  3. **Node before fossil.** The last tiebreak and the smallest claim: where
//     two rows are equally good answers, the one that can join the tree is
//     worth more than the one that can only hang off it.
//
// Broken taxa are left unstamped. They render as a note rather than a row —
// they cannot be picked — so a position in a list of pickable things would be a
// position in a list they are not in.
func Interleave(nodes []SearchResult, fossils []Fossil, q string) {
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
	for n, sl := range slots {
		order := n
		if sl.fossil {
			fossils[sl.i].Order = &order
		} else {
			nodes[sl.i].Order = &order
		}
	}
}

func matchStrength(m string) int {
	switch m {
	case "name":
		return 5
	case "abbreviation":
		return 4
	case "synonym":
		return 3
	case "fts":
		return 2
	case "vernacular":
		return 1
	}
	return 0
}

// matchTier splits "a name this taxon goes by" from "a name it used to go by".
func matchTier(m string) int {
	if m == "synonym" {
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
	// Two taxa can both be called exactly what was typed, and below this line
	// the only thing left to separate them is size — which is the wrong
	// question when the smaller one is the animal the word is *about*. `human`
	// is the case: *Homo* (7 tips) and *Homo sapiens* (2) both carry it, so the
	// genus won and the reader who typed the most ordinary word in the product
	// got the clade containing *H. erectus* and *H. neanderthalensis* instead of
	// themselves. English Wikipedia's article **Human** is *Homo sapiens*'s, and
	// that is a statement about which taxon the word denotes — decided outside
	// this project, by the same instrument name-ranking.md already trusts.
	//
	// It sits *below* the band and above `score` for a reason. It settles ties,
	// never bands: a taxon does not climb past a better-matching name because it
	// owns an article, and nothing is ever demoted for lacking one. Where no
	// candidate holds the title — `shark`, `snake`, `dog`, `cow`, `whale`, and
	// 5,942 of the 6,619 contested names — this line does not fire at all and
	// the ranking is exactly what it was.
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
// The obvious query — range scan ORDER BY tip_count DESC LIMIT 400 — measures
// 65 ms for a one-character prefix, because SQLite has to leave the covering
// index and seek the primary key for every one of 268,281 candidate rows just
// to sort them. The index-only scan of the same range is 3.5 ms.
//
// So the ranking happens here instead: take idx alone (index-only), read
// tip_count straight out of the mmap'd array, keep the best K in a bounded
// heap, and fetch full rows for only those. Same answer, one order of
// magnitude cheaper.
func (s *Store) searchNamePrefix(ctx context.Context, q string) ([]*SearchResult, error) {
	seen := make(map[int]struct{})
	var idxs []int
	add := func(list []int) {
		for _, idx := range list {
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
	// a one-character query from touching 268,281 index entries.
	hot := s.hotPrefixMatches(q, candidatesPerVariant)
	add(hot)
	if len(hot) < candidatesPerVariant {
		for _, v := range nameVariants(q) {
			top, err := s.topByTipCount(ctx, v, candidatesPerVariant)
			if err != nil {
				return nil, err
			}
			add(top)
		}
	}
	// An exact match can be a one-species node far outside the hot set, and it
	// has to rank first. One indexed equality lookup per capitalisation.
	exact, err := s.exactNameMatches(ctx, q)
	if err != nil {
		return nil, err
	}
	add(exact)

	if len(idxs) == 0 {
		return nil, nil
	}
	return s.resultsForIdxs(ctx, idxs, "name")
}

func (s *Store) exactNameMatches(ctx context.Context, q string) ([]int, error) {
	var out []int
	for _, v := range nameVariants(q) {
		rows, err := s.DB.QueryContext(ctx, `SELECT idx FROM node WHERE name = ?`, v)
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
func (s *Store) topByTipCount(ctx context.Context, prefix string, k int) ([]int, error) {
	rows, err := s.DB.QueryContext(ctx,
		`SELECT idx FROM node WHERE name >= ? AND name < ?`, prefix, prefixBound(prefix))
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
var nameKind = map[int64]string{0: "name", 1: "abbreviation", 2: "synonym", 3: "vernacular"}

// kindBrokenName is search_name.kind for a broken taxon's name. The row's idx
// is the MRCA that swallowed the taxon, not the taxon — it has no idx, being
// rejected from synthesis. `searchBroken` answers for these.
const kindBrokenName = 4

// ftsScanCap bounds the rows pulled out of the FTS index before de-duplication.
// The index holds one row per *name* — 6.8M rows against 2.7M nodes — so a
// heavily-synonymised taxon can occupy dozens of them. De-duplication has to
// happen before the page is cut, or one taxon fills the whole palette.
const ftsScanCap = 4000

func (s *Store) searchFTS(ctx context.Context, q string, limit int) ([]*SearchResult, error) {
	expr := ftsPrefixQuery(q)
	if expr == "" {
		return nil, nil
	}
	f := s.Schema.FTS
	kind := "NULL"
	if f.MapKind != "" {
		kind = "m." + fmt.Sprintf("%q", f.MapKind)
	}
	// node_fts.rowid is a search_name.id, NOT a node.idx. Joining it straight
	// to node does not error — it joins cleanly to unrelated nodes and returns
	// confident nonsense, which is exactly what it did.
	rows, err := s.DB.QueryContext(ctx, fmt.Sprintf(
		`SELECT m.%q, %s, m.%q FROM %q f JOIN %q m ON m.%q = f.rowid WHERE %q MATCH ? LIMIT ?`,
		f.MapIdx, kind, f.MapName, f.Table, f.MapTable, f.MapID, f.Table), expr, ftsScanCap)
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

		// One row, three questions, and they had been sharing one answer.
		//
		//   bands[idx] — how well did the best name match?
		//   kinds[idx] — which name should be reported as the reason?
		//   tiers[idx] — is any name matched one the taxon still goes by?
		//
		// A node matching through several names can differ on all three, and
		// Metazoa did: it reached "animal" through the synonym *Animalia* and
		// the vernacular *animals*. Reporting the strongest name picked the
		// synonym, which then cost it the ranking, and it fell below five-tip
		// bacteria and off the end of the candidate cut — searching "animal"
		// did not return the animals at all.
		//
		// So the reason reported is the name that actually won the band, with
		// strength only breaking ties. That is what makes matched_on true: the
		// vernacular is why Metazoa is on the page, and crediting the synonym
		// pointed at a name that lost.
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
		// row has no other way to mention is the whole point.
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
func (s *Store) exactVernacularMatches(ctx context.Context, q string) (map[int]struct{}, error) {
	out := map[int]struct{}{}
	v := s.Schema.Vernacular
	if v == nil {
		return out, nil
	}
	for _, variant := range nameVariants(q) {
		rows, err := s.DB.QueryContext(ctx, fmt.Sprintf(
			`SELECT %q FROM %q WHERE %q = ? AND %q IS NOT NULL`,
			v.Idx, v.Table, v.Name, v.Idx), variant)
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

func (s *Store) searchVernacular(ctx context.Context, q string, limit int) ([]*SearchResult, error) {
	v := s.Schema.Vernacular
	h := &tipHeap{tip: s.Arrays.TipCount}
	for _, variant := range nameVariants(q) {
		// idx is NULL for vernaculars whose taxon has not been resolved to a
		// node yet — the vernacular corpus is keyed by ott_id and by PBDB
		// taxon_no, and not all of those land in the synthesis tree.
		rows, err := s.DB.QueryContext(ctx, fmt.Sprintf(
			`SELECT %q FROM %q WHERE %q >= ? AND %q < ? AND %q IS NOT NULL LIMIT ?`,
			v.Idx, v.Table, v.Name, v.Name, v.Idx),
			variant, prefixBound(variant), vernacularScanCap)
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

// searchBroken answers the question "is the thing I typed a broken taxon?" —
// and only that question.
//
// It used to match on prefix, which was wrong in a way that made the palette
// worse the more of a name you typed. A broken taxon is not a candidate answer
// competing with real nodes: it is an explanation for a specific name, useful
// only to someone who meant that name. On a prefix, 9,839 of them chase every
// keystroke — typing "nean" put *Neanastatinae* and *Neanuridae* on the page
// alongside 22 real genera, and neither is what anyone reaching for
// *Neanderthal* wanted. Matching the whole name keeps the promise that matters
// (ask for Dinosauria and we say why it is not there, rather than silently
// answering about Archosauria) and drops the noise, which was all of it.
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
			// The whole-name rule, kept. An abbreviated binomial typed in full
			// is a complete name and not a prefix, so it carries the same
			// evidence that the person meant *this* taxon — which is the whole
			// reason the rule is "the whole name" rather than "a prefix of it".
			// Without this "E. coli" answered *Entamoeba coli* and never
			// mentioned *Escherichia coli*, the taxon nearly everyone means.
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

// decorate fills the ranking signals that live in the arrays and the optional
// tables: exact match, has-image, has-measured-age, baked score.
//
// Exact match is the primary sort key (architecture §4) and it is judged
// against every name a node has, not just its scientific one. "human" must
// reach Homo (7 tips) rather than Pulex, the human flea (22 tips); "T. rex"
// must reach Tyrannosaurus rex through its abbreviation.
//
// It also decides where exactness is *withdrawn*, which is the second half of
// that judgement and the one nothing had. An exact match settles which name
// the query is; it does not settle which taxon the reader means, because a
// common name can be filed against a taxon far below the group it names. Two
// withdrawals, both measured over 77 everyday words, and both only ever
// demoting a row to bandHead — where clade size decides — never below it:
//
//   - **A lone bare word recorded for a single species is a category label.**
//     PBDB's ColDP vernacular field carries group words ("belemnite" on 33
//     taxa, "heart urchin" on 25), and when it is the only thing anyone has
//     written down about a one-species taxon, the word says what kind of thing
//     it is rather than what it is called. "eagle" is the whole of what is
//     recorded for Miraquila, a one-species fossil genus, and it ranked above
//     Haliaeetus, the sea eagles. Restricting this to tip_count ≤ 1 is what
//     keeps Serpentes ("snake"), Nephropoidea ("lobster") and Salmo
//     ("salmon") — clades whose one recorded name is genuinely their name.
//
//   - **An alias the taxon is not headlined by answers to clade size.** If a
//     taxon's own headline name does not carry the word at all, an exact match
//     on one of its other aliases is a coincidence of naming: Chaetodon
//     capistratus is headlined "Kete" and carries "Butterfly" as one of nine
//     Caribbean aliases. Withdrawn only against a head-word match on a clade
//     outrankRatio times larger, which is what keeps Bos taurus ("cow", against
//     Sirenia's "sea cows") and Rattus norvegicus (headlined "Brown Rat", so
//     never eligible at all).
//
// A taxon whose *scientific* name is the query is never withdrawn — that is
// what bandOwn is for.
//
// # And one promotion, which is the other half of the same judgement
//
// Withdrawing exactness answers "this taxon is probably not what the word
// means" from offline signals. Nothing answered the positive form, so two taxa
// equally entitled to the word fell through to clade size — and the *larger*
// won. That is right for `beetle`, where Coleoptera holds it against two
// one-species beetles, and wrong for `human`, where *Homo* (7 tips) beat
// *Homo sapiens* (2).
//
// **English Wikipedia's article title is the discriminator**, and it is the
// instrument `docs/name-ranking.md` §2 already uses — read here for a
// different question than the one it answers there. `usage_rank` orders one
// taxon's own names and is display-only; an *article title* is held by one
// taxon and no other, so `wiki_evidence = 'title'` on the name the reader typed
// says which taxon that word denotes. Measured over the 6,619 English names
// more than one node claims: 663 have exactly one titled claimant, 5,942 have
// none, and **14 have two or more** — every one of those a monotypic pair with
// identical tip counts (Sphenisciformes/Spheniscidae at 59, Gaviidae/Gavia at
// 7), where the two answers are the same set of species and the tie does not
// matter. The leader changes on 358 names: `onion` to *Allium cepa* from the
// 1,048-tip genus *Allium*, `hare` to *Lepus* from Leporidae (which is also the
// rabbits), `perch` to *Perca* from Percidae, `mayfly` to Ephemeroptera from
// **Tipulidae**, the crane flies.
//
// It only ever promotes, and that is deliberate rather than timid. The mirror
// rule — withdraw an exact match whose evidence is `elsewhere`, i.e. a real
// English article by that name that is *not* this taxon's — was written,
// measured and refused: "whale" on Cetacea and "rat" on *Rattus norvegicus* are
// both `elsewhere` (the articles **Whale** and **Rat** are broad-concept pages)
// and both are the only exact claimant there is, so withdrawing them demotes
// the right answer with nothing better to promote. `snail` is `elsewhere` on
// all four of its claimants including Gastropoda. Absence of a title is not
// evidence against a taxon — the same rule `name-ranking.md` states for NULL.
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
	// A node's band has to be judged against *every* common name it carries:
	// Canidae matches "dog" as a whole word through "dog family", which is not
	// its primary vernacular.
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
		// Both withdrawals below ask "is this bare word really this taxon's
		// name, or a label somebody filed against it?". An article titled with
		// the word, about this taxon, answers that outright, so neither runs.
		// *Allium cepa* is the shape: one species, and "onion" is the whole of
		// what is recorded for it — a category label by every offline signal
		// available, and the title of the article about the onion.
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
	// The comparison is against head-word matches only, and it is made after
	// the pass above so that a label demoted there can be the thing a rival is
	// measured against.
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
