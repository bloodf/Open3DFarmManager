// Patch contribution: original MIT-licensed test source. UNRUN.
package gortsplib

import (
	"bufio"
	"context"
	"encoding/hex"
	"errors"
	"net"
	"strings"
	"testing"
	"time"

	"github.com/bluenviron/gortsplib/v5/pkg/base"
	"github.com/bluenviron/gortsplib/v5/pkg/conn"
	"github.com/bluenviron/gortsplib/v5/pkg/sdpunmarshaler"
	"github.com/pion/rtp"
	"github.com/pion/sdp/v3"
)

func TestIncomingRTCPPolicy(t *testing.T) {
	valid := []byte{0x80, 0xc9, 0, 1, 0, 0, 0, 1}
	normal := &clientMedia{c: &Client{}}
	packets, err := normal.decodeRTCP(valid)
	if err != nil || len(packets) != 1 {
		t.Fatalf("default RTCP: %v %v", packets, err)
	}
	discard := &clientMedia{c: &Client{discardIncomingRTCP: true}}
	for _, encoded := range []string{hex.EncodeToString(valid), "8fcd000900000000000000000000ffff000000003fff3fff3fff3fff3fff3fff3fff3fff20070000", "8fcd016d00000000000000000000ffff000000003fff3fff3fff3fff3fff3fff3fff3ff9bfff3fff3fff3fff3fff3fff3fff3fff3ff9bfff3fff3fff3fff3fff3fff3fff3fff3ff9bfff3fff3fff3fff3fff3fff3fff3fff3ff9bfff3fff3fff3fff3fff3fff3fff3fff3ff9bfff3fff3fff3fff3fff3fff3fff3fff3ff9bfff3fff3fff3fff3fff3fff3fff3fff3ff9bfff3fff3fff3fff3fff3fff3fff3fff3ff9bfff3fff3fff3fff3fff3fff3fff3fff3ff9bfff3fff3fff3fff3fff3fff3fff3fff3ff9bfff3fff3fff3fff3fff3fff3fff3fff3ff9bfff3fff3fff3fff3fff3fff3fff3fff3ff9bfff3fff3fff3fff3fff3fff3fff3fff3ff9bfff3fff3fff3fff3fff3fff3fff3fff3ff9bfff3fff3fff3fff3fff3fff3fff3fff3ff9bfff3fff3fff3fff3fff3fff3fff3fff3ff9bfff3fff3fff3fff3fff3fff3fff3fff3ff9bfff3fff3fff3fff3fff3fff3fff3fff3ff9bfff3fff3fff3fff3fff3fff3fff3fff3ff9bfff3fff3fff3fff3fff3fff3fff3fff3ff9bfff3fff3fff3fff3fff3fff3fff3fff3ff9bfff3fff3fff3fff3fff3fff3fff3fff3ff9bfff3fff3fff3fff3fff3fff3fff3fff3ff9bfff3fff3fff3fff3fff3fff3fff3fff3ff9bfff3fff3fff3fff3fff3fff3fff3fff3ff9bfff3fff3fff3fff3fff3fff3fff3fff3ff9bfff3fff3fff3fff3fff3fff3fff3fff3ff9bfff3fff3fff3fff3fff3fff3fff3fff3ff9bfff3fff3fff3fff3fff3fff3fff3fff3ff9bfff3fff3fff3fff3fff3fff3fff3fff3ff9bfff3fff3fff3fff3fff3fff3fff3fff3ff9bfff3fff3fff3fff3fff3fff3fff3fff3ff9bfff3fff3fff3fff3fff3fff3fff3fff3ff9bfff3fff3fff3fff3fff3fff3fff3fff3ff9bfff3fff3fff3fff3fff3fff3fff3fff3ff9bfff3fff3fff3fff3fff3fff3fff3fff3ff9bfff3fff3fff3fff3fff3fff3fff3fff3ff9bfff3fff3fff3fff3fff3fff3fff3fff3ff9bfff3fff3fff3fff3fff3fff3fff3fff3ff9bfff3fff3fff3fff3fff3fff3fff3fff3ff9bfff3fff3fff3fff3fff3fff3fff3fff3ff9bfff3fff3fff3fff3fff3fff3fff3fff3ff9bfff3fff3fff3fff3fff3fff3fff3fff3ff9bfff3fff3fff3fff3fff3fff3fff3fff3ff9bfff3fff3fff3fff3fff3fff3fff3fff3ff9bfff3fff3fff3fff3fff3fff3fff3fff3ff9bfff3fff3fff3fff3fff3fff3fff3fff3ff9bfff3fff3fff3fff3fff3fff3fff3fff3ff9bfff3fff3fff3fff3fff3fff3fff3fff3ff9bfff3fff3fff3fff3fff3fff3fff3fff3ff9bfff3fff3fff3fff3fff3fff3fff3fff3ff9bfff3fff3fff3fff3fff3fff3fff3fff3ff9bfff3fff3fff3fff3fff3fff3fff3fff3ff9bfff3fff3fff3fff3fff3fff3fff3fff3ff9bfff3fff3fff3fff3fff3fff3fff3fff3ff9bfff3fff3fff3fff3fff3fff3fff3fff3ff9bfff3fff3fff3fff3fff3fff3fff3fff3ff9bfff3fff3fff3fff3fff3fff3fff3fff3ff9bfff3fff3fff3fff3fff3fff3fff3fff3ff9bfff3fff3fff3fff3fff3fff3fff3fff3ff9bfff3fff3fff3fff3fff3fff3fff3fff3ff9bfff3fff3fff3fff3fff3fff3fff3fff3ff9bfff3fff3fff3fff3fff3fff3fff3fff3ff9bfff3fff3fff3fff3fff3fff3fff3fff3ff9bfff3fff3fff3fff3fff3fff3fff3fff3ff9bfff3fff3fff3fff3fff3fff3fff3fff3ff9bfff3fff3fff3fff3fff3fff3fff3fff3ff9bfff3fff3fff3fff3fff3fff3fff3fff3ff9bfff3fff3fff3fff3fff3fff3fff3fff3ff9bfff3fff3fff3fff3fff3fff3fff3fff3ff9bfff3fff3fff3fff3fff3fff3fff3fff3ff9bfff3fff3fff3fff3fff3fff3fff3fff3ff9bfff3fff3fff3fff3fff3fff3fff3fff3ff9bfff3fff3fff3fff3fff3fff3fff3fff3ff9bfff3fff3fff3fff3fff3fff3fff3fff3ff9bfff3fff3fff3fff3fff3fff3fff3fff3ff9bfff3fff3fff3fff3fff3fff3fff3fff3ff9bfff3fff3fff3fff3fff3fff3fff3fff3ff9bfff3fff3fff3fff3fff3fff3fff3fff3ff9bfff3fff3fff3fff3fff3fff3fff3fff3ff9bfff00000000"} {
		payload, err := hex.DecodeString(encoded)
		if err != nil {
			t.Fatal(err)
		}
		packets, err = discard.decodeRTCP(payload)
		if err != nil || len(packets) != 0 {
			t.Fatalf("discard: %v %v", packets, err)
		}
	}
	// An uninitialized SRTP context panics if decryptRTCP is entered.
	discard.srtpInCtx = &wrappedSRTPContext{}
	if packets, err = discard.decodeRTCP(valid); err != nil || len(packets) != 0 {
		t.Fatalf("decrypt bypass: %v", err)
	}
	discard.srtpInCtx = nil
	wire := []byte{0x80, 96, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 42}
	var header rtp.Header
	n, err := header.Unmarshal(wire)
	if err != nil {
		t.Fatal(err)
	}
	pkt, err := discard.decodeRTP(wire, &header, n)
	if err != nil || len(pkt.Payload) != 1 || pkt.Payload[0] != 42 {
		t.Fatalf("RTP: %v %v", pkt, err)
	}
}

