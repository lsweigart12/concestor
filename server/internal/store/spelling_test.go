package store

import (
	"database/sql"
	"log/slog"
	"os"
	"path/filepath"
	"slices"
	"testing"

	"github.com/lsweigart12/concestor/server/internal/testenv"
)

// The typo fallback, and the two things about it that a comment cannot hold.
//
// The first is the **cross-language contract**. `spellingKey` here and
// `spelling_key` in the pipeline are two implementations of one function, and
// when they disagree nothing errors: the lookup returns an empty bucket, which
// is indistinguishable from a word nobody misspelled. `TestKeyAgreesWithTheBuiltIndex`
// is the only thing that can catch it, and it asks the question the right way
// round — recompute the key for words taken out of the built table and require
// the stored value back — because a test written against invented pairs proves
// the two functions agree about the pairs somebody thought of.
//
// The second is **refusal**. A corrector is easy to make more forgiving and the
// pressure runs one way: somebody will meet `hard maple` returning nothing and
// reach for the distance cap. `TestRefuses` is what makes that reach fail, and
// the list it walks is the same one the pipeline gates on.

func TestSpellingKey(t *testing.T) {
	// Each pair is a misspelling and the word it must reach. If a key change
	// breaks one of these it has broken recall, whatever else it improved.
	for _, c := range []struct{ a, b string }{
		{"aardvark", "ardvark"},
		{"betula", "betual"},
		{"rhinoceros", "rinoceros"},
		{"dolphin", "dolfin"},
		{"gorilla", "gorila"},
		{"cheetah", "cheeta"},
		{"penguin", "pengiun"},
		{"tyrannosaurus", "tyranosaurus"},
		{"mosquito", "mosquitto"},
	} {
		if x, y := spellingKey(c.a), spellingKey(c.b); x != y {
			t.Errorf("spellingKey(%q) = %q, spellingKey(%q) = %q; want equal", c.a, x, c.b, y)
		}
	}
	for _, c := range []struct{ in, want string }{
		{"aardvark", "ardvrk"},
		{"betula", "btl"},
		{"rhinoceros", "rncrs"},
		{"dolphin", "dlfn"},
		{"homo", "hm"}, // a leading h is kept; only a silent one goes
		// The benchmark string keeps a key of its own. Folding z to s and q to
		// k — the obvious next English sound rules — would put it in a bucket
		// with 69 real candidates, which is why those rules are not there.
		{"zzzqqq", "zq"},
	} {
		if got := spellingKey(c.in); got != c.want {
			t.Errorf("spellingKey(%q) = %q, want %q", c.in, got, c.want)
		}
	}
}

func TestSpellingWords(t *testing.T) {
	if got := spellingWords("Betula pendula"); !slices.Equal(got, []string{"betula", "pendula"}) {
		t.Errorf("got %q", got)
	}
	if got := spellingWords("Abbott's Sea-eagle"); !slices.Equal(got, []string{"abbott", "s", "sea", "eagle"}) {
		t.Errorf("got %q", got)
	}
	// Refused whole rather than split around the accent: `aapaj` and `rvensis`
	// are not words, and a corrector let loose on them would correct them to
	// other things. The pipeline drops the same 0.27% of the corpus.
	if got := spellingWords("aapajärvensis"); got != nil {
		t.Errorf("non-ASCII should yield no words, got %q", got)
	}
}

func TestDamerauCountsATranspositionOnce(t *testing.T) {
	// The reason this is Damerau and not Levenshtein. Under plain Levenshtein
	// `betual` is two edits from `betula` *and* two from `betel`, a different
	// plant, and the shorter string wins the tie — which is exactly what the
	// first version of this did.
	if d := damerau("betual", "betula", 2); d != 1 {
		t.Errorf("betual/betula = %d, want 1", d)
	}
	if d := damerau("betual", "betel", 2); d != 2 {
		t.Errorf("betual/betel = %d, want 2", d)
	}
	// The budget is an argument rather than a filter on the answer, so a hopeless
	// pair costs a band of the matrix instead of all of it.
	if d := damerau("zzzqqq", "zaqiqah", 1); d <= 1 {
		t.Errorf("zzzqqq/zaqiqah = %d, want > 1", d)
	}
	if d := damerau("dog", "dog", 1); d != 0 {
		t.Errorf("identical = %d, want 0", d)
	}
}

