package api

import (
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
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

	srv := &Server{St: st, Log: slog.New(slog.DiscardHandler), Immutable: true}
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
		"nodes": 2725682, "tips": 2385875, "internal": 339807, "broken": 9839,
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
	if tag != `"`+st.BuildID+`"` {
		t.Fatalf("ETag = %q, want %q", tag, st.BuildID)
	}
	if cc := resp.Header.Get("Cache-Control"); !strings.Contains(cc, "immutable") {
		t.Errorf("Cache-Control = %q", cc)
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
	wantRendered := []int{
		1, 18, 12950, 449434, 588406, 588414, 588422, 588426, 588435, 588587,
		594475, 594485, 594505, 603110, 633749, 654142, 674350, 741328, 882186,
		1176207, 2328159,
	}
	if !slices.Equal(rendered, wantRendered) {
		t.Errorf("rendered set from the API\n got %v\nwant %v", rendered, wantRendered)
	}
	if mrca != 1 {
		t.Errorf("MRCA from the API = %d, want 1", mrca)
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
	}
	resp := getJSON(t, ts, "/v1/node/ott770315", &body)
	if resp.StatusCode != 200 {
		t.Fatalf("status %d", resp.StatusCode)
	}
	if body.Key != "ott770315" || body.Name == nil || *body.Name != "Homo sapiens" {
		t.Errorf("got %+v", body.Entry)
	}
	// Homo sapiens is not a leaf: the synthesis tree hangs two subspecies off
	// it. A "species" the user picks is frequently an internal node, which is
	// why nothing in the layout may assume selections are tips.
	if body.ChildCount != 2 || body.TipCount != 2 {
		t.Errorf("Homo sapiens child_count=%d tip_count=%d, want 2/2",
			body.ChildCount, body.TipCount)
	}
	var neander struct {
		ChildCount int64 `json:"child_count"`
		TipCount   int64 `json:"tip_count"`
	}
	getJSON(t, ts, "/v1/node/ott83926", &neander) // Homo sapiens neanderthalensis
	if neander.ChildCount != 0 || neander.TipCount != 1 {
		t.Errorf("a genuine tip should be 0/1, got %d/%d", neander.ChildCount, neander.TipCount)
	}
	if body.ParentIdx == nil {
		t.Error("parent_idx missing")
	}
	if body.Synonyms == nil || body.Vernaculars == nil {
		t.Error("synonyms and vernaculars must be arrays, never null")
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
