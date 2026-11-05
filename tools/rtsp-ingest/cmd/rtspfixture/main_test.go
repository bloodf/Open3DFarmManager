// SPDX-License-Identifier: MIT

package main

import (
	"bytes"
	"testing"
)

func TestReadConfigExactFixedPort(t *testing.T) {
	address, err := readConfig(bytes.NewReader([]byte{1, 0x48, 0x7a}))
	if err != nil || address.String() != "127.0.0.1:18554" {
		t.Fatal("unexpected fixed source configuration")
	}
}

func TestReadConfigRejectsMalformed(t *testing.T) {
	for _, input := range [][]byte{nil, {1}, {1, 0x48}, {0, 0x48, 0x7a}, {1, 0, 0}} {
		if _, err := readConfig(bytes.NewReader(input)); err == nil {
			t.Fatal("accepted malformed configuration")
		}
	}
}

type shortWriter struct{}

func (shortWriter) Write(data []byte) (int, error) { return len(data)-1, nil }

func TestWriteFixedRejectsShortWrite(t *testing.T) {
	if writeFixed(shortWriter{}, []byte{1, 2}) == nil {
		t.Fatal("accepted truncated private status")
	}
	var output bytes.Buffer
	if writeFixed(&output, []byte{1, 2}) != nil || !bytes.Equal(output.Bytes(), []byte{1, 2}) {
		t.Fatal("changed valid private status")
	}
}
