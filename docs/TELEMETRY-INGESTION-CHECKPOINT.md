# Internal telemetry ingestion checkpoint

The E3.2 component flow includes an internal library service in `apps/farm/server/services/telemetry.ts`. The maintained HTTP ingestion path does not call `ingestTelemetry` or `PostgresTelemetryStore`. The service requires caller-provided agent context; its shape validation does not authenticate that context. Future middleware must establish current agent identity, farm ownership and printer membership independently of the body.

The shared strict batch schema accepts only printer-state events, at most 100 records. The bounded JSON reader rejects bodies above 64 KiB, excessive nesting, duplicate keys and ambiguous input before schema validation. Duplicate event IDs within a batch, unknown fields and command payloads are rejected. The service checks all printer keys against the supplied authorization snapshot before invoking storage. Farm and agent identity are taken only from that context.

`commitBatch` must atomically persist or deduplicate the whole batch under `(farmId, agentId, eventId)`. Reuse of an ID with different event contents is a conflict, not an update. The service returns accepted IDs only after the adapter reports commit completion. Exceptions, invalid adapter outcomes and conflicts return fixed failure reasons without leaking underlying exception text. The service does not update a latest-state projection or trust observation timestamps as server time.

## Executed evidence

Seven new Node tests exercise:

- Actual synthetic Moonraker parsing, durable Connector queue, internal ingestion, lost response, queue reopen and successful duplicate delivery without another insertion.
- Missing or invalid context and out-of-scope printers without any storage call.
- Invalid JSON/schema, command fields, injected scope, duplicate IDs and over-limit batches without storage calls.
- Whole-batch conflict rejection and independent identity namespaces.
- Failed commit and unexpected adapter output without acknowledgement.
- Delayed commit: the acknowledgement promise stays pending until completion.
- A valid 100-record batch within the JSON reader bounds.

The store in `tests/helpers/memory-telemetry-store.ts` is a test double. It stages a Map replacement synchronously to model an atomic commit, scopes deduplication keys and compares canonical event content. It is volatile, unbounded and unsuitable for production. The lost-response test restarts only the disk-backed Connector queue; the synthetic server store stays alive. No server crash-durability or real database isolation claim follows from these tests.

## Remaining work

The maintained routes `/api/connector/telemetry/challenge` and `/api/connector/telemetry` use `PostgresConnectorCredentialAcceptance` for proof validation and transactional ingestion. Migrations define the telemetry table and unique `(farm_id, agent_id, event_id)` key. The Connector agent schedules its authenticated drain. The library service above accepts a string already in memory; it cannot enforce network stream limits itself.

The routes return 503 by default until runtime bootstrap is configured. The required LOWPRIV database role remains a deployment requirement. Authentication, TLS and deployed runtime acceptance are UNKNOWN. Bounded retention and a latest-state projection remain future work. There is no server command forwarding, real device access, new dependency, container execution or change to offline authorization policy. Integration also required replacing a DOM-only type assertion in shared signing code with an equivalent structural type so Nitro can typecheck it; signature behavior is unchanged.
