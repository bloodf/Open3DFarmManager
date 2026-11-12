# Internal pause issuer source checkpoint

This slice adds an internal authority service, a PostgreSQL adapter, and proposed migration `0018_pause_authority`. It has no route, runtime configuration, or command transport. The adapter's database authorization and migration behavior have not been executed against PostgreSQL. This checkpoint records source review and focused boundary tests, not a validated runtime authority path.

## Internal API and key custody

`createPauseAuthorityService(sql, config)` constructs the concrete `PostgresPauseAuthority` adapter. Its methods are:

- `issueChallenge({ sessionRecordId, request: { browserProofWire, connectorProofWire, admissionNonce } })`, returning a pause-admission challenge or a closed failure reason.
- `issueCapability({ sessionRecordId, request: { admissionProofWire } })`, returning a signed pause capability or a closed failure reason.

The private session reference must come from the reviewed sealed own-login flow. Its shape does not authenticate a caller. Text account identity comes from the session's current database account, and client transcript fields serve only as values to compare against stored authority. No login reference, browser-selected role, command payload, arbitrary action, or bearer JWT supplies authority.

Configuration contains the trusted origin, command audience, issuer, key ID, credential issuer and audience, the maintained 30-minute idle policy, and optional downward pause-policy limits. The dedicated issuer signing key is injected as a nonextractable Ed25519 private `CryptoKey`, with a separately pinned public verification key. A lazy native sign/verify check uses a dedicated local configuration domain to reject mismatched pairs before SQL. It does not create a synthetic capability or generate a key. Keys and settings are captured at construction and never stored in the database or returned by the service.

The service admits at most eight operations process-wide, including configuration cryptography and blocked SQL. It has no wait list. A hung operation retains its slot until it actually settles. Closing the service stops new calls but does not cancel or reinterpret an in-flight issuance, and the service does not own the supplied pool.

## Intended transactional authority

The adapter decodes bounded canonical control proofs and requires browser and Connector roles over exactly the same pause-control binding. Native signatures, public keys, fingerprints, transcript digest, configured origin and audience, and every identity must agree with current stored records. It does not reuse a read-only RTC binding.

The lock order starts with account SHARE and session UPDATE through the existing migration-0017 expiry observer. It then takes membership SHARE, owning browser key SHARE, enrollment SHARE, credential UPDATE, an existing migration-0014 proof-slot SHARE, and assignment SHARE. New watermark, allocation budget, and challenge rows come last. Credential UPDATE is deliberately stronger than a passive read. Gap serialization relies on the maintained acceptor locking that parent credential before creating a proof slot. Under that parent-first order, a missing slot cannot appear concurrently behind this issuer's authority snapshot. The actual race remains a PostgreSQL integration gate. A missing slot is allowed. A present terminal credential-expiry marker or future observation watermark denies. No slot is created, consumed, reset, or used as the command-admission quota.

The intended checks require a current enabled account, valid session version and idle/absolute lifetime, active owner/admin/operator membership, an approved nonrevoked owning browser key, approved matching enrollment, current unrevoked credential, and active immutable printer assignment. Viewer is denied. Session expiry observation can persist a genuine expiry tombstone but cannot renew session activity. New DB-clock samples follow waits and cryptography, before signing, after signing, and after the final potentially blocking watermark statement.

The distinct admission challenge lasts at most eight seconds. A successfully signed capability lasts at most 30 seconds and is clipped to the session idle and absolute deadlines, credential expiry, and control-binding expiry. Configured limits can only decrease the established hard maxima. The database stores public transcript/challenge metadata and signed-capability audit data, never executable commands or issuer private keys.

Signing and challenge consumption occur in a transaction with a savepoint. Expiry or signing failure rolls back partial issuance, then records a terminal expired or rejected challenge outside the savepoint when storage remains available. A well-formed matching cryptographic failure consumes its challenge once. Public success is withheld until commit. A separate bounded DB-time/high-water read after commit denies stale delivery if a deferred commit wait exhausted the deadline. This read does not retrieve an earlier capability for redelivery.

## Bounds, retention, and SQL capabilities

The proposed adapter serializes allocation behind a durable global clock watermark. It caps retained challenges at 4,096 globally and 64 per account. A session can allocate at most 60 distinct challenges per 15-minute window. The unique transport ID permits only one challenge for that transport, and `(agent_id, credential_jti, admission_nonce)` remains unique across transports. This command quota does not spend or renew browser enrollment's three lifetime challenges.

