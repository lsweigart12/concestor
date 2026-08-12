package store

import (
	"context"
	"database/sql"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"

	"github.com/lsweigart12/concestor/server/internal/testenv"
)

func open(t *testing.T) *Store {
	t.Helper()
	build := testenv.RequireBuild(t)
	st, err := Open(t.Context(), Options{BuildDir: build})
	if err != nil {
		t.Fatalf("opening store: %v", err)
	}
	t.Cleanup(func() { _ = st.Close() })
	return st
}

func TestParseKey(t *testing.T) {
	cases := []struct {
		in      string
		ott     int64
		isOtt   bool
		idx     int
		isIdx   bool
		ok      bool
		comment string
	}{
		{"ott770315", 770315, true, 0, false, true, "named node"},
		{"770315", 770315, true, 0, false, true, "bare id, as the URL form carries it"},
		{"idx:12345", 0, false, 12345, true, true, "internal index"},
		{"mrcaott83926ott3607676", 0, false, 0, false, true, "unnamed divergence, resolved via node_key"},
		{"", 0, false, 0, false, false, "empty"},
		{"ott", 0, false, 0, false, false, "no digits"},
		{"idx:-1", 0, false, 0, false, false, "negative index"},
		{"idx:abc", 0, false, 0, false, false, "non-numeric index"},
		{"Homo sapiens", 0, false, 0, false, false, "a name is not a key"},
	}
	for _, c := range cases {
		ott, isOtt, idx, isIdx, ok := ParseKey(c.in)
		if ok != c.ok || ott != c.ott || isOtt != c.isOtt || idx != c.idx || isIdx != c.isIdx {
			t.Errorf("ParseKey(%q) = (%d,%v,%d,%v,%v), want (%d,%v,%d,%v,%v) — %s",
				c.in, ott, isOtt, idx, isIdx, ok, c.ott, c.isOtt, c.idx, c.isIdx, c.ok, c.comment)
		}
	}
}

func TestResolveNode(t *testing.T) {
	st := open(t)
	ctx := t.Context()

	r, err := st.Resolve(ctx, "ott770315")
	if err != nil {
		t.Fatal(err)
	}
	if r.Broken != nil || r.ForwardedFrom != nil {
		t.Fatalf("Homo sapiens should resolve cleanly, got %+v", r)
	}
	if st.Arrays.OttID[r.Idx] != 770315 {
		t.Errorf("resolved to idx %d whose ott_id is %d", r.Idx, st.Arrays.OttID[r.Idx])
	}

	byIdx, err := st.Resolve(ctx, "idx:"+itoa(r.Idx))
	if err != nil || byIdx.Idx != r.Idx {
		t.Errorf("idx: form disagrees: %+v %v", byIdx, err)
	}

	// An unnamed divergence point has no OTT id at all, which is exactly why
	// idx is the primary key.
	var mrcaKey string
	if err := st.DB.QueryRowContext(ctx,
		"SELECT node_key FROM node WHERE ott_id IS NULL LIMIT 1").Scan(&mrcaKey); err != nil {
		t.Fatal(err)
	}
	if !strings.HasPrefix(mrcaKey, "mrca") {
		t.Fatalf("expected an mrca* key, got %q", mrcaKey)
	}
	m, err := st.Resolve(ctx, mrcaKey)
	if err != nil {
		t.Fatalf("resolving %s: %v", mrcaKey, err)
	}
	if st.Arrays.OttID[m.Idx] != -1 {
		t.Errorf("%s resolved to a node carrying an ott id", mrcaKey)
	}
}

func TestResolveUnknown(t *testing.T) {
	st := open(t)
	for _, k := range []string{"ott999999999", "idx:99999999", "mrcaottNOPE", "", "!!"} {
		if _, err := st.Resolve(t.Context(), k); err == nil {
			t.Errorf("%q should be unknown", k)
		}
	}
}

