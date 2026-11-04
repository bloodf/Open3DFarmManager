# Telemetry delivery checkpoint

This local E3.2 continuation connects the existing bounded Moonraker parser and disk-backed telemetry queue to a one-attempt delivery coordinator. It completes a component flow with a synthetic sink; it is not an HTTP client, agent endpoint or production synchronization loop.

`drainTelemetryOnce` reads at most 100 records and serializes a JSON array of at most 64 KiB. Only printer-state records admitted by the queue are eligible. An injected sender receives immutable serialized data and a cancellation signal. Its internal result must be the exact ordered event-ID array, returned only after authenticated durable acceptance. No network acknowledgement schema is selected here.

The coordinator removes the FIFO prefix only after matching acceptance. Exceptions, malformed/partial/reordered acknowledgements and cancellation do not acknowledge records. A late transport success after cancellation cannot remove them. A WeakSet prevents overlapping attempts on the same queue instance. New enqueues during an outstanding send remain after a successful prefix acknowledgement. Storage exceptions report `uncertain`, because an interrupted local write must not be described as certainly committed or certainly retained.

The queue's existing age/capacity eviction policy still applies, including while producers enqueue during delivery. The coordinator exposes losses reported during batch selection. `retained` means this attempt did not acknowledge the batch; it does not override queue retention limits or a different actor's operations. An oversized FIFO head is reported without silently removing it. Recovery after a storage error remains explicit.

## Verified flow

A synthetic Moonraker response becomes a normalized printer state and a durable queue record. A synthetic sink accepts it but loses the response. The queue is closed and reopened; a new attempt sends the same event ID and body. The sink deduplicates by ID, confirms acceptance, and the empty queue remains empty after another reopen.

Ten Node tests cover that flow, empty queues, strict acknowledgements, cancellation including cancellation during batch preparation, late completion, overlapping attempts, enqueue during delivery, bounded FIFO batches, unavailable queue storage and local acknowledgement failure. The synthetic destination is a Set in the test process, not a server persistence implementation. No network, container, account, credential or device is used.

## Remaining integration

- The sender must authenticate the destination, enforce a bounded response, interpret the actual agent protocol and accept only durable server commits. None of those network behaviors is supplied here.
- The caller must provide a deadline-bearing AbortSignal. The coordinator has no implicit timer, scheduler or automatic retry. A transport that ignores cancellation may still complete remotely; repeat telemetry delivery therefore requires server deduplication by stable event ID.
- A production server needs transactional ingestion and a uniqueness constraint scoped to the authenticated agent and event ID. This checkpoint demonstrates at-least-once attempts with a synthetic idempotent sink, not exactly-once network delivery.
- Authentication, ingestion endpoints, the synchronization loop and outage acceptance against a running service remain unimplemented. Queue stale-lock recovery and process/power-loss fault injection remain separate gaps.
- Commands are not eligible telemetry and no command retry or server command forwarding is added. The offline authorization policy is unchanged.
