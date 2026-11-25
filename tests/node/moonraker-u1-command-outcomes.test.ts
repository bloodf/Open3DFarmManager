import assert from 'node:assert/strict'
import { test, type TestContext } from 'node:test'
import {
  u1ConsoleAudit,
  u1HomeAudit,
} from '../../packages/connector/src/moonraker/u1-audit.ts'
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

test('declared U1 keeps the builder refusal reason instead of calling it invalid', async (t) => {
  const { remote, run } = await world(t)
  // The request is well formed; the U1 simply has no chamber heater.
  const chamber = await run('set_temperature', {
    heater: 'chamber',
    target_c: 40,
  })
  assert.equal(chamber.kind, 'not-sent', JSON.stringify(chamber))
  assert.equal(chamber.reason, 'unsupported-action', JSON.stringify(chamber))
  assert.deepEqual(remote.control.gcodeScripts, [])
})

test('declared U1 still reports a malformed request as invalid', async (t) => {
  const { remote, run } = await world(t)
  const result = await run('set_temperature', { heater: 'bed', target_c: 101 })
  assert.equal(result.kind, 'not-sent', JSON.stringify(result))
  assert.equal(result.reason, 'invalid-command', JSON.stringify(result))
  assert.deepEqual(remote.control.gcodeScripts, [])
})

test('declared U1 applies console lines only with read-back evidence', async (t) => {
  const { remote, applied } = await world(t)
  remote.control.update({ bedTarget: 60 })
  await applied('gcode', { line: 'M140 S0' })
  assert.equal(remote.control.model().bedTarget, 0)
  await applied('gcode', { line: 'M220 S120' })
  assert.equal(remote.control.model().speedFactor, 1.2)
  // Output-only commands have no state to read; the acknowledgement stands.
  await applied('gcode', { line: 'M105' })
  assert.deepEqual(remote.control.gcodeScripts, [
    'M140 S0',
    'M220 S120',
    'M105',
  ])
  // Canonical homing is confirmed by the homed axes, not by the script alone.
  await applied('gcode', { line: 'G28' })
  assert.equal(remote.control.gcodeScripts.at(-1), 'G28 X Y Z')
})

test('declared U1 reports an unreadable console line as sent but unconfirmed and never retries it', async (t) => {
  const { remote, run } = await world(t)
  for (const line of ['M104 S0', 'M117 hello']) {
    const before = remote.control.gcodeScripts.length
    const result = await run('gcode', { line })
    assert.equal(result.kind, 'outcome-unknown', JSON.stringify(result))
    assert.equal(result.reason, 'state-unconfirmed', JSON.stringify(result))
    assert.equal(remote.control.gcodeScripts.length, before + 1)
    assert.equal(remote.control.gcodeScripts.at(-1), line)
  }
  remote.control.update({ state: 'printing' })
  const adjust = await run('gcode', { line: 'SET_GCODE_OFFSET Z_ADJUST=0.05' })
  assert.equal(adjust.kind, 'outcome-unknown', JSON.stringify(adjust))
  assert.equal(remote.control.gcodeScripts.length, 3)
})

test('U1 console evidence rejects state that contradicts the line', () => {
  const effect = (line: string, status: unknown, tool?: string) =>
    u1ConsoleAudit(line, tool).effect(status, 5)
  assert.equal(effect('M140 S0', { heater_bed: { target: 60 } }), undefined)
  assert.equal(effect('M140 S0', {}), undefined)
  assert.equal(
    effect('M220 S120', { gcode_move: { speed_factor: 1 } }),
    undefined,
  )
  assert.deepEqual(effect('M220 S120', { gcode_move: { speed_factor: 1.2 } }), {
    kind: 'gcode',
    line: 'M220 S120',
    observedMono: 5,
  })
  assert.equal(
    effect('M117 hi', { toolhead: { extruder: 'extruder' } }),
    undefined,
  )
  assert.equal(
    effect('T1', { toolhead: { extruder: 'extruder' } }, 'extruder1'),
    undefined,
  )
  const home = u1HomeAudit({ axes: ['x', 'y', 'z'] })
  assert.equal(
    u1ConsoleAudit('G28', undefined, home).effect(
      { toolhead: { homed_axes: 'xy' } },
      5,
    ),
    undefined,
  )
  assert.equal(
    u1ConsoleAudit('G28', undefined, home).effect(
      { toolhead: { homed_axes: 'xyz' } },
      5,
    )?.kind,
    'gcode',
  )
})
