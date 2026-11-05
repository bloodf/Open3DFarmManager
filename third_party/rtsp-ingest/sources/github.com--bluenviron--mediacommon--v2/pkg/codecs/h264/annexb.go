package h264

import (
	"bytes"
	"errors"
	"fmt"
)

// ErrAnnexBNoNALUs is returned by AnnexBUnmarshal when no NALUs have been decoded.
var ErrAnnexBNoNALUs = errors.New("Annex-B unit doesn't contain any NALU")

// ErrAnnexBNoInitialDelimiter is returned by AnnexBUnmarshal when the initial delimiter is not found.
var ErrAnnexBNoInitialDelimiter = errors.New("initial delimiter not found")

// AnnexB is an access unit that can be decoded/encoded from/to the Annex-B stream format.
// Specification: ITU-T Rec. H.264, Annex B
type AnnexB [][]byte

// AnnexBLimits bounds input and canonical four-byte-delimited output.
type AnnexBLimits struct {
	MaxAccessUnitBytes    int
	MaxNALUsPerAccessUnit int
}

// UnmarshalWithLimits decodes with validated per-call limits.
func (a *AnnexB) UnmarshalWithLimits(buf []byte, limits AnnexBLimits) error {
	maxInt := int(^uint(0) >> 1)
	if limits.MaxAccessUnitBytes <= 0 || limits.MaxNALUsPerAccessUnit <= 0 ||
		limits.MaxNALUsPerAccessUnit > maxInt/4 || limits.MaxAccessUnitBytes > maxInt-4 {
		return fmt.Errorf("invalid Annex-B limits")
	}
	if len(buf) > limits.MaxAccessUnitBytes {
		return fmt.Errorf("Annex-B input exceeds limit")
	}
	return a.unmarshal(buf, &limits)
}

// Unmarshal decodes an access unit from the Annex-B stream format.
func (a *AnnexB) Unmarshal(buf []byte) error {
	return a.unmarshal(buf, nil)
}

func (a *AnnexB) unmarshal(buf []byte, limits *AnnexBLimits) error {
	var pos int
	switch {
	case len(buf) >= 4 && buf[0] == 0x00 && buf[1] == 0x00 && buf[2] == 0x00 && buf[3] == 0x01:
		pos = 4
	case len(buf) >= 3 && buf[0] == 0x00 && buf[1] == 0x00 && buf[2] == 0x01:
		pos = 3
	default:
		return ErrAnnexBNoInitialDelimiter
	}

	if len(buf) == pos {
		return ErrAnnexBNoNALUs
	}

	type naluPos struct {
		start int
		end   int
	}

	capacity := 8
	if limits != nil && limits.MaxNALUsPerAccessUnit < capacity {
		capacity = limits.MaxNALUsPerAccessUnit
	}
	positions := make([]naluPos, 0, capacity)
	auSize := 0
	serialized := 0
	charge := func(size int) error {
		if limits != nil {
			if len(positions) >= limits.MaxNALUsPerAccessUnit ||
				limits.MaxAccessUnitBytes-serialized < 4 || size > limits.MaxAccessUnitBytes-serialized-4 {
				return fmt.Errorf("Annex-B output exceeds limits")
			}
			serialized += size + 4
		}
		return nil
	}

	for pos < len(buf) {
		i := bytes.Index(buf[pos:], []byte{0x00, 0x00, 0x01})

		if i == -1 {
			remaining := len(buf) - pos
			if remaining > 0 {
				if (auSize + remaining) > MaxAccessUnitSize {
					return fmt.Errorf("access unit size (%d) is too big, maximum is %d", auSize+remaining, MaxAccessUnitSize)
				}
				if err := charge(remaining); err != nil {
					return err
				}
				positions = append(positions, naluPos{start: pos, end: len(buf)})
			}
			break
		}

		var naluEnd int
		if i > 0 && buf[pos+i-1] == 0x00 {
			naluEnd = pos + i - 1
		} else {
			naluEnd = pos + i
		}

		naluSize := naluEnd - pos
		if naluSize > 0 {
			auSize += naluSize
			if auSize > MaxAccessUnitSize {
				return fmt.Errorf("access unit size (%d) is too big, maximum is %d", auSize, MaxAccessUnitSize)
			}
			if err := charge(naluSize); err != nil {
				return err
			}
			positions = append(positions, naluPos{start: pos, end: naluEnd})
		}

		pos += i + 3
	}

	if len(positions) == 0 {
		return ErrAnnexBNoNALUs
	}

	if len(positions) > MaxNALUsPerAccessUnit {
		return fmt.Errorf("NALU count (%d) exceeds maximum allowed (%d)",
			len(positions), MaxNALUsPerAccessUnit)
	}

	*a = make([][]byte, len(positions))
	for i := range positions {
		(*a)[i] = buf[positions[i].start:positions[i].end]
	}

	return nil
}

func (a AnnexB) marshalSize() int {
	n := 0
	for _, nalu := range a {
		n += 4 + len(nalu)
	}
	return n
}

// Marshal encodes an access unit into the Annex-B stream format.
func (a AnnexB) Marshal() ([]byte, error) {
	buf := make([]byte, a.marshalSize())
	pos := 0

	for _, nalu := range a {
		pos += copy(buf[pos:], []byte{0x00, 0x00, 0x00, 0x01})
		pos += copy(buf[pos:], nalu)
	}

	return buf, nil
}
