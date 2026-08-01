package npy

import (
	"bytes"
	"encoding/binary"
	"fmt"
	"math"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// write produces a .npy file the way numpy does: magic, version, header
// length, an ASCII dict padded with spaces to a 64-byte boundary and
// terminated with a newline, then raw little-endian data.
func write(t *testing.T, dir, name, descr string, n int, version byte, data []byte) string {
	t.Helper()
	hdr := fmt.Sprintf("{'descr': '%s', 'fortran_order': False, 'shape': (%d,), }", descr, n)

	pre := 8
	if version == 1 {
		pre += 2
	} else {
		pre += 4
	}
	total := pre + len(hdr) + 1
	pad := (64 - total%64) % 64
	hdr += strings.Repeat(" ", pad) + "\n"

	var buf bytes.Buffer
	buf.Write(magic[:])
	buf.WriteByte(version)
	buf.WriteByte(0)
	if version == 1 {
		_ = binary.Write(&buf, binary.LittleEndian, uint16(len(hdr)))
	} else {
		_ = binary.Write(&buf, binary.LittleEndian, uint32(len(hdr)))
	}
	buf.WriteString(hdr)
	if buf.Len()%64 != 0 {
		t.Fatalf("generated header is %d bytes, not 64-byte aligned", buf.Len())
	}
	buf.Write(data)

	p := filepath.Join(dir, name)
	if err := os.WriteFile(p, buf.Bytes(), 0o600); err != nil {
		t.Fatal(err)
	}
	return p
}

func TestRoundTripU32(t *testing.T) {
	dir := t.TempDir()
	want := []uint32{0, 1, 4294967295, 42, 7}
	var data bytes.Buffer
	for _, v := range want {
		_ = binary.Write(&data, binary.LittleEndian, v)
	}
	for _, ver := range []byte{1, 2} {
		p := write(t, dir, fmt.Sprintf("u32_v%d.npy", ver), "<u4", len(want), ver, data.Bytes())
		a, err := Open(p)
		if err != nil {
			t.Fatalf("v%d: %v", ver, err)
		}
		got, err := a.U32()
		if err != nil {
			t.Fatal(err)
		}
		if len(got) != len(want) {
			t.Fatalf("len = %d, want %d", len(got), len(want))
		}
		for i := range want {
			if got[i] != want[i] {
				t.Fatalf("v%d [%d] = %d, want %d", ver, i, got[i], want[i])
			}
		}
		if err := a.Close(); err != nil {
			t.Fatal(err)
		}
	}
}

func TestRoundTripOtherDtypes(t *testing.T) {
	dir := t.TempDir()

	u8 := []byte{0, 1, 255, 3}
	a, err := Open(write(t, dir, "u8.npy", "|u1", len(u8), 1, u8))
	if err != nil {
		t.Fatal(err)
	}
	got8, err := a.U8()
	if err != nil || !bytes.Equal(got8, u8) {
		t.Fatalf("u8 = %v (%v), want %v", got8, err, u8)
	}
	_ = a.Close()

	i64want := []int64{-1, 0, 770315, math.MaxInt64}
	var b bytes.Buffer
	for _, v := range i64want {
		_ = binary.Write(&b, binary.LittleEndian, v)
	}
	a, err = Open(write(t, dir, "i64.npy", "<i8", len(i64want), 1, b.Bytes()))
	if err != nil {
		t.Fatal(err)
	}
	gotI, err := a.I64()
	if err != nil {
		t.Fatal(err)
	}
	for i := range i64want {
		if gotI[i] != i64want[i] {
			t.Fatalf("i64[%d] = %d, want %d", i, gotI[i], i64want[i])
		}
	}
	_ = a.Close()

	// NaN is load-bearing: it is how the pipeline says "no number may be shown".
	f32want := []float32{float32(math.NaN()), 0, 4246.67, -1}
	b.Reset()
	for _, v := range f32want {
		_ = binary.Write(&b, binary.LittleEndian, v)
	}
	a, err = Open(write(t, dir, "f32.npy", "<f4", len(f32want), 1, b.Bytes()))
	if err != nil {
		t.Fatal(err)
	}
	gotF, err := a.F32()
	if err != nil {
		t.Fatal(err)
	}
	if !math.IsNaN(float64(gotF[0])) {
		t.Fatalf("f32[0] = %v, want NaN", gotF[0])
	}
	if gotF[2] != f32want[2] {
		t.Fatalf("f32[2] = %v, want %v", gotF[2], f32want[2])
	}
	_ = a.Close()
}

func TestEmptyArray(t *testing.T) {
	dir := t.TempDir()
	a, err := Open(write(t, dir, "empty.npy", "<u4", 0, 1, nil))
	if err != nil {
		t.Fatal(err)
	}
	defer a.Close() //nolint:errcheck
	got, err := a.U32()
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 0 {
		t.Fatalf("len = %d, want 0", len(got))
	}
}

func TestDtypeMismatchIsAnError(t *testing.T) {
	dir := t.TempDir()
	a, err := Open(write(t, dir, "x.npy", "<u4", 1, 1, []byte{1, 0, 0, 0}))
	if err != nil {
		t.Fatal(err)
	}
	defer a.Close() //nolint:errcheck
	if _, err := a.I64(); err == nil {
		t.Fatal("reading a <u4 array as I64 should fail")
	}
}

func TestRejectsMalformed(t *testing.T) {
	dir := t.TempDir()
	cases := []struct {
		name string
		body []byte
		want string
	}{
		{"badmagic", append([]byte("NOTNPY\x01\x00\x76\x00"), bytes.Repeat([]byte(" "), 118)...), "bad magic"},
		{"tiny", []byte("\x93NUM"), "too short"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			p := filepath.Join(dir, c.name+".npy")
			if err := os.WriteFile(p, c.body, 0o600); err != nil {
				t.Fatal(err)
			}
			_, err := Open(p)
			if err == nil {
				t.Fatal("expected an error")
			}
			if !strings.Contains(err.Error(), c.want) {
				t.Fatalf("error %q does not mention %q", err, c.want)
			}
		})
	}
}

