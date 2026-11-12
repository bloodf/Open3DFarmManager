# Offline authorization lifetime

Phase 0 requires a defined limit on how long previously issued authorization stays usable while a Connector cannot reach the server, and proof that expiry fails closed. This document sets that limit. Enforcement is in `packages/connector/src/auth/offline-authority.ts`.

## What counts as cached authority

Some state is issued or confirmed by the server and then relied on locally without asking the server again. That includes trusted issuer and browser keys, the Connector's own credential and assignment state, and the server-signed pause capability with its control binding.

The pause capability path already has hard bounds in code. A capability lasts at most 30 s (`PAUSE_POLICY_HARD_MAXIMUMS.capabilityMs`, plus the `capability_expires_at <= consumed_at + 30000` check in migration 0018). A control binding lasts at most 30 s, an admission at most 8 s and a command at most 5 s. Each signed capability was issued by an online server, so it is fresh evidence by itself. The new bound covers state that has no signature of its own and comes only from the last server contact, such as the planned trusted-key cache.

The v1 `authorizeCommand` lease is supplied by the caller and capped at 60 s. That cap does not enforce the offline lifetime: the transport must still authenticate where the lease came from.

## Bound

| Setting                                           | Value                                                                      |
| ------------------------------------------------- | -------------------------------------------------------------------------- |
| Default lifetime (`OFFLINE_AUTHORITY_DEFAULT_MS`) | 30 000 ms, the same as the capability and binding maximum                  |
| Hard maximum (`OFFLINE_AUTHORITY_MAX_MS`)         | 60 000 ms, the same as the v1 lease cap                                    |
| Configurable range                                | an integer from 1 to 60 000 ms. Anything else is rejected at construction. |

Cached authority is fresh only while both `mono - confirmedMono < lifetime` and `wall - confirmedWall < lifetime` hold. At exactly the bound it is stale.

## Clock assumptions

- **Samples:** every call takes one `{ wall: Date.now(), mono: performance.now() }` pair, read immediately before the call. The caller passes the same pair it uses for its own deadline checks. Never reuse an older sample or combine readings taken at different moments.
- **Monotonic time** measures elapsed time within one process. Wall-clock time is still checked so that signed `issued_at`/`expires_at` values stay comparable.
- **Skew:** if wall time and monotonic time drift apart by more than 1 000 ms after the confirmation anchor, authority goes stale. The pause verifier and dispatcher already use the same tolerance. A forward wall jump (for example an NTP step) therefore fails closed.
- **Regression:** a backwards step in wall or monotonic time, or a non-finite or negative sample, makes authority stale immediately.
- **Restart:** nothing is persisted. After a restart, authority stays stale until the first authenticated `confirm()`. This removes any dependence on the wall clock across restarts.

## Confirmation and revocation ordering

- `confirm(now, serverSeq)` needs a server sequence number that is greater than every earlier confirm and revocation. Any confirm with an equal or lower number is refused. This stops replayed or delayed confirmations.
- `revoke(serverSeq?)` makes authority stale immediately. When a server sequence is given, it raises the minimum, so a confirm sent before the revocation cannot revive authority. Even without a sequence, the last confirm already accepted cannot be replayed.
- After a stale transition, only a newer `confirm()` restores freshness. Time passing, clock samples and older confirms do not.

## At expiry

- **Commands:** `createPauseCapabilityVerifier({ freshness })` checks freshness against the same clock sample during `admit()` (at every recheck between asynchronous steps) and during `inspectAt()` before each dispatch boundary. A stale result returns `expired-or-inactive`. The dispatcher then rejects with `invalid-authority`, and the handle is latched as expired, so reconfirmation cannot revive it. The browser must obtain a new capability.
- **The relay requires it:** `createPauseCommandRelay` requires `authority.freshness` and always passes it to the verifier. The low-level verifier keeps it optional for unit tests only.
- **Read-only:** status, telemetry, camera and `inspectLifecycle()` result auditing do not check freshness. Loss of connectivity alone does not stop a print, and local watchdogs keep running.
- **Audit:** `onStale(reason)` runs once per fresh-to-stale transition, with `expired`, `clock` or `revoked`, so the runtime can write a local audit entry. If the audit callback throws, authority is still not restored.

## Revocation latency tradeoff

