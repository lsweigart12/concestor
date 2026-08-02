package store

import (
	"context"
	"fmt"
	"math"
	"slices"
	"strings"
	"testing"

	"github.com/lsweigart12/concestor/server/internal/topo"
)

// node_fts.rowid is a search_name.id, not a node.idx. Joining it straight to
// `node` does not error: it joins cleanly to entirely unrelated nodes and
// returns confident nonsense — `q=dog` came back as three unnamed mrcaott…
// internal nodes. A test that only asserts "some rows came back" passes
// against that bug, so these assert that the rows are *the right rows*.

func TestSearchResultsAreActuallyRelatedToTheQuery(t *testing.T) {
	st := open(t)
	if st.Schema.FTS == nil {
		t.Skip("node_fts not wired up in this build")
	}
	ctx := t.Context()

	for _, q := range []string{"dog", "human", "shark", "Homo", "Tyrannosaurus", "T. rex"} {
		res, err := st.Search(ctx, q, 10)
		if err != nil {
			t.Fatalf("%q: %v", q, err)
		}
		if len(res) == 0 {
			t.Errorf("%q returned nothing", q)
			continue
		}
		for _, r := range res {
			if r.Idx == nil {
				continue // broken taxa are matched on their own name in memory
			}
			// An unnamed mrca* divergence point can never be a search hit: it
			// has no name of any kind. Seeing one is the signature of a bad
			// rowid join.
			if r.Name == nil {
				t.Errorf("%q returned idx %d with a null name — an unnamed "+
					"divergence point cannot match a text query", q, *r.Idx)
				continue
			}
			ok, err := st.nodeHasNameContaining(ctx, *r.Idx, q)
			if err != nil {
				t.Fatal(err)
			}
			if !ok {
				t.Errorf("%q returned %q (idx %d), which carries no name "+
					"containing the query", q, *r.Name, *r.Idx)
			}
		}
	}
}

// nodeHasNameContaining checks the node really owns a name — scientific,
// abbreviation, synonym or vernacular — matching the query's first token.
func (s *Store) nodeHasNameContaining(ctx context.Context, idx int, q string) (bool, error) {
	tok := strings.ToLower(q)
	if i := strings.IndexAny(tok, " ."); i > 0 {
		tok = tok[:i]
	}

	f := s.Schema.FTS
	rows, err := s.DB.QueryContext(ctx, fmt.Sprintf(
		`SELECT %q FROM %q WHERE %q = ?`, f.MapName, f.MapTable, f.MapIdx), idx)
	if err != nil {
		return false, err
	}
	defer rows.Close() //nolint:errcheck
	for rows.Next() {
		var n string
		if err := rows.Scan(&n); err != nil {
			return false, err
		}
		if strings.Contains(strings.ToLower(n), tok) {
			return true, nil
		}
	}
	if err := rows.Err(); err != nil {
		return false, err
	}

	if v := s.Schema.Vernacular; v != nil {
		var n int
		q := fmt.Sprintf(`SELECT count(*) FROM %q WHERE %q = ? AND lower(%q) LIKE ?`,
			v.Table, v.Idx, v.Name)
		if err := s.DB.QueryRowContext(ctx, q, idx, "%"+tok+"%").Scan(&n); err != nil {
			return false, err
		}
		return n > 0, nil
	}
	return false, nil
}

// Exact match is the primary sort key (architecture §4). These are the queries
// management.md names as the product's front door.
func TestExactMatchOutranksLargerSubtrees(t *testing.T) {
	st := open(t)
	if st.Schema.Vernacular == nil {
		t.Skip("vernaculars not built in this build")
	}
	cases := []struct {
		q    string
		want string
		why  string
	}{
		{"human", "Homo", "Homo has 7 tips; Pulex, the human flea, has 22 and must not win"},
		{"shark", "Selachii", "an exact common name beats a longer one"},
		{"T. rex", "Tyrannosaurus rex", "the abbreviation is indexed as search_name.kind=1"},
		{"Homo sapiens", "Homo sapiens", "an exact scientific name"},
	}
	for _, c := range cases {
		res, err := st.Search(t.Context(), c.q, 10)
		if err != nil {
			t.Fatalf("%q: %v", c.q, err)
		}
		if len(res) == 0 {
			t.Errorf("%q returned nothing", c.q)
			continue
		}
		if res[0].Name == nil || *res[0].Name != c.want {
			got := "<nil>"
			if res[0].Name != nil {
				got = *res[0].Name
			}
			t.Errorf("%q -> %q, want %q (%s)", c.q, got, c.want, c.why)
		}
	}
}

