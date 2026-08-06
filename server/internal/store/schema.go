package store

import (
	"context"
	"database/sql"
	"fmt"
	"strings"
)

// The binary must start against a partially-built dataset, so every table and
// column is detected from sqlite_master / PRAGMA table_info at startup and the
// resolution is reported by /v1/about. Where a column name is not fixed, a short
// candidate list is tried; a table present but unresolvable is reported skipped
// with a reason rather than guessed at silently.

// Schema is the resolved shape of the database this instance opened.
type Schema struct {
	Tables map[string][]string `json:"tables"`

	FTS        *FTSSchema        `json:"node_fts,omitempty"`
	Vernacular *VernacularSchema `json:"vernacular,omitempty"`
	Silhouette *SilhouetteSchema `json:"silhouette,omitempty"`
	NodeImage  *NodeImageSchema  `json:"node_image,omitempty"`
	Witness    *WitnessSchema    `json:"node_divergence_image,omitempty"`
	Synonym    *SynonymSchema    `json:"synonym,omitempty"`
	Ranking    *RankingSchema    `json:"search_ranking,omitempty"`
	Fossil     *FossilSchema     `json:"fossil,omitempty"`
	Occurrence *OccurrenceSchema `json:"occurrence,omitempty"`
	Spelling   *SpellingSchema   `json:"spelling,omitempty"`

	// Skipped records tables that exist but could not be wired up, with why.
	Skipped map[string]string `json:"skipped,omitempty"`
}

// FTSSchema names the FTS5 index plus the table that maps its rowid back to a
// node. There is one FTS row per name (a node has many), so `search_name`
// carries the id -> idx mapping and a `kind`. Assuming rowid == node.idx would
// not error but joins to unrelated nodes, so FTS is wired up only when the
// mapping table is found; otherwise the prefix fallback is used.
type FTSSchema struct {
	Table    string `json:"table"`
	MapTable string `json:"map_table"`
	MapID    string `json:"map_id"`
	MapIdx   string `json:"map_idx"`
	MapName  string `json:"map_name"`
	MapKind  string `json:"map_kind,omitempty"`
}

// VernacularSchema maps common names onto nodes.
//
// Source and SourceID record which Wikidata item a node is (the only place the
// database does), which is what lets a card link to the right taxon's article.
// They ride here because the crawl that produced them was a vernacular crawl, so
// a node with no common name has no QID either.
type VernacularSchema struct {
	Table     string `json:"table"`
	Idx       string `json:"idx"`
	Name      string `json:"name"`
	Lang      string `json:"lang,omitempty"`
	Preferred string `json:"preferred,omitempty"`
	Source    string `json:"source,omitempty"`
	SourceID  string `json:"source_id,omitempty"`

	// Rank is the pipeline's 1-based ordering of a taxon's names, most used
	// first — `usage_rank`, written by the `names` phase from English
	// Wikipedia's title and redirect graph. Absent on a build predating that
	// phase, where the fallback is the boolean Preferred and the remainder
	// comes back in whatever order the table yields.
	//
	// It is *display* order and nothing here ranks search results by it:
	// which name a taxon goes by and which taxon a query means are different
	// questions, and band.go answers the second.
	Rank string `json:"rank,omitempty"`

	// WikiEvidence is what English Wikipedia does with a name — `title`,
	// `redirect`, `elsewhere`, `none`, or NULL (no English article). Search reads
	// only `title`: an article title is held by one taxon, so "the word you typed
	// titles this taxon's article" answers band.go's question of which taxon a
	// word denotes. See decorate.
	WikiEvidence string `json:"wiki_evidence,omitempty"`
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

// NodeImageSchema maps a node to the silhouette shown for it. SourceIdx is the
// node the image is actually of (the closest drawn relative). CladeIdx is the
// smallest clade containing both node and drawing, and its tip_count is the size
// of the claim the picture makes. Climb and Method say how far and by what rule,
// so the UI need not imply the picture depicts the selected species.
type NodeImageSchema struct {
	Table     string `json:"table"`
	Idx       string `json:"idx"`
	ID        string `json:"phylopic_id"`
	SourceIdx string `json:"source_idx,omitempty"`
	CladeIdx  string `json:"clade_idx,omitempty"`
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

// RankingSchema is a baked search-ranking table. Only a column named `score` is
// used (higher is better); `rank` is ambiguous (FTS5 ranks lower-is-better) and
// ignored rather than guessed at.
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
	s.resolveWitness()
	s.resolveOccurrence()
	s.resolveSynonym()
	s.resolveRanking()
	s.resolveFossil()
	s.resolveSpelling()
	// Last, and with the database in hand: this is the one resolution that
	// cannot be settled from column names alone. See verifyFossilFTS.
	s.verifyFossilFTS(ctx, db)
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
		Source:    s.col(t, "source"),
		SourceID:  s.col(t, "source_id", "external_id"),
		Rank:      s.col(t, "usage_rank", "name_rank", "rank"),

		WikiEvidence: s.col(t, "wiki_evidence"),
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
		CladeIdx:  s.col(t, "clade_idx", "silhouette_clade_idx", "shared_clade_idx"),
		Climb:     s.col(t, "climb", "hops", "distance"),
		Method:    s.col(t, "method", "match_method"),
	}
}

