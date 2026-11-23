import {
  MAX_TRUSTED_BROWSER_KEYS,
  TRUSTED_KEY_CONFIRMATION_INTERVAL_MS,
  TrustedBrowserKey,
  TrustedIssuerKey,
  encodeTrustedKeySetFrame,
  signTrustedKeySet,
} from '../../../../../packages/farm-protocol/src/trusted-keys.ts'
import { canonicalize } from '../../../../../packages/farm-protocol/src/canonical.ts'

/** A browser key row as the store knows it; `farmId` lets the publisher refuse foreign rows. */
export type TrustedKeyRow = TrustedBrowserKey & Readonly<{ farmId: string }>
export interface TrustedKeySource {
  /** Current issuer keys and approved, non-revoked browser keys of exactly this farm. */
  read(farmId: string): Promise<{
    issuerKeys: readonly TrustedIssuerKey[]
    browserKeys: readonly TrustedKeyRow[]
  }>
}
export interface TrustedKeyInboxes {
  sendToFarmInboxes(farmId: string, wire: string): number
  onInboxProved(listener: (farmId: string) => void): () => void
}
export interface TrustedKeyTimers {
  every(ms: number, callback: () => void): () => void
}
export type TrustedKeyPublisherOptions = Readonly<{
  source: TrustedKeySource
  inboxes: TrustedKeyInboxes
  signer: Readonly<{ issuer: string; kid: string; signingKey: CryptoKey }>
  clock: Readonly<{ wall(): number }>
  timers: TrustedKeyTimers
  /** Failures never carry key material. Defaults to silent. */
  onError?: (farmId: string, reason: 'source' | 'invalid' | 'send') => void
}>
type FarmState = {
  digest: string | null
  version: number
  wire: string | null
  chain: Promise<void>
  lastUsed: number
}
const MAX_FARMS = 256

/**
 * Re-publishes a farm's trusted-key set over its authenticated credential
 * inboxes. A change (approval, revocation, rotation) is announced through
 * `notifyChange` and, as a backstop for missed notifications, re-read every
 * confirmation interval. An inbox that has just proved its credential gets
 * the current set immediately. Never sends before inbox proof; never mixes farms.
 */
export function createTrustedKeyPublisher(options: TrustedKeyPublisherOptions) {
  const { source, inboxes, signer, clock, timers } = options
  const farms = new Map<string, FarmState>()
  let closed = false
  const touch = (farm: FarmState) => {
    farm.lastUsed = clock.wall()
  }
  const evictIdle = () => {
    let oldestId: string | null = null
    let oldest = Number.POSITIVE_INFINITY
    for (const [id, farm] of farms) {
      if (farm.lastUsed < oldest) {
        oldest = farm.lastUsed
        oldestId = id
      }
    }
    if (oldestId) farms.delete(oldestId)
  }
  function state(farmId: string): FarmState | null {
    const known = farms.get(farmId)
    if (known) {
      touch(known)
      return known
    }
    if (farms.size >= MAX_FARMS) evictIdle()
    const created: FarmState = {
      digest: null,
      version: 0,
      wire: null,
      chain: Promise.resolve(),
      lastUsed: clock.wall(),
    }
    farms.set(farmId, created)
    return created
  }
  const fail = (farmId: string, reason: 'source' | 'invalid' | 'send') => {
    try {
      options.onError?.(farmId, reason)
    } catch {}
  }
  async function build(farmId: string, farm: FarmState): Promise<void> {
    let read: Awaited<ReturnType<TrustedKeySource['read']>>
    try {
      read = await source.read(farmId)
    } catch {
      return fail(farmId, 'source')
    }
    if (closed) return
    try {
      // Defence in depth: a source bug must not leak another farm's key.
      const browser = read.browserKeys.filter((row) => row.farmId === farmId)
      if (
        browser.length !== read.browserKeys.length ||
        browser.length > MAX_TRUSTED_BROWSER_KEYS
      )
        return fail(farmId, 'invalid')
      const browserKeys = browser
        .map(({ farmId: _farm, ...key }) => TrustedBrowserKey.parse(key))
        .sort((a, b) => (a.key_id < b.key_id ? -1 : 1))
      const issuerKeys = read.issuerKeys
        .map((key) => TrustedIssuerKey.parse(key))
        .sort((a, b) => (a.kid < b.kid ? -1 : 1))
      const content = canonicalize({ issuerKeys, browserKeys })
      if (content === farm.digest && farm.wire) return
      const issuedAt = clock.wall()
      const version = Math.max(farm.version + 1, issuedAt)
      const signed = await signTrustedKeySet(
        {
          v: 1,
          purpose: 'trusted-key-set',
          farm_id: farmId,
          version,
          issued_at: issuedAt,
          issuer: signer.issuer,
          kid: signer.kid,
          issuer_keys: issuerKeys,
          browser_keys: browserKeys,
        },
        signer.signingKey,
      )
      farm.wire = encodeTrustedKeySetFrame({
        v: 1,
        t: 'trusted-keys.set',
        key_set: signed,
      })
      farm.digest = content
      farm.version = version
    } catch {
      return fail(farmId, 'invalid')
    }
  }
  function deliver(farmId: string, farm: FarmState): void {
    if (closed || !farm.wire) return
    try {
      inboxes.sendToFarmInboxes(farmId, farm.wire)
    } catch {
      fail(farmId, 'send')
    }
  }
  /** Serialised per farm so versions are strictly increasing and sends ordered. */
  function refresh(farmId: string, force: boolean): Promise<void> {
    const farm = state(farmId)
    if (!farm || closed) return Promise.resolve()
    const run = farm.chain.then(async () => {
      if (closed) return
      const before = farm.version
      await build(farmId, farm)
      if (force || farm.version !== before) deliver(farmId, farm)
    })
    farm.chain = run.catch(() => {})
    return run
  }
  const stopInbox = inboxes.onInboxProved((farmId) => {
    void refresh(farmId, true)
  })
  const stopTimer = timers.every(TRUSTED_KEY_CONFIRMATION_INTERVAL_MS, () => {
    for (const farmId of [...farms.keys()]) void refresh(farmId, false)
  })
  return Object.freeze({
    /** Call after approve/revoke/rotate. Resolves once the new set was sent. */
    notifyChange(farmId: string): Promise<void> {
      return refresh(farmId, false)
    },
    /** Resolves when every queued refresh has finished (shutdown and tests). */
    async idle(): Promise<void> {
      await Promise.all([...farms.values()].map((farm) => farm.chain))
    },
    close(): void {
      if (closed) return
      closed = true
      stopInbox()
      stopTimer()
      farms.clear()
    },
  })
}
