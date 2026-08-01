package store

import (
	"context"
	"database/sql"
	"fmt"
	"strings"
)

// Other agents are concurrently adding vernacular, node_fts, silhouette,
// node_image and a search-ranking table to concestor.db. The binary must start
// and serve correctly against a partially-built dataset, so every table and
// column is detected from sqlite_master / PRAGMA table_info at startup and the
// resolution is reported verbatim by /v1/about.
//
// Where a column name cannot be known in advance, a short candidate list is
// tried and the winner recorded. Nothing is guessed silently: a table that is
// present but does not resolve is reported with the reason it was skipped.

// Schema is the resolved shape of the database this instance opened.
type Schema struct {
	Tables map[string][]string `json:"tables"`

	FTS        *FTSSchema        `json:"node_fts,omitempty"`
	Vernacular *VernacularSchema `json:"vernacular,omitempty"`
	Silhouette *SilhouetteSchema `json:"silhouette,omitempty"`
	NodeImage  *NodeImageSchema  `json:"node_image,omitempty"`
	Synonym    *SynonymSchema    `json:"synonym,omitempty"`
	Ranking    *RankingSchema    `json:"search_ranking,omitempty"`
	Fossil     *FossilSchema     `json:"fossil,omitempty"`

	// Skipped records tables that exist but could not be wired up, with why.
	Skipped map[string]string `json:"skipped,omitempty"`
}

// FTSSchema names the FTS5 index plus the table that maps its rowid back to a
// node.
//
// Architecture §3.3 sketched `node_fts` with `content=”` and an implied
// rowid == node.idx. The pipeline built something better: one FTS row per
// *name* — scientific, abbreviation, synonym, vernacular — because a node has
// many names, with `search_name` carrying the id -> idx mapping and a `kind`
// saying which sort of name matched.
//
// Assuming the rowid was node.idx against that schema does not error. It joins
// cleanly to entirely unrelated nodes and returns confident nonsense. So FTS is
// wired up only when the mapping table is found; otherwise it is skipped with
// a reason and the prefix fallback is used.
type FTSSchema struct {
	Table    string `json:"table"`
	MapTable string `json:"map_table"`
	MapID    string `json:"map_id"`
	MapIdx   string `json:"map_idx"`
	MapName  string `json:"map_name"`
	MapKind  string `json:"map_kind,omitempty"`
}

// VernacularSchema maps common names onto nodes. Priority-one work per
// handoff §1: a palette that returns nothing for "dog" is broken at the door.
type VernacularSchema struct {
	Table     string `json:"table"`
	Idx       string `json:"idx"`
	Name      string `json:"name"`
	Lang      string `json:"lang,omitempty"`
	Preferred string `json:"preferred,omitempty"`
}

// SilhouetteSchema carries PhyloPic attribution. Creator and uploader are
// separate fields deliberately: they differ 31% of the time and conflating
// them credits the wrong person.
type SilhouetteSchema struct {
	Table       string `json:"table"`
	ID          string `json:"phylopic_id"`
	Creator     string `json:"creator,omitempty"`
	Uploader    string `json:"uploader,omitempty"`
	License     string `json:"license_url,omitempty"`
	LicenseName string `json:"license_name,omitempty"`
	// SVGPath is the mirrored file, relative to the mirror root. It is NULL
	// until the SVG has actually been fetched, so its presence is also the
	// signal that an image can be served at all.
	SVGPath string `json:"svg_path,omitempty"`
}

// NodeImageSchema maps a node to the silhouette shown for it. SourceIdx names
// the node the image is actually *of*: PhyloPic resolves by clade fallback, so
// Homo sapiens can end up wearing Mammalia's silhouette 35 hops up. Climb and
// Method carry how far, which the UI needs in order not to imply the picture
// depicts the species the user selected.
type NodeImageSchema struct {
	Table     string `json:"table"`
	Idx       string `json:"idx"`
	ID        string `json:"phylopic_id"`
	SourceIdx string `json:"source_idx,omitempty"`
	Climb     string `json:"climb,omitempty"`
	Method    string `json:"method,omitempty"`
}