Terminal retention is one hour after the maximum of terminal observation time, challenge expiry, control-binding expiry, credential expiry, and any capability expiry. Thus nonce guards survive the entire credential lifetime and the additional retention period. Cleanup never deletes a pending challenge or an unexpired guard. The no-argument retention function uses only the database clock and fixed predicates, with batches of at most 128 rows per cleanup step. It locks and advances the durable watermark before pruning, so deleting old guards cannot permit a backward clock to revive expired credentials. Session allocation rows can be removed only one hour after their window start and after all retained challenges are gone. The retention function advances the watermark and prunes in the same transaction.

The new `farm_pause_authority` role is NOLOGIN and receives only required reads, identity-column row-lock capabilities, inserts and terminal updates on its own tables, and EXECUTE on the existing expiry observer. It receives no general account, session, membership, enrollment, credential, browser-key, or assignment mutation powers. The separate retention owner is not granted to runtime logins. New functions use qualified PostgreSQL types and the fixed `pg_catalog, farm, pg_temp` search path. The retention function accepts no user clock, cutoff, or deletion predicate. Down migration refuses to discard populated audit, allocation, or observed-watermark state.

Issued and delivered are distinct outcomes. In particular, postcommit expiry denial can leave an issued capability and consumed challenge durably recorded without delivering that capability. An unavailable or lost response may also correspond to a committed capability. Retrying does not retrieve, re-sign, refresh, or replace that result. Any previously issued capability keeps its original deadline. Closing a service or UI peer does not establish remote offline revocation.

## Evidence and pending acceptance

Six focused Node boundary tests passed at source-fix commit `aa24d95c7028d8c0cc566fded91d8678bea8aad5`, including a genuine native issuer-key mismatch check that performs no SQL. Most service-storage interactions in these tests use patched storage methods to isolate request bounds, input snapshots, admission, closed results, and failure handling. Focused strict TypeScript and formatting checks passed. These results do not validate current database authorization or execute migration 0018.

An independent source review of issuer commit `9c1d838` established no actionable security defect. It identified a real dependency gap: that exact tree lacked migration 0017. Dependency merge `d8b40e8653b4ce20dc885c6d877fd67045e074e5` incorporates the maintained 0017 pair while preserving the issuer sources. The coordinator's source-catalog loader now accepts the contiguous 18-pair catalog. This closes the source-tree gap; it does not establish a database journal, successful migration execution, or PostgreSQL acceptance. The review's runtime and integration objections remain open.

Subsequent source inspection identified a delivery-deadline defect beyond that review: capability postcommit freshness used the capability's up-to-30-second expiry without retaining the original eight-second admission deadline. Commit `aa24d95` fixes the source by carrying that fixed deadline internally and deducting the entire bounded freshness transaction's monotonic elapsed time after its COMMIT. There is no public deadline field or later unchecked asynchronous wait. A capability can remain durably issued even when late delivery is denied. The sixth Node test checks this accounting with controlled dependencies. The prepared real deferred-commit test waits until the admission has less than 750 milliseconds remaining, imposes a one-second commit delay, and requires denial with the issued audit preserved. The actual PostgreSQL case remains unrun.

The PostgreSQL runner and helpers are prepared but unexecuted pending an exclusive authorized database window. `scripts/test-postgres-pause-authority.ts` requires the disposable opt-in and assigned loopback port. It checks database/user identity and the exact full 18-entry catalog/journal before running the catalog, Connector-revocation and issuer helpers in that order. Its application dependencies require Bun; plain Node type stripping is not assumed. The maintained migration CLI remains a separate entry point.

Prepared coverage is source-only:

- Official empty 0018 down/reapply through `runMigrations`, populated down refusal, ownership and ACLs, restricted roles, denied mutations, definer isolation, bounded 128-row expiry/deletion, and a real database-time retention boundary.
- Actual two-second statement, one-second lock and ten-second transaction deadlines, pool recovery, maintained credential-acceptor contention, invalid-proof consumption, native signing failure, deferred-commit rollback, actually committed response loss, and admission-expiry delivery denial.
- Independent current-authority cases, including account-version change and idle/absolute expiry after row waits. The short expiry fixtures use 500-millisecond timing margins and have not established reliable runtime results.
- Browser-key and assignment races in both orders, and six fresh Connector-revocation cases. Enrollment-only terminal updates and ordinary-schema synthetic credential-expiry markers isolate their respective predicates. Markers leave enrollment approved and do not prove actual elapsed credential expiry. The maintained revoker changes enrollment and its credential tombstone atomically, so those cases establish its combined lifecycle rather than a credential-only predicate.
- Session 60-allocation and account 64-allocation limits through actual authority calls. The global fixture seeds synthetic retained pending rows to 4,095, then races two genuine allocations for the final slot. It expects one winner and exactly 4,096 retained rows. This does not prove 4,096 authenticated issuances.
- Separate-process/database-restart phases, immutable audit/deadline hashes and SQL nonce/terminal guards independent of expired-proof denial.

