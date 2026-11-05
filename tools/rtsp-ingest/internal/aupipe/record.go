package aupipe

import (
	"encoding/binary"
	"errors"
	"io"
)

const (
	maxAU = 262144
	maxTimestamp = uint64(1<<53 - 1)
	metadataSize = 12
	maxRecord = metadataSize + maxAU
)

// ErrInvalid is deliberately independent of source, operating system, and input errors.
var ErrInvalid = errors.New("aupipe failure")

// Record is an owned, validated private-pipe record.
type Record struct {
	TimestampUs uint64
	Keyframe bool
	AnnexB []byte
}

// ReadRecord validates the length before allocating the record body.
func ReadRecord(r io.Reader) (Record, error) {
	var prefix [4]byte
	if _, err := io.ReadFull(r, prefix[:]); err != nil {
		if err == io.EOF { return Record{}, io.EOF }
		return Record{}, ErrInvalid
	}
	n := binary.BigEndian.Uint32(prefix[:])
	if n < metadataSize+1 || n > maxRecord { return Record{}, ErrInvalid }
	body := make([]byte, int(n))
	if _, err := io.ReadFull(r, body); err != nil { return Record{}, ErrInvalid }
	if body[0] != 1 || body[1]&^byte(1) != 0 || body[2] != 0 || body[3] != 0 { return Record{}, ErrInvalid }
	ts := binary.BigEndian.Uint64(body[4:12])
	if ts > maxTimestamp { return Record{}, ErrInvalid }
	return Record{TimestampUs: ts, Keyframe: body[1] == 1, AnnexB: body[12:]}, nil
}

func writeAll(w io.Writer, data []byte) error {
	for len(data) > 0 {
		n, err := w.Write(data)
		if err != nil || n <= 0 || n > len(data) { return ErrInvalid }
		data = data[n:]
	}
	return nil
}
