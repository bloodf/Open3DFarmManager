import { SpoolmanConfig } from '../spoolman/config.ts'
import type { SpoolmanSnapshot } from '../runtime/spoolman-provider.ts'
import type { KobraXJobUsage } from './usage.ts'

export type KobraXBookingSkip =
  | 'no-spool'
  | 'spool-not-found'
  | 'inventory-unavailable'
  | 'exceeds-remaining'
  | 'already-booked'

export type KobraXBookingResult =
  | { slot: number; spoolId: number; grams: number; kind: 'booked' }
  | { slot: number; kind: 'skipped'; reason: KobraXBookingSkip }
  | { slot: number; spoolId: number; kind: 'failed' }

/** Records bookings per job and slot so a job is booked once. */
export function createKobraXBookingLedger() {
  const booked = new Set<string>()
  return {
    has: (jobKey: string, slot: number) => booked.has(`${jobKey}#${slot}`),
    add: (jobKey: string, slot: number) => {
      booked.add(`${jobKey}#${slot}`)
    },
  }
}
export type KobraXBookingLedger = ReturnType<typeof createKobraXBookingLedger>

/**
 * Spoolman `PUT /api/v1/spool/{id}/use`. The origin follows the same local
 * policy as the read provider and no redirect is followed.
 */
export function createSpoolmanUseClient(options: {
  origin: string
  timeoutMs?: number
  fetch?: typeof fetch
}) {
  const origin = SpoolmanConfig.shape.origin.parse(options.origin)
  const timeoutMs = options.timeoutMs ?? 5000
  const request = options.fetch ?? fetch
  return async function use(spoolId: number, grams: number): Promise<boolean> {
    if (!Number.isSafeInteger(spoolId) || spoolId <= 0 || !(grams > 0))
      return false
    try {
      const response = await request(
        new URL(`/api/v1/spool/${spoolId}/use`, origin),
        {
          method: 'PUT',
          redirect: 'error',
          credentials: 'omit',
          signal: AbortSignal.timeout(timeoutMs),
          headers: {
            accept: 'application/json',
            'content-type': 'application/json',
          },
          body: JSON.stringify({ use_weight: grams }),
        },
      )
      await response.body?.cancel().catch(() => {})
      return response.status === 200
    } catch {
      return false
    }
  }
}

/**
 * Books a job's per-slot usage on the operator-mapped spools. The inventory
 * comes from the existing Spoolman provider snapshot; a spool that the
 * snapshot does not show, or that holds less than the usage, is never booked.
 */
export async function bookKobraXUsage(input: {
  usage: KobraXJobUsage
  /** ACE slot to Spoolman spool id, from the operator's local configuration. */
  slotSpools: Readonly<Record<number, number>>
  snapshot: SpoolmanSnapshot
  use(spoolId: number, grams: number): Promise<boolean>
  ledger: KobraXBookingLedger
}): Promise<KobraXBookingResult[]> {
  const results: KobraXBookingResult[] = []
  const items =
    input.snapshot.kind === 'observed' ? input.snapshot.inventory?.items : null
  for (const { slot, grams } of input.usage.slots) {
    const spoolId = input.slotSpools[slot]
    if (spoolId === undefined) {
      results.push({ slot, kind: 'skipped', reason: 'no-spool' })
    } else if (!items) {
      results.push({ slot, kind: 'skipped', reason: 'inventory-unavailable' })
    } else if (input.ledger.has(input.usage.jobKey, slot)) {
      results.push({ slot, kind: 'skipped', reason: 'already-booked' })
    } else {
      const spool = items.find((item) => item.id === spoolId)
      if (!spool) {
        results.push({ slot, kind: 'skipped', reason: 'spool-not-found' })
      } else if (
        spool.remaining_weight !== null &&
        grams > spool.remaining_weight
      ) {
        results.push({ slot, kind: 'skipped', reason: 'exceeds-remaining' })
      } else if (await input.use(spoolId, grams)) {
        input.ledger.add(input.usage.jobKey, slot)
        results.push({ slot, spoolId, grams, kind: 'booked' })
      } else {
        results.push({ slot, spoolId, kind: 'failed' })
      }
    }
  }
  return results
}
