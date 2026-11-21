import type { Sql } from 'postgres'
import type { SpoolSlotAssignmentRow, SpoolSlotKind } from './spool-features-types.ts'
import { inventoryUuid } from './postgres-connector-inventory.ts'

export interface SlotQuery { farmId: string; printerId?: string; spoolId?: number }
export interface SlotAssignment extends SpoolSlotAssignmentRow {}

/** Farm-scoped assignment persistence. A transaction serializes changes for a farm. */
export class PostgresSpoolSlots {
  constructor(private readonly sql: Sql, private readonly clock: () => number = Date.now) {}

  async list(input: SlotQuery): Promise<SlotAssignment[]> {
    if (!inventoryUuid.test(input.farmId)) return []
    return this.sql<SlotAssignment[]>`SELECT farm_id AS "farmId", id::text, spool_id AS "spoolId", printer_id AS "printerId", slot_kind AS "slotKind", slot_index AS "slotIndex", assigned_at AS "assignedAt", unassigned_at AS "unassignedAt" FROM farm.spool_slot_assignments WHERE farm_id=${input.farmId}::uuid AND (${input.printerId ?? null}::uuid IS NULL OR printer_id=${input.printerId ?? null}::uuid) AND (${input.spoolId ?? null}::bigint IS NULL OR spool_id=${input.spoolId ?? null}::bigint) ORDER BY assigned_at DESC, id`
  }

  async activeAt(farmId: string, printerId: string, kind: SpoolSlotKind, index: number, at: number): Promise<SlotAssignment | null> {
    const rows = await this.sql<SlotAssignment[]>`SELECT farm_id AS "farmId", id::text, spool_id AS "spoolId", printer_id AS "printerId", slot_kind AS "slotKind", slot_index AS "slotIndex", assigned_at AS "assignedAt", unassigned_at AS "unassignedAt" FROM farm.spool_slot_assignments WHERE farm_id=${farmId}::uuid AND printer_id=${printerId}::uuid AND slot_kind=${kind} AND slot_index=${index} AND assigned_at<=${at} AND (unassigned_at IS NULL OR unassigned_at>${at}) ORDER BY assigned_at DESC LIMIT 1`
    return rows[0] ?? null
  }

  async assign(input: { farmId: string; spoolId: number; printerId: string; slotKind: SpoolSlotKind; slotIndex: number }): Promise<SlotAssignment | null> {
    if (!inventoryUuid.test(input.farmId) || !inventoryUuid.test(input.printerId) || !Number.isSafeInteger(input.spoolId) || input.spoolId < 1 || !Number.isInteger(input.slotIndex) || input.slotIndex < 0 || input.slotIndex > 1024) return null
    const now = this.clock()
    return this.sql.begin(async tx => {
      await tx`SELECT pg_advisory_xact_lock(hashtextextended(${input.farmId},0))`
      await tx`UPDATE farm.spool_slot_assignments SET unassigned_at=${now} WHERE farm_id=${input.farmId}::uuid AND spool_id=${input.spoolId} AND unassigned_at IS NULL`
      await tx`UPDATE farm.spool_slot_assignments SET unassigned_at=${now} WHERE farm_id=${input.farmId}::uuid AND printer_id=${input.printerId}::uuid AND slot_kind=${input.slotKind} AND slot_index=${input.slotIndex} AND unassigned_at IS NULL`
      const id = randomUUID()
      const rows = await tx<SlotAssignment[]>`INSERT INTO farm.spool_slot_assignments (farm_id,id,spool_id,printer_id,slot_kind,slot_index,assigned_at) VALUES (${input.farmId}::uuid,${id}::uuid,${input.spoolId},${input.printerId}::uuid,${input.slotKind},${input.slotIndex},${now}) RETURNING farm_id AS "farmId", id::text, spool_id AS "spoolId", printer_id AS "printerId", slot_kind AS "slotKind", slot_index AS "slotIndex", assigned_at AS "assignedAt", unassigned_at AS "unassignedAt"`
      return rows[0] ?? null
    })
  }

  async unassign(input: { farmId: string; printerId: string; slotKind: SpoolSlotKind; slotIndex: number }): Promise<boolean> {
    if (!inventoryUuid.test(input.farmId) || !inventoryUuid.test(input.printerId)) return false
    const rows = await this.sql<unknown[]>`UPDATE farm.spool_slot_assignments SET unassigned_at=${this.clock()} WHERE farm_id=${input.farmId}::uuid AND printer_id=${input.printerId}::uuid AND slot_kind=${input.slotKind} AND slot_index=${input.slotIndex} AND unassigned_at IS NULL RETURNING id`
    return rows.length > 0
  }
}
import { randomUUID } from 'node:crypto'
