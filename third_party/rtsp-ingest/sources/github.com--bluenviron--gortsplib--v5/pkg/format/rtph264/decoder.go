package rtph264

import (
	"bytes"
	"errors"
	"fmt"

	"github.com/bluenviron/mediacommon/v2/pkg/codecs/h264"
	"github.com/pion/rtp"
)

// ErrMorePacketsNeeded is returned when more packets are needed.
var ErrMorePacketsNeeded = errors.New("need more packets")

// ErrNonStartingPacketAndNoPrevious is returned when we received a non-starting
// packet of a fragmented NALU and we didn't received anything before.
// It's normal to receive this when decoding a stream that has been already
// running for some time.
var ErrNonStartingPacketAndNoPrevious = errors.New(
	"received a non-starting fragment without any previous starting fragment")

func joinFragments(fragments [][]byte, size int) []byte {
	ret := make([]byte, size)
	n := 0
	for _, p := range fragments {
		n += copy(ret[n:], p)
	}
	return ret
}

// Even though fragments must contain only
// one NAL unit, some vendors put multiple anyway.
func splitNALUs(b []byte) [][]byte {
	ret, _ := splitNALUsChecked(b, nil)
	return ret
}

func splitNALUsChecked(b []byte, check func(int, int) error) ([][]byte, error) {
	total := 0
	startCode := []byte{0x00, 0x00, 0x01}
	nalus := make([][]byte, 0, 1)
	for len(b) > 0 {
		idx := bytes.Index(b, startCode)
		if idx == -1 {
			if check != nil {
				if err := check(total+len(b), len(nalus)+1); err != nil {
					return nil, err
				}
			}
			nalus = append(nalus, b)
			break
		}
		sz := 3
		if idx > 0 && b[idx-1] == 0x00 {
			idx--
			sz++
		}
		if idx == 0 {
			b = b[sz:]
			continue
		}
		if check != nil {
			if err := check(total+idx, len(nalus)+1); err != nil {
				return nil, err
			}
		}
		total += idx
		nalus = append(nalus, b[:idx])
		b = b[idx+sz:]
	}
	return nalus, nil
}

func isAllZero(buf []byte) bool {
	for _, b := range buf {
		if b != 0 {
			return false
		}
	}
	return true
}

func auSize(au [][]byte) int {
	s := 0
	for _, nalu := range au {
		s += len(nalu)
	}
	return s
}

func auIsOnlySEI(au [][]byte) bool {
	for _, nalu := range au {
		if h264.NALUType(nalu[0]&0x1F) != h264.NALUTypeSEI {
			return false
		}
	}

	return true
}

// DecoderLimits bounds one access unit, including canonical output delimiters.
type DecoderLimits struct {
	MaxAccessUnitBytes      int
	MaxPacketsPerAccessUnit int
	MaxFragmentsPerNAL      int
	MaxNALUsPerAccessUnit   int
}

// Decoder is a RTP/H264 decoder.
// Specification: RFC6184
type Decoder struct {
	// Limits is copied by Init. Nil preserves the legacy profile.
	Limits          *DecoderLimits
	limits          *DecoderLimits
	initialized     bool
	terminal        bool
	packets         int
	fragmentPackets int
	strictTimestamp uint32
	strictNextSeq   uint16

	// indicates the packetization mode.
	PacketizationMode int

	firstPacketReceived bool
	fragments           [][]byte
	fragmentsSize       int
	fragmentNextSeqNum  uint16
	annexBMode          bool

	// for Decode()
	frameBuffer          [][]byte
	frameBufferLen       int
	frameBufferSize      int
	frameBufferTimestamp uint32
	lastNonSEITimestamp  uint32
	lastNonSEIReceived   bool
}

// Init initializes the decoder.
func (d *Decoder) Init() error {
	if d.terminal || d.initialized {
		return fmt.Errorf("decoder is already initialized or terminal")
	}
	if d.Limits != nil {
		v := *d.Limits
		maxInt := int(^uint(0) >> 1)
		if v.MaxAccessUnitBytes <= 0 || v.MaxAccessUnitBytes > maxInt-4 ||
			v.MaxPacketsPerAccessUnit <= 0 || v.MaxFragmentsPerNAL <= 0 ||
			v.MaxFragmentsPerNAL > maxInt-1 || v.MaxNALUsPerAccessUnit <= 0 ||
			v.MaxNALUsPerAccessUnit > maxInt/4 {
			d.failStrict()
			return fmt.Errorf("invalid decoder limits")
		}
		d.limits = &v
		d.initialized = true
	}

	if d.PacketizationMode != 0 && d.PacketizationMode != 1 {
		if d.Limits != nil {
			d.failStrict()
		}
		return fmt.Errorf("unsupported packetization mode: %d", d.PacketizationMode)
	}
	return nil
}

