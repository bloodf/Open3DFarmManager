// SPDX-License-Identifier: MIT

package rtspfixture

import (
	"bytes"
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
