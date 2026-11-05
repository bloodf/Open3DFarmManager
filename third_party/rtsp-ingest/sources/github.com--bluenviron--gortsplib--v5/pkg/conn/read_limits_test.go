// Source-only tests: UNRUN. Original MIT-licensed contributions.
package conn

import (
	"bufio"
	"github.com/bluenviron/gortsplib/v5/pkg/base"
	"io"
	"strings"
	"testing"
)

func TestConnLimitsSnapshot(t *testing.T) {
	limits := base.ReadLimits{MaxBodyBytes: 3}
	c := NewConnWithLimits(bufio.NewReader(strings.NewReader("RTSP/1.0 200 OK\r\nContent-Length: 4\r\n\r\nxxxx")), io.Discard, limits)
	limits.MaxBodyBytes = 8
	if _, err := c.Read(); err == nil {
		t.Fatal("limit not applied")
	}
	if _, err := NewConnWithLimits(nil, io.Discard, base.ReadLimits{}).Read(); err == nil {
		t.Fatal("invalid options read input")
	}
}

func TestConnLimitedControlAndRequest(t *testing.T) {
	for _, msg := range []string{"RTSP/1.0 200 OK\r\n\r\n", "OPTIONS * RTSP/1.0\r\n\r\n"} {
		if _, err := NewConnWithLimits(bufio.NewReader(strings.NewReader(msg)), io.Discard, base.ReadLimits{MaxBodyBytes: 1}).Read(); err != nil {
			t.Fatal(err)
		}
	}
}
