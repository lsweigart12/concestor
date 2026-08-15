package testenv

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

// InducedFixture is the reference induced subtree written by
// `concestor-build fixtures` to web/src/tree/__fixtures__/induced.json. The
// TypeScript port reads the same file, so all three implementations are
// pinned to one generated answer and none is transcribed by hand.
type InducedFixture struct {
	Selection []int `json:"selection"`
	Expected  struct {
		MRCA     int   `json:"mrca"`
		Rendered []int `json:"rendered"`
		Bound    int   `json:"bound"`
		Segments map[string]struct {
			// nil at the induced root, where TypeScript reads null.
			Anc        *int  `json:"anc"`
			Suppressed []int `json:"suppressed"`
		} `json:"segments"`
	} `json:"expected"`
}

// RequireInducedFixture parses the committed fixture, skipping — or, under
// CONCESTOR_REQUIRE_BUILD, failing — when it cannot be found. It is located
// from the build directory's parent, so a worktree that borrows build/ reads
// the fixture of the checkout it borrowed from, which is the tree the arrays
// actually describe.
func RequireInducedFixture(tb testing.TB) *InducedFixture {
	tb.Helper()
	build := RequireBuild(tb)
	path := filepath.Join(
		filepath.Dir(build), "web", "src", "tree", "__fixtures__", "induced.json",
	)
	raw, err := os.ReadFile(path)
	if err != nil {
		absent(tb, "no induced fixture; run `concestor-build fixtures` first")
		return nil
	}
	var f InducedFixture
	if err := json.Unmarshal(raw, &f); err != nil {
		tb.Fatalf("parsing %s: %v", path, err)
	}
	return &f
}
