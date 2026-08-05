// Package testenv locates the repository's build/ directory so tests can run
// against the real artifacts rather than fixtures. Tests skip when it is
// absent, so a clean checkout without a build still passes — set
// CONCESTOR_REQUIRE_BUILD to make that a failure instead. See RequireBuild.
package testenv

import (
	"os"
	"path/filepath"
	"testing"
)

// BuildDir walks up from the working directory looking for build/concestor.db.
// It returns "" when no built dataset is present.
func BuildDir(tb testing.TB) string {
	tb.Helper()
	wd, err := os.Getwd()
	if err != nil {
		return ""
	}
	for range 6 {
		p := filepath.Join(wd, "build")
		if st, err := os.Stat(filepath.Join(p, "concestor.db")); err == nil && !st.IsDir() {
			return p
		}
		parent := filepath.Dir(wd)
		if parent == wd {
			break
		}
		wd = parent
	}
	return ""
}

// RequireBuild skips the test when there is no built dataset — unless
// CONCESTOR_REQUIRE_BUILD is set, in which case it fails instead.
//
// The skip is the right default: a clean checkout has no build/, and CI never
// will, because producing one is hours of pipeline time against academic APIs
// that have no rate limiting. What the skip costs is that most of this suite
// vanishes and `go test` still prints `ok`, which reads as "the server is
// tested". docs/ci.md §2 counts the split and is the only place that does.
// That has already caught someone out in a git worktree, where
// testenv's six-parent walk stops one directory short of the borrowed build/.
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
		wd, err := os.Getwd()
		if err != nil {
			return ""
		}
		for range 6 {
			p := filepath.Join(wd, "build", "topology")
			if st, err := os.Stat(p); err == nil && st.IsDir() {
				return p
			}
			parent := filepath.Dir(wd)
			if parent == wd {
				break
			}
			wd = parent
		}
		return ""
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
			"rather than a skip; from a worktree, symlink build/ into the "+
			"checkout root)", msg)
	}
	tb.Skip(msg)
}
