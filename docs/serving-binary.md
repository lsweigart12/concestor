# The serving binary is Go

Architecture §4 left the runtime language open — "Go or Rust" — and said the
shape mattered more than the choice: one static binary over memory-mapped
topology arrays plus read-only SQLite, no database server, stateless replicas,
atomic releases. That shape is settled. This records which language implements
it, and why.

**Decision: Go.** Implemented in [`server/`](../server). Go 1.26, standard
library throughout, one third-party dependency
(`modernc.org/sqlite`).

---

## Why the choice is genuinely free

The pipeline is Python and stays Python. The serving binary shares **files**
with it and nothing else — `build/topology/*.npy`, `build/concestor.db`,
`build/timescale.json`, `build/*_gates.json`, the PhyloPic mirror. No runtime
is embedded, no FFI, no IPC, no shared object model. The two halves could be
written by people who never speak.

That is not incidental. It is what makes the artifact set reviewable, makes
`/v1/about` able to state exactly what the instance is made of, and makes the
language decision reversible: rewriting the server means reading the same
files again, not renegotiating an interface.

## The four reasons

**Mmap ergonomics.** The hot path is `path(node)` — a walk up a `u32` array,
mean length 41. `syscall.Mmap` is in the standard library, and one
`unsafe.Slice` turns the mapped region into a `[]uint32` that indexes with
bounds-checking and no copy. That is the entire `.npy` reader: 200 lines,
zero dependencies, reading the pipeline's output in place rather than
converting it to a second on-disk copy. Rust would do this at least as well —
`memmap2` plus `bytemuck` is comparably short and gets a lifetime-checked
slice instead of an `unsafe` block. This one is close to a tie; Go wins on
"no crate needed", Rust on "no `unsafe` needed".

**A static binary and a small container.** `CGO_ENABLED=0 go build` produces
a single file with no libc dependency, which drops into `scratch` or
`distroless` next to the artifacts. Rust matches this with
`x86_64-unknown-linux-musl`. The difference is that Go's default is already
the answer, and the artifacts dominate the image anyway — the binary is 15 MB
against ~700 MB of data.

**Mature read-only SQLite without cgo.** This is where the choice actually
tips. `modernc.org/sqlite` is SQLite transpiled to Go: no cgo, so the static
binary story survives contact with the database, and cross-compilation stays
a `GOOS`/`GOARCH` away. FTS5 is compiled in — verified by
`TestFTS5IsAvailableInTheDriver`, because architecture §4's search design
depends on it and a driver without FTS5 would have been a concrete reason to
reconsider. Rust's `rusqlite` is excellent but is a cgo-equivalent build of
the C library; the pure-Rust alternatives do not have FTS5 in the same shape.

**Nothing here needs what Rust is for.** There is no write path, no shared
mutable state, no lifetime puzzle, no allocator pressure worth fighting. The
data is immutable, memory-mapped, and read by independent request handlers.
The measured numbers say the same: a path lookup is 250 µs end to end over
HTTP, and almost all of that is JSON encoding and 41 SQLite primary-key
lookups, neither of which Rust would meaningfully change. Reaching for the
language whose advantage is fearless mutation, to serve data that never
mutates, would be optimizing the wrong axis — the same mistake as reaching
for WebGL because the *source* dataset is large when the *rendered* set is
nineteen nodes (architecture §7).

## What would have changed the answer

Written down so it can be re-checked rather than re-argued:

- **If FTS5 had been unavailable in a cgo-free driver.** It is available.
- **If per-request latency were dominated by our own code.** It is not:
  the profile is SQLite and `encoding/json`.
- **If the server needed to share a data structure with the pipeline** rather
  than a file. It does not, and the `package` phase that concatenates the
  arrays for the container image (architecture §3.2) does not change that.

## Consequences

- Standard library HTTP, routing (`net/http`'s pattern mux, Go 1.22+),
  logging (`log/slog`) and testing. One dependency to audit.
- `go vet` and `gofmt` are the lint gate, matching the pipeline's insistence
  that every change pass the same four checks.
- The correctness bar is the Python reference, not the Go code's own
  self-consistency: `TestInducedSubtreeMatchesReference` reproduces
  `render.py`'s `induced_subtree` for its `DEFAULT_SELECTION`, node for node,
  and asserts the `2|L| − 1` bound exactly. Any divergence between the port
  and the reference fails the build.
