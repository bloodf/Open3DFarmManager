# Offline authorization lifetime

Phase 0 requires a defined limit on how long previously issued authorization stays usable while a Connector cannot reach the server, and proof that expiry fails closed. This document sets that limit. Enforcement is in `packages/connector/src/auth/offline-authority.ts`.

## What counts as cached authority

Some state is issued or confirmed by the server and then relied on locally without asking the server again. That includes trusted issuer and browser keys, the Connector's own credential and assignment state, and the server-signed pause capability with its control binding.

The pause capability path already has hard bounds in code. A capability lasts at most 30 s (`PAUSE_POLICY_HARD_MAXIMUMS.capabilityMs`, plus the `capability_expires_at <= consumed_at + 30000` check in migration 0018). A control binding lasts at most 30 s, an admission at most 8 s and a command at most 5 s. The v1 `authorizeCommand` lease lasts at most 60 s. Each signed capability was issued by an online server, so it is fresh evidence by itself. The new bound covers state that has no signature of its own and comes only from the last server contact, such as the planned trusted-key cache.

## Bound

| Setting                                           | Value                                                                                   |
| ------------------------------------------------- | --------------------------------------------------------------------------------------- |
| Default lifetime (`OFFLINE_AUTHORITY_DEFAULT_MS`) | 30 000 ms, the same as the capability and binding maximum                               |
| Hard maximum (`OFFLINE_AUTHORITY_MAX_MS`)         | 60 000 ms, the same as the v1 authorization lease maximum, which now uses this constant |
| Configurable range                                | an integer from 1 to 60 000 ms. Anything else is rejected at construction.              |

Cached authority is fresh only while both `mono - confirmedMono < lifetime` and `wall - confirmedWall < lifetime` hold. At exactly the bound it is stale.

## Clock assumptions

- **Monotonic time** measures elapsed time within one process. Wall-clock time is still checked so that signed `issued_at`/`expires_at` values stay comparable.
- **Skew:** if wall time and monotonic time drift apart by more than 1 000 ms after the confirmation anchor, authority goes stale. The pause verifier and dispatcher already use the same tolerance. A forward wall jump (for example an NTP step) therefore fails closed.
- **Regression:** a backwards step in wall or monotonic time, or a non-finite or negative sample, makes authority stale immediately.
- **Restart:** the monotonic clock does not survive a restart. `snapshot()` persists only `confirmedWall`. `restore()` rebuilds the remaining wall-clock window, which is never longer than one lifetime. It refuses when the wall clock now reads earlier than `confirmedWall` or when the window has already passed.
- A stale state is never restored implicitly. Only a new `confirm()` makes authority fresh again, after an authenticated server exchange.

## At expiry

- **Commands:** `createPauseCapabilityVerifier({ freshness })` checks freshness against the same clock sample during `admit()` (at every recheck between asynchronous steps) and during `inspectAt()` before each dispatch boundary. A stale result returns `expired-or-inactive`. The dispatcher then rejects with `invalid-authority`, and the handle is latched as expired, so reconfirmation cannot revive it. The browser must obtain a new capability.
- **Read-only:** status, telemetry, camera and `inspectLifecycle()` result auditing do not check freshness. Loss of connectivity alone does not stop a print, and local watchdogs keep running.
- **Audit:** `onStale(reason)` runs once per fresh-to-stale transition, with `expired`, `clock` or `revoked`, so the runtime can write a local audit entry. If the audit callback throws, authority is still not restored.
- **Revocation:** `revoke()` makes authority stale immediately, for example when the server reports a credential or key revocation.

## Revocation latency tradeoff

An offline Connector cannot learn about a remote revocation. Revoked authority can therefore stay usable for up to one lifetime after the last server confirmation: 30 s by default, 60 s at most. A longer window would allow more control during outages, but a stolen browser key or revoked membership would then keep working for longer. During a longer outage, Phase 0 chooses safety: remote commands stop and the farm stays observable. The pause capability path is not loosened: it remains bounded by its own signed expiry no matter what the tracker says.

## Interface for later work

```ts
interface CachedAuthorityFreshness {
  freshAt(now: { wall: number; mono: number }): boolean
}
```

`createOfflineAuthority({ maxAgeMs?, onStale? })` returns `freshAt`, `confirm`, `restore`, `revoke`, `snapshot` and `maxAgeMs`. The tracker has no clock of its own and does no I/O. Callers pass the sample they already took for their own checks. A trusted-key cache should keep one tracker, call `confirm()` after each authenticated refresh, and pass it as `freshness` to the verifier.

## Not yet done

- The runtime does not yet construct a tracker or call `confirm()` from the authenticated signalling channel. That wiring will follow alongside the runtime and trusted-key cache work.
- A durable audit sink for `onStale` and persistence of `snapshot()` are runtime responsibilities and are not implemented here.
