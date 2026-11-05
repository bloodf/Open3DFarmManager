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

Five focused Node boundary tests passed, including a genuine native issuer-key mismatch check that performs no SQL. Most service-storage interactions in these tests use patched storage methods to isolate request bounds, input snapshots, admission, closed results, and failure handling. Focused strict TypeScript and formatting checks passed. These results do not validate current database authorization or execute migration 0018.

The PostgreSQL helper and runner are prepared but unexecuted pending an exclusive authorized database window. The prepared helper covers only part of the remaining matrix. Required acceptance still includes the exact maintained migration journal and empty up/down/reapply path, populated down refusal, least-privilege roles, successful current authority, and key, membership, enrollment, credential, session, and assignment revocation races. Missing-slot parent-lock serialization, post-wait expiry, invalid-proof consumption, signing failure, precommit and deferred-commit expiry, lost-response no-redelivery, actual statement/lock/transaction timeouts, retention/high-water behavior, and new-process/database restart persistence also remain database gates.

This issuer slice changes no existing auth code, migration 0017, protocol contract, index, dispatcher, journal, runtime, CLI, or native transport. Existing-path fixes owned by other work are outside this checkpoint. No PostgreSQL, Docker, network, build, browser, simulator, or physical-printer execution was used for this source-only task. The coordinator owns dependency links and later resource cleanup.

A real issuer-to-browser-to-authenticated-WebRTC-to-fixed-driver simulator pause remains unimplemented and unaccepted. It must prove current database authority, pinned issuer trust, the actual negotiated peer, durable replay-before-write, exactly one guarded pause RPC, and fresh paused simulator state. Such a pause gate would still not complete Phase 0's remaining commands, safety, status/camera, and outage-recovery acceptance.
