package rtph264

import (
	"testing"

	"github.com/pion/rtp"
	"github.com/stretchr/testify/require"
)

// Source-only regression additions: not executed during patch preparation.
func TestDecoderStrictLimits(t *testing.T) {
	limits := DecoderLimits{MaxAccessUnitBytes: 12, MaxPacketsPerAccessUnit: 3, MaxFragmentsPerNAL: 2, MaxNALUsPerAccessUnit: 2}
	packet := func(seq uint16, ts uint32, marker bool, payload ...byte) *rtp.Packet {
		return &rtp.Packet{Header: rtp.Header{SequenceNumber: seq, Timestamp: ts, Marker: marker}, Payload: payload}
	}
	for _, tc := range []struct {
		name    string
		packets []*rtp.Packet
		success bool
	}{
		{"Annex-B-boundary", []*rtp.Packet{packet(1, 1, true, 0, 0, 0, 1, 0x65, 1, 2, 3, 4, 5, 6, 7)}, true},
		{"single-boundary", []*rtp.Packet{packet(1, 1, true, 0x65, 1, 2, 3, 4, 5, 6, 7)}, true},
		{"single-delimiter-over", []*rtp.Packet{packet(1, 1, true, 0x65, 1, 2, 3, 4, 5, 6, 7, 8)}, false},
		{"FU-wrap", []*rtp.Packet{packet(65535, 1, false, 0x7c, 0x85), packet(0, 1, true, 0x7c, 0x45, 1)}, true},
		{"FU-zero-body-flood", []*rtp.Packet{packet(1, 1, false, 0x7c, 0x85), packet(2, 1, false, 0x7c, 5), packet(3, 1, true, 0x7c, 0x45)}, false},
		{"FU-repeated-start", []*rtp.Packet{packet(1, 1, false, 0x7c, 0x85), packet(2, 1, true, 0x7c, 0x85)}, false},
		{"hostile-marker", []*rtp.Packet{packet(1, 1, true, 0x7c, 0x85), packet(2, 2, true, 0x7c, 0x45)}, false},
		{"sequence-gap", []*rtp.Packet{packet(1, 1, false, 0x65), packet(3, 1, true, 0x65)}, false},
		{"combined-budget", []*rtp.Packet{packet(1, 1, false, 0x65, 1, 2), packet(2, 1, false, 0x7c, 0x85, 1, 2)}, false},
		{"STAP-valid", []*rtp.Packet{packet(1, 1, true, 0x78, 0, 1, 0x65, 0, 1, 0x61)}, true},
		{"STAP-dense", []*rtp.Packet{packet(1, 1, true, 0x78, 0, 1, 0x65, 0, 1, 0x61, 0, 1, 0x61)}, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			d := Decoder{Limits: &limits}
			require.NoError(t, d.Init())
			var result [][]byte
			var err error
			for _, p := range tc.packets {
				result, err = d.Decode(p)
				if err != nil && err != ErrMorePacketsNeeded {
					break
				}
			}
			if tc.success {
				require.NoError(t, err)
				require.NotEmpty(t, result)
			} else {
				require.Error(t, err)
				require.NotEqual(t, ErrMorePacketsNeeded, err)
				require.True(t, d.terminal)
				require.Empty(t, d.frameBuffer)
				for _, ref := range d.fragments[:cap(d.fragments)] {
					require.Nil(t, ref)
				}
				_, err = d.Decode(packet(9, 9, true, 0x65))
				require.Error(t, err)
				require.Error(t, d.Init())
			}
		})
	}
}

func TestDecoderStrictSnapshotAndOwnership(t *testing.T) {
	v := DecoderLimits{12, 3, 2, 2}
	d := Decoder{Limits: &v}
	require.NoError(t, d.Init())
	v.MaxAccessUnitBytes = 1
	au, err := d.Decode(&rtp.Packet{Header: rtp.Header{SequenceNumber: 1, Marker: true}, Payload: []byte{0x65}})
	require.NoError(t, err)
	_, err = d.Decode(&rtp.Packet{Header: rtp.Header{SequenceNumber: 2, Marker: true}, Payload: nil})
	require.Error(t, err)
	require.Equal(t, [][]byte{{0x65}}, au)
}

