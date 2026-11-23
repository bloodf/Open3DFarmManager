import { describe, expect, it } from 'vitest'
import {
  sameSlots,
  snapshotImportRequest,
  safeReadStored,
  safeWriteStored,
} from '../../apps/farm/app/utils/spool-form-state.ts'

describe('spool form state', () => {
  it('keeps the simulated request including its token and applies that exact request', () => {
    const simulated = snapshotImportRequest({
      format: 'spoolman-api',
      origin: 'http://spoolman.lan',
      bearerToken: 'secret',
      source: 'first',
      dryRun: true,
    })
    expect(simulated).toEqual({
      format: 'spoolman-api',
      origin: 'http://spoolman.lan',
      bearerToken: 'secret',
      source: 'first',
      dryRun: true,
    })
    expect({ ...simulated, dryRun: false }).toEqual({
      format: 'spoolman-api',
      origin: 'http://spoolman.lan',
      bearerToken: 'secret',
      source: 'first',
      dryRun: false,
    })
    expect(simulated).not.toHaveProperty('changedFormValue')
  })

  it('compares slots by value so fresh equivalent arrays do not reset a draft', () => {
    expect(sameSlots(['A', 'B'], ['A', 'B'])).toBe(true)
    expect(sameSlots(['A', 'B'], ['B', 'A'])).toBe(false)
    expect(sameSlots(['A'], ['A', 'B'])).toBe(false)
  })

  it('contains storage read and write failures', () => {
    const storage = {
      getItem: () => {
        throw new Error('blocked')
      },
      setItem: () => {
        throw new Error('blocked')
      },
    }
    expect(safeReadStored(storage, 'key')).toBeNull()
    expect(() => safeWriteStored(storage, 'key', '{}')).not.toThrow()
  })
})
