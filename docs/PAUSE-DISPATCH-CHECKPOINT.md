# Pause dispatch library checkpoint

This slice adds a durable v2 command journal and an internal pause dispatcher. It exercises dispatch ordering through an injected trusted driver contract. It does not implement a Moonraker network driver, connect a printer, or create a runnable authenticated control path.

The library comprises the pause verifier, command journal, dispatcher and their focused Node tests. This correction changes only those modules, tests and this checkpoint. Existing v1 replay and commands, protocol indexes, read-only RTC, SQL, runtime, native transport, CLI and browser code are outside this correction. It reserves no PostgreSQL migration number. Concurrent server issuer work has separate ownership and validation.

## Durable claims and unresolved printer guards

The journal uses a separate private `pause-commands.sqlite` database. It checks regular files, symlinks, and hard links for the database and existing sidecars, plus current-user ownership and private permissions on Unix. WAL mode, FULL synchronization, a 100-millisecond busy timeout, disabled extensions, an application identifier, and an exact local schema version are required. Unknown versions fail before a persistent journal-mode change. Unknown or damaged schemas are not repaired or reset.

A `BEGIN IMMEDIATE` transaction atomically claims the command ID, key/nonce pair, assignment, and stable farm/printer-key pair. Both active-printer indexes matter: a replacement assignment cannot bypass an unresolved attempt for the same farm and printer. Rows retain bounded identity and timing metadata and a command-wire SHA-256, without the raw executable command payload.

Opaque journal and receipt objects belong to module-private state. Plain objects, serialized copies, a different journal instance, or a reopened row cannot become writable receipts. Closing a journal invalidates its own receipts. A failed or ambiguous claim returns no receipt and permits no write.

The default capacity is 10,000 retained rows and can only decrease. The journal enforces ten claims per minute for the stable farm/printer-key pair and persists a wall-clock high-water mark. Backward clocks fail closed. Only final `applied` and `not-sent` rows can be pruned after ten minutes. Unresolved rows are never evicted to free capacity.

Claimed, write-started, and outcome-unknown rows keep both active guards. Reopen reports claimed and write-started rows conservatively as unresolved without changing another live writer's rows. An outcome-unknown completion is terminal for its receipt. A late promise cannot change it to applied or not-sent, and no recovered row is scanned, drained, unlocked, or retried. An unknown attempt can block its assignment and stable printer indefinitely. No reconciliation or operator-unlock API is supplied.

## Live authority and fresh state

The dispatcher constructs its own real pause-capability verifier. It accepts only genuine handles admitted by that instance, with the issuer, dual endpoint proofs, and fresh admission proof described in [the authority checkpoint](COMMAND-AUTHORITY-CHECKPOINT.md). Caller-created contexts, copied snapshots, handles from unrelated verifiers, and v1 command frames do not supply authority.

The dispatcher checks the canonical v2 signature and exact account, key, farm, agent, assignment, capability, and transport scope. The current immutable local mapping must match the capability. Commands must be issued within the capability window, have no future issuance allowance, and expire within the capability. Wall and monotonic deadlines never reset after awaits. Peer-generation changes, mapping retirement and explicit local revocation prevent further writes. The verifier owns opaque peer state: `createPeer(initialGeneration)` returns a peer handle plus a trusted local publisher with strictly increasing `advance(nextGeneration)` and terminal `close()`. An invalid or non-increasing advance closes that publisher. Admission captures its current generation; another verifier's peer cannot supply authority. `revoke(handle)` is terminal for that genuine capability. These local publishers do not authenticate or persist remote notifications. The former generation and revocation polling callbacks have been removed.

Eligibility requires a trusted local observation for the same assignment, printer key, and connection generation. Readiness and print state each have their own local observation time and must both be fresh. A recent progress-only update cannot refresh those fields. The pre-write state must be ready and printing, with finite, ordered timestamps. Unknown, idle, paused, error, stale, and mismatched observations deny.

Policy can reduce the approved 30-second capability, eight-second admission, five-second command, and two-second state-age maxima. The dispatcher enforces command and per-field state bounds in this slice. These checks cannot make a network read/check/write atomic with physical state. A future fixed Moonraker pause method must safely reject ineligible state at the printer boundary.

## One send boundary and explicit uncertainty

