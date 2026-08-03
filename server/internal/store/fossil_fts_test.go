package store

import (
	"database/sql"
	"log/slog"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/lsweigart12/concestor/server/internal/testenv"
)

// `fossil_fts` is the index that stopped `/v1/search` scanning 523,112 rows on
// every keystroke — 100–117 ms in the serving binary, roughly 90% of the
// endpoint, against 0.1–15 ms through the index.
//
// Two things about it are worth a test rather than a comment. Its rowid is a
// `pbdb_taxon_no` and nothing in the schema says so, which is the exact shape of
// the `node_fts.rowid` mistake this project has already paid for: a wrong key
// there does not error, it joins cleanly and describes a different animal. And
// the index narrows the corpus — it matches tokens and token prefixes where the
// old `LIKE '%q%'` also matched inside a word — so the direction of that
// narrowing has to stay one-way.

// fossilBuild assembles a build whose topology arrays are the real ones and
// whose database carries a fossil table, optionally indexed. `rowidOf` maps a
// taxon to the rowid its name is filed under, so a mis-keyed index can be built
// as easily as a correct one.
func fossilBuild(t *testing.T, indexed bool, rowidOf func(taxonNo int) int) string {
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
		INSERT INTO node VALUES (588427, 244265, 'ott244265', 'Mammalia', 'class', '', 9328, 33);

		-- attach_walk is what makes a row a fossil the tree does not contain;
		-- 0 means the taxon is itself a node and is refused outright.
		CREATE TABLE fossil (
			pbdb_taxon_no INTEGER PRIMARY KEY, accepted_no INTEGER, name TEXT NOT NULL,
			rank TEXT, attach_idx INTEGER NOT NULL, attach_walk INTEGER NOT NULL,
			difference TEXT, is_primary INTEGER,
			fea REAL, fla REAL, lea REAL, lla REAL,
			n_occs INTEGER NOT NULL, is_extant INTEGER);
		INSERT INTO fossil VALUES
			(1, 1, 'Triceratops horridus', 'species', 588427, 3, NULL, 1, 68.0, 67.0, 66.0, 66.0, 120, 0),
			(2, 2, 'Eotriceratops',        'genus',   588427, 3, NULL, 1, 72.0, 70.0, 68.0, 68.0,  4, 0),
			(3, 3, 'Zalambdalestidae',     'family',  588427, 2, NULL, 1, 83.6, 72.2, 83.6, 72.2,  9, 0);
	`); err != nil {
		t.Fatal(err)
	}

	if indexed {
		if _, err := db.Exec(`CREATE VIRTUAL TABLE fossil_fts USING fts5(
			name, content='', tokenize='unicode61 remove_diacritics 2')`); err != nil {
			t.Fatal(err)
		}
		rows, err := db.Query(`SELECT pbdb_taxon_no, name FROM fossil`)
		if err != nil {
			t.Fatal(err)
		}
		type row struct {
			no   int
			name string
		}
		var all []row
		for rows.Next() {
			var r row
			if err := rows.Scan(&r.no, &r.name); err != nil {
				t.Fatal(err)
			}
			all = append(all, r)
		}
		if err := rows.Err(); err != nil {
			t.Fatal(err)
		}
		_ = rows.Close()
		for _, r := range all {
			if _, err := db.Exec(`INSERT INTO fossil_fts(rowid, name) VALUES (?, ?)`,
				rowidOf(r.no), r.name); err != nil {
				t.Fatal(err)
			}
		}
	}
	return dir
}

func openFossilBuild(t *testing.T, dir string) *Store {
	t.Helper()
	st, err := Open(t.Context(), Options{BuildDir: dir, Log: slog.New(slog.DiscardHandler)})
	if err != nil {
		t.Fatalf("opening build: %v", err)
	}
	t.Cleanup(func() { _ = st.Close() })
	return st
}

func fossilNames(t *testing.T, st *Store, q string) []string {
	t.Helper()
	list, err := st.SearchFossils(t.Context(), q, 24)
	if err != nil {
		t.Fatal(err)
	}
	out := make([]string, len(list))
	for i, f := range list {
		out[i] = f.Name
	}
	return out
}

func same(t *testing.T) func(int) int { t.Helper(); return func(n int) int { return n } }

// A correctly keyed index is wired up, and answers.
func TestFossilFTSIsUsedWhenTheRowidIsTheTaxon(t *testing.T) {
	st := openFossilBuild(t, fossilBuild(t, true, same(t)))
	if st.Schema.Fossil.FTSTable == "" {
		t.Fatalf("a correct fossil_fts was not wired up; skipped=%v", st.Schema.Skipped)
	}
	if got := fossilNames(t, st, "triceratops"); len(got) != 1 || got[0] != "Triceratops horridus" {
		t.Errorf("triceratops = %v, want [Triceratops horridus]", got)
	}
}

// The one that matters. An index whose rowid addresses a different row must be
// refused, because the failure it causes is silent: the join succeeds and the
// reader is shown the wrong animal.
func TestFossilFTSIsRefusedWhenTheRowidIsNotTheTaxon(t *testing.T) {
	// Every name filed one row along, so `Triceratops horridus` is indexed
	// under the rowid of `Eotriceratops`.
	shifted := func(n int) int { return n%3 + 1 }
	st := openFossilBuild(t, fossilBuild(t, true, shifted))

	if st.Schema.Fossil.FTSTable != "" {
		t.Fatal("a mis-keyed fossil_fts was accepted; a search would silently " +
			"answer about a different taxon")
	}
	why := st.Schema.Skipped["fossil_fts"]
	if !strings.Contains(why, "pbdb_taxon_no") {
		t.Errorf("the refusal must say what it refused and why, got %q", why)
	}
	// The check must be the one that actually distinguishes the two indexes.
	// Reading a column off a contentless index yields NULL and compares equal
	// to nothing, so a name-comparison probe passes here as readily as on a
	// correct index — this asserts the probe went through MATCH instead.
	if strings.Contains(why, "disagree") {
		t.Errorf("the refusal reads like a column comparison, which a "+
			"contentless index cannot answer: %q", why)
	}
	// Refusing the index is not refusing the feature: the scan still answers,
	// and answers as it always did — reaching Eotriceratops inside the word,
	// which is exactly the recall the index trades away.
	if got := fossilNames(t, st, "triceratops"); len(got) != 2 {
		t.Errorf("the fallback scan must still answer, got %v", got)
	}
}

// A build with no index at all is the pre-existing state and must keep working.
func TestFossilSearchFallsBackWithNoIndex(t *testing.T) {
	st := openFossilBuild(t, fossilBuild(t, false, same(t)))
	if st.Schema.Fossil.FTSTable != "" {
		t.Fatal("FTSTable set with no index present")
	}
	// The scan matches inside a word, which is the recall the index trades away.
	got := fossilNames(t, st, "triceratops")
	if len(got) != 2 {
		t.Fatalf("the scan should reach Eotriceratops too, got %v", got)
	}
}

// `lower()` came off the column in both paths — SQLite's LIKE is already
// case-insensitive over ASCII, and the wrapper cost a call and an allocation on
// every one of 523,112 rows. This is the behaviour that had to survive it.
func TestFossilSearchIsCaseInsensitive(t *testing.T) {
	for _, indexed := range []bool{true, false} {
		st := openFossilBuild(t, fossilBuild(t, indexed, same(t)))
		want := fossilNames(t, st, "zalambdalestidae")
		if len(want) != 1 {
			t.Fatalf("indexed=%v: lowercase query returned %v", indexed, want)
		}
		for _, q := range []string{"Zalambdalestidae", "ZALAMBDALESTIDAE", "zAlAmBdAlEsTiDaE"} {
			if got := fossilNames(t, st, q); len(got) != 1 || got[0] != want[0] {
				t.Errorf("indexed=%v: %q = %v, want %v", indexed, q, got, want)
			}
		}
	}
}

// Against the real corpus, and only where the build carries the index: the
// narrowing is one-way. The index may return fewer rows than the scan it
// replaced and may never return one the scan would not, because a row it
// invented would be a row no ranking rule has ever seen.
func TestFossilFTSNeverInventsARow(t *testing.T) {
	st := open(t)
	f := st.Schema.Fossil
	if f == nil || f.FTSTable == "" {
		t.Skip("this build has no fossil_fts")
	}
	for _, q := range []string{"tyrannosaurus", "triceratops", "stegosaur", "rex", "oak", "ca"} {
		var invented int
		err := st.DB.QueryRowContext(t.Context(),
			`SELECT count(*) FROM `+quote(f.FTSTable)+` x WHERE `+quote(f.FTSTable)+
				` MATCH ? AND x.rowid NOT IN (SELECT `+quote(f.TaxonNo)+` FROM `+quote(f.Table)+
				` WHERE `+quote(f.Name)+` LIKE ?)`,
			`"`+q+`"*`, "%"+q+"%").Scan(&invented)
		if err != nil {
			t.Fatal(err)
		}
		if invented != 0 {
			t.Errorf("%q: the index returned %d rows the scan would not", q, invented)
		}
	}
}
