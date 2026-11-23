import { effectScope, nextTick, ref } from 'vue'
import { afterEach, expect, it, vi } from 'vitest'
import { useShellRecords } from '../../apps/farm/app/composables/useShellRecords'

afterEach(() => vi.unstubAllGlobals())
it('clears old farm data and ignores late responses after a farm switch', async () => {
  const pending: Array<{
    path: string
    signal: AbortSignal
    resolve: (value: unknown) => void
  }> = []
  vi.stubGlobal(
    '$fetch',
    (path: string, options: { signal: AbortSignal }) =>
      new Promise((resolve) =>
        pending.push({ path, signal: options.signal, resolve }),
      ),
  )
  const farm = ref<string | undefined>('a')
  const open = ref(true)
  const scope = effectScope()
  const records = scope.run(() =>
    useShellRecords(
      () => farm.value,
      () => open.value,
    ),
  )!
  expect(pending).toHaveLength(2)
  farm.value = 'b'
  await nextTick()
  expect(pending[0]!.signal.aborted).toBe(true)
  expect(pending[1]!.signal.aborted).toBe(true)
  pending[0]!.resolve({ items: [{ id: 1, archived: false }] })
  pending[1]!.resolve({ jobs: [{ id: 'old' }] })
  pending[2]!.resolve({
    items: [
      { id: 2, archived: false },
      { id: 3, archived: true },
    ],
  })
  pending[3]!.resolve({ jobs: [{ id: 'new' }] })
  await Promise.resolve()
  expect(records.spools.value.map((item) => item.id)).toEqual([2])
  expect(records.latestJob.value?.id).toBe('new')
  open.value = false
  await nextTick()
  expect(records.spools.value).toEqual([])
  scope.stop()
})
