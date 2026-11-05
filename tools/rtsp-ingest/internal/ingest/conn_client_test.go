// SPDX-License-Identifier: MIT

package ingest

import (
	"bufio"
	"bytes"
	"context"
	"io"
	"net"
	"os"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/bluenviron/gortsplib/v5/pkg/base"
)

// memoryConn is an original in-memory transport, never a socket or listener.
// Scripted RTSP uses the upstream request/response codec, not a second parser.
type memoryConn struct {
	mu            sync.Mutex
	cond          *sync.Cond
	in            bytes.Buffer
	out           bytes.Buffer
	closed        bool
	reads         int
	writes        int
	readDeadline  time.Time
	writeDeadline time.Time
	respond       func(*base.Request) *base.Response
}

func newMemoryConn() *memoryConn {
	c := &memoryConn{}
	c.cond = sync.NewCond(&c.mu)
	return c
}

func (c *memoryConn) Read(p []byte) (int, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.reads++
	for c.in.Len() == 0 && !c.closed {
		c.cond.Wait()
	}
	if c.closed {
		return 0, io.EOF
	}
	return c.in.Read(p)
}

func (c *memoryConn) Write(p []byte) (int, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.closed {
		return 0, io.ErrClosedPipe
	}
	c.writes++
	_, _ = c.out.Write(p)
	if c.respond != nil {
		var request base.Request
		if err := request.Unmarshal(bufio.NewReader(bytes.NewReader(p))); err != nil {
			return 0, err
		}
		response := c.respond(&request)
		if response.Header == nil {
			response.Header = make(base.Header)
		}
		response.Header["CSeq"] = request.Header["CSeq"]
		wire, err := response.Marshal()
		if err != nil {
			return 0, err
		}
		_, _ = c.in.Write(wire)
		c.cond.Broadcast()
	}
	return len(p), nil
}

func (c *memoryConn) Close() error {
	c.mu.Lock()
	c.closed = true
	c.cond.Broadcast()
	c.mu.Unlock()
	return nil
}

func (c *memoryConn) LocalAddr() net.Addr                { return &net.TCPAddr{} }
func (c *memoryConn) RemoteAddr() net.Addr               { return &net.TCPAddr{} }
func (c *memoryConn) SetReadDeadline(t time.Time) error  { c.readDeadline = t; return nil }
func (c *memoryConn) SetWriteDeadline(t time.Time) error { c.writeDeadline = t; return nil }
func (c *memoryConn) SetDeadline(t time.Time) error {
	c.readDeadline, c.writeDeadline = t, t
	return nil
}

func TestWireBoundsAndWindowRollover(t *testing.T) {
	now := time.Now()
	raw := newMemoryConn()
	_, _ = raw.in.Write(bytes.Repeat([]byte{1}, 32))
	state := newTerminalState()
	budget := &WireBudget{state: state, now: func() time.Time { return now }}
	c := NewPinnedConn(raw, now.Add(30*time.Second), budget)
	if state.attach(c) != nil {
		t.Fatal("attach")
	}
	budget.inbound, budget.windowBytes = maxInbound-3, maxInboundWindow-2
	buffer := make([]byte, 32)
	if n, err := c.Read(buffer); n != 2 || err != nil {
		t.Fatalf("clamped read: %d %v", n, err)
	}
	now = now.Add(time.Second)
	if n, err := c.Read(buffer); n != 1 || err != nil {
		t.Fatalf("window rollover: %d %v", n, err)
	}
	before := raw.reads
	if _, err := c.Read(buffer); err != ErrWire || raw.reads != before {
		t.Fatal("total budget allowed another read")
	}
	if _, err := c.Write([]byte{1}); err != ErrWire || raw.writes != 0 {
		t.Fatal("terminal connection wrote")
	}

	raw = newMemoryConn()
	budget = &WireBudget{}
	c = NewPinnedConn(raw, time.Now().Add(30*time.Second), budget)
	budget.outbound = maxOutbound - 1
	if n, err := c.Write([]byte{1}); n != 1 || err != nil {
		t.Fatal("exact outbound bound")
	}
	if _, err := c.Write([]byte{2}); err != ErrWire || raw.writes != 1 {
		t.Fatal("outbound cap bypass")
	}

	raw = newMemoryConn()
	budget = &WireBudget{}
	c = NewPinnedConn(raw, time.Now().Add(30*time.Second), budget)
	budget.windowBytes = maxInboundWindow
	if _, err := c.Read(buffer); err != ErrWire || raw.reads != 0 {
		t.Fatal("window cap bypass")
	}
}

