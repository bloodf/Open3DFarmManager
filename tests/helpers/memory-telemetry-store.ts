import {
  canonicalize,
  type TelemetryEvent,
} from '@open3dfarmmanager/farm-protocol'
import type { TelemetryEventStore } from '../../apps/farm/server/services/telemetry.ts'

/** TEST ONLY: transactional ordering model, no database or restart durability. */
export class MemoryTelemetryStore implements TelemetryEventStore {
  #events = new Map<string, string>()
  failBeforeCommit = false
  get size(): number {
    return this.#events.size
  }
  async commitBatch(
    scope: { farmId: string; agentId: string },
    records: readonly TelemetryEvent[],
  ): Promise<'committed' | 'conflict'> {
    const staged = new Map(this.#events)
    for (const record of records) {
      const key = JSON.stringify([scope.farmId, scope.agentId, record.eventId])
      const value = canonicalize(record)
      const previous = staged.get(key)
      if (previous !== undefined && previous !== value) return 'conflict'
      staged.set(key, value)
    }
    if (this.failBeforeCommit) throw new Error('Synthetic transaction failure')
    this.#events = staged
    return 'committed'
  }
}
