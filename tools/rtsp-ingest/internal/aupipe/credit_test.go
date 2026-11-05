package aupipe

import (
	"bytes"
	"context"
	"os"
	"runtime"
	"testing"
	"time"
)

func newTestPipe(t *testing.T) (*Pipe, *os.File, *os.File) {
	t.Helper()
	outRead, outWrite, err := os.Pipe()
	if err != nil {
		t.Fatal(err)
	}
	controlRead, controlWrite, err := os.Pipe()
	if err != nil {
		t.Fatal(err)
	}
	p := New(context.Background(), outWrite, controlRead)
	t.Cleanup(func() { _ = p.Close(); _ = outRead.Close(); _ = controlWrite.Close() })
	return p, outRead, controlWrite
}

func waitFor(t *testing.T, predicate func() bool) {
	t.Helper()
	deadline := time.Now().Add(time.Second)
	for !predicate() {
		if time.Now().After(deadline) {
			t.Fatal("timed out")
		}
		runtime.Gosched()
	}
}

func grant(t *testing.T, p *Pipe, control *os.File) {
	t.Helper()
	if _, err := control.Write([]byte{1}); err != nil {
		t.Fatal(err)
	}
	waitFor(t, func() bool { p.mu.Lock(); defer p.mu.Unlock(); return p.credit })
}

func TestCopyAndRecord(t *testing.T) {
	p, output, control := newTestPipe(t)
	grant(t, p, control)
	nalu := []byte{0x65, 2, 3}
	if err := p.Offer(0, true, [][]byte{nalu}); err != nil {
		t.Fatal(err)
	}
	nalu[1] = 9
	r, err := ReadRecord(output)
	if err != nil || !r.Keyframe || r.TimestampUs != 0 || !bytes.Equal(r.AnnexB, []byte{0, 0, 0, 1, 0x65, 2, 3}) {
		t.Fatalf("record: %#v %v", r, err)
	}
}

func TestPressureAndControl(t *testing.T) {
	t.Run("no credit", func(t *testing.T) {
		p, _, _ := newTestPipe(t)
		if p.Offer(0, false, [][]byte{{1}}) != ErrInvalid {
			t.Fatal("accepted without credit")
		}
		<-p.Done()
		if p.Err() != ErrInvalid {
			t.Fatal("missing terminal error")
		}
	})
	t.Run("occupied", func(t *testing.T) {
		p, _, control := newTestPipe(t)
		grant(t, p, control)
		if err := p.Offer(0, false, [][]byte{make([]byte, maxAU-4)}); err != nil {
			t.Fatal(err)
		}
		grant(t, p, control)
		if p.Offer(1, false, [][]byte{{1}}) != ErrInvalid {
			t.Fatal("accepted occupied slot")
		}
	})
	for _, credits := range [][]byte{{2}, {1, 1}} {
		t.Run(string(credits), func(t *testing.T) {
			p, _, control := newTestPipe(t)
			if _, err := control.Write(credits); err != nil {
				t.Fatal(err)
			}
			select {
			case <-p.Done():
			case <-time.After(time.Second):
				t.Fatal("control did not terminate")
			}
			if p.Err() != ErrInvalid {
				t.Fatal("missing control error")
			}
		})
	}
	t.Run("eof", func(t *testing.T) {
		p, _, control := newTestPipe(t)
		_ = control.Close()
		select {
		case <-p.Done():
		case <-time.After(time.Second):
			t.Fatal("EOF did not terminate")
		}
	})
}