// One heavily-synonymised taxon must not fill the palette: the FTS index has
// one row per name, so de-duplication has to happen before the page is cut.
func TestSearchDeduplicatesNodesAcrossTheirNames(t *testing.T) {
	st := open(t)
	if st.Schema.FTS == nil {
		t.Skip("node_fts not wired up")
	}
	for _, q := range []string{"Tyrannosaurus", "Homo", "rex"} {
		res, err := st.Search(t.Context(), q, 20)
		if err != nil {
			t.Fatal(err)
		}
		seen := map[int]bool{}
		for _, r := range res {
			if r.Idx == nil {
				continue
			}
			if seen[*r.Idx] {
				t.Errorf("%q returned idx %d more than once", q, *r.Idx)
			}
			seen[*r.Idx] = true
		}
	}
}

// matched_on tells the UI *why* a row matched. It comes from search_name.kind.
func TestMatchedOnReportsTheKindOfNameThatHit(t *testing.T) {
	st := open(t)
	if st.Schema.FTS == nil || st.Schema.FTS.MapKind == "" {
		t.Skip("no kind column")
	}
	res, err := st.Search(t.Context(), "T. rex", 5)
	if err != nil {
		t.Fatal(err)
	}
	if len(res) == 0 {
		t.Fatal("no results")
	}
	if res[0].MatchedOn != "abbreviation" {
		t.Errorf("matched_on = %q, want abbreviation", res[0].MatchedOn)
	}
}

// An exact whole-word match must outrank a mid-word prefix match, regardless
// of subtree size. Without the band rule "dog" ranks Apocynaceae ("dogbane
// family", 7,050 tips) above Canidae ("dog family", 211) — and "dog" is the
// example management.md uses for the palette being broken at the front door.
// The failure is subtle enough to come back if it is not pinned.
func TestWholeWordMatchOutranksMidWordPrefix(t *testing.T) {
	st := open(t)
	if st.Schema.Vernacular == nil {
		t.Skip("vernaculars not built")
	}
	res, err := st.Search(t.Context(), "dog", 20)
	if err != nil {
		t.Fatal(err)
	}
	rank := map[string]int{}
	for i, r := range res {
		if r.Name != nil {
			rank[*r.Name] = i
		}
	}
	canid, okC := rank["Canidae"]
	if !okC {
		t.Fatalf("Canidae is not in the results for \"dog\": %v", names(res))
	}
	if apo, ok := rank["Apocynaceae"]; ok && apo < canid {
		t.Errorf("\"dog\": Apocynaceae (dogbane family) at %d beats Canidae "+
			"(dog family) at %d — a mid-word prefix must not outrank a whole word",
			apo, canid)
	}
	// Whatever is first must match "dog" as a whole word or exactly.
	if res[0].Name == nil {
		t.Fatal("first result has no name")
	}
	best := matchBand(*res[0].Name, "dog")
	for _, v := range mustVernaculars(t, st, res[0]) {
		best = min(best, matchBand(v, "dog"))
	}
	if best > bandToken {
		t.Errorf("first result %q matches \"dog\" only at band %d", *res[0].Name, best)
	}
}

func mustVernaculars(t *testing.T, st *Store, r SearchResult) []string {
	t.Helper()
	if r.Idx == nil {
		return nil
	}
	all, err := st.allVernacularNames(t.Context(), []int{*r.Idx})
	if err != nil {
		t.Fatal(err)
	}
	return all[*r.Idx]
}

