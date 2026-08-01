// Package api serves the read-only HTTP contract described in architecture §4.
//
// Everything is immutable within a build, so every /v1 response carries an
// ETag derived from the build id and a one-year immutable Cache-Control. There
// is no write path, no session, and no runtime dependency on any upstream
// service: the Open Tree API is a build-time oracle only (architecture §9).
package api

import (
	"encoding/json"
	"errors"
	"log/slog"
	"math"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"

	"github.com/lsweigart12/concestor/server/internal/store"
	"github.com/lsweigart12/concestor/server/internal/topo"
)

// Server wires the store to an http.Handler.
type Server struct {
	St        *store.Store
	Log       *slog.Logger
	WebDist   string
	Immutable bool
}

// Handler builds the mux.
func (s *Server) Handler() http.Handler {
	mux := http.NewServeMux()

	mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Cache-Control", "no-store")
		w.Header().Set("Content-Type", "text/plain; charset=utf-8")
		_, _ = w.Write([]byte("ok"))
	})

	mux.HandleFunc("GET /v1/about", s.handleAbout)
	mux.HandleFunc("GET /v1/search", s.handleSearch)
	mux.HandleFunc("GET /v1/path/{key}", s.handlePath)
	mux.HandleFunc("GET /v1/paths", s.handlePaths)
	mux.HandleFunc("GET /v1/node/{key}", s.handleNode)
	mux.HandleFunc("GET /v1/segment/{upper}/{lower}", s.handleSegment)
	mux.HandleFunc("GET /v1/timescale", s.handleTimescale)
	mux.HandleFunc("GET /v1/silhouette/{file}", s.handleSilhouette)
	mux.HandleFunc("/v1/", func(w http.ResponseWriter, r *http.Request) {
		s.fail(w, r, http.StatusNotFound, "no such endpoint: "+r.URL.Path)
	})

	mux.HandleFunc("/", s.handleStatic)

	return cors(mux)
}

// cors allows local dev origins. The dataset is public and read-only, so the
// only thing at stake is the frontend's ability to talk to a local instance.
func cors(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if o := r.Header.Get("Origin"); isLocalOrigin(o) {
			w.Header().Set("Access-Control-Allow-Origin", o)
			w.Header().Set("Vary", "Origin")
			w.Header().Set("Access-Control-Allow-Methods", "GET, HEAD, OPTIONS")
			w.Header().Set("Access-Control-Allow-Headers", "Content-Type, If-None-Match")
			w.Header().Set("Access-Control-Expose-Headers", "ETag")
			w.Header().Set("Access-Control-Max-Age", "86400")
		}
		if r.Method == http.MethodOptions {
			w.WriteHeader(http.StatusNoContent)
			return
		}
		next.ServeHTTP(w, r)
	})
}

func isLocalOrigin(o string) bool {
	if o == "" {
		return false
	}
	for _, p := range []string{"http://localhost:", "http://127.0.0.1:", "http://[::1]:"} {
		if strings.HasPrefix(o, p) {
			return true
		}
	}
	return o == "http://localhost" || o == "http://127.0.0.1"
}

// --- response helpers ----------------------------------------------------

func (s *Server) etag() string { return `"` + s.St.BuildID + `"` }

// writeJSON emits an immutable, ETag'd JSON response and honours
// If-None-Match. Immutability is keyed on the build id, which changes whenever
// any artifact on disk does.
func (s *Server) writeJSON(w http.ResponseWriter, r *http.Request, code int, v any) {
	h := w.Header()
	h.Set("Content-Type", "application/json; charset=utf-8")
	if code == http.StatusOK {
		tag := s.etag()
		h.Set("ETag", tag)
		if s.Immutable {
			h.Set("Cache-Control", "public, max-age=31536000, immutable")
		} else {
			h.Set("Cache-Control", "no-cache")
		}
		if match := r.Header.Get("If-None-Match"); match != "" && etagMatches(match, tag) {
			w.WriteHeader(http.StatusNotModified)
			return
		}
	} else {
		h.Set("Cache-Control", "no-store")
	}
	w.WriteHeader(code)
	enc := json.NewEncoder(w)
	if err := enc.Encode(v); err != nil {
		s.Log.Error("encoding response", "path", r.URL.Path, "err", err)
	}
}