func (d *Decoder) resetFragments() {
	clear(d.fragments[:cap(d.fragments)])
	d.fragments = d.fragments[:0]
	d.fragmentPackets = 0
	d.fragmentsSize = 0
}

func (d *Decoder) decodeNALUs(pkt *rtp.Packet) ([][]byte, error) {
	if len(pkt.Payload) < 1 {
		d.resetFragments()
		return nil, fmt.Errorf("payload is too short")
	}

	typ := h264.NALUType(pkt.Payload[0] & 0x1F)
	var nalus [][]byte
	if d.limits != nil && len(d.fragments) != 0 && typ != h264.NALUTypeFUA {
		return nil, fmt.Errorf("unfinished fragmented NAL")
	}

	switch typ {
	case h264.NALUTypeFUA:
		if len(pkt.Payload) < 2 {
			return nil, fmt.Errorf("invalid FU-A packet (invalid size)")
		}

		start := pkt.Payload[1] >> 7
		end := (pkt.Payload[1] >> 6) & 0x01

		if d.limits != nil {
			if start == 1 && len(d.fragments) != 0 {
				return nil, fmt.Errorf("repeated FU start")
			}
			if d.fragmentPackets >= d.limits.MaxFragmentsPerNAL {
				return nil, fmt.Errorf("fragment limit exceeded")
			}
			if len(pkt.Payload)-2 > d.limits.MaxAccessUnitBytes-d.fragmentsSize {
				return nil, fmt.Errorf("fragment byte limit exceeded")
			}
			size := d.fragmentsSize + (len(pkt.Payload) - 2)
			if start == 1 {
				size = len(pkt.Payload) - 1
			}
			if err := d.checkStrictNAL(size, 1); err != nil {
				return nil, err
			}
		}
		if start == 1 {
			d.resetFragments()

			nri := (pkt.Payload[0] >> 5) & 0x03
			typ := pkt.Payload[1] & 0x1F
			d.fragmentPackets = 1
			d.fragmentsSize = len(pkt.Payload[1:])
			d.fragments = append(d.fragments, []byte{(nri << 5) | typ}, pkt.Payload[2:])
			d.fragmentNextSeqNum = pkt.SequenceNumber + 1
			d.firstPacketReceived = true

			// RFC 6184 clearly states:
			//
			//   A fragmented NAL unit MUST NOT be transmitted in one FU; that is, the
			//   Start bit and End bit MUST NOT both be set to one in the same FU
			//   header.
			//
			// However, some vendors camera (e.g. CostarHD) have been observed to nevertheless
			// emit one fragmented NAL unit for sufficiently small P-frames.
			if end != 0 {
				var splitErr error
				nalus, splitErr = d.splitFragments()
				if splitErr != nil {
					return nil, splitErr
				}
				d.resetFragments()
				break
			}

			return nil, ErrMorePacketsNeeded
		}

		if d.fragmentsSize == 0 {
			if !d.firstPacketReceived {
				return nil, ErrNonStartingPacketAndNoPrevious
			}

			return nil, fmt.Errorf("invalid FU-A packet (non-starting)")
		}

		if pkt.SequenceNumber != d.fragmentNextSeqNum {
			d.resetFragments()
			return nil, fmt.Errorf("discarding frame since a RTP packet is missing")
		}

		d.fragmentPackets++
		d.fragmentsSize += len(pkt.Payload[2:])

		if d.fragmentsSize > h264.MaxAccessUnitSize {
			errSize := d.fragmentsSize
			d.resetFragments()
			return nil, fmt.Errorf("NALU size (%d) is too big, maximum is %d",
				errSize, h264.MaxAccessUnitSize)
		}

		d.fragments = append(d.fragments, pkt.Payload[2:])
		d.fragmentNextSeqNum++

		if end != 1 {
			return nil, ErrMorePacketsNeeded
		}

		var splitErr error
		nalus, splitErr = d.splitFragments()
		if splitErr != nil {
			return nil, splitErr
		}
		d.resetFragments()

	case h264.NALUTypeSTAPA:
		d.resetFragments()

		payload := pkt.Payload[1:]

		for {
			if len(payload) < 2 {
				return nil, fmt.Errorf("invalid STAP-A packet (invalid size)")
			}

			size := uint16(payload[0])<<8 | uint16(payload[1])
			payload = payload[2:]

			if size == 0 {
				// discard padding
				if isAllZero(payload) {
					break
				}

				return nil, fmt.Errorf("invalid STAP-A packet (invalid size)")
			}

			if int(size) > len(payload) {
				return nil, fmt.Errorf("invalid STAP-A packet (invalid size)")
			}

			if d.limits != nil {
				current := auSize(nalus)
				if int(size) > d.limits.MaxAccessUnitBytes-current {
					return nil, fmt.Errorf("STAP byte limit exceeded")
				}
				if err := d.checkStrictNAL(current+int(size), len(nalus)+1); err != nil {
					return nil, err
				}
			}
			nalus = append(nalus, payload[:size])
			payload = payload[size:]

			if len(payload) == 0 {
				break
			}
		}

		if nalus == nil {
			return nil, fmt.Errorf("STAP-A packet doesn't contain any NALU")
		}

		d.firstPacketReceived = true

	case h264.NALUTypeSTAPB, h264.NALUTypeMTAP16,
		h264.NALUTypeMTAP24, h264.NALUTypeFUB:
		d.resetFragments()
		d.firstPacketReceived = true
		return nil, fmt.Errorf("packet type not supported (%v)", typ)

	default:
		d.resetFragments()
		d.firstPacketReceived = true
		if d.limits != nil && (d.annexBMode || bytes.Contains(pkt.Payload, []byte{0, 0, 0, 1})) {
			remaining := d.limits.MaxAccessUnitBytes - d.frameBufferSize - 4*d.frameBufferLen
			if len(pkt.Payload) > remaining {
				return nil, fmt.Errorf("Annex-B input exceeds limit")
			}
		} else if err := d.checkStrictNAL(len(pkt.Payload), 1); err != nil {
			return nil, err
		}
		nalus = [][]byte{pkt.Payload}
	}

	nalus, err := d.removeAnnexB(nalus)
	if err != nil {
		return nil, err
	}

	if len(nalus) == 0 {
		return nil, fmt.Errorf("fragmented NALU doesn't contain any NALU")
	}

	return nalus, nil
}

