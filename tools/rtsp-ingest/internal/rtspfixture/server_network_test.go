//go:build rtspfixture_network

// SPDX-License-Identifier: MIT

package rtspfixture

import (
	"bytes"
	"context"
	"sync/atomic"
	"testing"
	"time"

	"github.com/bluenviron/gortsplib/v5"
	"github.com/bluenviron/gortsplib/v5/pkg/base"
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
	var playRequest, playResponse atomic.Bool
	c := &gortsplib.Client{Scheme: "rtsp", Host: f.Address().String(), Protocol: &protocol,
		OnRequest: func(req *base.Request) { playRequest.Store(req.Method == base.Play) },
		OnResponse: func(res *base.Response) { if playRequest.Load() && res.StatusCode == base.StatusOK { playResponse.Store(true) } },
	}
	if err := c.Start(); err != nil { t.Fatal(err) }
	defer c.Close()
	u, err := base.ParseURL("rtsp://" + f.Address().String() + "/fixture")
	if err != nil { t.Fatal(err) }
	desc, _, err := c.Describe(u)
	if err != nil { t.Fatal(err) }
	if err := c.SetupAll(desc.BaseURL, desc.Medias); err != nil { t.Fatal(err) }
	result := make(chan []byte, 1)
	badOrder := make(chan struct{}, 1)
	decoder := &rtph264.Decoder{PacketizationMode: 1}
	if err := decoder.Init(); err != nil { t.Fatal(err) }
	c.OnPacketRTPAny(func(_ *description.Media, _ format.Format, pkt *rtp.Packet) {
		if !playResponse.Load() { select { case badOrder <- struct{}{}: default: }; return }
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
	case <-badOrder: t.Fatal("RTP arrived before PLAY response")
	case got := <-result: if !bytes.Equal(got, HeaderAnnexB()) { t.Fatal("unexpected access unit") }
	case <-ctx.Done(): t.Fatal("packet deadline")
	}
	if err := f.Close(); err != nil { t.Fatal(err) }
	select { case <-f.Closed(): case <-ctx.Done(): t.Fatal("fixture did not close") }
}