// The distance has to forgive what the key forgave, and it did not.
//
// `dolfin` and `dolphin` share a key — TestSpellingKey above asserts it — and
// then the raw distance charged two edits for the difference, over a cap of one
// on a six-character word. So every pair this sound rule exists for died at the
// last step: against the real corpus `dolfin` came back *dolfyn*, a genus one
// ordinary edit away, and `elefant` came back with nothing. The key's measured
// 19/20 was a claim about which bucket a word lands in and nothing checked what
// happened after it landed.
//
// The cap is not what changed and must not be what changes: 2 is still 2 here.
func TestTheDistanceFoldsWhatTheKeyFolds(t *testing.T) {
	if d := damerau("dolfin", "dolphin", 2); d != 2 {
		t.Errorf("raw dolfin/dolphin = %d, want 2 — the cap is unchanged", d)
	}
	if d := damerau(foldPH("dolfin"), foldPH("dolphin"), 2); d != 0 {
		t.Errorf("folded dolfin/dolphin = %d, want 0", d)
	}
	if d := damerau(foldPH("elefant"), foldPH("elephant"), 1); d != 0 {
		t.Errorf("folded elefant/elephant = %d, want 0", d)
	}
	// And nothing else moves. A fold that started swallowing ordinary edits
	// would be the wider cap this is careful not to be.
	if d := damerau(foldPH("betual"), foldPH("betel"), 2); d != 2 {
		t.Errorf("folded betual/betel = %d, want 2", d)
	}
}

func TestDistanceCapIsRelativeToLength(t *testing.T) {
	if got := distanceCap("betual"); got != 1 {
		t.Errorf("short cap = %d, want 1", got)
	}
	if got := distanceCap("triceratopps"); got != 2 {
		t.Errorf("long cap = %d, want 2", got)
	}
}

