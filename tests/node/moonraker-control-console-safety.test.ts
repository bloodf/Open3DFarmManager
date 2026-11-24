import assert from 'node:assert/strict'
import { test, type TestContext } from 'node:test'
import { declareSnapmakerU1Printers } from '../../packages/connector/src/moonraker/u1-tools.ts'
import { createPauseDriverRouter } from '../../packages/connector/src/runtime/pause-driver-router.ts'
import {
  startMoonrakerMock,
  type MoonrakerMockOptions,
} from '../../packages/sim-tools/src/mocks/moonraker-mock.ts'
import {
  createV2Authority,
  nodeSigner,
  openV2Dispatch,
  type ExtendedControlAction,
} from '../helpers/command-v2-dispatch.ts'

const actions = [
  'pause',
  'resume',
  'cancel',
  'set_temperature',
  'set_tool_temperature',
  'home',
  'jog',
  'gcode',
  'start_print',
  'set_fan',
] satisfies ExtendedControlAction[]

const configfileSettings = {
  extruder: { max_temp: 260 },
  extruder1: { max_temp: 250 },
  extruder2: { max_temp: 265 },
  extruder3: { max_temp: 275 },
  heater_bed: { max_temp: 80 },
  printer: { max_velocity: 40, max_z_velocity: 12 },
  stepper_x: { position_min: 0, position_max: 200 },
  stepper_y: { position_min: 0, position_max: 200 },
  stepper_z: { position_min: 0, position_max: 240 },
  unrelated_config: { gcode: 'M105\n'.repeat(1000) },
}

async function world(
  t: TestContext,
  options: MoonrakerMockOptions = {},
  console = true,
  u1 = true,
) {
  const authority = await createV2Authority(await nodeSigner())
  if (u1) {
    const withdraw = declareSnapmakerU1Printers([
      { printerKey: authority.printerKey, model: 'Snapmaker U1' },
    ])
    t.after(withdraw)
  }
  const remote = await startMoonrakerMock({
    profile: u1 ? 'u1' : 'sv06',
    configfileSettings,
    ...options,
  })
  t.after(() => remote.close())
  let retired: Promise<void> | undefined
  const session = await openV2Dispatch(authority, {
    capability: { role: 'owner', actions },
    loopback: {
      origin: remote.origin,
      driver({ clock, observe }) {
        const router = createPauseDriverRouter({
          allowedOrigins: [remote.origin],
          limits: {
            maxMessageBytes: 65536,
            connectTimeoutMs: 2000,
            requestTimeoutMs: 2000,
            staleAfterMs: 2000,
            reconnectMinMs: 100,
            reconnectMaxMs: 100,
          },
          clock,
          observe,
          gcodeConsole: () => console,
        })
        return {
          ...router,
          closeAttempt(binding) {
            retired = router.closeAttempt(binding)
            return retired
          },
        }
      },
    },
  })
  t.after(() => session.close())
  async function run(
    action: ExtendedControlAction,
    args: Record<string, unknown> = {},
  ) {
    retired = undefined
    const result = await session.dispatch(
      await authority.sign(
        {
          action,
          args,
          purpose: action === 'pause' ? 'printer-pause' : 'printer-control',
        },
        session.now(),
      ),
    )
    await retired
    return result
  }
  async function applied(
    action: ExtendedControlAction,
    args?: Record<string, unknown>,
  ) {
    const result = await run(action, args)
    assert.equal(result.kind, 'applied', JSON.stringify(result))
  }
  return { remote, session, run, applied }
}

test('idle console refuses unclassified and unsafe movement while preserving queries', async (t) => {
  const { remote, run, applied } = await world(t, { homedAxes: '' })
  for (const line of ['G1 X10 F300', 'G1 E100 F300', 'UNTRUSTED_MACRO']) {
    const result = await run('gcode', { line })
    assert.equal(result.kind, 'not-sent', JSON.stringify({ line, result }))
  }
  await applied('gcode', { line: 'M105' })
  assert.deepEqual(remote.control.gcodeScripts, ['M105'])
})