func TestDeadlineCannotExtendLeaseOrOperation(t *testing.T) {
	now := time.Now()
	for _, tc := range []struct{ requested, lease, want time.Time }{
		{time.Time{}, now.Add(30 * time.Second), now.Add(2 * time.Second)},
		{now.Add(time.Hour), now.Add(time.Second), now.Add(time.Second)},
		{now.Add(time.Millisecond), now.Add(time.Second), now.Add(time.Millisecond)},
	} {
		if got := boundedDeadline(tc.requested, tc.lease, now); !got.Equal(tc.want) {
			t.Fatal("deadline escaped bound")
		}
	}
	raw := newMemoryConn()
	budget := &WireBudget{now: func() time.Time { return now }}
	c := NewPinnedConn(raw, now.Add(time.Second), budget)
	if c.SetDeadline(time.Time{}) != nil || raw.readDeadline != now.Add(time.Second) || raw.writeDeadline != now.Add(time.Second) {
		t.Fatal("zero deadline removed lease cap")
	}
}

func TestDialIsSingleLiteralAttempt(t *testing.T) {
	for _, wrong := range []struct{ network, address string }{{"udp", "127.0.0.1:8554"}, {"tcp", "fixture.invalid:8554"}, {"tcp", "192.0.2.1:8554"}} {
		state := newTerminalState()
		calls := 0
		gate := dialGate{destination: fixtureDestination(), deadline: time.Now().Add(time.Second), state: state, budget: &WireBudget{state: state}, dial: func(context.Context, string, string) (net.Conn, error) { calls++; return newMemoryConn(), nil }}
		if _, err := gate.DialContext(context.Background(), wrong.network, wrong.address); err != ErrPolicy || calls != 0 {
			t.Fatal("forbidden dial reached transport")
		}
	}
	state := newTerminalState()
	calls := 0
	gate := dialGate{destination: fixtureDestination(), deadline: time.Now().Add(time.Second), state: state, budget: &WireBudget{state: state}, dial: func(context.Context, string, string) (net.Conn, error) { calls++; return newMemoryConn(), nil }}
	if _, err := gate.DialContext(context.Background(), "tcp", "127.0.0.1:8554"); err != nil {
		t.Fatal(err)
	}
	if _, err := gate.DialContext(context.Background(), "tcp", "127.0.0.1:8554"); err != ErrPolicy || calls != 1 {
		t.Fatal("second dial reached transport")
	}
	state = newTerminalState()
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	gate = dialGate{destination: fixtureDestination(), deadline: time.Now().Add(time.Second), ctx: ctx, state: state, budget: &WireBudget{state: state}, dial: func(context.Context, string, string) (net.Conn, error) {
		t.Fatal("canceled dial reached transport")
		return nil, ErrSource
	}}
	if _, err := gate.DialContext(context.Background(), "tcp", "127.0.0.1:8554"); err != ErrCanceled {
		t.Fatal("cancellation lost")
	}
}

func TestRequestHookRejectsBeforeAnyWrite(t *testing.T) {
	state := newTerminalState()
	raw := newMemoryConn()
	dials := 0
	gate := &dialGate{destination: fixtureDestination(), deadline: time.Now().Add(time.Second), state: state, budget: &WireBudget{state: state}, dial: func(context.Context, string, string) (net.Conn, error) { dials++; return raw, nil }}
	client := newClient(fixtureDestination(), gate, state)
	hook := client.OnRequest
	client.OnRequest = func(req *base.Request) {
		req.URL.Host = "192.0.2.1:8554"
		hook(req)
	}
	if err := client.Start(); err != nil {
		t.Fatal(err)
	}
	defer func() { state.stop(ErrCanceled); client.Close() }()
	u, _ := base.ParseURL("rtsp://127.0.0.1:8554/fixture")
	if _, _, err := client.Describe(u); err == nil || dials != 1 || raw.writes != 0 || state.failure() != ErrPolicy {
		t.Fatal("request hook failed to block original client write")
	}
}

