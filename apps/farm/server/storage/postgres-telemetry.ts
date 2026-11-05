import type { Sql } from 'postgres'
import {
  TelemetryBatch,
  type TelemetryEvent,
} from '@open3dfarmmanager/farm-protocol'
import type { TelemetryEventStore } from '../services/telemetry.ts'
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
      snapshot.sort((a, b) => a.eventId.localeCompare(b.eventId))
      await this.#sql.begin(async (tx) => {
        await tx`SET LOCAL statement_timeout = '2000ms'`
        await tx`SET LOCAL lock_timeout = '1000ms'`
        for (const event of snapshot) {
          const payload = event
          await tx`INSERT INTO farm.telemetry_events (farm_id, agent_id, event_id, payload)
            VALUES (${farmId}::uuid, ${agentId}::uuid, ${event.eventId}::uuid, ${tx.json(payload)}::jsonb)
            ON CONFLICT (farm_id, agent_id, event_id) DO NOTHING`
          const rows =
            await tx`SELECT payload = ${tx.json(payload)}::jsonb AS matches
            FROM farm.telemetry_events
            WHERE farm_id = ${farmId}::uuid AND agent_id = ${agentId}::uuid AND event_id = ${event.eventId}::uuid
            FOR SHARE`
          if (rows.length !== 1 || rows[0]?.matches !== true)
            throw new EventConflict()
        }
      })
      return 'committed'
    } catch (error) {
      if (error instanceof EventConflict) return 'conflict'
      throw new Error('Telemetry storage unavailable')
    }
  }
}