func etagMatches(header, tag string) bool {
	for _, part := range strings.Split(header, ",") {
		part = strings.TrimSpace(part)
		part = strings.TrimPrefix(part, "W/")
		if part == tag || part == "*" {
			return true
		}
	}
	return false
}

type apiError struct {
	Error  string `json:"error"`
	Status int    `json:"status"`
}

func (s *Server) fail(w http.ResponseWriter, r *http.Request, code int, msg string) {
	s.writeJSON(w, r, code, apiError{Error: msg, Status: code})
}

// --- shared payload shapes ------------------------------------------------

// Entry is one node as it appears in a path, a segment or a detail card.
type Entry struct {
	Idx                 int      `json:"idx"`
	Key                 string   `json:"key"`
	OttID               *int64   `json:"ott_id"`
	Name                *string  `json:"name"`
	Rank                *string  `json:"rank"`
	AgeMa               *float64 `json:"age_ma"`
	AgeLayout           *float64 `json:"age_layout"`
	Tier                *string  `json:"tier"`
	TipCount            int64    `json:"tip_count"`
	Depth               int64    `json:"depth"`
	PhylopicID          *string  `json:"phylopic_id"`
	SilhouetteSourceIdx *int     `json:"silhouette_source_idx"`
	// How far the silhouette was borrowed from, and by what rule. Climb 0 is
	// an exact match; climb 35 means the picture is of a clade 35 hops up and
	// the caption must say so.
	SilhouetteClimb  *int   `json:"silhouette_climb,omitempty"`
	SilhouetteMethod string `json:"silhouette_method,omitempty"`
}

// entries turns a list of indices into API entries, preserving order.
func (s *Server) entries(r *http.Request, idxs []int) ([]Entry, error) {
	ctx := r.Context()
	metas, err := s.St.Metas(ctx, idxs)
	if err != nil {
		return nil, err
	}
	images, err := s.St.Images(ctx, idxs)
	if err != nil {
		return nil, err
	}
	a := s.St.Arrays
	out := make([]Entry, 0, len(idxs))
	for _, idx := range idxs {
		m := metas[idx]
		e := Entry{
			Idx: idx, Key: m.NodeKey, OttID: m.OttID, Name: m.Name, Rank: m.Rank,
			TipCount: m.TipCount, Depth: m.Depth,
		}
		if e.Key == "" && a.Valid(idx) {
			// The node table should always have the row; if a partially-built
			// database does not, fall back to something addressable.
			e.Key = "idx:" + strconv.Itoa(idx)
			e.TipCount = int64(a.TipCount[idx])
			e.Depth = int64(a.Depth[idx])
		}
		if a.AgeMa != nil && a.Valid(idx) {
			v := float64(a.AgeMa[idx])
			// NaN means no number may be shown. Serialising it would be
			// invalid JSON anyway, but the point is the contract, not the
			// encoding: a structural-tier node never carries a figure.
			if !math.IsNaN(v) && !math.IsInf(v, 0) {
				e.AgeMa = &v
			}
		}
		if a.AgeLayout != nil && a.Valid(idx) {
			v := float64(a.AgeLayout[idx])
			if !math.IsNaN(v) && !math.IsInf(v, 0) {
				e.AgeLayout = &v
			}
		}
		if a.AgeTier != nil && a.Valid(idx) {
			t := topo.TierName(a.AgeTier[idx])
			e.Tier = &t
		}
		if img, ok := images[idx]; ok {
			id := img.PhylopicID
			e.PhylopicID = &id
			e.SilhouetteSourceIdx = img.SourceIdx
			e.SilhouetteClimb = img.Climb
			e.SilhouetteMethod = img.Method
		}
		out = append(out, e)
	}
	return out, nil
}

