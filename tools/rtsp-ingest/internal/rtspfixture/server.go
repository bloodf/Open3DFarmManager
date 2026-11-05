// SPDX-License-Identifier: MIT

package rtspfixture

import (
	"context"
	"errors"
	"net"
	"net/netip"
	"sync"
	"sync/atomic"
	"time"

	"github.com/bluenviron/gortsplib/v5"
	"github.com/bluenviron/gortsplib/v5/pkg/base"
	"github.com/bluenviron/gortsplib/v5/pkg/description"
	"github.com/bluenviron/gortsplib/v5/pkg/format"
	"github.com/bluenviron/gortsplib/v5/pkg/format/rtph264"
	"github.com/bluenviron/gortsplib/v5/pkg/headers"
)

const wireLimit = 2 << 20
const payloadLimit = 1200

var errFixture = errors.New("RTSP_FIXTURE_FAILURE")

type Fixture struct {
	server          *gortsplib.Server
	stream          *gortsplib.ServerStream
	media           *description.Media
	address         netip.AddrPort
	encoder         rtph264.Encoder
	played          chan struct{}
	responseWritten chan struct{}
	sentAU          bool
	closed          chan struct{}
	cancel          context.CancelFunc
	closeOnce       sync.Once
	sendMu          sync.Mutex
	mu              sync.Mutex
	conn            *gortsplib.ServerConn
	session         *gortsplib.ServerSession
	playPending     bool
	playAccepted    bool
	playedOnce      bool
	failed          atomic.Bool
}

func newDescription() (*description.Session, *description.Media) {
	media := &description.Media{Type: description.MediaTypeVideo, Profile: headers.TransportProfileAVP,
		Control: "trackID=0", Formats: []format.Format{&format.H264{PayloadTyp: 96, PacketizationMode: 1}}}
	return &description.Session{Title: "fixture", Medias: []*description.Media{media}}, media
}

// Start owns one TCP4 loopback listener and shuts it down within five seconds.
func Start(parent context.Context) (*Fixture, error) {
	if parent == nil || parent.Err() != nil {
		return nil, errFixture
	}
	ctx, cancel := context.WithTimeout(parent, 5*time.Second)
	f := &Fixture{played: make(chan struct{}), responseWritten: make(chan struct{}), closed: make(chan struct{}), cancel: cancel}
	desc, media := newDescription()
	f.media = media
	ssrc, seq := uint32(0x12345678), uint16(1000)
	f.encoder = rtph264.Encoder{PayloadType: 96, SSRC: &ssrc, InitialSequenceNumber: &seq, PayloadMaxSize: payloadLimit, PacketizationMode: 1}
	if f.encoder.Init() != nil {
		cancel()
		return nil, errFixture
	}
	ready := make(chan struct{})
	deadline, _ := ctx.Deadline()
	f.server = &gortsplib.Server{RTSPAddress: "127.0.0.1:0", Handler: f, WriteQueueSize: 16,
		ReadTimeout: 5 * time.Second, WriteTimeout: 5 * time.Second, IdleTimeout: 5 * time.Second,
		DisableRTCPSenderReports: true,
		Listen: func(network, address string) (net.Listener, error) {
			if network != "tcp" || address != "127.0.0.1:0" {
				return nil, errFixture
			}
			ln, err := net.Listen("tcp4", address)
			if err != nil {
				return nil, errFixture
			}
			addr, ok := ln.Addr().(*net.TCPAddr)
			if !ok {
				ln.Close()
				return nil, errFixture
			}
			f.address = addr.AddrPort()
			return &oneListener{Listener: ln, ready: ready, deadline: deadline, responseWritten: f.responseWritten}, nil
		},
		ListenPacket: func(string, string) (net.PacketConn, error) { return nil, errFixture },
	}
	if f.server.Start() != nil {
		cancel()
		return nil, errFixture
	}
	f.stream = &gortsplib.ServerStream{Server: f.server, Desc: desc}
	if f.stream.Initialize() != nil {
		close(ready)
		f.server.Close()
		cancel()
		return nil, errFixture
	}
	close(ready)
	go func() {
		select {
		case <-ctx.Done():
			f.Close()
		case <-f.closed:
		}
	}()
	return f, nil
}

func (f *Fixture) Address() netip.AddrPort { return f.address }
func (f *Fixture) Played() <-chan struct{} { return f.played }
func (f *Fixture) Closed() <-chan struct{} { return f.closed }

// SendAU accepts at most eight packets per call and requires a successful PLAY.
func (f *Fixture) SendAU(timestamp90k uint32, nalus [][]byte) error {
	f.sendMu.Lock()
	defer f.sendMu.Unlock()
	select {
	case <-f.played:
	default:
		return errFixture
	}
	select {
	case <-f.closed:
		return errFixture
	default:
	}
	if f.failed.Load() || len(nalus) == 0 || len(nalus) > 8 {
		return errFixture
	}
	if f.sentAU {
		select {
		case <-f.responseWritten:
		default:
			return errFixture
		}
	}
	packets := 0
	for _, nalu := range nalus {
		if len(nalu) == 0 || len(nalu) > 8*(payloadLimit-2) {
			return errFixture
		}
		packets += (len(nalu) + payloadLimit - 3) / (payloadLimit - 2)
		if packets > 8 {
			return errFixture
		}
	}
	f.sentAU = true
	encoded, err := f.encoder.Encode(nalus)
	if err != nil || len(encoded) == 0 || len(encoded) > 8 {
		f.fail()
		return errFixture
	}
	for _, pkt := range encoded {
		pkt.Timestamp = timestamp90k
		if f.stream.WritePacketRTP(f.media, pkt) != nil || f.failed.Load() {
			f.fail()
			return errFixture
		}
	}
	return nil
}

