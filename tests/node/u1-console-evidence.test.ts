import assert from 'node:assert/strict'
import { test, type TestContext } from 'node:test'
import { u1ConsoleAudit } from '../../packages/connector/src/moonraker/u1-audit.ts'
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
} from '../helpers/command-v2-dispatch.ts'

// Simulator only: no physical printer is contacted. The query reports are
// reference-derived (not captured); sources are cited in u1-audit.ts.
const states = ['standby', 'printing', 'paused'] as const
const builtIns = ['M105', 'M114', 'M115', 'GET_POSITION']

async function world(t: TestContext, options: MoonrakerMockOptions = {}) {
  const authority = await createV2Authority(await nodeSigner())
  const withdraw = declareSnapmakerU1Printers([
    { printerKey: authority.printerKey, model: 'Snapmaker U1' },
  ])
  t.after(withdraw)
  const remote = await startMoonrakerMock({ profile: 'u1', ...options })
  t.after(() => remote.close())
  let retired: Promise<void> | undefined
  const session = await openV2Dispatch(authority, {
    capability: { role: 'owner', actions: ['gcode'] },
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
          gcodeConsole: () => true,
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
  async function run(line: string) {
    retired = undefined
    const result = await session.dispatch(
      await authority.sign(
        { action: 'gcode', args: { line }, purpose: 'printer-control' },
        session.now(),
      ),
    )
    await retired
    return result
  }
  return { remote, run }
}

function assertUnconfirmed(
  result: Awaited<ReturnType<Awaited<ReturnType<typeof world>>['run']>>,
) {
  assert.equal(result.kind, 'outcome-unknown', JSON.stringify(result))
  assert.equal(result.reason, 'state-unconfirmed')
}

for (const state of states) {
  test(`built-in queries are applied with their report while ${state}`, async (t) => {
    const { remote, run } = await world(t)
    remote.control.update({ state })
    const lines =
      state === 'standby'
        ? [...builtIns, 'QUERY_ENDSTOPS']
        : [...builtIns, 'query_endstops']
    for (const line of lines) {
      const result = await run(line)
      assert.equal(result.kind, 'applied', JSON.stringify({ line, result }))
    }
    assert.deepEqual(remote.control.gcodeScripts, lines)
  })

  test(`built-in queries are sent but unconfirmed without a report while ${state}`, async (t) => {
    const { remote, run } = await world(t, { gcodeQueryReports: false })
    remote.control.update({ state })
    const lines = [...builtIns, 'QUERY_ENDSTOPS']
    for (const line of lines) assertUnconfirmed(await run(line))
    // Each line was written exactly once and never retried.
    assert.deepEqual(remote.control.gcodeScripts, lines)
  })

  test(`macros that shadow queries are refused while ${state}`, async (t) => {
    const { remote, run } = await world(t, {
      macros: ['QUERY_FOO', 'QUERY_X', 'm105', 'QUERY_ENDSTOPS'],
    })
    remote.control.update({ state })
    for (const line of [
      'QUERY_FOO',
      'query_foo',
      'QUERY_X VALUE=1',
      'M105',
      'QUERY_ENDSTOPS',
    ]) {
      const result = await run(line)
      assert.equal(result.kind, 'not-sent', JSON.stringify({ line, result }))
    }
    assert.deepEqual(remote.control.gcodeScripts, [])
  })
}

test('an unrelated or late report does not confirm a query', async (t) => {
  let respond = () => {}
  const { remote, run } = await world(t, {
    gcodeQueryReports: false,
    onMacroCall: () => respond(),
  })
  remote.control.update({ state: 'printing' })
  // The mock's bare "ok" and another command's report prove nothing.
  respond = () => remote.control.broadcastGcodeResponse('x:open y:open')
  assertUnconfirmed(await run('M105'))
  respond = () => {}
  remote.control.broadcastGcodeResponse('B:60.0 /60.0 T0:210.0 /210.0')
  assertUnconfirmed(await run('M105'))
})

test('an unknown query has no provable report', async (t) => {
  let respond = () => {}
  const { remote, run } = await world(t, { onMacroCall: () => respond() })
  respond = () => remote.control.broadcastGcodeResponse('// anything')
  remote.control.update({ state: 'printing' })
  assertUnconfirmed(await run('QUERY_SOMETHING'))
  assert.deepEqual(remote.control.gcodeScripts, ['QUERY_SOMETHING'])
})

test('each query accepts only its own report format', () => {
  const cases: [line: string, report: string, proven: boolean][] = [
    ['M105', 'T0:210.0 /210.0 B:60.0 /60.0', true],
    ['M105', 'T:0', false],
    ['M105', '// echo: M105', false],
    ['M114', 'X:1.000 Y:-2.000 Z:0.200 E:0.000', true],
    ['M114', 'ok', false],
    ['M115', '// FIRMWARE_NAME:Klipper FIRMWARE_VERSION:v0.12.0', true],
    ['M115', 'ok', false],
    [
      'GET_POSITION',
      '// mcu: x:0\n// toolhead: X:0\n// gcode homing: X:0',
      true,
    ],
    ['GET_POSITION', '// mcu: x:0', false],
    ['QUERY_PROBE', '// probe: TRIGGERED', true],
    ['QUERY_PROBE', 'x:open', false],
    ['QUERY_ADC', '// Available ADC objects: "extruder"', true],
    ['QUERY_ADC NAME=extruder', '// Available ADC objects: "x"', false],
    [
      'QUERY_ADC NAME=extruder',
      '// ADC object "extruder" has value 0.500000 (timestamp 1.000)',
      true,
    ],
    [
      'QUERY_FILAMENT_SENSOR SENSOR=e0',
      '// Filament Sensor e0: filament not detected',
      true,
    ],
    [
      'QUERY_FILAMENT_SENSOR SENSOR=e0',
      '// Filament Sensor e1: filament detected',
      false,
    ],
    ['QUERY_FOO', 'x:open', false],
  ]
  for (const [line, report, proven] of cases) {
    const audit = u1ConsoleAudit(line)
    assert.equal(audit.effect({}, 1), undefined, line)
    audit.response?.(report)
    assert.equal(
      audit.effect({}, 1) !== undefined,
      proven,
      JSON.stringify({ line, report }),
    )
  }
})