An in-process assignment slot is acquired before asynchronous work. At most eight requests can prepare or execute concurrently, and there is no wait list. A second request for the same assignment returns busy. SQLite guards extend exclusion across journal connections and processes.

After signature verification and fresh state checks, the dispatcher commits the durable claim before invoking `pauseOnce` or permitting any write. It repeats live authority and state checks after that blocking commit. The trusted driver receives a one-shot `beforeSend` callback. That callback first commits write-started, then samples both trusted clocks. It subsequently checks deadline, authority, latched revocation, mapping and connection/state using only module-owned state. No externally supplied callback runs after those clock samples before send permission. A true result permits exactly one fixed pause send immediately on the same stack, with no intervening await, reconnect, queue, or retry. False or throw forbids a send. The injected driver does not prove that a future network implementation obeys this contract.

Results distinguish rejection without a claim, a consumed definite not-sent claim, applied, and outcome-unknown. Applied requires a successful fixed RPC acknowledgement, a fresh paused observation on the same connection generation with a newer sequence and post-send state timestamp, and a durable final audit write. An acknowledgement alone or an old paused display snapshot is insufficient.

The RPC and result-observation deadline is at most five seconds, anchored at dispatch entry before driver invocation. It does not extend command or capability authority. Read-only observation and audit may complete after capability expiry because no further write is permitted. Abort or timeout after a possible send means outcome-unknown. Failed final persistence also returns unknown and preserves unresolved exclusion when the result cannot be recorded. Late asynchronous completion cannot silently change the returned or journaled terminal result.

The caller receives a bounded result even if the underlying work ignores cancellation. Its slot remains occupied until that work actually settles. Eight permanently wedged operations therefore exhaust admission and fail closed. There is no automatic slot replacement or retry. This is an explicit availability limit until a real cancellable driver and recovery procedure are accepted.

## Verification and remaining gates

Eighteen focused Node tests passed: seven journal tests and eleven dispatcher tests. The journal source is `b5f8100`, the test commit is `0bc54b7`, and the validated dispatcher source is `2ad3c93037aa4d42bcdb9fe5e9f88175ebe2a8db`. The coordinator independently reran the combined 18 tests, strict TypeScript checks for both sources and both tests, formatting, and diff checks. All passed. Full `check:all` remains pending integration. No dependency installation or build was authorized for this slice.

Journal tests use actual private SQLite and independent child processes. They cover simultaneous claims released from a shared barrier, SIGKILL after committed claim and write-started phases, conservative reopen, stable-printer exclusion across replacement assignments, terminal retention, capacity, rate, high-water clocks, and storage failures. An unrelated database retains its original journal mode when rejected.

Dispatcher tests use genuine cryptographic authority handles, isolated synthetic observations, and an injected fake driver. An external SQLite read of committed write-started state triggers revocation, observation connection-generation changes, stale state, expiry, reentrant close, or abort before the final send check, with zero permitted writes. Other cases cover failed write-start and final persistence, strict post-send paused-field freshness, read-only audit after capability expiry, late completion after unknown, and the eight-slot limit when underlying work stays wedged. Fake-driver send counters establish ordering under the driver contract, not a printer's response.

This focused library gate does not validate a transactional server issuer, authenticated control WebRTC adapter, durable printer provisioning, real Moonraker driver, runtime entry point or HTTP command endpoint. No PostgreSQL, container, network, simulator, or physical-printer operations are part of this slice. Dependency installation and full repository builds are outside its focused checks. The coordinator tracks local verification resources and final cleanup outside the repository.

The next runnable pause gate must connect real login and approved IndexedDB keys to current transactional authority, authenticated direct browser-to-Connector WebRTC, the journal and final send guard, an instrumented fixed Moonraker pause, and fresh paused status from an isolated printing simulator. Server outage must prevent new authority, and existing authority must expire without queued recovery writes. That pause gate would still leave the remaining Phase 0 actions, safety interlocks, status, camera, and outage-recovery acceptance incomplete. Physical acceptance requires separate authorization.

## Structural final decisions after trusted clock sampling

The correction replaces callback polling with opaque verifier-owned lifecycle state and explicit latched revocation. `inspectAt(handle, wall, mono)` validates primitive local measurements and inspects authority without invoking clocks or external callbacks. `inspectLifecycle(handle)` is a pure local consistency check for read-only result auditing; it deliberately ignores time-only capability expiry and cannot authorize a new write. Genuine handle provenance, immutable mapping and peer-generation checks remain mandatory. Observed expiry still permanently prevents further writes for that handle.

