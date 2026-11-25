// SPDX-License-Identifier: MIT
/**
 * Creality speed modes and CFS feed against creality-simulator.ts, which is
 * reference-derived (nothing was captured from a printer). Sources are cited
 * by creality/commands.ts and creality/filament.ts.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { createCrealitySimulator } from '../../packages/sim-tools/src/creality-simulator.ts'
import { provisionCrealityPrinter } from '../../packages/connector/src/control/printer-binding.ts'
import { controlEffectMatches } from '../../packages/connector/src/control/pause-dispatcher.ts'
import { createPauseDriverRouter } from '../../packages/connector/src/runtime/pause-driver-router.ts'
import { readCrealityCfsSlots } from '../../packages/connector/src/creality/filament.ts'
import type { ExtendedControlAction } from '../../packages/farm-protocol/src/control-actions.ts'

const idle = { state: 0, model: 'F008', speedMode: 0, curFeedratePct: 80 }
const slot = (id: number, type: string, selected = 0) => ({
  id,
  type,
  selected,
})
const boxsInfo = {
  materialBoxs: [
    { id: 0, type: 1, materials: [slot(0, 'PLA')] },
    { id: 2, type: 0, materials: [slot(0, 'PETG'), slot(1, 'PLA')] },
    {
      id: 1,
      type: 0,
      materials: [slot(0, 'PLA'), slot(1, ''), slot(2, 'ABS', 1)],
    },
  ],
}

type Simulator = Awaited<ReturnType<typeof createCrealitySimulator>>

async function run(
  input: {
    frame?: object
    cfsFeed?: boolean
    boxsInfo?: object | undefined
  },
  action: ExtendedControlAction,
  args: Record<string, unknown>,
  check: (result: {
    simulator: Simulator
    sets: () => unknown[]
    execute: Promise<unknown>
    confirmed: () => Promise<boolean>
    controls: readonly string[]
  }) => Promise<void>,
) {
  const simulator = await createCrealitySimulator(input.frame ?? idle, {
    boxsInfo: 'boxsInfo' in input ? input.boxsInfo : boxsInfo,
  })
  const binding = provisionCrealityPrinter(
    {
      assignment_id: randomUUID(),
      farm_id: randomUUID(),
      agent_id: randomUUID(),
      printer_key: 'creality',
    },
    {
      printerKey: 'creality',
      host: '127.0.0.1',
      port: simulator.port,
      transport: 'ws',
      ...(input.cfsFeed ? { cfsFeed: true } : {}),
    },
  )
  let latest: { sequence: number; connectionGeneration: number } | undefined
  const router = createPauseDriverRouter({
    allowedOrigins: [],
    limits: {} as never,
    clock: { monotonicNow: () => performance.now() },
    observe: (_binding, observation) => {
      if (observation) latest = observation
      return true
    },
  })
  try {
    const controls = await router.detect(binding)
    const signal = new AbortController().signal
    const { connectionGeneration } = await router.prepare({ binding, signal })
    let after = { connectionGeneration, sequence: 0, sentMono: 0 }
    const execute = router.execute(action, args, {
      binding,
      signal,
      beforeSend: () => {
        after = {
          connectionGeneration,
          sequence: latest?.sequence ?? 0,
          sentMono: performance.now(),
        }
        return true
      },
    })
    execute.catch(() => {})
    await check({
      simulator,
      controls,
      sets: () => simulator.requests.filter((r) => r.method === 'set'),
      execute,
      async confirmed() {
        const observation = await router.waitForPaused({
          action: action as never,
          args,
          binding,
          signal,
          after,
        })
        return (
          !!observation &&
          controlEffectMatches(action, args, observation, after.sentMono)
        )
      },
    })
  } finally {
    await router.closeAttempt(binding)
    await simulator.close()
  }
}

const set = (params: object) => ({ method: 'set', params })

for (const [level, frames] of [
  ['silent', [{ speedMode: 1 }]],
  ['standard', [{ speedMode: 0 }, { setFeedratePct: 100 }]],
  ['sport', [{ speedMode: 0 }, { setFeedratePct: 125 }]],
] as const)
  test(`speed ${level} sends the maker frames and is confirmed by the report`, () =>
    run({}, 'set_speed', { level }, async (it) => {
      assert.deepEqual(await it.execute, { acknowledged: true })
      assert.deepEqual(it.sets(), frames.map(set))
      assert.equal(await it.confirmed(), true)
    }))

test('a printer without speedMode gets the percentage alone', () =>
  run(
    { frame: { state: 1, curFeedratePct: 100 } },
    'set_speed',
    { level: 'silent' },
    async (it) => {
      await it.execute
      assert.deepEqual(it.sets(), [set({ setFeedratePct: 25 })])
      assert.equal(await it.confirmed(), true)
    },
  ))

for (const [name, frame, level, refusal] of [
  ['ludicrous has no maker mode', idle, 'ludicrous', 'unsupported-action'],
  ['Sleep Mode is on', { ...idle, sleepMode: 1 }, 'sport', 'state'],
  ['F022 is idle', { ...idle, model: 'F022' }, 'sport', 'state'],
] as const)
  test(`speed is refused with nothing sent when ${name}`, () =>
    run({ frame }, 'set_speed', { level }, async (it) => {
      await assert.rejects(it.execute, { refusal })
      assert.deepEqual(it.sets(), [])
    }))

test('CFS tray numbers run four per unit in ascending box id', () => {
  const slots = readCrealityCfsSlots(boxsInfo)!
  assert.deepEqual(
    [...slots].map(([tray, s]) => [tray, s.boxId, s.materialId]),
    [
      [0, 1, 0],
      [1, 1, 1],
      [2, 1, 2],
      [4, 2, 0],
      [5, 2, 1],
    ],
  )
  assert.equal(readCrealityCfsSlots({ materialBoxs: 'x' }), undefined)
})

const feeder = { ...idle, feedState: 0 }

test('CFS load reads the slots, sends one feed frame and sees it finish', () =>
  run(
    { frame: feeder, cfsFeed: true },
    'load_filament',
    { tray: 5 },
    async (it) => {
      assert.ok(it.controls.includes('load_filament'))
      await it.execute
      assert.deepEqual(it.simulator.requests, [
        { method: 'get', params: { boxsInfo: 1 } },
        set({ feedInOrOut: { boxId: 2, materialId: 1, isFeed: 1 } }),
      ])
      assert.equal(await it.confirmed(), true)
    },
  ))

test('CFS unload retracts the slot the printer reports as selected', () =>
  run({ frame: feeder, cfsFeed: true }, 'unload_filament', {}, async (it) => {
    await it.execute
    assert.deepEqual(it.sets(), [
      set({ feedInOrOut: { boxId: 1, materialId: 2, isFeed: 0 } }),
    ])
    assert.equal(await it.confirmed(), true)
  }))

test('CFS feed is neither advertised nor sent without the owner opt-in', () =>
  run({ frame: feeder }, 'load_filament', { tray: 0 }, async (it) => {
    assert.equal(it.controls.includes('load_filament'), false)
    assert.equal(it.controls.includes('unload_filament'), false)
    await assert.rejects(it.execute, /Control action unavailable/)
    assert.deepEqual(it.simulator.requests, [])
  }))

const unselected = {
  materialBoxs: [{ id: 1, type: 0, materials: [slot(0, 'PLA')] }],
}
for (const [name, frame, report, action, args, refusal] of [
  ['no tray is named', feeder, boxsInfo, 'load', {}, 'invalid-command'],
  [
    'the feeder is busy',
    { ...idle, feedState: 2 },
    boxsInfo,
    'load',
    { tray: 0 },
    'state',
  ],
  ['no feed state is reported', idle, boxsInfo, 'load', { tray: 0 }, 'state'],
  ['the slot type is unknown', feeder, boxsInfo, 'load', { tray: 1 }, 'state'],
  ['the slot does not exist', feeder, boxsInfo, 'load', { tray: 15 }, 'state'],
  ['no slot is active', feeder, unselected, 'unload', {}, 'state'],
  ['no CFS answers', feeder, undefined, 'unload', {}, 'state'],
  [
    'the model is F039',
    { ...feeder, model: 'F039' },
    boxsInfo,
    'unload',
    {},
    'unsupported-action',
  ],
] as const)
  test(
    `CFS ${action} is refused with no command when ${name}`,
    { timeout: 20_000 },
    () =>
      run(
        { frame, cfsFeed: true, boxsInfo: report },
        `${action}_filament`,
        args,
        async (it) => {
          await assert.rejects(it.execute, { refusal })
          assert.deepEqual(it.sets(), [])
        },
      ),
  )
