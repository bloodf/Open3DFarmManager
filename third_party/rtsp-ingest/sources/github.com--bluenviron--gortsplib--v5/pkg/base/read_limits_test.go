// Source-only tests: UNRUN. Original MIT-licensed contributions.
package base

import (
	"bufio"
	"strings"
	"testing"
)

func TestReadLimitsValidation(t *testing.T) {
	for _, n := range []int{0, -1, 128*1024 + 1, int(^uint(0) >> 1)} {
		var req Request
		if err := req.UnmarshalWithLimits(nil, ReadLimits{MaxBodyBytes: n}); err == nil {
			t.Fatal(n)
		}
		var res Response
		if err := res.UnmarshalWithLimits(nil, ReadLimits{MaxBodyBytes: n}); err == nil {
			t.Fatal(n)
		}
	}
}

func TestReadLimitsBodies(t *testing.T) {
	for _, start := range []string{"RTSP/1.0 200 OK\r\n", "OPTIONS * RTSP/1.0\r\n"} {
		for _, tc := range []struct {
			headers, body string
			wantErr       bool
		}{
			{"", "", false},
			{"Content-Length: 0\r\n", "", false},
			{"Content-Length: 3\r\n", "abc", false},
			{"Content-Length: 4\r\n", "", true},
			{"Content-Length: 3\r\nContent-Length: 3\r\n", "abc", true},
			{"Content-Length: bad\r\n", "", true},
			{"Content-Length: 18446744073709551616\r\n", "", true},
			{"Content-Length: 3\r\n", "ab", true},
		} {
			br := bufio.NewReader(strings.NewReader(start + tc.headers + "\r\n" + tc.body))
			var err error
			if strings.HasPrefix(start, "RTSP") {
				var res Response
				err = res.UnmarshalWithLimits(br, ReadLimits{3})
			} else {
				var req Request
				err = req.UnmarshalWithLimits(br, ReadLimits{3})
			}
			if (err != nil) != tc.wantErr {
				t.Fatalf("%q: %v", tc.headers, err)
			}
		}
	}
}

func TestReadLimitsRejectBeforeBodyMutation(t *testing.T) {
	b := body("old")
	br := bufio.NewReader(strings.NewReader("payload"))
	limits := ReadLimits{3}
	if err := b.unmarshalWithLimits(Header{"Content-Length": {"4"}}, br, &limits); err == nil {
		t.Fatal("accepted")
	}
	if string(b) != "old" {
		t.Fatal("allocated or mutated body before cap")
	}
	ch, err := br.ReadByte()
	if err != nil || ch != 'p' {
		t.Fatal("read body before cap")
	}
}

func TestLegacyDuplicateLengthUnchanged(t *testing.T) {
	var res Response
	if err := res.Unmarshal(bufio.NewReader(strings.NewReader("RTSP/1.0 200 OK\r\nContent-Length: 1\r\nContent-Length: 1\r\n\r\nx"))); err != nil || res.Body != nil {
		t.Fatal(err)
	}
}
