// Local limit additions are original MIT-licensed contributions.
package base

import "fmt"

// ReadLimits bounds RTSP bodies; header and interleaved limits are unchanged.
type ReadLimits struct {
	MaxBodyBytes int
}

// Validate checks opt-in limits without reading input.
func (l ReadLimits) Validate() error {
	if l.MaxBodyBytes <= 0 || l.MaxBodyBytes > rtspMaxBodySize {
		return fmt.Errorf("MaxBodyBytes must be in 1..%d", rtspMaxBodySize)
	}
	return nil
}
