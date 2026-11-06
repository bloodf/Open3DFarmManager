# Internal telemetry ingestion checkpoint

The E3.2 component flow includes an internal server service in `apps/farm/server/services/telemetry.ts`. The service creates no HTTP route, account or credential of its own. It requires caller-provided agent context; its shape validation does not authenticate that context. Future middleware must establish current agent identity, farm ownership and printer membership independently of the body.

The shared strict batch schema accepts only printer-state events, at most 100 records. The bounded JSON reader rejects bodies above 64 KiB, excessive nesting, duplicate keys and ambiguous input before schema validation. Duplicate event IDs within a batch, unknown fields and command payloads are rejected. The service checks all printer keys against the supplied authorization snapshot before invoking storage. Farm and agent identity are taken only from that context.

`commitBatch` must atomically persist or deduplicate the whole batch under `(farmId, agentId, eventId)`. Reuse of an ID with different event contents is a conflict, not an update. The service returns accepted IDs only after the adapter reports commit completion. Exceptions, invalid adapter outcomes and conflicts return fixed failure reasons without leaking underlying exception text. The service does not update a latest-state projection or trust observation timestamps as server time.

## Executed evidence

The evidence in this section belongs to the 2026-11-04 slice. The counts and results describe that commit, not the current tree.

Seven new Node tests exercise:

- Actual synthetic Moonraker parsing, durable Connector queue, internal ingestion, lost response, queue reopen and successful duplicate delivery without another insertion.
- Missing or invalid context and out-of-scope printers without any storage call.
- Invalid JSON/schema, command fields, injected scope, duplicate IDs and over-limit batches without storage calls.
- Whole-batch conflict rejection and independent identity namespaces.
- Failed commit and unexpected adapter output without acknowledgement.
- Delayed commit: the acknowledgement promise stays pending until completion.
- A valid 100-record batch within the JSON reader bounds.

The store in `tests/helpers/memory-telemetry-store.ts` is a test double. It stages a Map replacement synchronously to model an atomic commit, scopes deduplication keys and compares canonical event content. It is volatile, unbounded and unsuitable for production. The lost-response test restarts only the disk-backed Connector queue; the synthetic server store stays alive. No server crash-durability or real database isolation claim follows from these tests.

That slice added no server command forwarding, no real device access, no new dependency, no container execution and no change to the offline authorization policy. Its integration also required replacing a DOM-only type assertion in shared signing code with an equivalent structural type so Nitro can typecheck it; signature behavior is unchanged.

## Current state

Two ingestion implementations coexist, and the production route uses the one this document does not describe.

The internal slice in this document is intact. `ingestTelemetry` is defined in `apps/farm/server/services/telemetry.ts:34` and `PostgresTelemetryStore` in `apps/farm/server/storage/postgres-telemetry.ts:11`. Both symbols exist in the tree, but every call site sits under `tests/`. No production module imports them, so this slice remains a library surface with no live caller.

The production path runs through other code. `apps/farm/server/api/connector/telemetry.post.ts` and `apps/farm/server/api/connector/telemetry/challenge.post.ts` declare the two Nitro routes. Each rejects a request that fails the boundary inspection with 400, and each answers 503 while `telemetryHttpRuntime()` returns no handler. The handler built by `createTelemetryHttpHandler` in `apps/farm/server/services/telemetry-http.ts:24` reads the bearer token and the farm and agent headers, then calls `issueTelemetryChallenge` or `commitTelemetryWithProof` on `PostgresConnectorCredentialAcceptance` in `apps/farm/server/storage/postgres-connector-credential-acceptance.ts`. That class checks live printer assignment rows before it writes the batch to `farm.telemetry_events` inside a savepoint transaction. Neither route calls `ingestTelemetry` or `PostgresTelemetryStore`.

The runtime stays inactive by default. `apps/farm/server/plugins/telemetry-lifecycle.ts` reads `connectorTelemetry` from the Nuxt runtime configuration and hands it to `createTelemetryRuntimeLifecycle`. `parseTelemetryRuntimeConfig` in `apps/farm/server/services/telemetry-runtime-config.ts` returns `disabled` unless `enabled` is exactly `true`, and `invalid` when a required value is missing or malformed. The shipped default in `apps/farm/nuxt.config.ts` sets `enabled: false`, so no handler is installed and both routes answer 503 until an operator supplies the full configuration. Activation checks the database role and the verification key file first, and a failure there leaves the runtime unavailable rather than partly enabled.

## Remaining work

The database adapter and the migrations exist now. `apps/farm/server/storage/postgres-telemetry.ts:11` implements the store, and `infra/db/migrations/0002_telemetry_events.up.sql` declares `farm.telemetry_events` with the primary key `(farm_id, agent_id, event_id)`. Transaction, race and restart coverage lives in the opt-in scripts `scripts/test-postgres-atomic-telemetry.ts` and `scripts/test-atomic-telemetry-restart.ts`, outside the default test run. Bounded retention, a storage quota and a latest-state projection are still missing, and the per-batch bounds do not bound lifetime database growth.

The internal service still has no production caller, and the two implementations write the same table under different rules. The store trusts the printer key snapshot the caller supplies, while the credential acceptance path checks assignment rows in the database. Choosing the canonical path is a product decision.

The service accepts a string that is already in memory, so it cannot enforce network stream limits itself. The route path applies those limits at the boundary instead, in `apps/farm/server/services/telemetry-http-boundary.ts`.

The store separates no production roles. The production runtime requires a dedicated `farm_connector_telemetry_writer` role, and `createTelemetryHttpRuntime` in `apps/farm/server/services/telemetry-http-runtime.ts` refuses to install the handler when the connecting user holds that role and no other privileged one. Neither path provides event retention, a storage quota, an operational migration runner or telemetry scheduling. The offline authorization policy is unchanged.