// OTT id forwarding is silent — 297,070 entries — so a retired id must resolve
// and must say that it was forwarded.
func TestResolveChasesForwards(t *testing.T) {
	st := open(t)
	ctx := t.Context()

	var oldID, newID int64
	err := st.DB.QueryRowContext(ctx, `SELECT f.old_ott_id, f.new_ott_id FROM forward f
		JOIN node n ON n.ott_id = f.new_ott_id LIMIT 1`).Scan(&oldID, &newID)
	if err != nil {
		t.Skipf("no forward lands on a node in this build: %v", err)
	}

	r, err := st.Resolve(ctx, "ott"+itoa64(oldID))
	if err != nil {
		t.Fatalf("retired id ott%d did not resolve: %v", oldID, err)
	}
	if r.ForwardedFrom == nil || *r.ForwardedFrom != oldID {
		t.Fatalf("forwarded_from = %v, want %d", r.ForwardedFrom, oldID)
	}
	if st.Arrays.OttID[r.Idx] != newID {
		t.Errorf("landed on ott%d, want ott%d", st.Arrays.OttID[r.Idx], newID)
	}
}

// A retired id can forward onto a taxon that turns out to be broken. Both
// facts have to survive to the caller.
func TestResolveForwardIntoBrokenTaxon(t *testing.T) {
	st := open(t)
	ctx := t.Context()

	var oldID, newID int64
	err := st.DB.QueryRowContext(ctx, `SELECT f.old_ott_id, f.new_ott_id FROM forward f
		JOIN broken_taxon b ON b.ott_id = f.new_ott_id LIMIT 1`).Scan(&oldID, &newID)
	if err != nil {
		t.Skip("no forward lands on a broken taxon in this build")
	}
	r, err := st.Resolve(ctx, "ott"+itoa64(oldID))
	if err != nil {
		t.Fatal(err)
	}
	if r.Broken == nil {
		t.Fatalf("ott%d should have resolved to broken taxon ott%d", oldID, newID)
	}
	if r.ForwardedFrom == nil || *r.ForwardedFrom != oldID {
		t.Errorf("forwarded_from = %v, want %d", r.ForwardedFrom, oldID)
	}
}

// Dinosauria is non-monophyletic and so is not a node. The live Open Tree API
// silently answers about the substituted MRCA; we explain instead.
func TestResolveBrokenTaxonDinosauria(t *testing.T) {
	st := open(t)
	r, err := st.Resolve(t.Context(), "ott90215")
	if err != nil {
		t.Fatalf("ott90215 (Dinosauria): %v", err)
	}
	if r.Broken == nil {
		t.Fatal("Dinosauria should resolve as a broken taxon, not a node")
	}
	b := r.Broken
	if b.Name != "Dinosauria" {
		t.Errorf("name = %q", b.Name)
	}
	if b.MRCANodeKey == "" || b.MRCAIdx == nil {
		t.Error("the substituted MRCA must be reported")
	}
	if b.NAttachmentPoints == 0 {
		t.Error("attachment points must be reported so the UI can offer them")
	}
	if len(b.AttachmentPoints) == 0 || string(b.AttachmentPoints) == "null" {
		t.Error("attachment_points must be valid JSON")
	}
	if _, ok := st.Arrays.IdxForOtt(90215); ok {
		t.Error("a broken taxon must not also be a node")
	}
}

func TestBrokenCount(t *testing.T) {
	st := open(t)
	if st.CountBroken != 9839 {
		t.Errorf("broken taxa = %d, want 9839", st.CountBroken)
	}
}

func TestMetasBatch(t *testing.T) {
	st := open(t)
	idx, _ := st.Arrays.IdxForOtt(770315)
	path := st.Arrays.PathToRoot(idx)
	metas, err := st.Metas(t.Context(), path)
	if err != nil {
		t.Fatal(err)
	}
	if len(metas) != len(path) {
		t.Fatalf("got %d metas for a %d-node path", len(metas), len(path))
	}
	leaf := metas[idx]
	if leaf.Name == nil || *leaf.Name != "Homo sapiens" {
		t.Errorf("name = %v, want Homo sapiens", leaf.Name)
	}
	if leaf.Rank == nil || *leaf.Rank != "species" {
		t.Errorf("rank = %v, want species (a rename once left this column NULL)", leaf.Rank)
	}
	if leaf.NodeKey != "ott770315" {
		t.Errorf("node_key = %q", leaf.NodeKey)
	}
}

