// SPDX-License-Identifier: MIT

package main

import (
	"context"
	"encoding/binary"
	"io"

	"open3dfarm.local/rtsp-ingest/internal/rtspfixture"
)

// Preflight consumes the same finite V2 input without opening a listener. No
// receipt is emitted until every record and the exact EOF have been validated.
func runPreflight(ctx context.Context, input io.Reader, output io.Writer) error {
	var version [1]byte
	if _, err := io.ReadFull(input, version[:]); err != nil || version[0] != 2 || ctx.Err() != nil {
		return errFixtureCommand
	}
	header, err := rtspfixture.ReadMovingHeader(input)
	if err != nil {
		return errFixtureCommand
	}
	reader, err := rtspfixture.NewMovingInput(input, header.Frames)
	if err != nil {
		return errFixtureCommand
	}
	receipt := make([]byte, 8+int(header.Frames)*72)
	copy(receipt, "RPF1")
	binary.BigEndian.PutUint16(receipt[4:6], header.Frames)
	for i := uint16(0); i < header.Frames; i++ {
		if ctx.Err() != nil {
			return errFixtureCommand
		}
		frame, err := reader.ReadNext()
		if err != nil {
			return errFixtureCommand
		}
		row := receipt[8+int(i)*72 : 8+int(i+1)*72]
		copy(row[:32], frame.RawSHA256[:])
		copy(row[32:64], frame.CanonicalSHA256[:])
		binary.BigEndian.PutUint32(row[64:68], uint32(frame.CanonicalBytes))
		binary.BigEndian.PutUint16(row[68:70], uint16(len(frame.NALUs)))
		binary.BigEndian.PutUint16(row[70:72], uint16(frame.PacketCount))
	}
	var extra [1]byte
	n, err := input.Read(extra[:])
	if n != 0 || err != io.EOF || ctx.Err() != nil {
		return errFixtureCommand
	}
	return writeFixed(output, receipt)
}
