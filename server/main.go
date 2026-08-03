// Command concestor-serve is the read-only API in front of the baked dataset.
//
// The whole runtime is one static binary over memory-mapped topology arrays
// and a read-only SQLite database, both produced by the offline pipeline. It
// shares only *files* with that pipeline — no runtime, no FFI — which is why
// the language choice was made independently. See docs/serving-binary.md.
package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"syscall"
	"time"

	"github.com/lsweigart12/concestor/server/internal/api"
	"github.com/lsweigart12/concestor/server/internal/store"
)

// Set by the linker at release time — see scripts/ci/build-release.sh, which
// passes -X main.version and -X main.commit from the tag semantic-release
// computed. They are variables rather than constants for exactly that reason.
//
// "dev" is the honest default. A `go run` has no version, and reporting an
// empty string on /v1/about would read as a release that forgot to say which.
var (
	version = "dev"
	commit  = ""
)

func main() {
	if err := run(); err != nil {
		fmt.Fprintln(os.Stderr, "concestor-serve:", err)
		os.Exit(1)
	}
}

func run() error {
	addr := flag.String("addr", ":8080", "listen address")
	buildDir := flag.String("build", "../build", "path to the build/ artifact directory")
	webDist := flag.String("web", "", "path to the built frontend (default <build>/../web/dist)")
	silhouettes := flag.String("silhouettes", "",
		"root of the PhyloPic mirror (default <repo>/snapshot/phylopic)")
	publicCache := flag.Bool("public-cache", true,
		"send the production Cache-Control lifetimes on /v1 responses; "+
			"set false when iterating locally")
	flag.Parse()

	log := slog.New(slog.NewTextHandler(os.Stderr, &slog.HandlerOptions{Level: slog.LevelInfo}))
	slog.SetDefault(log)

	absBuild, err := filepath.Abs(*buildDir)
	if err != nil {
		return err
	}
	repoRoot := filepath.Dir(absBuild)

	silhouetteDirs := []string{*silhouettes}
	if *silhouettes == "" {
		// The mirror root, not the svg/ subdirectory: silhouette.svg_path is
		// recorded relative to the root.
		silhouetteDirs = []string{
			filepath.Join(repoRoot, "snapshot", "phylopic"),
			filepath.Join(absBuild, "silhouettes"),
			filepath.Join(absBuild, "phylopic"),
		}
	}

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	t0 := time.Now()
	st, err := store.Open(ctx, store.Options{
		BuildDir:       absBuild,
		SilhouetteDirs: silhouetteDirs,
		Log:            log,
	})
	if err != nil {
		return err
	}
	defer st.Close() //nolint:errcheck

	dist := *webDist
	if dist == "" {
		dist = filepath.Join(repoRoot, "web", "dist")
	}
	if fi, err := os.Stat(dist); err != nil || !fi.IsDir() {
		dist = ""
	}

	log.Info("dataset loaded",
		"build_id", st.BuildID,
		"nodes", st.Arrays.N,
		"tips", st.Arrays.Tips,
		"broken", st.CountBroken,
		"missing_arrays", st.MissingArrays,
		"silhouettes", st.SilhouetteDir,
		"frontend", dist,
		"took", time.Since(t0).Round(time.Millisecond),
	)
	for t, why := range st.Schema.Skipped {
		log.Warn("table present but not wired up", "table", t, "reason", why)
	}

	srv := &api.Server{
		St: st, Log: log, WebDist: dist, PublicCache: *publicCache,
		Release: version, Commit: commit,
	}
	h := srv.Handler()

	hs := &http.Server{
		Addr:              *addr,
		Handler:           h,
		ReadHeaderTimeout: 10 * time.Second,
		ReadTimeout:       30 * time.Second,
		WriteTimeout:      60 * time.Second,
		IdleTimeout:       120 * time.Second,
	}

	errCh := make(chan error, 1)
	go func() {
		log.Info("listening", "addr", *addr)
		if err := hs.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			errCh <- err
		}
	}()

	select {
	case err := <-errCh:
		return err
	case <-ctx.Done():
		log.Info("shutting down")
		shutCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		return hs.Shutdown(shutCtx)
	}
}
