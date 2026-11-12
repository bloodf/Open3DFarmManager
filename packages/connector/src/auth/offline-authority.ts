/**
 * Bounded offline lifetime for authority the Connector cached from the server.
 * See docs/OFFLINE-AUTHORIZATION-LIFETIME.md. The tracker owns no clock and performs no I/O.
 * Callers pass one `{ wall: Date.now(), mono: performance.now() }` pair taken immediately
 * before the call, the same pair they use for their own checks.
 * Nothing is persisted: after a restart authority stays stale until the first authenticated confirm().
 */
export const OFFLINE_AUTHORITY_DEFAULT_MS = 30_000
export const OFFLINE_AUTHORITY_MAX_MS = 60_000
/** Same tolerance the pause verifier and dispatcher apply between wall and monotonic time. */
export const OFFLINE_AUTHORITY_MAX_SKEW_MS = 1_000

export type AuthoritySample = Readonly<{ wall: number; mono: number }>
export type OfflineAuthorityStaleReason = 'expired' | 'clock' | 'revoked'

/** The only question command paths ask: is cached authority still fresh at this sample? */
export interface CachedAuthorityFreshness {
  freshAt(now: AuthoritySample): boolean
}

function validSample(now: AuthoritySample): boolean {
  return (
    Number.isSafeInteger(now.wall) &&
    now.wall >= 0 &&
    Number.isFinite(now.mono) &&
    now.mono >= 0
  )
}

export function createOfflineAuthority(
  config: {
    maxAgeMs?: number
    /** Called once per fresh-to-stale transition so the caller can write an audit entry. */
    onStale?: (reason: OfflineAuthorityStaleReason) => void
  } = {},
) {
  const maxAgeMs = config.maxAgeMs ?? OFFLINE_AUTHORITY_DEFAULT_MS
  if (
    !Number.isSafeInteger(maxAgeMs) ||
    maxAgeMs <= 0 ||
    maxAgeMs > OFFLINE_AUTHORITY_MAX_MS
  )
    throw new Error('Invalid offline authority lifetime')
  const onStale = config.onStale
  let anchor: AuthoritySample | null = null
  let previous: AuthoritySample | null = null
  // Server sequence floor: a confirm at or below it (stale or pre-revocation) never restores authority.
  let floor = -1

  function stale(reason: OfflineAuthorityStaleReason): false {
    const wasFresh = anchor !== null
    anchor = null
    if (wasFresh && onStale)
      try {
        onStale(reason)
      } catch {
        /* Auditing must never restore authority. */
      }
    return false
  }

  function freshAt(now: AuthoritySample): boolean {
    try {
      if (!anchor) return false
      if (
        !validSample(now) ||
        (previous && (now.wall < previous.wall || now.mono < previous.mono)) ||
        Math.abs(now.wall - anchor.wall - (now.mono - anchor.mono)) >
          OFFLINE_AUTHORITY_MAX_SKEW_MS
      )
        return stale('clock')
      previous = { wall: now.wall, mono: now.mono }
      if (
        now.mono - anchor.mono >= maxAgeMs ||
        now.wall - anchor.wall >= maxAgeMs
      )
        return stale('expired')
      return true
    } catch {
      return stale('clock')
    }
  }

  return Object.freeze({
    maxAgeMs,
    /** Read-only view to hand to verifiers; it cannot confirm or revoke. */
    freshness: Object.freeze({ freshAt }) as CachedAuthorityFreshness,
    /**
     * The server just confirmed cached authority. `serverSeq` must strictly increase
     * past every earlier confirm and revocation; anything else is refused.
     */
    confirm(now: AuthoritySample, serverSeq: number): boolean {
      if (
        !validSample(now) ||
        !Number.isSafeInteger(serverSeq) ||
        serverSeq <= floor
      )
        return false
      floor = serverSeq
      anchor = Object.freeze({ wall: now.wall, mono: now.mono })
      previous = anchor
      return true
    },
    /** Stale immediately. A server sequence raises the floor so older confirms cannot revive authority. */
    revoke(serverSeq?: number): void {
      if (
        serverSeq !== undefined &&
        Number.isSafeInteger(serverSeq) &&
        serverSeq > floor
      )
        floor = serverSeq
      stale('revoked')
    },
  })
}
export type OfflineAuthority = ReturnType<typeof createOfflineAuthority>
