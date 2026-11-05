// SPDX-License-Identifier: MIT

package ingest

import (
	"reflect"
	"testing"

	"github.com/bluenviron/gortsplib/v5/pkg/format/rtph264"
	"github.com/pion/rtp"
)

func fixturePacket(seq uint16, timestamp uint32, marker bool, payload ...byte) *rtp.Packet {
	return &rtp.Packet{Header: rtp.Header{Version: 2, PayloadType: 96, SSRC: 7, SequenceNumber: seq, Timestamp: timestamp, Marker: marker}, Payload: payload}
}

func TestRTPSequenceWrapAndIdentity(t *testing.T) {
	g := RTPGuard{PayloadType: 96}
	for _, seq := range []uint16{65535, 0, 1} {
		if err := g.Admit(fixturePacket(seq, 100, true, 0x65)); err != nil {
			t.Fatal(err)
		}
	}
	mutations := []func(*rtp.Packet){
		func(p *rtp.Packet) { p.SequenceNumber = 4 }, func(p *rtp.Packet) { p.SequenceNumber = 2 },
		func(p *rtp.Packet) { p.SSRC++ }, func(p *rtp.Packet) { p.PayloadType++ },
		func(p *rtp.Packet) { p.Version = 1 }, func(p *rtp.Packet) { p.Padding = true },
		func(p *rtp.Packet) { p.Extension = true }, func(p *rtp.Packet) { p.CSRC = []uint32{1} },
	}
	for _, mutate := range mutations {
		guard := RTPGuard{PayloadType: 96}
		_ = guard.Admit(fixturePacket(2, 100, true, 0x65))
		packet := fixturePacket(3, 200, true, 0x65)
		mutate(packet)
		if guard.Admit(packet) != ErrRTP || guard.Admit(fixturePacket(3, 200, true, 0x65)) != ErrRTP {
			t.Fatal("accepted invalid RTP or revived guard")
		}
	}
}

func TestDecodedAUAndSuppressedSEIDoNotLeaveOuterState(t *testing.T) {
	for _, packetCap := range []int{1, 512} {
		decoder := &rtph264.Decoder{PacketizationMode: 1, Limits: &rtph264.DecoderLimits{
			MaxAccessUnitBytes: 262144, MaxPacketsPerAccessUnit: packetCap, MaxFragmentsPerNAL: 512, MaxNALUsPerAccessUnit: 50,
		}}
		if err := decoder.Init(); err != nil {
			t.Fatal(err)
		}
		stream := streamAdmission{guard: RTPGuard{PayloadType: 96}, decoder: decoder}
		var timestamps []uint64
		var keys []bool
		var aus [][][]byte
		offer := func(timestamp uint64, key bool, nalus [][]byte) error {
			timestamps = append(timestamps, timestamp)
			keys = append(keys, key)
			aus = append(aus, nalus)
			return nil
		}
		// STAP-A carries original minimal SPS, PPS and IDR header fixtures.
		for _, packet := range []*rtp.Packet{
			fixturePacket(65535, 100, true, 0x78, 0, 1, 0x67, 0, 1, 0x68, 0, 1, 0x65),
			fixturePacket(0, 100, true, 0x06),
			fixturePacket(1, 9100, true, 0x61),
		} {
			if err := stream.accept(packet, offer); err != nil {
				t.Fatalf("packet cap %d: %v", packetCap, err)
			}
		}
		if !reflect.DeepEqual(timestamps, []uint64{0, 100000}) || !reflect.DeepEqual(keys, []bool{true, false}) || !reflect.DeepEqual(aus, [][][]byte{{{0x67}, {0x68}, {0x65}}, {{0x61}}}) {
			t.Fatal("wrong completed output or suppressed SEI offered")
		}
	}
}

func TestDecoderOwnsIncompleteAUAndLimits(t *testing.T) {
	for _, packets := range [][]*rtp.Packet{
		{fixturePacket(1, 1, false, 0x7c, 0x85, 1), fixturePacket(2, 1, false, 0x7c, 0x85, 2)},
		{fixturePacket(1, 1, false, 0x67), fixturePacket(2, 2, true, 0x68)},
		{fixturePacket(1, 1, true)},
		{fixturePacket(1, 1, true, 0x78, 0, 3, 0x65)},
	} {
		d, err := strictDecoder()
		if err != nil {
			t.Fatal(err)
		}
		var last error
		for _, packet := range packets {
			_, last = d.Decode(packet)
		}
		if last == nil || last == rtph264.ErrMorePacketsNeeded {
			t.Fatal("decoder accepted malformed AU")
		}
	}
	d, err := strictDecoder()
	if err != nil {
		t.Fatal(err)
	}
	for i := 0; i < 513; i++ {
		header := byte(0x05)
		if i == 0 {
			header = 0x85
		}
		_, err = d.Decode(fixturePacket(uint16(i), 1, true, 0x7c, header))
		if i < 512 && err != rtph264.ErrMorePacketsNeeded {
			t.Fatal("early packet limit")
		}
	}
	if err == nil || err == rtph264.ErrMorePacketsNeeded {
		t.Fatal("packet cap bypass")
	}
	d, _ = strictDecoder()
	oversized := make([]byte, 262141)
	oversized[0] = 0x65
	if _, err := d.Decode(fixturePacket(1, 1, true, oversized...)); err == nil {
		t.Fatal("AnnexB delimiter bytes excluded from cap")
	}
	d, _ = strictDecoder()
	exact := make([]byte, 262140)
	exact[0] = 0x65
	if au, err := d.Decode(fixturePacket(1, 1, true, exact...)); err != nil || len(au) != 1 || len(au[0]) != len(exact) {
		t.Fatal("rejected exact AU bound")
	}
	d, _ = strictDecoder()
	stap := []byte{0x78}
	for i := 0; i < 51; i++ {
		stap = append(stap, 0, 1, 0x67)
	}
	if _, err := d.Decode(fixturePacket(1, 1, true, stap...)); err == nil {
		t.Fatal("NAL count cap bypass")
	}
}

func TestDecoderFUCompletion(t *testing.T) {
	d, err := strictDecoder()
	if err != nil {
		t.Fatal(err)
	}
	if _, err := d.Decode(fixturePacket(1, 10, false, 0x7c, 0x85, 0x11)); err != rtph264.ErrMorePacketsNeeded {
		t.Fatal("FU start")
	}
	au, err := d.Decode(fixturePacket(2, 10, true, 0x7c, 0x45, 0x22))
	if err != nil || !reflect.DeepEqual(au, [][]byte{{0x65, 0x11, 0x22}}) {
		t.Fatal("FU completion")
	}
}

func TestStreamRequiresInBandBootstrapAndPropagatesOfferFailure(t *testing.T) {
	for _, nal := range []byte{0x65, 0x61, 0x80} {
		d, _ := strictDecoder()
		s := streamAdmission{guard: RTPGuard{PayloadType: 96}, decoder: d}
		if s.accept(fixturePacket(1, 1, true, nal), func(uint64, bool, [][]byte) error { t.Fatal("offered unbootstrapped video"); return nil }) != ErrRTP {
			t.Fatal("accepted unbootstrapped video")
		}
	}
	d, _ := strictDecoder()
	s := streamAdmission{guard: RTPGuard{PayloadType: 96}, decoder: d}
	if s.accept(fixturePacket(1, 1, true, 0x67), func(uint64, bool, [][]byte) error { return ErrOutput }) != ErrOutput {
		t.Fatal("lost output failure")
	}
}
