// Package npy reads NumPy .npy arrays by memory-mapping them.
//
// The pipeline's output is the single source of truth, so the server reads the
// arrays in place rather than converting them to a second on-disk copy. The
// format is trivial: the magic "\x93NUMPY", a version pair, a little-endian
// header length (2 bytes at v1, 4 at v2+), an ASCII dict giving descr /
// fortran_order / shape padded to a 64-byte boundary, then raw little-endian
// data.
//
// Because the header is padded to 64 bytes and mmap returns a page-aligned
// address, the data region is always 64-byte aligned, which is what makes the
// unsafe reinterpretation to a typed slice legal.
package npy

import (
	"encoding/binary"
	"errors"
	"fmt"
	"os"
	"strconv"
	"strings"
	"unsafe"
)

var magic = [6]byte{0x93, 'N', 'U', 'M', 'P', 'Y'}

// hostLittleEndian is asserted rather than assumed: every dtype we accept is
// explicitly little-endian, and reinterpreting the mmap on a big-endian host
// would silently produce garbage.
var hostLittleEndian = func() bool {
	x := uint16(1)
	return *(*byte)(unsafe.Pointer(&x)) == 1
}()

var itemSize = map[string]int{
	"|u1": 1, "|i1": 1, "|b1": 1,
	"<u2": 2, "<i2": 2,
	"<u4": 4, "<i4": 4, "<f4": 4,
	"<u8": 8, "<i8": 8, "<f8": 8,
}

// Array is a memory-mapped one-dimensional .npy file.
type Array struct {
	Path  string
	Descr string
	Len   int

	mapped []byte // whole file
	off    int    // start of the data region
}

// Open memory-maps path. The caller must Close the result.
func Open(path string) (*Array, error) {
	f, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer f.Close() //nolint:errcheck // read-only

	st, err := f.Stat()
	if err != nil {
		return nil, err
	}
	size := st.Size()
	if size < 10 {
		return nil, fmt.Errorf("npy %s: file is %d bytes, too short for a header", path, size)
	}
	if size > int64(^uint(0)>>1) {
		return nil, fmt.Errorf("npy %s: file too large to map on this platform", path)
	}

	mapped, err := mapFile(int(f.Fd()), int(size))
	if err != nil {
		return nil, fmt.Errorf("npy %s: mmap: %w", path, err)
	}

	a, err := parse(path, mapped)
	if err != nil {
		_ = unmapFile(mapped)
		return nil, err
	}
	return a, nil
}

func parse(path string, mapped []byte) (*Array, error) {
	if [6]byte(mapped[0:6]) != magic {
		return nil, fmt.Errorf("npy %s: bad magic %q", path, mapped[0:6])
	}
	major := mapped[6]

	var hlen int
	var off int
	switch {
	case major == 1:
		hlen = int(binary.LittleEndian.Uint16(mapped[8:10]))
		off = 10 + hlen
	case major == 2 || major == 3:
		if len(mapped) < 12 {
			return nil, fmt.Errorf("npy %s: truncated v%d header", path, major)
		}
		hlen = int(binary.LittleEndian.Uint32(mapped[8:12]))
		off = 12 + hlen
	default:
		return nil, fmt.Errorf("npy %s: unsupported format version %d", path, major)
	}
	if off > len(mapped) {
		return nil, fmt.Errorf("npy %s: header length %d runs past end of file", path, hlen)
	}
	hdrStart := off - hlen
	header := string(mapped[hdrStart:off])

	descrRaw, ok := dictValue(header, "descr")
	if !ok {
		return nil, fmt.Errorf("npy %s: header has no 'descr'", path)
	}
	descr := strings.Trim(descrRaw, "'\"")

	fortran, ok := dictValue(header, "fortran_order")
	if !ok {
		return nil, fmt.Errorf("npy %s: header has no 'fortran_order'", path)
	}
	if fortran != "False" {
		return nil, fmt.Errorf("npy %s: fortran_order=%s, only C order is supported", path, fortran)
	}

	shapeRaw, ok := dictValue(header, "shape")
	if !ok {
		return nil, fmt.Errorf("npy %s: header has no 'shape'", path)
	}
	dims, err := parseShape(shapeRaw)
	if err != nil {
		return nil, fmt.Errorf("npy %s: %w", path, err)
	}
	if len(dims) != 1 {
		return nil, fmt.Errorf("npy %s: shape %s is %d-dimensional, want 1-D", path, shapeRaw, len(dims))
	}

	sz, ok := itemSize[descr]
	if !ok {
		return nil, fmt.Errorf("npy %s: unsupported dtype %q", path, descr)
	}
	if !hostLittleEndian && sz > 1 {
		return nil, errors.New("npy: host is big-endian; the arrays are little-endian")
	}

	n := dims[0]
	want := n * sz
	if got := len(mapped) - off; got < want {
		return nil, fmt.Errorf("npy %s: data region is %d bytes, header implies %d", path, got, want)
	}
	// numpy pads the header so the data begins on a 64-byte boundary; the
	// typed-slice reinterpretation below depends on it.
	if off%64 != 0 {
		return nil, fmt.Errorf("npy %s: data offset %d is not 64-byte aligned", path, off)
	}

	return &Array{Path: path, Descr: descr, Len: n, mapped: mapped, off: off}, nil
}

