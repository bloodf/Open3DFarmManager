# Pause dispatch library checkpoint

This slice adds a durable v2 command journal and an internal pause dispatcher. It exercises dispatch ordering through an injected trusted driver contract. It does not implement a Moonraker network driver, connect a printer, or create a runnable authenticated control path.

The only implementation additions are `packages/connector/src/control/command-journal.ts` and `packages/connector/src/control/pause-dispatcher.ts`. New Node tests and this checkpoint accompany them. Existing v1 replay and commands, protocol indexes, read-only RTC, SQL, runtime, native transport, CLI, and browser code remain unchanged. No PostgreSQL migration number is reserved.

## Durable claims and unresolved printer guards

The journal uses a separate private `pause-commands.sqlite` database. It checks regular files, symlinks, and hard links for the database and existing sidecars, plus current-user ownership and private permissions on Unix. WAL mode, FULL synchronization, a 100-millisecond busy timeout, disabled extensions, an application identifier, and an exact local schema version are required. Unknown versions fail before a persistent journal-mode change. Unknown or damaged schemas are not repaired or reset.

A `BEGIN IMMEDIATE` transaction atomically claims the command ID, key/nonce pair, assignment, and stable farm/printer-key pair. Both active-printer indexes matter: a replacement assignment cannot bypass an unresolved attempt for the same farm and printer. Rows retain bounded identity and timing metadata and a command-wire SHA-256, without the raw executable command payload.

Opaque journal and receipt objects belong to module-private state. Plain objects, serialized copies, a different journal instance, or a reopened row cannot become writable receipts. Closing a journal invalidates its own receipts. A failed or ambiguous claim returns no receipt and permits no write.

The default capacity is 10,000 retained rows and can only decrease. The journal enforces ten claims per minute for the stable farm/printer-key pair and persists a wall-clock high-water mark. Backward clocks fail closed. Only final `applied` and `not-sent` rows can be pruned after ten minutes. Unresolved rows are never evicted to free capacity.

Claimed, write-started, and outcome-unknown rows keep both active guards. Reopen reports claimed and write-started rows conservatively as unresolved without changing another live writer's rows. An outcome-unknown completion is terminal for its receipt. A late promise cannot change it to applied or not-sent, and no recovered row is scanned, drained, unlocked, or retried. An unknown attempt can block its assignment and stable printer indefinitely. No reconciliation or operator-unlock API is supplied.

## Live authority and fresh state

The dispatcher constructs its own real pause-capability verifier. It accepts only genuine handles admitted by that instance, with the issuer, dual endpoint proofs, and fresh admission proof described in [the authority checkpoint](COMMAND-AUTHORITY-CHECKPOINT.md). Caller-created contexts, copied snapshots, handles from unrelated verifiers, and v1 command frames do not supply authority.

The dispatcher checks the canonical v2 signature and exact account, key, farm, agent, assignment, capability, and transport scope. The current immutable local mapping must match the capability. Commands must be issued within the capability window, have no future issuance allowance, and expire within the capability. Wall and monotonic deadlines never reset after awaits. Peer-generation changes, mapping retirement, and a locally observed revocation denial prevent further writes. A denial remains latched for that handle. The injected revocation source does not authenticate or persist remote notifications.

Eligibility requires a trusted local observation for the same assignment, printer key, and connection generation. Readiness and print state each have their own local observation time and must both be fresh. A recent progress-only update cannot refresh those fields. The pre-write state must be ready and printing, with finite, ordered timestamps. Unknown, idle, paused, error, stale, and mismatched observations deny.

Policy can reduce the approved 30-second capability, eight-second admission, five-second command, and two-second state-age maxima. The dispatcher enforces command and per-field state bounds in this slice. These checks cannot make a network read/check/write atomic with physical state. A future fixed Moonraker pause method must safely reject ineligible state at the printer boundary.

## One send boundary and explicit uncertainty

An in-process assignment slot is acquired before asynchronous work. At most eight requests can prepare or execute concurrently, and there is no wait list. A second request for the same assignment returns busy. SQLite guards extend exclusion across journal connections and processes.

After signature verification and fresh state checks, the dispatcher commits the durable claim before invoking `pauseOnce` or permitting any write. It repeats live authority and state checks after that blocking commit. The trusted driver receives a one-shot `beforeSend` callback. That callback first commits write-started, then synchronously repeats deadline, authority, revocation, mapping, and connection/state checks. A true result permits exactly one fixed pause send immediately on the same stack, with no intervening await, reconnect, queue, or retry. False or throw forbids a send. The injected driver does not prove that a future network implementation obeys this contract.