The runner exposes `run`, `prepare-restart` and `verify-restart`. Restart handoffs use a private absolute path outside the checkout, mode 0600, bounded files and no overwrite. A later fresh process verifies the journal and stored audit after the task cluster restarts. Its restricted-role SQL uniqueness and terminal-state assertions provide evidence independent of old-proof expiry. The API replay case uses a new synthetic issuer key; it does not establish continuity of the original issuer trust anchor across restart. All phases remain unrun.

The corrected signing-failure fixture expects a terminal rejected challenge with no capability and denies a subsequent retry. A separate real COMMIT-rollback case permits retry only because that transaction never committed. A committed lost response must retain its issued audit and must not redeliver, re-sign or extend authority. These are separate cases, not interchangeable evidence.

Every listed PostgreSQL case still needs execution against the pinned integrated head. Source assertions, configured timeout values and prepared phase wiring are not passing acceptance. The external recipe records isolated cluster/proxy ownership, original-fixture baselines, bounded deadlines and cleanup/release. No ports or database resources were allocated by preparing it. The complete repository `pnpm run check:all` gate also remains pending on the eventual integrated head.

Later isolated execution applied the official 18-entry catalog, but the first prepared suite stopped at its client-side transaction-timeout assertion. A separate bounded diagnostic established a same-backend server FATAL `25P04` after ten seconds; its final client error was sampled after pool cleanup and does not prove pre-cleanup propagation. The source-only adaptation now requires `PAUSE_AUTHORITY_SYNTHETIC_SERVER_LOG`, an explicit absolute path inside the disposable server. It uses a separate max-one timeout pool before the main issuer pool, per-login verbose logging, bounded admin log reads with an unchanged-prefix digest, and exact PID/SQLSTATE/database-time correlation. Missing, truncated or ambiguous evidence fails. Client settlement before and after pool cleanup is recorded separately; generic disconnection is insufficient. This maintained adaptation and a fresh full suite remain unexecuted. The old populated fixture remains held; it must not be reset or reused for the empty down/up gate without an explicit lifecycle handoff.

This issuer slice changes no existing auth code, migration 0017, protocol contract, index, dispatcher, journal, runtime, CLI, or native transport. The dependency merge and existing-path fixes owned by other work are outside the issuer's implementation scope. No PostgreSQL, Docker, network, build, browser, simulator, or physical-printer execution was used for this source-only issuer preparation. The coordinator owns dependency links and later resource cleanup.

A real issuer-to-browser-to-authenticated-WebRTC-to-fixed-driver simulator pause remains unimplemented and unaccepted. It must prove current database authority, pinned issuer trust, the actual negotiated peer, durable replay-before-write, exactly one guarded pause RPC, and fresh paused simulator state. Such a pause gate would still not complete Phase 0's remaining commands, safety, status/camera, and outage-recovery acceptance.

## Subsequent maintained PostgreSQL execution

At `b21df2b39335218ea43fd4c211ca24ffd31c585b`, a fresh owned PostgreSQL
17.11 cluster passed the maintained preparation phase in 55.965 seconds.
Its twenty named checks include official journal 18 → 17 → 18, ACL and
temporary-shadow isolation, current-authority and credential-slot contention,
retention boundaries, signing failure, rollback versus lost response, and
late-delivery denial after deferred commit. The global-cap test uses 4,095
synthetic retained rows followed by two genuine competing allocations; it is
not evidence of 4,096 authenticated issuances.

The timeout helper correlated the exact backend identity, in-transaction
settings, database interval and server FATAL `25P04` at about ten seconds.
The client was pending before pool cleanup and rejected with
`CONNECTION_DESTROYED` afterward. Server timeout enforcement passed; client
propagation of the FATAL error did not. Earlier transport, dependency and
probe failures remain recorded separately and were not counted as passes.

An actual restart of that same cluster then passed three checks in a fresh
process: exact journal and retained terminal/deadline hashes, restricted-role
nonce uniqueness and terminal immutability, and rejection of the old proof.
The replay case uses a new synthetic issuer key and does not establish
continuity of the original issuer key. This restart covered 0018, not the
later 0019 assignment authorization migration.

Independent audits found no remaining test roles or client backends and
confirmed the original database identity, journal and table counts unchanged.
The owned database and bridge were explicitly handed back to root and retained
for later integration. The production issuer-to-control-RTC-to-driver simulator
pause remains a separate, incomplete gate.
