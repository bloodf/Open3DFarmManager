# Connector recovery and revocation checkpoint

`PostgresConnectorRevocation.revoke` provides internal, authorized cleanup for an approved enrollment whose pairing proof expired and for a credential whose claim response was lost. No HTTP recovery or claim endpoint is exposed. The service never returns an old token, resets a pairing, or sends a printer command.

## Authorization and transaction

The request contains the independent session record ID, server session policy, farm ID, agent ID and expected immutable fingerprint. Only a current owner or admin membership in that exact farm can revoke the target. A user code, device code or JWT provides no authority here. Target discovery must come from an authenticated farm inventory or approval receipt; guessing a code is not a recovery flow.

The service locks the account, session and current farm membership before the exact target pairing and enrollment. It rejects an unauthorized caller before taking target locks. Credential metadata is locked after enrollment. This preserves the pairing-before-enrollment order used by claim. Account disable, account session-version changes, session revocation and membership removal or downgrade serialize with cleanup. Authorization is evaluated again after waits.

Migration `0011_connector_revocations` adds one immutable tombstone per agent. It records the exact farm and fingerprint, the first actor and time, and the exact issued credential `jti`, or NULL when no credential was issued. It preserves all original issuance metadata. Enrollment status changes to terminal `revoked` in the same transaction. The service also handles legacy enrollments without pairing rows.

If claim commits first, cleanup records that credential's `jti`. If cleanup commits first, claim sees the revoked enrollment and cannot issue. A repeated cleanup must still pass current session and owner/admin authorization, and returns the original tombstone without changing its actor, time or credential binding.

An internal savepoint groups the enrollment update and tombstone insertion. A final clock/session check after those writes detects expiry during foreign-key or trigger waits and clock regression. Failure rolls back both cleanup writes; an observed session expiry is persisted by the outer transaction. Success is returned only after COMMIT. A known rollback can be retried; an uncertain response requires reading durable state through an authorized service.

The separate `farm_connector_revoker` role cannot issue credentials, edit issuance metadata or mutate account/membership authority. Its limited UPDATE column grants permit row locking where required; existing immutable-row guards still apply. SQL role holders and schema owners remain trusted server components. This is service authorization, not tenant isolation against a compromised backend SQL role.

Migration rollback removes the new tombstone table and role but preserves enrollment status and original credential metadata. It does not un-revoke enrollments. Rollback therefore loses the new audit records and must not be used as a recovery operation; the down/up check ran only on the disposable synthetic fixture.

## Recovery and runtime limits

A lost successful claim response cannot be reconstructed: no JWT is stored. Cleanup revokes the old enrollment and records any issued `jti`; another credential requires a fresh pairing with a new agent ID. Reusing the same public key is allowed only through that complete new proof and approval flow. Both approval and claim retain the current at-most-60-second pairing-proof policy. Cleanup never silently renews proof or restores an old pairing.

Revocation changes current server state. The existing enrolled-Connector proof service rejects a revoked enrollment. A previously signed JWT can still pass the pure signature/claim verifier, so transport acceptance must check current enrollment, credential identity and revocation state and require fresh proof of private-key possession. A JWT alone never authorizes transport or commands.

An offline or already connected Connector cannot immediately learn a remote revocation. This slice does not stop printers, deliver commands, erase an offline key, or promise immediate remote disconnection. Connector safety enforcement remains local. Live status, camera and signed commands remain browser-to-Connector WebRTC, with no server command fallback.

HTTP exposure remains gated on authenticated exact-target discovery, strict server-configured session/CSRF handling and runtime credential acceptance that consults current state. Inventory integration is a separate slice. No browser recovery endpoint or full onboarding flow is claimed here.

## Verification

`scripts/test-postgres-connector-revocation.ts` requires explicit disposable-fixture opt-in and a loopback port. It validates the official journal through 0011 before running the helper. Separate restricted revocation and pairing runtime roles are removed and pools are closed afterward. Synthetic rows remain for the caller-owned cluster teardown. No token, private key or printer command is printed or sent.

A fresh isolated PostgreSQL cluster applied migrations 0001–0011 through the official runner and verified all eleven checksums. The runner then verified 0011 down/up. Ten real PostgreSQL acceptance groups passed:

- Expired-proof orphan cleanup and preservation of the first tombstone, with fresh authorization for idempotence.
- Legacy approved enrollment cleanup without a pairing row.
- Actual JOSE-issued credential cleanup, immutable issuance metadata, rejection by current online enrollment proof, and a successful fresh-agent pairing.
- Wrong farm, agent, fingerprint, session and non-admin denial, including no unauthorized target-lock wait.
- Account/session/membership revocation and downgrade winning before cleanup.
- Cleanup retaining authorization locks until COMMIT before those later mutations.
- Both actual claim/revocation race orders, recording one issued credential or none.
- Expiry after target-lock wait and after insertion, rollback of cleanup, and durable session expiry through clock regression.
- Deferred COMMIT failure rolling back enrollment and tombstone, followed by a known-rollback retry.
- Immutable tombstones and issuance records, restricted SQL privileges and denial of privilege escalation.

`bun run check:all` passed for the complete slice on base commit `a3b0abe`: formatting, root and Nuxt type checks, 216 Bun tests, 107 Node tests with no failures or cancellations, and both production builds. This checkpoint result was then recorded without changing implementation. The original shared fixture was not used as journal acceptance evidence. Exact journal checksums, test output and cleanup evidence are retained locally in a bounded task ledger. Publication remains separately gated.
