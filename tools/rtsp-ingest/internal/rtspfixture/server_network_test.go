//go:build rtspfixture_network

// SPDX-License-Identifier: MIT

package rtspfixture

import (
	"bufio"
	"bytes"
	"context"
	"net"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/bluenviron/gortsplib/v5"
	"github.com/bluenviron/gortsplib/v5/pkg/base"
	"github.com/bluenviron/gortsplib/v5/pkg/conn"
	"github.com/bluenviron/gortsplib/v5/pkg/description"
	"github.com/bluenviron/gortsplib/v5/pkg/format"
	"github.com/bluenviron/gortsplib/v5/pkg/format/rtph264"
	"github.com/pion/rtp"
)

// TestNetworkPlayOrdering requires separate loopback runtime authorization.
func TestNetworkPlayOrdering(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 4*time.Second)
	defer cancel()
	f, err := Start(ctx)
	if err != nil { t.Fatal(err) }
	defer f.Close()
	if f.SendAU(0, HeaderAU()) == nil { t.Fatal("sent before PLAY") }
	protocol := gortsplib.ProtocolTCP
	var playSequence atomic.Value
	capture := &capturedWire{}
	c := &gortsplib.Client{Scheme: "rtsp", Host: f.Address().String(), Protocol: &protocol,
		DialContext: func(ctx context.Context, network, address string) (net.Conn, error) {
            socket, err := (&net.Dialer{}).DialContext(ctx, network, address)
            if err != nil { return nil, err }
            return &capturingConn{Conn: socket, capture: capture}, nil
        },
        OnRequest: func(req *base.Request) {
            if req.Method == base.Play {
                if sequence := req.Header["CSeq"]; len(sequence) == 1 { playSequence.Store(sequence[0]) }
            }
        },
	}
	if err := c.Start(); err != nil { t.Fatal(err) }
	defer c.Close()
	u, err := base.ParseURL("rtsp://" + f.Address().String() + "/fixture")
	if err != nil { t.Fatal(err) }
	desc, _, err := c.Describe(u)
	if err != nil { t.Fatal(err) }
	if err := c.SetupAll(desc.BaseURL, desc.Medias); err != nil { t.Fatal(err) }
	result := make(chan []byte, 1)
	decoder := &rtph264.Decoder{PacketizationMode: 1}
	if err := decoder.Init(); err != nil { t.Fatal(err) }
	c.OnPacketRTPAny(func(_ *description.Media, _ format.Format, pkt *rtp.Packet) {
		nalus, err := decoder.Decode(pkt)
		if err != nil { return }
		var out []byte
		for _, nalu := range nalus { out = append(out, 0, 0, 0, 1); out = append(out, nalu...) }
		select { case result <- out: default: }
	})
	sent := make(chan error, 1)
	go func() { select { case <-f.Played(): sent <- f.SendAU(9000, HeaderAU()); case <-ctx.Done(): sent <- ctx.Err() } }()
	if _, err := c.Play(nil); err != nil { t.Fatal(err) }
	select { case err := <-sent: if err != nil { t.Fatal(err) }; case <-ctx.Done(): t.Fatal("send deadline") }
	select {
	case got := <-result: if !bytes.Equal(got, HeaderAnnexB()) { t.Fatal("unexpected access unit") }
	case <-ctx.Done(): t.Fatal("packet deadline")
	}
    // Decode bytes in their actual socket-read order, not callback scheduling order.
    capture.mu.Lock()
    raw := append([]byte(nil), capture.bytes.Bytes()...)
    capture.mu.Unlock()
    reader := conn.NewConn(bufio.NewReader(bytes.NewReader(raw)), nil)
    playSeen := false
    for {
        item, err := reader.Read()
        if err != nil { t.Fatal("missing complete wire-order evidence", err) }
        if response, ok := item.(*base.Response); ok {
            if sequence := response.Header["CSeq"]; len(sequence) == 1 && sequence[0] == playSequence.Load() {
                if response.StatusCode != base.StatusOK { t.Fatal("PLAY failed on wire") }
                playSeen = true
            }
        }
        if _, ok := item.(*base.InterleavedFrame); ok {
            if !playSeen { t.Fatal("interleaved frame preceded successful PLAY response on wire") }
            break
        }
    }
	if err := f.Close(); err != nil { t.Fatal(err) }
	select { case <-f.Closed(): case <-ctx.Done(): t.Fatal("fixture did not close") }
}

// Capture only bounded received bytes; the maintained codec establishes wire order.
type capturedWire struct {
    mu sync.Mutex
    bytes bytes.Buffer
}
type capturingConn struct {
    net.Conn
    capture *capturedWire
}
func (c *capturingConn) Read(p []byte) (int, error) {
    n, err := c.Conn.Read(p)
    c.capture.mu.Lock()
    defer c.capture.mu.Unlock()
    if c.capture.bytes.Len()+n > wireLimit { c.Conn.Close(); return 0, errFixture }
    c.capture.bytes.Write(p[:n])
    return n, err
}
