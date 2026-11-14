import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { createCrealitySimulator } from '../../packages/sim-tools/src/creality-simulator.ts'
import { provisionCrealityPrinter } from '../../packages/connector/src/control/printer-binding.ts'
import { createPauseDriverRouter } from '../../packages/connector/src/runtime/pause-driver-router.ts'

for (const [action, args, params] of [
  ['pause', {}, { pause: 1 }],
  ['resume', {}, { pause: 0 }],
  ['cancel', {}, { stop: 1 }],
  [
    'set_temperature',
    { heater: 'bed', target_c: 60 },
    { bedTempControl: { num: 0, val: 60 } },
  ],
  ['set_fan', { fan: 'part', percent: 100 }, { fan: 1 }],
  ['home', { axes: ['x', 'y'] }, { autohome: 'X Y' }],
  ['set_light', { on: true }, { lightSw: 1 }],
] as const) {
  test(`Creality routes ${action} once`, async () => {
    const simulator = await createCrealitySimulator({ state: 1 })
    const binding = provisionCrealityPrinter(
      {
        assignment_id: randomUUID(),
        farm_id: randomUUID(),
        agent_id: randomUUID(),
        printer_key: 'creality',
      },
      { printerKey: 'creality', host: '127.0.0.1', port: simulator.port },
    )
    const router = createPauseDriverRouter({
      allowedOrigins: [],
      limits: {} as never,
      clock: { monotonicNow: () => performance.now() },
      observe: () => true,
    })
    try {
      assert.deepEqual(await router.detect(binding), [
        'pause',
        'resume',
        'cancel',
        'set_temperature',
        'set_fan',
        'home',
        'set_light',
      ])
      const signal = new AbortController().signal
      await router.prepare({ binding, signal })
      let guards = 0
      const request = {
        binding,
        signal,
        beforeSend: () => {
          guards++
          return true
        },
      }
      await assert.rejects(router.execute('emergency_stop', {}, request))
      assert.deepEqual(await router.execute(action, args, request), {
        acknowledged: true,
      })
      await assert.rejects(router.execute(action, args, request))
      assert.equal(guards, 1)
      assert.deepEqual(simulator.requests, [{ method: 'set', params }])
    } finally {
      await router.closeAttempt(binding)
      await simulator.close()
    }
  })
}
