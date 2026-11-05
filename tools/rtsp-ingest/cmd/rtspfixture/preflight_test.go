// SPDX-License-Identifier: MIT

package main

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/binary"
	"testing"
)

func preflightInput(count uint16) []byte {
	data := []byte{2, 1, 0x48, 0x7a, 0, 0, 0, 0}
	binary.BigEndian.PutUint16(data[4:6], count)
	for i := uint16(0); i < count; i++ {
		body := []byte{0, 0, 1, 0x67, 0x11, 0, 0, 1, 0x68, 0x22, 0, 0, 1, 0x65, 0x33}
		record := make([]byte, 16+len(body))
		binary.BigEndian.PutUint32(record[:4], uint32(12+len(body)))
		record[4], record[5] = 1, 1
		binary.BigEndian.PutUint64(record[8:16], uint64(i)*100000)
		copy(record[16:], body)
		data = append(data, record...)
	}
	return data
}

func TestPreflightCompleteReceipt(t *testing.T) {
	input := preflightInput(30)
	var output bytes.Buffer
	if err := runPreflight(context.Background(), bytes.NewReader(input), &output); err != nil {
		t.Fatal(err)
	}
	receipt := output.Bytes()
	if len(receipt) != 2168 || string(receipt[:4]) != "RPF1" || binary.BigEndian.Uint16(receipt[4:6]) != 30 || receipt[6] != 0 || receipt[7] != 0 {
		t.Fatal("invalid receipt framing")
	}
	raw := sha256.Sum256(input[24:39])
	canonical := sha256.Sum256([]byte{0, 0, 0, 1, 0x67, 0x11, 0, 0, 0, 1, 0x68, 0x22, 0, 0, 0, 1, 0x65, 0x33})
	for i := 0; i < 30; i++ {
		row := receipt[8+i*72 : 8+(i+1)*72]
		if !bytes.Equal(row[:32], raw[:]) || !bytes.Equal(row[32:64], canonical[:]) || binary.BigEndian.Uint32(row[64:68]) != 18 || binary.BigEndian.Uint16(row[68:70]) != 3 || binary.BigEndian.Uint16(row[70:72]) != 3 {
			t.Fatal("receipt does not describe validated bytes")
		}
	}
}

func TestPreflightRejectsWithoutPartialReceipt(t *testing.T) {
	valid := preflightInput(2)
	badLast := append([]byte{}, valid...)
	badLast[len(badLast)-2] = 0x61
	wrongVersion := append([]byte{}, valid...)
	wrongVersion[0] = 1
	for _, input := range [][]byte{nil, valid[:7], valid[:len(valid)-1], append(append([]byte{}, valid...), 0), badLast, wrongVersion} {
		var output bytes.Buffer
		if runPreflight(context.Background(), bytes.NewReader(input), &output) == nil || output.Len() != 0 {
			t.Fatal("invalid input produced a receipt")
		}
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	var output bytes.Buffer
	if runPreflight(ctx, bytes.NewReader(valid), &output) == nil || output.Len() != 0 {
		t.Fatal("cancelled preflight produced a receipt")
	}
}