// Decode decodes an access unit from a RTP packet.
// On success, the access unit contains at least one NALU, each with at least one byte.
func (d *Decoder) Decode(pkt *rtp.Packet) (retAU [][]byte, retErr error) {
	if d.Limits != nil && !d.initialized {
		d.failStrict()
		return nil, fmt.Errorf("strict decoder requires successful Init")
	}
	if d.terminal {
		return nil, fmt.Errorf("decoder is terminal")
	}
	if d.limits != nil {
		defer func() {
			if retErr != nil && retErr != ErrMorePacketsNeeded {
				d.failStrict()
			}
		}()
		if d.packets >= d.limits.MaxPacketsPerAccessUnit {
			return nil, fmt.Errorf("packet limit exceeded")
		}
		if d.packets > 0 && (pkt.Timestamp != d.strictTimestamp || pkt.SequenceNumber != d.strictNextSeq) {
			return nil, fmt.Errorf("access unit discontinuity")
		}
		d.packets++
		d.strictTimestamp = pkt.Timestamp
		d.strictNextSeq = pkt.SequenceNumber + 1
	}

	nalus, err := d.decodeNALUs(pkt)
	if err != nil {
		return nil, err
	}
	l := len(nalus)

	var ret [][]byte
	var retTimestamp uint32

	// support splitting access units by timestamp.
	// (some cameras do not use the Marker field, like the FLIR M400)
	if d.frameBuffer != nil && pkt.Timestamp != d.frameBufferTimestamp {
		ret = d.frameBuffer
		retTimestamp = d.frameBufferTimestamp
		d.resetFrameBuffer()

		err = d.addToFrameBuffer(nalus, l, pkt.Timestamp)
		if err != nil {
			return nil, err
		}
	} else {
		err = d.addToFrameBuffer(nalus, l, pkt.Timestamp)
		if err != nil {
			return nil, err
		}

		if !pkt.Marker {
			return nil, ErrMorePacketsNeeded
		}

		ret = d.frameBuffer
		retTimestamp = d.frameBufferTimestamp
		d.resetFrameBuffer()
	}

	if d.limits != nil {
		d.packets = 0
	}

	// Drop trailing SEI-only access units, that in reality should be leading the previous access unit.
	// These cause problems in downstream components (DTS extractor, recorder).
	if auIsOnlySEI(ret) {
		if d.lastNonSEIReceived && retTimestamp == d.lastNonSEITimestamp {
			return nil, ErrMorePacketsNeeded
		}
		d.lastNonSEIReceived = false
	} else {
		d.lastNonSEITimestamp = retTimestamp
		d.lastNonSEIReceived = true
	}

	return ret, nil
}