func names(res []SearchResult) []string {
	out := make([]string, 0, len(res))
	for _, r := range res {
		if r.Name != nil {
			out = append(out, *r.Name)
		}
	}
	return out
}

// A deprecated synonym is a weaker signal than a name the taxon goes by.
func TestSynonymHitsRankBelowCurrentNames(t *testing.T) {
	st := open(t)
	if st.Schema.FTS == nil {
		t.Skip("node_fts not wired up")
	}
	res, err := st.Search(t.Context(), "Can", 20)
	if err != nil {
		t.Fatal(err)
	}
	firstSynonym, lastCurrent := -1, -1
	for i, r := range res {
		if r.Kind == "broken" {
			continue
		}
		if r.MatchedOn == "synonym" {
			if firstSynonym < 0 {
				firstSynonym = i
			}
		} else {
			lastCurrent = i
		}
	}
	if firstSynonym >= 0 && lastCurrent > firstSynonym {
		t.Errorf("a synonym hit at %d outranks a current-name hit at %d: %v",
			firstSynonym, lastCurrent, names(res))
	}
}

// A broken taxon's name is filed in search_name against the MRCA that
// swallowed it, because that is the node the client draws once the app has
// explained itself. That row must never come back as an ordinary node hit:
// doing so answers about the substitute, silently, which is the live Open Tree
// behaviour handoff.md §3 exists to refuse. Searching "Dinosauria" returned a
// node called *Sauria*, ranked above the explanation.
func TestABrokenTaxonsNameNeverReturnsTheSubstitutedNode(t *testing.T) {
	st := open(t)
	if st.Schema.FTS == nil {
		t.Skip("node_fts not wired up in this build")
	}
	ctx := t.Context()

	for _, c := range []struct{ q, substitute string }{
		{"Dinosauria", "Sauria"},
		{"Escherichia coli", ""},
	} {
		res, err := st.Search(ctx, c.q, 10)
		if err != nil {
			t.Fatalf("%q: %v", c.q, err)
		}
		var explained bool
		for _, r := range res {
			if r.Kind == "broken" && r.Name != nil && strings.EqualFold(*r.Name, c.q) {
				explained = true
			}
			if r.Kind == "broken" || r.Name == nil {
				continue
			}
			// A real node whose own name contains the query is fine —
			// "Escherichia coli O157:H7" is a genuine taxon. The substitute is
			// not: it does not bear the name at all.
			if c.substitute != "" && strings.EqualFold(*r.Name, c.substitute) {
				t.Errorf("%q returned the substituted node %q as a node hit; "+
					"the app must explain the broken taxon, not silently "+
					"answer about what replaced it", c.q, *r.Name)
			}
		}
		if !explained {
			t.Errorf("%q did not come back explained as a broken taxon", c.q)
		}
	}
}

// Metazoa's English name is "animals" and it holds 1.49M tips. It matched
// "animal" through both a vernacular and the synonym *Animalia*, and two
// separate defects then buried it: the ranking took its tier from the
// strongest name reported rather than the best one matched, so reporting
// "synonym" demoted it; and a plural counted only as a prefix, so it lost the
// whole-word band to a Wikidata alias reading "arthropod animal". It fell
// below five-tip bacteria and off the end of the page entirely.
func TestTheWordAnimalReachesTheAnimals(t *testing.T) {
	st := open(t)
	if st.Schema.FTS == nil {
		t.Skip("node_fts not wired up in this build")
	}
	res, err := st.Search(t.Context(), "animal", 10)
	if err != nil {
		t.Fatal(err)
	}
	for i, r := range res {
		if r.Name != nil && *r.Name == "Metazoa" {
			if i > 2 {
				t.Errorf("Metazoa ranked %d for \"animal\"; it is the answer", i)
			}
			return
		}
	}
	names := make([]string, 0, len(res))
	for _, r := range res {
		if r.Name != nil {
			names = append(names, *r.Name)
		}
	}
	t.Errorf("\"animal\" did not return Metazoa at all; got %v", names)
}

