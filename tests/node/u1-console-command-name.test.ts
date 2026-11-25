import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  consoleAllowedWhilePrinting,
  idleConsoleClass,
} from '../../packages/connector/src/moonraker/control-console.ts'
import { klipperCommandName } from '../../packages/connector/src/moonraker/klipper-command.ts'
import { u1ConsoleAudit } from '../../packages/connector/src/moonraker/u1-audit.ts'
import { declareSnapmakerU1Printers } from '../../packages/connector/src/moonraker/u1-tools.ts'
import { createPauseDriverRouter } from '../../packages/connector/src/runtime/pause-driver-router.ts'
import { startMoonrakerMock } from '../../packages/sim-tools/src/mocks/moonraker-mock.ts'
import {
  createV2Authority,
  nodeSigner,
  openV2Dispatch,
} from '../helpers/command-v2-dispatch.ts'

test('console command names follow Klipper dispatch', () => {
  for (const [line, command] of [
    ['QUERY_FOO1BAR', 'QUERY_FOO1'],
    ['QUERY_T0X', 'QUERY_T0'],
    ['G1X10', 'G1'],
    ['  query_foo1bar  ', 'QUERY_FOO1'],
    ['m105', 'M105'],
    ['QUERY_FOO', 'QUERY_FOO'],
    ['N42 G1X10*99 ; comment', 'G1'],
  ] as const) {
    assert.equal(klipperCommandName(line), command, line)
  }
})

test('console policy keeps strict arguments after resolving the command name', () => {
  assert.equal(idleConsoleClass('G1X10'), 'guarded')
  assert.equal(consoleAllowedWhilePrinting('G1X10'), false)
  assert.equal(consoleAllowedWhilePrinting('QUERY_FOO1BAR'), false)
  assert.equal(consoleAllowedWhilePrinting('QUERY_T0X'), false)
  assert.equal(idleConsoleClass('QUERY_FOO'), 'refused')
  assert.equal(consoleAllowedWhilePrinting('QUERY_FOO'), true)
  assert.equal(idleConsoleClass('m105'), 'safe')
  assert.equal(consoleAllowedWhilePrinting('m105'), true)
})

test('U1 audit matches reports to the parsed command name', () => {
  const line = 'm105x10'
  const audit = u1ConsoleAudit(line)
  assert.equal(audit.effect({}, 5), undefined)
  audit.response?.('T:20.0 /0.0')
  assert.deepEqual(audit.effect({}, 5), {
    kind: 'gcode',
    line,
    observedMono: 5,
  })
})

for (const state of ['standby', 'printing', 'paused'] as const) {
  test(`U1 console refuses overridden commands and compact arguments in ${state}`, async (t) => {
    const authority = await createV2Authority(await nodeSigner())
    t.after(
      declareSnapmakerU1Printers([
        { printerKey: authority.printerKey, model: 'Snapmaker U1' },
      ]),
    )
    const remote = await startMoonrakerMock({
      profile: 'u1',
      macros: ['QUERY_FOO1', 'QUERY_T0', 'M105', 'QUERY_FOO'],
    })
    t.after(() => remote.close())
    remote.control.update({ state })
    const session = await openV2Dispatch(authority, {
      capability: { role: 'owner', actions: ['gcode'] },
      loopback: {
        origin: remote.origin,
        driver: ({ clock, observe }) =>
          createPauseDriverRouter({
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
          }),
      },
    })
    t.after(() => session.close())

    for (const line of [
      'QUERY_FOO1BAR',
      'QUERY_T0X',
      'G1X10',
      'query_foo1bar',
      'm105',
      'QUERY_FOO',
    ]) {
      const result = await session.dispatch(
        await authority.sign(
          { action: 'gcode', args: { line }, purpose: 'printer-control' },
          session.now(),
        ),
      )
      assert.equal(result.kind, 'not-sent', JSON.stringify({ line, result }))
    }
    assert.deepEqual(remote.control.gcodeScripts, [])
  })
}
