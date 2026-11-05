# Session persistence and revocation contract

Status: local design and pure decision tests only. No repository adapter, database migration, session issuance, password verification or HTTP middleware is implemented. No dependency was added or executed for this review.

## Library review

Candidate: [Nuxt Auth Utils](https://github.com/atinux/nuxt-auth-utils), an MIT Nuxt module maintained by Sébastien Chopin and contributors. Its documentation describes sealed cookie sessions, scrypt helpers and session fetch/clear hooks. The [release history](https://github.com/atinux/nuxt-auth-utils/releases) shows recent maintenance: v0.5.34 and v0.6.0; the latter changes server APIs and secret configuration for Nuxt 5. The project currently uses Nuxt 4.6.4. Candidate suitability is an inference from that documentation, not a completed dependency audit or proof of compatibility. Before adoption, review a fixed version's Nuxt 4 support, transitive licenses, advisories, defaults and runtime behavior. Do not install an unreviewed latest version.

Cookie integrity alone does not establish current account/session status. Our adapter must validate current server-side state for every protected request; a UI session-fetch hook alone is insufficient. Do not place credentials or authoritative farm roles in the browser payload. Session IDs in the contract are internal references extracted only after library verification, not a token format or entropy specification.

## Standards comparison

[OWASP's session guidance](https://cheatsheetseries.owasp.org/cheatsheets/Session_Management_Cheat_Sheet.html) calls for server-enforced idle and absolute expiration, server-side logout invalidation and session renewal around authentication or privilege changes. Existing cookie configuration covers host-only, Secure, HttpOnly and SameSite attributes; transport and browser behavior remain untested. The older rolling-duration requirement is not a complete expiration policy: idle and absolute durations and reauthentication triggers still need an explicit decision. This contract accepts policy input and chooses no production duration.

## Proposed persistence boundary

A dedicated account row contains an immutable account ID, monotonically increasing session version and disabled state. A session row has a unique internal ID, owning account ID, captured account version, creation and last-use times, immutable absolute expiry and nullable revocation timestamp. Times are integer milliseconds from a trusted server clock. Session material, passwords and email addresses are intentionally outside this contract.

`SessionRepository.authorizeAndTouch` must read both rows and evaluate/touch them in one transaction serialized against revocation. It must return success only after commit. Reject missing records, wrong identity bindings, disabled accounts, version mismatches, revocation, expiry or invalid state. Storage errors must return `storage-unavailable`; never accept cached cookie claims as fallback. The pure `evaluateSession` helper specifies the decision but does not provide transaction isolation or storage.

Single-session logout durably marks or deletes the session and is idempotent. Account-wide invalidation atomically increments the account version; old sessions cannot regain validity. Password-reset/account-disable operations must commit their state changes and invalidation together. Prevent counter overflow rather than wrapping. Rotation must invalidate the old reference atomically with new-session creation; never reactivate or reuse an old session ID. These lifecycle operations are requirements, not implemented methods beyond the interface.

Revocation applies to authorizations serialized after its commit. Already authorized requests are not magically cancelled. Sensitive actions need their own transaction/revalidation boundary. On backup restoration, prevent old account versions or revoked sessions from becoming valid again, for example through a separately controlled restoration epoch or mandatory session invalidation; a restore procedure remains to be designed.

## Evidence and open gates

Seven unit tests cover active snapshots, missing records, revocation/version/disabled state, exact expiry boundaries, identity mismatch, invalid/regressing clocks and malformed runtime input. They use synthetic IDs and timestamps, with no real account or secret.

A future database adapter needs additional tests for concurrent logout/touch, reset/login races, unique insertion, transaction rollback, storage failure, crash/restart durability and backup restoration. Endpoint tests must verify the cookie library, per-request state checks, logout ordering, CSRF and response redaction. Farm authorization is separate. No offline Connector revocation policy is decided here.

## Test-only in-memory adapter

`tests/helpers/memory-session-repository.ts` implements the interface as a deterministic test double. It belongs to server-login tests, not Connector storage. The application does not import it. Each method performs its state transition without yielding, so same-turn calls model a chosen serial order. Fixtures and inspection results are copied to prevent outside mutation. There is no creation API, credential/token handling, disk access or production fallback.

Ten additional tests exercise activity updates, immutable absolute expiry, idempotent logout, account-wide invalidation, unrelated-account isolation, both logout/authorization orderings, account-revocation ordering, injected unavailability, clock rollback, fixture isolation, version overflow and invalid fixtures. The in-memory clock high-water mark rejects backward time even after denied authorization; it does not survive process restart. A failed version increment reports failure rather than wrapping. Simulated storage unavailability happens before an operation and does not test partial database commit failures.

The double intentionally provides no durability, database transaction isolation or cross-process concurrency guarantee. Its successful revocation models a committed operation only for the lifetime of the test instance. Production adapters still need real race, rollback, restart and restore tests. Server policy durations, session-library integration and offline Connector authorization remain undecided or unimplemented as previously recorded.