// "E. coli" is what people type, and *Escherichia coli* is a broken taxon so
// `search.py` generated no abbreviation for it — the abbreviation corpus comes
// from `node`, and a broken taxon is precisely what is not in there. The query
// answered *Entamoeba coli* and never mentioned the bacterium.
func TestAnAbbreviatedBinomialReachesABrokenTaxon(t *testing.T) {
	st := open(t)
	res, err := st.Search(t.Context(), "E. coli", 10)
	if err != nil {
		t.Fatal(err)
	}
	for _, r := range res {
		if r.Kind == "broken" && r.Name != nil && *r.Name == "Escherichia coli" {
			if r.MatchedOn != "abbreviation" {
				t.Errorf("matched_on = %q, want \"abbreviation\"", r.MatchedOn)
			}
			return
		}
	}
	t.Error("\"E. coli\" never mentioned Escherichia coli")
}

func TestAbbreviateBinomial(t *testing.T) {
	for name, want := range map[string]string{
		"Tyrannosaurus rex":      "T. rex",
		"Escherichia coli":       "E. coli",
		"Canis lupus familiaris": "C. l. familiaris",
		"Dinosauria":             "", // uninomial: nothing to abbreviate
		"T. rex":                 "", // already abbreviated
		"":                       "",
	} {
		if got := abbreviateBinomial(name); got != want {
			t.Errorf("abbreviateBinomial(%q) = %q, want %q", name, got, want)
		}
	}
}

// The fourth age tier's constraints, checked at the boundary the client sees.
//
// handoff §7 makes four of them non-negotiable, and two are checkable here:
// a range never enters age_ma, and it is a range rather than a point. The
// pipeline gates the arrays; this gates what leaves the process, because the
// two are separate programs sharing only files.
func TestAnOccurrenceRangeIsNeverAnAge(t *testing.T) {
	st := open(t)
	if st.Schema.Occurrence == nil {
		t.Skip("occurrence table not in this build")
	}
	ctx := t.Context()

	var idxs []int
	rows, err := st.DB.QueryContext(ctx, "SELECT idx FROM occurrence LIMIT 500")
	if err != nil {
		t.Fatal(err)
	}
	for rows.Next() {
		var i int
		if err := rows.Scan(&i); err != nil {
			t.Fatal(err)
		}
		idxs = append(idxs, i)
	}
	_ = rows.Close()
	if len(idxs) == 0 {
		t.Fatal("occurrence table is empty")
	}

	occs, err := st.Occurrences(ctx, idxs)
	if err != nil {
		t.Fatal(err)
	}
	a := st.Arrays
	empty := 0
	for _, idx := range idxs {
		o, ok := occs[idx]
		if !ok {
			t.Errorf("idx %d has an occurrence row but no range came back", idx)
			continue
		}
		if a.AgeTier != nil && a.AgeTier[idx] != topo.TierOccurrence {
			t.Errorf("idx %d carries a range at tier %d", idx, a.AgeTier[idx])
		}
		// The constraint that matters most: no confident number.
		if a.AgeMa != nil && !math.IsNaN(float64(a.AgeMa[idx])) {
			t.Errorf("idx %d carries both a fossil range and an age_ma of %v",
				idx, a.AgeMa[idx])
		}
		if o.Fea == nil || o.Lla == nil {
			t.Errorf("idx %d has no envelope", idx)
			continue
		}
		if *o.Fea < *o.Lla {
			t.Errorf("idx %d envelope runs backwards: %v -> %v", idx, *o.Fea, *o.Lla)
		}
		if o.Fla != nil && o.Lea != nil && *o.Fla < *o.Lea {
			empty++
		}
	}
	// Not an error — the point of asserting it. For 60.4% of PBDB taxa the
	// certain extent is empty, because everything known comes from a single
	// interval, and a renderer that assumes fla >= lea draws those inverted.
	if empty == 0 {
		t.Error("no sampled node had an empty certain extent; expected most of " +
			"them to, so either the sample or the assumption is wrong")
	}
	t.Logf("%d of %d sampled nodes have no certain extent", empty, len(idxs))
}

