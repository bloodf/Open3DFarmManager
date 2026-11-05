# Pairing persistence checkpoint

This slice persists pairing requests before farm selection. It does not expose HTTP endpoints or issue credentials, and it does not establish Connector authentication or proof of private-key possession.

## Persisted behavior

Migration `0007_pairing_requests` adds separate requests with a fixed 15-minute lifetime. The adapter uses the existing start, approval and poll request schemas. The server derives the SHA-256 fingerprint from the submitted canonical Ed25519 SPKI. Random device codes contain 32 bytes; human codes contain eight characters from the protocol alphabet. Only code hashes are stored. Identity, code hashes, issue time and expiry cannot change.

`PostgresPairing.start` limits active requests to 1,000 across instances through a transaction advisory lock. Expired requests release active capacity. Tombstones remain, so this limit does not bound total database storage. A reviewed retention policy and abuse limits are required before public start or approval endpoints.

`decide` locks the account, session, membership and request in that order. It validates the session and membership before acquiring the request lock, then samples the clock and evaluates the locked session again after the wait. Observed idle or absolute session expiry is persisted as terminal revocation. Only a current owner or admin of the selected farm can decide. The displayed fingerprint must match. Successful approval creates the actual farm-bound enrollment and approves it in the same transaction as the pairing decision and session touch. Denial creates no enrollment. A user code cannot approve again or select a different farm after a decision.

`claim` is an internal, single-use metadata handoff. It returns the enrolled agent ID, farm ID, public SPKI and fingerprint only after committing consumption. It checks the enrollment is still approved under a shared row lock and checks expiry again after that lock. Concurrent claims produce at most one success. Pending polls use a five-second interval; the stored next poll time is capped at request expiry. Denied, expired and consumed requests cannot return metadata. Approved requests retain their historical decision after expiry, but cannot be claimed.

The dedicated `farm_pairing_runtime` capability has no login or elevated cluster privileges. It can insert requests, update lifecycle fields, lock authorization records, touch sessions and create or approve enrollments. It cannot edit memberships, account security state, public keys or fingerprints, remove tombstones, or create schema objects. These are database capabilities for a trusted backend, not row isolation from another holder of the same backend credentials. In particular, the role can update enrollment status across rows, including revocation; it must not be given to clients or treated as a substitute for the application authorization checks.

## Verification

`testPostgresPairing(admin, port)` in `tests/helpers/postgres-pairing-integration.ts` runs against a caller-owned, disposable loopback PostgreSQL fixture with migrations 0001 through 0007. It creates a restricted login role, closes its connections and removes that role in `finally`. Synthetic rows remain for the fixture owner's teardown. The helper can run repeatedly without resetting another task's data.

The real PostgreSQL checks passed:

- Hashed codes before farm selection, owner/admin authorization, fingerprint and farm binding, racing approvals and single-use claims.
- Denial replay, exact expiry deadlines, expiry while waiting for request or enrollment locks, and enrollment revocation before claim.
- Disabled accounts, session-version changes, explicit revocation, idle and absolute expiry persisted across clock regression, and isolation between two existing farms.
- Membership revocation and role downgrade committed while approval waits, session expiry while the request lock is held, and deferred commit failure rolling back both enrollment and approval.
- Unauthorized requests return without waiting on the pairing row, and pending poll time is capped at expiry.
- Restricted-role privileges, database identity and terminal-state guards, concurrent starts at the active-capacity boundary, and closed storage failing closed.

The updated helper passed all 12 reported groups against the disposable PostgreSQL fixture. Migration 0007 down/up executed successfully inside a transaction that was rolled back to preserve the shared fixture. Root TypeScript checking and the nine pairing/migration-catalog unit tests passed. `bun run check:all` passed with formatting, root and Nuxt type checks, 190 Bun tests, 95 Node tests, and both production builds. HTTP, proof-of-possession, credential delivery and Connector-to-browser integration remain pending.

## Remaining integration

1. Define the HTTP approval boundary using the existing independent host-only session and origin/CSRF checks. Limit start requests, code guesses and polling without exposing account or code existence.
2. Bind a reviewed proof-of-possession challenge to the persisted public key and pairing attempt. Submitted SPKI shape and fingerprint matching alone do not prove possession. No token may be issued from metadata alone.
3. Join real credential issuance to the consumption transaction, including commit failure and delivery/retry semantics. The current `claimed` result is deliberately not `PairingPollResponse.status = approved`, which requires a real device token. Do not map it to a synthetic JWT.
4. Wire Connector CLI and browser flow only after these gates, then verify with simulators. Live status, camera and signed commands remain browser-to-Connector WebRTC with no server command fallback.

No dependency, public endpoint, simulator, printer command or hardware access was introduced by this slice.
