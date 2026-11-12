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

## Wiring prerequisites (later runtime PR)

- `confirm()` may be called only from the cloud signalling channel authenticated with the Connector credential. It must run after that message's keyring and cache state have been applied. It must never be driven by WebRTC or browser frames.
- The server must send an authenticated keepalive or confirmation at least every `maxAgeMs / 3` (10 s by default), so normal jitter does not make authority stale.
- Signalling backoff must reset after an admitted session. `runtime/signalling.ts` currently never resets backoff, so after a few reconnects the retry interval could exceed the lifetime.
- `onStale` needs a durable audit sink.

## Follow-up

The pause verifier and dispatcher latch a wall/monotonic skew baseline from their first sample and fail permanently after more than 1 s of drift. On long-lived objects, normal crystal drift reaches this limit after about 14 h at 20 ppm, and pause stops working. Re-anchor the baseline on each authenticated confirmation, or rebuild these objects regularly.