Results distinguish rejection without a claim, a consumed definite not-sent claim, applied, and outcome-unknown. Applied requires a successful fixed RPC acknowledgement, a fresh paused observation on the same connection generation with a newer sequence and post-send state timestamp, and a durable final audit write. An acknowledgement alone or an old paused display snapshot is insufficient.

The RPC and result-observation deadline is at most five seconds, anchored at dispatch entry before driver invocation. It does not extend command or capability authority. Read-only observation and audit may complete after capability expiry because no further write is permitted. Abort or timeout after a possible send means outcome-unknown. Failed final persistence also returns unknown and preserves unresolved exclusion when the result cannot be recorded. Late asynchronous completion cannot silently change the returned or journaled terminal result.

The caller receives a bounded result even if the underlying work ignores cancellation. Its slot remains occupied until that work actually settles. Eight permanently wedged operations therefore exhaust admission and fail closed. There is no automatic slot replacement or retry. This is an explicit availability limit until a real cancellable driver and recovery procedure are accepted.

## Verification and remaining gates

Eighteen focused Node tests passed: seven journal tests and eleven dispatcher tests. The journal source is `b5f8100`, the test commit is `0bc54b7`, and the validated dispatcher source is `2ad3c93037aa4d42bcdb9fe5e9f88175ebe2a8db`. The coordinator independently reran the combined 18 tests, strict TypeScript checks for both sources and both tests, formatting, and diff checks. All passed. Full `check:all` remains pending integration. No dependency installation or build was authorized for this slice.

Journal tests use actual private SQLite and independent child processes. They cover simultaneous claims released from a shared barrier, SIGKILL after committed claim and write-started phases, conservative reopen, stable-printer exclusion across replacement assignments, terminal retention, capacity, rate, high-water clocks, and storage failures. An unrelated database retains its original journal mode when rejected.

Dispatcher tests use genuine cryptographic authority handles, isolated synthetic observations, and an injected fake driver. An external SQLite read of committed write-started state triggers revocation, observation connection-generation changes, stale state, expiry, reentrant close, or abort before the final send check, with zero permitted writes. Other cases cover failed write-start and final persistence, strict post-send paused-field freshness, read-only audit after capability expiry, late completion after unknown, and the eight-slot limit when underlying work stays wedged. Fake-driver send counters establish ordering under the driver contract, not a printer's response.

There is no current transactional server issuer, authenticated control WebRTC adapter, durable printer provisioning, real Moonraker driver, runtime entry point, or HTTP command endpoint. No PostgreSQL, container, network, simulator, or physical-printer operations are part of this slice. Dependency installation and full repository builds are outside its focused checks. The coordinator tracks local verification resources and final cleanup outside the repository.

The next runnable pause gate must connect real login and approved IndexedDB keys to current transactional authority, authenticated direct browser-to-Connector WebRTC, the journal and final send guard, an instrumented fixed Moonraker pause, and fresh paused status from an isolated printing simulator. Server outage must prevent new authority, and existing authority must expire without queued recovery writes. That pause gate would still leave the remaining Phase 0 actions, safety interlocks, status, camera, and outage-recovery acceptance incomplete. Physical acceptance requires separate authorization.

The final revocation callback is followed by current authority inspection, a fresh clock sample and pure terminal/lifecycle checks. A regression reproduces reentrant abort, close and expiry from that callback and requires zero writes with a durable not-sent result. Test fixtures use independently owned temporary directories directly under the operating-system temporary directory.

## Callback-free local state at the send boundary

The dispatcher no longer invokes a driver `current()` callback. A trusted local observation owner calls `observe(binding, observation)` with per-field timestamps, connection generation and sequence; disconnect uses `null`. These are local inputs, never accepted from a command payload or backend. Each observation is parsed, copied and frozen against the immutable local assignment. Invalid or wrong-scope updates clear the prior observation. Missing updates age out under the existing two-second policy.

After durable write-start, revocation and peer-authority callbacks and the final clock sample run before the final internal observation lookup. No external callback runs between that lookup and the true send permission. Reentrant updates to idle, not-ready or a different connection generation therefore prevent a send, including updates from peer and clock callbacks. The existing fake driver now publishes observations explicitly; there is no production driver to migrate. This does not make physical printer state and a network write atomic. A real driver must publish observed disconnects and field changes before requesting permission and obey the same-stack one-send contract.

The previous final-callback connection-change trace was reproduced as an outcome-unknown result after a send. The correction's focused journal/dispatcher suite covers state/lifecycle reentry, copied input ownership, wrong-scope invalidation and disconnect; broader repository, real driver and simulator acceptance remain pending.
