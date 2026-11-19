// SPDX-License-Identifier: MIT
import { afterEach, describe, expect, it } from 'vitest'
import {
  startMoonrakerMock,
  type MoonrakerMockInstance,
} from '../../packages/sim-tools/src/mocks/moonraker-mock.ts'

let mock: MoonrakerMockInstance
afterEach(async () => {
  await mock?.close()
})

function request(path: string, method = 'GET', params?: unknown) {
  return fetch(mock.origin + path, {
    method,
    ...(params === undefined
      ? {}
      : {
          body: JSON.stringify(params),
          headers: { 'Content-Type': 'application/json' },
        }),
  })
}

async function result(path: string, method = 'GET', params?: unknown) {
  const response = await request(path, method, params)
  const payload = await response.json()
  expect(response.ok, JSON.stringify(payload)).toBe(true)
  return payload.result
}

function post(path: string, params?: unknown) {
  return result(path, 'POST', params)
}

async function socket() {
  const ws = new WebSocket(mock.origin.replace('http:', 'ws:') + '/websocket')
  await new Promise<void>((resolve, reject) => {
    ws.addEventListener('open', () => resolve(), { once: true })
    ws.addEventListener('error', reject, { once: true })
  })
  return ws
}

describe('Moonraker full control', () => {
  it('updates objects and emits a G-code console response across transports', async () => {
    mock = await startMoonrakerMock()
    const ws = await socket()
    const messages: unknown[] = []
    ws.addEventListener('message', ({ data }) =>
      messages.push(JSON.parse(data)),
    )
    ws.send(
      JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'printer.gcode.help' }),
    )
    const script = [
      'G28',
      'G1 X25 Y30 Z1',
      'G91',
      'G1 X5',
      'G90',
      'G1 X999',
      'M104 S215',
      'M140 S60',
      'M106 S255',
      'SET_FAN_SPEED FAN=auxiliary SPEED=0.5',
      'SET_HEATER_TEMPERATURE HEATER=chamber TARGET=45',
      'SET_PIN PIN=caselight VALUE=0.4',
      'SET_LED LED=chamber RED=0.2 BLUE=0.5',
      'EXCLUDE_OBJECT_DEFINE NAME=fixture',
      'EXCLUDE_OBJECT_START NAME=fixture',
      'EXCLUDE_OBJECT',
      'EXCLUDE_OBJECT_END',
      'PROBE',
      'BED_MESH_CALIBRATE PROFILE=fixture',
      'BED_MESH_PROFILE SAVE=copy',
      'BED_MESH_CLEAR',
      'BED_MESH_PROFILE LOAD=copy',
      'BED_MESH_PROFILE REMOVE=fixture',
      'M118 ready to print',
    ].join('\n')
    expect(await post('/printer/gcode/script', { script })).toBe('ok')
    const { status } = await result('/printer/objects/query')
    expect(status).toMatchObject({
      toolhead: {
        homed_axes: 'xyz',
        position: [30, 30, 1, 0],
        axis_maximum: [220, 220, 250, 0],
      },
      extruder: { target: 215 },
      heater_bed: { target: 60 },
      fan: { speed: 1 },
      'fan_generic auxiliary': { speed: 0.5 },
      'heater_generic chamber': { target: 45 },
      'output_pin caselight': { value: 0.4 },
      'led chamber': { color_data: [[0.2, 0, 0.5, 0]] },
      exclude_object: {
        objects: [{ name: 'fixture' }],
        excluded_objects: ['fixture'],
        current_object: null,
      },
      probe: { last_z_result: 0.125 },
      bed_mesh: {
        profile_name: 'copy',
        mesh_matrix: [
          [0, 0.125],
          [0.125, 0],
        ],
      },
    })
    expect(Object.keys(status.bed_mesh.profiles)).toEqual(['copy'])
    expect(await result('/server/temperature_store')).toMatchObject({
      extruder: { temperatures: [20, 20], targets: [0, 215], powers: [0, 0.5] },
    })
    expect(await result('/printer/gcode/help')).toMatchObject({
      G28: 'Home axes',
    })
    expect(await result('/server/gcode_store?count=1')).toEqual({
      gcode_store: [
        {
          message: 'ready to print',
          type: 'response',
          time: expect.any(Number),
        },
      ],
    })
    await expect
      .poll(() => messages)
      .toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            id: 1,
            result: expect.objectContaining({ G28: 'Home axes' }),
          }),
          {
            jsonrpc: '2.0',
            method: 'notify_gcode_response',
            params: ['ready to print'],
          },
          {
            jsonrpc: '2.0',
            method: 'notify_gcode_response',
            params: ['!! Move out of range'],
          },
        ]),
      )
    expect(mock.calls()).toMatchObject({ 'HTTP POST /printer/gcode/script': 1 })
  })

  it('creates directories, moves between roots, downloads and deletes files', async () => {
    mock = await startMoonrakerMock({
      files: [{ path: 'fixture.gcode', content: 'G28' }],
    })
    expect(await result('/server/files/roots')).toEqual([
      { name: 'gcodes', path: '/gcodes', permissions: 'rw' },
      { name: 'config', path: '/config', permissions: 'rw' },
    ])
    expect(
      await post('/server/files/directory', { path: 'config/test' }),
    ).toEqual({
      item: { root: 'config', path: 'test' },
      action: 'create_dir',
    })
    expect(await result('/server/files/directory?path=config')).toMatchObject({
      dirs: [{ dirname: 'test' }],
    })
    expect(
      await post('/server/files/move', {
        source: 'gcodes/fixture.gcode',
        dest: 'config/test/printer.cfg',
      }),
    ).toMatchObject({ action: 'move_file' })
    expect(
      await result('/server/files/directory?path=config/test'),
    ).toMatchObject({ files: [{ filename: 'printer.cfg' }] })
    expect(
      await (await request('/server/files/config/test/printer.cfg')).text(),
    ).toBe('G28')
    expect(
      await result('/server/files/config/test/printer.cfg', 'DELETE'),
    ).toMatchObject({ action: 'delete_file' })
    expect(
      (await request('/server/files/config/test/printer.cfg')).status,
    ).toBe(404)
    expect(
      await result('/server/files/directory?path=config/test', 'DELETE'),
    ).toMatchObject({ action: 'delete_dir' })
    const form = new FormData()
    form.set('root', 'config')
    form.set('file', new Blob(['[printer]']), 'printer.cfg')
    expect(
      (
        await fetch(mock.origin + '/server/files/upload', {
          method: 'POST',
          body: form,
        })
      ).status,
    ).toBe(201)
    expect(
      await (await request('/server/files/config/printer.cfg')).text(),
    ).toBe('[printer]')
    expect(await result('/server/files/list')).toEqual([])
    expect(await result('/server/files/list?root=config')).toMatchObject([
      { path: 'printer.cfg' },
    ])
    expect(mock.calls.all.map(({ method }) => method)).toEqual(
      expect.arrayContaining([
        'HTTP POST /server/files/directory',
        'HTTP POST /server/files/move',
        'HTTP DELETE /server/files/config/test/printer.cfg',
        'HTTP POST /server/files/upload',
      ]),
    )
  })

  it('records print history and manages the queue', async () => {
    mock = await startMoonrakerMock()
    await post('/printer/print/start', { filename: 'fixture.gcode' })
    mock.control.update({ printDuration: 12, totalDuration: 15 })
    mock.control.completePrint()
    const job = {
      job_id: '000001',
      filename: 'fixture.gcode',
      status: 'completed',
      print_duration: 12,
      total_duration: 15,
    }
    expect(await result('/server/history/list')).toMatchObject({
      count: 1,
      jobs: [job],
    })
    expect(await result('/server/history/job?uid=000001')).toMatchObject({
      job,
    })
    expect(await result('/server/history/totals')).toMatchObject({
      job_totals: { total_jobs: 1, total_time: 15, total_print_time: 12 },
    })
    expect(await result('/server/history/job?uid=000001', 'DELETE')).toEqual({
      deleted_jobs: ['000001'],
    })
    expect(await result('/server/history/list')).toEqual({ count: 0, jobs: [] })
    expect(
      await post('/server/job_queue/job', {
        filenames: ['one.gcode', 'two.gcode'],
      }),
    ).toMatchObject({
      queued_jobs: [
        { job_id: '1', filename: 'one.gcode' },
        { job_id: '2', filename: 'two.gcode' },
      ],
    })
    expect(await post('/server/job_queue/jump', { job_id: '2' })).toMatchObject(
      { queued_jobs: [{ job_id: '2' }, { job_id: '1' }] },
    )
    expect(await post('/server/job_queue/pause')).toMatchObject({
      queue_state: 'paused',
    })
    expect(await post('/server/job_queue/start')).toMatchObject({
      queue_state: 'ready',
    })
    expect(
      await result('/server/job_queue/job?job_ids=1', 'DELETE'),
    ).toMatchObject({ queued_jobs: [{ job_id: '2' }] })
    expect(await result('/server/job_queue/status')).toMatchObject({
      queued_jobs: [{ job_id: '2' }],
      queue_state: 'ready',
    })
  })

  it('controls power, timelapse and restarts and reports fixture stats', async () => {
    mock = await startMoonrakerMock({ restartDelayMs: 0 })
    expect(await result('/machine/device_power/devices')).toMatchObject({
      devices: [{ device: 'printer', status: 'off' }],
    })
    expect(
      await post('/machine/device_power/device', {
        device: 'printer',
        action: 'on',
      }),
    ).toEqual({ device: 'printer', status: 'on' })
    expect(await result('/machine/device_power/device?device=printer')).toEqual(
      { device: 'printer', status: 'on' },
    )
    expect(await post('/machine/device_power/off?printer')).toEqual({
      printer: 'off',
    })
    expect(await post('/machine/device_power/on?printer')).toEqual({
      printer: 'on',
    })
    expect(await result('/machine/device_power/status?printer')).toEqual({
      printer: 'on',
    })
    expect(await result('/server/timelapse/settings')).toMatchObject({
      enabled: false,
    })
    expect(
      await post('/server/timelapse/settings', { enabled: true }),
    ).toMatchObject({ enabled: true })
    expect(await post('/server/timelapse/takeframe')).toEqual({ frame: 1 })
    expect(await result('/server/timelapse/lastframe')).toEqual({ frame: 1 })
    expect(await post('/server/timelapse/render')).toEqual({
      status: 'success',
      frames: 1,
    })
    expect(await post('/server/timelapse/saveframes')).toEqual({ frames: 1 })
    expect(await result('/machine/update/status')).toMatchObject({
      version_info: { klipper: {}, moonraker: {} },
    })
    expect(await result('/machine/proc_stats')).toMatchObject({
      websocket_connections: 0,
      system_cpu_usage: { cpu: 0 },
    })
    for (const [path, params] of [
      ['/machine/services/restart', { service: 'klipper' }],
      ['/printer/restart', undefined],
      ['/printer/firmware_restart', undefined],
    ] as const) {
      mock.control.setKlippyState('shutdown')
      expect(await post(path, params)).toBe('ok')
      expect(mock.control.model().klippyState).toBe('ready')
      expect(mock.calls()['HTTP POST ' + path]).toBe(1)
    }
  })

  it.each(['delay', 'drop', 'refuse', 'malformed', 'stall'] as const)(
    'applies the %s fault to writes',
    async (type) => {
      mock = await startMoonrakerMock()
      const path = '/machine/device_power/device'
      mock.control.faults.setFault({
        path,
        method: 'POST',
        count: 1,
        fault: type === 'delay' ? { type, delayMs: 20 } : { type },
      })
      const before = performance.now()
      const pending = request(path, 'POST', { device: 'printer', action: 'on' })
      const response = pending.then(
        (value) => value,
        () => null,
      )
      if (type === 'delay') {
        expect((await response)?.status).toBe(200)
        expect(performance.now() - before).toBeGreaterThanOrEqual(20)
      } else if (type === 'malformed') {
        const malformed = await response
        expect(malformed?.status).toBe(999)
        expect(malformed?.statusText).toBe('GARBAGE')
        await malformed?.text()
      } else if (type === 'refuse') {
        expect((await response)?.status).toBe(503)
      } else {
        if (type === 'stall') {
          await expect.poll(() => mock.control.faults.hasFault()).toBe(false)
          const marker = Symbol('pending')
          expect(
            await Promise.race([
              response,
              request('/server/info').then(() => marker),
            ]),
          ).toBe(marker)
          await mock.close()
        }
        expect(await response).toBeNull()
      }
      if (type !== 'stall') {
        expect(await result(path)).toMatchObject({
          status: type === 'delay' ? 'on' : 'off',
        })
      }
      expect(mock.calls()['HTTP POST ' + path]).toBe(1)
    },
  )

  it('starts and closes 100 fixtures with no retained TCP or timer resources', async () => {
    const counts = () =>
      process
        .getActiveResourcesInfo()
        .filter((resource) => /TCP|Timeout/.test(resource))
        .sort()
    const baseline = counts()
    for (let iteration = 0; iteration < 100; iteration++) {
      mock = await startMoonrakerMock({ restartDelayMs: 60_000 })
      expect(new URL(mock.origin).hostname).toBe('127.0.0.1')
      const ws = await socket()
      const closed = new Promise<void>((resolve) =>
        ws.addEventListener('close', () => resolve(), { once: true }),
      )
      await post('/printer/restart')
      await mock.close()
      await closed
      expect(mock.control.sockets.size).toBe(0)
    }
    // Node releases the final TCP handles on a subsequent event-loop turn.
    await new Promise((resolve) => setImmediate(resolve))
    const remaining = counts()
    expect(remaining.filter((resource) => /TCP/.test(resource))).toEqual(
      baseline.filter((resource) => /TCP/.test(resource)),
    )
    expect(
      remaining.filter((resource) => resource === 'Timeout').length,
    ).toBeLessThanOrEqual(
      baseline.filter((resource) => resource === 'Timeout').length,
    )
  }, 15_000)
})
