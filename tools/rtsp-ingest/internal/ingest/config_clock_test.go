// SPDX-License-Identifier: MIT

package ingest

import (
	"net/netip"
	"strings"
	"testing"
	"time"
)

const validConfigJSON = `{"version":1,"address":"127.0.0.1","port":8554,"path":"/fixture","leaseMs":30000}`

func fixtureDestination() Destination {
	return Destination{Addr: netip.MustParseAddrPort("127.0.0.1:8554"), Path: "/fixture"}
}

func TestConfigStrictAdmission(t *testing.T) {
	cfg, err := ValidateConfig([]byte(validConfigJSON))
	if err != nil || cfg.Destination != fixtureDestination() || cfg.Lease != 30*time.Second {
		t.Fatalf("config admission: %v", err)
	}
	for _, raw := range []string{
		validConfigJSON + ` {}`, strings.Replace(validConfigJSON, `"version":1`, `"version":1,"version":1`, 1),
		strings.Replace(validConfigJSON, `"version":1`, `"Version":1`, 1),
		strings.Replace(validConfigJSON, `"version":1`, `"extra":1,"version":1`, 1),
		strings.Replace(validConfigJSON, `"version":1`, `"version":null`, 1),
		strings.Replace(validConfigJSON, `"port":8554`, `"port":0`, 1),
		strings.Replace(validConfigJSON, `"port":8554`, `"port":65536`, 1),
		strings.Replace(validConfigJSON, `"leaseMs":30000`, `"leaseMs":0`, 1),
		strings.Replace(validConfigJSON, `"leaseMs":30000`, `"leaseMs":30001`, 1),
		strings.Replace(validConfigJSON, `"leaseMs":30000`, `"leaseMs":1.0`, 1),
		strings.Replace(validConfigJSON, `"leaseMs":30000`, `"leaseMs":"1"`, 1),
		strings.Replace(validConfigJSON, `,"leaseMs":30000`, ``, 1),
		`null`, `[]`, validConfigJSON + strings.Repeat(" ", 2048),
	} {
		if _, err := ValidateConfig([]byte(raw)); err != ErrConfig {
			t.Fatal("accepted invalid config")
		}
	}
	for _, address := range []string{"fixture.invalid", "0.0.0.0", "::", "224.0.0.1", "255.255.255.255", "::ffff:127.0.0.1", "fe80::1%lo0", "127.0.0.1:8554"} {
		if _, err := ValidateConfig([]byte(strings.Replace(validConfigJSON, "127.0.0.1", address, 1))); err != ErrConfig {
			t.Fatal("accepted invalid address")
		}
	}
	for _, path := range []string{"fixture", "//other", "/user@host", "/fixture?token=x", "/fixture#x", "/fixture\\r", "/fixture\\u0000"} {
		if _, err := ValidateConfig([]byte(strings.Replace(validConfigJSON, "/fixture", path, 1))); err != ErrConfig {
			t.Fatal("accepted invalid path")
		}
	}
	for _, address := range []string{"::1", "192.0.2.1", "2001:db8::1"} {
		if _, err := ValidateConfig([]byte(strings.Replace(validConfigJSON, "127.0.0.1", address, 1))); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := ValidateConfig(append([]byte(validConfigJSON), 0xff)); err != ErrConfig {
		t.Fatal("accepted invalid UTF-8")
	}
}

func TestStreamClockWrapAndRounding(t *testing.T) {
	var clock StreamClock
	for i, tc := range []struct {
		rtp uint32
		us  uint64
	}{
		{^uint32(0) - 44999, 0}, {45000, 1000000}, {45001, 1000011}, {135000, 2000000},
	} {
		got, err := clock.Complete(tc.rtp)
		if err != nil || got != tc.us {
			t.Fatalf("step %d: got %d, %v", i, got, err)
		}
	}
}

func TestStreamClockRejectsDiscontinuityAndOverflow(t *testing.T) {
	for _, timestamp := range []uint32{100, 99, 180101} {
		var clock StreamClock
		_, _ = clock.Complete(100)
		if _, err := clock.Complete(timestamp); err != ErrClock {
			t.Fatal("accepted discontinuity")
		}
		if _, err := clock.Complete(200); err != ErrClock {
			t.Fatal("revived clock")
		}
	}
	for _, ticks := range []uint64{^uint64(0), ^uint64(0) / 1000000} {
		clock := StreamClock{started: true, last: 1, ticks: ticks}
		if _, err := clock.Complete(2); err != ErrClock {
			t.Fatal("accepted overflowing clock")
		}
	}
	var clock StreamClock
	_, _ = clock.Complete(10)
	if got, err := clock.Complete(180010); err != nil || got != 2000000 {
		t.Fatal("rejected exact two-second delta")
	}
}
