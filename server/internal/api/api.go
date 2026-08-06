// Package api serves the read-only HTTP contract.
//
// Everything is immutable within a build, so every /v1 response carries an ETag
// derived from the build (dataset and binary, see etag) and a long
// Cache-Control — long rather than `immutable`, since a URL names no particular
// build and a browser told not to revalidate never learns it holds an old one.
// No write path, no session, no runtime dependency on any upstream service.
package api

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"math"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/lsweigart12/concestor/server/internal/store"
	"github.com/lsweigart12/concestor/server/internal/topo"
)

// Server wires the store to an http.Handler.
type Server struct {
	St      *store.Store
	Log     *slog.Logger
	WebDist string
	// Release is the version of this binary — the git tag the release
	// pipeline compiled in, or "dev" from a `go run`. Deliberately not the
	// same thing as the store's BuildID, which identifies the *dataset*: the
	// two move on different cadences, and /v1/about reports both so that a
	// support question can be answered without guessing which one changed.
	Release string
	Commit  string
	// PublicCache turns on the production cache lifetimes. It was called
	// Immutable, and was renamed with the header it names: nothing this server
	// sends says `immutable` any more, and a field claiming otherwise is the
	// same half-truth as an ETag that names half the build.
	PublicCache bool

	// The code half of the ETag, resolved once. See codeID: with no commit
	// compiled in it costs a stat of the executable, and that must not happen
	// per response.
	codeOnce sync.Once
	code     string
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
	mux.HandleFunc("GET /v1/random-pool/{build}", s.handlePool)
	mux.HandleFunc("GET /v1/hits", s.handleHits)
	mux.HandleFunc("GET /v1/path/{key}", s.handlePath)
	mux.HandleFunc("GET /v1/paths", s.handlePaths)
	mux.HandleFunc("GET /v1/node/{key}", s.handleNode)
	mux.HandleFunc("GET /v1/segment/{upper}/{lower}", s.handleSegment)
	mux.HandleFunc("GET /v1/fossil/{id}", s.handleFossil)
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

// etag names the response's content: the dataset AND the code that renders it.
// BuildID alone was a bug — it hashes only the artifacts, so a Go-only release
// emitted an identical ETag under `immutable` and warm caches served the old
// shape. BuildID is left alone (it is the dataset identity /v1/about publishes);
// the ETag is where the two ids are combined.
func (s *Server) etag() string { return `"` + s.St.BuildID + "-" + s.codeID() + `"` }

// codeID names the running binary the way St.BuildID names the dataset. A release
// build has the commit compiled in (-X main.commit); a `go run`/`go test` falls
// back to the binary's own path, size and mtime hashed, with a `dev-` prefix so
// it is not misread as a sha.
func (s *Server) codeID() string {
	s.codeOnce.Do(func() { s.code = resolveCodeID(s.Commit) })
	return s.code
}

func resolveCodeID(commit string) string {
	if c := etagSafe(commit); c != "" {
		return c
	}
	return "dev-" + binaryFingerprint()
}

// etagSafe keeps the header a single well-formed quoted-string. The commit
// arrives through a linker flag, so nothing has checked it on the way in, and
// a stray quote or comma would split the ETag rather than fail loudly.
func etagSafe(s string) string {
	var b strings.Builder
	for _, c := range s {
		if b.Len() >= 40 {
			break
		}
		switch {
		case c >= 'a' && c <= 'z', c >= 'A' && c <= 'Z', c >= '0' && c <= '9',
			c == '-', c == '.', c == '_':
			b.WriteRune(c)
		}
	}
	return b.String()
}

// binaryFingerprint identifies this executable by what the filesystem knows
// about it, which is enough: a rebuild is a new file.
func binaryFingerprint() string {
	if p, err := os.Executable(); err == nil {
		if id, ok := fingerprintFile(p); ok {
			return id
		}
	}
	// Nothing on disk to fingerprint — an executable deleted or unreadable
	// under us. Per-process rather than constant, deliberately: the cost of
	// this branch is a revalidation after a restart, and the cost of a shared
	// constant is the bug in etag's comment.
	h := sha256.New()
	fmt.Fprintf(h, "pid=%d\x00start=%d", os.Getpid(), time.Now().UnixNano())
	return hex.EncodeToString(h.Sum(nil))[:12]
}

func fingerprintFile(p string) (string, bool) {
	fi, err := os.Stat(p)
	if err != nil {
		return "", false
	}
	h := sha256.New()
	fmt.Fprintf(h, "%s\x00%d\x00%d", p, fi.Size(), fi.ModTime().UnixNano())
	return hex.EncodeToString(h.Sum(nil))[:12], true
}

// The three lifetimes a /v1 response can carry. `ccDev` is what
// -public-cache=false turns the other two into, so local iteration does not mean
// hard-reloading after every rebuild.
//
// `max-age` (browser) and `s-maxage` (edge) differ because the two caches are
// corrected differently: a deploy is a new Worker version and the edge is keyed
// by version, so it starts empty and can hold a year, but nothing corrects a
// browser holding a non-content-addressed URL. So an hour, not `immutable`,
// which would make the ETag a validator for a request never sent. The
// revalidation is answered by the edge out of its own fresh copy, not a
// container wake.
const (
	ccLongLived  = "public, max-age=3600, s-maxage=31536000"
	ccShortLived = "public, max-age=60, must-revalidate"
	ccDev        = "no-cache"
)

func (s *Server) longLivedCC() string {
	if s.PublicCache {
		return ccLongLived
	}
	return ccDev
}

func (s *Server) shortLivedCC() string {
	if s.PublicCache {
		return ccShortLived
	}
	return ccDev
}

// stampCacheable writes the ETag and lifetime and reports whether the request
// may be answered 304. One place, so the three callers cannot drift the ETag or
// drop the If-None-Match check.
func (s *Server) stampCacheable(w http.ResponseWriter, r *http.Request, cc string) (notModified bool) {
	tag := s.etag()
	h := w.Header()
	h.Set("ETag", tag)
	h.Set("Cache-Control", cc)
	match := r.Header.Get("If-None-Match")
	return match != "" && etagMatches(match, tag)
}

// writeJSON emits an immutable, ETag'd JSON response and honours
// If-None-Match. Immutability is keyed on the build id and the code id
// together, which between them change whenever anything the response is a
// function of does.
func (s *Server) writeJSON(w http.ResponseWriter, r *http.Request, code int, v any) {
	h := w.Header()
	h.Set("Content-Type", "application/json; charset=utf-8")
	if code == http.StatusOK {
		if s.stampCacheable(w, r, s.longLivedCC()) {
			w.WriteHeader(http.StatusNotModified)
			return
		}
	} else {
		h.Set("Cache-Control", "no-store")
	}
	w.WriteHeader(code)
	s.encode(w, r, v)
}

// writeShortLivedJSON emits a response that is cacheable but not immutable.
//
// It exists for /v1/about, which a deploy check or monitor asks "what is
// running": a year-long `immutable` would turn "the deploy did not land" into a
// permanent answer. Not `no-store` either (nothing on /v1 is), because that
// disables the edge's request collapsing and this is the boot path every reader
// hits. A minute of freshness keeps the collapsing and bounds staleness below
// any deploy.
//
// It is also the request that wakes a sleeping container: the frontend asks it
// first on boot, so a minute of edge freshness means the first reader back after
// idle reaches the container. Shortening this lifetime or making it immutable
// silently removes the warm-up.
func (s *Server) writeShortLivedJSON(w http.ResponseWriter, r *http.Request, v any) {
	h := w.Header()
	h.Set("Content-Type", "application/json; charset=utf-8")
	if s.stampCacheable(w, r, s.shortLivedCC()) {
		w.WriteHeader(http.StatusNotModified)
		return
	}
	w.WriteHeader(http.StatusOK)
	s.encode(w, r, v)
}

// There is no writeVolatileJSON: /v1/random (the one non-cacheable response) is
// gone, the draw now happening on the client from a build-keyed pool
// (handlePool), so every response this server sends is cacheable by one rule.

func (s *Server) encode(w http.ResponseWriter, r *http.Request, v any) {
	if err := json.NewEncoder(w).Encode(v); err != nil {
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
	Idx   int     `json:"idx"`
	Key   string  `json:"key"`
	OttID *int64  `json:"ott_id"`
	Name  *string `json:"name"`
	Rank  *string `json:"rank"`
	// The name this taxon goes by, for a canvas drawing common names instead of
	// scientific ones. Absent (not empty) where there is none. Two restrictions,
	// applied here: it is the rank-1 name only (store.HeadlineVernaculars), and
	// only for genus, species and subspecies — a common name higher up names a
	// group, not a kind of animal (Metazoa would read "animals"). A caller
	// wanting every name uses /v1/node's Vernaculars.
	Vernacular          *string  `json:"vernacular,omitempty"`
	AgeMa               *float64 `json:"age_ma"`
	AgeLayout           *float64 `json:"age_layout"`
	Tier                *string  `json:"tier"`
	TipCount            int64    `json:"tip_count"`
	Depth               int64    `json:"depth"`
	PhylopicID          *string  `json:"phylopic_id"`
	SilhouetteSourceIdx *int     `json:"silhouette_source_idx"`
	// The smallest clade containing both this node and the drawing — what the
	// picture stands for. Its tip count is the size of the claim, which the
	// client applies its suppression rule to. Name is null for `mrcaott…` clades.
	SilhouetteCladeIdx  *int    `json:"silhouette_clade_idx,omitempty"`
	SilhouetteCladeTips *int64  `json:"silhouette_clade_tips,omitempty"`
	SilhouetteCladeName *string `json:"silhouette_clade_name,omitempty"`
	// How far the silhouette was borrowed and by what rule. Climb is hops to the
	// clade, not the source, so climb 0 is not an exact match.
	SilhouetteClimb  *int   `json:"silhouette_climb,omitempty"`
	SilhouetteMethod string `json:"silhouette_method,omitempty"`

	// The fossil range, present only on the `occurrence` tier. Not an age (AgeMa
	// stays null on these nodes); a client must render it as a range, not a point.
	Occurrence *store.Occurrence `json:"occurrence,omitempty"`

	// The divergence witness: a second silhouette for a fork, of a fossil taxon
	// from below it whose bracket puts it at the split. Never on a node with its
	// own image. Where the fork is undated the match was against where it is
	// drawn, so a client must not caption those as a date (Tier says which).
	//
	// A client must not draw it instead of PhylopicID everywhere: which applies
	// depends on how the reader reached the node (a picked node wants its clade's
	// exemplar, a split wants the witness), and only the client knows which.
	//
	// DivergenceAttachWalk is how loose the placement is (PBDB `parent_no` hops to
	// a node in the tree; zero means PBDB's own taxon is in the tree).
	// DivergenceRange is the taxon's own bracket, which makes the picture legible
	// and is a range, never a point.
	DivergencePhylopicID *string  `json:"divergence_phylopic_id,omitempty"`
	DivergenceTaxonNo    *int     `json:"divergence_pbdb_taxon_no,omitempty"`
	DivergenceSourceName *string  `json:"divergence_source_name,omitempty"`
	DivergenceSourceRank *string  `json:"divergence_source_rank,omitempty"`
	DivergenceAttachIdx  *int     `json:"divergence_attach_idx,omitempty"`
	DivergenceAttachWalk *int     `json:"divergence_attach_walk,omitempty"`
	DivergenceGapMa      *float64 `json:"divergence_gap_ma,omitempty"`
	// Only fea and lla are populated: the witness is chosen by a containment
	// test on the outer bracket, so the inner pair is not what decided it and
	// would invite a reader to draw a certainty the choice never used.
	DivergenceRange *store.Occurrence `json:"divergence_range,omitempty"`
}

// The ranks a common name may be served for. See Entry.Vernacular.
//
// Spelled as OTT spells them. `subspecies` is in because OTT files *Homo
// sapiens neanderthalensis* there and a reader who selects a Neanderthal has
// selected a kind of animal, not a group; `varietas` is out, along with every
// rank above genus, because both directions from these three stop naming one.
var vernacularRanks = map[string]bool{
	"genus":      true,
	"species":    true,
	"subspecies": true,
}

// entries turns a list of indices into API entries, preserving order.
func (s *Server) entries(r *http.Request, idxs []int) ([]Entry, error) {
	ctx := r.Context()
	images, err := s.St.Images(ctx, idxs)
	if err != nil {
		return nil, err
	}
	witnesses, err := s.St.Witnesses(ctx, idxs)
	if err != nil {
		return nil, err
	}
	// Naming the clade a picture stands for needs a `node` row the caller did
	// not ask for. The clade indices along a path are few and repeat heavily —
	// neighbouring nodes share one — so they are folded into the metadata
	// lookup that was happening anyway rather than costing a query each. A
	// witness taxon is the same shape of extra row and rides along with them.
	want := append([]int(nil), idxs...)
	seen := make(map[int]bool, len(idxs))
	for _, idx := range idxs {
		seen[idx] = true
	}
	for _, img := range images {
		if c := img.CladeIdx; c != nil && !seen[*c] {
			seen[*c] = true
			want = append(want, *c)
		}
	}
	// A witness is a fossil and carries its own name and bracket, so it needs
	// no lookup at all. A build predating the rename still names a node, and
	// there the name and the range are two more rows to fetch.
	wantOcc := append([]int(nil), idxs...)
	for _, w := range witnesses {
		if w.SourceIdx == nil {
			continue
		}
		if !seen[*w.SourceIdx] {
			seen[*w.SourceIdx] = true
			want = append(want, *w.SourceIdx)
		}
		wantOcc = append(wantOcc, *w.SourceIdx)
	}
	occs, err := s.St.Occurrences(ctx, wantOcc)
	if err != nil {
		return nil, err
	}
	metas, err := s.St.Metas(ctx, want)
	if err != nil {
		return nil, err
	}
	// The rank filter runs off the metadata we already hold, so a path of 41
	// nodes asks about the two or three of them a common name may be drawn for
	// rather than all 41. See Entry.Vernacular for why those three ranks.
	var named []int
	for _, idx := range idxs {
		if r := metas[idx].Rank; r != nil && vernacularRanks[*r] {
			named = append(named, idx)
		}
	}
	commons, err := s.St.HeadlineVernaculars(ctx, named)
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
		if c, ok := commons[idx]; ok {
			v := c
			e.Vernacular = &v
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
		if o, ok := occs[idx]; ok {
			v := o
			e.Occurrence = &v
		}
		if img, ok := images[idx]; ok {
			id := img.PhylopicID
			e.PhylopicID = &id
			e.SilhouetteSourceIdx = img.SourceIdx
			e.SilhouetteCladeIdx = img.CladeIdx
			e.SilhouetteClimb = img.Climb
			e.SilhouetteMethod = img.Method
			if c := img.CladeIdx; c != nil {
				e.SilhouetteCladeName = metas[*c].Name
				if a.TipCount != nil && a.Valid(*c) {
					t := int64(a.TipCount[*c])
					e.SilhouetteCladeTips = &t
				}
			}
		}
		if w, ok := witnesses[idx]; ok {
			id := w.PhylopicID
			e.DivergencePhylopicID = &id
			e.DivergenceGapMa = w.GapMa
			if src := w.SourceIdx; src != nil {
				// A pre-rename build: the witness is a node, so its name and
				// its range come from the tables the node lives in.
				e.DivergenceSourceName = metas[*src].Name
				e.DivergenceSourceRank = metas[*src].Rank
				if o, ok := occs[*src]; ok {
					v := o
					e.DivergenceRange = &v
				}
			} else {
				taxonNo, attach, walk := w.PbdbTaxonNo, w.AttachIdx, w.AttachWalk
				name := w.Name
				e.DivergenceTaxonNo = &taxonNo
				e.DivergenceSourceName = &name
				e.DivergenceSourceRank = w.Rank
				e.DivergenceAttachIdx = &attach
				e.DivergenceAttachWalk = &walk
				e.DivergenceRange = &store.Occurrence{Fea: w.Oldest, Lla: w.Youngest}
			}
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
	// Release and BuildID answer two different questions — which code is
	// running, and which dataset it has open. Neither implies the other.
	Release     string                        `json:"release"`
	Commit      string                        `json:"commit,omitempty"`
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

	release := s.Release
	if release == "" {
		// An unset field must not read as a released build with an empty
		// version. "dev" is what a `go run` is.
		release = "dev"
	}

	body := aboutBody{
		Release:     release,
		Commit:      s.Commit,
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
			// Was hardcoded false while the fossil layer was live and
			// /v1/segment was answering. "What this is made of" is
			// user-facing, so a false negative there is a claim.
			FossilsReady: st.Schema.Fossil != nil,
		},
	}
	if body.Features.MissingArrays == nil {
		body.Features.MissingArrays = []string{}
	}
	// Short-lived rather than immutable: this is the endpoint whose answer is
	// checked to find out whether a deploy landed, and an answer nobody can
	// ask again is no answer. writeShortLivedJSON is the argument.
	s.writeShortLivedJSON(w, r, body)
}

// --- /v1/search ----------------------------------------------------------

type searchBody struct {
	Query   string               `json:"query"`
	Results []store.SearchResult `json:"results"`
	// PBDB taxa the tree does not contain, matching the same query. A separate
	// array because they are a different shape (a bracket and occurrence count vs
	// an ancestry and subtree), not a lesser answer: both arrays carry `order`
	// from store.Interleave and the client draws one list in that order.
	Fossils []store.Fossil `json:"fossils"`
	// False when the fossil table has not been built, so an empty list can be
	// told apart from "nothing matched".
	FossilsAvailable bool `json:"fossils_available"`
	// The spelling these results are for, when the typed query returned nothing
	// and a corrected one returned something. `Query` stays what the reader
	// typed; the client shows the substitution rather than performing it. Absent
	// when nothing was corrected.
	Corrected string `json:"corrected,omitempty"`
	// A spelling that answers better than the typed one, with the typed one's rows
	// left in place. Unlike Corrected (which replaces rows, honest only when there
	// were none to lose), this only suggests, so it does not take away the rows a
	// reader mid-word is typing towards. Never set together with Corrected.
	Suggested string `json:"suggested,omitempty"`
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
	body, ans, err := s.searchBoth(r, q, limit)
	if err != nil {
		s.Log.Error("search", "q", q, "err", err)
		s.fail(w, r, http.StatusInternalServerError, "search failed")
		return
	}
	// Only when the answer was no good, ask whether the query was misspelled.
	// The gate is Answer.Weak, not "no rows": a typo usually returns one row
	// (`elefant` reaches a ciliate through a synonym substring), and the empty
	// list is the bottom of that scale. Last thing tried, so a query that worked
	// pays nothing.
	if ans.Weak() {
		if fixed, err := s.St.Suggest(r.Context(), q); err != nil {
			s.Log.Warn("spelling", "q", q, "err", err)
		} else if fixed != "" {
			alt, altAns, err := s.searchBoth(r, fixed, limit)
			if err != nil {
				s.Log.Warn("spelling search", "q", fixed, "err", err)
			} else if altAns.Better(ans) {
				// Substituted only where there was nothing to substitute *for*,
				// and that test is on the *body* rather than on `ans.Rows`.
				// They differ by one case and it matters: a broken taxon is not
				// a row, so an answer made only of broken taxa has no rows and
				// is still something on the reader's screen — the note
				// explaining that *Dinosauria* is not monophyletic, which is an
				// answer to what they typed and must not be swapped out from
				// under them. See the two fields on searchBody.
				if len(body.Results) == 0 && len(body.Fossils) == 0 {
					alt.Query, alt.Corrected = q, fixed
					body = alt
				} else {
					body.Suggested = fixed
				}
			}
		}
	}
	s.writeJSON(w, r, http.StatusOK, body)
}

// searchBoth answers one string from both catalogues and puts them in one
// order, and reports how good that answer is.
func (s *Server) searchBoth(r *http.Request, q string, limit int) (searchBody, store.Answer, error) {
	res, err := s.St.Search(r.Context(), q, limit)
	if err != nil {
		return searchBody{}, store.Answer{}, err
	}
	body := searchBody{Query: q, Results: res, Fossils: []store.Fossil{}}
	// A failure here costs the fossil section and nothing else. The species
	// results are the answer to the question; the fossils are an extra, and
	//502-ing the whole palette because a supplementary scan failed would trade
	// a degraded list for no list.
	if s.St.Schema.Fossil != nil {
		fos, err := s.St.SearchFossils(r.Context(), q, limit)
		if err != nil {
			s.Log.Warn("fossil search", "q", q, "err", err)
		} else {
			body.Fossils, body.FossilsAvailable = fos, true
		}
	}
	// After both lists exist and before either is written, because `order` is a
	// statement about the pair. A fossil scan that failed leaves the nodes
	// stamped 0..n-1, which is the same order they were already in.
	return body, store.Interleave(body.Results, body.Fossils, q), nil
}

// --- /v1/hits ------------------------------------------------------------

// hitsBody is a set of search rows for taxa named by key rather than matched.
// `results` and not a bare array, matching /v1/search, so the shape can grow a
// field later.
type hitsBody struct {
	Results []store.SearchResult `json:"results"`
}

// handleHits dresses a caller's chosen taxa as palette rows.
//
// A general key lookup rather than a `/v1/starters` with the list baked in,
// because the list is editorial and belongs in `web/` beside its copy (see
// store.HitsForKeys). Cached long-lived: a pure function of the key set and
// build, so one edge entry serves every session's boot fetch on a half-vCPU
// container. The build id is not in the path (unlike /v1/random-pool) because
// the request is OTT keys, which survive a rebuild, and the response is consumed
// immediately. Unknown keys are skipped rather than 404ing (see HitsForKeys).
func (s *Server) handleHits(w http.ResponseWriter, r *http.Request) {
	keys, ok := s.batchKeys(w, r)
	if !ok {
		return
	}
	res, err := s.St.HitsForKeys(r.Context(), keys)
	if err != nil {
		s.Log.Error("hits", "keys", len(keys), "err", err)
		s.fail(w, r, http.StatusInternalServerError, "lookup failed")
		return
	}
	s.writeJSON(w, r, http.StatusOK, hitsBody{Results: res})
}

// --- /v1/random-pool -----------------------------------------------------

// poolBody is the two lists a client draws from, plus the build they describe.
// `build_id` repeats the path segment: the segment makes the URL unique per
// build; the body is what a client checks the lists against once it holds them.
type poolBody struct {
	BuildID string  `json:"build_id"`
	Nodes   []int32 `json:"nodes"`
	Fossils []int64 `json:"fossils"`
}

// handlePool serves the pools a random pick is drawn from (see store/random.go).
//
// This replaced `/v1/random`, the one uncacheable response. The draw moved to
// the client because the exclusion filter (which taxa are already on the canvas)
// is a fact no request carries, so with the pool in hand the client filters
// before choosing. The build id is in the path because the lists are bare `idx`
// values, meaningless across a build: a mismatched id is refused rather than
// answered, so the edge cannot store build B's list under build A's URL.
func (s *Server) handlePool(w http.ResponseWriter, r *http.Request) {
	want := r.PathValue("build")
	if want != s.St.BuildID {
		// `no-store` explicitly. A 404 is heuristically cacheable, and one
		// pinned at the edge would outlive the deploy that caused it.
		w.Header().Set("Cache-Control", "no-store")
		s.fail(w, r, http.StatusNotFound,
			"that build is no longer being served; re-read /v1/about for the current build_id")
		return
	}
	pool, err := s.St.RandomPool(r.Context())
	if err != nil {
		s.Log.Error("random pool", "err", err)
		s.fail(w, r, http.StatusInternalServerError, "building the random pool failed")
		return
	}
	s.writeJSON(w, r, http.StatusOK, poolBody{
		BuildID: s.St.BuildID,
		Nodes:   pool.Nodes,
		Fossils: pool.Fossils,
	})
}

// --- /v1/path ------------------------------------------------------------

type pathBody struct {
	Key           string  `json:"key"`
	Idx           int     `json:"idx"`
	ForwardedFrom *int64  `json:"forwarded_from"`
	Path          []Entry `json:"path"`
}

// brokenBody is returned with HTTP 200 for a non-monophyletic taxon, so the
// client can explain it rather than silently answer about the substituted MRCA
// the way the live Open Tree API does.
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

// batchKeys reads a `?keys=a,b,c` parameter, or writes the failure and returns
// false. Shared by /v1/paths and /v1/hits so the cap cannot drift apart between
// the two endpoints that take a key list — they are the only two, and a cap
// enforced on one of them is a cap on neither.
func (s *Server) batchKeys(w http.ResponseWriter, r *http.Request) ([]string, bool) {
	raw := r.URL.Query().Get("keys")
	if strings.TrimSpace(raw) == "" {
		s.fail(w, r, http.StatusBadRequest, "keys is required, e.g. ?keys=ott770315,ott417950")
		return nil, false
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
		return nil, false
	}
	return keys, true
}

func (s *Server) handlePaths(w http.ResponseWriter, r *http.Request) {
	keys, ok := s.batchKeys(w, r)
	if !ok {
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
	// The Wikidata item this node is, when the vernacular crawl found one —
	// 108,293 of 2.7M nodes, which are close to exactly the ones a reader has
	// heard of. It is here so the card can offer an article about *this taxon*
	// instead of a search for its name; see store.WikidataQID for how much the
	// identifier is warranted to mean.
	WikidataQID string `json:"wikidata_qid,omitempty"`
	// The witness's own credit. A separate block because it is a separate
	// drawing by a separate artist, and the canvas draws it: CC-BY applies to
	// whatever is on screen, so an image the card cannot credit is an image
	// the canvas may not show.
	DivergenceSilhouette *store.Attribution `json:"divergence_silhouette,omitempty"`
	// The two dated taxa an undated node's x was spread between, so the card
	// can name them instead of saying "its nearest dated ancestor and
	// descendant" — a phrase that describes a case 2.8% of these nodes are in.
	// Absent on any node carrying an age, which needs no explanation at all.
	LayoutSpread *layoutSpread `json:"layout_spread,omitempty"`
}

// layoutBound is one end of the span an undated node was placed within.
type layoutBound struct {
	Idx   int     `json:"idx"`
	Key   string  `json:"key"`
	Name  *string `json:"name"`
	Rank  *string `json:"rank"`
	AgeMa float64 `json:"age_ma"`
}

// layoutSpread names the dated taxa above and below an undated node.
//
// Below is usually null: every age comes from a chronogram of extant species, so
// a dated descendant is usually a tip at the present and the lower end of the
// span is the present, not a missing value (see topo.LayoutSpread). Above is
// never null on the shipped build but is typed absent-able so a partially dated
// build cannot make a client print a name for idx -1.
type layoutSpread struct {
	Above *layoutBound `json:"above"`
	Below *layoutBound `json:"below"`
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
	// A missing identifier costs the card one optional link, so it is warned
	// about and stepped over rather than failing the request.
	qid, err := s.St.WikidataQID(ctx, idx)
	if err != nil {
		s.Log.Warn("wikidata qid", "idx", idx, "err", err)
		qid = ""
	}
	var attrib *store.Attribution
	if entries[0].PhylopicID != nil {
		attrib, err = s.St.SilhouetteAttribution(ctx, *entries[0].PhylopicID)
		if err != nil {
			s.Log.Warn("silhouette attribution", "idx", idx, "err", err)
		}
		if attrib != nil {
			attrib.SourceIdx = entries[0].SilhouetteSourceIdx
			attrib.CladeIdx = entries[0].SilhouetteCladeIdx
			attrib.CladeName = entries[0].SilhouetteCladeName
			attrib.CladeTipCount = entries[0].SilhouetteCladeTips
			attrib.Climb = entries[0].SilhouetteClimb
			attrib.Method = entries[0].SilhouetteMethod
			// Name the node the picture is of, so the card can say so rather
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

	var witAttrib *store.Attribution
	if entries[0].DivergencePhylopicID != nil {
		witAttrib, err = s.St.SilhouetteAttribution(ctx, *entries[0].DivergencePhylopicID)
		if err != nil {
			s.Log.Warn("witness attribution", "idx", idx, "err", err)
		}
		if witAttrib != nil {
			// SourceIdx stays nil for a fossil witness. On this struct it means
			// "the node the picture is of", and a fossil is not a node — its
			// attachment point is where it *hangs*, which is a different claim,
			// and putting one in the other's field would address a node cleanly
			// and wrongly. The credit line needs the name, and the name travels
			// with the witness row.
			witAttrib.SourceName = entries[0].DivergenceSourceName
			witAttrib.SourceRank = entries[0].DivergenceSourceRank
			// No clade: the fork is the whole of what the picture speaks for,
			// and how far below it the taxon sits is DivergenceAttachWalk's
			// business rather than a clade's.
		}
	}

	body := nodeBody{
		Entry: entries[0], Flags: meta.Flags,
		ChildCount: int64(s.St.Arrays.ChildCount[idx]),
		Synonyms:   syn, Vernaculars: vern, Silhouette: attrib,
		WikidataQID:          qid,
		DivergenceSilhouette: witAttrib,
	}
	if p := s.St.Arrays.Parent[idx]; p != topo.NoParent {
		v := int(p)
		body.ParentIdx = &v
	}
	body.LayoutSpread = s.layoutSpread(ctx, idx)
	s.writeJSON(w, r, http.StatusOK, body)
}

// layoutSpread names the dated taxa an undated node's position was derived
// from, or returns nil where the question does not apply.
//
// One extra `node` lookup for at most two rows, and only on a node with no age
// — so it never runs on the 2.5M dated ones. A failure here costs the card one
// sentence, so it is warned about and stepped over: a missing name must not
// turn a working card into a 500.
func (s *Server) layoutSpread(ctx context.Context, idx int) *layoutSpread {
	sp, ok := s.St.Arrays.LayoutSpreadFor(idx)
	if !ok {
		return nil
	}
	want := make([]int, 0, 2)
	if sp.Above.Idx >= 0 {
		want = append(want, sp.Above.Idx)
	}
	if sp.Below.Idx >= 0 {
		want = append(want, sp.Below.Idx)
	}
	if len(want) == 0 {
		return nil
	}
	metas, err := s.St.Metas(ctx, want)
	if err != nil {
		s.Log.Warn("layout spread", "idx", idx, "err", err)
		return nil
	}
	bound := func(b topo.LayoutBound) *layoutBound {
		if b.Idx < 0 {
			return nil
		}
		m, ok := metas[b.Idx]
		if !ok {
			return nil
		}
		return &layoutBound{
			Idx: b.Idx, Key: m.NodeKey, Name: m.Name, Rank: m.Rank, AgeMa: b.AgeMa,
		}
	}
	out := &layoutSpread{Above: bound(sp.Above), Below: bound(sp.Below)}
	// Nothing nameable on either side is nothing to say. Returning the object
	// anyway would have the card open a paragraph it cannot finish.
	if out.Above == nil && out.Below == nil {
		return nil
	}
	return out
}

// --- /v1/fossil ----------------------------------------------------------

// handleFossil resolves one PBDB taxon by its own key.
//
// The segment listing is how a reader normally meets a fossil, and it is keyed
// on the branch. A *graft* is view state and therefore lives in the URL, so a
// cold load arrives holding an id and no segment to ask about. This is the only
// way back from an id to a taxon.
func (s *Server) handleFossil(w http.ResponseWriter, r *http.Request) {
	id, err := strconv.ParseInt(r.PathValue("id"), 10, 64)
	if err != nil {
		s.fail(w, r, http.StatusBadRequest, "fossil id must be an integer")
		return
	}
	if s.St.Schema.Fossil == nil {
		s.fail(w, r, http.StatusNotFound, "the fossil table has not been built (ingest phase 4)")
		return
	}
	fo, err := s.St.FossilByTaxonNo(r.Context(), id)
	if err != nil {
		s.Log.Error("fossil", "err", err)
		s.fail(w, r, http.StatusInternalServerError, "fossil lookup failed")
		return
	}
	if fo == nil {
		s.fail(w, r, http.StatusNotFound, "no PBDB taxon with that id")
		return
	}

	body := fossilBody{Fossil: *fo}

	// The drawing's credit. **Not optional**: a graft puts this image on the
	// canvas, CC-BY applies to whatever is on screen, and the card is the only
	// surface with room to say who drew it. The node card has carried this
	// since the silhouette layer shipped; a fossil drawing had no card at all
	// until now, which is the gap this closes rather than a new requirement.
	if fo.PhylopicID != nil && *fo.PhylopicID != "" {
		attrib, err := s.St.SilhouetteAttribution(r.Context(), *fo.PhylopicID)
		if err != nil {
			s.Log.Warn("fossil silhouette attribution", "id", id, "err", err)
		} else {
			body.Silhouette = attrib
		}
	}

	// The taxon it hangs below, named. The client has this node only when the
	// clade happens to be on the canvas already, and the card has to be able to
	// say "belongs somewhere below Homo" on a cold load too.
	if a := s.St.Arrays; a.Valid(fo.AttachIdx) {
		if entries, err := s.entries(r, []int{fo.AttachIdx}); err == nil && len(entries) == 1 {
			body.Attach = &entries[0]
		}
	}

	s.writeJSON(w, r, http.StatusOK, body)
}

// fossilBody is one PBDB taxon with the two things a card needs beyond the row
// itself: who drew the picture, and what the attachment point is called.
type fossilBody struct {
	store.Fossil
	Silhouette *store.Attribution `json:"silhouette,omitempty"`
	Attach     *Entry             `json:"attach,omitempty"`
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
	if s.stampCacheable(w, r, s.longLivedCC()) {
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
	if s.stampCacheable(w, r, s.longLivedCC()) {
		w.WriteHeader(http.StatusNotModified)
		return
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
