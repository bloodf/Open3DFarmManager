# Telemetry delivery checkpoint

This local E3.2 continuation connects the existing bounded Moonraker parser and disk-backed telemetry queue to a one-attempt delivery coordinator. It completes a component flow with a synthetic sink; it is not an HTTP client, agent endpoint or production synchronization loop.

`drainTelemetryOnce` reads at most 100 records and serializes a JSON array of at most 64 KiB. Only printer-state records admitted by the queue are eligible. An injected sender receives immutable serialized data and a cancellation signal. Its internal result must be the exact ordered event-ID array, returned only after authenticated durable acceptance. No network acknowledgement schema is selected here.

The coordinator removes the FIFO prefix only after matching acceptance. Exceptions, malformed/partial/reordered acknowledgements and cancellation do not acknowledge records. A late transport success after cancellation cannot remove them. A WeakSet prevents overlapping attempts on the same queue instance. New enqueues during an outstanding send remain after a successful prefix acknowledgement. Storage exceptions report `uncertain`, because an interrupted local write must not be described as certainly committed or certainly retained.

The queue's existing age/capacity eviction policy still applies, including while producers enqueue during delivery. The coordinator exposes losses reported during batch selection. `retained` means this attempt did not acknowledge the batch; it does not override queue retention limits or a different actor's operations. An oversized FIFO head is reported without silently removing it. Recovery after a storage error remains explicit.

## Verified flow

A synthetic Moonraker response becomes a normalized printer state and a durable queue record. A synthetic sink accepts it but loses the response. The queue is closed and reopened; a new attempt sends the same event ID and body. The sink deduplicates by ID, confirms acceptance, and the empty queue remains empty after another reopen.

Eleven Node tests cover that flow, empty queues, strict acknowledgements, cancellation including cancellation during batch preparation, late completion, overlapping attempts, enqueue during delivery, bounded FIFO batches, unavailable queue storage and local acknowledgement failure. The synthetic destination is a Set in the test process, not a server persistence implementation. No network, container, account, credential or device is used.

## Remaining integration

- The sender must authenticate the destination, enforce a bounded response, interpret the actual agent protocol and accept only durable server commits. None of those network behaviors is supplied here.
- The caller must provide a deadline-bearing AbortSignal. The coordinator has no implicit timer, scheduler or automatic retry. A transport that ignores cancellation may still complete remotely; repeat telemetry delivery therefore requires server deduplication by stable event ID.
- A production server needs transactional ingestion and a uniqueness constraint scoped to the authenticated agent and event ID. This checkpoint demonstrates at-least-once attempts with a synthetic idempotent sink, not exactly-once network delivery.
- Authentication, ingestion endpoints, the synchronization loop and outage acceptance against a running service remain unimplemented. Queue stale-lock recovery and power-loss fault injection remain separate gaps.
- Commands are not eligible telemetry and no command retry or server command forwarding is added. The offline authorization policy is unchanged.

## Cancellation concurrency regression

A local review reproduced an overlap: cancelling an attempt released its queue slot while an abort-ignoring sender was still pending, allowing a second send on the same queue. The regression test failed with a second delivery where `busy` was expected.

The coordinator now returns cancellation promptly but retains the per-queue slot until the actual sender promise settles. Late success or failure releases the slot without acknowledging the cancelled batch. Tests cover both outcomes and confirm a subsequent attempt can drain the retained record. The existing late-success test now waits for the async sender to finish instead of assuming one microtask completes it.

A sender that never settles keeps this queue instance busy. This is intentional bounded concurrency, not automatic recovery: a real transport must honor cancellation/deadlines and release its resources. There is still no production transport or scheduler, and remote acceptance after cancellation still requires server deduplication. The slot is process-local and does not promise cross-process or cross-restart exclusion.

## Process crash fault test

A bounded Node subprocess test kills the queue owner after the internal ingestion service accepts two synthetic records and before its sender receives an acknowledgement. Concurrent opening fails while the child is alive, and the remaining lock also blocks reopening after its observed exit. The test removes that specific lock only after it has killed and reaped its sole owner, then verifies FIFO replay with the same body and IDs, a single insertion per ID in the in-memory store, and an empty queue after acknowledgement and reopening. The test does not establish a general safe stale-lock removal procedure. Production supervision must establish exclusive ownership; automatic recovery remains unimplemented.

The store and trusted ingestion context in this test are synthetic and in memory. They do not prove database durability, power-loss behavior, transport authentication or parent authentication integration. No real endpoint or printer is contacted.