func TestSearchExactMatchRanksFirst(t *testing.T) {
	st := open(t)
	res, err := st.Search(t.Context(), "Homo", 20)
	if err != nil {
		t.Fatal(err)
	}
	if len(res) == 0 {
		t.Fatal("no results for Homo")
	}
	if res[0].Name == nil || *res[0].Name != "Homo" {
		t.Errorf("first result is %v, want the exact match Homo", res[0].Name)
	}
	if res[0].Kind != "node" {
		t.Errorf("kind = %q", res[0].Kind)
	}
}

func TestSearchIsCaseInsensitiveEnough(t *testing.T) {
	st := open(t)
	for _, q := range []string{"homo sapiens", "Homo sapiens", "HOMO SAPIENS"} {
		res, err := st.Search(t.Context(), q, 10)
		if err != nil {
			t.Fatal(err)
		}
		found := false
		for _, r := range res {
			if r.Name != nil && *r.Name == "Homo sapiens" {
				found = true
			}
		}
		if !found {
			t.Errorf("%q did not find Homo sapiens", q)
		}
	}
}

func TestSearchRanksByTipCount(t *testing.T) {
	st := open(t)
	res, err := st.Search(t.Context(), "Can", 20)
	if err != nil {
		t.Fatal(err)
	}
	if len(res) < 2 {
		t.Fatal("expected several results for Can")
	}
	// The page must be a total order under the ranking rule. Asserting
	// tip_count alone is descending is too strong once a baked rank_score
	// exists — that column *is* the composite of tip_count, silhouette,
	// measured age and vernacular count, and it legitimately outranks any one
	// of them.
	for i := 1; i < len(res); i++ {
		if lessResult(&res[i], &res[i-1]) {
			t.Fatalf("results are out of rank order at %d: %v before %v",
				i, res[i-1].Name, res[i].Name)
		}
	}
	// Ranking ambiguous prefixes by subtree size is what makes a big clade
	// beat a one-species genus (architecture §4).
	if res[0].TipCount == nil || *res[0].TipCount < 500 {
		t.Errorf("first result for Can is %v with tip_count %v; a large clade "+
			"should win an ambiguous prefix", res[0].Name, res[0].TipCount)
	}
}

// The hot-name cache answers short prefixes without touching the database. It
// must agree with the index scan it replaces.
func TestHotNameCacheAgreesWithTheIndexScan(t *testing.T) {
	st := open(t)
	if len(st.hot) == 0 {
		t.Skip("hot-name cache not built")
	}
	for _, q := range []string{"a", "ca", "Mam", "Tyr"} {
		hot := st.hotPrefixMatches(q, candidatesPerVariant)
		if len(hot) == 0 {
			continue
		}
		// Everything the cache returns must really start with the prefix,
		// and must be ordered by subtree size.
		metas, err := st.Metas(t.Context(), hot)
		if err != nil {
			t.Fatal(err)
		}
		var prev uint32 = ^uint32(0)
		for _, idx := range hot {
			m := metas[idx]
			if m.Name == nil || !strings.HasPrefix(strings.ToLower(*m.Name), strings.ToLower(q)) {
				t.Fatalf("%q returned %v", q, m.Name)
			}
			if tc := st.Arrays.TipCount[idx]; tc > prev {
				t.Fatalf("%q: hot matches are not tip_count-descending", q)
			} else {
				prev = tc
			}
		}
		// And the largest of them must be the largest overall, which is the
		// property that lets the cache skip the scan entirely.
		scan, err := st.topByTipCount(t.Context(), strings.ToUpper(q[:1])+q[1:], 1, nil)
		if err != nil {
			t.Fatal(err)
		}
		if len(scan) == 1 && st.Arrays.TipCount[scan[0]] > st.Arrays.TipCount[hot[0]] {
			t.Errorf("%q: the index scan found a bigger subtree (%d) than the cache (%d)",
				q, st.Arrays.TipCount[scan[0]], st.Arrays.TipCount[hot[0]])
		}
	}
}

