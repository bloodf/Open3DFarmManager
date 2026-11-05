// SPDX-License-Identifier: MIT

package rtspfixture

import (
	"crypto/sha256"
	"encoding/binary"
	"io"

	"github.com/bluenviron/mediacommon/v2/pkg/codecs/h264"
	"open3dfarm.local/rtsp-ingest/internal/aupipe"
)

// MovingHeader follows the already consumed version byte. No address is supplied.
type MovingHeader struct {
	Port   uint16
	Frames uint16
}

func ReadMovingHeader(input io.Reader) (MovingHeader, error) {
	var data [7]byte
	if _, err := io.ReadFull(input, data[:]); err != nil || data[0] != 1 || data[5] != 0 || data[6] != 0 {
		return MovingHeader{}, errFixture
	}
	h := MovingHeader{Port: binary.BigEndian.Uint16(data[1:3]), Frames: binary.BigEndian.Uint16(data[3:5])}
	if h.Port == 0 || h.Frames == 0 || h.Frames > 60 {
		return MovingHeader{}, errFixture
	}
	return h, nil
}

// NALUs reference this frame's exclusively owned record body. No subsequent read
// mutates it. The caller must finish SendAU before releasing/replacing the frame.
type MovingFrame struct {
	Timestamp90k    uint32
	NALUs           [][]byte
	CanonicalBytes  int
	CanonicalSHA256 [32]byte
	RawSHA256       [32]byte
	PacketCount     int
}

type MovingInput struct {
	input          io.Reader
	frames         uint16
	index          uint16
	failed         bool
	rawTotal       int
	canonicalTotal int
	packetTotal    int
	recent         [11]int
	sps            bool
	pps            bool
}

func NewMovingInput(input io.Reader, frames uint16) (*MovingInput, error) {
	if input == nil || frames == 0 || frames > 60 {
		return nil, errFixture
	}
	return &MovingInput{input: input, frames: frames}, nil
}

// ReadNext reads one record only. Any rejection permanently terminates this input.
// Counts/timestamps describe finite source data; they confer no lease authority.
func (m *MovingInput) ReadNext() (frame MovingFrame, err error) {
	if m.failed {
		return frame, errFixture
	}
	if m.index == m.frames {
		return frame, io.EOF
	}
	defer func() {
		if err != nil {
			m.failed = true
		}
	}()
	record, readErr := aupipe.ReadRecord(m.input)
	if readErr != nil || !record.Keyframe || record.TimestampUs != uint64(m.index)*100000 {
		return frame, errFixture
	}
	var nalus h264.AnnexB
	if nalus.UnmarshalWithLimits(record.AnnexB, h264.AnnexBLimits{MaxAccessUnitBytes: 262144, MaxNALUsPerAccessUnit: 8}) != nil {
		return frame, errFixture
	}
	hash := sha256.New()
	canonical, packets := 0, 0
	sps, pps, idr := m.sps, m.pps, false
	for _, nalu := range nalus {
		if len(nalu) == 0 || nalu[0]&0x80 != 0 || len(nalu) > 8*(payloadLimit-2) {
			return frame, errFixture
		}
		packets += (len(nalu) + payloadLimit - 3) / (payloadLimit - 2)
		if packets > 8 {
			return frame, errFixture
		}
		switch h264.NALUType(nalu[0] & 31) {
		case h264.NALUTypeSPS:
			sps = true
		case h264.NALUTypePPS:
			pps = true
		case h264.NALUTypeIDR:
			if !sps || !pps {
				return frame, errFixture
			}
			idr = true
		case h264.NALUTypeSEI, h264.NALUTypeAccessUnitDelimiter:
		default:
			return frame, errFixture
		}
		canonical += 4 + len(nalu)
		hash.Write([]byte{0, 0, 0, 1})
		hash.Write(nalu)
	}
	if !idr {
		return frame, errFixture
	}
	// Reserve 64 KiB for RTSP/control wire overhead within the unchanged 2 MiB
	// socket budget. RTP upper bound includes interleaved and RTP headers. The
	// actual socket budget remains authoritative for all bytes in both directions.
	rawTotal, canonicalTotal := m.rawTotal+len(record.AnnexB), m.canonicalTotal+canonical
	packetTotal := m.packetTotal + packets
	if rawTotal > 4<<20 || canonicalTotal > 4<<20 || canonicalTotal+packetTotal*18 > wireLimit-(64<<10) {
		return frame, errFixture
	}
	recent := m.recent
	recent[int(m.index)%len(recent)] = canonical + 16
	rate := 0
	for _, n := range recent {
		rate += n
	}
	if rate > 1<<20 {
		return frame, errFixture
	}
	frame = MovingFrame{Timestamp90k: 9000 + uint32(m.index)*9000, NALUs: nalus, CanonicalBytes: canonical, RawSHA256: sha256.Sum256(record.AnnexB), PacketCount: packets}
	copy(frame.CanonicalSHA256[:], hash.Sum(nil))
	m.index++
	m.rawTotal = rawTotal
	m.canonicalTotal = canonicalTotal
	m.packetTotal = packetTotal
	m.recent = recent
	m.sps = sps
	m.pps = pps
	return frame, nil
}
