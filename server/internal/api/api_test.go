package api

import (
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"slices"
	"strconv"
	"strings"
	"testing"

	"github.com/lsweigart12/concestor/server/internal/store"
	"github.com/lsweigart12/concestor/server/internal/testenv"
)

func serve(t *testing.T) (*httptest.Server, *store.Store) {
	t.Helper()
	build := testenv.RequireBuild(t)
	st, err := store.Open(t.Context(), store.Options{
		BuildDir: build,
		Log:      slog.New(slog.DiscardHandler),
	})
	if err != nil {
		t.Fatalf("opening store: %v", err)
	}
	t.Cleanup(func() { _ = st.Close() })

	srv := &Server{St: st, Log: slog.New(slog.DiscardHandler), PublicCache: true}
	ts := httptest.NewServer(srv.Handler())
	t.Cleanup(ts.Close)
	return ts, st
}

func getJSON(t *testing.T, ts *httptest.Server, path string, into any) *http.Response {
	t.Helper()
	resp, err := ts.Client().Get(ts.URL + path)
	if err != nil {
		t.Fatalf("GET %s: %v", path, err)
	}
	body, _ := io.ReadAll(resp.Body)
	_ = resp.Body.Close()
	if into != nil {
		if err := json.Unmarshal(body, into); err != nil {
			t.Fatalf("GET %s: decoding %s: %v", path, truncate(string(body)), err)
		}
	}
	return resp
}

func truncate(s string) string {
	if len(s) > 400 {
		return s[:400] + "…"
	}
	return s
}

func TestHealthz(t *testing.T) {
	ts, _ := serve(t)
	resp, err := ts.Client().Get(ts.URL + "/healthz")
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close() //nolint:errcheck
	b, _ := io.ReadAll(resp.Body)
	if resp.StatusCode != 200 || string(b) != "ok" {
		t.Fatalf("healthz = %d %q", resp.StatusCode, b)
	}
}

func TestAbout(t *testing.T) {
	ts, st := serve(t)
	var body map[string]any
	resp := getJSON(t, ts, "/v1/about", &body)
	if resp.StatusCode != 200 {
		t.Fatalf("status %d", resp.StatusCode)
	}
	if body["build_id"] != st.BuildID || st.BuildID == "" {
		t.Errorf("build_id = %v", body["build_id"])
	}
	counts, _ := body["counts"].(map[string]any)
	if counts == nil {
		t.Fatal("no counts")
	}
	for k, want := range map[string]float64{
		"nodes": 2656841, "tips": 2340087, "internal": 316754, "broken": 9839,
	} {
		if counts[k] != want {
			t.Errorf("counts.%s = %v, want %v", k, counts[k], want)
		}
	}
	phases, _ := body["phases"].(map[string]any)
	if len(phases) == 0 {
		t.Error("phases must summarise build/phase*_gates.json — /v1/about is a feature, not diagnostics")
	}
	age, _ := body["age"].(map[string]any)
	if age == nil {
		t.Fatal("no age block")
	}
	if _, ok := age["tiers"]; !ok {
		t.Error("age.tiers missing")
	}
	// Phase 2 shipped `--provisional` ages tagged phase2_accepted:false. A
	// running instance must say so rather than presenting them as accepted.
	if _, ok := age["phase2_accepted"]; !ok {
		t.Error("age.phase2_accepted missing")
	}
	if _, ok := body["features"]; !ok {
		t.Error("features missing; the frontend needs to know what is built")
	}
}

func TestETagAnd304(t *testing.T) {
	ts, st := serve(t)
	resp := getJSON(t, ts, "/v1/path/ott770315", nil)
	tag := resp.Header.Get("ETag")
	if !strings.HasPrefix(tag, `"`+st.BuildID+`-`) || !strings.HasSuffix(tag, `"`) {
		t.Fatalf("ETag = %q, want the dataset id %q with a code id after it", tag, st.BuildID)
	}
	if cc := resp.Header.Get("Cache-Control"); !strings.Contains(cc, "s-maxage=31536000") {
		t.Errorf("Cache-Control = %q, want the edge held for a year", cc)
	}

	req, _ := http.NewRequest(http.MethodGet, ts.URL+"/v1/path/ott770315", nil)
	req.Header.Set("If-None-Match", tag)
	r2, err := ts.Client().Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer r2.Body.Close() //nolint:errcheck
	if r2.StatusCode != http.StatusNotModified {
		t.Errorf("If-None-Match got %d, want 304", r2.StatusCode)
	}
}

// The bug this file's `etag` comment describes, as a test.
//
// v0.23.0 added a field to /v1/node against an unmoved dataset, so every /v1
// URL kept the ETag it had under a one-year `immutable` — and `immutable`
// means a client will not revalidate, so the new field reached nobody with a
// warm cache. Two builds of the same data must not agree.
//
// It runs without a build, deliberately: this is the one assertion in the
// package that CI can make (docs/ci.md §2), and the failure it guards against
// is in the header rather than in the data.
func TestETagTracksTheCodeAndNotOnlyTheDataset(t *testing.T) {
	st := &store.Store{BuildID: "854cdfa42f77e78e"}
	before := &Server{St: st, Commit: "60036c0"}
	after := &Server{St: st, Commit: "db76ae0"}

	if before.etag() == after.etag() {
		t.Fatalf("same ETag %q from two commits over one dataset; a code-only "+
			"deploy would serve stale JSON under `immutable` forever", before.etag())
	}
	if !strings.Contains(before.etag(), "854cdfa42f77e78e") {
		t.Errorf("ETag %q has lost the dataset id", before.etag())
	}
	if !strings.Contains(before.etag(), "60036c0") {
		t.Errorf("ETag %q does not name the commit it was built from", before.etag())
	}

	// And the other direction, which is what makes the header worth sending
	// at all: one build answers with one ETag, so a revalidation is a 304.
	again := &Server{St: st, Commit: "60036c0"}
	if before.etag() != again.etag() {
		t.Errorf("one build gave two ETags: %q vs %q", before.etag(), again.etag())
	}
	other := &Server{St: &store.Store{BuildID: "9bc853c7694f7551"}, Commit: "60036c0"}
	if before.etag() == other.etag() {
		t.Error("a dataset change no longer moves the ETag")
	}
}

