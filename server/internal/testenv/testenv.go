// Package testenv locates the repository's build/ directory so tests can run
// against the real artifacts rather than fixtures. Tests skip when it is
// absent, so a clean checkout without a build still passes — set
// CONCESTOR_REQUIRE_BUILD to make that a failure instead. See RequireBuild.
package testenv

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// BuildDir walks up from the working directory to the checkout and returns
// the build directory that has concestor.db in it. It returns "" when no
// built dataset is present.
func BuildDir(tb testing.TB) string {
	tb.Helper()
	return find("concestor.db", false)
}

// find returns the first build directory the surrounding checkout may read
// that holds rel, as a directory or as a file.
func find(rel string, dir bool) string {
	wd, err := os.Getwd()
	if err != nil {
		return ""
	}
	for range 6 {
		for _, build := range buildDirs(wd) {
			if st, err := os.Stat(filepath.Join(build, rel)); err == nil && st.IsDir() == dir {
				return build
			}
		}
		parent := filepath.Dir(wd)
		if parent == wd {
			break
		}
		wd = parent
	}
	return ""
}

// buildDirs lists where a checkout rooted at root keeps a build/ these tests
// may read. In the main checkout that is its own tree. A linked git worktree
// keeps one in its state directory, <git-dir>/concestor — scripts/lib/paths.sh
// says why, and makes the same decision — and until one is cloned there it
// reads the main checkout's. That is safe for a test, which only reads; the
// pipeline, which writes, never falls back.
func buildDirs(root string) []string {
	dirs := []string{filepath.Join(root, "build")}

	// A file in a linked worktree, a directory in the main checkout.
	raw, err := os.ReadFile(filepath.Join(root, ".git"))
	if err != nil {
		return dirs
	}
	gitDir, ok := strings.CutPrefix(strings.TrimSpace(string(raw)), "gitdir: ")
	if !ok {
		return dirs
	}
	gitDir = abs(root, gitDir)
	dirs = append(dirs, filepath.Join(gitDir, "concestor", "build"))

	if common, err := os.ReadFile(filepath.Join(gitDir, "commondir")); err == nil {
		main := filepath.Dir(abs(gitDir, strings.TrimSpace(string(common))))
		dirs = append(dirs, filepath.Join(main, "build"))
	}
	return dirs
}

// abs resolves p against base unless it is already absolute.
func abs(base, p string) string {
	if filepath.IsAbs(p) {
		return filepath.Clean(p)
	}
	return filepath.Join(base, p)
}

// RequireBuild skips the test when there is no built dataset — unless
// CONCESTOR_REQUIRE_BUILD is set, in which case it fails instead.
//
// The skip is the right default: a clean checkout has no build/, and CI never
// will, because producing one is hours of pipeline time against academic APIs
// that have no rate limiting. What the skip costs is that most of this suite
// vanishes and `go test` still prints `ok`, which reads as "the server is
// tested". docs/ci.md §2 counts the split and is the only place that does.
//
// So the escape hatch: scripts/check.sh sets the variable whenever it can
// resolve a build, and then a suite that skips is a suite that could not find
// what it was pointed at, reported as the failure it is.
func RequireBuild(tb testing.TB) string {
	tb.Helper()
	d := BuildDir(tb)
	if d == "" {
		absent(tb, "no build/concestor.db; run the pipeline first")
	}
	return d
}

// TopologyDir returns build/topology, or "" when phase 1 has not been run.
// Separate from BuildDir because the arrays and the database are separate
// artifacts: a checkout can have phase 1's output and no database.
func TopologyDir(tb testing.TB) string {
	tb.Helper()
	build := BuildDir(tb)
	if build == "" {
		// BuildDir keys off concestor.db, which phase 1 does not write, so
		// the arrays have to be looked for in their own right.
		if build = find("topology", true); build == "" {
			return ""
		}
	}
	p := filepath.Join(build, "topology")
	if st, err := os.Stat(p); err != nil || !st.IsDir() {
		return ""
	}
	return p
}

// RequireTopology skips — or, under CONCESTOR_REQUIRE_BUILD, fails — when
// phase 1's arrays are absent.
func RequireTopology(tb testing.TB) string {
	tb.Helper()
	d := TopologyDir(tb)
	if d == "" {
		absent(tb, "no build/topology; run `concestor-build topology` first")
	}
	return d
}

// absent is the one place the skip-or-fail decision is made, so a new
// artifact cannot be added with a skip that the flag does not cover.
func absent(tb testing.TB, msg string) {
	tb.Helper()
	if os.Getenv("CONCESTOR_REQUIRE_BUILD") != "" {
		tb.Fatalf("%s (CONCESTOR_REQUIRE_BUILD is set, so this is a failure "+
			"rather than a skip)", msg)
	}
	tb.Skip(msg)
}
