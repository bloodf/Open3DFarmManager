// SPDX-License-Identifier: MIT
import { nextTick, ref } from 'vue'
import { beforeEach, expect, it, vi } from 'vitest'

const { ready, selectFarm, connectFiles, index } = await vi.hoisted(
  async () => ({
    ready: (await import('vue')).shallowRef<any>(null),
    selectFarm: vi.fn(),
    connectFiles: vi.fn(),
    index: vi.fn(),
  }),
)
vi.mock('../../apps/farm/app/composables/useFarmView.ts', () => ({
  useFarmView: () => ({ ready, selectFarm, now: { value: {} } }),
}))
vi.mock('../../apps/farm/app/components/farm/useFarmControls.ts', () => ({
  useFarmControls: () => ({ pauseEnabled: { value: true }, connectFiles }),
}))
vi.mock('../../apps/farm/app/utils/replay-live.ts', () => ({
  liveReplayIndex: index,
  sendLibraryReplay: vi.fn(async (connect, args) => {
    connect(vi.fn())
    return { outcome: 'applied', args }
  }),
}))
import { useReplayLive } from '../../apps/farm/app/composables/useReplayLive.ts'

beforeEach(() => {
  vi.clearAllMocks()
  ready.value = null
})

it('selects farm B and sends only to its live printer', async () => {
  const farm = ref('B')
  const live = useReplayLive(farm)
  ready.value = { scope: null, rows: [], keys: {} }
  await nextTick()
  expect(selectFarm).toHaveBeenLastCalledWith('B')
  ready.value = {
    scope: { farmId: 'B' },
    rows: [{ assignment: { printerKey: 'printer-b' } }],
    keys: {},
  }
  index.mockReturnValue(new Map([['printer-b', { live: true }]]))
  expect(live.liveFor('printer-a')).toBeUndefined()
  expect(await live.send('printer-a', { sha256: 'a'.repeat(64) })).toEqual({
    outcome: 'not-sent',
  })
  expect(
    await live.send('printer-b', { sha256: 'a'.repeat(64) }),
  ).toMatchObject({ outcome: 'applied' })
  expect(connectFiles).toHaveBeenCalledOnce()
})