An offline Connector cannot learn about a remote revocation. Revoked authority can therefore stay usable for up to one lifetime after the last server confirmation: 30 s by default, 60 s at most. A longer window would allow more control during outages, but a stolen browser key or revoked membership would then keep working for longer. During a longer outage, Phase 0 chooses safety: remote commands stop and the farm stays observable. The pause capability path is not loosened: it remains bounded by its own signed expiry no matter what the tracker says.

## Interface

```ts
interface CachedAuthorityFreshness {
  freshAt(now: { wall: number; mono: number }): boolean
}
```

`createOfflineAuthority({ maxAgeMs?, onStale? })` returns `freshness`, `confirm`, `revoke` and `maxAgeMs`. `freshness` is a frozen `{ freshAt }` view. Only that view goes to the verifier, the relay or a later trusted-key cache, so consumers can read freshness but cannot confirm or revoke. The tracker has no clock of its own and does no I/O.

## Runtime wiring

The Connector agent creates one tracker when `pause.control` is configured and passes only its `freshness` view to the pause relay.

- **Source:** the server sends `connector.authority-confirm` on the read-only Connector inbox (`/api/signalling/connector`) right after `connector.inbox-ready` and after every successful 5 s current-authority reread (enrollment approved, credential current and unrevoked, unchanged identity pins). That is at most `maxAgeMs / 6`. The frame is sent after the reread result has been applied to the connection. It carries `server_seq`, `farm_id`, `agent_id` and `credential_jti`.
- **Connector acceptance:** `AuthenticatedConnectorSignallingClient` accepts the frame only after the server admitted the inbox credential proof, and only when farm, agent and credential id match its own scope; anything else is terminal. The agent then calls `confirm({ wall: Date.now(), mono: performance.now() }, server_seq)`. The pause signalling client, the WebRTC peers and browser frames have no path to `confirm()`.
- **Revocation:** when a reread fails, the server sends `connector.authority-revoked` with a higher `server_seq` and closes the inbox. The agent calls `revoke(server_seq)`.
- **Sequence:** `server_seq = max(previous + 1, databaseObservedAtMs * 1000)`, so it strictly increases within a process and, anchored to database time, across restarts and instances.
- **Backoff:** `runSignallingLifecycle` resets backoff to `retryMinMs` once a session's inbox is admitted, so reconnect gaps stay far below the lifetime.
- **Audit:** every stale transition appends one fsynced JSON line to `<data>/pause-journal/authority-audit.jsonl` (private file, no symlink, 1 MiB bound) and emits `pause-authority-stale`. A failed or full write emits `pause-audit-failed` and never restores authority.

Without the read-only `signalling` section no confirmation arrives and the pause path stays inert.

## Threat considerations

- **Forged confirmation:** requires the TLS-authenticated server connection after a Connector credential proof-of-possession. Frames before admission or for another credential end the session. WebRTC data channels and browser input cannot reach `confirm()`.
- **Replay or reordering:** inside one TLS connection frames cannot be replayed; across connections the tracker refuses any `server_seq` at or below its floor.
- **Clock faults:** a database clock that steps backwards produces lower sequences that the tracker refuses, so authority goes stale (fail closed) until database time passes the floor. Several server instances share database time; a lagging one can only be refused.
- **Transient failures count as revocation:** the reader returns no authority for both revocation and database errors, so either sends `authority-revoked`. This favours safety; the next admitted inbox confirms again.
- **Silent loss:** a dropped socket or a server that stops confirming leaves authority to expire after `maxAgeMs` (30 s).
- **Scope of the attestation:** the confirmation covers Connector enrollment, credential and revocation state. Assignment, membership and browser-key state are still checked by the issuer for each capability, which lives at most 30 s. The issuer keyring is local configuration, not server-provided state.
- **Compromised server:** it can confirm, but it already issues capabilities; the tracker does not defend against it.
- **Audit tampering:** the audit file is local and private but not signed; it records events for operators, it is not evidence against a local attacker.

## Follow-up

The pause verifier and dispatcher latch a wall/monotonic skew baseline from their first sample and fail permanently after more than 1 s of drift. On long-lived objects, normal crystal drift reaches this limit after about 14 h at 20 ppm, and pause stops working. Re-anchor the baseline on each authenticated confirmation, or rebuild these objects regularly.