// There are 9,839 broken taxa and they must be searchable.
func TestSearchReturnsBrokenTaxa(t *testing.T) {
	st := open(t)
	res, err := st.Search(t.Context(), "Dinosauria", 20)
	if err != nil {
		t.Fatal(err)
	}
	var got *SearchResult
	for i := range res {
		if res[i].Kind == "broken" {
			got = &res[i]
			break
		}
	}
	if got == nil {
		t.Fatal("Dinosauria did not come back with kind=broken")
	}
	if got.Key != "ott90215" {
		t.Errorf("key = %q, want ott90215", got.Key)
	}
	if got.Idx != nil {
		t.Error("a broken taxon is not a node and must not carry an idx")
	}
	if got.TipCount != nil {
		t.Error("a broken taxon has no tip_count of its own")
	}
	if got.MRCAIdx == nil || got.NAttachmentPoints == nil {
		t.Error("the UI needs the substituted MRCA and the attachment points")
	}
}

// …but only when the query *is* one. A broken taxon is an explanation for a
// name, not a candidate answer, and on a prefix 9,839 of them chase every
// keystroke: typing towards "Homo sapiens neanderthalensis" used to surface
// Neanastatinae and Neanuridae, which is noise on the way to a real species.
func TestSearchDoesNotOfferBrokenTaxaOnAPrefix(t *testing.T) {
	st := open(t)
	for _, q := range []string{"nean", "neand", "homo neand", "dinosaur", "dinosauri"} {
		res, err := st.Search(t.Context(), q, 24)
		if err != nil {
			t.Fatal(err)
		}
		for i := range res {
			if res[i].Kind == "broken" {
				t.Errorf("%q returned broken taxon %q — only the whole name should",
					q, deref(res[i].Name))
			}
		}
	}
}

// The explanation is worth exactly one row. Four "FamilyI" rows is the same
// failure the prefix match had, at a smaller scale.
func TestSearchCapsSameNamedBrokenTaxa(t *testing.T) {
	st := open(t)
	var name string
	err := st.DB.QueryRowContext(t.Context(), `
		SELECT name FROM broken_taxon WHERE name <> ''
		GROUP BY name HAVING count(*) > 2 LIMIT 1`).Scan(&name)
	if err != nil {
		t.Skipf("no name is shared by three broken taxa in this build: %v", err)
	}
	res, err := st.Search(t.Context(), name, 24)
	if err != nil {
		t.Fatal(err)
	}
	n := 0
	for i := range res {
		if res[i].Kind == "broken" {
			n++
		}
	}
	if n > maxBrokenExplanations {
		t.Errorf("%q returned %d broken rows, want at most %d", name, n, maxBrokenExplanations)
	}
	if n == 0 {
		t.Errorf("%q returned no explanation at all", name)
	}
}

func deref(s *string) string {
	if s == nil {
		return "<nil>"
	}
	return *s
}

func TestSearchLimits(t *testing.T) {
	st := open(t)
	res, err := st.Search(t.Context(), "A", 50)
	if err != nil {
		t.Fatal(err)
	}
	if len(res) > 50 {
		t.Fatalf("returned %d results for limit 50", len(res))
	}
	empty, err := st.Search(t.Context(), "   ", 20)
	if err != nil || len(empty) != 0 {
		t.Errorf("blank query = %v %v, want no results and no error", empty, err)
	}
	if _, err := st.Search(t.Context(), `"; DROP TABLE node --`, 20); err != nil {
		t.Errorf("a hostile query must not error: %v", err)
	}
}

// The build id is a pure function of the artifacts on disk, and both halves of
// that sentence are load-bearing.
//
// *Function*: two opens of one build agree, which is what makes it usable as a
// cache validator at all. *Of the artifacts*: nothing about the binary is in
// it, which is why `/v1/about` can publish it as the dataset's name — and why
// the ETag cannot be this id alone. A release that changes only Go code moves
// nothing here, correctly, and shipped stale JSON under `immutable` for
// exactly that reason. `api.etag` is where the code identity is added; do not
// add it here. docs/deployment.md §5 records why the two ids stay two.
func TestBuildIDIsStable(t *testing.T) {
	build := testenv.RequireBuild(t)
	a, err := Open(t.Context(), Options{BuildDir: build})
	if err != nil {
		t.Fatal(err)
	}
	defer a.Close() //nolint:errcheck
	b, err := Open(t.Context(), Options{BuildDir: build})
	if err != nil {
		t.Fatal(err)
	}
	defer b.Close() //nolint:errcheck
	if a.BuildID != b.BuildID || a.BuildID == "" {
		t.Errorf("build id is not stable: %q vs %q", a.BuildID, b.BuildID)
	}
	if len(a.BuildID) != 16 {
		t.Errorf("build id = %q, want the 16 hex digits /v1/about promises", a.BuildID)
	}
}