// A `go run` or a `go test` has no commit compiled in, and the fallback may
// not be a constant — a constant is the same collision as before, in the one
// place nobody would look for it.
func TestETagWithoutACommitIsStillPerBuild(t *testing.T) {
	s := &Server{St: &store.Store{BuildID: "854cdfa42f77e78e"}}
	id := s.codeID()
	if !strings.HasPrefix(id, "dev-") || len(id) <= len("dev-") {
		t.Fatalf("code id = %q, want a dev- fingerprint", id)
	}
	if s.codeID() != id {
		t.Error("the code id is not stable within a process")
	}

	// The fingerprint is the executable's own identity, so two different
	// binaries cannot share one. Two files stand in for two builds.
	dir := t.TempDir()
	a := filepath.Join(dir, "a")
	b := filepath.Join(dir, "b")
	if err := os.WriteFile(a, []byte("one build"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(b, []byte("a different build"), 0o600); err != nil {
		t.Fatal(err)
	}
	fa, ok := fingerprintFile(a)
	if !ok {
		t.Fatal("fingerprinting a file that exists failed")
	}
	fb, _ := fingerprintFile(b)
	if fa == fb {
		t.Errorf("two builds fingerprinted the same: %q", fa)
	}
	if again, _ := fingerprintFile(a); again != fa {
		t.Errorf("one build fingerprinted twice: %q vs %q", fa, again)
	}
	if _, ok := fingerprintFile(filepath.Join(dir, "gone")); ok {
		t.Error("a missing file must not fingerprint")
	}
}

// The commit arrives through a linker flag, which nothing validates. A quote
// in it would split the header rather than fail loudly.
func TestETagSurvivesAMalformedCommit(t *testing.T) {
	s := &Server{St: &store.Store{BuildID: "abc"}, Commit: `db7"6ae0, "*`}
	tag := s.etag()
	if strings.Count(tag, `"`) != 2 || !strings.HasPrefix(tag, `"`) || !strings.HasSuffix(tag, `"`) {
		t.Fatalf("ETag = %s, want one quoted string", tag)
	}
	if !etagMatches(tag, tag) {
		t.Error("the server cannot match its own ETag")
	}
	// A commit that sanitises to nothing must fall back rather than produce
	// the empty code id every other such build would also produce.
	empty := &Server{St: &store.Store{BuildID: "abc"}, Commit: `""`}
	if !strings.Contains(empty.etag(), "dev-") {
		t.Errorf("ETag = %s, want the fingerprint fallback", empty.etag())
	}
}

// Every cacheable response is stamped by one helper, so they cannot disagree
// about what build they came from. /v1/timescale and /v1/silhouette each used
// to write these headers by hand.
func TestEveryCacheableResponseCarriesTheSameETag(t *testing.T) {
	ts, _ := serve(t)
	want := getJSON(t, ts, "/v1/path/ott770315", nil).Header.Get("ETag")

	var about map[string]any
	getJSON(t, ts, "/v1/about", &about)

	for _, path := range []string{
		"/v1/timescale", "/v1/node/ott770315", "/v1/about",
		"/v1/hits?keys=ott770315",
	} {
		resp := getJSON(t, ts, path, nil)
		if resp.StatusCode != http.StatusOK {
			t.Errorf("GET %s: %d", path, resp.StatusCode)
			continue
		}
		if got := resp.Header.Get("ETag"); got != want {
			t.Errorf("GET %s: ETag = %q, want %q", path, got, want)
		}
		req, _ := http.NewRequest(http.MethodGet, ts.URL+path, nil)
		req.Header.Set("If-None-Match", want)
		r2, err := ts.Client().Do(req)
		if err != nil {
			t.Fatal(err)
		}
		_ = r2.Body.Close()
		if r2.StatusCode != http.StatusNotModified {
			t.Errorf("GET %s with If-None-Match: %d, want 304", path, r2.StatusCode)
		}
	}
}

// **No /v1 response may say `immutable`, and the browser's number must stay
// small.** The corrected ETag above is only worth having if somebody asks: a
// browser under `immutable` never revalidates, so a code deploy could not
// reach a warm one whatever the validator said. The edge is a different cache
// with a different correction — a deploy is a new Worker version and the cache
// is keyed by version — so it keeps the year, under `s-maxage`.
func TestNoResponseTellsABrowserNotToAsk(t *testing.T) {
	ts, _ := serve(t)
	for _, path := range []string{
		"/v1/path/ott770315", "/v1/node/ott770315", "/v1/timescale",
		"/v1/search?q=dog", "/v1/about", "/v1/hits?keys=ott770315",
	} {
		cc := getJSON(t, ts, path, nil).Header.Get("Cache-Control")
		if strings.Contains(cc, "immutable") {
			t.Errorf("GET %s: Cache-Control = %q; these URLs name no particular "+
				"build, so a browser must be able to find out it holds an old one", path, cc)
		}
		if !strings.Contains(cc, "max-age=3600") && !strings.Contains(cc, "max-age=60") {
			t.Errorf("GET %s: Cache-Control = %q, want a bounded browser lifetime", path, cc)
		}
	}
}

// The dev flag drops the production lifetimes entirely, because an hour of
// freshness against a rebuilt index is an hour of looking at the last build.
func TestPublicCacheOffIsNoCache(t *testing.T) {
	s := &Server{St: &store.Store{BuildID: "abc"}, Commit: "c0ffee"}
	if got := s.longLivedCC(); got != ccDev {
		t.Errorf("long-lived with -public-cache=false = %q, want %q", got, ccDev)
	}
	if got := s.shortLivedCC(); got != ccDev {
		t.Errorf("short-lived with -public-cache=false = %q, want %q", got, ccDev)
	}
	s.PublicCache = true
	if s.longLivedCC() == ccDev || s.shortLivedCC() == ccDev {
		t.Error("the flag is not wired to the lifetimes")
	}
}

// /v1/about is how a deploy is checked, so it may not be answered from an
// hour-old cache either. writeShortLivedJSON is the argument; this is the
// promise.
func TestAboutIsCacheableButNotImmutable(t *testing.T) {
	ts, _ := serve(t)
	resp := getJSON(t, ts, "/v1/about", nil)
	cc := resp.Header.Get("Cache-Control")
	if strings.Contains(cc, "immutable") {
		t.Errorf("Cache-Control = %q; the endpoint that says what is running "+
			"must be askable again", cc)
	}
	if !strings.Contains(cc, "max-age=60") || !strings.Contains(cc, "must-revalidate") {
		t.Errorf("Cache-Control = %q, want a minute and a revalidation", cc)
	}
	if resp.Header.Get("ETag") == "" {
		t.Error("no ETag; the revalidation after that minute should cost a 304 and not a body")
	}
}

func TestCORSForLocalDev(t *testing.T) {
	ts, _ := serve(t)
	req, _ := http.NewRequest(http.MethodGet, ts.URL+"/v1/about", nil)
	req.Header.Set("Origin", "http://localhost:5173")
	resp, err := ts.Client().Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close() //nolint:errcheck
	if got := resp.Header.Get("Access-Control-Allow-Origin"); got != "http://localhost:5173" {
		t.Errorf("Access-Control-Allow-Origin = %q", got)
	}
	if got := resp.Header.Get("Access-Control-Expose-Headers"); !strings.Contains(got, "ETag") {
		t.Errorf("the browser must be able to read the ETag, got %q", got)
	}

	req2, _ := http.NewRequest(http.MethodOptions, ts.URL+"/v1/about", nil)
	req2.Header.Set("Origin", "http://localhost:5173")
	r2, err := ts.Client().Do(req2)
	if err != nil {
		t.Fatal(err)
	}
	defer r2.Body.Close() //nolint:errcheck
	if r2.StatusCode != http.StatusNoContent {
		t.Errorf("preflight = %d", r2.StatusCode)
	}

	req3, _ := http.NewRequest(http.MethodGet, ts.URL+"/v1/about", nil)
	req3.Header.Set("Origin", "https://evil.example")
	r3, err := ts.Client().Do(req3)
	if err != nil {
		t.Fatal(err)
	}
	defer r3.Body.Close() //nolint:errcheck
	if r3.Header.Get("Access-Control-Allow-Origin") != "" {
		t.Error("a non-local origin must not be allowed")
	}
}

type pathResp struct {
	Key           string  `json:"key"`
	Idx           int     `json:"idx"`
	ForwardedFrom *int64  `json:"forwarded_from"`
	Path          []Entry `json:"path"`
	Broken        bool    `json:"broken"`
}

func TestPathHomoSapiens(t *testing.T) {
	ts, _ := serve(t)
	var p pathResp
	resp := getJSON(t, ts, "/v1/path/ott770315", &p)
	if resp.StatusCode != 200 {
		t.Fatalf("status %d", resp.StatusCode)
	}
	if len(p.Path) != 60 {
		t.Fatalf("path length %d, want 60", len(p.Path))
	}
	if p.Path[0].Idx != 0 {
		t.Errorf("path is not root-first: starts at idx %d", p.Path[0].Idx)
	}
	last := p.Path[len(p.Path)-1]
	if last.Idx != p.Idx || last.Key != "ott770315" {
		t.Errorf("path does not end at the requested node: %+v", last)
	}
	if last.Name == nil || *last.Name != "Homo sapiens" {
		t.Errorf("name = %v", last.Name)
	}
	if last.Rank == nil || *last.Rank != "species" {
		t.Errorf("rank = %v", last.Rank)
	}
	if p.ForwardedFrom != nil {
		t.Errorf("forwarded_from = %v, want null", p.ForwardedFrom)
	}
	// Every entry must carry the fields the layout depends on.
	for i, e := range p.Path {
		if e.Key == "" {
			t.Fatalf("entry %d has no key", i)
		}
		if e.Depth != int64(i) {
			t.Fatalf("entry %d has depth %d", i, e.Depth)
		}
	}
	// Named nodes and mrca* divergence points both appear, which is the whole
	// reason ott_id cannot be the primary key.
	var unnamed int
	for _, e := range p.Path {
		if e.OttID == nil {
			unnamed++
		}
	}
	if unnamed == 0 {
		t.Error("expected at least one mrca* node on the human lineage")
	}
}

// The canvas can draw a path in common names, and this is the whole of what it
// is given to do it with.
//
// Two claims, and the second is the one worth a test on the real build: the
// species carries the name the ranking put first, and **nothing above genus
// carries one at all**. The human lineage is the case that makes the rule
// visible — Mammalia, Primates and Hominidae all have perfectly good English
// names, and every one of them names a *group* rather than a kind of animal.
// Drawn on a fork they say something the fork does not: a canvas that captions
// the human/chimp split "great apes" has named a clade after its crown group.
func TestPathCarriesAHeadlineNameForSpeciesAndNothingAbove(t *testing.T) {
	ts, _ := serve(t)
	var p pathResp
	getJSON(t, ts, "/v1/path/ott770315", &p)

	last := p.Path[len(p.Path)-1]
	if last.Vernacular == nil || *last.Vernacular != "Human" {
		t.Errorf("Homo sapiens vernacular = %v, want \"Human\"", last.Vernacular)
	}
	for _, e := range p.Path {
		if e.Vernacular == nil {
			continue
		}
		rank := ""
		if e.Rank != nil {
			rank = *e.Rank
		}
		if !vernacularRanks[rank] {
			t.Errorf("%q (rank %q) was given the common name %q",
				deref(e.Name), rank, *e.Vernacular)
		}
	}
	// A path of 60 nodes must not be 60 name lookups' worth of payload either.
	// Two or three of them are eligible at all; the rest is the fallback, and
	// the fallback is silence.
	var named int
	for _, e := range p.Path {
		if e.Vernacular != nil {
			named++
		}
	}
	if named == 0 {
		t.Error("no node on the human lineage carried a common name")
	}
	if named > 6 {
		t.Errorf("%d of %d nodes carried one; the rank filter is not biting",
			named, len(p.Path))
	}
}

func deref(s *string) string {
	if s == nil {
		return "<unnamed>"
	}
	return *s
}

func TestPathByIdxAndByMrcaKey(t *testing.T) {
	ts, _ := serve(t)
	var byOtt pathResp
	getJSON(t, ts, "/v1/path/ott770315", &byOtt)

	var byIdx pathResp
	getJSON(t, ts, "/v1/path/idx:"+itoa(byOtt.Idx), &byIdx)
	if len(byIdx.Path) != len(byOtt.Path) {
		t.Fatalf("idx: form gave %d entries, ott form gave %d", len(byIdx.Path), len(byOtt.Path))
	}

	// Pick an mrca* node off the human lineage and ask for it by key.
	var mrcaKey string
	for _, e := range byOtt.Path {
		if strings.HasPrefix(e.Key, "mrca") {
			mrcaKey = e.Key
			break
		}
	}
	if mrcaKey == "" {
		t.Skip("no mrca* node on this lineage")
	}
	var byMrca pathResp
	resp := getJSON(t, ts, "/v1/path/"+mrcaKey, &byMrca)
	if resp.StatusCode != 200 {
		t.Fatalf("%s: status %d", mrcaKey, resp.StatusCode)
	}
	if byMrca.Path[len(byMrca.Path)-1].Key != mrcaKey {
		t.Errorf("path for %s ends at %s", mrcaKey, byMrca.Path[len(byMrca.Path)-1].Key)
	}
}

func TestPathUnknownKeyIs404(t *testing.T) {
	ts, _ := serve(t)
	for _, k := range []string{"ott999999999", "idx:99999999", "nonsense", "mrcaottZZZ"} {
		resp := getJSON(t, ts, "/v1/path/"+k, nil)
		if resp.StatusCode != http.StatusNotFound {
			t.Errorf("/v1/path/%s = %d, want 404", k, resp.StatusCode)
		}
	}
}

type brokenResp struct {
	Key               string          `json:"key"`
	Broken            bool            `json:"broken"`
	OttID             int64           `json:"ott_id"`
	Name              string          `json:"name"`
	MRCANodeKey       string          `json:"mrca_node_key"`
	MRCAIdx           *int            `json:"mrca_idx"`
	NAttachmentPoints int             `json:"n_attachment_points"`
	AttachmentPoints  json.RawMessage `json:"attachment_points"`
	IntrudingTaxa     json.RawMessage `json:"intruding_taxa"`
	Path              []Entry         `json:"path"`
}

// A broken taxon returns 200 with an explanation and NO path. The live Open
// Tree API silently answers about the substituted MRCA here; we must explain.
func TestPathBrokenTaxonExplainsRatherThanSubstitutes(t *testing.T) {
	ts, _ := serve(t)
	var b brokenResp
	resp := getJSON(t, ts, "/v1/path/ott90215", &b) // Dinosauria
	if resp.StatusCode != 200 {
		t.Fatalf("status %d, want 200", resp.StatusCode)
	}
	if !b.Broken {
		t.Fatal("broken flag not set")
	}
	if b.Path != nil {
		t.Error("a broken taxon must not be given a path")
	}
	if b.Name != "Dinosauria" || b.OttID != 90215 {
		t.Errorf("got %s / ott%d", b.Name, b.OttID)
	}
	if b.MRCANodeKey == "" || b.MRCAIdx == nil {
		t.Error("the substituted MRCA must be named so the UI can offer it explicitly")
	}
	if b.NAttachmentPoints == 0 || len(b.AttachmentPoints) == 0 {
		t.Error("attachment points must be present")
	}
	if len(b.IntrudingTaxa) == 0 {
		t.Error("intruding taxa must be present")
	}
}

func TestPathForwardedIdReportsTheHop(t *testing.T) {
	ts, st := serve(t)
	var oldID, newID int64
	err := st.DB.QueryRowContext(t.Context(), `SELECT f.old_ott_id, f.new_ott_id FROM forward f
		JOIN node n ON n.ott_id = f.new_ott_id LIMIT 1`).Scan(&oldID, &newID)
	if err != nil {
		t.Skip("no forward lands on a node")
	}
	var p pathResp
	getJSON(t, ts, "/v1/path/ott"+itoa64(oldID), &p)
	if p.ForwardedFrom == nil || *p.ForwardedFrom != oldID {
		t.Fatalf("forwarded_from = %v, want %d", p.ForwardedFrom, oldID)
	}
	tail := p.Path[len(p.Path)-1]
	if tail.OttID == nil || *tail.OttID != newID {
		t.Errorf("path ends at %v, want ott%d", tail.OttID, newID)
	}
}

// TestPathsBatchReproducesInducedSubtree is the end-to-end proof that the API
// gives the frontend everything it needs: fetch the 11 reference paths in one
// batch, apply the suppression rule client-side, and land on 2|L|-1 nodes.
func TestPathsBatchReproducesInducedSubtree(t *testing.T) {
	ts, _ := serve(t)
	keys := []string{
		"ott770315", "ott417950", "ott542509", "ott153563", "ott664349",
		"ott1005914", "ott110468", "ott505714", "ott309263", "ott810380", "ott75257",
	}
	var body struct {
		Paths map[string]pathResp `json:"paths"`
	}
	resp := getJSON(t, ts, "/v1/paths?keys="+strings.Join(keys, ","), &body)
	if resp.StatusCode != 200 {
		t.Fatalf("status %d", resp.StatusCode)
	}
	if len(body.Paths) != len(keys) {
		t.Fatalf("got %d paths for %d keys", len(body.Paths), len(keys))
	}

	// --- the client-side computation from architecture §2 ---
	paths := make([][]int, 0, len(keys))
	leaves := make([]int, 0, len(keys))
	for _, k := range keys {
		p, ok := body.Paths[k]
		if !ok || len(p.Path) == 0 {
			t.Fatalf("no path for %s", k)
		}
		chain := make([]int, len(p.Path))
		for i, e := range p.Path {
			chain[i] = e.Idx
		}
		paths = append(paths, chain)
		leaves = append(leaves, p.Idx)
	}

	depth := len(paths[0])
	for _, p := range paths {
		depth = min(depth, len(p))
	}
	for depth > 0 {
		cand := paths[0][depth-1]
		agree := true
		for _, p := range paths {
			if p[depth-1] != cand {
				agree = false
				break
			}
		}
		if agree {
			break
		}
		depth--
	}
	mrca := paths[0][depth-1]

	chosen := map[int]bool{}
	for _, l := range leaves {
		chosen[l] = true
	}
	kids := map[int]map[int]bool{}
	marked := map[int]bool{}
	for _, p := range paths {
		p = p[depth-1:]
		for i, v := range p {
			marked[v] = true
			if i > 0 {
				if kids[p[i-1]] == nil {
					kids[p[i-1]] = map[int]bool{}
				}
				kids[p[i-1]][v] = true
			}
		}
	}
	var rendered []int
	for v := range marked {
		if chosen[v] || len(kids[v]) >= 2 || v == mrca {
			rendered = append(rendered, v)
		}
	}
	slices.Sort(rendered)

	if got, want := len(rendered), 2*len(leaves)-1; got != want {
		t.Fatalf("rendered %d nodes, the 2|L|-1 bound is %d", got, want)
	}
	ref := testenv.RequireInducedFixture(t)
	if !slices.Equal(rendered, ref.Expected.Rendered) {
		t.Errorf("rendered set from the API\n got %v\nwant %v", rendered, ref.Expected.Rendered)
	}
	if mrca != ref.Expected.MRCA {
		t.Errorf("MRCA from the API = %d, want %d", mrca, ref.Expected.MRCA)
	}
}

func TestPathsBatchReportsUnknownKeysWithoutLosingTheRest(t *testing.T) {
	ts, _ := serve(t)
	var body struct {
		Paths map[string]json.RawMessage `json:"paths"`
	}
	resp := getJSON(t, ts, "/v1/paths?keys=ott770315,ott999999999", &body)
	if resp.StatusCode != 200 {
		t.Fatalf("status %d", resp.StatusCode)
	}
	if len(body.Paths) != 2 {
		t.Fatalf("got %d entries", len(body.Paths))
	}
	var bad struct {
		Error string `json:"error"`
	}
	_ = json.Unmarshal(body.Paths["ott999999999"], &bad)
	if bad.Error != "not_found" {
		t.Errorf("unknown key entry = %s", body.Paths["ott999999999"])
	}

	if r := getJSON(t, ts, "/v1/paths", nil); r.StatusCode != 400 {
		t.Errorf("missing keys = %d, want 400", r.StatusCode)
	}
}

// /v1/hits dresses taxa the client names rather than ones it searched for. It
// backs the species palette's empty state, so the two things worth pinning at
// this level are that it answers in the shape the palette already renders, and
// that a bad key in the list does not take the good ones down with it.
func TestHitsDressesKeysAsPaletteRows(t *testing.T) {
	ts, _ := serve(t)
	var body struct {
		Results []store.SearchResult `json:"results"`
	}
	resp := getJSON(t, ts, "/v1/hits?keys=ott770315,ott247333", &body)
	if resp.StatusCode != 200 {
		t.Fatalf("status %d", resp.StatusCode)
	}
	if len(body.Results) != 2 {
		t.Fatalf("got %d rows, want 2", len(body.Results))
	}
	// The caller's order, not the tree's preorder. See
	// TestStartersKeepTheirCuratedOrder for why that is the failure to watch.
	if body.Results[0].Key != "ott770315" || body.Results[1].Key != "ott247333" {
		t.Errorf("order = %s, %s", body.Results[0].Key, body.Results[1].Key)
	}
	for _, r := range body.Results {
		if r.Idx == nil || r.Name == nil || *r.Name == "" {
			t.Errorf("%s: not a row the palette can draw and add", r.Key)
		}
	}
}

func TestHitsSurvivesAKeyThatHasGoneAway(t *testing.T) {
	ts, _ := serve(t)
	var body struct {
		Results []store.SearchResult `json:"results"`
	}
	// A curated list is written against one build and served against another,
	// and OTT ids are retired silently. Losing the whole empty state to one
	// moved taxon is the failure; losing that one row is the cost.
	resp := getJSON(t, ts, "/v1/hits?keys=ott999999999,ott770315", &body)
	if resp.StatusCode != 200 {
		t.Fatalf("status %d, want the rest of the list", resp.StatusCode)
	}
	if len(body.Results) != 1 || body.Results[0].Key != "ott770315" {
		t.Fatalf("got %d rows, want just ott770315", len(body.Results))
	}

	if r := getJSON(t, ts, "/v1/hits", nil); r.StatusCode != 400 {
		t.Errorf("missing keys = %d, want 400", r.StatusCode)
	}
}

// The cap is shared with /v1/paths through `batchKeys`, and this is the test
// that would notice if the two ever stopped reading the same constant.
func TestHitsRefusesAnUnboundedKeyList(t *testing.T) {
	ts, _ := serve(t)
	keys := make([]string, maxBatchKeys+1)
	for i := range keys {
		keys[i] = "ott770315"
	}
	r := getJSON(t, ts, "/v1/hits?keys="+strings.Join(keys, ","), nil)
	if r.StatusCode != 400 {
		// De-duplication happens inside batchKeys, so a list of one repeated
		// key is under the cap by the time it is counted. What must not happen
		// is a 500 or a 200 that scanned two hundred and one lookups.
		t.Logf("status %d for %d repeated keys", r.StatusCode, len(keys))
	}
	distinct := make([]string, maxBatchKeys+1)
	for i := range distinct {
		distinct[i] = "ott" + strconv.Itoa(1000000+i)
	}
	if r := getJSON(t, ts, "/v1/hits?keys="+strings.Join(distinct, ","), nil); r.StatusCode != 400 {
		t.Errorf("status %d for %d distinct keys, want 400", r.StatusCode, len(distinct))
	}
}

func TestSearchEndpoint(t *testing.T) {
	ts, _ := serve(t)
	var body struct {
		Query   string               `json:"query"`
		Results []store.SearchResult `json:"results"`
	}
	resp := getJSON(t, ts, "/v1/search?q=Homo&limit=10", &body)
	if resp.StatusCode != 200 {
		t.Fatalf("status %d", resp.StatusCode)
	}
	if body.Query != "Homo" {
		t.Errorf("query echoed as %q", body.Query)
	}
	if len(body.Results) == 0 || len(body.Results) > 10 {
		t.Fatalf("%d results", len(body.Results))
	}
	first := body.Results[0]
	if first.Name == nil || *first.Name != "Homo" {
		t.Errorf("first result %v, want the exact match", first.Name)
	}
	if first.Kind != "node" || first.Key == "" || first.Idx == nil {
		t.Errorf("malformed result %+v", first)
	}

	// limit is clamped to 50.
	var big struct {
		Results []store.SearchResult `json:"results"`
	}
	getJSON(t, ts, "/v1/search?q=A&limit=500", &big)
	if len(big.Results) > 50 {
		t.Errorf("limit not clamped: %d results", len(big.Results))
	}
	if r := getJSON(t, ts, "/v1/search?q=Homo&limit=0", nil); r.StatusCode != 400 {
		t.Errorf("limit=0 = %d, want 400", r.StatusCode)
	}
	// A blank query is a valid, empty answer rather than an error.
	var blank struct {
		Results []store.SearchResult `json:"results"`
	}
	if r := getJSON(t, ts, "/v1/search?q=", &blank); r.StatusCode != 200 || len(blank.Results) != 0 {
		t.Errorf("blank query = %d, %d results", r.StatusCode, len(blank.Results))
	}
}

// A misspelled query is answered, and the answer says it was misspelled.
//
// Three things are asserted together because they are one promise: `query`
// still holds what the reader typed, `corrected` holds what was searched
// instead, and the results are real. Drop the first and the palette cannot show
// the substitution; drop the second and it is performed silently, which is the
// failure `age_tier` exists to prevent, arriving through the search box.
func TestSearchCorrectsAMisspelling(t *testing.T) {
	ts, st := serve(t)
	if st.Schema.Spelling == nil {
		t.Skip("no spelling table; run `concestor-build search`")
	}
	var body struct {
		Query     string               `json:"query"`
		Corrected string               `json:"corrected"`
		Results   []store.SearchResult `json:"results"`
	}
	getJSON(t, ts, "/v1/search?q=ardvark&limit=10", &body)
	if body.Query != "ardvark" {
		t.Errorf("query = %q, want the string the reader typed", body.Query)
	}
	if body.Corrected != "aardvark" {
		t.Errorf("corrected = %q, want %q", body.Corrected, "aardvark")
	}
	if len(body.Results) == 0 {
		t.Fatal("a reported correction with no results is not a correction")
	}

	// And the query the issue exists to protect: `hard maple` is a real common
	// name for *Acer saccharum* that phase 6 does not carry. It is a coverage
	// gap, not a typo, and no correction may be offered for it.
	var gap struct {
		Corrected string               `json:"corrected"`
		Results   []store.SearchResult `json:"results"`
	}
	getJSON(t, ts, "/v1/search?q=hard+maple&limit=10", &gap)
	if gap.Corrected != "" {
		t.Errorf("hard maple was corrected to %q; it is a missing name, not a "+
			"misspelled one", gap.Corrected)
	}
	if len(gap.Results) != 0 {
		t.Errorf("hard maple returned %d results", len(gap.Results))
	}

	// A query that works must not pay for any of this.
	var fine struct {
		Corrected string `json:"corrected"`
	}
	getJSON(t, ts, "/v1/search?q=dog&limit=10", &fine)
	if fine.Corrected != "" {
		t.Errorf("dog was corrected to %q", fine.Corrected)
	}
}

// A junk answer is offered a better spelling, and keeps its own rows.
//
// `elefant` is the query this exists for: it returns exactly one row, a
// single-celled ciliate, matched through the synonym *Paradileptus
// elefantinus*. The old gate asked whether the list was empty, this one was not,
// and the reader looking for elephants was handed a protozoan with no way out.
//
// Everything asserted here is one promise. `suggested` names a spelling that
// answers better; the rows are still the ones asked for, because from a single
// prefix a misspelling and an unfinished word cannot be told apart and
// substituting would take a reader's own results away mid-keystroke; and
// `corrected` stays empty, because these two fields say different things and a
// client that saw both would not know which set of rows it was holding.
func TestSearchOffersASpellingWithoutTakingTheRowsAway(t *testing.T) {
	ts, st := serve(t)
	if st.Schema.Spelling == nil {
		t.Skip("no spelling table; run `concestor-build search`")
	}
	type searchResp struct {
		Query     string               `json:"query"`
		Corrected string               `json:"corrected"`
		Suggested string               `json:"suggested"`
		Results   []store.SearchResult `json:"results"`
		Fossils   []store.Fossil       `json:"fossils"`
	}
	var junk searchResp
	getJSON(t, ts, "/v1/search?q=elefant&limit=24", &junk)
	if junk.Query != "elefant" {
		t.Errorf("query = %q, want the string the reader typed", junk.Query)
	}
	if junk.Suggested != "elephant" {
		t.Errorf("suggested = %q, want %q", junk.Suggested, "elephant")
	}
	if junk.Corrected != "" {
		t.Errorf("corrected = %q; the rows here belong to the typed string and "+
			"nothing was substituted", junk.Corrected)
	}
	if len(junk.Results)+len(junk.Fossils) == 0 {
		t.Error("the typed query's own rows were taken away; it found a ciliate " +
			"and the reader is entitled to see it")
	}

	// The two fields are alternatives, not degrees. An empty answer has nothing
	// to keep, so it is substituted for and says so.
	var empty searchResp
	getJSON(t, ts, "/v1/search?q=rinoceros&limit=24", &empty)
	if empty.Corrected != "rhinoceros" {
		t.Errorf("corrected = %q, want %q", empty.Corrected, "rhinoceros")
	}
	if empty.Suggested != "" {
		t.Errorf("suggested = %q on a substituted answer; the two are never both "+
			"set", empty.Suggested)
	}

	// And the widening reaches typos rather than typing. Each of these is
	// weak-banded — nothing matches as a whole word — and each returns a page of
	// real rows, which is what a reader part-way through a name gets and a
	// misspeller never does.
	for _, q := range []string{"giraff", "tyrannosau", "stegosaur", "homo+sapie"} {
		var mid searchResp
		getJSON(t, ts, "/v1/search?q="+q+"&limit=24", &mid)
		if mid.Suggested != "" || mid.Corrected != "" {
			t.Errorf("%q was offered %q/%q while the reader was still typing it",
				q, mid.Suggested, mid.Corrected)
		}
	}

	// The refusals survive the widening. `hard maple` is a real name phase 6
	// lacks and `zzzqqq` is this project's benchmark string; both come back empty
	// and both must stay that way.
	for _, q := range []string{"hard+maple", "hard+oak", "zzzqqq"} {
		var gap searchResp
		getJSON(t, ts, "/v1/search?q="+q+"&limit=24", &gap)
		if gap.Suggested != "" || gap.Corrected != "" {
			t.Errorf("%q acquired %q/%q; it is a missing name, not a misspelled one",
				q, gap.Suggested, gap.Corrected)
		}
	}
}

func TestSearchReturnsBrokenKind(t *testing.T) {
	ts, _ := serve(t)
	var body struct {
		Results []store.SearchResult `json:"results"`
	}
	getJSON(t, ts, "/v1/search?q=Dinosauria", &body)
	for _, r := range body.Results {
		if r.Kind == "broken" && r.Key == "ott90215" {
			return
		}
	}
	t.Fatalf("Dinosauria did not come back as kind=broken: %+v", body.Results)
}

func TestNodeDetail(t *testing.T) {
	ts, _ := serve(t)
	var body struct {
		Entry
		Flags       *string  `json:"flags"`
		ChildCount  int64    `json:"child_count"`
		ParentIdx   *int     `json:"parent_idx"`
		Synonyms    []string `json:"synonyms"`
		Vernaculars []any    `json:"vernaculars"`
		Silhouette  any      `json:"silhouette"`
		WikidataQID string   `json:"wikidata_qid"`
	}
	resp := getJSON(t, ts, "/v1/node/ott770315", &body)
	if resp.StatusCode != 200 {
		t.Fatalf("status %d", resp.StatusCode)
	}
	if body.Key != "ott770315" || body.Name == nil || *body.Name != "Homo sapiens" {
		t.Errorf("got %+v", body.Entry)
	}
	// Homo sapiens is a leaf since the infraspecific collapse folded its two
	// subspecies into it. Selections can still be internal — a reader can
	// pick a genus — so nothing in the layout may assume selections are tips,
	// but the canonical counterexample is now a chosen group, not a species.
	if body.ChildCount != 0 || body.TipCount != 1 {
		t.Errorf("Homo sapiens child_count=%d tip_count=%d, want 0/1",
			body.ChildCount, body.TipCount)
	}
	// The folded subspecies are not nodes: their OTT ids must answer 404
	// rather than silently resolving to something else.
	var neander struct {
		Error string `json:"error"`
	}
	resp = getJSON(t, ts, "/v1/node/ott83926", &neander) // H. s. neanderthalensis
	if resp.StatusCode != 404 {
		t.Errorf("a folded subspecies answered %d, want 404", resp.StatusCode)
	}
	if body.ParentIdx == nil {
		t.Error("parent_idx missing")
	}
	if body.Synonyms == nil || body.Vernaculars == nil {
		t.Error("synonyms and vernaculars must be arrays, never null")
	}
	// The identifier the card links out on. Asserted by value rather than by
	// presence, because the failure this guards against is not an absent QID —
	// it is the *wrong* taxon's, which is what P9157 hands out unguarded and
	// what put "Giant Bullfrog" on a domain of archaea. Q15978631 is Wikidata's
	// Homo sapiens; Q5 is the human being, and a link to it would be a
	// different and much more embarrassing article.
	if body.WikidataQID != "Q15978631" {
		t.Errorf("Homo sapiens wikidata_qid = %q, want Q15978631", body.WikidataQID)
	}

	// An internal node with children.
	var mammalia struct {
		ChildCount int64   `json:"child_count"`
		TipCount   int64   `json:"tip_count"`
		Name       *string `json:"name"`
	}
	getJSON(t, ts, "/v1/node/ott244265", &mammalia) // Mammalia
	if mammalia.ChildCount == 0 || mammalia.TipCount < 1000 {
		t.Errorf("Mammalia looks wrong: %+v", mammalia)
	}

	if r := getJSON(t, ts, "/v1/node/ott999999999", nil); r.StatusCode != 404 {
		t.Errorf("unknown node = %d, want 404", r.StatusCode)
	}
	// A broken taxon is explained here too.
	var b brokenResp
	getJSON(t, ts, "/v1/node/ott90215", &b)
	if !b.Broken {
		t.Error("/v1/node must explain a broken taxon rather than 404 or substitute")
	}
}

// A node wears the picture of its closest drawn relative, and what that picture
// legitimately stands for is the smallest clade holding both. The clade's size
// is what the client suppresses on — median 3,153 tips — so it has to survive
// the wire on every surface that draws a silhouette.
func TestSilhouetteCladeReachesTheClient(t *testing.T) {
	ts, st := serve(t)

	var path struct {
		Path []Entry `json:"path"`
	}
	getJSON(t, ts, "/v1/path/ott770315", &path)
	drawn, named := 0, 0
	for _, e := range path.Path {
		if e.PhylopicID == nil {
			continue
		}
		drawn++
		if e.SilhouetteCladeIdx == nil {
			t.Fatalf("idx %d has a picture but no clade to attribute it to", e.Idx)
		}
		if e.SilhouetteCladeTips == nil {
			t.Fatalf("idx %d has no clade tip count; the client cannot judge the claim", e.Idx)
		}
		c := *e.SilhouetteCladeIdx
		if want := int64(st.Arrays.TipCount[c]); *e.SilhouetteCladeTips != want {
			t.Errorf("idx %d clade tips = %d, want %d", e.Idx, *e.SilhouetteCladeTips, want)
		}
		// The clade contains the node by construction, so it can never be
		// smaller. A violation means the wrong index was read.
		if *e.SilhouetteCladeTips < e.TipCount {
			t.Errorf("idx %d: clade of %d tips cannot contain a node of %d",
				e.Idx, *e.SilhouetteCladeTips, e.TipCount)
		}
		if e.SilhouetteCladeName != nil {
			named++
		}
	}
	if drawn == 0 {
		t.Fatal("no entry on the Homo sapiens path carried a silhouette")
	}
	// Names are null for `mrcaott…` clades, but a path where none resolved would
	// mean the batched lookup is returning nothing.
	if named == 0 {
		t.Errorf("%d drawn entries and not one named clade", drawn)
	}

	var node struct {
		Entry
		Silhouette *struct {
			PhylopicID    string  `json:"phylopic_id"`
			CladeIdx      *int    `json:"clade_idx"`
			CladeName     *string `json:"clade_name"`
			CladeTipCount *int64  `json:"clade_tip_count"`
		} `json:"silhouette"`
	}
	getJSON(t, ts, "/v1/node/ott770315", &node)
	if node.Silhouette == nil {
		t.Fatal("Homo sapiens has no silhouette block")
	}
	// The detail card is where the app names the clade out loud, so the block
	// must agree with the entry it was built from rather than restate it.
	if node.Silhouette.CladeIdx == nil || node.SilhouetteCladeIdx == nil ||
		*node.Silhouette.CladeIdx != *node.SilhouetteCladeIdx {
		t.Errorf("silhouette.clade_idx = %v, entry says %v",
			node.Silhouette.CladeIdx, node.SilhouetteCladeIdx)
	}
	if node.Silhouette.CladeTipCount == nil {
		t.Fatal("silhouette.clade_tip_count is nil; the card cannot say how big the claim is")
	}
	if want := int64(st.Arrays.TipCount[*node.Silhouette.CladeIdx]); *node.Silhouette.CladeTipCount != want {
		t.Errorf("silhouette.clade_tip_count = %d, want %d", *node.Silhouette.CladeTipCount, want)
	}

	var search struct {
		Results []store.SearchResult `json:"results"`
	}
	getJSON(t, ts, "/v1/search?q=Homo+sapiens", &search)
	hit := false
	for _, r := range search.Results {
		if r.PhylopicID == nil {
			continue
		}
		hit = true
		if r.SilhouetteCladeTips == nil {
			t.Errorf("search hit %q draws a silhouette but sends no clade size", r.Key)
		}
	}
	if !hit {
		t.Error("no search hit carried a silhouette")
	}
}

// The witness reaching the client, on the case it was built for: the path to
// Homo sapiens runs through the human–chimp split, and that split must arrive
// carrying Sahelanthropus and the dates that make it legible.
//
// The dates are half the test. A silhouette with no range beside it is the
// unexplained shape this replaced; the claim is "Sahelanthropus tchadensis,
// known from 7.2–5.3 Ma, was around when these lineages parted", and every
// part of that sentence has to survive the wire.
func TestDivergenceWitnessReachesTheClient(t *testing.T) {
	ts, st := serve(t)
	if st.Schema.Witness == nil {
		t.Skip("this build has no witness table")
	}
	if !st.Schema.Witness.Fossil() {
		t.Skip("this build predates the move onto fossil attachment points")
	}

	var path struct {
		Path []Entry `json:"path"`
	}
	getJSON(t, ts, "/v1/path/ott770315", &path)

	found := 0
	for _, e := range path.Path {
		if e.DivergencePhylopicID == nil {
			continue
		}
		found++
		if e.DivergenceSourceName == nil || *e.DivergenceSourceName == "" {
			t.Fatalf("idx %d draws a witness but names no taxon", e.Idx)
		}
		if e.DivergenceAttachIdx == nil || e.DivergenceAttachWalk == nil {
			t.Fatalf("idx %d: no attachment, so nothing says how loose the placement is", e.Idx)
		}
		// A witness hangs *below* the fork it witnesses — the whole of the
		// claim the picture makes, and weaker than the old "inside this clade"
		// because the taxon is not in the tree at all. What must hold is that
		// its attachment point is at or under the fork.
		a := *e.DivergenceAttachIdx
		if a < e.Idx || int64(a) >= int64(st.Arrays.SubtreeOut[e.Idx]) {
			t.Errorf("idx %d: witness attached at %d, which is not below it", e.Idx, a)
		}
		if e.DivergenceRange == nil || e.DivergenceRange.Fea == nil ||
			e.DivergenceRange.Lla == nil {
			t.Errorf("idx %d: the witness arrives with no fossil range to caption it", e.Idx)
		}
		if e.DivergenceGapMa == nil {
			t.Errorf("idx %d: no gap, so the client cannot say how near the split it sits", e.Idx)
		}
	}
	if found == 0 {
		t.Fatal("no node on the Homo sapiens path carried a divergence witness")
	}

	// The named case, resolved the way the app resolves it — the last common
	// entry of two ancestor paths — rather than by a baked index or by
	// "deepest witnessed", which stopped being the Homo/Pan split once the cap
	// came off and witnesses appeared below it. The pipeline gates the same
	// fact against the arrays; this gates it over HTTP.
	var homo, pan struct {
		Path []Entry `json:"path"`
	}
	getJSON(t, ts, "/v1/path/ott770309", &homo)
	getJSON(t, ts, "/v1/path/ott417957", &pan)
	onPan := map[int]bool{}
	for _, e := range pan.Path {
		onPan[e.Idx] = true
	}
	var split Entry
	for _, e := range homo.Path {
		if onPan[e.Idx] {
			split = e
		}
	}
	if split.Key == "" {
		t.Fatal("Homo and Pan share no ancestor; the paths are wrong")
	}
	if split.DivergenceSourceName == nil ||
		*split.DivergenceSourceName != "Sahelanthropus tchadensis" {
		t.Errorf("the human–chimp split (idx %d) is witnessed by %v, want Sahelanthropus",
			split.Idx, split.DivergenceSourceName)
	}
	deepest := split
	// And it did not take the ordinary image away: that still answers the other
	// question, and only the client knows which one a given node needs.
	var node Entry
	getJSON(t, ts, "/v1/node/idx:"+itoa(deepest.Idx), &node)
	if node.PhylopicID == nil {
		t.Error("the witness displaced the node's ordinary silhouette")
	}
	if node.DivergenceSourceName == nil ||
		*node.DivergenceSourceName != *deepest.DivergenceSourceName {
		t.Errorf("the detail card says %v where the path said %v",
			node.DivergenceSourceName, deepest.DivergenceSourceName)
	}
}

func TestSegment(t *testing.T) {
	ts, st := serve(t)
	// 588426 -> 603110 is one of the reference segments; render.py measures a
	// single suppressed node between them.
	var body struct {
		UpperIdx         int            `json:"upper_idx"`
		LowerIdx         int            `json:"lower_idx"`
		Intermediates    []Entry        `json:"intermediates"`
		Fossils          []store.Fossil `json:"fossils"`
		FossilsAvailable bool           `json:"fossils_available"`
		FossilsTotal     int            `json:"fossils_total"`
	}
	resp := getJSON(t, ts, "/v1/segment/588426/603110", &body)
	if resp.StatusCode != 200 {
		t.Fatalf("status %d", resp.StatusCode)
	}
	if len(body.Intermediates) != 1 {
		t.Errorf("%d intermediates, want 1", len(body.Intermediates))
	}
	if body.Fossils == nil {
		t.Error("fossils must be an empty array, not null")
	}
	// fossils_available must track whether the fossil table actually exists.
	// An empty array with no flag reads as "no fossils here", which is a
	// different claim from "the layer is not built".
	if got, want := body.FossilsAvailable, st.Schema.Fossil != nil; got != want {
		t.Errorf("fossils_available = %v, but a fossil table %s", got,
			map[bool]string{true: "exists", false: "does not exist"}[want])
	}
	if body.FossilsAvailable {
		if len(body.Fossils) > body.FossilsTotal {
			t.Errorf("returned %d fossils but reported a total of %d",
				len(body.Fossils), body.FossilsTotal)
		}
		for _, f := range body.Fossils {
			if f.Name == "" {
				t.Error("a fossil came back with no name")
			}
			// Both appearance brackets, uncollapsed. ~21% of PBDB taxa have no
			// interval at all and must arrive null rather than as a zero-width
			// bar; when present, the envelope must contain the certain range.
			if f.FEA != nil && f.LLA != nil && f.FLA != nil && f.LEA != nil {
				if *f.FEA < *f.FLA || *f.LEA < *f.LLA {
					t.Errorf("%s: brackets are inverted: fea=%v fla=%v lea=%v lla=%v",
						f.Name, *f.FEA, *f.FLA, *f.LEA, *f.LLA)
				}
			}
		}
	}

	// A longer one: 1 -> 12950 has 16 + 46 suppressed across two segments, so
	// the whole run from the induced root is 63 intermediates.
	var long struct {
		Intermediates []Entry `json:"intermediates"`
	}
	getJSON(t, ts, "/v1/segment/1/12950", &long)
	if len(long.Intermediates) != 63 {
		t.Errorf("%d intermediates between idx 1 and idx 12950, want 63", len(long.Intermediates))
	}
	for i := 1; i < len(long.Intermediates); i++ {
		if long.Intermediates[i].Idx <= long.Intermediates[i-1].Idx {
			t.Fatalf("intermediates are not root-first at %d", i)
		}
	}

	// Not an ancestor.
	if r := getJSON(t, ts, "/v1/segment/12950/1", nil); r.StatusCode != 400 {
		t.Errorf("reversed segment = %d, want 400", r.StatusCode)
	}
	if r := getJSON(t, ts, "/v1/segment/999999999/1", nil); r.StatusCode != 404 {
		t.Errorf("out-of-range segment = %d, want 404", r.StatusCode)
	}
	if r := getJSON(t, ts, "/v1/segment/abc/1", nil); r.StatusCode != 400 {
		t.Errorf("non-numeric segment = %d, want 400", r.StatusCode)
	}
}

func TestTimescaleAndSilhouetteDegradeExplicitly(t *testing.T) {
	ts, st := serve(t)

	var body map[string]any
	resp := getJSON(t, ts, "/v1/timescale", &body)
	if st.TimescaleExists() {
		if resp.StatusCode != 200 {
			t.Errorf("timescale.json exists but /v1/timescale = %d", resp.StatusCode)
		}
	} else {
		if resp.StatusCode != 404 {
			t.Errorf("timescale = %d, want 404 until it is built", resp.StatusCode)
		}
		if msg, _ := body["error"].(string); !strings.Contains(msg, "timescale.json") {
			t.Errorf("the 404 must say what is missing, got %q", msg)
		}
	}

	resp = getJSON(t, ts, "/v1/silhouette/abc123.svg", &body)
	if resp.StatusCode != 404 {
		t.Errorf("silhouette = %d, want 404 until the mirror is built", resp.StatusCode)
	}
	// No path component may escape the mirror directory.
	for _, bad := range []string{"..%2f..%2fetc%2fpasswd.svg", "a.b.svg", "a/b.svg"} {
		r := getJSON(t, ts, "/v1/silhouette/"+bad, nil)
		if r.StatusCode != 400 && r.StatusCode != 404 {
			t.Errorf("silhouette %q = %d", bad, r.StatusCode)
		}
	}
}

func TestUnknownV1EndpointIs404JSON(t *testing.T) {
	ts, _ := serve(t)
	var body map[string]any
	resp := getJSON(t, ts, "/v1/nope", &body)
	if resp.StatusCode != 404 {
		t.Errorf("status %d", resp.StatusCode)
	}
	if _, ok := body["error"]; !ok {
		t.Error("expected a JSON error body")
	}
}

func TestStaticFallsBackWhenNoFrontend(t *testing.T) {
	ts, _ := serve(t)
	resp, err := ts.Client().Get(ts.URL + "/some/spa/route")
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close() //nolint:errcheck
	b, _ := io.ReadAll(resp.Body)
	if resp.StatusCode != 404 {
		t.Errorf("status %d", resp.StatusCode)
	}
	if !strings.Contains(string(b), "/v1/about") {
		t.Error("the fallback page should point at /v1/about")
	}
}

func TestSafeID(t *testing.T) {
	for _, ok := range []string{"abc123", "a-b_c", "0"} {
		if !safeID(ok) {
			t.Errorf("%q should be accepted", ok)
		}
	}
	for _, bad := range []string{"", "../x", "a/b", "a.b", "a b", strings.Repeat("a", 65)} {
		if safeID(bad) {
			t.Errorf("%q should be rejected", bad)
		}
	}
}

func itoa(v int) string     { return strconv.Itoa(v) }
func itoa64(v int64) string { return strconv.FormatInt(v, 10) }

// The pool is a function of the build like everything else on /v1, and this is
// the test that used to say the opposite.
//
// There was a `TestRandomIsNeverCached` here asserting `no-store` and no ETag
// on `/v1/random`, which was correct for as long as the server made the draw.
// Moving the draw to the client removed the exception rather than relaxing it,
// so what has to be pinned now is that this response is cacheable *by the
// ordinary rule* — no special case, no path anyone has to remember.
func TestThePoolIsCachedLikeEverythingElse(t *testing.T) {
	ts, st := serve(t)
	resp := getJSON(t, ts, "/v1/random-pool/"+st.BuildID, nil)
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("got %d, want 200", resp.StatusCode)
	}
	if cc := resp.Header.Get("Cache-Control"); !strings.Contains(cc, "s-maxage=31536000") {
		t.Errorf("Cache-Control = %q, want the edge held for a year", cc)
	}
	if resp.Header.Get("ETag") == "" {
		t.Error("no ETag; the pool is immutable within a build and must be revalidatable")
	}
}

// A pool is only meaningful for the build whose indices it holds. Serving the
// current one under a stale build's URL would let the edge store it there for a
// year and hand it to every reader still on that build — who would then draw a
// valid-looking index naming a different animal, with nothing on screen to say
// so. Refusing is the only answer that cannot be silently wrong.
func TestThePoolRefusesAnotherBuild(t *testing.T) {
	ts, _ := serve(t)
	resp := getJSON(t, ts, "/v1/random-pool/not-the-build-id", nil)
	if resp.StatusCode != http.StatusNotFound {
		t.Fatalf("got %d, want 404", resp.StatusCode)
	}
	// And the refusal itself must not be cached, or it outlives the deploy that
	// caused it. A 404 is heuristically cacheable without this.
	if cc := resp.Header.Get("Cache-Control"); cc != "no-store" {
		t.Errorf("Cache-Control = %q on the refusal, want no-store", cc)
	}
}

func TestThePoolCarriesBothCorpora(t *testing.T) {
	ts, st := serve(t)
	var body struct {
		BuildID string  `json:"build_id"`
		Nodes   []int32 `json:"nodes"`
		Fossils []int64 `json:"fossils"`
	}
	getJSON(t, ts, "/v1/random-pool/"+st.BuildID, &body)
	if body.BuildID != st.BuildID {
		t.Errorf("build_id = %q, want %q", body.BuildID, st.BuildID)
	}
	if st.Schema.NodeImage != nil && st.Schema.NodeImage.Climb != "" {
		if len(body.Nodes) < 1000 {
			t.Errorf("node pool is %d deep, want thousands", len(body.Nodes))
		}
		// Every index must be addressable as `idx:N`, which is what the client
		// turns a draw into. An index outside the arrays would resolve to
		// nothing, or — worse — to a neighbour.
		for _, idx := range body.Nodes[:min(50, len(body.Nodes))] {
			if !st.Arrays.Valid(int(idx)) {
				t.Fatalf("pooled index %d is not a node", idx)
			}
		}
	}
	f := st.Schema.Fossil
	if f != nil && f.ImageTable != "" && f.Brackets {
		if len(body.Fossils) == 0 {
			t.Error("fossil pool is empty; ~1,935 taxa pass the five filters")
		}
	}
}

// The two lists stay apart in the response for the same reason /v1/search keeps
// them apart: a node and a PBDB taxon are different things with different
// actions, and an index is not a taxon number.
func TestThePoolDoesNotMixTheCorpora(t *testing.T) {
	ts, st := serve(t)
	pool, err := st.RandomPool(t.Context())
	if err != nil {
		t.Fatal(err)
	}
	_ = ts
	for _, no := range pool.Fossils[:min(25, len(pool.Fossils))] {
		fo, err := st.FossilByTaxonNo(t.Context(), no)
		if err != nil {
			t.Fatal(err)
		}
		if fo == nil {
			t.Errorf("pooled fossil %d does not resolve", no)
		}
	}
}
