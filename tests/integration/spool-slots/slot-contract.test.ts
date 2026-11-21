import { describe, expect, it } from 'vitest'
import type { SpoolSlotAssignmentRow } from '../../../apps/farm/server/storage/spool-features-types.ts'

describe('spool slot assignment contract', () => {
  it('models printer, AMS, and toolhead slot history', () => {
    const row: SpoolSlotAssignmentRow = {
      farmId: 'farm', id: 'assignment', spoolId: 1, printerId: 'printer',
      slotKind: 'ams', slotIndex: 0, assignedAt: 1, unassignedAt: null,
    }
    expect(row.slotKind).toBe('ams')
    expect(row.unassignedAt).toBeNull()
  })
})
