# Atomic operation-bound telemetry checkpoint

The internal storage/proof slice passed focused checks and real PostgreSQL acceptance through migration 0016. The integrated gate is pending coordination. HTTP/client integration and authenticated transport are separate slices; this primitive supplies no printer command.

## Narrow transaction contract

`PostgresConnectorCredentialAcceptance.issueTelemetryChallenge(input, rawBody)` and `commitTelemetryWithProof(input, rawBody)` are the only new operation APIs. They require server configuration with purpose `telemetry-ingestion` and a separate least-privileged telemetry pool. Existing generic `issue`/`accept` retain their input/output contracts and provide only point-in-time context receipts.

The trusted server owns and generates `connectionId`. Both telemetry methods copy a 1–65,536-byte `Uint8Array` before their first await. Fatal UTF-8 decoding, the existing bounded JSON parser and strict `TelemetryBatch` validate one snapshot. The body contains 1–100 events with unique event IDs; parsing retains depth/value/string limits. PostgreSQL-incompatible printer keys are rejected without normalization. The transaction never trusts a caller-supplied printer authorization set.

Version 2 signs the exact byte SHA-256 and byte count, fixed `POST` and `/api/connector/telemetry`, along with the existing credential, immutable identity, origin/audience, connection, purpose, generation, nonce and deadline fields. Its strict schema and `Open3DFarmManager/credential-operation-proof/v2` domain reject generic v1 proofs. Whitespace changes require another proof even when the parsed JSONB event payload is equivalent. The narrow Connector signer checks those exact bytes and trusted context without exporting the private key.

An eventual HTTP adapter must enforce that exact method/path, reject query/fragment routing substitutions and Content-Encoding, stream-limit the raw body before allocation, and require the intended JSON content type. These requirements are not supplied by passing browser-owned method or context values to the internal API. The current generic HTTP telemetry sender has no credential/proof exchange and remains unwired.

## Current authority and lock order

The shared implementation reuses exact current enrollment, issued metadata, JOSE verification, revocation denial, clock watermark, credential-expiry marker, admission limits and rate/signature budget. The pre-lock expiry retention fix from `b2a5169` is preserved. Advisory admission applies to processes connected to the same PostgreSQL database, not other databases in a cluster.

Lock order is enrollment SHARE → immutable credential SHARE → proof slot UPDATE → active assignments SHARE in UTF-8 byte order → telemetry event IDs in stable order. Migration 0015 ownership mutations hold enrollment UPDATE before assignment UPDATE; Connector revocation also locks enrollment before credential. Neither path requires a reverse assignment-to-enrollment edge. Current locks stay held until COMMIT.

Every printer must have one active assignment to the exact farm and agent. Missing, revoked or other-agent assignments deny the batch. Telemetry never provisions an assignment or discovers a printer. After all assignment locks, the service rechecks proof/token time. Proof consumption and the complete batch insert/dedup share one savepoint; a conflicting reused event ID rolls back every insert and consumption. Immutable JSONB equality and scoped event IDs preserve the original dedup semantics. A valid new proof can retry the identical events after a lost response, including through another process.

The final check runs after event insertion and any uniqueness/row waits. Expiry rolls back batch and consumption while the outer transaction retains the appropriate expiry marker. Deferred COMMIT failure returns no acknowledgment. Success is returned only after COMMIT and another deadline check. If time expires during COMMIT itself, a batch may already have committed atomically with proof consumption, but no success is returned. A fresh proof for an identical batch then deduplicates safely. This is not token/proof redelivery or a reusable verified flag.

## Schema and capability boundary

Migration 0016 extends the existing single proof slot per issued credential with version and operation fields, keeping allocations bounded across processes and restarts. Binding fields cannot change inside a generation. Only a legitimate new generation can clear them for v1 or bind another v2 request. The generic acceptor may reset a replacement to v1, but a SQL lifecycle guard requires the separate telemetry capability to create v2. A pending v2 slot cannot be consumed through the generic API.

`farm_connector_telemetry_writer` inherits the existing acceptor capability and adds assignment read/row-lock and telemetry insert/read/row-lock grants. It cannot provision/revoke assignments, approve enrollments, revoke Connectors or issue credentials. The generic acceptor gains no telemetry write grant. Existing immutable assignment/event triggers reject actual identity/event UPDATEs despite the column grants needed for row locking. SQL role holders remain trusted backend components; this does not isolate tenants from a compromised backend database credential. The old raw telemetry store remains internal and unauthenticated, and must not become an HTTP bypass around this transaction.

The down migration takes an exclusive proof-table lock and refuses rollback while any current v2 generation exists, including a consumed one. It never drops an active operation binding and silently reinterprets it as generic proof authority. V1-only fixtures can roll back and reapply. A populated v2 rollback requires separately reviewed retirement; down is not a recovery API.

## Verification status

Three new Node tests passed for exact body/method/path/context signing, separate v1/v2 domains, changed body/trust/key/deadline rejection, immutable byte snapshots, bounded parsing and invalid printer encodings. Root and focused strict TypeScript checks passed for the prepared source.

The disposable-fixture helper passed nine real PostgreSQL groups: actual issued credentials and live identity signatures; two proof-row waiters with one commit and an exact busy loser; fresh-proof dedup; v1/v2 separation/reset; altered bytes and ownership denial; entire-batch conflict rollback; both Connector/ownership race orders; expiry during assignment/event waits; deferred commit failure; expired acknowledgment retry; and role/binding guards. These are nine grouped checks, not a separate count for each assertion above. All nine groups passed in the initial run, after restart, and while preparing the final restart fixture.

The generic credential regression runner passed all twelve groups on schema 0016, including the retained `b2a5169` pre-lock expiry/clock-regression case. Generic input/output contracts remain unchanged. Both generic runners now validate the official contiguous journal through 0016; historical 0014 evidence applies to that original source only.

A fresh isolated cluster applied official migrations 0001–0016. Empty/v1-only 0016 down/up passed, with all sixteen journal checksums unchanged. After v2 records existed, official down correctly refused rollback; journal, proof-slot, event and assignment counts/digests were unchanged. The final journal after actual PostgreSQL restart was byte-equal to the initial/reapplied journal. No historical entries were fabricated.

A fresh-process restart verifier passed after an actual isolated PostgreSQL restart: a fresh pending proof retried an already committed identical batch with no duplicate events, and both old and newly consumed proofs were denied. Its first attempt exposed a test-clock sequencing error: two independent replay probes used the same time, so the second correctly returned busy rather than the asserted denial. The verifier now advances one second per probe. A new private fixture and actual restart verified the correction; production code was unchanged. The initial failure log remains bounded local evidence.

The original shared database identity and six-row journal matched before and after. Task-owned cluster/proxy, restricted fixture roles, pools and private synthetic-token restart fixture were removed. No private key was persisted or token logged. No container, image, volume, network or worktree was added. Existing integration build output was preserved. Exact source hashes, journals, counts and cleanup evidence remain in the bounded local task ledger. `check:all` for the integrated current head remains pending; no full application or publication acceptance follows from these helpers.
