# Enrollment-gated Connector proof checkpoint

`EnrolledConnectorProof` now connects the existing one-time Ed25519 challenge registry to a current enrollment lookup. The request supplies only farm/agent references and a server-owned connection ID; the expected key and fingerprint come from the consulted record. Missing, pending, revoked, mismatched or malformed records cannot complete the flow. There is no endpoint or production enrollment source.

The source must read current enrollment state and run the synchronous proof operation while serialized against approval/revocation, resolving only after its transaction commits. The wrapper checks that the callback runs exactly once. Skipped, repeated or late callbacks fail closed; a callback invoked after the transaction promise completes cannot create or evaluate challenges. Storage exceptions and failed read commits never return success. Challenges associated with the connection are discarded on lookup/proof failure, requiring a fresh attempt after recovery.

Both issue and completion perform a new lookup. This lets a revocation recorded after issuance reject completion. The adapter contract treats revocation as terminal for an agent ID: re-enrollment requires a new ID. The production data model must enforce that invariant; this service does not mutate approval records. Nor does it make claims about operations already authorized before a revocation commits.

## Verified synthetic lifecycle

Seven Node tests use a clearly labeled test-only enrollment fixture. They cover absent/pending → approved → one successful proof, revoked enrollment rejecting completion, wrong farm/agent records, a valid signature from an unenrolled key, lookup outage/recovery, failure after proof evaluation but before transaction completion, and source callback contract violations.

The fixture's approval and revocation methods only arrange test data. They do not verify an owner's identity, farm membership or permission to approve. Its synchronous callback models one-process ordering; it is neither durable storage nor evidence of real database transaction isolation.

`check:all` passed with 148 Bun and 68 Node tests, lint, typecheck and builds. Existing browser tests were unchanged and not repeated. No real credentials, accounts, devices or network services participate.

## Remaining prerequisites

- A durable enrollment database and migrations must enforce agent/farm scope, expected key binding, terminal revocation and transactional consistency.
- The approval workflow must authenticate the user, check current farm permissions, confirm the fingerprint and enforce pairing-code expiry, attempt limits and audit requirements.
- Agent credentials, authenticated transport, connection ownership, token verification and live revocation lookup still require implementation. Farm/agent request IDs are lookup references, not credentials.
- Production adapter race/restart tests must validate the source contract. A malicious adapter can fabricate an approved record; this integration does not make an untrusted source trustworthy.
- No JWT, authenticated telemetry context or permission grant is returned. Success establishes possession relative to the approved record supplied by the trusted source. Existing channel-binding, relay-defense and distributed-registry gaps remain as documented in the Connector proof checkpoint.

A subsequent [PostgreSQL source prototype](POSTGRES-ENROLLMENT-CHECKPOINT.md) now tests real row-lock serialization and revocation persistence after database restart. It is not wired to routes and does not supply approval permissions or a production storage deployment.