// --- /v1/about -----------------------------------------------------------

type aboutCounts struct {
	Nodes       int `json:"nodes"`
	Tips        int `json:"tips"`
	Internal    int `json:"internal"`
	Broken      int `json:"broken"`
	Vernaculars int `json:"vernaculars"`
	Silhouettes int `json:"silhouettes"`
}

type aboutAge struct {
	SourceTree     *string        `json:"source_tree"`
	Phase2Accepted *bool          `json:"phase2_accepted"`
	NodesWithAge   int            `json:"nodes_with_age"`
	Tiers          map[string]int `json:"tiers"`
	HasAgeArray    bool           `json:"has_age_array"`
	HasLayoutArray bool           `json:"has_layout_array"`
	HasTierArray   bool           `json:"has_tier_array"`
	Warning        *string        `json:"warning,omitempty"`
	// The phase-2 provenance file verbatim. It carries the tier semantics
	// (interpolated ages are UPPER BOUNDS), the internal-node-only breakdown,
	// and the count of demoted conflicting nodes — none of which the counts
	// above convey on their own.
	Provenance map[string]any `json:"provenance,omitempty"`
}

type aboutBody struct {
	BuildID     string                        `json:"build_id"`
	GeneratedAt string                        `json:"generated_at"`
	Counts      aboutCounts                   `json:"counts"`
	Phases      map[string]store.PhaseSummary `json:"phases"`
	Age         aboutAge                      `json:"age"`
	Sources     map[string]any                `json:"sources,omitempty"`
	Features    aboutFeatures                 `json:"features"`
}

type aboutFeatures struct {
	Schema         *store.Schema `json:"schema"`
	MissingArrays  []string      `json:"missing_arrays"`
	TimescaleReady bool          `json:"timescale"`
	SilhouetteDir  string        `json:"silhouette_dir"`
	FrontendDir    string        `json:"frontend_dir"`
	FossilsReady   bool          `json:"fossils"`
}

func (s *Server) handleAbout(w http.ResponseWriter, r *http.Request) {
	st := s.St
	a := st.Arrays

	age := aboutAge{
		NodesWithAge:   st.NodesWithAge,
		Tiers:          st.TierCounts,
		HasAgeArray:    a.AgeMa != nil,
		HasLayoutArray: a.AgeLayout != nil,
		HasTierArray:   a.AgeTier != nil,
	}
	if p := st.AgeProvenance; p != nil {
		age.Provenance = p
		if v, ok := p["source_tree"].(string); ok {
			age.SourceTree = &v
		}
		if v, ok := p["phase2_accepted"].(bool); ok {
			age.Phase2Accepted = &v
		}
		if v, ok := p["warning"].(string); ok {
			age.Warning = &v
		}
	}

	_, tsErr := os.Stat(st.TimescalePath)

	body := aboutBody{
		BuildID:     st.BuildID,
		GeneratedAt: st.GeneratedAt.Format("2006-01-02T15:04:05Z"),
		Counts: aboutCounts{
			Nodes: a.N, Tips: a.Tips, Internal: a.Internal,
			Broken: st.CountBroken, Vernaculars: st.CountVernaculars,
			Silhouettes: st.CountSilhouettes,
		},
		Phases:  st.Phases,
		Age:     age,
		Sources: st.SnapshotMeta,
		Features: aboutFeatures{
			Schema:         st.Schema,
			MissingArrays:  st.MissingArrays,
			TimescaleReady: tsErr == nil,
			SilhouetteDir:  st.SilhouetteDir,
			FrontendDir:    s.WebDist,
			FossilsReady:   false,
		},
	}
	if body.Features.MissingArrays == nil {
		body.Features.MissingArrays = []string{}
	}
	s.writeJSON(w, r, http.StatusOK, body)
}

// --- /v1/search ----------------------------------------------------------

type searchBody struct {
	Query   string               `json:"query"`
	Results []store.SearchResult `json:"results"`
}

