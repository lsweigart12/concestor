// Package store owns everything the API reads: the memory-mapped topology
// arrays, the read-only SQLite database, the build's gate reports, and the
// feature detection that lets the binary serve a half-built dataset.
package store

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"math"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/lsweigart12/concestor/server/internal/topo"

	_ "modernc.org/sqlite" // read-only SQLite, no cgo, keeps the static binary
)

// Options configure Open.
type Options struct {
	BuildDir       string
	SilhouetteDirs []string
	Log            *slog.Logger
}

// Store is the immutable dataset a running instance serves.
type Store struct {
	Arrays *topo.Arrays
	DB     *sql.DB
	Schema *Schema

	BuildDir      string
	BuildID       string
	GeneratedAt   time.Time
	SilhouetteDir string
	TimescalePath string

	MissingArrays []string
	Phases        map[string]PhaseSummary
	AgeProvenance map[string]any
	SnapshotMeta  map[string]any

	hot      []hotName
	hotFloor uint32

	CountBroken      int
	CountVernaculars int
	CountSilhouettes int

	// Age statistics, counted once at startup. /v1/about is served on every
	// page load; recounting 2.7M nodes per request cost 21 ms of pure waste.
	NodesWithAge int
	TierCounts   map[string]int

	// The 9,839 broken taxa are small enough to hold in memory and must be
	// searchable (management.md: explain them rather than silently answering a
	// different question the way the live API does).
	broken     []BrokenTaxon
	brokenByID map[int64]int
	log        *slog.Logger

	// A rank for the ~2,000 nodes the taxonomy leaves unranked and PBDB does
	// not, keyed by idx. Loaded once because the join is on a name and `fossil`
	// has no index on one. See rank.go.
	pbdbRank map[int]string
}

// BrokenTaxon is a non-monophyletic taxon rejected from synthesis. It is not a
// node and has no idx of its own.
type BrokenTaxon struct {
	OttID             int64           `json:"ott_id"`
	NodeKey           string          `json:"node_key"`
	Name              string          `json:"name"`
	MRCANodeKey       string          `json:"mrca_node_key"`
	MRCAIdx           *int            `json:"mrca_idx"`
	NAttachmentPoints int             `json:"n_attachment_points"`
	AttachmentPoints  json.RawMessage `json:"attachment_points"`
	IntrudingTaxa     json.RawMessage `json:"intruding_taxa"`

	fold string // case-folded name, for search
	// The abbreviated binomial, case-folded — "Escherichia coli" -> "e. coli".
	// A broken taxon is not a node, so `search.py` never generated one for it:
	// the abbreviation corpus is built from `node`, and these are exactly the
	// taxa rejected from synthesis. Without it "E. coli" answered *Entamoeba
	// coli* and never mentioned *Escherichia coli* at all, which is the taxon
	// almost everyone typing it means.
	foldAbbr string
}

