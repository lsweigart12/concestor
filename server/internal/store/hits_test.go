package store

import (
	"os"
	"path/filepath"
	"regexp"
	"testing"
)

// The empty palette's suggestions, checked against the dataset they claim to
// describe.
//
// This test reads a TypeScript file, which wants justifying. The curated list
// lives in `web/` because which animals a curious reader recognises is an
// editorial judgement that belongs beside the copy it serves — see
// `hits.go` for the other half of that argument. But the claims the list makes
// are all claims about *this database*: that the taxon exists, that it has a
// name a stranger can read, that its drawing is its own. None of those can be
// checked from inside `web/`, where there is no dataset, and none of them fail
// loudly — a starter that quietly resolves to nothing is one fewer row, and a
// starter wearing a borrowed silhouette is a beetle drawn as a mole.
//
// So the file is the input and the database is the oracle, which is the same
// shape as `viewport.test.ts` reading `styles.css`: pin the fact where the fact
// can actually be established. Nielsen Norman's hardest rule about suggested
// queries is that every one of them must lead somewhere good, and this is the
// only place in the repository where that is a checkable statement.

// startersRe pulls the quoted keys out of the exported array. Deliberately
// anchored on the `ott` prefix rather than on any string in the file, so a
// comment, an import or the `RECENT_LIMIT` constant below it cannot be mistaken
// for a taxon.
var startersRe = regexp.MustCompile(`"(ott\d+)"`)

// readStarters returns the curated keys, or fails. It does not skip: an
// unreadable list is a broken test rather than an absent dataset, and the two
// must not be reported the same way.
func readStarters(t *testing.T) []string {
	t.Helper()
	const rel = "web/src/palette/starters.ts"
	wd, err := os.Getwd()
	if err != nil {
		t.Fatal(err)
	}
	// Up from server/internal/store to the checkout root. Six, matching
	// testenv's walk, so this behaves the same way in a worktree.
	for range 6 {
		p := filepath.Join(wd, rel)
		if _, err := os.Stat(p); err == nil {
			raw, err := os.ReadFile(p) //nolint:gosec // a path this test derived
			if err != nil {
				t.Fatal(err)
			}
			var keys []string
			for _, m := range startersRe.FindAllStringSubmatch(string(raw), -1) {
				keys = append(keys, m[1])
			}
			if len(keys) == 0 {
				t.Fatalf("%s: found no ott keys — has the array been renamed?", rel)
			}
			return keys
		}
		parent := filepath.Dir(wd)
		if parent == wd {
			break
		}
		wd = parent
	}
	t.Fatalf("could not find %s from %s", rel, wd)
	return nil
}

// TestStartersAreDrawableAndNamed is the gate on the curated list.
//
// Four claims, and the last two are the ones a reader would actually notice:
//
//   - **It resolves.** A retired OTT id costs the palette a row, silently.
//   - **It has a name.** The row's title.
//   - **`climb = 0`.** The drawing is of this taxon or of something inside it.
//     Phase 5 gives all 2.7M nodes an image by climbing to a relative, so
//     `has_image` is true of everything and means nothing; and `hitSilhouette`
//     ships with suppression dialled to infinity, so a borrowed picture renders
//     without complaint. Nothing else in the stack will catch this.
//   - **A rank-1 English common name.** The row subtitles the scientific name
//     with the vernacular, and a starter without one says only *Blaberus
//     giganteus* to an audience of curious people. This is the constraint that
//     rejected the cockroach, the cremini and the horse ant.
func TestStartersAreDrawableAndNamed(t *testing.T) {
	st := open(t)
	keys := readStarters(t)

	got, err := st.HitsForKeys(t.Context(), keys)
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != len(keys) {
		// Which ones, not just how many: a count leaves the next person running
		// the query by hand.
		seen := map[string]bool{}
		for _, r := range got {
			seen[r.Key] = true
		}
		for _, k := range keys {
			if !seen[k] {
				t.Errorf("%s: resolves to nothing — retired, forwarded past, or broken", k)
			}
		}
		t.Fatalf("asked for %d starters, got %d", len(keys), len(got))
	}

	for _, r := range got {
		if r.Idx == nil {
			t.Errorf("%s: no idx, so nothing the palette can add", r.Key)
			continue
		}
		name := ""
		if r.Name != nil {
			name = *r.Name
		}
		if name == "" {
			t.Errorf("%s: no name to put in the row's title", r.Key)
		}
		if r.MatchedOn != matchedOnKey {
			t.Errorf("%s: matched_on = %q, want %q — nothing was typed", name, r.MatchedOn, matchedOnKey)
		}
		if r.Vernacular == nil || *r.Vernacular == "" {
			t.Errorf("%s: no rank-1 English common name, so the row is Latin only", name)
		}
		if r.PhylopicID == nil || *r.PhylopicID == "" {
			t.Errorf("%s: no drawing", name)
		}
		if climb := climbFor(t, st, *r.Idx); climb != 0 {
			// The silent one. A borrowed picture draws perfectly happily and
			// belongs to something else.
			t.Errorf("%s: node_image.climb = %d, want 0 — the drawing is borrowed", name, climb)
		}
	}
}