func TestAdmissionLimits(t *testing.T) {
	for name, setup := range map[string]func(*Pipe) (uint64, [][]byte){
		"timestamp": func(*Pipe) (uint64, [][]byte) { return maxTimestamp + 1, [][]byte{{1}} },
		"order":     func(p *Pipe) (uint64, [][]byte) { p.haveTimestamp = true; p.timestamp = 1; return 1, [][]byte{{1}} },
		"empty":     func(*Pipe) (uint64, [][]byte) { return 0, [][]byte{{}} },
		"count":     func(*Pipe) (uint64, [][]byte) { return 0, make([][]byte, 51) },
		"size":      func(*Pipe) (uint64, [][]byte) { return 0, [][]byte{make([]byte, maxAU-3)} },
		"rate":      func(p *Pipe) (uint64, [][]byte) { p.window = time.Now(); p.windowAUs = 30; return 0, [][]byte{{1}} },
		"bytes": func(p *Pipe) (uint64, [][]byte) {
			p.window = time.Now()
			p.windowBytes = 1048576
			return 0, [][]byte{{1}}
		},
		"lease": func(p *Pipe) (uint64, [][]byte) { p.leaseBytes = 16777216; return 0, [][]byte{{1}} },
	} {
		t.Run(name, func(t *testing.T) {
			p, _, control := newTestPipe(t)
			grant(t, p, control)
			p.mu.Lock()
			ts, nalus := setup(p)
			p.mu.Unlock()
			if p.Offer(ts, false, nalus) != ErrInvalid {
				t.Fatal("accepted invalid AU")
			}
		})
	}
}

func TestCloseUnblocksWriter(t *testing.T) {
	p, _, control := newTestPipe(t)
	grant(t, p, control)
	if err := p.Offer(0, false, [][]byte{make([]byte, maxAU-4)}); err != nil {
		t.Fatal(err)
	}
	closed := make(chan struct{})
	go func() { _ = p.Close(); _ = p.Close(); close(closed) }()
	select {
	case <-closed:
	case <-time.After(time.Second):
		t.Fatal("Close blocked")
	}
}

func TestOutputFailureCancels(t *testing.T) {
	p, output, control := newTestPipe(t)
	_ = output.Close()
	grant(t, p, control)
	if err := p.Offer(0, false, [][]byte{{1}}); err != nil {
		t.Fatal(err)
	}
	select {
	case <-p.Done():
	case <-time.After(time.Second):
		t.Fatal("output failure did not terminate")
	}
	if p.Err() != ErrInvalid {
		t.Fatal("missing output error")
	}
}

func TestWaitInitialCreditAdmissionAndLatch(t *testing.T) {
	p, _, control := newTestPipe(t)
	p.mu.Lock()
	if _, err := control.Write([]byte{1}); err != nil {
		p.mu.Unlock()
		t.Fatal(err)
	}
	select {
	case <-p.firstCredit:
		p.mu.Unlock()
		t.Fatal("write alone signaled acceptance")
	default:
	}
	p.mu.Unlock()
	if err := p.WaitInitialCredit(context.Background()); err != nil {
		t.Fatal(err)
	}
	if err := p.Offer(0, false, [][]byte{{1}}); err != nil {
		t.Fatal(err)
	}
	if err := p.WaitInitialCredit(context.Background()); err != nil {
		t.Fatal("consumed credit lost latch:", err)
	}
}

func TestWaitInitialCreditCancellationAndTerminal(t *testing.T) {
	t.Run("canceled before credit", func(t *testing.T) {
		p, _, _ := newTestPipe(t)
		ctx, cancel := context.WithCancel(context.Background())
		cancel()
		if p.WaitInitialCredit(ctx) != context.Canceled {
			t.Fatal("cancellation lost")
		}
	})
	t.Run("canceled with credit", func(t *testing.T) {
		p, _, control := newTestPipe(t)
		ctx, cancel := context.WithCancel(context.Background())
		p.mu.Lock()
		if _, err := control.Write([]byte{1}); err != nil {
			p.mu.Unlock()
			t.Fatal(err)
		}
		cancel()
		p.mu.Unlock()
		<-p.firstCredit
		if p.WaitInitialCredit(ctx) != context.Canceled {
			t.Fatal("simultaneous cancellation lost")
		}
	})
	for _, afterCredit := range []bool{false, true} {
		t.Run(map[bool]string{false: "terminal before credit", true: "terminal after credit"}[afterCredit], func(t *testing.T) {
			p, _, control := newTestPipe(t)
			if afterCredit {
				grant(t, p, control)
			}
			if err := p.Close(); err != nil {
				t.Fatal(err)
			}
			if p.WaitInitialCredit(context.Background()) != ErrInvalid {
				t.Fatal("terminal pipe accepted")
			}
		})
	}
}