// Open loads the dataset. It refuses to return a Store whose topology violates
// the preorder invariant.
func Open(ctx context.Context, opt Options) (*Store, error) {
	log := opt.Log
	if log == nil {
		log = slog.Default()
	}
	buildDir, err := filepath.Abs(opt.BuildDir)
	if err != nil {
		return nil, err
	}
	if st, err := os.Stat(buildDir); err != nil || !st.IsDir() {
		return nil, fmt.Errorf("build directory %s is not readable", buildDir)
	}

	arrays, missing, err := topo.Load(filepath.Join(buildDir, "topology"))
	if err != nil {
		return nil, err
	}

	dbPath := filepath.Join(buildDir, "concestor.db")
	if _, err := os.Stat(dbPath); err != nil {
		_ = arrays.Close()
		return nil, fmt.Errorf("concestor.db: %w", err)
	}
	dsn := "file:" + dbPath + "?mode=ro&immutable=1"
	db, err := sql.Open("sqlite", dsn)
	if err != nil {
		_ = arrays.Close()
		return nil, err
	}
	db.SetMaxOpenConns(16)
	db.SetMaxIdleConns(16)
	db.SetConnMaxLifetime(0)
	if err := db.PingContext(ctx); err != nil {
		_ = arrays.Close()
		_ = db.Close()
		return nil, fmt.Errorf("opening %s: %w", dsn, err)
	}

	schema, err := detectSchema(ctx, db)
	if err != nil {
		_ = arrays.Close()
		_ = db.Close()
		return nil, err
	}

	s := &Store{
		Arrays:        arrays,
		DB:            db,
		Schema:        schema,
		BuildDir:      buildDir,
		MissingArrays: missing,
		TimescalePath: filepath.Join(buildDir, "timescale.json"),
		log:           log,
	}

	for _, d := range opt.SilhouetteDirs {
		if d == "" {
			continue
		}
		if st, err := os.Stat(d); err == nil && st.IsDir() {
			s.SilhouetteDir = d
			break
		}
	}

	if err := s.loadBroken(ctx); err != nil {
		_ = s.Close()
		return nil, err
	}
	s.loadPhases()
	s.loadProvenance()
	s.loadSnapshotMeta()
	s.countOptional(ctx)
	s.countAges()
	s.loadPBDBRanks(ctx)
	s.loadHotNames(ctx)
	s.computeBuildID()
	return s, nil
}

func (s *Store) countAges() {
	s.TierCounts = map[string]int{"measured": 0, "interpolated": 0, "structural": 0}
	a := s.Arrays
	for _, v := range a.AgeMa {
		if !math.IsNaN(float64(v)) {
			s.NodesWithAge++
		}
	}
	for _, t := range a.AgeTier {
		s.TierCounts[topo.TierName(t)]++
	}
}

// Close releases the mmaps and the database handle.
func (s *Store) Close() error {
	var errs []error
	if s.Arrays != nil {
		errs = append(errs, s.Arrays.Close())
	}
	if s.DB != nil {
		errs = append(errs, s.DB.Close())
	}
	return errors.Join(errs...)
}

func (s *Store) loadBroken(ctx context.Context) error {
	if !s.Schema.has("broken_taxon") {
		s.log.Warn("no broken_taxon table; broken taxa will not be searchable or explained")
		s.brokenByID = map[int64]int{}
		return nil
	}
	rows, err := s.DB.QueryContext(ctx, `SELECT ott_id, node_key, name, mrca_node_key,
		mrca_idx, n_attachment_points, attachment_points, intruding_taxa FROM broken_taxon`)
	if err != nil {
		return fmt.Errorf("broken_taxon: %w", err)
	}
	defer rows.Close() //nolint:errcheck
	s.brokenByID = map[int64]int{}
	for rows.Next() {
		var b BrokenTaxon
		var name sql.NullString
		var mrcaIdx sql.NullInt64
		var ap, it string
		if err := rows.Scan(&b.OttID, &b.NodeKey, &name, &b.MRCANodeKey,
			&mrcaIdx, &b.NAttachmentPoints, &ap, &it); err != nil {
			return err
		}
		b.Name = name.String
		if mrcaIdx.Valid {
			v := int(mrcaIdx.Int64)
			b.MRCAIdx = &v
		}
		b.AttachmentPoints = rawJSON(ap)
		b.IntrudingTaxa = rawJSON(it)
		b.fold = strings.ToLower(b.Name)
		b.foldAbbr = strings.ToLower(abbreviateBinomial(b.Name))
		s.brokenByID[b.OttID] = len(s.broken)
		s.broken = append(s.broken, b)
	}
	if err := rows.Err(); err != nil {
		return err
	}
	s.CountBroken = len(s.broken)
	return nil
}

func rawJSON(s string) json.RawMessage {
	if !json.Valid([]byte(s)) {
		return json.RawMessage("null")
	}
	return json.RawMessage(s)
}

// PhaseSummary is a build phase's gate report, condensed. /v1/about is a
// feature, not diagnostics: a running instance must be able to state exactly
// what it is made of.
type PhaseSummary struct {
	File     string        `json:"file"`
	Phase    string        `json:"phase"`
	OK       bool          `json:"ok"`
	Gates    int           `json:"gates"`
	Passed   int           `json:"passed"`
	Blocking int           `json:"blocking"`
	Failures []GateFailure `json:"failures"`
}

