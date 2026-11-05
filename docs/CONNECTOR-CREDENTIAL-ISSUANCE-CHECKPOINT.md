# Atomic Connector credential issuance checkpoint

`PostgresPairing.claim` now issues a real signed Connector credential through the JOSE helper. It returns the protocol's approved response only after the metadata insert and single-use pairing consumption commit. No HTTP endpoint is exposed. A credential alone does not authenticate Connector transport or authorize printer commands.

## Transaction and binding

The caller supplies trusted server issuance configuration separately from the strict device-code request. The adapter snapshots issuer, audience, signing key, key ID and explicit lifetime before its first asynchronous operation. Browser input cannot select these values.

The adapter locks the pairing request, its current verified proof and the current enrollment in that order. The existing configured proof origin/audience, exact immutable identity, enrollment status/farm, proof deadline and pairing deadline remain mandatory. Browser approval retains its independent session, current farm membership and fingerprint checks. Both approval and claim must occur within the proof's at-most-60-second lifetime.

Inside the transaction, the adapter generates a random UUID `jti`, derives the fingerprint and RFC 7638 key thumbprint from the locked public SPKI, and calls the pure issuer with those exact agent/farm/key identifiers. The issuer uses real Ed25519 JOSE signing. The adapter checks the clock again after the asynchronous cryptographic work. Expired proof, expired pairing, expired newly signed token or clock regression prevents delivery.

Migration `0010_connector_credentials` stores immutable metadata: `jti`, agent/farm IDs, fingerprint, thumbprint, signing key ID, issuer/audience and NumericDate issue/expiry times. It stores no compact JWT or private key. One unique agent ID permits at most one credential record for a pairing; unique `jti` values and tombstones prevent reuse. Identity/lifetime checks and bounded field lengths reject invalid metadata. The configured lifetime must be an integer from 1 through 3,600 seconds, matching the issuer's policy and the database check.

Metadata insertion and pairing consumption use an internal savepoint. The adapter samples time again after those SQL operations, so a foreign-key wait after signing cannot extend the proof or token deadline. If that final check fails, the savepoint rolls back both writes, while the outer transaction records observed proof expiry durably when appropriate. No transaction object or signing callback is exposed to callers. Successful output waits for the outer COMMIT, including deferred constraints.

The pairing runtime has only SELECT/INSERT on credential metadata. It cannot update, delete or truncate rows. The lifecycle trigger rejects direct UPDATE, DELETE and TRUNCATE, including ordinary DML by the fixture administrator. Schema-owner changes remain trusted. As with other backend roles, holders of trusted SQL capabilities are not isolated from one another; application authorization must remain at the reviewed service boundary.

## Failure and recovery limits

A signing failure or a known rolled-back commit creates no metadata and leaves the request approved and unconsumed. An internal caller may retry only while the same proof remains current and the earlier attempt is known not to have committed. Synthetic tests prove these rollback cases; they do not establish network delivery guarantees.

If the proof expires after browser approval, the historical enrollment can remain approved without a delivered credential. Observed expiry remains terminal through clock regression. This slice does not automatically revoke that orphan enrollment. Starting a fresh pairing is required; cleanup/revocation of abandoned enrollments needs a reviewed flow.

If COMMIT succeeds and the response is lost, the request is consumed and its metadata remains, but the JWT cannot be recovered from the database. An ambiguous commit failure must be treated the same way until durable state is inspected. A repeated claim is denied and does not issue a second token. The prototype requires a fresh pairing to obtain another credential; this is not transparent retry and does not revoke or clean up the previous enrollment or credential. Do not expose an HTTP claim endpoint until that flow is implemented and tested.

The pure verifier checks signature, strict claims, configured issuer/audience/key and key binding only. Future runtime acceptance must additionally check current enrollment and credential metadata and require a fresh proof of private-key possession. Neither a JWT nor an earlier pairing proof authorizes a command. Status, camera and signed commands remain browser-to-Connector WebRTC, without server command fallback.

## Verification

`scripts/test-postgres-credential-issuance.ts` requires explicit disposable-fixture opt-in and an explicit loopback port. It validates the official migration journal through 0010 before running the real PostgreSQL helper. The helper creates and removes a restricted runtime login role, closes its connections and leaves synthetic rows for the fixture owner to tear down. It never prints a token or private key.

Acceptance checks cover:

- Real JOSE verification against the exact locked agent, farm, fingerprint and RFC 7638 thumbprint; exact metadata/times; one concurrent winner and replay denial; no token column or plaintext JWT in stored metadata.
- Signing-key failure and deferred commit failure rolling back both metadata and consumption, with known-rollback retries while the proof is valid.
- Proof, pairing and token expiry and clock regression after asynchronous signing; expiry during a later metadata foreign-key wait rolls back insertion and consumption while persisting the expiry marker.
- Issuer configuration snapshotting, database identity/length/lifetime bounds, restricted SQL privileges and immutable credential tombstones.

A fresh isolated cluster applied migrations 0001 through 0010 through the official runner, validated all ten journal checksums, and verified 0010 down/up before the final credential helper run. All eight credential check groups and sixteen existing pairing groups passed. The updated pairing runner also validates all ten migrations and exercises its existing authorization/proof/expiry/race gates with real credentials. Exact checksums and final resource audit are retained as bounded local task evidence. Root type checking, formatting, 213 Bun tests and both production builds passed. The first integrated Node run encountered existing deadline/FIFO fixture failures under overlapping test loads; both affected files subsequently passed a focused diagnostic run. The final serialized full gate remains pending the scoped fixture correction. No publication is authorized by these checks.
