# Bounded RTSP ingest

The isolated helper has passed a bounded Darwin ARM64 loopback test with a synthetic access unit. This proves helper/RTSP/supervisor interoperability for that fixture, not decoded video or production camera integration. No physical printer was used.

The input is private stdin: a strict versioned configuration of at most 2048 bytes, followed by EOF. The Connector resolves an opaque source handle locally and grants a nonrenewable lease of at most 30 seconds. The helper's entry deadline starts before the read. The destination is an explicit literal unicast IP and port with an RTSP path; DNS, credentials, TLS, query, fragment and multicast are excluded. A configured literal loopback simulator is permitted. Browser input does not supply source authority.

The profile uses one TCP RTSP connection and one H.264/90000 video track, packetization mode 1, with in-band SPS/PPS. Redirects, authentication, alternate destinations, additional tracks, reordering and unsupported SDP are terminal. It uses bounded SDP, wire, RTP and access-unit limits. The strict upstream decoder alone owns access-unit lifecycle and completion, including suppressed SEI; independent guards own wire, rate, sequence, SSRC and payload-type policy. There is no UDP, reconnection or HTTP command fallback. The Connector retains safety enforcement and browser-to-Connector WebRTC remains the live transport.

The private output protocol uses bounded Annex B records with version, flags and RTP-derived timestamps. An inherited control descriptor grants one outstanding access unit; EOF, invalid credit and pressure terminate the helper. Diagnostics contain fixed messages only. The Connector must independently enforce lease revocation, close pipes, stop and reap the child. These checks do not establish a process-wide memory or CPU limit.

## Verified local checkpoints

The reviewed offline Darwin build used Go 1.27.1, local pinned module replacements and an OS profile denying network access. Compiler-selected source and link inputs were recorded with the retained module and toolchain notices. No module download occurred. Linux execution, reproducible builds and distribution clearance remain pending.

One corrected real loopback test passed at source `433a1cc4d5d419a02db62470bd6d32dc0c0483fd`. It reused the original helper executable and replaced only the fixture executable after correcting three handler path comparisons from `fixture` to `/fixture`. The earlier failed run and both original binaries were preserved.

The test asserted one accepted connection, one PLAY and one access unit, exact Annex B bytes/keyframe/timestamp, bounded packets and wire bytes, cancellation, helper exit and the complete fixture summary followed by EOF. Both controlled processes exited zero, the helper was absent and both checked loopback ports were closed. The synthetic H.264 header access unit is not proof of browser decoding or moving video.

After root integration, repository formatting preserved the parsed operator/child structure and literal values of the original TypeScript/JavaScript files. All 66 supervisor/reader tests passed under a network-denying OS profile, and the seven owned TypeScript/checked-JavaScript files passed strict typing. These tests use finite local child fixtures and are included in `bun run check:all` through `test:rtsp-supervisor`. They do not execute the Go binaries or open an RTSP listener.

The audited upstream sources and notices are excluded from formatting so their manifest hashes remain intact. Verify them with `python3 third_party/rtsp-ingest/verify.py`.

## Remaining integration

Genuine authorized camera composition, moving encoded video through RTSP and native WebRTC to browser decoding, Linux process isolation and the MediaMTX source-to-image decision remain separate gates. Native pressure, process-wide memory and CPU bounds are not established by the finite fixture. Actual helper/network runs remain opt-in. Run `bun run check:all` on the final integrated source before publication; publication itself remains unauthorized.