// GateFailure is a gate that did not pass, blocking or not.
type GateFailure struct {
	Name     string `json:"name"`
	Expected any    `json:"expected"`
	Actual   any    `json:"actual"`
	Blocking bool   `json:"blocking"`
	Note     string `json:"note,omitempty"`
}

func (s *Store) loadPhases() {
	s.Phases = map[string]PhaseSummary{}
	paths, _ := filepath.Glob(filepath.Join(s.BuildDir, "phase*_gates*.json"))
	sort.Strings(paths)
	for _, p := range paths {
		raw, err := os.ReadFile(p) //nolint:gosec // path comes from our own glob
		if err != nil {
			continue
		}
		var f struct {
			Phase string `json:"phase"`
			OK    bool   `json:"ok"`
			Gates []struct {
				Name     string `json:"name"`
				Expected any    `json:"expected"`
				Actual   any    `json:"actual"`
				Passed   bool   `json:"passed"`
				Blocking bool   `json:"blocking"`
				Note     string `json:"note"`
			} `json:"gates"`
		}
		if err := json.Unmarshal(raw, &f); err != nil {
			s.log.Warn("unparseable gate report", "file", p, "err", err)
			continue
		}
		sum := PhaseSummary{
			File:     filepath.Base(p),
			Phase:    f.Phase,
			OK:       f.OK,
			Gates:    len(f.Gates),
			Failures: []GateFailure{},
		}
		for _, g := range f.Gates {
			if g.Passed {
				sum.Passed++
			} else {
				sum.Failures = append(sum.Failures, GateFailure{
					Name: g.Name, Expected: g.Expected, Actual: g.Actual,
					Blocking: g.Blocking, Note: g.Note,
				})
			}
			if g.Blocking {
				sum.Blocking++
			}
		}
		key := strings.TrimSuffix(filepath.Base(p), ".json")
		s.Phases[key] = sum
	}
}

func (s *Store) loadProvenance() {
	p := filepath.Join(s.BuildDir, "topology", "age_provenance.json")
	raw, err := os.ReadFile(p) //nolint:gosec // fixed path under the build dir
	if err != nil {
		return
	}
	var m map[string]any
	if err := json.Unmarshal(raw, &m); err != nil {
		s.log.Warn("unparseable age_provenance.json", "err", err)
		return
	}
	s.AgeProvenance = m
}

func (s *Store) loadSnapshotMeta() {
	p := filepath.Join(filepath.Dir(s.BuildDir), "snapshot", "manifest.json")
	raw, err := os.ReadFile(p) //nolint:gosec // derived from the build dir
	if err != nil {
		return
	}
	var m struct {
		Meta map[string]any `json:"meta"`
	}
	if err := json.Unmarshal(raw, &m); err != nil {
		return
	}
	s.SnapshotMeta = m.Meta
}

func (s *Store) countOptional(ctx context.Context) {
	if v := s.Schema.Vernacular; v != nil {
		_ = s.DB.QueryRowContext(ctx,
			fmt.Sprintf("SELECT count(*) FROM %q", v.Table)).Scan(&s.CountVernaculars)
	}
	if sl := s.Schema.Silhouette; sl != nil {
		_ = s.DB.QueryRowContext(ctx,
			fmt.Sprintf("SELECT count(*) FROM %q", sl.Table)).Scan(&s.CountSilhouettes)
	}
}

