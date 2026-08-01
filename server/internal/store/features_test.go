package store

import (
	"database/sql"
	"log/slog"
	"os"
	"path/filepath"
	"testing"

	"github.com/lsweigart12/concestor/server/internal/testenv"
)

// The tables below do not exist yet: other agents are adding node_fts,
// vernacular, silhouette, node_image and a search-ranking table concurrently.
// These tests build a database that has them, over the real topology arrays,
// so that the optional code paths are exercised now rather than discovered
// broken on the day they land.

// TestFTS5IsAvailableInTheDriver guards the choice of modernc.org/sqlite. The
// search design depends on FTS5 (architecture §4); a driver without it would
// be a concrete reason to reconsider.
func TestFTS5IsAvailableInTheDriver(t *testing.T) {
	db, err := sql.Open("sqlite", "file:ftsprobe?mode=memory")
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close() //nolint:errcheck
	if _, err := db.Exec(`CREATE VIRTUAL TABLE node_fts USING fts5(
		name, synonyms, content='', tokenize='unicode61 remove_diacritics 2')`); err != nil {
		t.Fatalf("FTS5 is not compiled into the driver: %v", err)
	}
	if _, err := db.Exec(`INSERT INTO node_fts(rowid, name, synonyms) VALUES (594485,'Homo sapiens','human')`); err != nil {
		t.Fatal(err)
	}
	var rowid int
	if err := db.QueryRow(`SELECT rowid FROM node_fts WHERE node_fts MATCH ?`, `"homo"*`).Scan(&rowid); err != nil {
		t.Fatalf("prefix MATCH failed: %v", err)
	}
	if rowid != 594485 {
		t.Fatalf("rowid = %d", rowid)
	}
}

// futureBuild assembles a build directory whose topology arrays are the real
// ones (symlinked) and whose database carries the schema the pipeline is
// growing towards.
func futureBuild(t *testing.T) string {
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

	_, err = db.Exec(`
		CREATE TABLE node (idx INTEGER PRIMARY KEY, ott_id INTEGER, node_key TEXT NOT NULL,
			name TEXT, rank TEXT, flags TEXT, tip_count INTEGER NOT NULL, depth INTEGER NOT NULL);
		CREATE INDEX node_name ON node(name) WHERE name IS NOT NULL;
		INSERT INTO node VALUES
			(594485, 770315, 'ott770315', 'Homo sapiens', 'species', '', 2, 59),
			(588427, 244265, 'ott244265', 'Mammalia', 'class', '', 9328, 33),
			(594475, NULL,   'mrcaott786ott6182', NULL, NULL, '', 4, 55);

		-- One FTS row per NAME, with search_name mapping rowid back to a node.
		-- This is the real shape: node_fts.rowid is a search_name.id, never a
		-- node.idx.
		CREATE VIRTUAL TABLE node_fts USING fts5(sci, abbr, syn, vern,
			content='', tokenize='unicode61 remove_diacritics 2');
		CREATE TABLE search_name (id INTEGER PRIMARY KEY, idx INTEGER NOT NULL,
			kind INTEGER NOT NULL, name TEXT NOT NULL);
		INSERT INTO search_name VALUES
			(1000001, 594485, 0, 'Homo sapiens'),
			(1000002, 594485, 1, 'H. sapiens'),
			(1000003, 594485, 3, 'human'),
			(1000004, 588427, 0, 'Mammalia'),
			(1000005, 588427, 3, 'mammal');
		INSERT INTO node_fts(rowid, sci, abbr, syn, vern) VALUES
			(1000001, 'Homo sapiens', '', '', ''),
			(1000002, '', 'H. sapiens', '', ''),
			(1000003, '', '', '', 'human'),
			(1000004, 'Mammalia', '', '', ''),
			(1000005, '', '', '', 'mammal');

		CREATE TABLE vernacular (idx INTEGER, name TEXT, lang TEXT, is_preferred INTEGER);
		INSERT INTO vernacular VALUES
			(594485, 'human', 'en', 1), (594485, 'people', 'en', 0),
			(588427, 'mammal', 'en', 1);

		CREATE TABLE silhouette (phylopic_id TEXT PRIMARY KEY, license_url TEXT,
			attribution TEXT, contributor TEXT, commercial_ok INTEGER);
		INSERT INTO silhouette VALUES
			('abc-123', 'https://creativecommons.org/licenses/by/4.0/', 'A Creator', 'B Uploader', 1);

		CREATE TABLE node_image (idx INTEGER PRIMARY KEY, phylopic_id TEXT, source_idx INTEGER);
		INSERT INTO node_image VALUES (594485, 'abc-123', 588427);

		CREATE TABLE synonym (idx INTEGER, name TEXT);
		INSERT INTO synonym VALUES (594485, 'Homo sapiens Linnaeus 1758');

		CREATE TABLE search_rank (idx INTEGER PRIMARY KEY, rank_score REAL);
		INSERT INTO search_rank VALUES (594485, 9.5), (588427, 1.0);

		CREATE TABLE fossil (
			pbdb_taxon_no INTEGER PRIMARY KEY, name TEXT NOT NULL, rank TEXT,
			attach_idx INTEGER NOT NULL, difference TEXT,
			fea REAL, fla REAL, lea REAL, lla REAL,
			n_occs INTEGER NOT NULL, is_extant INTEGER);
		INSERT INTO fossil VALUES
			(1, 'Tyrannosaurus', 'genus', 588427, NULL, 72.1, 70.6, 66.0, 66.0, 400, 0),
			(2, 'Tyrannosaurus', 'genus', 588427, 'subjective synonym of', 72.1, 70.6, 66.0, 66.0, 400, 0),
			(3, 'Obscurosaurus', 'genus', 588427, NULL, NULL, NULL, NULL, NULL, 1, NULL);
	`)
	if err != nil {
		t.Fatal(err)
	}
	return dir
}

