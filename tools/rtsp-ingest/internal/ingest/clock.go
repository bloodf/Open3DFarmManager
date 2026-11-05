// SPDX-License-Identifier: MIT

package ingest

// StreamClock maps completed 90 kHz AUs to a relative, increasing media clock.
// It has no wall-clock or RTCP/NTP dependency.
type StreamClock struct {
	started  bool
	last     uint32
	ticks    uint64
	lastUs   uint64
	terminal bool
}

func (c *StreamClock) Complete(timestamp uint32) (uint64, error) {
	if c.terminal {
		return 0, ErrClock
	}
	if !c.started {
		c.started, c.last = true, timestamp
		return 0, nil
	}
	delta := uint64(timestamp - c.last)
	const maxUint64 = ^uint64(0)
	if delta == 0 || delta > 180000 || delta > maxUint64-c.ticks {
		c.terminal = true
		return 0, ErrClock
	}
	ticks := c.ticks + delta
	if ticks > maxUint64/1000000 {
		c.terminal = true
		return 0, ErrClock
	}
	us := ticks * 1000000 / 90000
	if us <= c.lastUs || us > 9007199254740991 {
		c.terminal = true
		return 0, ErrClock
	}
	c.last, c.ticks, c.lastUs = timestamp, ticks, us
	return us, nil
}
