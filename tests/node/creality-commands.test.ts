import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import {
  buildCrealityCommand,
  supportedCrealityActions,
} from '../../packages/connector/src/creality/commands.ts'
import { createCrealitySimulator } from '../../packages/sim-tools/src/creality-simulator.ts'

const require = createRequire(
  new URL('../../packages/connector/package.json', import.meta.url),
)
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const WebSocket = require('ws') as any

test('supportedCrealityActions lists supported actions with public documentation', () => {
  const actions = supportedCrealityActions('K1')
  assert.ok(actions.includes('pause'))
  assert.ok(actions.includes('resume'))
  assert.ok(actions.includes('cancel'))
  assert.ok(actions.includes('set_temperature'))
  assert.ok(actions.includes('set_fan'))
  assert.ok(actions.includes('home'))
  assert.ok(actions.includes('set_light'))
  assert.equal(actions.includes('emergency_stop'), false)
  assert.equal(actions.includes('firmware_restart'), false)
})

test('buildCrealityCommand builds expected set frames and rejects invalid calls', () => {
  // Pause / resume / cancel
  assert.deepEqual(buildCrealityCommand('pause'), {
    method: 'set',
    params: { pause: 1 },
  })
  assert.deepEqual(buildCrealityCommand('resume'), {
    method: 'set',
    params: { pause: 0 },
  })
  assert.deepEqual(buildCrealityCommand('cancel'), {
    method: 'set',
    params: { stop: 1 },
  })

  // Temperatures
  assert.deepEqual(
    buildCrealityCommand('set_temperature', {
      heater: 'extruder',
      target_c: 215,
    }),
    {
      method: 'set',
      params: { nozzleTempControl: 215 },
    },
  )
  assert.deepEqual(
    buildCrealityCommand('set_temperature', { heater: 'bed', target_c: 60 }),
    {
      method: 'set',
      params: { bedTempControl: { num: 0, val: 60 } },
    },
  )
  assert.deepEqual(
    buildCrealityCommand('set_temperature', {
      heater: 'chamber',
      target_c: 45,
    }),
    {
      method: 'set',
      params: { boxTempControl: 45 },
    },
  )

  // Fan control (boolean on & percent)
  assert.deepEqual(
    buildCrealityCommand('set_fan', { fan: 'part', percent: 100 }),
    {
      method: 'set',
      params: { fan: 1 },
    },
  )
  assert.deepEqual(
    buildCrealityCommand('set_fan', { fan: 'part', on: false }),
    {
      method: 'set',
      params: { fan: 0 },
    },
  )
  assert.deepEqual(
    buildCrealityCommand('set_fan', { fan: 'aux', percent: 80 }),
    {
      method: 'set',
      params: { fanAuxiliary: 1 },
    },
  )
  assert.deepEqual(
    buildCrealityCommand('set_fan', { fan: 'chamber', percent: 0 }),
    {
      method: 'set',
      params: { fanCase: 0 },
    },
  )

  // Light control
  assert.deepEqual(buildCrealityCommand('set_light', { on: true }), {
    method: 'set',
    params: { lightSw: 1 },
  })
  assert.deepEqual(buildCrealityCommand('set_light', { on: false }), {
    method: 'set',
    params: { lightSw: 0 },
  })

  // Home axes
  assert.deepEqual(buildCrealityCommand('home', { axes: ['x', 'y'] }), {
    method: 'set',
    params: { autohome: 'X Y' },
  })
  assert.deepEqual(buildCrealityCommand('home', { axes: ['x', 'y', 'z'] }), {
    method: 'set',
    params: { autohome: 'X Y Z' },
  })
  assert.deepEqual(buildCrealityCommand('home', { axes: ['z'] }), {
    method: 'set',
    params: { autohome: 'Z' },
  })

  // Validations & rejections
  assert.throws(() => buildCrealityCommand('unknown_action', {}))
  assert.throws(() =>
    buildCrealityCommand('pause', { unexpected: 'arg' } as any),
  )
  assert.throws(() =>
    buildCrealityCommand('set_temperature', {
      heater: 'extruder',
      target_c: 350,
    }),
  )
  assert.throws(() =>
    buildCrealityCommand('set_temperature', { heater: 'bed', target_c: 150 }),
  )
  assert.throws(() =>
    buildCrealityCommand('set_temperature', {
      heater: 'chamber',
      target_c: 70,
    }),
  )
  assert.throws(() =>
    buildCrealityCommand('set_temperature', {
      heater: 'unknown' as any,
      target_c: 200,
    }),
  )
  assert.throws(() =>
    buildCrealityCommand('set_fan', { fan: 'part', percent: 150 }),
  )
  assert.throws(() =>
    buildCrealityCommand('set_fan', { fan: 'invalid' as any, percent: 50 }),
  )
  assert.throws(() => buildCrealityCommand('set_light', { on: 'yes' as any }))
  assert.throws(() => buildCrealityCommand('home', { axes: [] }))
  assert.throws(() =>
    buildCrealityCommand('home', { axes: ['x', 'invalid' as any] }),
  )
})

test(
  'Creality simulator applies commands and updates state over WebSocket 9999',
  { timeout: 5000 },
  async () => {
    const simulator = await createCrealitySimulator({
      state: 1, // printing
      nozzleTemp: 200,
      bedTemp: 50,
      printProgress: 30,
    })

    const ws = new WebSocket(`ws://127.0.0.1:${simulator.port}`)
    await new Promise<void>((resolve, reject) => {
      ws.once('open', resolve)
      ws.once('error', reject)
    })

    try {
      const commands = [
        buildCrealityCommand('pause'),
        buildCrealityCommand('set_temperature', {
          heater: 'extruder',
          target_c: 220,
        }),
        buildCrealityCommand('set_temperature', {
          heater: 'bed',
          target_c: 65,
        }),
        buildCrealityCommand('set_fan', { fan: 'part', percent: 100 }),
        buildCrealityCommand('set_fan', { fan: 'aux', on: true }),
        buildCrealityCommand('set_light', { on: true }),
        buildCrealityCommand('home', { axes: ['x', 'y'] }),
        buildCrealityCommand('resume'),
        buildCrealityCommand('cancel'),
      ]

      for (const cmd of commands) {
        ws.send(JSON.stringify(cmd))
      }

      for (
        let i = 0;
        i < 100 && simulator.requests.length < commands.length;
        i++
      ) {
        await new Promise((resolve) => setTimeout(resolve, 20))
      }

      assert.equal(simulator.requests.length, commands.length)
      assert.deepEqual(simulator.requests[0], {
        method: 'set',
        params: { pause: 1 },
      })
      assert.deepEqual(simulator.state, {
        state: 0, // after cancel
        nozzleTemp: 200,
        nozzleTemp2: 220,
        bedTemp: 50,
        bedTemp2: 65,
        printProgress: 30,
        fan: 1,
        modelFanPct: 100,
        fanAuxiliary: 1,
        auxiliaryFanPct: 100,
        lightSw: 1,
        autohome: 'X Y',
      })
    } finally {
      ws.terminate()
      await simulator.close()
    }
  },
)