func (d *Decoder) resetFrameBuffer() {
	d.frameBuffer = nil // do not reuse frameBuffer to avoid race conditions
	d.frameBufferLen = 0
	d.frameBufferSize = 0
}

func (d *Decoder) addToFrameBuffer(nalus [][]byte, l int, ts uint32) error {
	if err := d.checkStrictNAL(auSize(nalus), l); err != nil {
		return err
	}
	if (d.frameBufferLen + l) > h264.MaxNALUsPerAccessUnit {
		errCount := d.frameBufferLen + l
		d.resetFrameBuffer()
		return fmt.Errorf("NALU count (%d) exceeds maximum allowed (%d)",
			errCount, h264.MaxNALUsPerAccessUnit)
	}

	addSize := auSize(nalus)

	if (d.frameBufferSize + addSize) > h264.MaxAccessUnitSize {
		errSize := d.frameBufferSize + addSize
		d.resetFrameBuffer()
		return fmt.Errorf("access unit size (%d) is too big, maximum is %d",
			errSize, h264.MaxAccessUnitSize)
	}

	d.frameBuffer = append(d.frameBuffer, nalus...)
	d.frameBufferLen += l
	d.frameBufferSize += addSize
	d.frameBufferTimestamp = ts
	return nil
}

// some cameras / servers wrap NALUs into Annex-B
func (d *Decoder) removeAnnexB(nalus [][]byte) ([][]byte, error) {
	if len(nalus) == 1 {
		nalu := nalus[0]

		if !d.annexBMode && bytes.Contains(nalu, []byte{0x00, 0x00, 0x00, 0x01}) {
			d.annexBMode = true
		}

		if d.annexBMode {
			if !bytes.HasPrefix(nalu, []byte{0x00, 0x00, 0x00, 0x01}) {
				if d.limits != nil && len(nalu) > d.limits.MaxAccessUnitBytes-4 {
					return nil, fmt.Errorf("Annex-B adaptation exceeds limit")
				}
				nalu = append([]byte{0x00, 0x00, 0x00, 0x01}, nalu...)
			}

			var annexb h264.AnnexB
			var err error
			if d.limits != nil {
				err = annexb.UnmarshalWithLimits(nalu, h264.AnnexBLimits{
					MaxAccessUnitBytes:    d.limits.MaxAccessUnitBytes - d.frameBufferSize - 4*d.frameBufferLen,
					MaxNALUsPerAccessUnit: d.limits.MaxNALUsPerAccessUnit - d.frameBufferLen,
				})
			} else {
				err = annexb.Unmarshal(nalu)
			}
			return annexb, err
		}
	}

	return nalus, nil
}

func (d *Decoder) checkStrictNAL(size, count int) error {
	if d.limits == nil {
		return nil
	}
	v := d.limits
	if count > v.MaxNALUsPerAccessUnit-d.frameBufferLen {
		return fmt.Errorf("NAL count limit exceeded")
	}
	remaining := v.MaxAccessUnitBytes - d.frameBufferSize - 4*d.frameBufferLen
	if count > remaining/4 || size > remaining-4*count {
		return fmt.Errorf("access unit byte limit exceeded")
	}
	return nil
}

func (d *Decoder) splitFragments() ([][]byte, error) {
	if err := d.checkStrictNAL(d.fragmentsSize, 1); err != nil {
		return nil, err
	}
	return splitNALUsChecked(joinFragments(d.fragments, d.fragmentsSize), d.checkStrictNAL)
}

func (d *Decoder) failStrict() {
	d.terminal = true
	d.resetFragments()
	clear(d.frameBuffer)
	d.resetFrameBuffer()
}