func (f *Fixture) Close() error {
	f.closeOnce.Do(func() {
		f.cancel()
		f.stream.Close()
		f.server.Close()
		close(f.closed)
	})
	return nil
}

func (f *Fixture) fail() {
	if f.failed.CompareAndSwap(false, true) {
		go f.Close()
	}
}

func (f *Fixture) OnConnOpen(c *gortsplib.ServerHandlerOnConnOpenCtx) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.conn != nil {
		c.Conn.Close()
		return
	}
	f.conn = c.Conn
}
func (f *Fixture) OnSessionOpen(c *gortsplib.ServerHandlerOnSessionOpenCtx) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.session != nil || c.Conn != f.conn {
		c.Session.Close()
		return
	}
	f.session = c.Session
}
func (f *Fixture) OnRequest(c *gortsplib.ServerConn, r *base.Request) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.playPending = c == f.conn && r.Method == base.Play
	f.playAccepted = false
}
func (f *Fixture) OnResponse(c *gortsplib.ServerConn, r *base.Response) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if c == f.conn && f.playPending && f.playAccepted && r.StatusCode == base.StatusOK && !f.playedOnce {
		conn, ok := c.NetConn().(*budgetConn)
		if !ok {
			f.fail()
			return
		}
		conn.playResponse.Store(true)
		f.playedOnce = true
		close(f.played)
	}
	f.playPending = false
}
func (f *Fixture) OnDescribe(c *gortsplib.ServerHandlerOnDescribeCtx) (*base.Response, *gortsplib.ServerStream, error) {
	if c.Conn != f.conn || c.Path != "fixture" || c.Query != "" {
		return &base.Response{StatusCode: base.StatusNotFound}, nil, nil
	}
	return &base.Response{StatusCode: base.StatusOK}, f.stream, nil
}
func (f *Fixture) OnSetup(c *gortsplib.ServerHandlerOnSetupCtx) (*base.Response, *gortsplib.ServerStream, error) {
	f.mu.Lock()
	valid := c.Conn == f.conn && c.Session == f.session
	f.mu.Unlock()
	if !valid || c.Path != "fixture" || c.Query != "" || c.Transport.Protocol != gortsplib.ProtocolTCP || c.Transport.Profile != headers.TransportProfileAVP {
		return &base.Response{StatusCode: base.StatusUnsupportedTransport}, nil, nil
	}
	return &base.Response{StatusCode: base.StatusOK}, f.stream, nil
}
func (f *Fixture) OnPlay(c *gortsplib.ServerHandlerOnPlayCtx) (*base.Response, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if c.Conn != f.conn || c.Session != f.session || c.Path != "fixture" || c.Query != "" || f.playedOnce {
		return &base.Response{StatusCode: base.StatusBadRequest}, nil
	}
	f.playAccepted = true
	return &base.Response{StatusCode: base.StatusOK}, nil
}
func (f *Fixture) OnStreamWriteError(*gortsplib.ServerHandlerOnStreamWriteErrorCtx) { f.fail() }
func (f *Fixture) OnPacketsLost(*gortsplib.ServerHandlerOnPacketsLostCtx)           { f.fail() }
func (f *Fixture) OnDecodeError(*gortsplib.ServerHandlerOnDecodeErrorCtx)           { f.fail() }

// oneListener admits one connection for the lifetime of the fixture.
type oneListener struct {
	net.Listener
	ready           <-chan struct{}
	deadline        time.Time
	accepted        bool
	responseWritten chan struct{}
}

func (l *oneListener) Accept() (net.Conn, error) {
	<-l.ready
	for {
		c, err := l.Listener.Accept()
		if err != nil {
			return nil, err
		}
		if l.accepted {
			c.Close()
			continue
		}
		l.accepted = true
		return &budgetConn{Conn: c, deadline: l.deadline, responseWritten: l.responseWritten}, nil
	}
}

type budgetConn struct {
	net.Conn
	deadline        time.Time
	used            atomic.Int64
	playResponse    atomic.Bool
	responseWritten chan struct{}
}

func (c *budgetConn) reserve(n int) bool {
	for {
		used := c.used.Load()
		if int64(n) > wireLimit-used {
			c.Conn.Close()
			return false
		}
		if c.used.CompareAndSwap(used, used+int64(n)) {
			return true
		}
	}
}
func (c *budgetConn) Read(p []byte) (int, error) {
	if !c.reserve(len(p)) {
		return 0, errFixture
	}
	n, err := c.Conn.Read(p)
	c.used.Add(-int64(len(p) - n))
	return n, err
}
func (c *budgetConn) Write(p []byte) (int, error) {
	if !c.reserve(len(p)) {
		return 0, errFixture
	}
	n, err := c.Conn.Write(p)
	c.used.Add(-int64(len(p) - n))
	if err == nil && n == len(p) && c.playResponse.CompareAndSwap(true, false) {
		close(c.responseWritten)
	}
	return n, err
}
func (c *budgetConn) limit(t time.Time) time.Time {
	if t.IsZero() || t.After(c.deadline) {
		return c.deadline
	}
	return t
}
func (c *budgetConn) SetDeadline(t time.Time) error      { return c.Conn.SetDeadline(c.limit(t)) }
func (c *budgetConn) SetReadDeadline(t time.Time) error  { return c.Conn.SetReadDeadline(c.limit(t)) }
func (c *budgetConn) SetWriteDeadline(t time.Time) error { return c.Conn.SetWriteDeadline(c.limit(t)) }
