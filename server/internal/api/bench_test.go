package api

import (
	"io"
	"log/slog"
	"net/http/httptest"
	"testing"

	"github.com/lsweigart12/concestor/server/internal/store"
	"github.com/lsweigart12/concestor/server/internal/testenv"
)

// These benchmarks measure the full HTTP round trip against the real dataset,
// not just the handler: server, JSON encoding, SQLite and the mmap walk.
func benchServer(b *testing.B) *httptest.Server {
	b.Helper()
	build := testenv.BuildDir(b)
	if build == "" {
		b.Skip("no build/concestor.db")
	}
	st, err := store.Open(b.Context(), store.Options{BuildDir: build, Log: slog.New(slog.DiscardHandler)})
	if err != nil {
		b.Fatal(err)
	}
	b.Cleanup(func() { _ = st.Close() })
	srv := &Server{St: st, Log: slog.New(slog.DiscardHandler), Immutable: true}
	ts := httptest.NewServer(srv.Handler())
	b.Cleanup(ts.Close)
	return ts
}

func benchGet(b *testing.B, path string) {
	b.Helper()
	ts := benchServer(b)
	c := ts.Client()
	b.ReportAllocs()
	b.ResetTimer()
	for b.Loop() {
		resp, err := c.Get(ts.URL + path)
		if err != nil {
			b.Fatal(err)
		}
		if _, err := io.Copy(io.Discard, resp.Body); err != nil {
			b.Fatal(err)
		}
		_ = resp.Body.Close()
		if resp.StatusCode != 200 {
			b.Fatalf("%s = %d", path, resp.StatusCode)
		}
	}
}

func BenchmarkPath(b *testing.B)     { benchGet(b, "/v1/path/ott770315") }
func BenchmarkPathDeep(b *testing.B) { benchGet(b, "/v1/path/ott664349") }
func BenchmarkPathsBatch11(b *testing.B) {
	benchGet(b, "/v1/paths?keys=ott770315,ott417950,ott542509,ott153563,ott664349,"+
		"ott1005914,ott110468,ott505714,ott309263,ott810380,ott75257")
}
func BenchmarkSearchExact(b *testing.B)   { benchGet(b, "/v1/search?q=Homo+sapiens") }
func BenchmarkSearchPrefix(b *testing.B)  { benchGet(b, "/v1/search?q=Can") }
func BenchmarkSearchOneChar(b *testing.B) { benchGet(b, "/v1/search?q=a") }
func BenchmarkNode(b *testing.B)          { benchGet(b, "/v1/node/ott244265") }
func BenchmarkSegment(b *testing.B)       { benchGet(b, "/v1/segment/1/12950") }
func BenchmarkAbout(b *testing.B)         { benchGet(b, "/v1/about") }
