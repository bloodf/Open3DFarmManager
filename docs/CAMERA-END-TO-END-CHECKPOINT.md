# Camera end-to-end checkpoint

Live camera video travels from a local RTSP source to the browser over the existing browser-to-Connector WebRTC peer. There is no TURN, no server media path and no HTTP fallback. Refs #2, #8, #9.

## Path

1. **RTSP source.** The `rtsp` simulator profile (MediaMTX, `infra/sim/docker-compose.yml`) publishes a 320 × 240, 5 fps H.264 test pattern over RTSP/TCP. Production cameras use the same profile: one H.264 packetization-mode 1 video track with in-band SPS/PPS.
2. **Ingest helper.** The Connector resolves an opaque handle to a literal IP, port and path from its private runtime configuration and starts `tools/rtsp-ingest` through the attested supervisor (`openHelperSource`). The helper speaks RTSP/TCP, validates SDP/RTP, and emits bounded Annex B access units with one outstanding credit.
3. **Connector media track.** `ConnectorCameraMedia` (`packages/connector/src/camera/camera-media.ts`) reserves an H.264 `SendOnly` track (MID `camera`, PT 102) and a `camera-purpose-v3` data channel before the offer. `startCameraSession` copies each access unit and hands it to the libdatachannel H.264 packetizer. This is passthrough: no decoding or transcoding. The RTP timestamp derives from the helper's stream clock.
4. **Browser.** `BrowserCameraMedia` (`apps/farm/app/utils/webrtc/camera-media.ts`) receives the track and attaches a `MediaStream` to a `<video>` element, via `CameraDisplay.vue`, only after authorization.

MediaMTX advertises out-of-band `sprop-parameter-sets` and starts each new reader mid-GOP. The helper now accepts a strictly base64, bounded `sprop-parameter-sets` value without using it. It drops at most 128 leading non-IDR access units before the first in-band SPS/PPS/IDR. In-band parameter sets are still required, and the helper's dependencies and `third_party/` are unchanged.

## Authorization

Media requires a camera-purpose V3 statement signed by both ends, after both RTC role proofs of the admitted v2 assignment binding.

- After verification, the Connector picks the first configured camera whose assignment is in the admitted assignment set. It derives the statement from the binding with `cameraStatementFromBinding`, which copies the transport, identities, nonces, SDP hashes, DTLS fingerprints, assignment digest and lifetime, then adds `camera_id`, `printer_id` (the assignment id), `video_mid` and a random `lease_ref`. It sends its Ed25519 signature over that statement. Camera proofs sign under their own domain, `Open3DFarmManager/camera-purpose-proof/v1\0<role>\0`, so they cannot collide with any RTC session proof version.
- The browser rebuilds the expected statement from its own admitted binding and takes only the four camera fields from the offer. It requires `printer_id` to be an assignment the view authorized and `video_mid` to match the actual transceiver MID. It verifies the Connector key from the binding, then countersigns with the non-extractable P-256 device key.
- The Connector verifies the browser signature against its own offered statement and the binding's browser key. Only then does it acquire a session slot and start the helper. Before that point no source is opened and no access unit exists.
- Any malformed, early, repeated or wrongly signed frame closes the whole peer (fail closed). A missing camera leaves the channel idle.
- Declining is camera-only. When the offer names an assignment the view did not authorize, or the browser has no camera consumer, the browser closes only the `camera-purpose-v3` channel. The Connector then ends that camera without opening a source, and the status peer stays verified. Closing the camera channel never closes the peer on either side.
- The helper's `isAdmitted` check requires an unaborted lease, live camera media and an unexpired admitted binding on the monotonic and wall clocks.
- Camera freshness is bounded by the server-admitted binding (at most 30 s). Video stops when that binding expires, independently of the offline status tracker.
- Revocation is `peer.close()` on either side. The Connector's `stop()` synchronously aborts the lease, stops the session and closes the track. The supervisor then stops and reaps the helper. The browser's `stop()` synchronously detaches the stream, as `CameraDisplay` does.
- The browser never receives the RTSP address, path or any credential. The configuration rejects host names, `@`, query and fragment, and the statement carries only opaque ids.