A trusted local observation owner calls `observe(binding, observation)` with per-field timestamps, connection generation and sequence; disconnect uses `null`. These inputs never come from a command payload or backend. Observations are parsed, copied and frozen. Invalid or wrong-scope input clears the prior observation. Generation rollback is rejected. Disconnect, malformed input and generation changes replace a private version token; an in-flight attempt cannot regain eligibility when another publication restores the prior shape. Missing updates age out under the two-second policy. This is a trusted publisher contract, not an authenticated production driver.

After write-started commits, both clock callbacks run before the final pure authority, lifecycle, mapping, observation and attempt-state checks. The final cursor comes from that same local observation. The driver's one-send same-stack contract is unchanged. This does not make physical printer state and a network write atomic.

For result completion, driver result properties are parsed and copied first. Driver abort listeners and cancellation cleanup run before the final clock samples. The dispatcher then checks the paused snapshot together with current local lifecycle, mapping, revocation and observation-version state. Any invalidation yields durable outcome-unknown. Abort listeners or clock callbacks cannot reopen a terminal attempt.

The applied path calls `finishCommandAt` with the already sampled primitive wall time. Its SQLite transaction performs the existing validation and durable high-water check without invoking the journal's injected clock. A regressed or invalid sample fails closed, consumes the receipt's completion attempt and leaves unresolved exclusion intact. The existing journal finalization API retains its original clock sampling after the receipt latch for other journal callers. No schema, SQLite durability settings, pruning, replay, rate, capacity or unknown-blocking policy changes are included.

## Correction verification

Thirty-six focused Node tests passed: eleven authority/protocol tests, seventeen dispatcher tests and eight journal tests. The exact command is `node --test tests/node/pause-authority-contract.test.ts tests/node/pause-dispatcher.test.ts tests/node/command-journal.test.ts`. Focused strict TypeScript, changed-file formatting and diff checks passed. The earlier 18-test record above is historical validation of the explicitly named earlier commits.

The new send and result regressions inject changes from the last monotonic clock callback, including explicit revocation, peer closure or generation advance, disconnect, connection-generation change, and disconnect/restore or attempted generation rollback. Send cases require zero writes and a durable not-sent row. Result cases require one prior synthetic write, outcome-unknown and a durable unresolved row, never applied. Additional cases exercise abort-listener invalidation before the result decision, write-start journal-clock reentry, and an armed malicious final journal-clock callback that must never be invoked on the applied path. Existing cross-process SQLite, eight wedged slots, short deadlines, offline expiry, late completions and readonly audit-after-expiry tests remain green.

Repository-wide TypeScript was attempted but this existing worktree lacks unrelated Nuxt, hashing, workspace and browser-test dependency resolution; that attempt did not pass. No dependency install or broad build was performed. Full `check:all`, production transport/driver integration, simulator pause and physical acceptance remain pending separate gates. Focused tests created and removed their own temporary SQLite directories; bounded local logs are retained outside the repository. Pre-existing shared dependency links remain for active workers.

## Dispatcher and fixed-driver composition

The subsequent `tests/node/pause-dispatch-driver-integration.test.ts` exercises
the actual dispatcher, cryptographic verifier, SQLite journal and maintained
fixed WebSocket pause driver together. The only printer endpoint is the
existing original loopback Moonraker protocol fixture. Issuer keys, control
transcript and local assignment provisioning are synthetic; no actual control
RTC or current PostgreSQL authority is supplied.

Four Node 24.20 tests passed in about 770 ms. They verify one fixed pause RPC,
a later complete paused query and durable `applied` after journal reopen;
authority or observation invalidation before dispatch with no pause; and
lost acknowledgement or socket disconnection after the request with durable
`outcome-unknown`. Reopening the journal still blocks a new claim for both the
same assignment and a replacement assignment for the same farm/printer key.
There is no automatic resend or reconnection.

Focused strict TypeScript, formatting and whitespace checks passed. All five
fixture listeners and temporary SQLite directories were closed or removed.
Initial test-authoring failures remain in the private evidence. No production
source changed for this test. This closes the isolated driver/dispatcher
composition gap, while issuer HTTP/runtime wiring, browser control transport,
real printing-simulator state, outage cases and the complete source gate remain
separate requirements.
