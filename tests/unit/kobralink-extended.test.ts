import type { KobraLinkBridgeCommand } from '../../packages/connector/src/kobralink/bridge-control.ts'
import { describe, expect, it } from 'vitest'
import { createKobraLinkClient } from '../../packages/connector/src/kobralink/client.ts'
import type { KobraLinkExtendedCommand } from '../../packages/connector/src/kobralink/extended-control.ts'
import { createControlFixture } from '../fixtures/kobralink-integration/control.ts'

async function ready() {
  const fixture = createControlFixture()
  fixture.state.printState = 'standby'
  const origin = 'http://127.0.0.1:7100'
  const client = createKobraLinkClient({
    origin,
    allowedOrigins: [origin],
    fetch: fixture.fetch,
  })
  await client.authenticate({
    ownership: 'fresh_owned',
    mode: 'signin',
    name: 'Connector',
    email: 'c@example.test',
    password: 'synthetic-password',
  })
  return { ...fixture, client }
}
const cases: {
  command: KobraLinkExtendedCommand
  path: string
  body: unknown
}[] = [
  {
    command: {
      action: 'set_temperature',
      args: { heater: 'extruder', target_c: 320 },
    },
    path: 'temperature',
    body: { nozzle: 320 },
  },
  {
    command: {
      action: 'set_temperature',
      args: { heater: 'bed', target_c: 0 },
    },
    path: 'temperature',
    body: { bed: 0 },
  },
  {
    command: { action: 'set_fan', args: { fan: 'part', percent: 100 } },
    path: 'fan',
    body: { speed: 100 },
  },
  {
    command: { action: 'set_light', args: { on: false } },
    path: 'light',
    body: { on: false },
  },
  ...(['silent', 'standard', 'sport'] as const).map((level, i) => ({
    command: { action: 'set_speed' as const, args: { level } },
    path: 'speed',
    body: { mode: i + 1 },
  })),
  {
    command: { action: 'home', args: { axes: ['z', 'x', 'y'] } },
    path: 'axis',
    body: { axis: 4, moveType: 2, distance: 0 },
  },
  {
    command: { action: 'start_print', args: { file: 'part.gcode' } },
    path: 'printer-files/print',
    body: { filename: 'part.gcode', sizeBytes: 0 },
  },
]
describe('pinned KobraLink extended control', () => {
  it.each(cases)(
    'maps $command to the pinned wire contract',
    async ({ command, path, body }) => {
      const f = await ready()
      expect(
        await f.client.controlExtendedPrinter('printer-1', command),
      ).toEqual({ accepted: true, confirmed: false })
      expect(f.extended).toEqual([
        { path: `/api/v1/printers/printer-1/${path}`, body },
      ])
    },
  )
  it('advertises exactly the executable protocol actions', async () => {
    const f = await ready()
    expect(f.client.supportedControls).toEqual([
      'pause',
      'resume',
      'cancel',
      'set_temperature',
      'set_fan',
      'set_light',
      'set_speed',
      'home',
      'start_print',
    ])
    expect(Object.isFrozen(f.client.supportedControls)).toBe(true)
  })
  it('homes only the requested partial axes in order', async () => {
    const f = await ready()
    await f.client.controlExtendedPrinter('printer-1', {
      action: 'home',
      args: { axes: ['z', 'x'] },
    })
    expect(f.extended).toEqual(
      [3, 1].map((axis) => ({
        path: '/api/v1/printers/printer-1/axis',
        body: { axis, moveType: 2, distance: 0 },
      })),
    )
  })
  it.each([
    { action: 'set_temperature', args: { heater: 'chamber', target_c: 30 } },
    { action: 'set_temperature', args: { heater: 'bed', target_c: 121 } },
    { action: 'set_temperature', args: { heater: 'extruder', target_c: 321 } },
    { action: 'set_temperature', args: { heater: 'extruder', target_c: -1 } },
    { action: 'set_fan', args: { fan: 'aux', percent: 50 } },
    { action: 'set_fan', args: { fan: 'part', percent: 101 } },
    { action: 'set_light', args: { on: true, endpoint: '/other' } },
    { action: 'set_speed', args: { level: 'ludicrous' } },
    { action: 'home', args: { axes: ['x', 'x'] } },
    { action: 'home', args: { axes: [] } },
    { action: 'start_print', args: { file: '../secret' } },
    { action: 'firmware_restart', args: {} },
    { action: 'emergency_stop', args: {} },
  ])(
    'rejects unsupported or invalid command %j before transport',
    async (input) => {
      const f = await ready()
      // Exercise an untyped boundary without weakening the production signature.
      await expect(
        Reflect.apply(f.client.controlExtendedPrinter, f.client, [
          'printer-1',
          input,
        ]),
      ).rejects.toMatchObject({ code: 'invalid' })
      expect(f.extended).toEqual([])
    },
  )
  it.each(['printing', 'paused', 'pausing', 'unknown', 'error'])(
    'blocks home and start while %s',
    async (state) => {
      const f = await ready()
      f.state.printState = state
      for (const command of [
        { action: 'home', args: { axes: ['x'] } },
        { action: 'start_print', args: { file: 'part.gcode' } },
      ] satisfies KobraLinkExtendedCommand[]) {
        await expect(
          f.client.controlExtendedPrinter('printer-1', command),
        ).rejects.toMatchObject({ code: 'unsupported_state' })
      }
      expect(f.extended).toEqual([])
    },
  )
  it.each([400, 401, 403, 502, 503])(
    'does not retry or disclose credentials on HTTP %s',
    async (status) => {
      const f = await ready()
      f.state.status = status
      const command = {
        action: 'home',
        args: { axes: ['x', 'z'] },
      } satisfies KobraLinkExtendedCommand
      try {
        await f.client.controlExtendedPrinter('printer-1', command)
        expect.fail('must reject')
      } catch (error) {
        expect(error).toMatchObject({
          code:
            status === 400
              ? 'invalid'
              : status === 401 || status === 403
                ? 'unauthorized'
                : 'unavailable',
        })
        expect(String(error)).not.toContain(f.token)
        expect(JSON.stringify(error)).not.toContain(f.token)
      }
      expect(f.extended).toHaveLength(1)
    },
  )
  it('rejects invalid IDs, stale observations, disconnects and changed identity without writes', async () => {
    const f = await ready()
    const command = {
      action: 'set_light',
      args: { on: true },
    } satisfies KobraLinkExtendedCommand
    await expect(
      f.client.controlExtendedPrinter('../other', command),
    ).rejects.toMatchObject({ code: 'invalid' })
    f.state.updatedAt = 0
    await expect(
      f.client.controlExtendedPrinter('printer-1', command),
    ).rejects.toMatchObject({ code: 'unavailable' })
    f.state.updatedAt = Date.now()
    f.state.connected = false
    await expect(
      f.client.controlExtendedPrinter('printer-1', command),
    ).rejects.toMatchObject({ code: 'unavailable' })
    f.state.connected = true
    f.state.deviceId = 'other'
    await expect(
      f.client.controlExtendedPrinter('printer-1', command),
    ).rejects.toMatchObject({ code: 'identity_changed' })
    expect(f.extended).toEqual([])
  })
  it('rejects malformed acceptance and stops a partial home', async () => {
    const f = await ready()
    f.state.malformed = true
    await expect(
      f.client.controlExtendedPrinter('printer-1', {
        action: 'home',
        args: { axes: ['x', 'z'] },
      }),
    ).rejects.toMatchObject({ code: 'invalid' })
    expect(f.extended).toHaveLength(1)
  })
})