func TestClientPolicySnapshotsAndValidation(t *testing.T) {
	limits := base.ReadLimits{MaxBodyBytes: 16384}
	sdpLimits := sdpunmarshaler.Limits{MaxBodyBytes: 16384, MaxLineBytes: 2048, MaxLines: 64, MaxMediaDescriptions: 1, MaxFormatsPerMedia: 1, MaxAttributes: 32}
	called := false
	c := &Client{DiscardIncomingRTCP: true, ReadLimits: &limits, SDPLimits: &sdpLimits, ValidateSDP: func(*sdp.SessionDescription) error { called = true; return nil }}
	if err := c.Start(); err != nil {
		t.Fatal(err)
	}
	defer c.Close()
	limits.MaxBodyBytes = 1
	sdpLimits.MaxLines = 1
	c.DiscardIncomingRTCP = false
	c.ValidateSDP = nil
	if !c.discardIncomingRTCP || c.readLimits.MaxBodyBytes != 16384 || c.sdpLimits.MaxLines != 64 || c.validateSDP == nil {
		t.Fatal("policy changed after Start")
	}
	if err := c.validateSDP(&sdp.SessionDescription{}); err != nil || !called {
		t.Fatal("hook snapshot changed")
	}
	for _, bad := range []Client{
		{ReadLimits: &base.ReadLimits{MaxBodyBytes: 0}},
		{ReadLimits: &base.ReadLimits{MaxBodyBytes: -1}},
		{ReadLimits: &base.ReadLimits{MaxBodyBytes: int(^uint(0) >> 1)}},
		{SDPLimits: &sdpunmarshaler.Limits{}},
		{SDPLimits: &sdpunmarshaler.Limits{MaxBodyBytes: 16384, MaxLineBytes: -1, MaxLines: 64, MaxMediaDescriptions: 1, MaxFormatsPerMedia: 1, MaxAttributes: 32}},
	} {
		if err := bad.Start(); err == nil {
			bad.Close()
			t.Fatal("invalid limits accepted")
		}
		if bad.DialContext != nil {
			t.Fatal("validation followed Start side effects")
		}
	}
}