// computeBuildID hashes the identity of every artifact on disk. Everything is
// immutable within a build, so this is what the ETag and Cache-Control key on;
// a rebuild changes it and invalidates every cached response.
func (s *Store) computeBuildID() {
	h := sha256.New()
	var newest time.Time

	var files []string
	globs := []string{
		filepath.Join(s.BuildDir, "topology", "*.npy"),
		filepath.Join(s.BuildDir, "topology", "age_provenance.json"),
		filepath.Join(s.BuildDir, "concestor.db"),
		filepath.Join(s.BuildDir, "timescale.json"),
		filepath.Join(s.BuildDir, "phase*_gates*.json"),
	}
	for _, g := range globs {
		m, _ := filepath.Glob(g)
		files = append(files, m...)
	}
	sort.Strings(files)
	for _, p := range files {
		st, err := os.Stat(p)
		if err != nil {
			continue
		}
		fmt.Fprintf(h, "%s\x00%d\x00%d\n", filepath.Base(p), st.Size(), st.ModTime().UnixNano())
		if st.ModTime().After(newest) {
			newest = st.ModTime()
		}
	}
	if v, ok := s.SnapshotMeta["synth_id"].(string); ok {
		fmt.Fprintf(h, "synth_id=%s\n", v)
	}
	s.BuildID = hex.EncodeToString(h.Sum(nil))[:16]
	s.GeneratedAt = newest.UTC()
}

// --- node metadata -------------------------------------------------------

// NodeMeta is the `node` row for one index.
type NodeMeta struct {
	Idx      int
	OttID    *int64
	NodeKey  string
	Name     *string
	Rank     *string
	Flags    *string
	TipCount int64
	Depth    int64
}

const metaChunk = 400

// Metas fetches the `node` rows for idxs in one batched primary-key lookup.
func (s *Store) Metas(ctx context.Context, idxs []int) (map[int]NodeMeta, error) {
	out := make(map[int]NodeMeta, len(idxs))
	for start := 0; start < len(idxs); start += metaChunk {
		end := min(start+metaChunk, len(idxs))
		chunk := idxs[start:end]
		q := "SELECT idx, ott_id, node_key, name, rank, flags, tip_count, depth FROM node WHERE idx IN (" +
			placeholders(len(chunk)) + ")"
		args := make([]any, len(chunk))
		for i, v := range chunk {
			args[i] = v
		}
		rows, err := s.DB.QueryContext(ctx, q, args...)
		if err != nil {
			return nil, err
		}
		for rows.Next() {
			var m NodeMeta
			var ott sql.NullInt64
			var name, rank, flags sql.NullString
			if err := rows.Scan(&m.Idx, &ott, &m.NodeKey, &name, &rank, &flags, &m.TipCount, &m.Depth); err != nil {
				_ = rows.Close()
				return nil, err
			}
			if ott.Valid {
				v := ott.Int64
				m.OttID = &v
			}
			m.Name = nullStr(name)
			// The taxonomy's rank where it has one, PBDB's where it does not.
			// Here rather than at each caller because a rank that differs
			// between the canvas label and the card is the kind of thing this
			// audience notices, and `Metas` is what both of them read.
			m.Rank = s.rankFor(m.Idx, nullStr(rank))
			m.Flags = nullStr(flags)
			out[m.Idx] = m
		}
		if err := rows.Err(); err != nil {
			_ = rows.Close()
			return nil, err
		}
		_ = rows.Close()
	}
	return out, nil
}

func nullStr(v sql.NullString) *string {
	if !v.Valid {
		return nil
	}
	s := v.String
	return &s
}

func placeholders(n int) string {
	if n <= 0 {
		return ""
	}
	return strings.Repeat("?,", n-1) + "?"
}

// --- key resolution ------------------------------------------------------

// Resolved is the outcome of turning an API key into something on disk.
type Resolved struct {
	Idx           int
	ForwardedFrom *int64
	Broken        *BrokenTaxon
}

// ErrUnknownKey is returned when a key names neither a node nor a broken taxon.
var ErrUnknownKey = errors.New("unknown key")

