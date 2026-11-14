import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createMoonrakerSocket } from '../../packages/connector/src/moonraker/socket.ts'
import {
  buildMoonrakerCommand,
  supportedMoonrakerActions,
} from '../../packages/connector/src/moonraker/commands.ts'
import { pauseFixture } from '../../packages/connector/test/moonraker-pause-fixture.ts'

const limits = {
  maxMessageBytes: 4096,
  connectTimeoutMs: 1000,
  requestTimeoutMs: 1000,
  staleAfterMs: 1000,
  reconnectMinMs: 100,
  reconnectMaxMs: 1000,
}

test('supportedMoonrakerActions identifies capabilities from printer.objects.list', () => {
  // Empty or default objects
  const defaultActions = supportedMoonrakerActions([])
  assert.ok(defaultActions.includes('pause'))
  assert.ok(defaultActions.includes('resume'))
  assert.ok(defaultActions.includes('cancel'))
  assert.ok(defaultActions.includes('emergency_stop'))
  assert.ok(defaultActions.includes('home'))
  assert.ok(defaultActions.includes('set_speed'))
  assert.ok(defaultActions.includes('set_temperature'))
  assert.ok(defaultActions.includes('set_fan'))

  // Custom objects with LED and temperature_fan chamber
  const objects = [
    'extruder',
    'heater_bed',
    'temperature_fan chamber',
    'fan_generic aux',
    'output_pin caselight',
  ]
  const actions = supportedMoonrakerActions(objects)
  assert.ok(actions.includes('set_light'))
  assert.ok(actions.includes('set_temperature'))
  assert.ok(actions.includes('set_fan'))

  // Objects without any light
  const noLightObjects = ['extruder', 'heater_bed', 'fan_generic part']
  const noLightActions = supportedMoonrakerActions(noLightObjects)
  assert.equal(noLightActions.includes('set_light'), false)

  // Objects with neopixel LED
  const neopixelActions = supportedMoonrakerActions([
    'extruder',
    'neopixel sb_leds',
  ])
  assert.ok(neopixelActions.includes('set_light'))
})

test('buildMoonrakerCommand generates expected JSON-RPC calls for standard actions', () => {
  const objects = [
    'extruder',
    'heater_bed',
    'heater_generic chamber',
    'fan_generic aux',
    'fan_generic chamber',
    'output_pin caselight',
  ]

  // Pause / resume / cancel / emergency_stop
  assert.deepEqual(buildMoonrakerCommand('pause', {}, objects), {
    method: 'printer.print.pause',
  })
  assert.deepEqual(buildMoonrakerCommand('resume', {}, objects), {
    method: 'printer.print.resume',
  })
  assert.deepEqual(buildMoonrakerCommand('cancel', {}, objects), {
    method: 'printer.print.cancel',
  })
  assert.deepEqual(buildMoonrakerCommand('emergency_stop', {}, objects), {
    method: 'printer.emergency_stop',
  })

  // Home axes
  assert.deepEqual(buildMoonrakerCommand('home', {}, objects), {
    method: 'printer.gcode.script',
    params: { script: 'G28' },
  })
  assert.deepEqual(
    buildMoonrakerCommand('home', { axes: ['x', 'y'] }, objects),
    {
      method: 'printer.gcode.script',
      params: { script: 'G28 X Y' },
    },
  )
  assert.deepEqual(
    buildMoonrakerCommand('home', { axes: ['x', 'y', 'z'] }, objects),
    {
      method: 'printer.gcode.script',
      params: { script: 'G28 X Y Z' },
    },
  )

  // Speed factor (M220)
  assert.deepEqual(
    buildMoonrakerCommand('set_speed', { level: 'sport' }, objects),
    {
      method: 'printer.gcode.script',
      params: { script: 'M220 S124' },
    },
  )
  assert.deepEqual(
    buildMoonrakerCommand('set_speed', { percent: 150 }, objects),
    {
      method: 'printer.gcode.script',
      params: { script: 'M220 S150' },
    },
  )

  // Temperatures
  assert.deepEqual(
    buildMoonrakerCommand(
      'set_temperature',
      { heater: 'extruder', target_c: 210 },
      objects,
    ),
    {
      method: 'printer.gcode.script',
      params: { script: 'SET_HEATER_TEMPERATURE HEATER=extruder TARGET=210' },
    },
  )
  assert.deepEqual(
    buildMoonrakerCommand(
      'set_temperature',
      { heater: 'bed', target_c: 60 },
      objects,
    ),
    {
      method: 'printer.gcode.script',
      params: { script: 'SET_HEATER_TEMPERATURE HEATER=heater_bed TARGET=60' },
    },
  )
  assert.deepEqual(
    buildMoonrakerCommand(
      'set_temperature',
      { heater: 'chamber', target_c: 50 },
      objects,
    ),
    {
      method: 'printer.gcode.script',
      params: { script: 'SET_HEATER_TEMPERATURE HEATER=chamber TARGET=50' },
    },
  )

  // Temperature_fan chamber variant
  const tempFanObjects = ['extruder', 'heater_bed', 'temperature_fan chamber']
  assert.deepEqual(
    buildMoonrakerCommand(
      'set_temperature',
      { heater: 'chamber', target_c: 45 },
      tempFanObjects,
    ),
    {
      method: 'printer.gcode.script',
      params: {
        script: 'SET_TEMPERATURE_FAN_TARGET TEMPERATURE_FAN=chamber TARGET=45',
      },
    },
  )

  // Fans
  assert.deepEqual(
    buildMoonrakerCommand('set_fan', { fan: 'part', percent: 100 }, objects),
    {
      method: 'printer.gcode.script',
      params: { script: 'M106 S255' },
    },
  )
  assert.deepEqual(
    buildMoonrakerCommand('set_fan', { fan: 'part', on: false }, objects),
    {
      method: 'printer.gcode.script',
      params: { script: 'M106 S0' },
    },
  )
  assert.deepEqual(
    buildMoonrakerCommand('set_fan', { fan: 'aux', percent: 50 }, objects),
    {
      method: 'printer.gcode.script',
      params: { script: 'SET_FAN_SPEED FAN=aux SPEED=0.5' },
    },
  )

  // Light control with caselight
  assert.deepEqual(buildMoonrakerCommand('set_light', { on: true }, objects), {
    method: 'printer.gcode.script',
    params: { script: 'SET_PIN PIN=caselight VALUE=1' },
  })
  assert.deepEqual(buildMoonrakerCommand('set_light', { on: false }, objects), {
    method: 'printer.gcode.script',
    params: { script: 'SET_PIN PIN=caselight VALUE=0' },
  })

  // Light control with LED object
  const ledObjects = ['extruder', 'heater_bed', 'led case_light']
  assert.deepEqual(
    buildMoonrakerCommand('set_light', { on: true }, ledObjects),
    {
      method: 'printer.gcode.script',
      params: {
        script: 'SET_LED LED=case_light WHITE=1 SYNC=0 TRANSMIT=1',
      },
    },
  )
})