func TestDecoderStrictInvalidLimits(t *testing.T) {
	maxInt := int(^uint(0) >> 1)
	for field := 0; field < 4; field++ {
		for _, bad := range []int{0, -1, maxInt} {
			v := DecoderLimits{12, 3, 2, 2}
			switch field {
			case 0:
				v.MaxAccessUnitBytes = bad
			case 1:
				v.MaxPacketsPerAccessUnit = bad
			case 2:
				v.MaxFragmentsPerNAL = bad
			case 3:
				v.MaxNALUsPerAccessUnit = bad
			}
			if field == 1 && bad == maxInt {
				continue
			} // packet count has no multiplied arithmetic
			d := Decoder{Limits: &v}
			require.Error(t, d.Init())
		}
	}
}

func TestDecoderStrictPacketBudgetAndFragmentClear(t *testing.T) {
	v := DecoderLimits{64, 2, 8, 4}
	d := Decoder{Limits: &v}
	require.NoError(t, d.Init())
	for i := 0; i < 3; i++ {
		_, err := d.Decode(&rtp.Packet{Header: rtp.Header{SequenceNumber: uint16(i), Marker: true}, Payload: []byte{0x7c, map[bool]byte{true: 0x85, false: 5}[i == 0]}})
		if i < 2 {
			require.Equal(t, ErrMorePacketsNeeded, err)
		} else {
			require.Error(t, err)
			require.True(t, d.terminal)
		}
	}
	for _, ref := range d.fragments[:cap(d.fragments)] {
		require.Nil(t, ref)
	}
	legacy := Decoder{}
	require.NoError(t, legacy.Init())
	legacy.fragments = [][]byte{{1}, {2}, {3}}
	legacy.resetFragments()
	for _, ref := range legacy.fragments[:cap(legacy.fragments)] {
		require.Nil(t, ref)
	}
}

func TestDecoderStrictSplitDescriptorBound(t *testing.T) {
	d := Decoder{Limits: &DecoderLimits{64, 4, 4, 1}}
	require.NoError(t, d.Init())
	d.fragments = [][]byte{{0x65, 0, 0, 1, 0x61}}
	d.fragmentsSize = 5
	_, err := d.splitFragments()
	require.Error(t, err)
}

func TestDecoderStrictRequiresSuccessfulInit(t *testing.T) {
	for _, v := range []DecoderLimits{{}, {12, 3, 2, 2}} {
		d := Decoder{Limits: &v}
		// Nil packet proves rejection precedes payload/header access.
		_, err := d.Decode(nil)
		require.Error(t, err)
		require.True(t, d.terminal)
		require.Zero(t, d.packets)
		require.Nil(t, d.fragments)
		require.Nil(t, d.frameBuffer)
		require.Error(t, d.Init())
	}
}

func TestDecoderStrictInvalidModeNoRevival(t *testing.T) {
	v := DecoderLimits{12, 3, 2, 2}
	d := Decoder{Limits: &v, PacketizationMode: 2}
	require.Error(t, d.Init())
	require.True(t, d.terminal)
	d.PacketizationMode = 1
	d.Limits = nil
	require.Error(t, d.Init())
	_, err := d.Decode(nil)
	require.Error(t, err)
	require.Zero(t, d.packets)
	require.Nil(t, d.frameBuffer)
}

func TestDecoderStrictTrailingSEIReset(t *testing.T) {
	for _, tc := range []struct {
		name    string
		packets int
	}{{"eight-packets", 8}, {"one-packet", 1}} {
		t.Run(tc.name, func(t *testing.T) {
			d := Decoder{Limits: &DecoderLimits{MaxAccessUnitBytes: 64, MaxPacketsPerAccessUnit: tc.packets, MaxFragmentsPerNAL: 1, MaxNALUsPerAccessUnit: 4}}
			require.NoError(t, d.Init())
			packet := func(seq uint16, ts uint32, nal byte) *rtp.Packet {
				return &rtp.Packet{Header: rtp.Header{SequenceNumber: seq, Timestamp: ts, Marker: true}, Payload: []byte{nal}}
			}
			au, err := d.Decode(packet(1, 100, 0x65))
			require.NoError(t, err)
			require.Equal(t, [][]byte{{0x65}}, au)
			au, err = d.Decode(packet(2, 100, 0x06))
			require.ErrorIs(t, err, ErrMorePacketsNeeded)
			require.Nil(t, au)
			au, err = d.Decode(packet(3, 200, 0x65))
			require.NoError(t, err)
			require.Equal(t, [][]byte{{0x65}}, au)
			require.False(t, d.terminal)
		})
	}
}