// Close unmaps the file. The typed slices handed out by U8/U32/I64/F32 are
// invalid afterwards.
func (a *Array) Close() error {
	if a.mapped == nil {
		return nil
	}
	m := a.mapped
	a.mapped = nil
	return unmapFile(m)
}

// Bytes returns the raw data region.
func (a *Array) Bytes() []byte { return a.mapped[a.off:] }

func (a *Array) check(want string) error {
	if a.Descr != want {
		return fmt.Errorf("npy %s: dtype is %q, want %q", a.Path, a.Descr, want)
	}
	return nil
}

func typed[T any](a *Array, want string) ([]T, error) {
	if err := a.check(want); err != nil {
		return nil, err
	}
	if a.Len == 0 {
		return nil, nil
	}
	b := a.mapped[a.off:]
	return unsafe.Slice((*T)(unsafe.Pointer(&b[0])), a.Len), nil
}

// U8 reinterprets the mapping as []uint8 ('|u1').
func (a *Array) U8() ([]uint8, error) { return typed[uint8](a, "|u1") }

// U32 reinterprets the mapping as []uint32 ('<u4').
func (a *Array) U32() ([]uint32, error) { return typed[uint32](a, "<u4") }

// I64 reinterprets the mapping as []int64 ('<i8').
func (a *Array) I64() ([]int64, error) { return typed[int64](a, "<i8") }

// F32 reinterprets the mapping as []float32 ('<f4').
func (a *Array) F32() ([]float32, error) { return typed[float32](a, "<f4") }

// dictValue pulls the value for key out of a Python-repr dict, respecting
// quotes and bracket nesting so that "shape': (12,)" survives.
func dictValue(h, key string) (string, bool) {
	i := strings.Index(h, "'"+key+"'")
	if i < 0 {
		return "", false
	}
	rest := h[i+len(key)+2:]
	c := strings.IndexByte(rest, ':')
	if c < 0 {
		return "", false
	}
	rest = rest[c+1:]

	depth := 0
	var quote byte
	for p := range len(rest) {
		ch := rest[p]
		switch {
		case quote != 0:
			if ch == quote {
				quote = 0
			}
		case ch == '\'' || ch == '"':
			quote = ch
		case ch == '(' || ch == '[' || ch == '{':
			depth++
		case ch == ')' || ch == ']':
			depth--
		case ch == '}' && depth == 0:
			return strings.TrimSpace(rest[:p]), true
		case ch == '}':
			depth--
		case ch == ',' && depth == 0:
			return strings.TrimSpace(rest[:p]), true
		}
	}
	return strings.TrimSpace(rest), true
}

func parseShape(s string) ([]int, error) {
	s = strings.TrimSpace(s)
	s = strings.TrimPrefix(s, "(")
	s = strings.TrimSuffix(s, ")")
	var out []int
	for _, part := range strings.Split(s, ",") {
		part = strings.TrimSpace(part)
		if part == "" {
			continue
		}
		n, err := strconv.Atoi(part)
		if err != nil {
			return nil, fmt.Errorf("bad shape %q", s)
		}
		if n < 0 {
			return nil, fmt.Errorf("negative dimension in shape %q", s)
		}
		out = append(out, n)
	}
	return out, nil
}
