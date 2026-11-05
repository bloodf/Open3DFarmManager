# Pairing persistence checkpoint

This slice persists pairing requests before farm selection. It does not expose HTTP endpoints or issue credentials, and it does not establish authenticated Connector transport. Approval and metadata claim require the durable proof of private-key possession described in [the proof checkpoint](PAIRING-PROOF-CHECKPOINT.md).

## Persisted behavior

Migration `0007_pairing_requests` adds separate requests with a fixed 15-minute lifetime. The adapter uses the existing start, approval and poll request schemas. The server derives the SHA-256 fingerprint from the submitted canonical Ed25519 SPKI. Random device codes contain 32 bytes; human codes contain eight characters from the protocol alphabet. Only code hashes are stored. Identity, code hashes, issue time and expiry cannot change.

`PostgresPairing.start` limits active requests to 1,000 across instances through a transaction advisory lock. Expired requests release active capacity. Tombstones remain, so this limit does not bound total database storage. A reviewed retention policy and abuse limits are required before public start or approval endpoints.

`decide` locks the account, session, membership and request in that order, then locks the verified proof for approval. Server-configured origin and audience are mandatory constructor arguments; client approval fields cannot override them. It validates the session and membership before acquiring the request lock, then samples the clock and evaluates the locked session again after the wait. Observed idle or absolute session expiry is persisted as terminal revocation. Only a current owner or admin of the selected farm can decide. The displayed fingerprint must match. Approval also requires a verified proof for this exact immutable pairing identity, with the configured origin/audience and a current proof deadline. The session is evaluated again after the proof lock wait. Denial grants no authority and can proceed without proof, while retaining the session, farm and fingerprint checks. Successful approval creates the actual farm-bound enrollment and approves it in the same transaction as the pairing decision and session touch. Denial creates no enrollment. A user code cannot approve again or select a different farm after a decision.

`claim` is an internal, single-use credential operation. It locks the request, verified proof and enrollment, then signs a real Connector JWT and atomically records bounded metadata and consumes the request. It returns the protocol's approved response only after COMMIT. Proof and pairing deadlines are checked after signing and after the SQL writes. Concurrent claims produce at most one credential. Pending polls use a five-second interval capped at request expiry. No HTTP claim endpoint exists; response-loss recovery remains a required gate. See the [atomic issuance checkpoint](CONNECTOR-CREDENTIAL-ISSUANCE-CHECKPOINT.md).

Proof must be current at both approval and claim. This prototype requires both stages within the challenge's at-most-60-second lifetime. Missing that window requires a new pairing; proof expiry does not automatically revoke the historical enrollment.

Migration `0009_pairing_proof_gates` grants the pairing runtime read/lock access to proofs and adds `proof_expired_at` to requests. Observed proof expiry is committed as an immutable marker, including on already-approved requests. A later clock regression cannot reactivate approval or claim. Safe-integer timestamp checks and a database lifecycle trigger prevent marker reset or replacement.

The dedicated `farm_pairing_runtime` capability has no login or elevated cluster privileges. It can insert requests, update lifecycle fields, lock authorization records, touch sessions and create or approve enrollments. It cannot edit memberships, account security state, public keys or fingerprints, remove tombstones, or create schema objects. These are database capabilities for a trusted backend, not row isolation from another holder of the same backend credentials. In particular, the role can update enrollment status across rows, including revocation; it must not be given to clients or treated as a substitute for the application authorization checks.

## Verification

`testPostgresPairing(admin, port)` in `tests/helpers/postgres-pairing-integration.ts` runs against a caller-owned, disposable loopback PostgreSQL fixture with migrations 0001 through 0010. It creates a restricted login role, closes its connections and removes that role in `finally`. Synthetic rows remain for the fixture owner's teardown. The helper can run repeatedly without resetting another task's data.

The real PostgreSQL checks passed:

- Hashed codes before farm selection, owner/admin authorization, fingerprint and farm binding, racing approvals and single-use claims.
- Denial replay, exact expiry deadlines, expiry while waiting for request or enrollment locks, and enrollment revocation before claim.
- Disabled accounts, session-version changes, explicit revocation, idle and absolute expiry persisted across clock regression, and isolation between two existing farms.
- Membership revocation and role downgrade committed while approval waits, session expiry while the request lock is held, and deferred commit failure rolling back both enrollment and approval.
- Unauthorized requests return without waiting on the pairing row, and pending poll time is capped at expiry.
- Restricted-role privileges, database identity and terminal-state guards, concurrent starts at the active-capacity boundary, and closed storage failing closed.

The updated helper passed 16 groups against a fresh isolated PostgreSQL cluster initialized through the official migration runner, including all ten journal entries/checksums. It additionally covers missing proofs, legacy approved rows without proofs, wrong pairing/origin/audience, current proof at both stages, proof expiry after either proof or enrollment locks, and durable expiry through clock regression. The proof helper passed 11 groups, including both stepped-clock outcomes after real Ed25519 verification. Live identity tests use the new narrow signing method without exporting a key.

Migrations 0009 and 0010 down/up and their final journals are verified through the official runner. `bun run check:all` passed formatting, root and Nuxt type checks, 193 Bun tests, 96 Node tests, and both production builds. The focused Connector build also preserves and byte-compares the project and Zod license notices alongside the bundle. HTTP delivery/recovery/revocation and Connector-to-browser transport integration remain pending.

## Remaining integration

1. Define the HTTP approval boundary using the existing independent host-only session and origin/CSRF checks. Limit start requests, code guesses and polling without exposing account or code existence.
2. Wire the reviewed durable challenge and `ConnectorIdentity.signPairingProof` into the CLI and browser interaction, with trusted origin/audience configuration and explicit recovery when the proof window expires. No token may be issued from metadata alone.
3. Implement and verify explicit lost-response recovery and revocation before exposing the atomic real-credential claim through HTTP. A committed token is not stored for replay; repeated claims are denied. Never substitute a synthetic JWT for delivery recovery.
4. Wire Connector CLI and browser flow only after these gates, then verify with simulators. Live status, camera and signed commands remain browser-to-Connector WebRTC with no server command fallback.

No dependency, public endpoint, simulator, printer command or hardware access was introduced by this slice.