// TestStartersKeepTheirCuratedOrder pins the half of the contract the list
// itself cannot enforce.
//
// The order is a ranking by pull on a first-time reader — the human leads
// because a row about *you* needs no other hook — and `resultsForIdxs` hands
// rows back in whatever order the chunked IN scan produces, which for SQLite is
// idx order. That is the tree's own preorder: a stable, plausible-looking
// ordering that would silently replace somebody's judgement with taxonomy.
func TestStartersKeepTheirCuratedOrder(t *testing.T) {
	st := open(t)
	keys := readStarters(t)
	got, err := st.HitsForKeys(t.Context(), keys)
	if err != nil {
		t.Fatal(err)
	}
	for i, r := range got {
		if i < len(keys) && r.Key != keys[i] {
			t.Errorf("position %d: got %s, want %s", i, r.Key, keys[i])
		}
	}
}

// TestHitsForKeysSkipsWhatItCannotFind is the contract that keeps one retired
// id from costing the whole empty state.
func TestHitsForKeysSkipsWhatItCannotFind(t *testing.T) {
	st := open(t)
	real := readStarters(t)[0]

	got, err := st.HitsForKeys(t.Context(), []string{"ott999999999", real, "nonsense"})
	if err != nil {
		t.Fatalf("one bad key must not fail the request: %v", err)
	}
	if len(got) != 1 || got[0].Key != real {
		t.Fatalf("got %d rows, want just %s", len(got), real)
	}

	// Every key unknown is an empty list and not an error, for the same reason:
	// the caller has a fallback and a 500 takes it away from them.
	empty, err := st.HitsForKeys(t.Context(), []string{"ott999999999"})
	if err != nil {
		t.Fatal(err)
	}
	if len(empty) != 0 {
		t.Fatalf("got %d rows for an unknown key", len(empty))
	}
}

// TestHitsForKeysDeduplicates covers the case a shared URL makes easy to hit:
// the same taxon named twice, or named once by ott id and once by node key.
func TestHitsForKeysDeduplicates(t *testing.T) {
	st := open(t)
	real := readStarters(t)[0]
	got, err := st.HitsForKeys(t.Context(), []string{real, real})
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 1 {
		t.Fatalf("got %d rows for the same key twice, want 1", len(got))
	}
}

func climbFor(t *testing.T, st *Store, idx int) int {
	t.Helper()
	if st.Schema.NodeImage == nil || st.Schema.NodeImage.Climb == "" {
		t.Skip("this build has no node_image.climb")
	}
	var climb int
	err := st.DB.QueryRowContext(t.Context(),
		"SELECT "+st.Schema.NodeImage.Climb+" FROM "+st.Schema.NodeImage.Table+
			" WHERE "+st.Schema.NodeImage.Idx+" = ?", idx).Scan(&climb)
	if err != nil {
		t.Errorf("idx %d: no node_image row at all: %v", idx, err)
		return -1
	}
	return climb
}
