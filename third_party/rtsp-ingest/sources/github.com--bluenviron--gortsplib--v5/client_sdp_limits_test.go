// Source-only tests: UNRUN. Requires combined P1/P3 patch. Original MIT contributions.
package gortsplib

import (
	"github.com/bluenviron/gortsplib/v5/pkg/base"
	"github.com/bluenviron/gortsplib/v5/pkg/sdpunmarshaler"
	"testing"
)

func TestClientSDPBoundsRejectBeforeStart(t *testing.T) {
	for _, c := range []*Client{
		{ReadLimits: &base.ReadLimits{MaxBodyBytes: 128*1024 + 1}},
		{SDPLimits: &sdpunmarshaler.Limits{MaxBodyBytes: 16384, MaxLineBytes: 2048, MaxLines: 2, MaxMediaDescriptions: 3, MaxFormatsPerMedia: 1, MaxAttributes: 1}},
	} {
		if err := c.Start(); err == nil {
			c.Close()
			t.Fatal("accepted invalid configuration")
		}
		if c.ctx != nil {
			t.Fatal("started before limits validation")
		}
	}
}
