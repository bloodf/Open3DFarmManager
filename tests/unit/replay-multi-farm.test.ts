// SPDX-License-Identifier: MIT
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  createFarmView,
  type FarmViewState,
} from '../../apps/farm/app/utils/farm-view.ts'

/**
 * `useReplayLive` for an account with two farms. The real farm view runs
 * against an in-process API; only Vue's reactivity, the WebRTC control
 * session and the live-availability rule are stand-ins.
 */
const ACCOUNT = 'account-one'
const FARM_A = '00000000-0000-4000-8000-00000000000a'
const FARM_B = '00000000-0000-4000-8000-00000000000b'
const AGENT = '00000000-0000-4000-8000-000000000002'

const assignment = (id: string, key: string) => ({
  assignmentId: `00000000-0000-4000-8000-0000000000${id}`,
  agentId: AGENT,
  printerKey: key,
  status: 'active',
  connectorStatus: 'approved',
})
const PRINTERS: Record<string, ReturnType<typeof assignment>[]> = {
  [FARM_A]: [assignment('a1', 'a-printer'), assignment('a2', 'shared')],
  [FARM_B]: [assignment('b1', 'b-printer'), assignment('b2', 'shared')],
}
let farms: { farmId: string }[] = []
const reads: string[] = []
async function read(path: string) {
  reads.push(path)
  if (path === '/api/auth/me') return { accountId: ACCOUNT }
  if (path === '/api/farms') return { farms, nextAfter: null }
  const match = /^\/api\/farms\/([^/]+)\/printers$/.exec(path)
  const printers = match?.[1] ? PRINTERS[match[1]] : undefined
  if (printers) return { printers, nextAfter: null, canManage: true }
  throw new Error(`Unexpected request: ${path}`)
}

const state = { current: { kind: 'loading' } as FarmViewState }
const effects: (() => void)[] = []
const connected: string[] = []
const sentArgs: unknown[] = []
const view = createFarmView({
  read,
  listKeys: async () => [],
  clock: () => ({ wall: 1, mono: 1 }),
  changed: (next) => {
    state.current = next
  },
})

vi.mock('vue', () => ({
  computed: <T>(get: () => T) => ({
    get value() {
      return get()
    },
  }),
  toValue: <T>(source: T | (() => T) | { value: T }) =>
    typeof source === 'function'
      ? (source as () => T)()
      : source && typeof source === 'object' && 'value' in source
        ? source.value
        : source,
  watchEffect: (effect: () => void) => {
    effects.push(effect)
    effect()
  },
}))
vi.mock('../../apps/farm/app/composables/useFarmView.ts', () => ({
  useFarmView: () => ({
    ...view,
    now: { value: { wall: 1, mono: 1 } },
    ready: {
      get value() {
        return state.current.kind === 'ready' ? state.current : null
      },
    },
  }),
}))
vi.mock('../../apps/farm/app/components/farm/useFarmControls.ts', () => ({
  useFarmControls: () => ({
    pauseEnabled: { value: true },
    connectFiles: async (row: { assignment: { assignmentId: string } }) => {
      connected.push(row.assignment.assignmentId)
      return {
        issueControlCommand: async (_: string, args: unknown) => {
          sentArgs.push(args)
          return 'applied'
        },
        close() {},
        async dispose() {},
      }
    },
  }),
}))
// Every row of the scoped view counts as live: what matters is which rows.
vi.mock('../../apps/farm/app/utils/replay-live.ts', async (original) => ({
  ...(await original<object>()),
  liveReplayIndex: (rows: { assignment: { printerKey: string } }[]) =>
    new Map(
      rows.map((row) => [
        row.assignment.printerKey,
        { connectorOnline: true, live: true, materials: [] },
      ]),
    ),
}))
const { useReplayLive } =
  await import('../../apps/farm/app/composables/useReplayLive.ts')