const bridgeCases: {
  command: KobraLinkBridgeCommand
  path: string
  body: unknown
}[] = [
  {
    command: { action: 'temperature', args: { nozzle: 215.5, bed: 60 } },
    path: 'temperature',
    body: { nozzle: 215.5, bed: 60 },
  },
  {
    command: { action: 'fan', args: { speed: 0 } },
    path: 'fan',
    body: { speed: 0 },
  },
  {
    command: { action: 'light', args: { on: true, brightness: 35 } },
    path: 'light',
    body: { on: true, brightness: 35 },
  },
  {
    command: { action: 'speed', args: { mode: 3 } },
    path: 'speed',
    body: { mode: 3 },
  },
  {
    command: { action: 'axis', args: { axis: 1, moveType: 0, distance: 10 } },
    path: 'axis',
    body: { axis: 1, moveType: 0, distance: 10 },
  },
  { command: { action: 'axis_off', args: {} }, path: 'axis/off', body: {} },
  {
    command: {
      action: 'ams_slot',
      args: { index: 19, type: ' pla ', color: [0, 128, 255] },
    },
    path: 'ams/slot',
    body: { index: 19, type: 'PLA', color: [0, 128, 255] },
  },
  {
    command: { action: 'ams_feed', args: { slotIndex: 0, type: 1 } },
    path: 'ams/feed',
    body: { slotIndex: 0, type: 1 },
  },
  {
    command: { action: 'ace_auto_feed', args: { aceId: 3, on: false } },
    path: 'ace/auto-feed',
    body: { aceId: 3, on: false },
  },
  {
    command: { action: 'ace_dry', args: { action: 'start' } },
    path: 'ace/dry',
    body: { action: 'start', targetTemp: 45, duration: 240 },
  },
  {
    command: {
      action: 'ace_dry',
      args: { action: 'stop', aceId: 0, targetTemp: 80, duration: 1440 },
    },
    path: 'ace/dry',
    body: { action: 'stop', aceId: 0, targetTemp: 80, duration: 1440 },
  },
]
describe('native KobraLink bridge controls', () => {
  it.each(bridgeCases)(
    'maps $command to the pinned native contract',
    async ({ command, path, body }) => {
      const f = await ready()
      expect(await f.client.controlBridgePrinter('printer-1', command)).toEqual(
        { accepted: true, confirmed: false },
      )
      expect(f.extended).toEqual([
        { path: `/api/v1/printers/printer-1/${path}`, body },
      ])
    },
  )
  it('advertises only the native controls covered by wire-contract cases', async () => {
    const f = await ready()
    expect(f.client.supportedBridgeControls).toEqual([
      'temperature',
      'fan',
      'light',
      'speed',
      'axis',
      'axis_off',
      'ams_slot',
      'ams_feed',
      'ace_auto_feed',
      'ace_dry',
    ])
    expect(new Set(bridgeCases.map((c) => c.command.action))).toEqual(
      new Set(f.client.supportedBridgeControls),
    )
  })
  it.each([
    { action: 'temperature', args: {} },
    { action: 'temperature', args: { nozzle: Infinity } },
    { action: 'light', args: { on: true, brightness: 101 } },
    { action: 'speed', args: { mode: 4 } },
    { action: 'axis', args: { axis: 5, moveType: 0 } },
    { action: 'axis', args: { axis: 1, moveType: 3 } },
    { action: 'axis', args: { axis: 1, moveType: 0, distance: -1 } },
    { action: 'axis_off', args: { extra: true } },
    { action: 'ams_slot', args: { index: 20, type: 'PLA', color: [0, 0, 0] } },
    { action: 'ams_slot', args: { index: 0, type: ' ', color: [0, 0, 0] } },
    { action: 'ams_slot', args: { index: 0, type: 'PLA', color: [0, 0, 256] } },
    { action: 'ams_feed', args: { slotIndex: 0, type: 3 } },
    { action: 'ace_auto_feed', args: { aceId: 4, on: true } },
    { action: 'ace_dry', args: { action: 'start', targetTemp: 81 } },
    { action: 'ace_dry', args: { action: 'start', duration: 9 } },
    { action: 'arbitrary', args: {} },
  ])('rejects invalid native command %j', async (input) => {
    const f = await ready()
    await expect(
      Reflect.apply(f.client.controlBridgePrinter, f.client, [
        'printer-1',
        input,
      ]),
    ).rejects.toMatchObject({ code: 'invalid' })
    expect(f.extended).toEqual([])
  })
  it.each(['printing', 'paused', 'pausing'])(
    'blocks motion, motors and filament feed while %s',
    async (state) => {
      const f = await ready()
      f.state.printState = state
      for (const command of [
        { action: 'axis', args: { axis: 1, moveType: 0, distance: 10 } },
        { action: 'axis_off', args: {} },
        { action: 'ams_feed', args: { slotIndex: 0, type: 2 } },
      ] satisfies KobraLinkBridgeCommand[]) {
        await expect(
          f.client.controlBridgePrinter('printer-1', command),
        ).rejects.toMatchObject({ code: 'unsupported_state' })
      }
      expect(f.extended).toEqual([])
    },
  )
  it('rechecks identity between partial home writes', async () => {
    const fixture = createControlFixture()
    fixture.state.printState = 'standby'
    const origin = 'http://127.0.0.1:7100'
    const client = createKobraLinkClient({
      origin,
      allowedOrigins: [origin],
      fetch: async (url, init) => {
        const result = await fixture.fetch(url, init)
        if (fixture.extended.length === 1) fixture.state.deviceId = 'changed'
        return result
      },
    })
    await client.authenticate({
      ownership: 'fresh_owned',
      mode: 'signin',
      name: 'Connector',
      email: 'c@example.test',
      password: 'synthetic-password',
    })
    await expect(
      client.controlExtendedPrinter('printer-1', {
        action: 'home',
        args: { axes: ['x', 'y'] },
      }),
    ).rejects.toMatchObject({ code: 'identity_changed' })
    expect(fixture.extended).toHaveLength(1)
  })
})