// ParseKey accepts `ott770315`, `mrcaott83926ott3607676` and `idx:12345`.
func ParseKey(key string) (ott int64, isOtt bool, idx int, isIdx bool, ok bool) {
	key = strings.TrimSpace(key)
	if key == "" {
		return 0, false, 0, false, false
	}
	if rest, found := strings.CutPrefix(key, "idx:"); found {
		v, err := strconv.Atoi(rest)
		if err != nil || v < 0 {
			return 0, false, 0, false, false
		}
		return 0, false, v, true, true
	}
	if strings.HasPrefix(key, "mrca") {
		return 0, false, 0, false, true // resolved via node_key
	}
	if rest, found := strings.CutPrefix(key, "ott"); found {
		v, err := strconv.ParseInt(rest, 10, 64)
		if err != nil || v < 0 {
			return 0, false, 0, false, false
		}
		return v, true, 0, false, true
	}
	// A bare number is accepted as an OTT id; the URL form in architecture §7
	// (`/?n=770315,…`) carries them unprefixed.
	if v, err := strconv.ParseInt(key, 10, 64); err == nil && v >= 0 {
		return v, true, 0, false, true
	}
	return 0, false, 0, false, false
}

// Resolve turns a key into a node index, chasing retired OTT ids transitively
// and reporting the hop, or into the broken taxon that explains why there is
// no single answer.
func (s *Store) Resolve(ctx context.Context, key string) (*Resolved, error) {
	ott, isOtt, idx, isIdx, ok := ParseKey(key)
	if !ok {
		return nil, ErrUnknownKey
	}
	switch {
	case isIdx:
		if !s.Arrays.Valid(idx) {
			return nil, ErrUnknownKey
		}
		return &Resolved{Idx: idx}, nil
	case isOtt:
		if i, found := s.Arrays.IdxForOtt(ott); found {
			return &Resolved{Idx: i}, nil
		}
		if b, found := s.brokenByID[ott]; found {
			return &Resolved{Idx: -1, Broken: &s.broken[b]}, nil
		}
		// OTT id forwarding is silent — 297,070 entries — so never assume the
		// id you were handed is the id the tree knows.
		fwd, err := s.chaseForward(ctx, ott)
		if err != nil {
			return nil, err
		}
		if fwd != ott {
			from := ott
			if i, found := s.Arrays.IdxForOtt(fwd); found {
				return &Resolved{Idx: i, ForwardedFrom: &from}, nil
			}
			if b, found := s.brokenByID[fwd]; found {
				return &Resolved{Idx: -1, ForwardedFrom: &from, Broken: &s.broken[b]}, nil
			}
		}
		return nil, ErrUnknownKey
	default: // mrca…
		var i int
		err := s.DB.QueryRowContext(ctx, "SELECT idx FROM node WHERE node_key = ?", key).Scan(&i)
		if errors.Is(err, sql.ErrNoRows) {
			return nil, ErrUnknownKey
		}
		if err != nil {
			return nil, err
		}
		return &Resolved{Idx: i}, nil
	}
}

const maxForwardHops = 64

func (s *Store) chaseForward(ctx context.Context, ott int64) (int64, error) {
	if !s.Schema.has("forward") {
		return ott, nil
	}
	cur := ott
	seen := map[int64]bool{cur: true}
	for range maxForwardHops {
		var next int64
		err := s.DB.QueryRowContext(ctx,
			"SELECT new_ott_id FROM forward WHERE old_ott_id = ?", cur).Scan(&next)
		if errors.Is(err, sql.ErrNoRows) {
			return cur, nil
		}
		if err != nil {
			return cur, err
		}
		if seen[next] {
			return cur, nil // cycle; stop where we entered it
		}
		seen[next] = true
		cur = next
	}
	return cur, nil
}

// Broken returns the broken taxon for an OTT id, if any.
func (s *Store) Broken(ott int64) (*BrokenTaxon, bool) {
	if i, ok := s.brokenByID[ott]; ok {
		return &s.broken[i], true
	}
	return nil, false
}

// BrokenAll exposes the in-memory table for search.
func (s *Store) BrokenAll() []BrokenTaxon { return s.broken }

// TimescaleExists reports whether ingest has produced build/timescale.json.
func (s *Store) TimescaleExists() bool {
	st, err := os.Stat(s.TimescalePath)
	return err == nil && !st.IsDir()
}