test('buildMoonrakerCommand guards against unvalidated strings and injection attempts', () => {
  const objects = ['extruder', 'heater_bed', 'output_pin caselight']

  // Unknown action
  assert.throws(() => buildMoonrakerCommand('invalid_action', {}, objects))

  // Unexpected arguments
  assert.throws(() =>
    buildMoonrakerCommand('pause', { extra: 'arg' } as any, objects),
  )

  // G-code newline / command injection in heater name
  assert.throws(() =>
    buildMoonrakerCommand(
      'set_temperature',
      { heater: 'extruder\nM112', target_c: 200 } as any,
      objects,
    ),
  )
  assert.throws(() =>
    buildMoonrakerCommand(
      'set_temperature',
      { heater: 'chamber; G28', target_c: 40 } as any,
      ['heater_generic chamber'],
    ),
  )

  // G-code injection in fan name
  assert.throws(() =>
    buildMoonrakerCommand(
      'set_fan',
      { fan: 'part\nG28', percent: 100 } as any,
      objects,
    ),
  )
  assert.throws(() =>
    buildMoonrakerCommand(
      'set_fan',
      { fan: 'aux\nM112', percent: 100 } as any,
      ['fan_generic aux'],
    ),
  )

  // G-code injection in home axes
  assert.throws(() =>
    buildMoonrakerCommand('home', { axes: ['x\nM112'] } as any, objects),
  )
  assert.throws(() =>
    buildMoonrakerCommand('home', { axes: ['x', 'x'] } as any, objects),
  )
  assert.throws(() =>
    buildMoonrakerCommand('home', { axes: [] } as any, objects),
  )

  // G-code injection in LED name
  assert.throws(() =>
    buildMoonrakerCommand('set_light', { on: true }, ['led light\nM112']),
  )

  // Exceeding temperature limits
  assert.throws(() =>
    buildMoonrakerCommand(
      'set_temperature',
      { heater: 'extruder', target_c: 350 },
      objects,
    ),
  )
  assert.throws(() =>
    buildMoonrakerCommand(
      'set_temperature',
      { heater: 'bed', target_c: 150 },
      objects,
    ),
  )
  assert.throws(() =>
    buildMoonrakerCommand(
      'set_temperature',
      { heater: 'chamber', target_c: 70 },
      ['heater_generic chamber'],
    ),
  )

  // Target temperature negative or not integer
  assert.throws(() =>
    buildMoonrakerCommand(
      'set_temperature',
      { heater: 'extruder', target_c: -5 },
      objects,
    ),
  )
  assert.throws(() =>
    buildMoonrakerCommand(
      'set_temperature',
      { heater: 'extruder', target_c: 200.5 },
      objects,
    ),
  )

  // Fan percent invalid
  assert.throws(() =>
    buildMoonrakerCommand('set_fan', { fan: 'part', percent: 150 }, objects),
  )
  assert.throws(() =>
    buildMoonrakerCommand('set_fan', { fan: 'part', percent: -10 }, objects),
  )

  // Speed level or percent invalid
  assert.throws(() =>
    buildMoonrakerCommand('set_speed', { level: 'invalid' }, objects),
  )
  assert.throws(() =>
    buildMoonrakerCommand('set_speed', { percent: 5 }, objects),
  )
  assert.throws(() =>
    buildMoonrakerCommand('set_speed', { percent: 600 }, objects),
  )

  // Missing required objects in printer objects list
  assert.throws(() =>
    buildMoonrakerCommand(
      'set_temperature',
      { heater: 'chamber', target_c: 50 },
      ['extruder', 'heater_bed'], // no chamber defined
    ),
  )
  assert.throws(
    () =>
      buildMoonrakerCommand('set_fan', { fan: 'aux', percent: 50 }, [
        'extruder',
        'heater_bed',
      ]), // no aux fan defined
  )
  assert.throws(
    () =>
      buildMoonrakerCommand('set_light', { on: true }, [
        'extruder',
        'heater_bed',
      ]), // no caselight or led defined
  )
})