func TestOptionalTablesAreDetectedAndUsed(t *testing.T) {
	dir := futureBuild(t)
	st, err := Open(t.Context(), Options{BuildDir: dir, Log: slog.New(slog.DiscardHandler)})
	if err != nil {
		t.Fatalf("opening a future build: %v", err)
	}
	defer st.Close() //nolint:errcheck

	sc := st.Schema
	if sc.FTS == nil || sc.Vernacular == nil || sc.Silhouette == nil ||
		sc.NodeImage == nil || sc.Synonym == nil || sc.Ranking == nil {
		t.Fatalf("feature detection missed something: %+v", sc)
	}
	if sc.Vernacular.Lang != "lang" || sc.Vernacular.Preferred != "is_preferred" {
		t.Errorf("vernacular columns resolved to %+v", sc.Vernacular)
	}
	if sc.Silhouette.Creator != "attribution" || sc.Silhouette.Uploader != "contributor" {
		t.Errorf("creator and uploader must resolve separately, got %+v", sc.Silhouette)
	}
	if sc.NodeImage.SourceIdx != "source_idx" {
		t.Errorf("node_image columns resolved to %+v", sc.NodeImage)
	}
	if sc.FTS.MapTable != "search_name" || sc.FTS.MapID != "id" ||
		sc.FTS.MapIdx != "idx" || sc.FTS.MapName != "name" || sc.FTS.MapKind != "kind" {
		t.Errorf("FTS must resolve through the rowid mapping table, got %+v", sc.FTS)
	}
	if sc.Ranking.Score != "rank_score" {
		t.Errorf("ranking score column resolved to %q", sc.Ranking.Score)
	}
	if sc.Fossil == nil || !sc.Fossil.Brackets {
		t.Errorf("fossil schema resolved to %+v", sc.Fossil)
	}
	if st.CountVernaculars != 3 || st.CountSilhouettes != 1 {
		t.Errorf("counts = %d vernaculars, %d silhouettes", st.CountVernaculars, st.CountSilhouettes)
	}
	if len(sc.Skipped) != 0 {
		t.Errorf("nothing should have been skipped: %v", sc.Skipped)
	}

	ctx := t.Context()

	imgs, err := st.Images(ctx, []int{594485, 588427})
	if err != nil {
		t.Fatal(err)
	}
	got, ok := imgs[594485]
	if !ok || got.PhylopicID != "abc-123" || got.SourceIdx == nil || *got.SourceIdx != 588427 {
		t.Errorf("image = %+v", got)
	}

	att, err := st.SilhouetteAttribution(ctx, "abc-123")
	if err != nil || att == nil {
		t.Fatalf("attribution: %v", err)
	}
	if att.Creator == nil || *att.Creator != "A Creator" {
		t.Errorf("creator = %v", att.Creator)
	}
	if att.Uploader == nil || *att.Uploader != "B Uploader" {
		t.Errorf("uploader = %v — creator and uploader differ 31%% of the time", att.Uploader)
	}

	vern, err := st.Vernaculars(ctx, 594485)
	if err != nil {
		t.Fatal(err)
	}
	if len(vern) != 2 || vern[0].Name != "human" || !vern[0].Preferred {
		t.Errorf("vernaculars = %+v, want the preferred one first", vern)
	}

	syn, err := st.Synonyms(ctx, NodeMeta{Idx: 594485})
	if err != nil || len(syn) != 1 {
		t.Errorf("synonyms = %v %v", syn, err)
	}
}