func (s *Server) handleSearch(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query().Get("q")
	limit := 20
	if v := r.URL.Query().Get("limit"); v != "" {
		n, err := strconv.Atoi(v)
		if err != nil || n <= 0 {
			s.fail(w, r, http.StatusBadRequest, "limit must be a positive integer")
			return
		}
		limit = min(n, 50)
	}
	res, err := s.St.Search(r.Context(), q, limit)
	if err != nil {
		s.Log.Error("search", "q", q, "err", err)
		s.fail(w, r, http.StatusInternalServerError, "search failed")
		return
	}
	s.writeJSON(w, r, http.StatusOK, searchBody{Query: q, Results: res})
}

// --- /v1/path ------------------------------------------------------------

type pathBody struct {
	Key           string  `json:"key"`
	Idx           int     `json:"idx"`
	ForwardedFrom *int64  `json:"forwarded_from"`
	Path          []Entry `json:"path"`
}

// brokenBody is returned with HTTP 200 for a non-monophyletic taxon. This is
// deliberate: the live Open Tree API silently answers about the substituted
// MRCA instead, and management.md is explicit that we must explain rather than
// quietly answer a different question.
type brokenBody struct {
	Key               string          `json:"key"`
	Broken            bool            `json:"broken"`
	ForwardedFrom     *int64          `json:"forwarded_from"`
	OttID             int64           `json:"ott_id"`
	Name              string          `json:"name"`
	MRCANodeKey       string          `json:"mrca_node_key"`
	MRCAIdx           *int            `json:"mrca_idx"`
	NAttachmentPoints int             `json:"n_attachment_points"`
	AttachmentPoints  json.RawMessage `json:"attachment_points"`
	IntrudingTaxa     json.RawMessage `json:"intruding_taxa"`
}

func (s *Server) pathPayload(r *http.Request, key string) (any, int, error) {
	res, err := s.St.Resolve(r.Context(), key)
	if errors.Is(err, store.ErrUnknownKey) {
		return nil, http.StatusNotFound, err
	}
	if err != nil {
		return nil, http.StatusInternalServerError, err
	}
	if res.Broken != nil {
		b := res.Broken
		return brokenBody{
			Key: key, Broken: true, ForwardedFrom: res.ForwardedFrom,
			OttID: b.OttID, Name: b.Name, MRCANodeKey: b.MRCANodeKey,
			MRCAIdx: b.MRCAIdx, NAttachmentPoints: b.NAttachmentPoints,
			AttachmentPoints: b.AttachmentPoints, IntrudingTaxa: b.IntrudingTaxa,
		}, http.StatusOK, nil
	}
	idxs := s.St.Arrays.PathToRoot(res.Idx)
	entries, err := s.entries(r, idxs)
	if err != nil {
		return nil, http.StatusInternalServerError, err
	}
	return pathBody{Key: key, Idx: res.Idx, ForwardedFrom: res.ForwardedFrom, Path: entries},
		http.StatusOK, nil
}

func (s *Server) handlePath(w http.ResponseWriter, r *http.Request) {
	key := r.PathValue("key")
	body, code, err := s.pathPayload(r, key)
	if err != nil {
		if code == http.StatusNotFound {
			s.fail(w, r, code, "unknown key: "+key)
			return
		}
		s.Log.Error("path", "key", key, "err", err)
		s.fail(w, r, code, "path lookup failed")
		return
	}
	s.writeJSON(w, r, code, body)
}

const maxBatchKeys = 200

type pathsBody struct {
	Paths map[string]any `json:"paths"`
}

// pathsError is what a batch entry carries when one key of many is unknown.
// The single-key endpoint 404s; the batch cannot, because a shared URL that
// restores N selections should not lose all of them to one retired id.
type pathsError struct {
	Key   string `json:"key"`
	Error string `json:"error"`
}

