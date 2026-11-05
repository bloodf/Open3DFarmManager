// Source-only tests: UNRUN. Original MIT-licensed contributions.
package sdpunmarshaler

import (
	"github.com/pion/sdp/v3"
	"reflect"
	"strings"
	"testing"
)

func testLimits() Limits { return Limits{16384, 2048, 64, 1, 1, 32} }

func TestLimitsValidation(t *testing.T) {
	for field := 0; field < 6; field++ {
		for _, n := range []int{0, -1, int(^uint(0) >> 1)} {
			l := testLimits()
			reflect.ValueOf(&l).Elem().Field(field).SetInt(int64(n))
			if _, err := UnmarshalWithLimits(nil, l); err == nil {
				t.Fatalf("field %d=%d", field, n)
			}
		}
	}
}

func TestLimitsBoundaries(t *testing.T) {
	valid := "v=0\ns=x\nt=0 0\nm=video 0 RTP/AVP 96\na=rtpmap:96 H264/90000\n"
	legacy, err := Unmarshal([]byte(valid))
	if err != nil {
		t.Fatal(err)
	}
	limited, err := UnmarshalWithLimits([]byte(valid), testLimits())
	if err != nil || !reflect.DeepEqual(legacy, limited) {
		t.Fatal(err)
	}
	l := testLimits()
	l.MaxBodyBytes = len(valid)
	l.MaxLineBytes = 30
	l.MaxLines = 5
	l.MaxAttributes = 1
	if _, err = UnmarshalWithLimits([]byte(valid), l); err != nil {
		t.Fatal(err)
	}
	for _, text := range []string{valid + "\n", valid + "m=video 0 RTP/AVP 96\n", strings.Replace(valid, "AVP 96", "AVP 96 97", 1), valid + strings.Repeat("a=x\n", 32)} {
		if _, err = UnmarshalWithLimits([]byte(text), testLimits()); err == nil && text != valid+"\n" {
			t.Fatal("accepted amplification")
		}
	}
	l.MaxBodyBytes = len(valid) - 1
	if _, err = UnmarshalWithLimits([]byte(valid), l); err == nil {
		t.Fatal("body bound")
	}
	l = testLimits()
	l.MaxLineBytes = 4
	if _, err = UnmarshalWithLimits([]byte(valid), l); err == nil {
		t.Fatal("line bound")
	}
	l = testLimits()
	l.MaxLines = 4
	l.MaxAttributes = 4
	if _, err = UnmarshalWithLimits([]byte(valid), l); err == nil {
		t.Fatal("line count")
	}
}

func TestStructuralChecksBeforeAppend(t *testing.T) {
	b := &parseBudget{limits: testLimits()}
	s := &sdp.SessionDescription{}
	if err := unmarshalMediaDescription(s, "video 0 RTP/AVP 96", b); err != nil {
		t.Fatal(err)
	}
	if err := unmarshalMediaDescription(s, "video 0 RTP/AVP 96", b); err == nil || len(s.MediaDescriptions) != 1 {
		t.Fatal("media appended")
	}
	b.limits.MaxAttributes = 1
	if err := unmarshalMediaAttribute(s, "x", b); err != nil {
		t.Fatal(err)
	}
	if err := unmarshalMediaAttribute(s, "y", b); err == nil || len(s.MediaDescriptions[0].Attributes) != 1 {
		t.Fatal("attribute appended")
	}
	b.ancillary = b.limits.MaxLines
	if err := unmarshalMediaBandwidth(s, "AS:1", b); err == nil || len(s.MediaDescriptions[0].Bandwidth) != 0 {
		t.Fatal("ancillary appended")
	}
}

func TestAncillaryAmplification(t *testing.T) {
	l := testLimits()
	for _, text := range []string{
		"v=0\nz=" + strings.Repeat("0 0 ", 65) + "\n",
		"v=0\nt=0 0\nr=1 1 " + strings.Repeat("0 ", 65) + "\n",
		"v=0\nm=video 0 " + strings.Repeat("RTP/", 65) + "AVP 96\n",
	} {
		if _, err := UnmarshalWithLimits([]byte(text), l); err == nil {
			t.Fatal("ancillary amplification")
		}
	}
}
