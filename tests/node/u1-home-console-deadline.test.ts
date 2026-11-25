import assert from 'node:assert/strict'
import { test, type TestContext } from 'node:test'
import { isU1PhysicalControl } from '../../packages/farm-protocol/src/control-actions.ts'
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

/** Past the default 5 s result deadline, inside the U1 physical window. */
const DELAYED_ACK_MS = 5200

async function world(t: TestContext, options: MoonrakerMockOptions) {
  const authority = await createV2Authority(await nodeSigner())
  t.after(
    declareSnapmakerU1Printers([
      { printerKey: authority.printerKey, model: 'Snapmaker U1' },
    ]),
  )
  const remote = await startMoonrakerMock({ profile: 'u1', ...options })
  t.after(() => remote.close())
  let retired: Promise<void> | undefined
  const session = await openV2Dispatch(authority, {
    capability: { role: 'owner', actions: ['home', 'gcode'] },
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
  remote.control.faults.addFault({
    path: '/websocket',
    method: 'printer.gcode.script',
    fault: { type: 'delay', delayMs: DELAYED_ACK_MS },
    count: 1,
  })
  async function run(
    action: ExtendedControlAction,
    args: Record<string, unknown>,
  ) {
    retired = undefined
    const result = await session.dispatch(
      await authority.sign(
        { action, args, purpose: 'printer-control' },
        session.now(),
      ),
    )
    await retired
    return result
  }
  return { remote, run }
}

test('canonical console homing lines share the U1 physical-control window', () => {
  for (const line of ['G28', 'g28', ' G28 X Y ', 'G28 Z', 'G28 Z Y X'])
    assert.equal(isU1PhysicalControl('gcode', { line }), true, line)
  for (const line of ['G28 X0', 'G28 X X', 'G280', 'G1 X1', 'G28 E', 'M105'])
    assert.equal(isU1PhysicalControl('gcode', { line }), false, line)
})

test('admitted U1 console home confirms a delayed acknowledgement with one write', async (t) => {
  const { remote, run } = await world(t, { homedAxes: '' })
  const result = await run('gcode', { line: 'G28' })
  assert.equal(result.kind, 'applied', JSON.stringify(result))
  assert.deepEqual(remote.control.gcodeScripts, ['G28 X Y Z'])
  assert.equal(remote.calls()['printer.gcode.script'], 1)
})

test('U1 console home still refuses an advertised G28 macro without a write', async (t) => {
  const { remote, run } = await world(t, { homedAxes: '', macros: ['G28'] })
  for (const line of ['G28', 'G28 X Y']) {
    const result = await run('gcode', { line })
    assert.equal(result.kind, 'not-sent', JSON.stringify({ line, result }))
  }
  assert.deepEqual(remote.control.gcodeScripts, [])
  assert.equal(remote.calls()['printer.gcode.script'] ?? 0, 0)
})