func TestClientHooksAgainstUpstreamRequestLifecycle(t *testing.T) {
	for _, tc := range []struct {
		name    string
		status  base.StatusCode
		headers base.Header
		body    []byte
		wantOK  bool
	}{
		{"valid", 200, base.Header{"Content-Type": {"application/sdp"}}, []byte(fixtureSDP), true},
		{"redirect", 302, base.Header{"Location": {"rtsp://192.0.2.1:8554/other"}}, nil, false},
		{"auth", 401, base.Header{"WWW-Authenticate": {"Basic realm=fixture"}}, nil, false},
		{"proxy-auth", 407, nil, nil, false},
		{"base", 200, base.Header{"Content-Type": {"application/sdp"}, "Content-Base": {"rtsp://192.0.2.1:8554/other"}}, []byte(fixtureSDP), false},
		{"location", 200, base.Header{"Content-Type": {"application/sdp"}, "Content-Location": {"rtsp://192.0.2.1:8554/other"}}, []byte(fixtureSDP), false},
		{"control", 200, base.Header{"Content-Type": {"application/sdp"}}, []byte(strings.Replace(fixtureSDP, "trackID=0", "rtsp://192.0.2.1:8554/track", 1)), false},
		{"profile", 200, base.Header{"Content-Type": {"application/sdp"}}, []byte(strings.Replace(fixtureSDP, "H264/90000", "H265/90000", 1)), false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			raw := newMemoryConn()
			requests := 0
			var methods []base.Method
			raw.respond = func(req *base.Request) *base.Response {
				requests++
				methods = append(methods, req.Method)
				if req.Method == base.Options {
					return &base.Response{StatusCode: 200}
				}
				return &base.Response{StatusCode: tc.status, Header: tc.headers, Body: tc.body}
			}
			if !tc.wantOK {
				outputR, outputW, err := os.Pipe()
				if err != nil {
					t.Fatal(err)
				}
				defer outputR.Close()
				defer outputW.Close()
				controlR, controlW, err := os.Pipe()
				if err != nil {
					t.Fatal(err)
				}
				defer controlR.Close()
				defer controlW.Close()
				dials := 0
				err = run(context.Background(), Config{Destination: fixtureDestination(), Lease: time.Second}, outputW, controlR, func(context.Context, string, string) (net.Conn, error) {
					dials++
					return raw, nil
				})
				if err != ErrPolicy || dials != 1 || requests != 2 || raw.writes != 2 || methods[0] != base.Options || methods[1] != base.Describe {
					t.Fatalf("rejected lifecycle: error %v, dials %d, requests %d, writes %d, methods %v", err, dials, requests, raw.writes, methods)
				}
				return
			}
			state := newTerminalState()
			dials := 0
			gate := &dialGate{destination: fixtureDestination(), deadline: time.Now().Add(time.Second), state: state, budget: &WireBudget{state: state}, dial: func(context.Context, string, string) (net.Conn, error) { dials++; return raw, nil }}
			client := newClient(fixtureDestination(), gate, state)
			if err := client.Start(); err != nil {
				t.Fatal(err)
			}
			defer func() { state.stop(ErrCanceled); client.Close() }()
			u, _ := base.ParseURL("rtsp://127.0.0.1:8554/fixture")
			_, _, err := client.Describe(u)
			if err != nil || dials != 1 || requests != 2 {
				t.Fatalf("lifecycle: error %v, dials %d, requests %d", err != nil, dials, requests)
			}
		})
	}
}

func TestRunAsyncControlFailureClosesSocketWithoutOffer(t *testing.T) {
	outputR, outputW, err := os.Pipe()
	if err != nil {
		t.Fatal(err)
	}
	defer outputR.Close()
	defer outputW.Close()
	controlR, controlW, err := os.Pipe()
	if err != nil {
		t.Fatal(err)
	}
	defer controlR.Close()
	defer controlW.Close()
	raw := newMemoryConn()
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	dials := 0
	err = run(ctx, Config{Destination: fixtureDestination(), Lease: time.Second}, outputW, controlR, func(context.Context, string, string) (net.Conn, error) {
		dials++
		// No RTP or Offer call. Control EOF must independently cancel ingress.
		_ = controlW.Close()
		return raw, nil
	})
	if err != ErrOutput || dials != 1 || !raw.closed {
		t.Fatalf("async pipe failure: %v, dials %d, closed %v", err, dials, raw.closed)
	}
}

