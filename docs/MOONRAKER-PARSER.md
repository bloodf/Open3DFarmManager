# Read-only Moonraker parser

This component prepares part of E5.1a. It consumes supplied strings and returns normalized telemetry. It has no HTTP client, WebSocket, printer discovery, subscriptions, authentication or command dispatcher. The fixture is original synthetic data, not a capture from a printer.

The HTTP envelope and queried objects follow the [Moonraker API introduction](https://moonraker.readthedocs.io/en/latest/external_api/introduction/); field meanings are described by the [Klipper status reference](https://www.klipper3d.org/Status_Reference.html). Upstream implementations have not been copied into this MIT repository.

`parseMoonrakerServerInfo()` returns readiness only when Klippy is both connected and ready. `parseMoonrakerSnapshot()` requires a complete object query containing webhooks, print statistics and virtual-SD progress. It projects supported fields and discards unrelated metadata. The parser maps standby, completed and cancelled jobs to the current coarse `idle` state, preserving reported progress. It does not assert that the bed is clear or that a printer is safe to start. A Klippy error or shutdown takes precedence over stale job status; startup maps to unavailable/offline.

The response's `eventtime` is retained as source metadata and is never treated as a wall-clock timestamp. The Connector must supply the local `observedAt` when receiving a response. This parser does not establish freshness, order incremental updates or detect a disconnected transport. Those responsibilities remain with the future connection lifecycle.

Messages exceeding 256 KiB, invalid JSON, remote errors, ambiguous error/result envelopes, JSON-RPC envelopes, incomplete objects, unknown state values and invalid numeric bounds are rejected. JSON-RPC needs request-ID matching and is intentionally outside this HTTP parser. Unknown upstream metadata is ignored for compatibility. Error messages contain only local error codes, not upstream payloads. A failure produces no fabricated telemetry; the caller must retain the old observation time and expose failure or staleness.

The future network layer must enforce the byte limit while reading, before buffering, and check HTTP status and origin. Duplicate JSON property detection, subscription delta merging, authentication, webcam discovery and actual simulator interoperability remain pending. Unit tests validate synthetic parsing behavior only and provide no authorization or physical safety guarantees.
