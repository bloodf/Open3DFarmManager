/**
 * Farm-scoped change feed behind the Spoolman v0.27.1 websocket paths.
 *
 * Upstream (`spoolman/ws.py`) keeps a subscription tree keyed by tuples:
 * `()` is the root feed, `("vendor",)` every vendor change and
 * `("vendor", "3")` one vendor. An event is sent to its own pool and to every
 * prefix of it. This bus is the same tree with one extra level in front: the
 * farm. A subscriber is bound to one farm when it connects and an event is
 * published for exactly one farm, so no event can cross farms.
 */
import { spoolmanDateTime } from './legacy-api/compat.ts'

export type SpoolEventType = 'added' | 'updated' | 'deleted'
export type SpoolEventResource = 'vendor' | 'filament' | 'spool' | 'setting'

/** One event as upstream sends it: `type`, `resource`, `date`, `payload`. */
export interface SpoolFeedEvent {
  /** Pool path below the farm, e.g. `["spool", "7"]`. */
  pool: readonly string[]
  /** Serialised JSON text, built once at the time of the change. */
  text: string
}

export interface FeedSubscriber {
  send(text: string): void
  close(code: number, reason: string): void
}

/** Most feeds one farm may hold open at the same time. */
export const MAX_FEEDS_PER_FARM = 256

export function buildFeedEvent(
  type: SpoolEventType,
  resource: SpoolEventResource,
  poolId: string,
  payload: unknown,
  now: number = Date.now(),
): SpoolFeedEvent {
  return {
    pool: [resource, poolId],
    text: JSON.stringify({
      type,
      resource,
      date: spoolmanDateTime(now),
      payload,
    }),
  }
}

const key = (farmId: string, pool: readonly string[]) =>
  [farmId, ...pool].join('\u0000')

export class SpoolFeedBus {
  private readonly pools = new Map<string, Set<FeedSubscriber>>()
  private readonly perFarm = new Map<string, number>()

  /** True when at least one client of this farm is listening. */
  hasSubscribers(farmId: string): boolean {
    return (this.perFarm.get(farmId) ?? 0) > 0
  }

  /**
   * Listen to one pool of one farm. Returns the unsubscribe function, or
   * `undefined` when the farm already holds the maximum number of feeds.
   */
  subscribe(
    farmId: string,
    pool: readonly string[],
    subscriber: FeedSubscriber,
  ): (() => void) | undefined {
    const count = this.perFarm.get(farmId) ?? 0
    if (count >= MAX_FEEDS_PER_FARM) return undefined
    const id = key(farmId, pool)
    let set = this.pools.get(id)
    if (!set) this.pools.set(id, (set = new Set()))
    set.add(subscriber)
    this.perFarm.set(farmId, count + 1)
    let active = true
    return () => {
      if (!active) return
      active = false
      const current = this.pools.get(id)
      current?.delete(subscriber)
      if (current?.size === 0) this.pools.delete(id)
      const left = (this.perFarm.get(farmId) ?? 1) - 1
      if (left <= 0) this.perFarm.delete(farmId)
      else this.perFarm.set(farmId, left)
    }
  }

  /** Deliver committed events of one farm, in order, to their pool and prefixes. */
  publish(farmId: string, events: readonly SpoolFeedEvent[]): void {
    for (const event of events)
      for (let depth = 0; depth <= event.pool.length; depth++) {
        const set = this.pools.get(key(farmId, event.pool.slice(0, depth)))
        if (!set) continue
        for (const subscriber of [...set])
          try {
            subscriber.send(event.text)
          } catch {
            // A dead socket must not stop delivery to the others.
          }
      }
  }

  /** Close every feed (server shutdown). */
  closeAll(code = 1001, reason = 'Server shutting down'): void {
    const all = new Set<FeedSubscriber>()
    for (const set of this.pools.values()) for (const s of set) all.add(s)
    for (const subscriber of all)
      try {
        subscriber.close(code, reason)
      } catch {
        // Already closed.
      }
  }
}

/** Process-wide bus shared by the HTTP bridge and the websocket route. */
export const spoolFeedBus = new SpoolFeedBus()
