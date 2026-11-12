# Read-only Moonraker parser

This component prepares part of E5.1a. It consumes supplied strings and returns normalized telemetry. It has no HTTP client, WebSocket, printer discovery, subscriptions, authentication or command dispatcher. The fixture is original synthetic data, not a capture from a printer.

The HTTP envelope and queried objects follow the [Moonraker API introduction](https://moonraker.readthedocs.io/en/latest/external_api/introduction/); field meanings are described by the [Klipper status reference](https://www.klipper3d.org/Status_Reference.html). Upstream implementations have not been copied into this MIT repository.

`parseMoonrakerServerInfo()` returns readiness only when Klippy is both connected and ready. `parseMoonrakerSnapshot()` requires a complete object query containing webhooks, print statistics and virtual-SD progress. It projects supported fields and discards unrelated metadata. The parser maps standby, completed and cancelled jobs to the current coarse `idle` state, preserving reported progress. It does not assert that the bed is clear or that a printer is safe to start. A Klippy error or shutdown takes precedence over stale job status; startup maps to unavailable/offline.

The response's `eventtime` is retained as source metadata and is never treated as a wall-clock timestamp. The Connector must supply the local `observedAt` when receiving a response. This parser does not establish freshness, order incremental updates or detect a disconnected transport. Those responsibilities remain with the future connection lifecycle.

Messages exceeding 256 KiB, invalid JSON, remote errors, ambiguous error/result envelopes, JSON-RPC envelopes, incomplete objects, unknown state values and invalid numeric bounds are rejected. JSON-RPC needs request-ID matching and is intentionally outside this HTTP parser. Unknown upstream metadata is ignored for compatibility. Error messages contain only local error codes, not upstream payloads. A failure produces no fabricated telemetry; the caller must retain the old observation time and expose failure or staleness.

The future network layer must enforce the byte limit while reading, before buffering, and check HTTP status and origin. The integrated bounded decoder rejects duplicate JSON properties and excessive structure before schema validation. Subscription delta merging, authentication, webcam discovery and actual simulator interoperability remain pending. Unit tests validate synthetic parsing behavior only and provide no authorization or physical safety guarantees.

## Discovery (E5, identify / multi-tool / webcams)

`discoverMoonraker()` (`discovery.ts`) opens one WebSocket and runs a read-only, sequential handshake: `server.connection.identify`, `server.info`, `printer.objects.list`, `printer.objects.query` (`toolhead.extruder` plus `temperature`/`target` of `extruder`, `extruder1`..`extruderN`) and `server.webcams.list`. Pure parsers live in `discovery-parse.ts`; frame decoding (`frame.ts`) and socket construction (`socket.ts`) are shared with `client.ts`. The origin is validated with `validateMoonrakerInput`, each request is bounded by `requestTimeoutMs` and the whole run by an overall deadline.

- `identify` registers a visible client connection in Moonraker; it changes no printer state.
- If Klippy is not connected and ready after `server.info`, discovery rejects with `not-ready` and does not query Klipper objects (Moonraker answers those with 503).
- Extruder objects are matched by strict name, ordered by index and capped at 16 tools; the object list itself is not count-limited (macro-heavy printers), only byte/value-bounded. The active tool is `toolhead.extruder`.
- Webcams are capped at 8. Moonraker reports root-relative paths such as `/webcam/?action=snapshot`; Mainsail/Fluidd resolve them against the frontend host (typically port 80), not the Moonraker port. Pass that host as `webcamOrigin`. Each webcam returns the raw `streamPath`/`snapshotPath` (root-relative only) and `streamUrl`/`snapshotUrl`, which are resolved only against `webcamOrigin` and are `null` without it. Absolute URLs are accepted only for exactly `webcamOrigin`; protocol-relative, non-http(s), userinfo, control-character, backslash and over-long values are dropped. Discovering which frontend host serves the cameras is not implemented.
- Malformed entries are dropped, malformed envelopes reject with `invalid-response`. A remote error on `server.webcams.list` means no webcam support and yields an empty list. Snapshots are never fetched.

Fixtures are hand-written from the Moonraker API documentation, not captured from a simulator or printer; `infra/sim/u1/tools.cfg` defines the four-tool shape.
