// SPDX-License-Identifier: MIT

package ingest

import (
	"context"
	"net"
	"os"
	"strings"
	"time"

	"github.com/bluenviron/gortsplib/v5"
	"github.com/bluenviron/gortsplib/v5/pkg/base"
	"github.com/bluenviron/gortsplib/v5/pkg/format"
	"github.com/pion/rtp"
	"github.com/pion/sdp/v3"

	"open3dfarm.local/rtsp-ingest/internal/aupipe"
)

func validateRequest(req *base.Request, destination Destination) error {
	if req == nil || validateURL(req.URL, destination) != nil || len(req.Body) != 0 {
		return ErrPolicy
	}
	switch req.Method {
	case base.Options, base.Describe, base.Setup, base.Play, base.GetParameter, base.Teardown:
	default:
		return ErrPolicy
	}
	for key := range req.Header {
		if strings.EqualFold(key, "Authorization") || strings.EqualFold(key, "Proxy-Authorization") {
			return ErrPolicy
		}
	}
	return nil
}

// newClient installs every policy before Start. It never logs an upstream error.
func newClient(destination Destination, gate *dialGate, state *terminalState) *gortsplib.Client {
	protocol := gortsplib.ProtocolTCP
	return &gortsplib.Client{
		Scheme: "rtsp", Host: destination.Addr.String(),
		Protocol: &protocol, Tunnel: gortsplib.TunnelNone,
		ReadTimeout: operationTimeout, WriteTimeout: operationTimeout,
		WriteQueueSize: 8, UserAgent: "Open3dFarm-RTSP-Ingest/1",
		RequestBackChannels: false, DiscardIncomingRTCP: true, DisableRTCPSenderReports: true,
		ReadLimits: &base.ReadLimits{MaxBodyBytes: 16384}, SDPLimits: sdpLimits(),
		ValidateSDP: func(desc *sdp.SessionDescription) error {
			err := ValidateSDP(desc, destination)
			if err != nil {
				state.stop(ErrPolicy)
			}
			return err
		},
		DialContext:    gate.DialContext,
		ListenPacket:   func(string, string) (net.PacketConn, error) { state.stop(ErrPolicy); return nil, ErrPolicy },
		ResolveIPAddr:  func(string, string) (*net.IPAddr, error) { state.stop(ErrPolicy); return nil, ErrPolicy },
		DialTLSContext: func(context.Context, string, string) (net.Conn, error) { state.stop(ErrPolicy); return nil, ErrPolicy },
		OnRequest: func(req *base.Request) {
			if validateRequest(req, destination) != nil {
				state.stop(ErrPolicy)
			}
		},
		OnResponse: func(res *base.Response) {
			if validateResponse(res, destination) != nil {
				state.stop(ErrPolicy)
			}
		},
		OnServerRequest:   func(*base.Request) { state.stop(ErrPolicy) },
		OnServerResponse:  func(*base.Response) { state.stop(ErrPolicy) },
		OnTransportSwitch: func(error) { state.stop(ErrPolicy) },
		OnPacketsLost:     func(uint64) { state.stop(ErrRTP) },
		OnDecodeError:     func(error) { state.stop(ErrRTP) },
	}
}

// Run consumes one connection for at most cfg.Lease and the caller's context.
// Main must also start its entry timer before reading private configuration.
func Run(parent context.Context, cfg Config, output *os.File, control *os.File) error {
	return run(parent, cfg, output, control, (&net.Dialer{}).DialContext)
}