func (s *Server) handlePaths(w http.ResponseWriter, r *http.Request) {
	raw := r.URL.Query().Get("keys")
	if strings.TrimSpace(raw) == "" {
		s.fail(w, r, http.StatusBadRequest, "keys is required, e.g. ?keys=ott770315,ott417950")
		return
	}
	var keys []string
	seen := map[string]bool{}
	for _, k := range strings.Split(raw, ",") {
		k = strings.TrimSpace(k)
		if k == "" || seen[k] {
			continue
		}
		seen[k] = true
		keys = append(keys, k)
	}
	if len(keys) > maxBatchKeys {
		s.fail(w, r, http.StatusBadRequest,
			"too many keys: "+strconv.Itoa(len(keys))+" > "+strconv.Itoa(maxBatchKeys))
		return
	}

	out := make(map[string]any, len(keys))
	for _, k := range keys {
		body, code, err := s.pathPayload(r, k)
		switch {
		case err == nil:
			out[k] = body
		case code == http.StatusNotFound:
			out[k] = pathsError{Key: k, Error: "not_found"}
		default:
			s.Log.Error("paths", "key", k, "err", err)
			out[k] = pathsError{Key: k, Error: "lookup_failed"}
		}
	}
	s.writeJSON(w, r, http.StatusOK, pathsBody{Paths: out})
}

// --- /v1/node ------------------------------------------------------------

type nodeBody struct {
	Entry
	Flags       *string            `json:"flags"`
	ChildCount  int64              `json:"child_count"`
	ParentIdx   *int               `json:"parent_idx"`
	Synonyms    []string           `json:"synonyms"`
	Vernaculars []store.Vernacular `json:"vernaculars"`
	Silhouette  *store.Attribution `json:"silhouette"`
}

func (s *Server) handleNode(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	key := r.PathValue("key")
	res, err := s.St.Resolve(ctx, key)
	if errors.Is(err, store.ErrUnknownKey) {
		s.fail(w, r, http.StatusNotFound, "unknown key: "+key)
		return
	}
	if err != nil {
		s.Log.Error("node", "key", key, "err", err)
		s.fail(w, r, http.StatusInternalServerError, "node lookup failed")
		return
	}
	if res.Broken != nil {
		b := res.Broken
		s.writeJSON(w, r, http.StatusOK, brokenBody{
			Key: key, Broken: true, ForwardedFrom: res.ForwardedFrom,
			OttID: b.OttID, Name: b.Name, MRCANodeKey: b.MRCANodeKey,
			MRCAIdx: b.MRCAIdx, NAttachmentPoints: b.NAttachmentPoints,
			AttachmentPoints: b.AttachmentPoints, IntrudingTaxa: b.IntrudingTaxa,
		})
		return
	}

	idx := res.Idx
	entries, err := s.entries(r, []int{idx})
	if err != nil || len(entries) == 0 {
		s.Log.Error("node entries", "key", key, "err", err)
		s.fail(w, r, http.StatusInternalServerError, "node lookup failed")
		return
	}
	metas, err := s.St.Metas(ctx, []int{idx})
	if err != nil {
		s.fail(w, r, http.StatusInternalServerError, "node lookup failed")
		return
	}
	meta := metas[idx]

	syn, err := s.St.Synonyms(ctx, meta)
	if err != nil {
		s.Log.Warn("synonyms", "idx", idx, "err", err)
		syn = []string{}
	}
	vern, err := s.St.Vernaculars(ctx, idx)
	if err != nil {
		s.Log.Warn("vernaculars", "idx", idx, "err", err)
		vern = []store.Vernacular{}
	}
	var attrib *store.Attribution
	if entries[0].PhylopicID != nil {
		attrib, err = s.St.SilhouetteAttribution(ctx, *entries[0].PhylopicID)
		if err != nil {
			s.Log.Warn("silhouette attribution", "idx", idx, "err", err)
		}
		if attrib != nil {
			attrib.SourceIdx = entries[0].SilhouetteSourceIdx
			attrib.Climb = entries[0].SilhouetteClimb
			attrib.Method = entries[0].SilhouetteMethod
			// Name the clade the picture is of, so the card can say so rather
			// than making the UI infer it from a path it may not have loaded.
			if src := attrib.SourceIdx; src != nil && s.St.Arrays.Valid(*src) {
				if sm, err := s.St.Metas(ctx, []int{*src}); err == nil {
					m := sm[*src]
					attrib.SourceName = m.Name
					attrib.SourceRank = m.Rank
					tc := m.TipCount
					attrib.SourceTipCount = &tc
				}
			}
		}
	}

	body := nodeBody{
		Entry: entries[0], Flags: meta.Flags,
		ChildCount: int64(s.St.Arrays.ChildCount[idx]),
		Synonyms:   syn, Vernaculars: vern, Silhouette: attrib,
	}
	if p := s.St.Arrays.Parent[idx]; p != topo.NoParent {
		v := int(p)
		body.ParentIdx = &v
	}
	s.writeJSON(w, r, http.StatusOK, body)
}

