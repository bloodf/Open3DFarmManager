package aupipe

import (
	"bytes"
	"encoding/binary"
	"io"
	"testing"
)

func TestReadRecordBoundaries(t *testing.T) {
	makeRecord := func(size int) []byte {
		b := make([]byte, 4+metadataSize+size)
		binary.BigEndian.PutUint32(b, uint32(len(b)-4))
		b[4] = 1
		return b
	}
	for _, size := range []int{1, maxAU} {
		b := makeRecord(size)
		b[5] = 1
		binary.BigEndian.PutUint64(b[8:16], maxTimestamp)
		r, err := ReadRecord(bytes.NewReader(b))
		if err != nil || !r.Keyframe || r.TimestampUs != maxTimestamp || len(r.AnnexB) != size {
			t.Fatalf("size %d: %#v %v", size, r, err)
		}
	}
	for _, n := range []uint32{0, 12, maxRecord + 1, ^uint32(0)} {
		var prefix [4]byte
		binary.BigEndian.PutUint32(prefix[:], n)
		if _, err := ReadRecord(bytes.NewReader(prefix[:])); err != ErrInvalid {
			t.Fatalf("length %d: %v", n, err)
		}
	}
	if _, err := ReadRecord(bytes.NewReader(nil)); err != io.EOF {
		t.Fatalf("empty: %v", err)
	}
	valid := makeRecord(1)
	for i := 1; i < len(valid); i++ {
		if _, err := ReadRecord(bytes.NewReader(valid[:i])); err != ErrInvalid {
			t.Fatalf("truncation %d: %v", i, err)
		}
	}
	for _, change := range []func([]byte){
		func(b []byte) { b[4] = 2 },
		func(b []byte) { b[5] = 2 },
		func(b []byte) { b[6] = 1 },
		func(b []byte) { b[7] = 1 },
		func(b []byte) { binary.BigEndian.PutUint64(b[8:16], maxTimestamp+1) },
	} {
		b := append([]byte(nil), valid...)
		change(b)
		if _, err := ReadRecord(bytes.NewReader(b)); err != ErrInvalid {
			t.Fatal("accepted invalid metadata")
		}
	}
}
