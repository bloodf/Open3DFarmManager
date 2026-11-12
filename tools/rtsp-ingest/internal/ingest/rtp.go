// SPDX-License-Identifier: MIT

package ingest

import (
	"github.com/bluenviron/gortsplib/v5/pkg/format/rtph264"
	"github.com/bluenviron/mediacommon/v2/pkg/codecs/h264"
	"github.com/pion/rtp"
)

// RTPGuard owns only transport identity and continuous sequence policy.
// Decoder owns all AU packet, fragment, NAL, timestamp and completion state,
// including completed SEI-only units which it deliberately suppresses.
type RTPGuard struct {
	PayloadType uint8
	started     bool
	ssrc        uint32
	next        uint16
	terminal    bool
}

// streamAdmission owns only completed-output timing and stream bootstrap.
// No completion is inferred from RTP markers or ErrMorePacketsNeeded.
type streamAdmission struct {
	guard   RTPGuard
	decoder *rtph264.Decoder
	clock   StreamClock
	sps     bool
	pps     bool
	ready   bool
	// Live sources join mid-GOP; leading non-IDR units are dropped, never offered.
	skipped int
}

const maxBootstrapSkips = 128

func (s *streamAdmission) accept(pkt *rtp.Packet, offer func(uint64, bool, [][]byte) error) error {
	if err := s.guard.Admit(pkt); err != nil {
		return err
	}
	nalus, err := s.decoder.Decode(pkt)
	if err == rtph264.ErrMorePacketsNeeded {
		return nil
	}
	if err != nil {
		return ErrRTP
	}
	keyframe, skip := false, false
	for _, nalu := range nalus {
		if len(nalu) == 0 || nalu[0]&0x80 != 0 {
			return ErrRTP
		}
		switch h264.NALUType(nalu[0] & 0x1f) {
		case h264.NALUTypeSPS:
			s.sps = true
		case h264.NALUTypePPS:
			s.pps = true
		case h264.NALUTypeIDR:
			if !s.sps || !s.pps {
				return ErrRTP
			}
			keyframe, s.ready = true, true
		case h264.NALUTypeNonIDR:
			skip = !s.ready
		case h264.NALUTypeSEI, h264.NALUTypeAccessUnitDelimiter:
		default:
			return ErrRTP
		}
	}
	if skip {
		if s.skipped++; s.skipped > maxBootstrapSkips {
			return ErrRTP
		}
		return nil
	}
	timestampUs, err := s.clock.Complete(pkt.Timestamp)
	if err != nil {
		return err
	}
	if offer(timestampUs, keyframe, nalus) != nil {
		return ErrOutput
	}
	return nil
}

func (g *RTPGuard) Admit(pkt *rtp.Packet) error {
	if g.terminal {
		return ErrRTP
	}
	if pkt == nil || pkt.Version != 2 || pkt.PayloadType != g.PayloadType || pkt.Padding || pkt.Extension || len(pkt.CSRC) != 0 || len(pkt.Extensions) != 0 || pkt.PaddingSize != 0 || pkt.Header.PaddingSize != 0 ||
		(g.started && (pkt.SSRC != g.ssrc || pkt.SequenceNumber != g.next)) {
		g.terminal = true
		return ErrRTP
	}
	g.started, g.ssrc, g.next = true, pkt.SSRC, pkt.SequenceNumber+1
	return nil
}

func strictDecoder() (*rtph264.Decoder, error) {
	d := &rtph264.Decoder{PacketizationMode: 1, Limits: &rtph264.DecoderLimits{
		MaxAccessUnitBytes:      262144,
		MaxPacketsPerAccessUnit: 512,
		MaxFragmentsPerNAL:      512,
		MaxNALUsPerAccessUnit:   50,
	}}
	if d.Init() != nil {
		return nil, ErrRTP
	}
	return d, nil
}