func TestRunCanceledBeforeDialAndLeaseClosesBlockedRead(t *testing.T) {
	for _, cancelFirst := range []bool{true, false} {
		outputR, outputW, err := os.Pipe()
		if err != nil {
			t.Fatal(err)
		}
		controlR, controlW, err := os.Pipe()
		if err != nil {
			outputR.Close()
			outputW.Close()
			t.Fatal(err)
		}
		ctx, cancel := context.WithCancel(context.Background())
		if cancelFirst {
			cancel()
		}
		raw := newMemoryConn()
		dials := 0
		err = run(ctx, Config{Destination: fixtureDestination(), Lease: time.Second}, outputW, controlR, func(context.Context, string, string) (net.Conn, error) { dials++; return raw, nil })
		cancel()
		_ = outputR.Close()
		_ = outputW.Close()
		_ = controlR.Close()
		_ = controlW.Close()
		if cancelFirst {
			if err != ErrCanceled || dials != 0 {
				t.Fatal("pre-canceled run dialed")
			}
		} else if err != ErrLease || dials != 1 || !raw.closed {
			t.Fatal("lease did not close blocked reader")
		}
	}
}

func TestRunPlayRequiresInitialCredit(t *testing.T) {
	for _, mode := range []string{"abort", "terminal", "credit and abort", "credit"} {
		t.Run(mode, func(t *testing.T) {
			outputR, outputW, err := os.Pipe()
			if err != nil {
				t.Fatal(err)
			}
			defer outputR.Close()
			defer outputW.Close()
			controlR, controlW, err := os.Pipe()
			if err != nil {
				t.Fatal(err)
			}
			defer controlR.Close()
			defer controlW.Close()
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			setup := make(chan struct{})
			played := make(chan struct{}, 1)
			raw := newMemoryConn()
			raw.respond = func(req *base.Request) *base.Response {
				switch req.Method {
				case base.Describe:
					return &base.Response{StatusCode: 200, Header: base.Header{"Content-Type": {"application/sdp"}}, Body: []byte(fixtureSDP)}
				case base.Setup:
					if mode == "credit and abort" {
						_, _ = controlW.Write([]byte{1})
						cancel()
					}
					close(setup)
					return &base.Response{StatusCode: 200, Header: base.Header{"Session": {"fixture"}, "Transport": {"RTP/AVP/TCP;unicast;interleaved=0-1"}}}
				case base.Play:
					played <- struct{}{}
					cancel()
				}
				return &base.Response{StatusCode: 200}
			}
			done := make(chan error, 1)
			go func() {
				done <- run(ctx, Config{Destination: fixtureDestination(), Lease: 2 * time.Second}, outputW, controlR, func(context.Context, string, string) (net.Conn, error) { return raw, nil })
			}()
			select {
			case <-setup:
			case err := <-done:
				t.Fatalf("run ended before SETUP: %v", err)
			case <-time.After(time.Second):
				t.Fatal("SETUP not reached")
			}
			switch mode {
			case "abort":
				cancel()
			case "terminal":
				_ = controlW.Close()
			case "credit":
				if _, err := controlW.Write([]byte{1}); err != nil {
					t.Fatal(err)
				}
			}
			select {
			case err := <-done:
				want := ErrCanceled
				if mode == "terminal" {
					want = ErrOutput
				}
				if err != want {
					t.Fatalf("run error: %v, want %v", err, want)
				}
			case <-time.After(3 * time.Second):
				t.Fatal("run did not finish")
			}
			select {
			case <-played:
				if mode != "credit" {
					t.Fatal("PLAY sent after abort")
				}
			default:
				if mode == "credit" {
					t.Fatal("PLAY not sent after credit")
				}
			}
		})
	}
}