// --- /v1/segment ---------------------------------------------------------

type segmentBody struct {
	UpperIdx      int            `json:"upper_idx"`
	LowerIdx      int            `json:"lower_idx"`
	Intermediates []Entry        `json:"intermediates"`
	Fossils       []store.Fossil `json:"fossils"`
	// False when the fossil table has not been built. An empty array with no
	// flag reads as "no fossils here", which is a different claim.
	FossilsAvailable bool `json:"fossils_available"`
	// Total matches before the cap, so the UI can say "showing N of M".
	FossilsTotal int `json:"fossils_total"`
}

func (s *Server) handleSegment(w http.ResponseWriter, r *http.Request) {
	upper, err1 := strconv.Atoi(r.PathValue("upper"))
	lower, err2 := strconv.Atoi(r.PathValue("lower"))
	if err1 != nil || err2 != nil {
		s.fail(w, r, http.StatusBadRequest, "upper_idx and lower_idx must be integers")
		return
	}
	a := s.St.Arrays
	if !a.Valid(upper) || !a.Valid(lower) {
		s.fail(w, r, http.StatusNotFound, "idx out of range")
		return
	}
	if !a.IsAncestor(upper, lower) {
		s.fail(w, r, http.StatusBadRequest,
			"idx "+strconv.Itoa(upper)+" is not an ancestor of "+strconv.Itoa(lower))
		return
	}

	// The suppressed degree-2 nodes between the two endpoints, root-first.
	var chain []int
	for cur := int(a.Parent[lower]); cur != upper && a.Valid(cur); cur = int(a.Parent[cur]) {
		chain = append(chain, cur)
		if a.Parent[cur] == topo.NoParent {
			break
		}
	}
	for i, j := 0, len(chain)-1; i < j; i, j = i+1, j-1 {
		chain[i], chain[j] = chain[j], chain[i]
	}

	entries, err := s.entries(r, chain)
	if err != nil {
		s.Log.Error("segment", "err", err)
		s.fail(w, r, http.StatusInternalServerError, "segment lookup failed")
		return
	}
	if entries == nil {
		entries = []Entry{}
	}

	// Fossils attach to the suppressed nodes on the segment and to its lower
	// endpoint (architecture §3.4). The upper endpoint is excluded: it belongs
	// to the segment above.
	body := segmentBody{
		UpperIdx: upper, LowerIdx: lower, Intermediates: entries,
		Fossils: []store.Fossil{},
	}
	if s.St.Schema.Fossil != nil {
		attach := append(append([]int{}, chain...), lower)
		fossils, total, err := s.St.Fossils(r.Context(), attach, 0)
		if err != nil {
			s.Log.Error("segment fossils", "err", err)
		} else {
			body.Fossils, body.FossilsTotal, body.FossilsAvailable = fossils, total, true
		}
	}
	s.writeJSON(w, r, http.StatusOK, body)
}

// --- /v1/timescale -------------------------------------------------------