func TestClientSDPPolicyVetoBeforeConversion(t *testing.T) {
	client, server := net.Pipe()
	defer client.Close()
	defer server.Close()
	deadline := time.Now().Add(5 * time.Second)
	if err := client.SetDeadline(deadline); err != nil {
		t.Fatal(err)
	}
	if err := server.SetDeadline(deadline); err != nil {
		t.Fatal(err)
	}
	done := make(chan error, 1)
	go func() {
		defer server.Close()
		wire := conn.NewConn(bufio.NewReader(server), server)
		for i := 0; i < 2; i++ {
			req, err := wire.ReadRequest()
			if err != nil {
				done <- err
				return
			}
			res := &base.Response{StatusCode: base.StatusOK}
			if req.Method == base.Options {
				res.Header = base.Header{"Public": base.HeaderValue{"DESCRIBE"}}
			} else {
				res.Header = base.Header{"Content-Type": base.HeaderValue{"application/sdp"}}
				res.Body = []byte("v=0\r\no=- 0 0 IN IP4 127.0.0.1\r\ns=test\r\nt=0 0\r\nm=video 0 RTP/AVP 96\r\na=rtpmap:96 H264/90000\r\na=fmtp:96 packetization-mode=invalid\r\n")
			}
			if err = wire.WriteResponse(res); err != nil {
				done <- err
				return
			}
		}
		done <- nil
	}()
	veto := errors.New("policy veto sentinel")
	c := &Client{Scheme: "rtsp", Host: "example.invalid:554", DialContext: func(context.Context, string, string) (net.Conn, error) { return client, nil }, ValidateSDP: func(*sdp.SessionDescription) error { return veto }}
	if err := c.Start(); err != nil {
		t.Fatal(err)
	}
	defer c.Close()
	u, err := base.ParseURL("rtsp://example.invalid:554/test")
	if err != nil {
		t.Fatal(err)
	}
	_, _, err = c.Describe(u)
	if err == nil || !strings.Contains(err.Error(), veto.Error()) {
		t.Fatalf("expected policy veto before malformed codec conversion: %v", err)
	}
	select {
	case err := <-done:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("server did not finish")
	}
}