const settle = async () => {
  for (let step = 0; step < 20; step++) {
    await Promise.resolve()
    for (const effect of effects) effect()
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
}
const scopedFarm = () => {
  const current = state.current
  return current.kind === 'ready' ? (current.scope?.farmId ?? null) : null
}

beforeEach(() => {
  effects.length = 0
  connected.length = 0
  sentArgs.length = 0
  reads.length = 0
})

describe('useReplayLive with two farms', () => {
  it('selects the farm of the replayed version and offers only its printers', async () => {
    farms = [{ farmId: FARM_A }, { farmId: FARM_B }]
    const farmId = { value: FARM_B }
    const live = useReplayLive(farmId)
    await view.discover()
    // Two farms: the view never selects one on its own.
    expect(scopedFarm()).toBeNull()
    await settle()
    expect(scopedFarm()).toBe(FARM_B)
    expect(reads).toContain(`/api/farms/${FARM_B}/printers`)
    expect(reads).not.toContain(`/api/farms/${FARM_A}/printers`)
    expect(live.liveFor('b-printer')?.live).toBe(true)
    expect(live.liveFor('a-printer')).toBeUndefined()
  })

  it('sends to the printer of farm B, even when farm A has a printer with the same key', async () => {
    farms = [{ farmId: FARM_A }, { farmId: FARM_B }]
    const live = useReplayLive({ value: FARM_B })
    await view.discover()
    await settle()
    const args = { sha256: 'a'.repeat(64) }
    expect(await live.send('b-printer', args)).toEqual({ outcome: 'applied' })
    expect(await live.send('shared', args)).toEqual({ outcome: 'applied' })
    expect(connected).toEqual([
      '00000000-0000-4000-8000-0000000000b1',
      '00000000-0000-4000-8000-0000000000b2',
    ])
    expect(sentArgs).toEqual([args, args])
  })

  it('never sends to a printer of farm A while farm B is replayed', async () => {
    farms = [{ farmId: FARM_A }, { farmId: FARM_B }]
    const live = useReplayLive({ value: FARM_B })
    await view.discover()
    await settle()
    expect(await live.send('a-printer', { sha256: 'a'.repeat(64) })).toEqual({
      outcome: 'not-sent',
    })
    expect(connected).toEqual([])
  })

  it('sends nothing before a farm is chosen', async () => {
    farms = [{ farmId: FARM_A }, { farmId: FARM_B }]
    const farmId = { value: '' }
    const live = useReplayLive(farmId)
    await view.discover()
    await settle()
    expect(scopedFarm()).toBeNull()
    expect(live.liveFor('b-printer')).toBeUndefined()
    expect(await live.send('b-printer', { sha256: 'a'.repeat(64) })).toEqual({
      outcome: 'not-sent',
    })
    // Choosing farm B later selects it.
    farmId.value = FARM_B
    await settle()
    expect(scopedFarm()).toBe(FARM_B)
  })

  it('follows the page to another farm and drops the previous farm printers', async () => {
    farms = [{ farmId: FARM_A }, { farmId: FARM_B }]
    const farmId = { value: FARM_A }
    const live = useReplayLive(farmId)
    await view.discover()
    await settle()
    expect(live.liveFor('a-printer')?.live).toBe(true)
    farmId.value = FARM_B
    await settle()
    expect(scopedFarm()).toBe(FARM_B)
    expect(live.liveFor('a-printer')).toBeUndefined()
    expect(live.liveFor('b-printer')?.live).toBe(true)
  })

  it('ignores a farm the account does not have', async () => {
    farms = [{ farmId: FARM_A }, { farmId: FARM_B }]
    const live = useReplayLive({
      value: '00000000-0000-4000-8000-0000000000ff',
    })
    await view.discover()
    await settle()
    expect(scopedFarm()).toBeNull()
    expect(live.liveFor('a-printer')).toBeUndefined()
  })

  it('keeps the single-farm behaviour: the view selects it and the page farm matches', async () => {
    farms = [{ farmId: FARM_A }]
    const live = useReplayLive({ value: FARM_A })
    await view.discover()
    await settle()
    expect(scopedFarm()).toBe(FARM_A)
    // Selected once by the view, not again by the composable.
    expect(
      reads.filter((path) => path === `/api/farms/${FARM_A}/printers`),
    ).toHaveLength(1)
    expect(live.liveFor('a-printer')?.live).toBe(true)
  })
})
