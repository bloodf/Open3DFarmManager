import assert from 'node:assert/strict'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test, type TestContext } from 'node:test'
import { declareSnapmakerU1Printers } from '../../packages/connector/src/moonraker/u1-tools.ts'
import { uploadMoonrakerFile } from '../../packages/connector/src/moonraker/upload.ts'
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
) {
  const authority = await createV2Authority(await nodeSigner())
  const withdraw = declareSnapmakerU1Printers([
    { printerKey: authority.printerKey, model: 'Snapmaker U1' },
  ])
  t.after(withdraw)
  const remote = await startMoonrakerMock({
    profile: 'u1',
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

test('declared U1 sets and clears each tool and the bed', async (t) => {
  const { remote, applied } = await world(t)
  for (const tool of [0, 1, 2, 3]) {
    const heater = tool ? `extruder${tool}` : 'extruder'
    await applied('set_tool_temperature', { tool, target_c: 195 + tool })
    assert.equal(remote.control.model().extruders[heater]?.target, 195 + tool)
    await applied('set_tool_temperature', { tool, target_c: 0 })
    assert.equal(remote.control.model().extruders[heater]?.target, 0)
  }
  await applied('set_temperature', { heater: 'bed', target_c: 55 })
  assert.equal(remote.control.model().bedTarget, 55)
  await applied('set_temperature', { heater: 'bed', target_c: 0 })
  assert.equal(remote.control.model().bedTarget, 0)
  assert.equal(remote.control.gcodeScripts.length, 10)
})

test('declared U1 homes, jogs and selects tools', async (t) => {
  const { remote, applied, run } = await world(t, { homedAxes: '' })
  const early = await run('gcode', { line: 'T2' })
  assert.equal(early.kind, 'not-sent', JSON.stringify(early))
  const unhomed = await run('jog', { axis: 'x', distance_mm: 1, feed: 300 })
  assert.deepEqual(unhomed.kind, 'not-sent', JSON.stringify(unhomed))
  assert.deepEqual(remote.control.gcodeScripts, [])
  await applied('home', { axes: ['x', 'y', 'z'] })
  await applied('jog', { axis: 'x', distance_mm: 1, feed: 300 })
  for (const tool of [0, 1, 2, 3]) {
    await applied('gcode', { line: `T${tool}` })
    assert.equal(remote.control.model().activeTool, tool)
  }
  assert.deepEqual(remote.control.gcodeScripts, [
    'G28 X Y Z',
    'G91\nG1 X1 F300\nG90',
    'T0 A0',
    'T1 A0',
    'T2 A0',
    'T3 A0',
  ])
})

test('declared U1 homes XY together and checks XY before Z-only homing', async (t) => {
  const { remote, run, applied } = await world(t, { homedAxes: '' })
  for (const axes of [['x'], ['y', 'z'], ['z']]) {
    const result = await run('home', { axes })
    assert.equal(result.kind, 'not-sent', JSON.stringify(result))
  }
  assert.deepEqual(remote.control.gcodeScripts, [])
  await applied('home', { axes: ['x', 'y'] })
  await applied('home', { axes: ['z'] })
  assert.deepEqual(remote.control.gcodeScripts, ['G28 X Y', 'G28 Z'])
})

test('declared U1 confirms a delayed signed home without replaying its write', async (t) => {
  const { remote, applied } = await world(t, { homedAxes: '' })
  remote.control.faults.addFault({
    path: '/websocket',
    method: 'printer.gcode.script',
    fault: { type: 'delay', delayMs: 5200 },
    count: 1,
  })
  await applied('home', { axes: ['x', 'y', 'z'] })
  assert.deepEqual(remote.control.gcodeScripts, ['G28 X Y Z'])
  assert.equal(remote.calls()['printer.gcode.script'], 1)
})

test('declared U1 confirms a delayed console home without replaying its write', async (t) => {
  const { remote, applied } = await world(t, { homedAxes: '' })
  remote.control.faults.addFault({
    path: '/websocket',
    method: 'printer.gcode.script',
    fault: { type: 'delay', delayMs: 5200 },
    count: 1,
  })
  await applied('gcode', { line: 'G28' })
  assert.deepEqual(remote.control.gcodeScripts, ['G28 X Y Z'])
  assert.equal(remote.calls()['printer.gcode.script'], 1)
})

test('declared U1 console still refuses an advertised G28 macro under the home window', async (t) => {
  const { remote, run } = await world(t, { homedAxes: '', macros: ['G28'] })
  remote.control.faults.addFault({
    path: '/websocket',
    method: 'printer.gcode.script',
    fault: { type: 'delay', delayMs: 5200 },
    count: 1,
  })
  for (const line of ['G28', 'G28 X Y']) {
    const result = await run('gcode', { line })
    assert.equal(result.kind, 'not-sent', JSON.stringify({ line, result }))
  }
  assert.deepEqual(remote.control.gcodeScripts, [])
  assert.equal(remote.calls()['printer.gcode.script'] ?? 0, 0)
})

test('declared U1 console retains the existing safety policy', async (t) => {
  const { remote, run, applied } = await world(t)
  for (const line of [
    'RESTART',
    'FIRMWARE_RESTART',
    'SAVE_CONFIG',
    'SDCARD_PRINT_FILE',
    'T4',
    'T2 P0',
  ]) {
    const result = await run('gcode', { line })
    assert.equal(result.kind, 'not-sent', JSON.stringify(result))
  }
  remote.control.update({ state: 'printing' })
  for (const line of ['G28', 'T0']) {
    const result = await run('gcode', { line })
    assert.equal(result.kind, 'not-sent', JSON.stringify(result))
  }
  await applied('gcode', { line: 'M105' })
  assert.deepEqual(remote.control.gcodeScripts, ['M105'])
})

test('declared U1 console refuses vendor start aliases and alternate tool commands', async (t) => {
  const { remote, run } = await world(t)
  for (const line of [
    'sdcard_print_file_with_parameters FILENAME=cube.gcode',
    'SDCARD_PRINT_PL_RESTORE',
    'N1 RESTART',
    'N1 T2',
    'N 1 T2',
    'T 2',
    'T+2',
    'T02',
  ]) {
    const result = await run('gcode', { line })
    assert.equal(result.kind, 'not-sent', JSON.stringify({ line, result }))
  }
  assert.deepEqual(remote.control.gcodeScripts, [])
})

test('declared U1 refuses unsupported or unsafe commands with zero writes', async (t) => {
  const { remote, run } = await world(t, {}, false)
  for (const [action, args] of [
    ['set_fan', { fan: 'part', percent: 30 }],
    ['gcode', { line: 'M105' }],
    ['set_temperature', { heater: 'bed', target_c: 101 }],
  ] as const) {
    const result = await run(action, args)
    assert.ok(
      result.kind === 'rejected' || result.kind === 'not-sent',
      JSON.stringify(result),
    )
  }
  remote.control.update({ state: 'printing' })
  for (const [action, args] of [
    ['jog', { axis: 'x', distance_mm: 1, feed: 300 }],
    ['set_tool_temperature', { tool: 1, target_c: 200 }],
  ] as const) {
    const result = await run(action, args)
    assert.equal(result.kind, 'not-sent', JSON.stringify(result))
  }
  assert.deepEqual(remote.control.gcodeScripts, [])
})

test('declared U1 enforces the installed heater and motion limits', async (t) => {
  const { remote, run, applied } = await world(t, {
    configfileSettings: {
      ...configfileSettings,
      extruder2: {},
      stepper_x: { position_min: 0, position_max: 0.5 },
    },
  })
  for (const [action, args] of [
    ['set_tool_temperature', { tool: 1, target_c: 251 }],
    ['set_tool_temperature', { tool: 2, target_c: 200 }],
    ['set_temperature', { heater: 'bed', target_c: 81 }],
    ['jog', { axis: 'x', distance_mm: 1, feed: 300 }],
    ['jog', { axis: 'y', distance_mm: 1, feed: 2401 }],
    ['jog', { axis: 'z', distance_mm: 1, feed: 721 }],
  ] as const) {
    const result = await run(action, args)
    assert.equal(result.kind, 'not-sent', JSON.stringify(result))
  }
  assert.deepEqual(remote.control.gcodeScripts, [])
  await applied('set_tool_temperature', { tool: 2, target_c: 0 })
  assert.deepEqual(remote.control.gcodeScripts, [
    'SET_HEATER_TEMPERATURE HEATER=extruder2 TARGET=0',
  ])
})

test('declared U1 starts an uploaded file', async (t) => {
  const { remote, session, applied, run } = await world(t)
  const file = 'simulator-cube.gcode'
  const filePath = join(session.directory, file)
  await writeFile(filePath, '; simulator only\n')
  await uploadMoonrakerFile({
    origin: remote.origin,
    filePath,
    name: file,
    signal: AbortSignal.timeout(5000),
  })
  assert.equal(remote.control.model().state, 'standby')
  await applied('start_print', { file })
  assert.equal(remote.control.model().filename, file)
  assert.equal(remote.control.model().state, 'printing')
  const busy = await run('start_print', { file })
  assert.equal(busy.kind, 'not-sent', JSON.stringify(busy))
  await applied('pause')
  assert.equal(remote.control.model().state, 'paused')
  await applied('resume')
  assert.equal(remote.control.model().state, 'printing')
  await applied('cancel')
  assert.equal(remote.control.model().state, 'cancelled')
  assert.equal(remote.calls()['printer.print.start'], 1)
})