// "dog" and "T. rex" are the front door. Once vernaculars exist, a query that
// matches only a common name must still return the node.
func TestSearchFindsNodesByVernacularOnce(t *testing.T) {
	dir := futureBuild(t)
	st, err := Open(t.Context(), Options{BuildDir: dir, Log: slog.New(slog.DiscardHandler)})
	if err != nil {
		t.Fatal(err)
	}
	defer st.Close() //nolint:errcheck

	// "human" shares no prefix with "Homo sapiens", so the only route to the
	// node is the common name.
	res, err := st.Search(t.Context(), "human", 10)
	if err != nil {
		t.Fatal(err)
	}
	if len(res) == 0 {
		t.Fatal("a vernacular-only query returned nothing")
	}
	found := false
	for _, r := range res {
		if r.Idx != nil && *r.Idx == 594485 {
			found = true
			if r.MatchedOn != "vernacular" {
				t.Errorf("matched_on = %q, want vernacular", r.MatchedOn)
			}
			if r.Vernacular == nil || *r.Vernacular != "human" {
				t.Errorf("vernacular = %v", r.Vernacular)
			}
		}
	}
	if !found {
		t.Errorf("Homo sapiens not found by its common name: %+v", res)
	}

	// "mammal" reaches Mammalia through the capitalisation variants of the
	// scientific-name index, which is the fallback path doing its job.
	res, err = st.Search(t.Context(), "mammal", 10)
	if err != nil {
		t.Fatal(err)
	}
	if len(res) == 0 || res[0].Idx == nil || *res[0].Idx != 588427 {
		t.Errorf("mammal -> %+v", res)
	}
}

func TestSearchUsesFTSAndImageSignalWhenPresent(t *testing.T) {
	dir := futureBuild(t)
	st, err := Open(t.Context(), Options{BuildDir: dir, Log: slog.New(slog.DiscardHandler)})
	if err != nil {
		t.Fatal(err)
	}
	defer st.Close() //nolint:errcheck

	res, err := st.Search(t.Context(), "Homo", 10)
	if err != nil {
		t.Fatal(err)
	}
	if len(res) == 0 {
		t.Fatal("no results")
	}
	if res[0].Idx == nil || *res[0].Idx != 594485 {
		t.Fatalf("first result = %+v", res[0])
	}
	if !res[0].HasImage {
		t.Error("has_image should be true once node_image exists")
	}
	if res[0].Vernacular == nil || *res[0].Vernacular != "human" {
		t.Errorf("vernacular = %v", res[0].Vernacular)
	}
}

// A table that exists but whose columns cannot be resolved is reported, not
// guessed at. Silently picking a column is how a build ships wrong data.
func TestUnresolvableTableIsSkippedAndReported(t *testing.T) {
	real := testenv.RequireBuild(t)
	dir := t.TempDir()
	if err := os.Symlink(filepath.Join(real, "topology"), filepath.Join(dir, "topology")); err != nil {
		t.Fatal(err)
	}
	db, err := sql.Open("sqlite", "file:"+filepath.Join(dir, "concestor.db"))
	if err != nil {
		t.Fatal(err)
	}
	_, err = db.Exec(`
		CREATE TABLE node (idx INTEGER PRIMARY KEY, ott_id INTEGER, node_key TEXT NOT NULL,
			name TEXT, rank TEXT, flags TEXT, tip_count INTEGER NOT NULL, depth INTEGER NOT NULL);
		CREATE TABLE vernacular (surprise TEXT, unexpected TEXT);
		CREATE TABLE search_rank (idx INTEGER, rank REAL);
	`)
	if err != nil {
		t.Fatal(err)
	}
	_ = db.Close()

	st, err := Open(t.Context(), Options{BuildDir: dir, Log: slog.New(slog.DiscardHandler)})
	if err != nil {
		t.Fatal(err)
	}
	defer st.Close() //nolint:errcheck

	if st.Schema.Vernacular != nil {
		t.Error("an unrecognisable vernacular table must not be wired up")
	}
	if st.Schema.Ranking != nil {
		t.Error("`rank` is ambiguous (FTS5 ranks lower-is-better) and must not be guessed at")
	}
	if st.Schema.Skipped["vernacular"] == "" || st.Schema.Skipped["search_rank"] == "" {
		t.Errorf("skips must carry a reason: %v", st.Schema.Skipped)
	}
}
