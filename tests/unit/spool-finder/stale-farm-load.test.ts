import { expect, test } from 'vitest'
import {
  loadFinderSpools,
  type FinderFarmList,
} from '../../../apps/farm/app/components/spool-finder/finder-load.ts'
import { createFarmRequestGuard } from '../../../apps/farm/app/utils/farm-request-guard.ts'
import type { SpoolItem } from '../../../apps/farm/app/utils/spool-library-types.ts'

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

function spool(id: number, farmId: string): SpoolItem {
  return {
    id,
    registered: '2024-01-01T00:00:00Z',
    filament: {
      id: 1,
      registered: '2024-01-01T00:00:00Z',
      name: farmId,
      material: 'PLA',
      density: 1.24,
      diameter: 1.75,
      color_hex: '000000',
      extra: {},
    },
    remaining_weight: 100,
    used_weight: 0,
    used_length: 0,
    location: farmId,
    archived: false,
    extra: {},
  }
}

function listFor(farmId: string, canWrite: boolean): FinderFarmList {
  return {
    canWrite,
    items: [spool(farmId === 'farm-a' ? 1 : 2, farmId)],
  }
}

test('discards a slow response after the farm selection changes', async () => {
  let farm = 'farm-a'
  const guard = createFarmRequestGuard(() => farm)
  const pending = new Map<string, ReturnType<typeof deferred<FinderFarmList>>>()

  const fetch = (farmId: string) => {
    const wait = deferred<FinderFarmList>()
    pending.set(farmId, wait)
    return wait.promise
  }

  // Operator opens farm A, then switches to farm B before A answers.
  const forA = guard.start('farm-a')
  const loadA = loadFinderSpools('farm-a', forA, fetch)
  farm = 'farm-b'
  const forB = guard.start('farm-b')
  const loadB = loadFinderSpools('farm-b', forB, fetch)

  // B answers first; A answers later (out of order).
  pending.get('farm-b')!.resolve(listFor('farm-b', true))
  pending.get('farm-a')!.resolve(listFor('farm-a', false))

  const state = { items: [] as SpoolItem[], canWrite: false }
  const apply = (result: FinderFarmList | null) => {
    if (!result) return
    state.items = result.items
    state.canWrite = result.canWrite
  }
  const [fromB, fromA] = await Promise.all([loadB, loadA])
  apply(fromB)
  apply(fromA)

  expect(fromA).toBeNull()
  expect(fromB).not.toBeNull()
  expect(state.canWrite).toBe(true)
  expect(state.items.map((item) => item.id)).toEqual([2])
  expect(state.items[0]?.location).toBe('farm-b')
})
