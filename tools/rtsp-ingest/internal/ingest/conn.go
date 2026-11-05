// SPDX-License-Identifier: MIT

package ingest

import (
	"context"
	"net"
	"net/netip"
	"sync"
	"time"
)

const (
	maxInbound       = 16 * 1024 * 1024
	maxOutbound      = 64 * 1024
	maxInboundWindow = 4 * 1024 * 1024
	operationTimeout = 2 * time.Second
)

type terminalState struct {
	mu   sync.Mutex
	err  error
	conn net.Conn
	done chan struct{}
}

func newTerminalState() *terminalState { return &terminalState{done: make(chan struct{})} }

func (s *terminalState) failure() error {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.err
}

// Socket close never waits for Client.Close and is safe from client callbacks.
func (s *terminalState) stop(err error) {
	s.mu.Lock()
	if s.err != nil {
		s.mu.Unlock()
		return
	}
	s.err = err
	conn := s.conn
	close(s.done)
	s.mu.Unlock()
	if conn != nil {
		_ = conn.Close()
	}
}

func (s *terminalState) attach(conn net.Conn) error {
	s.mu.Lock()
	if s.err != nil {
		err := s.err
		s.mu.Unlock()
		_ = conn.Close()
		return err
	}
	s.conn = conn
	s.mu.Unlock()
	return nil
}

// WireBudget counts all connection bytes, including RTSP and discarded RTCP.
// It contains no AU, NAL, fragment, or RTP timestamp state.
type WireBudget struct {
	once        sync.Once
	state       *terminalState
	now         func() time.Time
	readMu      sync.Mutex
	writeMu     sync.Mutex
	inbound     int
	outbound    int
	windowBytes int
	windowStart time.Time
}

type pinnedConn struct {
	net.Conn
	deadline time.Time
	budget   *WireBudget
}

func NewPinnedConn(conn net.Conn, deadline time.Time, budget *WireBudget) net.Conn {
	if budget == nil {
		budget = &WireBudget{}
	}
	budget.once.Do(func() {
		if budget.state == nil {
			budget.state = newTerminalState()
		}
		if budget.now == nil {
			budget.now = time.Now
		}
		budget.windowStart = budget.now()
	})
	return &pinnedConn{Conn: conn, deadline: deadline, budget: budget}
}

func boundedDeadline(requested, lease, now time.Time) time.Time {
	limit := now.Add(operationTimeout)
	if lease.Before(limit) {
		limit = lease
	}
	if !requested.IsZero() && requested.Before(limit) {
		limit = requested
	}
	return limit
}

func (c *pinnedConn) SetReadDeadline(t time.Time) error {
	if c.Conn.SetReadDeadline(boundedDeadline(t, c.deadline, c.budget.now())) != nil {
		return ErrSource
	}
	return nil
}

func (c *pinnedConn) SetWriteDeadline(t time.Time) error {
	if c.Conn.SetWriteDeadline(boundedDeadline(t, c.deadline, c.budget.now())) != nil {
		return ErrSource
	}
	return nil
}

func (c *pinnedConn) SetDeadline(t time.Time) error {
	if err := c.SetReadDeadline(t); err != nil {
		return err
	}
	return c.SetWriteDeadline(t)
}

func (c *pinnedConn) Close() error {
	if c.Conn.Close() != nil {
		return ErrSource
	}
	return nil
}

func (c *pinnedConn) Read(p []byte) (int, error) {
	b := c.budget
	b.readMu.Lock()
	defer b.readMu.Unlock()
	if err := b.state.failure(); err != nil {
		return 0, err
	}
	if len(p) == 0 {
		return 0, nil
	}
	now := b.now()
	if elapsed := now.Sub(b.windowStart); elapsed >= time.Second {
		b.windowStart = b.windowStart.Add((elapsed / time.Second) * time.Second)
		b.windowBytes = 0
	}
	remaining := min(maxInbound-b.inbound, maxInboundWindow-b.windowBytes)
	if remaining <= 0 {
		b.state.stop(ErrWire)
		return 0, ErrWire
	}
	if c.SetReadDeadline(time.Time{}) != nil {
		b.state.stop(ErrSource)
		return 0, ErrSource
	}
	n, err := c.Conn.Read(p[:min(len(p), remaining)])
	b.inbound += n
	b.windowBytes += n
	if err != nil {
		b.state.stop(ErrSource)
		return n, ErrSource
	}
	return n, nil
}

func (c *pinnedConn) Write(p []byte) (int, error) {
	b := c.budget
	b.writeMu.Lock()
	defer b.writeMu.Unlock()
	// The synchronous request hook can reject and close before this guard.
	if err := b.state.failure(); err != nil {
		return 0, err
	}
	if len(p) > maxOutbound-b.outbound {
		b.state.stop(ErrWire)
		return 0, ErrWire
	}
	if c.SetWriteDeadline(time.Time{}) != nil {
		b.state.stop(ErrSource)
		return 0, ErrSource
	}
	n, err := c.Conn.Write(p)
	b.outbound += n
	if err != nil || n != len(p) {
		b.state.stop(ErrSource)
		return n, ErrSource
	}
	return n, nil
}

type dialGate struct {
	mu          sync.Mutex
	used        bool
	destination Destination
	deadline    time.Time
	budget      *WireBudget
	state       *terminalState
	ctx         context.Context
	dial        func(context.Context, string, string) (net.Conn, error)
}

func (g *dialGate) DialContext(ctx context.Context, network, address string) (net.Conn, error) {
	g.mu.Lock()
	addr, err := netip.ParseAddrPort(address)
	if g.used || network != "tcp" || err != nil || addr != g.destination.Addr || g.state.failure() != nil {
		g.mu.Unlock()
		g.state.stop(ErrPolicy)
		return nil, ErrPolicy
	}
	g.used = true
	g.mu.Unlock()
	ctx, cancel := context.WithDeadline(ctx, boundedDeadline(time.Time{}, g.deadline, time.Now()))
	defer cancel()
	if g.ctx != nil {
		stop := context.AfterFunc(g.ctx, cancel)
		defer stop()
		if g.ctx.Err() != nil {
			cancel()
		}
	}
	if ctx.Err() != nil {
		return nil, ErrCanceled
	}
	conn, err := g.dial(ctx, "tcp", g.destination.Addr.String())
	if err != nil {
		g.state.stop(ErrSource)
		return nil, ErrSource
	}
	conn = NewPinnedConn(conn, g.deadline, g.budget)
	if err := g.state.attach(conn); err != nil {
		return nil, err
	}
	return conn, nil
}