// A common word that names a group must reach the group, not a taxon that
// happens to be labelled with it. All three of these were wrong in the running
// app and each was wrong for a different reason (handoff.md §7):
//
//   - "butterfly" returned *Chaetodon capistratus*, a butterflyfish headlined
//     "Kete" and carrying "Butterfly" as one of nine Caribbean aliases
//   - "eagle" returned *Miraquila*, a one-species fossil genus whose only
//     recorded common name is PBDB's category label "eagle"
//   - "oak" returned *Usnea* ("Oak moss", a lichen) and *Enaphalodes* ("Oak
//     Borer", a beetle), because no node carries the bare word at all and
//     nothing separated a name the word modifies from a name it is
func TestGroupWordsReachTheGroup(t *testing.T) {
	st := open(t)
	if st.Schema.Vernacular == nil {
		t.Skip("vernaculars not built")
	}
	cases := []struct {
		q    string
		want []string
		why  string
	}{
		{"butterfly", []string{"Papilionidae"},
			"a nine-alias local name on one fish must not outrank the swallowtails"},
		{"eagle", []string{"Haliaeetus", "Aquila", "Aquila chrysaetos", "Accipitridae"},
			"a fossil genus labelled 'eagle' must not outrank the living eagles"},
		{"oak", []string{"Quercus petraea", "Quercus robur", "Quercus castaneifolia"},
			"Quercus is a broken taxon, so an oak species is the best answer there is"},
		// The guards. Each of these is a taxon whose exactness must survive.
		{"dog", []string{"Canis lupus familiaris", "Canis familiaris", "Canis lupus"},
			"the Dog is what 'dog' means, against six taxa called something-dog"},
		{"cow", []string{"Bos taurus"},
			"headlined 'Domestic Cattle', so 'cow' is an alias — but Sirenia's " +
				"'sea cows' is only 7 tips and must not take it"},
		{"rat", []string{"Rattus norvegicus"},
			"headlined 'Brown Rat', which carries the word, so never withdrawable"},
		{"human", []string{"Homo", "Homo sapiens"},
			"one recorded common name, but seven tips — not a category label"},
		{"snake", []string{"Serpentes"},
			"one recorded common name on 4,156 tips is that clade's name"},
		{"beetle", []string{"Coleoptera"}, "the same, at 287,458 tips"},
	}
	for _, c := range cases {
		res, err := st.Search(t.Context(), c.q, 10)
		if err != nil {
			t.Fatalf("%q: %v", c.q, err)
		}
		if len(res) == 0 || res[0].Name == nil {
			t.Errorf("%q returned nothing usable", c.q)
			continue
		}
		if !slices.Contains(c.want, *res[0].Name) {
			t.Errorf("%q -> %q, want one of %v (%s); got %v",
				c.q, *res[0].Name, c.want, c.why, names(res))
		}
	}
}

// The withdrawal demotes a row by one band. It never removes it, and it never
// touches the taxon's own name — which is the promise that makes the rule
// safe to apply on evidence as thin as "this is a bare word on one species".
//
// *Chaetodon capistratus* is still on the page for "butterfly", 30 rows down
// among the butterflies, which is where a fish called Butterfly belongs.
// *Miraquila* is not, and that is the band doing its job rather than an
// exception to it: there are more than fifty living eagles above it.
func TestAWithdrawnExactMatchKeepsItsOwnName(t *testing.T) {
	st := open(t)
	if st.Schema.Vernacular == nil {
		t.Skip("vernaculars not built")
	}
	res, err := st.Search(t.Context(), "butterfly", 50)
	if err != nil {
		t.Fatal(err)
	}
	if !slices.Contains(names(res), "Chaetodon capistratus") {
		t.Errorf("\"butterfly\" no longer returns Chaetodon capistratus at all: %v",
			names(res))
	}
	for _, name := range []string{"Chaetodon capistratus", "Miraquila"} {
		res, err := st.Search(t.Context(), name, 5)
		if err != nil {
			t.Fatal(err)
		}
		if len(res) == 0 || res[0].Name == nil || *res[0].Name != name {
			t.Errorf("%q no longer answers itself: %v", name, names(res))
		}
	}
}