// spellingStore builds a store whose topology is the real one and whose
// database holds a hand-written spelling index — enough to exercise every rule
// without the 1.9 GB corpus.
func spellingStore(t *testing.T, words map[string]int) *Store {
	t.Helper()
	real := testenv.RequireBuild(t)
	dir := t.TempDir()
	if err := os.Symlink(filepath.Join(real, "topology"), filepath.Join(dir, "topology")); err != nil {
		t.Fatal(err)
	}
	db, err := sql.Open("sqlite", "file:"+filepath.Join(dir, "concestor.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close() //nolint:errcheck
	if _, err := db.Exec(`
		CREATE TABLE node (idx INTEGER PRIMARY KEY, ott_id INTEGER, node_key TEXT NOT NULL,
			name TEXT, rank TEXT, flags TEXT, tip_count INTEGER NOT NULL, depth INTEGER NOT NULL);
		CREATE TABLE spelling (key TEXT NOT NULL, word TEXT NOT NULL, n INTEGER NOT NULL);
		CREATE INDEX spelling_key ON spelling(key);`); err != nil {
		t.Fatal(err)
	}
	for w, n := range words {
		if _, err := db.Exec(`INSERT INTO spelling VALUES (?,?,?)`, spellingKey(w), w, n); err != nil {
			t.Fatal(err)
		}
	}
	if err := db.Close(); err != nil {
		t.Fatal(err)
	}
	st, err := Open(t.Context(), Options{BuildDir: dir, Log: slog.New(slog.DiscardHandler)})
	if err != nil {
		t.Fatalf("opening store: %v", err)
	}
	t.Cleanup(func() { _ = st.Close() })
	return st
}

func TestSuggest(t *testing.T) {
	st := spellingStore(t, map[string]int{
		"aardvark": 3, "betula": 9, "pendula": 40, "sugar": 30, "maple": 12,
		"hard": 5, "dolphin": 8, "sag": 60, "abut": 4,
		// A real taxon name that is also a common misspelling of another word.
		"racoon": 1,
	})
	for _, c := range []struct{ in, want, why string }{
		{"ardvark", "aardvark", "the typo pulled from the query log"},
		{"betual pendula", "betula pendula", "only the misspelled word moves"},
		{"hard maple", "", "a real name the corpus lacks is not a typo"},
		{"suag", "", "below the length floor, where every false correction lived"},
		{"racoon", "", "a word the corpus holds is not a typo"},
		{"zzzqqq", "", "nothing within the cap"},
		{"", "", "an empty query has no words"},
	} {
		got, err := st.Suggest(t.Context(), c.in)
		if err != nil {
			t.Fatalf("Suggest(%q): %v", c.in, err)
		}
		if got != c.want {
			t.Errorf("Suggest(%q) = %q, want %q — %s", c.in, got, c.want, c.why)
		}
	}
}

func TestSuggestIsSilentWithoutTheIndex(t *testing.T) {
	// Every build predating the index, where a query that found nothing simply
	// finds nothing — the same answer as before, which is why nothing
	// downstream needs a fallback of its own.
	st := open(t)
	st.Schema.Spelling = nil
	got, err := st.Suggest(t.Context(), "ardvark")
	if err != nil || got != "" {
		t.Errorf("got (%q, %v), want (\"\", nil)", got, err)
	}
}

// --------------------------------------------------------------------------
// Against the built corpus
// --------------------------------------------------------------------------

func requireSpelling(t *testing.T) *Store {
	t.Helper()
	st := open(t)
	if st.Schema.Spelling == nil {
		t.Skip("no spelling table; run `concestor-build search`")
	}
	return st
}

// TestKeyAgreesWithTheBuiltIndex is the contract between this file and
// `spelling.py`. See the header.
//
// Sampled from both ends of the keyspace, because a key computed by an older
// version of either function agrees across a whole region and diverges outside
// it — the same reason `fossil_index_miskeyed` samples both ends.
func TestKeyAgreesWithTheBuiltIndex(t *testing.T) {
	st := requireSpelling(t)
	n := 0
	for _, dir := range []string{"ASC", "DESC"} {
		rows, err := st.DB.QueryContext(t.Context(),
			`SELECT key, word FROM spelling ORDER BY word `+dir+` LIMIT 1000`)
		if err != nil {
			t.Fatal(err)
		}
		for rows.Next() {
			var key, word string
			if err := rows.Scan(&key, &word); err != nil {
				t.Fatal(err)
			}
			if got := spellingKey(word); got != key {
				t.Errorf("spellingKey(%q) = %q, but the pipeline stored %q", word, got, key)
			}
			n++
		}
		if err := rows.Err(); err != nil {
			t.Fatal(err)
		}
		_ = rows.Close()
	}
	if n == 0 {
		t.Fatal("no rows sampled; the index is empty")
	}
}

func TestCorrectsRealMisspellings(t *testing.T) {
	st := requireSpelling(t)
	// The first three were typed at concestor.com and pulled from Workers Logs.
	// The rest are the ordinary English misspellings a curious reader makes.
	// Kept in step with `spelling.CORRECTIONS` in the pipeline, which gates on
	// the same list.
	for _, c := range []struct{ in, want string }{
		{"ardvark", "aardvark"},
		// The `ph`/`f` pair the key was built for. Neither reached its answer
		// until the distance folded the same sound; see
		// TestTheDistanceFoldsWhatTheKeyFolds.
		{"elefant", "elephant"},
		{"dolfin", "dolphin"},
		{"betual", "betula"},
		{"betual pendula", "betula pendula"},
		{"rinoceros", "rhinoceros"},
		{"gorila", "gorilla"},
		{"cheeta", "cheetah"},
		{"mosquitto", "mosquito"},
		{"aligator", "alligator"},
		{"pengiun", "penguin"},
		{"triceratopps", "triceratops"},
	} {
		got, err := st.Suggest(t.Context(), c.in)
		if err != nil {
			t.Fatalf("Suggest(%q): %v", c.in, err)
		}
		if got != c.want {
			t.Errorf("Suggest(%q) = %q, want %q", c.in, got, c.want)
		}
	}
}

// The gate in front of the corrector, measured against the corpus rather than
// asserted about it.
//
// This is the test the empty-list gate never had. It assumed a typo returns
// nothing; over 2.3M names plus 523k fossil taxa a typo usually returns *one*
// thing, and the correction was then suppressed because the list was not empty.
// The other half matters just as much and is the reason the row count is in
// {@link Answer.Weak} at all: a reader part-way through a name the corpus holds
// is indistinguishable from a misspeller by the band alone — `elefant` is a live
// prefix of *Paradileptus elefantinus* exactly as `giraff` is one of Giraffidae
// — and what separates them is how much of the corpus lives under the string.
//
// The limit is the one `web/src/palette/Palette.tsx` asks for. Both sides of
// this test move if that changes, which is why it is written down here.
func TestJunkAnswersAreWeakAndTypeaheadIsNot(t *testing.T) {
	st := requireSpelling(t)
	const limit = 24
	answer := func(q string) Answer {
		t.Helper()
		res, err := st.Search(t.Context(), q, limit)
		if err != nil {
			t.Fatalf("Search(%q): %v", q, err)
		}
		fos, err := st.SearchFossils(t.Context(), q, limit)
		if err != nil {
			t.Fatalf("SearchFossils(%q): %v", q, err)
		}
		return Interleave(res, fos, q)
	}
	for _, c := range []struct {
		q    string
		weak bool
		why  string
	}{
		// The query from the issue. One row, a single-celled ciliate, reached
		// through the synonym *Paradileptus elefantinus* — so the old gate saw a
		// non-empty list and said nothing.
		{"elefant", true, "one ciliate is not an answer about elephants"},
		{"mamal", true, "a fruit fly and four things named after a beach"},
		{"cheeta", true, "four rows, none of them a cheetah"},
		{"elephent", true, "nothing at all, which is the bottom of this scale"},
		// And the other side: a reader who is simply not finished typing. None of
		// these may reach the corrector, and the reason they do not is the row
		// count — every one of them is weak-banded.
		{"giraff", false, "a full page of giraffes, mid-word"},
		{"tyrannosau", false, "ten rows of tyrannosaurs; the correction on offer is `tyrannos`"},
		{"stegosaur", false, "twenty rows of stegosaurs"},
		{"quercus rob", false, "two words, the second unfinished"},
		{"homo sapie", false, "the most ordinary query in the product, one letter short"},
		// Answered outright, so the question never arises.
		{"elephant", false, "an exact match"},
		{"dog", false, "a head-word match on Canidae"},
	} {
		if got := answer(c.q); got.Weak() != c.weak {
			t.Errorf("%q: Weak() = %v (band %d, %d rows), want %v — %s",
				c.q, got.Weak(), got.Band, got.Rows, c.weak, c.why)
		}
	}
}

// `mamal` is five characters, under minCorrectedWord, where the subsystem's
// precision lives. Lowering that floor is relaxing the matcher, which is not
// done; the fix for `mamal` getting no suggestion is phase 6 coverage.
func TestMamalIsRefusedByTheLengthFloorAndNotByTheGate(t *testing.T) {
	st := requireSpelling(t)
	got, err := st.Suggest(t.Context(), "mamal")
	if err != nil {
		t.Fatal(err)
	}
	if got != "" {
		t.Errorf("Suggest(\"mamal\") = %q; the length floor is load-bearing and "+
			"nothing in this change may have moved it", got)
	}
}

func TestRefuses(t *testing.T) {
	st := requireSpelling(t)
	// Each is a different way this could go wrong rather than nine of the same
	// test. `hard maple` and `hard oak` are real names phase 6 lacks and are the
	// whole subject of the issue; `zzzqqq` is this project's own benchmark
	// string and is in the query log; `suag`, `abot` and `amt` are short-word
	// false positives; `about` is a *command*, answered client-side; `pleasy`
	// has 75 candidates in its bucket and none within a single edit; `dog` and
	// `whale` are ordinary queries that already work.
	for _, q := range []string{
		"hard maple", "hard oak", "zzzqqq", "suag", "abot",
		"about", "pleasy", "amt", "dog", "whale",
	} {
		got, err := st.Suggest(t.Context(), q)
		if err != nil {
			t.Fatalf("Suggest(%q): %v", q, err)
		}
		if got != "" {
			t.Errorf("Suggest(%q) = %q, want no correction", q, got)
		}
	}
}
