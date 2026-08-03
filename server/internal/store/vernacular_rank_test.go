package store

import (
	"database/sql"
	"log/slog"
	"path/filepath"
	"testing"
)

// The ordering contract between the pipeline and the card.
//
// `usage_rank` is measured by the `names` phase against English Wikipedia's
// title and redirect graph, and the whole point of the column is that nothing
// downstream recomputes it. These tests hold the two halves of that: the store
// hands back the pipeline's order when the column is there, and it degrades to
// the old boolean when it is not — because feature detection over a partially
// built dataset is a documented property of this server, not an accident.
//
// The fixture is *Homo sapiens*'s real name list. `man` is rank 5 because the
// enwiki title `Man` is a different article from `Human`; ranked by string
// length — which is what phase 6 did before this — it would be second.
func rankedBuild(t *testing.T, withRank bool) string {
	t.Helper()
	dir := futureBuild(t)

	db, err := sql.Open("sqlite", "file:"+filepath.Join(dir, "concestor.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close() //nolint:errcheck

	stmts := []string{`DROP TABLE vernacular`}
	if withRank {
		stmts = append(stmts,
			`CREATE TABLE vernacular (idx INTEGER, name TEXT, lang TEXT,
				is_primary INTEGER, usage_rank INTEGER)`,
			`INSERT INTO vernacular VALUES
				(594485, 'men',         'en', 0, 6),
				(594485, 'man',         'en', 0, 5),
				(594485, 'human being', 'en', 0, 3),
				(594485, 'human',       'en', 1, 1),
				(594485, 'humans',      'en', 0, 2),
				(594485, 'human beings','en', 0, 4),
				(588427, 'mammal',      'en', 1, 1)`,
		)
	} else {
		stmts = append(stmts,
			`CREATE TABLE vernacular (idx INTEGER, name TEXT, lang TEXT, is_primary INTEGER)`,
			`INSERT INTO vernacular VALUES
				(594485, 'men',   'en', 0),
				(594485, 'man',   'en', 0),
				(594485, 'human', 'en', 1),
				(588427, 'mammal','en', 1)`,
		)
	}
	for _, s := range stmts {
		if _, err := db.Exec(s); err != nil {
			t.Fatalf("%s: %v", s, err)
		}
	}
	return dir
}

func openRanked(t *testing.T, withRank bool) *Store {
	t.Helper()
	st, err := Open(t.Context(), Options{
		BuildDir: rankedBuild(t, withRank),
		Log:      slog.New(slog.DiscardHandler),
	})
	if err != nil {
		t.Fatalf("opening build: %v", err)
	}
	t.Cleanup(func() { _ = st.Close() })
	return st
}

func TestVernacularsComeBackInThePipelinesOrder(t *testing.T) {
	st := openRanked(t, true)
	if st.Schema.Vernacular.Rank != "usage_rank" {
		t.Fatalf("usage_rank was not detected: %+v", st.Schema.Vernacular)
	}

	got, err := st.Vernaculars(t.Context(), 594485)
	if err != nil {
		t.Fatal(err)
	}
	want := []string{"human", "humans", "human being", "human beings", "man", "men"}
	if len(got) != len(want) {
		t.Fatalf("got %d names, want %d: %+v", len(got), len(want), got)
	}
	for i, w := range want {
		if got[i].Name != w {
			t.Errorf("position %d = %q, want %q (full order %+v)", i, got[i].Name, w, got)
		}
	}
	// The insertion order above is deliberately neither the rank order nor
	// alphabetical, so a query that forgot to sort would fail rather than
	// pass by luck.
	if got[0].Name == "men" {
		t.Error("rows came back in insertion order; the ORDER BY is missing")
	}
}

// A name whose ordinary English referent is a different article must not lead,
// and must not be dropped either — demoted one band, never removed, which is
// the same rule /v1/search applies to a withdrawn exact match.
func TestDemotedNamesSurviveRatherThanVanishing(t *testing.T) {
	st := openRanked(t, true)
	got, err := st.Vernaculars(t.Context(), 594485)
	if err != nil {
		t.Fatal(err)
	}
	seen := map[string]int{}
	for i, v := range got {
		seen[v.Name] = i
	}
	for _, n := range []string{"man", "men"} {
		i, ok := seen[n]
		if !ok {
			t.Errorf("%q was removed; the rule is demotion, not deletion", n)
			continue
		}
		if i == 0 {
			t.Errorf("%q leads the list", n)
		}
	}
}

func TestBestVernacularIsTheLowestRank(t *testing.T) {
	st := openRanked(t, true)
	got, err := st.BestVernaculars(t.Context(), []int{594485, 588427})
	if err != nil {
		t.Fatal(err)
	}
	if got[594485] != "human" {
		t.Errorf("best name for Homo sapiens = %q, want \"human\"", got[594485])
	}
	if got[588427] != "mammal" {
		t.Errorf("best name for Mammalia = %q, want \"mammal\"", got[588427])
	}
}

// The canvas asks a stricter question than the card, and the difference is the
// missing fallback: a headline name or nothing.
//
// On the canvas the common name *replaces* the scientific one rather than
// sitting beside it, so a name the ranking never vouched for would be an
// unranked guess in the only slot that says which taxon a mark is. Silence
// there is not a gap — it is the scientific name, which is never wrong.
func TestHeadlineVernacularIsRankOneOrNothing(t *testing.T) {
	st := openRanked(t, true)
	got, err := st.HeadlineVernaculars(t.Context(), []int{594485, 588427, 1})
	if err != nil {
		t.Fatal(err)
	}
	if got[594485] != "human" {
		t.Errorf("headline for Homo sapiens = %q, want \"human\"", got[594485])
	}
	if got[588427] != "mammal" {
		t.Errorf("headline for Mammalia = %q, want \"mammal\"", got[588427])
	}
	if len(got) != 2 {
		t.Errorf("a node with no names answered anyway: %+v", got)
	}
	// Every lower-ranked name this node carries must be absent. `man` is rank 5
	// because the enwiki title `Man` is a different article, and a canvas that
	// drew it would be captioning our own species with a word about something
	// else.
	for _, name := range got {
		if name == "man" || name == "humans" {
			t.Errorf("a name below rank 1 reached the canvas: %+v", got)
		}
	}
}

// A build predating the `names` phase has no ranking to read, so the switch
// finds no common names and every label stays scientific. That is the intended
// degradation and the reason the method refuses to fall back on its own: the
// weaker answer here is a *wrong name*, not a worse order.
func TestHeadlineVernacularIsSilentWithoutTheColumn(t *testing.T) {
	st := openRanked(t, false)
	got, err := st.HeadlineVernaculars(t.Context(), []int{594485, 588427})
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 0 {
		t.Errorf("names were served from a build that ranked none: %+v", got)
	}
}

// Older builds have no usage_rank. The server must still start, still answer,
// and still put the headline first — worse ordering, never a broken one.
func TestOrderingFallsBackWithoutTheColumn(t *testing.T) {
	st := openRanked(t, false)
	if st.Schema.Vernacular.Rank != "" {
		t.Fatalf("a rank column was resolved where none exists: %+v", st.Schema.Vernacular)
	}
	got, err := st.Vernaculars(t.Context(), 594485)
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 3 || got[0].Name != "human" {
		t.Errorf("preferred-first fallback broke: %+v", got)
	}
	best, err := st.BestVernaculars(t.Context(), []int{594485})
	if err != nil {
		t.Fatal(err)
	}
	if best[594485] != "human" {
		t.Errorf("best name without a rank column = %q", best[594485])
	}
}
