// SPDX-License-Identifier: MIT

package rtspfixture

import (
	"bytes"
	"context"
	"net/netip"
	"testing"

	"github.com/bluenviron/gortsplib/v5/pkg/sdpunmarshaler"
	"open3dfarm.local/rtsp-ingest/internal/ingest"
)

func TestFixtureSDP(t *testing.T) {
	desc, _ := newDescription()
	body, err := desc.Marshal()
	if err != nil {
		t.Fatal(err)
	}
	limits := sdpunmarshaler.Limits{MaxBodyBytes: 16384, MaxLineBytes: 2048, MaxLines: 64, MaxMediaDescriptions: 1, MaxFormatsPerMedia: 1, MaxAttributes: 32}
	parsed, err := sdpunmarshaler.UnmarshalWithLimits(body, limits)
	if err != nil {
		t.Fatal(err)
	}
	destination := ingest.Destination{Addr: netip.MustParseAddrPort("127.0.0.1:8554"), Path: "/fixture"}
	if err := ingest.ValidateSDP(parsed, destination); err != nil {
		t.Fatal(err)
	}
	if bytes.Contains(body, []byte("sprop-parameter-sets")) || !bytes.Contains(body, []byte("packetization-mode=1")) {
		t.Fatal("unexpected SDP parameter sets or packetization mode")
	}
	var annex []byte
	for _, nalu := range HeaderAU() {
		annex = append(annex, 0, 0, 0, 1)
		annex = append(annex, nalu...)
	}
	if !bytes.Equal(annex, HeaderAnnexB()) {
		t.Fatal("unexpected canonical fixture bytes")
	}
}

// Rejection must happen before Start creates any listener.
func TestStartAtRejectsNonFixedLoopback(t *testing.T) {
	for _, address := range []string{"127.0.0.1:0", "127.0.0.2:18554", "0.0.0.0:18554", "[::1]:18554", "[::ffff:127.0.0.1]:18554"} {
		if _, err := StartAt(context.Background(), netip.MustParseAddrPort(address)); err == nil {
			t.Fatal("StartAt accepted disallowed address")
		}
		if validFixedAddress(netip.MustParseAddrPort(address)) {
			t.Fatalf("accepted disallowed fixed address")
		}
	}
	if !validFixedAddress(netip.MustParseAddrPort("127.0.0.1:18554")) {
		t.Fatal("rejected fixed TCP4 loopback")
	}
	if _, err := StartAt(nil, netip.AddrPort{}); err == nil {
		t.Fatal("accepted missing address")
	}
}

func TestSnapshotCountersSaturate(t *testing.T) {
	f := &Fixture{}
	f.counts.rejected.Store(65534)
	increment(&f.counts.rejected)
	increment(&f.counts.rejected)
	got := f.Snapshot()
	if got.Rejected != 65535 || got.Accepted != 0 || got.WireBytes != 0 || got.Failed {
		t.Fatal("unexpected bounded snapshot")
	}
}
