// Package api serves the read-only HTTP contract described in architecture §4.
//
// Everything is immutable within a build, so every /v1 response carries an
// ETag derived from the build id and a one-year immutable Cache-Control. There
// is no write path, no session, and no runtime dependency on any upstream
// service: the Open Tree API is a build-time oracle only (architecture §9).
package api

import (
	"context"
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
	St      *store.Store
	Log     *slog.Logger
	WebDist string
	// Release is the version of this binary — the git tag the release
	// pipeline compiled in, or "dev" from a `go run`. Deliberately not the
	// same thing as the store's BuildID, which identifies the *dataset*: the
	// two move on different cadences, and /v1/about reports both so that a
	// support question can be answered without guessing which one changed.
	Release   string
	Commit    string
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
	mux.HandleFunc("GET /v1/random", s.handleRandom)
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
	s.encode(w, r, v)
}

// writeVolatileJSON emits a response that must **not** be cached or ETag'd.
//
// The package note says everything is immutable within a build, and everything
// is — except the one thing that is deliberately not a function of the build:
// a random pick. Sending it through writeJSON would stamp it with the build's
// ETag and a one-year `immutable`, so the second press of the command would be
// answered from the browser cache with the first press's answer, forever. The
// endpoint would appear to work and would never pick twice.
func (s *Server) writeVolatileJSON(w http.ResponseWriter, r *http.Request, code int, v any) {
	h := w.Header()
	h.Set("Content-Type", "application/json; charset=utf-8")
	h.Set("Cache-Control", "no-store")
	w.WriteHeader(code)
	s.encode(w, r, v)
}

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
	// scientific ones. Absent — not empty — wherever there is no such name.
	//
	// It carries two restrictions, both of them deliberate and both of them
	// applied here rather than left to a client. It is the name ranked *first*
	// by use and never a lower-ranked one (store.HeadlineVernaculars), and it is
	// populated only for **genus, species and subspecies**. The second is the
	// one worth defending: a common name higher up the tree names a group rather
	// than a kind of animal, so Metazoa reads "animals" and Ferae reads "bug" —
	// the demotions `docs/name-ranking.md` §3 records exist precisely because
	// those words' ordinary referents are something else. 97.1% of the ranked
	// names sit at these three ranks anyway, so the restriction costs the canvas
	// almost nothing and removes the whole class of label that would be wrong.
	//
	// A caller that wants every name a node has wants /v1/node's Vernaculars,
	// which is a list and is not restricted.
	Vernacular          *string  `json:"vernacular,omitempty"`
	AgeMa               *float64 `json:"age_ma"`
	AgeLayout           *float64 `json:"age_layout"`
	Tier                *string  `json:"tier"`
	TipCount            int64    `json:"tip_count"`
	Depth               int64    `json:"depth"`
	PhylopicID          *string  `json:"phylopic_id"`
	SilhouetteSourceIdx *int     `json:"silhouette_source_idx"`
	// The smallest clade containing both this node and the drawing, which is
	// what the picture actually stands for. Its tip count is the size of the
	// claim — 3,153 at the median — and it is the number the client applies its
	// suppression rule to, since a silhouette standing for a million tips
	// misinforms where a blank merely withholds. The name is null for
	// `mrcaott…` clades, which have none to give.
	SilhouetteCladeIdx  *int    `json:"silhouette_clade_idx,omitempty"`
	SilhouetteCladeTips *int64  `json:"silhouette_clade_tips,omitempty"`
	SilhouetteCladeName *string `json:"silhouette_clade_name,omitempty"`
	// How far the silhouette was borrowed, and by what rule. Climb is hops up
	// to the clade, not to the source, so climb 0 is not an exact match: an
	// unseeded genus holding a drawn species sits at 0. Mean is 4.24.
	SilhouetteClimb  *int   `json:"silhouette_climb,omitempty"`
	SilhouetteMethod string `json:"silhouette_method,omitempty"`

	// The fossil range, present only on the `occurrence` tier. It is not an
	// age: AgeMa stays null on these nodes, by construction in the pipeline
	// and checked there against the array rather than the code that wrote it.
	// A client must render it as a range and never as a point.
	Occurrence *store.Occurrence `json:"occurrence,omitempty"`

	// The divergence witness: a second silhouette for a fork, of a **fossil
	// taxon from below it** whose stratigraphic bracket puts it at the split.
	// Never on a node that carries its own image. Where the fork itself is
	// undated the match was made against where it is *drawn*, so a client must
	// not caption those as a date; Tier says which, since age_ma is null on
	// exactly those nodes.
	//
	// A client must not draw it *instead of* PhylopicID everywhere. The two
	// answer different questions and which one applies depends on how the
	// reader arrived at the node: a node they picked wants its clade's
	// exemplar, a node they arrived at by splitting wants the witness. Only
	// the client knows which.
	//
	// **The claim is weaker than it used to be and the wording must be too.** A
	// witness was once a node inside the clade, so the picture could say "a
	// member of this group". It is now a PBDB taxon attached below the fork,
	// and architecture §3.4 fixes the honest phrasing for that: *this taxon
	// belongs somewhere below node X, and existed between these dates.* Not
	// *this taxon is the sister of that one.* DivergenceAttachWalk is how loose
	// the placement is — how many PBDB `parent_no` hops it took to reach a node
	// in the synthesis tree. Zero means PBDB's own taxon is in the tree;
	// eleven is a statement about a family rather than a lineage.
	//
	// DivergenceRange is the taxon's own bracket and is what makes the picture
	// legible — "Sahelanthropus, 7.2–5.3 Ma" beside a split dated 6.7 Ma is a
	// statement a reader can check. Drawing the silhouette without it restates
	// the problem this replaced, an unexplained shape. It is a range and never
	// a point, exactly as Occurrence is.
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
	s.writeJSON(w, r, http.StatusOK, body)
}