const RAW_MOTION = [
  ['G0 X10 F300', 'G1 X10 F300', 'G1 X100 F300', 'G1 Z-5 F300', 'G1 E5 F300'],
  [
    'G1 X10 Y10 F300',
    'G1 X10 F99999',
    'G91',
    'G92 X0',
    'M84',
    'UNTRUSTED_MACRO',
  ],
]

for (const u1 of [true, false])
  for (const [part, lines] of RAW_MOTION.entries())
    test(`idle console refuses raw motion and macros without writing (${u1 ? 'U1' : 'generic'} ${part + 1})`, async (t) => {
      const { remote, run, applied } = await world(t, {}, true, u1)
      for (const line of lines) {
        const result = await run('gcode', { line })
        assert.equal(result.kind, 'not-sent', JSON.stringify({ line, result }))
      }
      assert.deepEqual(remote.control.gcodeScripts, [])
      if (u1) await applied('gcode', { line: 'M105' })
      else await run('gcode', { line: 'M105' })
      assert.deepEqual(remote.control.gcodeScripts, ['M105'])
    })

test('idle console homes through the structured home script', async (t) => {
  const { remote, run } = await world(t, { homedAxes: '' }, true, false)
  // The generic dispatch harness never confirms extended actions: the home
  // action itself reports the same unknown outcome as the console line.
  for (const line of ['G28', 'G28 X Y'])
    assert.notEqual((await run('gcode', { line })).kind, 'not-sent')
  assert.deepEqual(remote.control.gcodeScripts, ['G28 X Y Z', 'G28 X Y'])
})

test('idle U1 console homing keeps the XY pairing and Z-only checks', async (t) => {
  const { remote, run, applied } = await world(t, { homedAxes: '' })
  for (const line of ['G28 X', 'G28 Z', 'G28 X0', 'G28 X X']) {
    const result = await run('gcode', { line })
    assert.equal(result.kind, 'not-sent', JSON.stringify({ line, result }))
  }
  assert.deepEqual(remote.control.gcodeScripts, [])
  await applied('gcode', { line: 'G28 X Y' })
  await applied('gcode', { line: 'G28 Z' })
  assert.deepEqual(remote.control.gcodeScripts, ['G28 X Y', 'G28 Z'])
})

test('idle U1 console tool selection still needs homed axes and an idle printer', async (t) => {
  const { remote, run, applied } = await world(t, { homedAxes: '' })
  const early = await run('gcode', { line: 'T2' })
  assert.equal(early.kind, 'not-sent', JSON.stringify(early))
  await applied('gcode', { line: 'G28' })
  await applied('gcode', { line: 'T2' })
  assert.equal(remote.control.model().activeTool, 2)
  assert.deepEqual(remote.control.gcodeScripts, ['G28 X Y Z', 'T2 A0'])
  remote.control.update({ state: 'printing' })
  for (const line of ['G28', 'T0', 'G1 X10 F300']) {
    const result = await run('gcode', { line })
    assert.equal(result.kind, 'not-sent', JSON.stringify({ line, result }))
  }
  assert.equal(remote.control.gcodeScripts.length, 2)
})

test('idle generic console refuses a tool macro it cannot classify', async (t) => {
  const { remote, run } = await world(t, {}, true, false)
  const result = await run('gcode', { line: 'T0' })
  assert.equal(result.kind, 'not-sent', JSON.stringify(result))
  assert.deepEqual(remote.control.gcodeScripts, [])
})

for (const u1 of [true, false])
  test(`idle console refuses homing when G28 is an advertised macro (${u1 ? 'U1' : 'generic'})`, async (t) => {
    const { remote, run } = await world(t, { macros: ['G28'] }, true, u1)
    for (const line of ['G28', 'G28 X Y', 'G28 Z']) {
      const result = await run('gcode', { line })
      assert.equal(result.kind, 'not-sent', JSON.stringify({ line, result }))
    }
    assert.deepEqual(remote.control.gcodeScripts, [])
  })

test('idle console still homes canonically when no G28 macro is advertised', async (t) => {
  const { remote, run } = await world(
    t,
    { macros: ['LOAD_FILAMENT'], homedAxes: '' },
    true,
    false,
  )
  assert.notEqual((await run('gcode', { line: 'G28' })).kind, 'not-sent')
  assert.deepEqual(remote.control.gcodeScripts, ['G28 X Y Z'])
})