## Bounds

| Resource                   | Bound                                                                    |
| -------------------------- | ------------------------------------------------------------------------ |
| Session lifetime           | Equal to the RTC binding, at most 30 s; renewal is a new RTC session     |
| Concurrent camera sessions | `camera.maxSessions`, 1–4 per Connector (default 1); one camera per peer |
| Access unit                | 256 KiB; Annex B; strictly increasing timestamps                         |
| Rate                       | 30 access units/s and 1 MiB/s (about 8 Mbit/s); 64 MiB per session       |
| Helper                     | 2 s per access unit, 30 s lease, 16 MiB per lease, 16 KiB stderr         |
| Browser loading            | 10 s (`CAMERA_LOADING_TIMEOUT_MS`), then error and detach                |
| Camera proof frame         | 8 KiB canonical JSON; one offer and one answer per peer                  |

The first keyframe must arrive within the helper's 2 s per-unit deadline, so cameras need a keyframe interval of about 2 s or less. Configured sources must be loopback, private or link-local literal addresses. Zone ids, IPv4-mapped or dotted IPv6 forms, `.255` broadcast addresses and the cloud metadata endpoints `169.254.169.254` and `fd00:ec2::254` are rejected. Frame dimensions are not parsed on the Connector. The access-unit byte bound limits them indirectly, and the browser decoder enforces its own limits.

## Failure states (pt-BR)

`CameraDisplay.vue` already provides the user-facing states:

- loading: "Carregando câmera…"
- error: "Não foi possível exibir a câmera. A visualização foi encerrada."
- unavailable: "Câmera indisponível."
- live: "Câmera ao vivo."

## Farm view

The browser signalling client takes an opt-in camera hooks factory per peer. The farm status feed builds `BrowserCameraMedia` authorized only for that feed's server assignment refs. It publishes `{ assignmentId, stream }` and always publishes `null` on revocation. `useFarmView` keeps the streams outside the farm-view state machine. `farm.vue` mounts `CameraDisplay` for each active assignment whose Connector is approved; the pause control is unchanged. The region and video are named per printer. The video is muted, has no `autoplay` attribute and starts through `play()` only after authorization. With `prefers-reduced-motion: reduce`, the image starts only after the user presses "Mostrar imagem ao vivo".

## Configuration (opt-in)

The camera section is absent by default. When it is absent, the Connector adds no track, no channel and no helper.

```json
"camera": {
  "helper": { "path": "/abs/path/rtsp-ingest", "sha256": "<hex>" },
  "maxSessions": 1,
  "cameras": [
    {
      "cameraId": "cam-1",
      "assignmentId": "<runtime assignment uuid>",
      "source": { "address": "192.0.2.10", "port": 8554, "path": "/stream" }
    }
  ]
}
```

## Evidence

- `node --test tests/node/camera-media.test.ts tests/node/camera-runtime-config.test.ts` covers the offer and countersign ordering, wrong keys, early or repeated frames, unassigned cameras, slot exhaustion, synchronous revocation and config rejection.
- `go test ./...` in `tools/rtsp-ingest` covers bounded sprop acceptance and the bounded bootstrap skip.
- The gated native interop test `packages/webrtc-experiment/real-identity/camera-rtsp.interop.test.ts` ran on Linux amd64 against the `rtsp` simulator profile, with Node 24.22.2, libdatachannel 0.24.6 and Chromium 158.0.8127.18. Each run declined an unauthorized assignment without starting the helper while the status peer stayed verified, decoded 15 distinct 320 × 240 frames in Chromium from 15 access units sent, checked that browser state held no source location, and showed a synchronous terminal track on revocation, a detached browser video and stable counters for 500 ms. Afterwards no helper process remained.

## Remaining

- Real farm-page acceptance with video playing through the authenticated HTTPS signalling harness (Postgres, built app, Connector child with camera config).
- Native NACK/RTCP handling for lossy networks, cross-network NAT and physical cameras are untested. The Connector peer still binds to loopback.
- Native, process-wide memory and CPU bounds are not measured.
