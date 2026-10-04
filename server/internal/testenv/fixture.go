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
// CONCESTOR_REQUIRE_BUILD, failing — when it cannot be found. The fixture is
// the one beside the build: a build inside a checkout's tree is described by
// that checkout's fixture, which is what a worktree reading the main
// checkout's build/ needs, and a build in a worktree's state directory is
// described by the worktree's own.
func RequireInducedFixture(tb testing.TB) *InducedFixture {
	tb.Helper()
	build := RequireBuild(tb)
	rel := filepath.Join("web", "src", "tree", "__fixtures__", "induced.json")
	path := filepath.Join(filepath.Dir(build), rel)
	if _, err := os.Stat(path); err != nil {
		path = filepath.Join(checkout(), rel)
	}
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

// checkout walks up from the working directory to the directory holding
// `.git`, or returns "" outside a repository.
func checkout() string {
	wd, err := os.Getwd()
	if err != nil {
		return ""
	}
	for {
		if _, err := os.Stat(filepath.Join(wd, ".git")); err == nil {
			return wd
		}
		parent := filepath.Dir(wd)
		if parent == wd {
			return ""
		}
		wd = parent
	}
}