// --- /v1/search ----------------------------------------------------------

type searchBody struct {
	Query   string               `json:"query"`
	Results []store.SearchResult `json:"results"`
	// PBDB taxa the tree does not contain, matching the same query.
	//
	// They stay in an array of their own because they are a different *shape* —
	// a stratigraphic bracket and an occurrence count where a node has an
	// ancestry and a subtree — not because they are a lesser answer. Both
	// arrays carry `order`, the row's position in the single ranking
	// `store.Interleave` computed over the two of them, and the client draws
	// one list in that order. It used to draw two, with these pinned below
	// however well they matched, which answered "triceratops" with every
	// species that nearly matches the word before the animal itself.
	Fossils []store.Fossil `json:"fossils"`
	// False when the fossil table has not been built, so an empty list can be
	// told apart from "nothing matched".
	FossilsAvailable bool `json:"fossils_available"`
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
	store.Interleave(body.Results, body.Fossils, q)
	s.writeJSON(w, r, http.StatusOK, body)
}

// --- /v1/random ----------------------------------------------------------

// randomBody is one draw from one of the two corpora.
//
// Two lists rather than one field of a union type, and for the same reason
// /v1/search has two: a node and a PBDB taxon are different things with
// different actions, and a client that had to unpack a tagged union would be
// doing that work in order to arrive back at the two lists it wanted. Only one
// is ever non-empty, and `kind` says which was asked for.
type randomBody struct {
	Kind    string               `json:"kind"`
	Results []store.SearchResult `json:"results"`
	Fossils []store.Fossil       `json:"fossils"`
	// False when the corpus this draw needs has not been built — no
	// `node_image.climb`, or no fossil/`fossil_image` tables. An empty list
	// with no flag reads as "the dice came up empty", which cannot happen.
	Available bool `json:"available"`
}

// handleRandom draws from a pool of taxa that carry their own drawing.
//
// `limit` exists so a caller can skip picks already on its canvas without a
// second round trip. Adding a species that is already there is a no-op, and the
// confirmation that follows it would be a false statement — the cheapest fix is
// to hand the client a few candidates and let it take the first unused one.
func (s *Server) handleRandom(w http.ResponseWriter, r *http.Request) {
	kind := r.URL.Query().Get("kind")
	if kind == "" {
		kind = "species"
	}
	if kind != "species" && kind != "fossil" {
		s.fail(w, r, http.StatusBadRequest, `kind must be "species" or "fossil"`)
		return
	}
	limit := 1
	if v := r.URL.Query().Get("limit"); v != "" {
		n, err := strconv.Atoi(v)
		if err != nil || n <= 0 {
			s.fail(w, r, http.StatusBadRequest, "limit must be a positive integer")
			return
		}
		limit = n
	}

	body := randomBody{Kind: kind, Results: []store.SearchResult{}, Fossils: []store.Fossil{}}
	if kind == "fossil" {
		fos, err := s.St.RandomFossils(r.Context(), limit)
		if err != nil {
			s.Log.Error("random fossil", "err", err)
			s.fail(w, r, http.StatusInternalServerError, "random pick failed")
			return
		}
		body.Fossils = fos
		body.Available = s.St.Schema.Fossil != nil && s.St.Schema.Fossil.ImageTable != ""
	} else {
		res, err := s.St.RandomNodes(r.Context(), limit)
		if err != nil {
			s.Log.Error("random species", "err", err)
			s.fail(w, r, http.StatusInternalServerError, "random pick failed")
			return
		}
		body.Results = res
		body.Available = s.St.Schema.NodeImage != nil && s.St.Schema.NodeImage.Climb != ""
	}
	s.writeVolatileJSON(w, r, http.StatusOK, body)
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
// **Below is null far more often than it is set, and a client must say
// something different in that case rather than omitting a clause.** Every age
// in the artifact set comes from a chronogram of extant species, so a dated
// descendant is usually a tip at the present; measured over the 186,317
// structural nodes, only 5,168 (2.8%) have one older than zero. For the other
// 97.2% the lower end of the span *is* the present, which is a fact about the
// axis rather than a missing value — see topo.LayoutSpread.
//
// Above is never null on the shipped build (measured: zero of 186,317 lack a
// dated ancestor) but is typed as absent-able because a partially dated build
// could produce one, and a client printing a name for idx -1 is the failure
// that would follow.
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
