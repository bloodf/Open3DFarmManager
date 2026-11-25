import type { Sql } from 'postgres'
import {
  TelemetryBatch,
  type TelemetryEvent,
} from '@open3dfarmmanager/farm-protocol'
import type { TelemetryEventStore } from '../services/telemetry.ts'
import { jobsFromEvents } from '../services/job-history-core.ts'
import { recordJobs } from './job-history-store.ts'
import { recordLatestStates } from './postgres-printer-latest-state.ts'
import { recordNetworkTelemetry } from './postgres-farm-network.ts'
// Send age is per delivery attempt and does not participate in replay matching.
export function durableTelemetryEvent(event: TelemetryEvent) {
  if (event.kind !== 'printer-state' && event.kind !== 'inventory-snapshot')
    return event
  const { ageAtSendMs: _age, ...payload } = event
  return payload
}

class EventConflict extends Error {}
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

/** Internal persistence only. This store does not authenticate or authorize its caller. */
export class PostgresTelemetryStore implements TelemetryEventStore {
  #sql: Sql
  constructor(sql: Sql) {
    this.#sql = sql
  }
  async commitBatch(
    scope: { farmId: string; agentId: string },
    records: readonly TelemetryEvent[],
  ): Promise<'committed' | 'conflict'> {
    try {
      const farmId = scope.farmId
      const agentId = scope.agentId
      if (
        ![farmId, agentId].every(
          (id) => typeof id === 'string' && uuid.test(id),
        )
      )
        throw new Error()
      const snapshot = TelemetryBatch.parse(records)
      if (Buffer.byteLength(JSON.stringify(snapshot)) > 64 * 1024)
        throw new Error()
      // Stable lock acquisition order for overlapping concurrent batches.
      const sorted = [...snapshot].sort((a, b) =>
        a.eventId.localeCompare(b.eventId),
      )
      await this.#sql.begin(async (tx) => {
        await tx`SET LOCAL statement_timeout = '2000ms'`
        await tx`SET LOCAL lock_timeout = '1000ms'`
        const inserted = new Set<string>()
        for (const event of sorted) {
          const payload = durableTelemetryEvent(event)
          const result =
            await tx`INSERT INTO farm.telemetry_events (farm_id, agent_id, event_id, payload)
            VALUES (${farmId}::uuid, ${agentId}::uuid, ${event.eventId}::uuid, ${tx.json(payload)}::jsonb)
            ON CONFLICT (farm_id, agent_id, event_id) DO NOTHING RETURNING event_id`
          if (result.length) inserted.add(event.eventId)
          const rows =
            await tx`SELECT payload = ${tx.json(payload)}::jsonb AS matches
            FROM farm.telemetry_events
            WHERE farm_id = ${farmId}::uuid AND agent_id = ${agentId}::uuid AND event_id = ${event.eventId}::uuid
            FOR SHARE`
          if (rows.length !== 1 || rows[0]?.matches !== true)
            throw new EventConflict()
        }
        await recordLatestStates(
          tx,
          { farmId, agentId },
          snapshot.filter((event) => inserted.has(event.eventId)),
        )
        await recordNetworkTelemetry(tx, { farmId, agentId }, snapshot)
        // Finished jobs ride along in the same transaction; repeats are a no-op.
        await recordJobs(tx, { farmId, agentId }, jobsFromEvents(snapshot))
      })
      return 'committed'
    } catch (error) {
      if (error instanceof EventConflict) return 'conflict'
      throw new Error('Telemetry storage unavailable')
    }
  }
}
