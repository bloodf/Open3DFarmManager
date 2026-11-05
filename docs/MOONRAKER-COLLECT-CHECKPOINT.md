# Local Moonraker collection checkpoint

`collect --config <arquivo-privado> --data-dir <diretório-privado>` now runs the Connector's read-only Moonraker subscriptions and persists fresh printer observations in one existing `TelemetryQueue` under the fixed `telemetry` child directory. This command does not initialize an identity, register a printer, reload configuration, send queued records, acknowledge ingestion or expose a browser URL/RPC interface. Existing exported identity `main()` remains synchronous; only direct CLI collection dispatch is asynchronous.

## Private configuration

The strict version 1 JSON document contains `version: 1`, `allowedOrigins`, `printers` and optional `limits`. Each of the 1–16 printers has only `{ printerKey, origin }`. The allowlist has 1–16 origin strings and is independent of printer keys. Every assignment and allowlist entry is validated before opening a queue or starting any connection. Unknown fields, duplicate JSON properties, duplicate exact printer keys and unlisted origins fail closed.

Printer keys remain opaque, case-sensitive values of 1–128 UTF-16 code units with valid PostgreSQL UTF-8 representability. NUL and unpaired surrogates are rejected; valid astral pairs, slashes and case are preserved. Keys are never derived from endpoints or discovery. This is a trusted local configuration contract, not a migration 0015 assignment UUID or proof of current cloud ownership. Configuration loading and the separate server assignment lifecycle still need integration.

The file must be a private regular file owned by the current user with one link. Final symlinks, FIFOs, devices, shared permission bits and hardlinks fail. `lstat` precedes `open` to avoid FIFO blocking; `O_NOFOLLOW | O_NONBLOCK`, descriptor metadata and inode/device checks protect the opened descriptor. Reads stop after at most 64 KiB plus one overflow byte, even if the file grows. UTF-8 decoding is fatal, and bounded JSON parsing precedes schema validation. This private-file implementation fails closed on Windows; a Windows ownership/ACL implementation is not supplied.

Timing defaults are 5 seconds each for connection and request deadlines, 30 seconds for staleness, and reconnect delays between 1 and 30 seconds. Optional timing values must be integer milliseconds between 100 and 300000; staleness must be at least 1000 and the retry minimum cannot exceed its maximum. Accepted message bytes default to 256 KiB and may be configured between 256 bytes and 256 KiB. Up to 16 printers therefore share one queue while maintaining at most one socket and one pending RPC per printer.

## Persistence and shutdown

The queue opens before any subscription. Recovery losses are reported before collection starts. Snapshot callbacks synchronously call the existing durable enqueue; a `queued` diagnostic is emitted only after enqueue has returned from its write and fsync. An unavailable event emits only a local diagnostic, without inventing progress or enqueuing a fabricated printer state. A queue write failure aborts every subscription, joins their socket closure, closes the queue and exits nonzero. SIGINT and SIGTERM use the same cancellation and joining path, and their listeners are removed afterward. Stale queue locks are never deleted automatically.

Diagnostics use a fixed schema without printer keys, endpoints, private paths or upstream error text. At most 1024 ordinary diagnostic lines are emitted per run, followed by one final aggregate summary. Collection continues after the ordinary-line budget is exhausted. Subsequent retention losses accumulate in the shutdown summary rather than producing unlimited terminal output. `queued` means local persistence, never cloud acceptance. The existing queue's 50 MiB and 24-hour retention bounds still apply; this command does not add a sender or alter queue recovery semantics.

## Bounded WebSocket transport

This transport supersedes the native WebSocket receive limitation and dependency description in the earlier `MOONRAKER-CLIENT-CHECKPOINT.md`.

The Connector directly pins `ws@8.22.1`; the audited `@types/ws@8.18.2` declarations are development-only. Both exact packages are MIT and their complete notices were appended to `THIRD_PARTY.md`. The existing notices remain intact. The Connector build script additionally copies the exact `ws` notice into `WS-LICENSE`; redistribution must retain it alongside the existing distribution notices.

The module sets `WS_NO_BUFFER_UTIL=1` and `WS_NO_UTF_8_VALIDATE=1` before dynamically importing `ws`. There is no native WebSocket fallback. Compression and redirects are disabled. The receiver enforces `maxPayload` at the configured message cap, plus fixed limits of 128 fragments and 128 buffered chunks. The existing application byte/JSON validation remains in place. These are receiver/message bounds, not a bound on total process RSS, TCP/kernel buffers, all application allocations or operating-system resources. Forced termination replaces a remote closing-handshake wait; the subscription finalizer joins the actual close event, including pre-open, malformed-snapshot and callback-failure paths.

## Evidence and remaining gates

Focused tests run the actual Node 24 CLI against original synthetic Bun loopback services. They reopen the real durable queue after shutdown to verify opaque keys and FIFO state, reject invalid configuration without queue/network creation, reject a FIFO without blocking, simulate an actual append failure by replacing a task-owned queue file, and check all printer sockets stop without another false queued receipt. Other cases check recovery reporting, preserved stale locks, cancellation during upgrade, disabled compression and optional-addon module-load ordering. A separate original Node fixture using the actual `ws` server sends oversized and excessively fragmented messages; both are rejected before an enqueue callback.

The collect-focused command `bun test tests/unit/moonraker-collect.test.ts --max-concurrency 1` passed 8 test groups and 83 assertions. The changed transport regression command `bun test tests/unit/moonraker-client.test.ts --max-concurrency 1` passed 10 groups and 202 assertions. The receive-limit fixture observed the audited receiver close codes, 1009 for payload size and 1008 for fragment count, with no queued records. An owned-file TypeScript check and targeted formatting checks passed. These are source-level results on Node 24.20.0 and Bun 1.4.2, not production bundle execution or a full repository gate.

Genuine pinned Moonraker simulator acceptance, production packaging execution, migration 0015 ownership integration, printer-local authentication, authenticated telemetry sending and the coordinator's full repository gate remain pending. No physical printer, Docker, emulator, PostgreSQL, SSH, production service or publication was used by this slice.

## Coalesced-frame correction

Independent review identified a valid subscription reply and following delta
arriving in one receiver batch before the snapshot promise continuation installed
its baseline. A real Node client regression sends both complete WebSocket frames
in one socket write. Before the correction it lost the delta and repeatedly
reconnected; with `allowSynchronousEvents: false` it observes both progress values
in order on one connection, without an invalid-response event. No extra queue or
buffer is introduced. The full focused client suite passed 11 tests and 209
assertions; root TypeScript, targeted formatting and diff checks passed. This
remains local source evidence, not packaged or genuine simulator acceptance.