func (s *Server) handleTimescale(w http.ResponseWriter, r *http.Request) {
	raw, err := os.ReadFile(s.St.TimescalePath) //nolint:gosec // fixed build path
	if err != nil {
		s.fail(w, r, http.StatusNotFound,
			"timescale.json has not been built yet (ingest phase 5); expected at "+s.St.TimescalePath)
		return
	}
	h := w.Header()
	h.Set("Content-Type", "application/json; charset=utf-8")
	h.Set("ETag", s.etag())
	if s.Immutable {
		h.Set("Cache-Control", "public, max-age=31536000, immutable")
	} else {
		h.Set("Cache-Control", "no-cache")
	}
	if match := r.Header.Get("If-None-Match"); match != "" && etagMatches(match, s.etag()) {
		w.WriteHeader(http.StatusNotModified)
		return
	}
	_, _ = w.Write(raw)
}

// --- /v1/silhouette ------------------------------------------------------

func (s *Server) handleSilhouette(w http.ResponseWriter, r *http.Request) {
	file := r.PathValue("file")
	id, ok := strings.CutSuffix(file, ".svg")
	if !ok {
		s.fail(w, r, http.StatusNotFound, "silhouettes are served as {id}.svg")
		return
	}
	if !safeID(id) {
		s.fail(w, r, http.StatusBadRequest, "invalid silhouette id")
		return
	}
	if s.St.SilhouetteDir == "" {
		s.fail(w, r, http.StatusNotFound,
			"the PhyloPic mirror has not been built yet (ingest phase 5)")
		return
	}
	p := s.St.SVGPath(r.Context(), id)
	if p == "" {
		s.fail(w, r, http.StatusNotFound,
			"silhouette "+id+" is not in the mirror yet")
		return
	}
	raw, err := os.ReadFile(p) //nolint:gosec // path resolved and bounded by the store
	if err != nil {
		s.fail(w, r, http.StatusNotFound, "no silhouette "+id)
		return
	}
	h := w.Header()
	h.Set("Content-Type", "image/svg+xml")
	h.Set("ETag", s.etag())
	if s.Immutable {
		h.Set("Cache-Control", "public, max-age=31536000, immutable")
	} else {
		h.Set("Cache-Control", "no-cache")
	}
	_, _ = w.Write(raw)
}

// safeID rejects anything that is not a bare PhyloPic identifier, so no path
// component can escape the mirror directory.
func safeID(id string) bool {
	if id == "" || len(id) > 64 {
		return false
	}
	for _, c := range id {
		switch {
		case c >= 'a' && c <= 'z', c >= 'A' && c <= 'Z', c >= '0' && c <= '9', c == '-', c == '_':
		default:
			return false
		}
	}
	return true
}

// --- static ---------------------------------------------------------------

const noFrontend = `<!doctype html><meta charset="utf-8"><title>concestor</title>
<style>body{background:#0b0e12;color:#c9d4e0;font:14px/1.6 ui-monospace,monospace;
padding:3rem;max-width:44rem;margin:0 auto}a{color:#7fd4ff}code{color:#9be8c0}</style>
<h1>concestor</h1>
<p>The API is serving. No frontend build was found, so there is nothing to show here yet.</p>
<p>Try <a href="/v1/about"><code>/v1/about</code></a> — a running instance can state
exactly what it is made of.</p>
`

func (s *Server) handleStatic(w http.ResponseWriter, r *http.Request) {
	if s.WebDist == "" {
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		w.Header().Set("Cache-Control", "no-store")
		w.WriteHeader(http.StatusNotFound)
		_, _ = w.Write([]byte(noFrontend))
		return
	}
	clean := filepath.Clean("/" + strings.TrimPrefix(r.URL.Path, "/"))
	p := filepath.Join(s.WebDist, clean)
	if st, err := os.Stat(p); err == nil && !st.IsDir() {
		http.ServeFile(w, r, p)
		return
	}
	// SPA fallback: any unmatched non-/v1 path is a client route.
	index := filepath.Join(s.WebDist, "index.html")
	if _, err := os.Stat(index); err != nil {
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		w.WriteHeader(http.StatusNotFound)
		_, _ = w.Write([]byte(noFrontend))
		return
	}
	w.Header().Set("Cache-Control", "no-cache")
	http.ServeFile(w, r, index)
}