func run(parent context.Context, cfg Config, output *os.File, control *os.File, dial func(context.Context, string, string) (net.Conn, error)) error {
	entered := time.Now()
	if !validConfig(cfg) {
		return ErrConfig
	}
	if output == nil || control == nil {
		return ErrOutput
	}
	ctx, cancel := context.WithDeadline(parent, entered.Add(cfg.Lease))
	defer cancel()
	deadline, _ := ctx.Deadline()
	state := newTerminalState()
	budget := &WireBudget{state: state}
	gate := &dialGate{destination: cfg.Destination, deadline: deadline, budget: budget, state: state, ctx: ctx, dial: dial}
	pipe := aupipe.New(ctx, output, control)
	client := newClient(cfg.Destination, gate, state)
	watchDone := make(chan struct{})
	go func() {
		defer close(watchDone)
		select {
		case <-ctx.Done():
			if ctx.Err() == context.DeadlineExceeded {
				state.stop(ErrLease)
			} else {
				state.stop(ErrCanceled)
			}
		case <-pipe.Done():
			// Err is observed here even if Offer has not been called yet.
			pipeErr := pipe.Err()
			if ctx.Err() == context.DeadlineExceeded {
				state.stop(ErrLease)
			} else if ctx.Err() != nil || pipeErr == nil {
				state.stop(ErrCanceled)
			} else {
				state.stop(ErrOutput)
			}
		case <-state.done:
		}
		cancel()
	}()
	started := false
	defer func() {
		state.stop(ErrCanceled)
		cancel()
		// Close the socket before the library waits, including on hook failure.
		if started {
			client.Close()
		}
		_ = pipe.Close()
		<-watchDone
	}()
	fail := func() error {
		if err := state.failure(); err != nil {
			return err
		}
		if ctx.Err() == context.DeadlineExceeded {
			return ErrLease
		}
		if ctx.Err() != nil {
			return ErrCanceled
		}
		return ErrSource
	}
	playReady := func() bool {
		if ctx.Err() == context.DeadlineExceeded {
			state.stop(ErrLease)
			return false
		}
		if ctx.Err() != nil {
			state.stop(ErrCanceled)
			return false
		}
		if pipe.Err() != nil {
			state.stop(ErrOutput)
			return false
		}
		select {
		case <-pipe.Done():
			if pipe.Err() != nil {
				state.stop(ErrOutput)
			} else {
				state.stop(ErrCanceled)
			}
			return false
		default:
		}
		return state.failure() == nil
	}
	onRequest := client.OnRequest
	client.OnRequest = func(req *base.Request) {
		if req.Method == base.Play && !playReady() {
			return
		}
		onRequest(req)
	}
	if ctx.Err() != nil {
		return fail()
	}
	if client.Start() != nil {
		return fail()
	}
	started = true
	u := &base.URL{Scheme: "rtsp", Host: cfg.Destination.Addr.String(), Path: cfg.Destination.Path}
	desc, _, err := client.Describe(u)
	if err != nil {
		return fail()
	}
	if state.failure() != nil {
		return fail()
	}
	if desc == nil || validateURL(desc.BaseURL, cfg.Destination) != nil || len(desc.Medias) != 1 || len(desc.Medias[0].Formats) != 1 {
		return ErrPolicy
	}
	media := desc.Medias[0]
	codec, ok := media.Formats[0].(*format.H264)
	if !ok || codec.PacketizationMode != 1 {
		return ErrPolicy
	}
	trackURL, err := media.URL(desc.BaseURL)
	if err != nil || validateURL(trackURL, cfg.Destination) != nil {
		return ErrPolicy
	}
	decoder, err := strictDecoder()
	if err != nil {
		return err
	}
	stream := &streamAdmission{guard: RTPGuard{PayloadType: codec.PayloadTyp}, decoder: decoder}
	if _, err := client.Setup(desc.BaseURL, media, 0, 0); err != nil {
		return fail()
	}
	if state.failure() != nil {
		return fail()
	}
	client.OnPacketRTP(media, codec, func(pkt *rtp.Packet) {
		if state.failure() != nil {
			return
		}
		if err := stream.accept(pkt, pipe.Offer); err != nil {
			state.stop(err)
		}
	})
	if pipe.WaitInitialCredit(ctx) != nil {
		playReady()
		return fail()
	}
	if !playReady() {
		return fail()
	}
	if _, err := client.Play(nil); err != nil {
		return fail()
	}
	_ = client.Wait()
	return fail()
}