func TestRejectsFortranOrderAnd2D(t *testing.T) {
	dir := t.TempDir()

	mk := func(name, hdrBody string) string {
		hdr := hdrBody
		total := 10 + len(hdr) + 1
		hdr += strings.Repeat(" ", (64-total%64)%64) + "\n"
		var buf bytes.Buffer
		buf.Write(magic[:])
		buf.WriteByte(1)
		buf.WriteByte(0)
		_ = binary.Write(&buf, binary.LittleEndian, uint16(len(hdr)))
		buf.WriteString(hdr)
		buf.Write(make([]byte, 64))
		p := filepath.Join(dir, name)
		if err := os.WriteFile(p, buf.Bytes(), 0o600); err != nil {
			t.Fatal(err)
		}
		return p
	}

	if _, err := Open(mk("fortran.npy", "{'descr': '<u4', 'fortran_order': True, 'shape': (4,), }")); err == nil {
		t.Fatal("fortran_order=True should be rejected")
	}
	if _, err := Open(mk("twod.npy", "{'descr': '<u4', 'fortran_order': False, 'shape': (2, 2), }")); err == nil {
		t.Fatal("a 2-D shape should be rejected")
	}
	if _, err := Open(mk("dtype.npy", "{'descr': '>u4', 'fortran_order': False, 'shape': (4,), }")); err == nil {
		t.Fatal("a big-endian dtype should be rejected")
	}
}

func TestTruncatedDataIsAnError(t *testing.T) {
	dir := t.TempDir()
	// Header claims 8 elements, only 4 elements of data follow.
	p := write(t, dir, "short.npy", "<u4", 8, 1, make([]byte, 16))
	if _, err := Open(p); err == nil || !strings.Contains(err.Error(), "data region") {
		t.Fatalf("expected a data-region error, got %v", err)
	}
}

func TestDictValue(t *testing.T) {
	h := "{'descr': '<u4', 'fortran_order': False, 'shape': (2725682,), }"
	for _, c := range []struct{ k, want string }{
		{"descr", "'<u4'"},
		{"fortran_order", "False"},
		{"shape", "(2725682,)"},
	} {
		got, ok := dictValue(h, c.k)
		if !ok || got != c.want {
			t.Fatalf("dictValue(%q) = %q,%v want %q", c.k, got, ok, c.want)
		}
	}
	if _, ok := dictValue(h, "nope"); ok {
		t.Fatal("missing key should report false")
	}
}

// TestRealPipelineArrays reads the actual pipeline output. This is the check
// that matters: a hand-rolled generator agreeing with a hand-rolled reader
// proves nothing on its own.
func TestRealPipelineArrays(t *testing.T) {
	dir := repoBuildTopology(t)
	if dir == "" {
		t.Skip("build/topology not present")
	}
	for _, c := range []struct {
		file  string
		descr string
		n     int
	}{
		{"parent.npy", "<u4", 2725682},
		{"depth.npy", "|u1", 2725682},
		{"subtree_out.npy", "<u4", 2725682},
		{"tip_count.npy", "<u4", 2725682},
		{"ott_id.npy", "<i8", 2725682},
		{"child_count.npy", "<u4", 2725682},
	} {
		p := filepath.Join(dir, c.file)
		if _, err := os.Stat(p); err != nil {
			t.Skipf("%s not present", c.file)
		}
		a, err := Open(p)
		if err != nil {
			t.Fatalf("%s: %v", c.file, err)
		}
		if a.Descr != c.descr {
			t.Errorf("%s: descr = %q, want %q", c.file, a.Descr, c.descr)
		}
		if a.Len != c.n {
			t.Errorf("%s: len = %d, want %d", c.file, a.Len, c.n)
		}
		_ = a.Close()
	}
}

func repoBuildTopology(t *testing.T) string {
	t.Helper()
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