func TestPhasesAreLoaded(t *testing.T) {
	st := open(t)
	if len(st.Phases) == 0 {
		t.Fatal("no phase gate reports were loaded")
	}
	p, ok := st.Phases["phase1_gates"]
	if !ok {
		t.Fatalf("phase1_gates missing; have %v", keys(st.Phases))
	}
	if !p.OK || p.Gates != 25 {
		t.Errorf("phase 1 = ok:%v gates:%d, want ok:true gates:25", p.OK, p.Gates)
	}
}

// chaseForward has to be transitive with a cycle guard, even though the
// pipeline currently collapses chains before writing the table. Build a
// deliberately nasty forward table to exercise it.
func TestChaseForwardTransitiveAndCyclic(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "fwd.db")
	db, err := sql.Open("sqlite", "file:"+path)
	if err != nil {
		t.Fatal(err)
	}
	_, err = db.Exec(`CREATE TABLE forward (old_ott_id INTEGER PRIMARY KEY, new_ott_id INTEGER NOT NULL);
		INSERT INTO forward VALUES (1,2),(2,3),(3,4),(10,11),(11,10);`)
	if err != nil {
		t.Fatal(err)
	}
	st := &Store{DB: db, Schema: &Schema{Tables: map[string][]string{"forward": {"old_ott_id", "new_ott_id"}}}}
	defer db.Close() //nolint:errcheck

	got, err := st.chaseForward(t.Context(), 1)
	if err != nil {
		t.Fatal(err)
	}
	if got != 4 {
		t.Errorf("1 chased to %d, want 4", got)
	}
	// A cycle must terminate rather than spin; where it stops matters less
	// than that it stops and returns something in the cycle.
	cyc, err := st.chaseForward(t.Context(), 10)
	if err != nil {
		t.Fatal(err)
	}
	if cyc != 10 && cyc != 11 {
		t.Errorf("cycle chased to %d, want 10 or 11", cyc)
	}
	if same, _ := st.chaseForward(t.Context(), 99); same != 99 {
		t.Errorf("an unforwarded id should come back unchanged, got %d", same)
	}
}

func TestOpenRejectsMissingBuild(t *testing.T) {
	if _, err := Open(context.Background(), Options{BuildDir: filepath.Join(t.TempDir(), "nope")}); err == nil {
		t.Fatal("expected an error for a missing build directory")
	}
	dir := t.TempDir()
	if err := os.MkdirAll(filepath.Join(dir, "topology"), 0o755); err != nil {
		t.Fatal(err)
	}
	if _, err := Open(context.Background(), Options{BuildDir: dir}); err == nil {
		t.Fatal("expected an error when parent.npy is absent")
	}
}

func TestSchemaDetectionOnTodaysDatabase(t *testing.T) {
	st := open(t)
	for _, want := range []string{"node", "broken_taxon", "forward"} {
		if !st.Schema.has(want) {
			t.Errorf("table %s not detected", want)
		}
	}
	// These are being added concurrently by other agents. The point of the
	// test is that their absence is detected, not fatal.
	t.Logf("node_fts=%v vernacular=%v silhouette=%v node_image=%v synonym=%v ranking=%v",
		st.Schema.FTS != nil, st.Schema.Vernacular != nil, st.Schema.Silhouette != nil,
		st.Schema.NodeImage != nil, st.Schema.Synonym != nil, st.Schema.Ranking != nil)
}

func keys[V any](m map[string]V) []string {
	out := make([]string, 0, len(m))
	for k := range m {
		out = append(out, k)
	}
	return out
}

func itoa(v int) string     { return strconv.Itoa(v) }
func itoa64(v int64) string { return strconv.FormatInt(v, 10) }