// SynonymSchema is keyed by either idx or ott_id, whichever the table carries.
type SynonymSchema struct {
	Table string `json:"table"`
	Key   string `json:"key"`
	ByOtt bool   `json:"by_ott_id"`
	Name  string `json:"name"`
}

// RankingSchema is a baked search-ranking table. Only a column literally named
// `score` is used, and higher is taken to be better; a column named `rank` is
// ambiguous (SQLite FTS5 ranks lower-is-better) so it is deliberately ignored
// rather than guessed at.
type RankingSchema struct {
	Table string `json:"table"`
	Idx   string `json:"idx"`
	Score string `json:"score"`
}

func detectSchema(ctx context.Context, db *sql.DB) (*Schema, error) {
	s := &Schema{Tables: map[string][]string{}, Skipped: map[string]string{}}

	rows, err := db.QueryContext(ctx,
		`SELECT name FROM sqlite_master WHERE type IN ('table','view') AND name NOT LIKE 'sqlite_%'`)
	if err != nil {
		return nil, fmt.Errorf("sqlite_master: %w", err)
	}
	var names []string
	for rows.Next() {
		var n string
		if err := rows.Scan(&n); err != nil {
			return nil, err
		}
		names = append(names, n)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	_ = rows.Close()

	for _, n := range names {
		cols, err := tableColumns(ctx, db, n)
		if err != nil {
			return nil, err
		}
		s.Tables[n] = cols
	}

	if _, ok := s.Tables["node"]; !ok {
		return nil, fmt.Errorf("concestor.db has no `node` table")
	}

	s.resolveFTS()
	s.resolveVernacular()
	s.resolveSilhouette()
	s.resolveNodeImage()
	s.resolveSynonym()
	s.resolveRanking()
	s.resolveFossil()
	return s, nil
}

func tableColumns(ctx context.Context, db *sql.DB, table string) ([]string, error) {
	// The table name comes from sqlite_master, never from user input, but
	// PRAGMA does not accept bound parameters so quote it defensively anyway.
	q := fmt.Sprintf("PRAGMA table_info(%q)", table)
	rows, err := db.QueryContext(ctx, q)
	if err != nil {
		// FTS5 shadow/virtual tables occasionally refuse table_info; that is
		// not fatal, we just know less about them.
		return nil, nil //nolint:nilerr // absence of columns is a valid answer
	}
	defer rows.Close() //nolint:errcheck
	var cols []string
	for rows.Next() {
		var cid int
		var name, typ string
		var notnull int
		var dflt any
		var pk int
		if err := rows.Scan(&cid, &name, &typ, &notnull, &dflt, &pk); err != nil {
			return nil, err
		}
		cols = append(cols, name)
	}
	return cols, rows.Err()
}

func (s *Schema) has(table string) bool { _, ok := s.Tables[table]; return ok }

func (s *Schema) col(table string, candidates ...string) string {
	cols, ok := s.Tables[table]
	if !ok {
		return ""
	}
	for _, want := range candidates {
		for _, c := range cols {
			if strings.EqualFold(c, want) {
				return c
			}
		}
	}
	return ""
}

func (s *Schema) firstTable(candidates ...string) string {
	for _, c := range candidates {
		if s.has(c) {
			return c
		}
	}
	return ""
}

func (s *Schema) resolveFTS() {
	t := s.firstTable("node_fts")
	if t == "" {
		return
	}
	m := s.firstTable("search_name", "fts_name", "node_fts_map")
	if m == "" {
		s.Skipped[t] = "no rowid->idx mapping table (search_name) found; the index " +
			"is one row per name, and joining node.idx = node_fts.rowid silently " +
			"returns unrelated nodes"
		return
	}
	id, idx := s.col(m, "id", "rowid"), s.col(m, "idx", "node_idx")
	name := s.col(m, "name", "text")
	if id == "" || idx == "" || name == "" {
		s.Skipped[m] = "no id/idx/name columns could be resolved"
		return
	}
	s.FTS = &FTSSchema{
		Table: t, MapTable: m, MapID: id, MapIdx: idx, MapName: name,
		MapKind: s.col(m, "kind", "name_kind", "type"),
	}
}

func (s *Schema) resolveVernacular() {
	t := s.firstTable("vernacular", "vernacular_name", "node_vernacular", "vernaculars")
	if t == "" {
		return
	}
	idx := s.col(t, "idx", "node_idx")
	name := s.col(t, "name", "vernacular", "vernacular_name", "common_name")
	if idx == "" || name == "" {
		s.Skipped[t] = "no idx/name column pair could be resolved"
		return
	}
	s.Vernacular = &VernacularSchema{
		Table:     t,
		Idx:       idx,
		Name:      name,
		Lang:      s.col(t, "lang", "language", "lang_code", "languagecode"),
		Preferred: s.col(t, "is_preferred", "preferred", "is_primary", "primary_name"),
	}
}

func (s *Schema) resolveSilhouette() {
	t := s.firstTable("silhouette", "silhouettes", "phylopic")
	if t == "" {
		return
	}
	id := s.col(t, "phylopic_id", "id", "uuid", "image_id")
	if id == "" {
		s.Skipped[t] = "no phylopic_id column could be resolved"
		return
	}
	s.Silhouette = &SilhouetteSchema{
		Table:       t,
		ID:          id,
		Creator:     s.col(t, "attribution", "creator", "artist"),
		Uploader:    s.col(t, "contributor", "uploader", "submitter"),
		License:     s.col(t, "license_url", "license"),
		LicenseName: s.col(t, "license_name", "license_abbr"),
		SVGPath:     s.col(t, "svg_path", "path", "file"),
	}
}

func (s *Schema) resolveNodeImage() {
	t := s.firstTable("node_image", "node_silhouette", "node_images")
	if t == "" {
		return
	}
	idx := s.col(t, "idx", "node_idx")
	id := s.col(t, "phylopic_id", "image_id", "uuid", "silhouette_id")
	if idx == "" || id == "" {
		s.Skipped[t] = "no idx/phylopic_id column pair could be resolved"
		return
	}
	s.NodeImage = &NodeImageSchema{
		Table:     t,
		Idx:       idx,
		ID:        id,
		SourceIdx: s.col(t, "silhouette_source_idx", "source_idx", "resolved_from_idx", "from_idx"),
		Climb:     s.col(t, "climb", "hops", "distance"),
		Method:    s.col(t, "method", "match_method"),
	}
}

func (s *Schema) resolveSynonym() {
	t := s.firstTable("synonym", "synonyms", "node_synonym")
	if t == "" {
		return
	}
	name := s.col(t, "name", "synonym", "synonym_name")
	if name == "" {
		s.Skipped[t] = "no name column could be resolved"
		return
	}
	if k := s.col(t, "idx", "node_idx"); k != "" {
		s.Synonym = &SynonymSchema{Table: t, Key: k, Name: name}
		return
	}
	if k := s.col(t, "ott_id", "uid"); k != "" {
		s.Synonym = &SynonymSchema{Table: t, Key: k, ByOtt: true, Name: name}
		return
	}
	s.Skipped[t] = "no idx or ott_id column could be resolved"
}

func (s *Schema) resolveRanking() {
	t := s.firstTable("search_rank", "node_rank", "search_ranking", "node_search_rank")
	if t == "" {
		return
	}
	idx := s.col(t, "idx", "node_idx")
	// A bare `rank` is deliberately not accepted: FTS5 ranks lower-is-better
	// and a plain `rank` column could mean either direction. `score` and
	// `rank_score` are unambiguous.
	score := s.col(t, "rank_score", "score", "search_score")
	if idx == "" || score == "" {
		s.Skipped[t] = "needs an idx column and an unambiguously higher-is-better " +
			"score column (`rank_score` or `score`); a bare `rank` is not guessed at"
		return
	}
	s.Ranking = &RankingSchema{Table: t, Idx: idx, Score: score}
}
