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
			(594502, 3607688, 'ott3607688', 'Sahelanthropus', 'no rank', 'extinct', 1, 51),
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

		-- climb is hops up to clade_idx, not to source_idx: Homo sapiens sits
		-- at depth 59 and Mammalia at 33.
		CREATE TABLE node_image (idx INTEGER PRIMARY KEY, phylopic_id TEXT,
			source_idx INTEGER NOT NULL, clade_idx INTEGER NOT NULL,
			climb INTEGER NOT NULL, method TEXT NOT NULL);
		INSERT INTO node_image VALUES (594485, 'abc-123', 588427, 588427, 26, 'ancestor'),
			(594475, 'abc-123', 588427, 588427, 22, 'ancestor');

		-- The second resolution: the human–chimp split witnessed by the taxon
		-- whose fossil record sits at it, not by the crown genus below it.
		CREATE TABLE node_divergence_image (idx INTEGER PRIMARY KEY,
			phylopic_id TEXT NOT NULL, source_idx INTEGER NOT NULL, gap_ma REAL NOT NULL);
		INSERT INTO node_divergence_image VALUES (594475, 'def-456', 594502, 0.0);

		CREATE TABLE occurrence (idx INTEGER PRIMARY KEY,
			fea REAL, fla REAL, lea REAL, lla REAL);
		INSERT INTO occurrence VALUES (594502, 7.246, 5.333, 7.246, 5.333);

		CREATE TABLE synonym (idx INTEGER, name TEXT);
		INSERT INTO synonym VALUES (594485, 'Homo sapiens Linnaeus 1758');

		CREATE TABLE search_rank (idx INTEGER PRIMARY KEY, rank_score REAL);
		INSERT INTO search_rank VALUES (594485, 9.5), (588427, 1.0);

		-- The ordering fixture. Mammalia attached below Mammalia is the real
		-- shape of it: a clade accumulates every occurrence of everything
		-- inside it, so ordering on n_occs alone hands the lane its least
		-- informative row. Every column the ranking reads is exercised here.
		CREATE TABLE fossil (
			pbdb_taxon_no INTEGER PRIMARY KEY, accepted_no INTEGER, name TEXT NOT NULL, rank TEXT,
			attach_idx INTEGER NOT NULL, difference TEXT, is_primary INTEGER,
			fea REAL, fla REAL, lea REAL, lla REAL,
			n_occs INTEGER NOT NULL, is_extant INTEGER);
		INSERT INTO fossil VALUES
			(1, 1, 'Tyrannosaurus', 'genus', 588427, NULL, 1, 72.1, 70.6, 66.0, 66.0, 400, 0),
			(2, 1, 'Tyrannosaurus', 'genus', 588427, 'subjective synonym of', 0, 72.1, 70.6, 66.0, 66.0, 400, 0),
			(3, 3, 'Obscurosaurus', 'genus', 588427, NULL, 1, NULL, NULL, NULL, NULL, 1, NULL),
			(4, 4, 'Mammalia', 'class', 588427, NULL, 1, 239.5, 237.0, 0.01, 0.0, 127810, 1),
			(5, 5, 'Zalambdalestidae', 'family', 588427, NULL, 1, 83.6, 72.2, 83.6, 72.2, 9, 0),
			(6, 6, 'Undrawnodon', 'genus', 588427, NULL, 1, 90.0, 85.0, 90.0, 85.0, 50, 0);

		-- A fossil is not a node, so node_image cannot reach it. This is the
		-- only join that can, and it is keyed on the taxon rather than a name.
		CREATE TABLE fossil_image (accepted_no INTEGER PRIMARY KEY,
			phylopic_id TEXT NOT NULL, matched_name TEXT NOT NULL);
		INSERT INTO fossil_image VALUES
			(1, 'abc-123', 'Tyrannosaurus'), (5, 'def-456', 'Zalambdalestidae');
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
	if sc.NodeImage.SourceIdx != "source_idx" || sc.NodeImage.CladeIdx != "clade_idx" ||
		sc.NodeImage.Climb != "climb" || sc.NodeImage.Method != "method" {
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
	// The clade is what the picture claims to stand for, and its tip count is
	// the only thing that tells a caller whether drawing it would misinform.
	if got.CladeIdx == nil || *got.CladeIdx != 588427 {
		t.Errorf("clade_idx = %v, want 588427", got.CladeIdx)
	}
	if got.Climb == nil || *got.Climb != 26 || got.Method != "ancestor" {
		t.Errorf("climb/method = %v %q", got.Climb, got.Method)
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
	// has_image ranks a row; these draw it. The palette shows a silhouette per
	// hit, and without the id it can only know that one exists.
	if res[0].PhylopicID == nil || *res[0].PhylopicID != "abc-123" {
		t.Errorf("phylopic_id = %v, want abc-123", res[0].PhylopicID)
	}
	if res[0].SilhouetteSourceIdx == nil || *res[0].SilhouetteSourceIdx != 588427 {
		t.Errorf("silhouette_source_idx = %v, want 588427", res[0].SilhouetteSourceIdx)
	}
	// The borrowed-image suppression rule is a comparison against the source
	// clade's size, and the client has no other way to learn it — the source is
	// an ancestor and is not itself in the result set.
	if res[0].SilhouetteSourceTips == nil {
		t.Fatal("silhouette_source_tips is nil; the client cannot judge the borrow")
	}
	if got := *res[0].SilhouetteSourceTips; got != int64(st.Arrays.TipCount[588427]) {
		t.Errorf("silhouette_source_tips = %d, want %d", got, st.Arrays.TipCount[588427])
	}
	if res[0].SilhouetteCladeTips == nil {
		t.Fatal("silhouette_clade_tips is nil; the palette cannot apply the canvas's rule")
	}
	if got := *res[0].SilhouetteCladeTips; got != int64(st.Arrays.TipCount[588427]) {
		t.Errorf("silhouette_clade_tips = %d, want %d", got, st.Arrays.TipCount[588427])
	}
}

// The witness is a *second* answer, not a replacement, so the test is that both
// survive on the same node: node_image still says what the clade looks like and
// node_divergence_image says what stood at its split. Collapsing them is the
// failure this table exists to avoid.
func TestTheDivergenceWitnessDoesNotDisplaceTheOrdinaryImage(t *testing.T) {
	dir := futureBuild(t)
	st, err := Open(t.Context(), Options{BuildDir: dir, Log: slog.New(slog.DiscardHandler)})
	if err != nil {
		t.Fatalf("opening a future build: %v", err)
	}
	defer st.Close() //nolint:errcheck

	if st.Schema.Witness == nil {
		t.Fatal("node_divergence_image was not detected")
	}
	if st.Schema.Witness.SourceIdx != "source_idx" || st.Schema.Witness.GapMa != "gap_ma" {
		t.Errorf("witness columns resolved to %+v", st.Schema.Witness)
	}

	ctx := t.Context()
	ws, err := st.Witnesses(ctx, []int{594475, 594485})
	if err != nil {
		t.Fatal(err)
	}
	got, ok := ws[594475]
	if !ok || got.PhylopicID != "def-456" || got.SourceIdx != 594502 {
		t.Fatalf("witness = %+v", got)
	}
	if got.GapMa == nil || *got.GapMa != 0 {
		t.Errorf("gap_ma = %v, want 0 — the taxon's range spans this split", got.GapMa)
	}
	// A leaf the reader selected is not a divergence and must not acquire one.
	if _, ok := ws[594485]; ok {
		t.Error("594485 is a tip; it has no split for a fossil to witness")
	}

	imgs, err := st.Images(ctx, []int{594475})
	if err != nil {
		t.Fatal(err)
	}
	if imgs[594475].PhylopicID != "abc-123" {
		t.Errorf("the ordinary image = %+v, want it untouched", imgs[594475])
	}
}

// A witness with no taxon is a picture with no caption, and the caption is the
// whole point — without it the drawing is just another unexplained silhouette,
// which is the thing this replaced. So the row is dropped rather than served
// half-resolved.
func TestAWitnessWithoutItsTaxonIsRefused(t *testing.T) {
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
		INSERT INTO node VALUES (594475, NULL, 'mrcaott786ott6182', NULL, NULL, '', 4, 55);
		CREATE TABLE node_divergence_image (idx INTEGER PRIMARY KEY,
			phylopic_id TEXT NOT NULL, source_idx INTEGER NOT NULL, gap_ma REAL NOT NULL);
		INSERT INTO node_divergence_image VALUES (594475, 'def-456', -1, 0.0);
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

	ws, err := st.Witnesses(t.Context(), []int{594475})
	if err != nil {
		t.Fatal(err)
	}
	if _, ok := ws[594475]; ok {
		t.Error("a witness whose source_idx addresses nothing must be dropped")
	}
}

// A build from before phase 5a grew a witness table must open and serve
// unchanged. This is the ordinary case for every dataset built to date.
func TestNoWitnessTableIsNotAnError(t *testing.T) {
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
		INSERT INTO node VALUES (594485, 770315, 'ott770315', 'Homo sapiens', 'species', '', 2, 59);
	`)
	if err != nil {
		t.Fatal(err)
	}
	_ = db.Close()

	st, err := Open(t.Context(), Options{BuildDir: dir, Log: slog.New(slog.DiscardHandler)})
	if err != nil {
		t.Fatalf("opening a build with no witness table: %v", err)
	}
	defer st.Close() //nolint:errcheck

	if st.Schema.Witness != nil {
		t.Errorf("witness schema resolved against no such table: %+v", st.Schema.Witness)
	}
	ws, err := st.Witnesses(t.Context(), []int{594485})
	if err != nil || len(ws) != 0 {
		t.Fatalf("Witnesses = %v, %v; want an empty map and no error", ws, err)
	}
}

// A database built before phase 5a grew `clade_idx` must still open and serve.
// Feature detection is what lets the binary run against a partially-built or an
// older dataset, and a column added to one table is exactly the case where a
// hardcoded SELECT would turn a rebuild into a startup failure.
func TestNodeImageWithoutCladeColumn(t *testing.T) {
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
		INSERT INTO node VALUES (594485, 770315, 'ott770315', 'Homo sapiens', 'species', '', 2, 59);
		CREATE TABLE node_image (idx INTEGER PRIMARY KEY, phylopic_id TEXT, source_idx INTEGER);
		INSERT INTO node_image VALUES (594485, 'abc-123', 588427);
	`)
	if err != nil {
		t.Fatal(err)
	}
	_ = db.Close()

	st, err := Open(t.Context(), Options{BuildDir: dir, Log: slog.New(slog.DiscardHandler)})
	if err != nil {
		t.Fatalf("opening a pre-clade_idx build: %v", err)
	}
	defer st.Close() //nolint:errcheck

	if st.Schema.NodeImage == nil {
		t.Fatal("node_image must still be wired up without clade_idx")
	}
	if st.Schema.NodeImage.CladeIdx != "" {
		t.Errorf("clade_idx resolved to %q against a table that has no such column",
			st.Schema.NodeImage.CladeIdx)
	}
	imgs, err := st.Images(t.Context(), []int{594485})
	if err != nil {
		t.Fatalf("Images against a pre-clade_idx table: %v", err)
	}
	got, ok := imgs[594485]
	if !ok || got.SourceIdx == nil || *got.SourceIdx != 588427 {
		t.Fatalf("image = %+v", got)
	}
	if got.CladeIdx != nil {
		t.Errorf("clade_idx = %v, want nil when the column is absent", got.CladeIdx)
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

// The lane's ordering, which is the whole of the drill-down fix.
//
// Ordering on n_occs alone put five living wastebasket clades at the top of
// every deep segment — measured on Tetrapoda, the first eight rows were
// Tetrapoda itself and four more like it, and Acanthostega gunnari sat at rank
// 147 of 623. The fixture reproduces that shape in miniature: Mammalia is
// attached below Mammalia with 127,810 occurrences and would win any
// count-based order.
func TestLaneOrdersByNotabilityNotOccurrenceCount(t *testing.T) {
	dir := futureBuild(t)
	st, err := Open(t.Context(), Options{BuildDir: dir, Log: slog.New(slog.DiscardHandler)})
	if err != nil {
		t.Fatalf("opening a future build: %v", err)
	}
	defer st.Close() //nolint:errcheck

	got, total, err := st.Fossils(t.Context(), []int{588427}, 10)
	if err != nil {
		t.Fatal(err)
	}
	names := make([]string, len(got))
	for i, f := range got {
		names[i] = f.Name
	}
	// Tyrannosaurus: extinct, drawn, a genus — clears every penalty.
	// Zalambdalestidae: extinct and drawn, but a family.
	// Undrawnodon: extinct and a genus, but nobody drew it — and 50
	//   occurrences against Zalambdalestidae's 9 does not rescue it, which is
	//   the point of weighting the drawing above specificity.
	// Obscurosaurus: extancy unknown.
	// Mammalia: extant, and last however many occurrences it has.
	want := []string{"Tyrannosaurus", "Zalambdalestidae", "Undrawnodon", "Obscurosaurus", "Mammalia"}
	if len(names) != len(want) {
		t.Fatalf("lane = %v, want %d rows", names, len(want))
	}
	for i := range want {
		if names[i] != want[i] {
			t.Fatalf("lane = %v, want %v", names, want)
		}
	}
	// The synonym row is filtered by is_primary, not merely deduplicated, so
	// it never occupies a lane row before the dedup can drop it.
	if total != len(want) {
		t.Errorf("total = %d, want %d accepted taxa", total, len(want))
	}
	// A drawing rides along on the row that has one; a fossil never inherits.
	if got[0].PhylopicID == nil || *got[0].PhylopicID != "abc-123" {
		t.Errorf("Tyrannosaurus image = %v", got[0].PhylopicID)
	}
	if got[2].PhylopicID != nil {
		t.Errorf("Undrawnodon has no drawing; got %v", got[2].PhylopicID)
	}
}
