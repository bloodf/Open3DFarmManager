// SPDX-License-Identifier: MIT

package main

import (
	"bytes"
	"context"
	"encoding/binary"
	"io"
	"net/netip"

	"open3dfarm.local/rtsp-ingest/internal/rtspfixture"
)

func run(ctx context.Context, input io.Reader, output io.Writer) error {
	var version [1]byte
	if _, err := io.ReadFull(input, version[:]); err != nil {
		return errFixtureCommand
	}
	switch version[0] {
	case 1:
		return runV1(ctx, io.MultiReader(bytes.NewReader(version[:]), input), output)
	case 2:
		return runV2(ctx, input, output)
	default:
		return errFixtureCommand
	}
}

func movingSummary(counts rtspfixture.Snapshot, hashes [][32]byte) ([]byte, error) {
	if len(hashes) == 0 || len(hashes) > 60 {
		return nil, errFixtureCommand
	}
	data := make([]byte, 32+32*len(hashes))
	copy(data, "RTS2")
	for i, v := range []uint32{counts.Accepted, counts.Rejected, counts.Plays, counts.AccessUnits, counts.Packets, counts.WireBytes} {
		binary.BigEndian.PutUint32(data[4+i*4:8+i*4], v)
	}
	binary.BigEndian.PutUint16(data[28:30], uint16(len(hashes)))
	for i, h := range hashes {
		copy(data[32+i*32:64+i*32], h[:])
	}
	return data, nil
}

func runV2(ctx context.Context, input io.Reader, output io.Writer) error {
	header, err := rtspfixture.ReadMovingHeader(input)
	if err != nil || ctx.Err() != nil {
		return errFixtureCommand
	}
	reader, err := rtspfixture.NewMovingInput(input, header.Frames)
	if err != nil {
		return errFixtureCommand
	}
	address := netip.AddrPortFrom(netip.MustParseAddr("127.0.0.1"), header.Port)
	fixture, err := rtspfixture.StartAt(ctx, address)
	if err != nil {
		return errFixtureCommand
	}
	defer fixture.Close()
	var ready [8]byte
	copy(ready[:4], "RTF2")
	binary.BigEndian.PutUint16(ready[4:6], header.Port)
	binary.BigEndian.PutUint16(ready[6:8], header.Frames)
	if writeFixed(output, ready[:]) != nil {
		return errFixtureCommand
	}
	// No AU is read or sent until the existing maintained server admits PLAY.
	// The helper's initial-credit gate controls that request. No later credit ACK
	// is inferred here; the parent owns sequential next()/pacing and lease abort.
	select {
	case <-fixture.Played():
	case <-fixture.Closed():
		return errFixtureCommand
	case <-ctx.Done():
		return errFixtureCommand
	}
	hashes := make([][32]byte, 0, int(header.Frames))
	for i := uint16(0); i < header.Frames; i++ {
		frame, err := reader.ReadNext()
		if err != nil || ctx.Err() != nil {
			return errFixtureCommand
		}
		select {
		case <-fixture.Closed():
			return errFixtureCommand
		default:
		}
		if fixture.SendAU(frame.Timestamp90k, frame.NALUs) != nil {
			return errFixtureCommand
		}
		hashes = append(hashes, frame.CanonicalSHA256)
	}
	// Keep the server alive until the parent consumes the final AU and closes its
	// private input. main closes real descriptors on the original five-second
	// deadline; generic io.Reader does not promise cancellation or ownership.
	var extra [1]byte
	n, endErr := input.Read(extra[:])
	if n != 0 || endErr != io.EOF || ctx.Err() != nil {
		return errFixtureCommand
	}
	fixture.Close()
	counts := fixture.Snapshot()
	summary, err := movingSummary(counts, hashes)
	if err != nil || counts.Failed || counts.AccessUnits != uint32(header.Frames) || writeFixed(output, summary) != nil {
		return errFixtureCommand
	}
	return nil
}
