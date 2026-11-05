# PostgreSQL telemetry and proof boundary review

The enrollment review reproduced two connection-close races: an in-flight lookup could issue a challenge after `discardConnection`, and proof completion could return success after the connection closed while the transaction was still completing. Both regression tests failed before the fix. The wrapper now marks outstanding operations cancelled and checks that state before proof evaluation and after the transaction returns. In-flight bookkeeping is bounded to 1000 operations and removed on settlement. Cancellation is scoped by connection; a third regression verifies another connection still completes successfully.

This does not cancel PostgreSQL I/O or keep an everlasting registry of closed connections. The trusted server transport must stop initiating operations on closed connection IDs and never reuse IDs across connection lifetimes. Challenge state remains process-local. Cancellation before resolution suppresses success but cannot undo an authorization already returned to a caller.

The disposable PostgreSQL enrollment test additionally covers a callback exception with pool recovery, a real row-lock timeout and rejection of that consumed/discarded proof after recovery. It retains the measured revoke-before-verification ordering and normal database restart coverage. Commit-response loss, power loss, backup restoration and distributed deployments remain untested.

## Durable telemetry slice

`PostgresTelemetryStore` connects the existing internal ingestion validator to an atomic PostgreSQL batch transaction. Scope comes from trusted caller context, not event JSON. The store independently validates and snapshots up to 100 events/64 KiB, acquires rows in stable event-ID order, and deduplicates by farm, agent and event ID. Equal JSONB payloads are idempotent; conflicting reuse aborts the entire transaction. Acknowledgement is returned only after commit. Database errors remain redacted; no endpoint is exposed.

The opt-in PostgreSQL script now invokes a helper that connects synthetic Moonraker parsing, the actual disk queue, ingestion validation and the database store. It simulates a lost response after successful commit, closes/reopens the queue, and verifies redelivery acknowledges the same durable row. Additional assertions cover atomic conflict rollback, concurrent identical insertion, scope isolation and durable deduplication after a real database restart. Missing trusted context never writes.

The first actual run rejected telemetry because a pre-stringified JSON parameter became a JSONB string. The database object constraint caught the error and the queue retained the event. A follow-up check found that the installed Bun 1.4.2 lacks the `sql.json` helper described by newer documentation/types. The store now passes the validated plain object as the JSONB parameter, following [Bun's parameter type guidance](https://bun.com/docs/runtime/sql#parameter-types), without upgrading the runtime or adding dependencies. Actual database integration is the compatibility gate.

Migration 0002 is explicit and follows 0001; rollback is in reverse order and restricted to the disposable fixture. Neither migration runs at startup. This is internal persistence, not authenticated telemetry: synthetic trusted context in the fixture is not derived from enrollment proof, and the store deliberately does not interpret enrollment state. Connecting proof/channel identity to current farm/printer permission checks is still required before exposing ingestion.

There is no production role separation, event retention/storage quota, operational migration runner, database TLS/pool configuration, API authentication or telemetry scheduling. Batch resource bounds do not bound lifetime database growth. The table's integrity depends on restricted write roles; this slice does not defend against privileged direct SQL changes. Offline authorization policy is unchanged. No production service or device is accessed.

## Measured validation

On 2026-11-04 the expanded initial and post-restart phases both exited 0 against native ARM64 PostgreSQL 17.11, image `postgres@sha256:266d3c257594e195b309ae9d1805e54c788f1d7b375f56bf6c367aac6c917e7b`, using Bun 1.4.2. The final run verified the plain-object encoding, queue recovery, conflict rollback, concurrency, scoped deduplication and persistence across normal database restart. Two earlier integration failures remain in local evidence rather than being counted as passes.

Each attempt used a separate labeled container, volume and bridge network; publication was loopback-only, with UID 70, all capabilities dropped, no-new-privileges, 1 CPU, 512 MiB and 128 PIDs. Synthetic passwordless trust existed only in these disposable fixtures, never in project runtime configuration. The bridge did not enforce outbound filtering. All task-owned resources and newly pulled unused images were removed after each attempt, and label-filtered cleanup inventories were empty. Pre-existing containers were preserved.

Final verification: 173 Bun tests, 95 Node tests, lint, typecheck and Connector/Nuxt builds. PostgreSQL integration is a separate explicit test, not part of these counts or CI. No endpoints, production changes or publication were introduced; GitHub Actions authorization remains pending.
