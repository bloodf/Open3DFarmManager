import { describe, expect, it } from 'vitest'
import {
  createFarmRequestGuard,
  selectedFarm,
} from '../../apps/farm/app/utils/farm-request-guard.ts'
import { collectPrinterPages } from '../../apps/farm/app/utils/printer-pages.ts'

describe('farm-scoped requests', () => {
  it('rejects old generations and responses from another farm', () => {
    let farm = 'a'
    const guard = createFarmRequestGuard(() => farm)
    const first = guard.start('a')
    const second = guard.start('a')
    expect(first()).toBe(false)
    expect(second()).toBe(true)
    farm = 'b'
    expect(second()).toBe(false)
    const third = guard.start('b')
    farm = 'a'
    expect(third()).toBe(false)
    guard.invalidate()
    expect(first()).toBe(false)
  })
  it('selects the requested accessible farm and its role', () => {
    const farms = [
      { farmId: 'a', role: 'viewer' },
      { farmId: 'b', role: 'owner' },
    ]
    expect(selectedFarm(farms, 'b')?.role).toBe('owner')
    expect(selectedFarm(farms, 'missing')?.farmId).toBe('a')
  })
  it('collects every printer page', async () => {
    const cursors: (string | undefined)[] = []
    const items = await collectPrinterPages(async (after) => {
      cursors.push(after)
      return after
        ? { printers: [2], nextAfter: null }
        : { printers: [1], nextAfter: 'next' }
    })
    expect(items).toEqual([1, 2])
    expect(cursors).toEqual([undefined, 'next'])
  })
})
