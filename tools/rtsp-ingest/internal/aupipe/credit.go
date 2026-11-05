package aupipe

import (
	"context"
	"encoding/binary"
	"os"
	"sync"
	"time"
)

// Pipe owns output and control until Close returns. Done closes on any terminal event.
type Pipe struct {
	output        *os.File
	control       *os.File
	mu            sync.Mutex
	credit        bool
	initialCredit bool
	occupied      bool
	failed        bool
	haveTimestamp bool
	timestamp     uint64
	window        time.Time
	windowAUs     int
	windowBytes   int
	leaseBytes    int
	stop          chan struct{}
	firstCredit   chan struct{}
	slot          chan []byte
	once          sync.Once
	wg            sync.WaitGroup
}

func New(ctx context.Context, output *os.File, control *os.File) *Pipe {
	p := &Pipe{output: output, control: control, stop: make(chan struct{}), firstCredit: make(chan struct{}), slot: make(chan []byte, 1)}
	p.wg.Add(3)
	go p.readControl()
	go p.writeOutput()
	go func() {
		defer p.wg.Done()
		select {
		case <-ctx.Done():
			p.shutdown(true)
		case <-p.stop:
		}
	}()
	return p
}

func (p *Pipe) shutdown(failed bool) {
	p.once.Do(func() {
		p.mu.Lock()
		p.failed = p.failed || failed
		close(p.stop)
		p.mu.Unlock()
		_ = p.control.Close()
		_ = p.output.Close()
	})
}

func (p *Pipe) readControl() {
	defer p.wg.Done()
	var b [1]byte
	for {
		n, err := p.control.Read(b[:])
		if n != 1 || err != nil {
			p.shutdown(true)
			return
		}
		p.mu.Lock()
		invalid := b[0] != 1 || p.credit
		if !invalid {
			p.credit = true
			if !p.initialCredit {
				p.initialCredit = true
				close(p.firstCredit)
			}
		} else {
			p.failed = true
		}
		p.mu.Unlock()
		if invalid {
			p.shutdown(true)
			return
		}
	}
}

func (p *Pipe) writeOutput() {
	defer p.wg.Done()
	for {
		select {
		case <-p.stop:
			return
		case data := <-p.slot:
			if writeAll(p.output, data) != nil {
				p.shutdown(true)
				return
			}
			p.mu.Lock()
			p.occupied = false
			p.mu.Unlock()
		}
	}
}

// Offer validates before consuming credit and copying into the single owned slot.
// Any violation terminates the pipe; it never waits for the output descriptor.
func (p *Pipe) Offer(timestampUs uint64, keyframe bool, nalus [][]byte) error {
	p.mu.Lock()
	select {
	case <-p.stop:
		p.mu.Unlock()
		return ErrInvalid
	default:
	}
	if p.failed {
		p.mu.Unlock()
		return ErrInvalid
	}
	bad := timestampUs > maxTimestamp || (p.haveTimestamp && timestampUs <= p.timestamp) || len(nalus) == 0 || len(nalus) > 50
	size := 0
	for i, nalu := range nalus {
		if i >= 50 {
			break
		}
		if len(nalu) == 0 || len(nalu) > maxAU-4-size {
			bad = true
			break
		}
		size += 4 + len(nalu)
	}
	now := time.Now()
	if p.window.IsZero() || now.Sub(p.window) >= time.Second {
		p.window = now
		p.windowAUs = 0
		p.windowBytes = 0
	}
	serialized := size + 4 + metadataSize
	if !p.credit || p.occupied || p.windowAUs >= 30 || serialized > 1048576-p.windowBytes || serialized > 16777216-p.leaseBytes {
		bad = true
	}
	if bad {
		p.failed = true
		p.mu.Unlock()
		p.shutdown(true)
		return ErrInvalid
	}
	p.credit = false
	p.occupied = true
	p.haveTimestamp = true
	p.timestamp = timestampUs
	p.windowAUs++
	p.windowBytes += serialized
	p.leaseBytes += serialized
	data := make([]byte, serialized)
	binary.BigEndian.PutUint32(data[:4], uint32(metadataSize+size))
	data[4] = 1
	if keyframe {
		data[5] = 1
	}
	binary.BigEndian.PutUint64(data[8:16], timestampUs)
	offset := 16
	for _, nalu := range nalus {
		data[offset+3] = 1
		offset += 4
		offset += copy(data[offset:], nalu)
	}
	p.slot <- data
	p.mu.Unlock()
	return nil
}

// WaitInitialCredit waits until the control reader accepts its first credit.
func (p *Pipe) WaitInitialCredit(ctx context.Context) error {
	select {
	case <-p.firstCredit:
	case <-p.stop:
	case <-ctx.Done():
	}
	if err := ctx.Err(); err != nil {
		return err
	}
	p.mu.Lock()
	defer p.mu.Unlock()
	if err := ctx.Err(); err != nil {
		return err
	}
	select {
	case <-p.stop:
		return ErrInvalid
	default:
	}
	if p.failed || !p.initialCredit {
		return ErrInvalid
	}
	return nil
}

func (p *Pipe) Done() <-chan struct{} { return p.stop }

// Err never exposes errors from a descriptor or context.
func (p *Pipe) Err() error {
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.failed {
		return ErrInvalid
	}
	return nil
}

// Close releases the owned descriptors and waits for all workers to exit.
func (p *Pipe) Close() error {
	p.shutdown(false)
	p.wg.Wait()
	return p.Err()
}