// WitnessSchema maps a divergence to a second silhouette: a fossil taxon from
// below the fork whose stratigraphic bracket puts it at that divergence. It is a
// separate table from node_image because node_image prefers the most inclusive
// drawing (a crown group at a split); this says what was there when the lineages
// parted.
//
// A witness is a fossil, not a node, and PbdbTaxonNo is the key that says so. It
// was renamed from a node index `source_idx` rather than redefined, to avoid the
// join-cleanly-to-`node` trap; the old `node_divergence_image` table is still
// recognised (SourceIdx set, fossil columns empty) so an older build keeps
// serving. AttachIdx/AttachWalk say how far below the fork the fossil sits;
// GapMa is the split-to-range distance, 0 meaning the range spans it.
type WitnessSchema struct {
	Table string `json:"table"`
	Idx   string `json:"idx"`
	ID    string `json:"phylopic_id"`
	GapMa string `json:"gap_ma,omitempty"`

	// The fossil form. Empty on a pre-rename build.
	PbdbTaxonNo string `json:"pbdb_taxon_no,omitempty"`
	TaxonName   string `json:"taxon_name,omitempty"`
	TaxonRank   string `json:"taxon_rank,omitempty"`
	AttachIdx   string `json:"attach_idx,omitempty"`
	AttachWalk  string `json:"attach_walk,omitempty"`
	Fea         string `json:"fea,omitempty"`
	Lla         string `json:"lla,omitempty"`

	// The node form, from `node_divergence_image`. Empty on a current build.
	SourceIdx string `json:"source_idx,omitempty"`
}

// Fossil reports whether this build's witness is a PBDB taxon rather than a
// node. Everything downstream branches on it once, here, rather than on the
// presence of individual columns.
func (w *WitnessSchema) Fossil() bool { return w.PbdbTaxonNo != "" }

func (s *Schema) resolveWitness() {
	t := s.firstTable("node_divergence_witness", "node_divergence_image", "node_witness_image")
	if t == "" {
		return
	}
	idx := s.col(t, "idx", "node_idx")
	id := s.col(t, "phylopic_id", "image_id", "uuid")
	if idx == "" || id == "" {
		s.Skipped[t] = "no idx/phylopic_id columns could be resolved"
		return
	}
	w := &WitnessSchema{
		Table:       t,
		Idx:         idx,
		ID:          id,
		GapMa:       s.col(t, "gap_ma", "gap"),
		PbdbTaxonNo: s.col(t, "pbdb_taxon_no"),
		TaxonName:   s.col(t, "taxon_name"),
		TaxonRank:   s.col(t, "taxon_rank"),
		AttachIdx:   s.col(t, "attach_idx"),
		AttachWalk:  s.col(t, "attach_walk"),
		Fea:         s.col(t, "fea"),
		Lla:         s.col(t, "lla"),
	}
	// The taxon and its dates are required: a witness with no name or no bracket
	// is a picture with no caption.
	if w.Fossil() {
		if w.TaxonName == "" || w.Fea == "" || w.Lla == "" || w.AttachIdx == "" {
			s.Skipped[t] = "a fossil witness carries no taxon name or no bracket"
			return
		}
	} else {
		w.SourceIdx = s.col(t, "source_idx", "witness_idx")
		if w.SourceIdx == "" {
			s.Skipped[t] = "no source_idx/pbdb_taxon_no column could be resolved"
			return
		}
	}
	s.Witness = w
}

// OccurrenceSchema names the fossil range shown for a node in the fourth age
// tier. The four bounds stay four columns: `fea`/`fla` and `lea`/`lla` are two
// separate uncertainty brackets and one range would be a different, wrong claim.
type OccurrenceSchema struct {
	Table string `json:"table"`
	Idx   string `json:"idx"`
	Fea   string `json:"fea,omitempty"`
	Fla   string `json:"fla,omitempty"`
	Lea   string `json:"lea,omitempty"`
	Lla   string `json:"lla,omitempty"`
}

func (s *Schema) resolveOccurrence() {
	t := s.firstTable("occurrence", "node_occurrence")
	if t == "" {
		return
	}
	idx := s.col(t, "idx", "node_idx")
	fea := s.col(t, "fea", "firstapp_max_ma")
	lla := s.col(t, "lla", "lastapp_min_ma")
	// Both ends of the *envelope* are required. A tier that promises a range
	// and can only produce one end of it says less than `structural` did while
	// looking like it says more.
	if idx == "" || fea == "" || lla == "" {
		s.Skipped[t] = "no idx/fea/lla columns could be resolved"
		return
	}
	s.Occurrence = &OccurrenceSchema{
		Table: t,
		Idx:   idx,
		Fea:   fea,
		Fla:   s.col(t, "fla", "firstapp_min_ma"),
		Lea:   s.col(t, "lea", "lastapp_max_ma"),
		Lla:   lla,
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
