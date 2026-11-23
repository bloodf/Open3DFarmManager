# RTC backend decision (issue 360)

## Problem

Every Connector RTC peer (`webrtc/pause-control-peer.ts`,
`configuration-peer.ts`, `readonly-peer.ts`, and the camera path in
`camera/camera-media.ts` and `camera-runtime.ts`) uses `node-datachannel@0.33.6`.
The package has no install script. Its native binary comes from an optional
platform package such as `@node-datachannel/linux-x64-gnu@0.33.6` (about 9 MB).
When a registry mirror lacks that package, npm skips it silently and every RTC
path fails at the first browser connection. Building from source needs network
access for the cmake-js headers and the libdatachannel submodules.

## What ships now: startup probe and read-only degraded mode

`webrtc/rtc-backend.ts` loads the native module once at agent startup and
reports a fixed vocabulary:

| `backend`          | `mode`               | `reason`                                        |
| ------------------ | -------------------- | ----------------------------------------------- |
| `node-datachannel` | `direct`             | none                                            |
| `none`             | `read-only-degraded` | `native-binary-missing` or `native-load-failed` |

The probe never exposes an error message or a file path. The result is:

- emitted as one `rtc-backend` diagnostic when `run` starts;
- shown on the local status page and in `/status` JSON (`rtc` field, and a
  "Backend WebRTC" row on the page) when `--status-port` is set.

In `read-only-degraded` mode the agent skips the signalling lifecycle and the
camera media factory. Moonraker/printer collection, the durable telemetry queue
and drain, credential renewal, the local status page and the offline authority
(which stays stale, so pause commands are refused) keep working. No browser RTC
session is offered: pause, configuration, farm view and cameras are
unavailable until the native module loads. This is a degraded mode, not a
substitute transport.

Protections are unchanged: every peer keeps `iceServers: []` (no STUN, no
TURN), `disableFingerprintVerification: false`, loopback bind by default,
`enableIceTcp: false`, signed authorization and certificate fingerprint pinning.
No WebSocket or HTTP command or media relay is built, by decision.

## Decision on a second backend: `werift`, not adopted yet

`werift` (pure TypeScript: ICE, DTLS, SCTP data channels, RTP/RTCP, H.264
payloading) is the only candidate that could remove the native dependency while
keeping a direct, DTLS-pinned peer. Adopting it would require a dependency change and renewed security and
interoperability review. No `werift` code was added, and no werift limit has
been measured; this document records a candidate, not an adopted backend.

### Connector requirements to check against `werift`

The list comes from the `node-datachannel` calls the peers make today.

| Requirement                                                                                  | Used by           | Status for `werift`                            |
| -------------------------------------------------------------------------------------------- | ----------------- | ---------------------------------------------- |
| `iceServers: []`, no TURN, no STUN                                                           | all peers         | to verify: gathering with no servers           |
| Bind ICE to one literal address (`bindAddress`, loopback default)                            | all peers         | to verify: per-peer interface restriction      |
| ICE over UDP only (`enableIceTcp: false`)                                                    | all peers         | to verify                                      |
| Read the actual remote DTLS fingerprint (`remoteFingerprint()`) and pin it to the signed SDP | all peers         | to verify: API for the remote leaf certificate |
| Manual negotiation (`disableAutoNegotiation`, explicit local/remote descriptions)            | all peers         | to verify                                      |
| Ordered reliable channels, `maxMessageSize` per channel family (proof wire, frame limits)    | all peers         | to measure: SCTP max message size and refusal  |
| `bufferedAmount()` and `onBufferedAmountLow` back-pressure                                   | read-only peer    | to verify                                      |
| Selected candidate pair (`getSelectedCandidatePair`) to prove no relay                       | read-only peer    | to verify                                      |
| Send-only H.264 track from RTP packets (`H264RtpPacketizer`, SSRC, media handler)            | `camera-media.ts` | to verify: payload type, SPS/PPS, keyframes    |

### Measurements required before adoption

Run the same RTC suites against both backends in a disposable loopback
harness, and record in this file: handshake time, maximum accepted and refused
message sizes, throughput and back-pressure at the Connector frame limits,
H.264 keyframe interval and latency, CPU and resident memory for one camera
and for the full peer set, and the exact behavior when the remote fingerprint
differs from the signed one. If any requirement above cannot be met, the
fallback is this degraded mode, not a relay.

## Acceptance state

- Startup probe and status backend: done and covered by
  `tests/node/e16-360.test.mjs`.
- Read-only degraded mode with a clear status: done.
- Pause control, configuration and farm view passing in system Chrome with the
  native package absent: not met. It needs a second direct backend. Deferred to
  the dependency change after the npm migration.
- RTC suites against both backends: not run, for the same reason.
- Playwright scenario `tests/e2e/connector-rtc-backend-status.spec.ts` (local
  status page names the degraded backend in system Chrome) is written and runs
  with the single combined Playwright run, which is deferred.
