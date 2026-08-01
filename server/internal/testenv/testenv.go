// Package testenv locates the repository's build/ directory so tests can run
// against the real artifacts rather than fixtures. Tests skip when it is
// absent, so a clean checkout without a build still passes.
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

// RequireBuild skips the test when there is no built dataset.
func RequireBuild(tb testing.TB) string {
	tb.Helper()
	d := BuildDir(tb)
	if d == "" {
		tb.Skip("no build/concestor.db; run the pipeline first")
	}
	return d
}