test('Moonraker loopback fixture receives and executes extended commands', async () => {
  const objects = [
    'extruder',
    'heater_bed',
    'output_pin caselight',
    'fan_generic aux',
    'fan_generic chamber',
  ]
  const fixture = await pauseFixture({ objects })
  const ws = createMoonrakerSocket(fixture.origin, limits)

  await new Promise<void>((resolve, reject) => {
    ws.once('open', resolve)
    ws.once('error', reject)
  })

  try {
    let reqId = 100

    // Send printer.objects.list query
    const listReplyPromise = new Promise<any>((resolve) => {
      const handler = (data: Buffer) => {
        const msg = JSON.parse(data.toString())
        if (msg.id === reqId) {
          ws.off('message', handler)
          resolve(msg)
        }
      }
      ws.on('message', handler)
    })
    ws.send(
      JSON.stringify({
        jsonrpc: '2.0',
        id: reqId,
        method: 'printer.objects.list',
      }),
    )
    const listReply = await listReplyPromise
    assert.deepEqual(listReply.result.objects, objects)

    const supported = supportedMoonrakerActions(listReply.result.objects)
    assert.ok(supported.includes('set_temperature'))
    assert.ok(supported.includes('set_fan'))
    assert.ok(supported.includes('set_light'))
    assert.ok(supported.includes('home'))
    assert.ok(supported.includes('set_speed'))

    // Send a sequence of extended commands
    const commandsToTest = [
      buildMoonrakerCommand('home', { axes: ['x', 'y'] }, objects),
      buildMoonrakerCommand(
        'set_temperature',
        { heater: 'extruder', target_c: 215 },
        objects,
      ),
      buildMoonrakerCommand(
        'set_temperature',
        { heater: 'bed', target_c: 65 },
        objects,
      ),
      buildMoonrakerCommand('set_fan', { fan: 'part', percent: 80 }, objects),
      buildMoonrakerCommand('set_fan', { fan: 'aux', percent: 100 }, objects),
      buildMoonrakerCommand('set_light', { on: true }, objects),
      buildMoonrakerCommand('set_speed', { level: 'sport' }, objects),
    ]

    for (const cmd of commandsToTest) {
      reqId++
      const replyPromise = new Promise<any>((resolve) => {
        const handler = (data: Buffer) => {
          const msg = JSON.parse(data.toString())
          if (msg.id === reqId) {
            ws.off('message', handler)
            resolve(msg)
          }
        }
        ws.on('message', handler)
      })
      ws.send(JSON.stringify({ jsonrpc: '2.0', id: reqId, ...cmd }))
      const reply = await replyPromise
      assert.equal(reply.result, 'ok')
    }

    // Verify all G-code scripts were recorded by the fixture
    assert.deepEqual(fixture.gcodeScripts, [
      'G28 X Y',
      'SET_HEATER_TEMPERATURE HEATER=extruder TARGET=215',
      'SET_HEATER_TEMPERATURE HEATER=heater_bed TARGET=65',
      'M106 S204',
      'SET_FAN_SPEED FAN=aux SPEED=1',
      'SET_PIN PIN=caselight VALUE=1',
      'M220 S124',
    ])

    // Test emergency stop
    reqId++
    const estopPromise = new Promise<any>((resolve) => {
      const handler = (data: Buffer) => {
        const msg = JSON.parse(data.toString())
        if (msg.id === reqId) {
          ws.off('message', handler)
          resolve(msg)
        }
      }
      ws.on('message', handler)
    })
    ws.send(
      JSON.stringify({
        jsonrpc: '2.0',
        id: reqId,
        ...buildMoonrakerCommand('emergency_stop', {}, objects),
      }),
    )
    const estopReply = await estopPromise
    assert.equal(estopReply.result, 'ok')
  } finally {
    ws.terminate()
    await fixture.close()
  }
})
