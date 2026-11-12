/**
 * Bounded offline lifetime for authority the Connector cached from the server.
 * See docs/OFFLINE-AUTHORIZATION-LIFETIME.md. The tracker owns no clock and performs no I/O:
 * callers pass the same wall/monotonic sample they use for their own checks.
 */
export const OFFLINE_AUTHORITY_DEFAULT_MS = 30_000
export const OFFLINE_AUTHORITY_MAX_MS = 60_000
/** Same tolerance the pause verifier and dispatcher apply between wall and monotonic time. */
export const OFFLINE_AUTHORITY_MAX_SKEW_MS = 1_000

export type AuthoritySample = Readonly<{ wall: number; mono: number }>
export type PersistedOfflineAuthority = Readonly<{ confirmedWall: number }>
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
    freshAt,
    /** The server just confirmed cached authority over an authenticated channel. */
    confirm(now: AuthoritySample): boolean {
      if (!validSample(now)) return false
      anchor = Object.freeze({ wall: now.wall, mono: now.mono })
      previous = anchor
      return true
    },
    /**
     * Restart path. The monotonic clock does not survive a restart, so only the remaining
     * wall-clock window is restored, never more than one lifetime and never after a backwards jump.
     */
    restore(persisted: unknown, now: AuthoritySample): boolean {
      anchor = null
      previous = null
      if (!validSample(now) || typeof persisted !== 'object' || !persisted)
        return false
      const confirmedWall = (persisted as { confirmedWall?: unknown })
        .confirmedWall
      if (
        !Number.isSafeInteger(confirmedWall) ||
        (confirmedWall as number) > now.wall ||
        now.wall - (confirmedWall as number) >= maxAgeMs
      )
        return false
      const age = now.wall - (confirmedWall as number)
      anchor = Object.freeze({ wall: now.wall - age, mono: now.mono - age })
      previous = Object.freeze({ wall: now.wall, mono: now.mono })
      return true
    },
    /** Server reported revocation, or the caller dropped its cache: stale immediately. */
    revoke(): void {
      stale('revoked')
    },
    snapshot(): PersistedOfflineAuthority | null {
      return anchor ? Object.freeze({ confirmedWall: anchor.wall }) : null
    },
  })
}
export type OfflineAuthority = ReturnType<typeof createOfflineAuthority>
