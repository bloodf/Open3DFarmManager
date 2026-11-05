// SPDX-License-Identifier: MIT

// Package rtspfixture contains a finite loopback-only ingest test fixture.
package rtspfixture

// Original synthetic NAL units exercise header-level ingest only. They are not
// a claim of decodable video. Parameter sets appear in RTP, never in SDP.
func HeaderAU() [][]byte {
	return [][]byte{{0x67, 0x42, 0xe0, 0x1f, 0xaa}, {0x68, 0xce, 0x06}, {0x65, 0x88, 0x84}}
}

// HeaderAnnexB is the exact canonical Annex B output expected from HeaderAU.
func HeaderAnnexB() []byte {
	return []byte{0, 0, 0, 1, 0x67, 0x42, 0xe0, 0x1f, 0xaa, 0, 0, 0, 1, 0x68, 0xce, 0x06, 0, 0, 0, 1, 0x65, 0x88, 0x84}
}
