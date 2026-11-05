// SPDX-License-Identifier: MIT

package main

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/binary"
	"testing"

	"open3dfarm.local/rtsp-ingest/internal/rtspfixture"
)

func TestMovingSummaryBoundAndExactHashes(t *testing.T) {
	hashes := make([][32]byte, 30)
	for i := range hashes {
		hashes[i] = sha256.Sum256([]byte{byte(i)})
	}
	data, err := movingSummary(rtspfixture.Snapshot{Accepted: 1, Plays: 1, AccessUnits: 30, Packets: 60, WireBytes: 3972}, hashes)
	if err != nil || len(data) != 992 || string(data[:4]) != "RTS2" || binary.BigEndian.Uint16(data[28:30]) != 30 || data[30] != 0 || data[31] != 0 {
		t.Fatal("invalid moving summary")
	}
	for i, hash := range hashes {
		if !bytes.Equal(data[32+i*32:64+i*32], hash[:]) {
			t.Fatal("canonical hash changed")
		}
	}
	if binary.BigEndian.Uint32(data[16:20]) != 30 || binary.BigEndian.Uint32(data[24:28]) != 3972 {
		t.Fatal("counter layout changed")
	}
	for _, count := range []int{0, 61} {
		if _, err := movingSummary(rtspfixture.Snapshot{}, make([][32]byte, count)); err == nil {
			t.Fatal("unbounded summary")
		}
	}
	max, err := movingSummary(rtspfixture.Snapshot{}, make([][32]byte, 60))
	if err != nil || len(max) != 1952 {
		t.Fatal("maximum summary changed")
	}
}

func TestVersionDispatchRejectsBeforeStart(t *testing.T) {
	for _, data := range [][]byte{nil, {0}, {3}, {2}, {2, 1, 0, 0, 0, 30, 0, 0}} {
		var output bytes.Buffer
		if run(context.Background(), bytes.NewReader(data), &output) == nil || output.Len() != 0 {
			t.Fatal("invalid version/config reached start")
		}
	}
	// Both valid formats under cancellation must stop before any listener/output.
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	for _, data := range [][]byte{{1, 0x48, 0x7a}, {2, 1, 0x48, 0x7a, 0, 30, 0, 0}} {
		var output bytes.Buffer
		if run(ctx, bytes.NewReader(data), &output) == nil || output.Len() != 0 {
			t.Fatal("cancelled configuration started")
		}
	}
}
