import { afterEach, describe, expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import type { Duplex } from 'node:stream'
import {
  startMoonrakerMock,
  type MoonrakerMockInstance,
} from '../../packages/sim-tools/src/mocks/moonraker-mock.ts'

const openMocks: MoonrakerMockInstance[] = []

afterEach(async () => {
  while (openMocks.length > 0) {
    const mock = openMocks.pop()
    await mock?.close()
  }
})

async function start(
  options?: Parameters<typeof startMoonrakerMock>[0],
): Promise<MoonrakerMockInstance> {
  const mock = await startMoonrakerMock(options)
  openMocks.push(mock)
  return mock
}

async function httpJson(
  origin: string,
  path: string,
  init: RequestInit = {},
): Promise<{ status: number; body: any }> {
  const response = await fetch(`${origin}${path}`, init)
  const text = await response.text()
  let body: unknown = null
  try {
    body = text ? JSON.parse(text) : null
  } catch {
    body = text
  }
  return { status: response.status, body }
}

function frame(opcode: number, payload: Buffer, mask = true): Buffer {
  let header: Buffer
  if (payload.length < 126) {
    header = Buffer.alloc(2)
    header[1] = payload.length
  } else if (payload.length < 65536) {
    header = Buffer.alloc(4)
    header[1] = 126
    header.writeUInt16BE(payload.length, 2)
  } else {
    header = Buffer.alloc(10)
    header[1] = 127
    header.writeBigUInt64BE(BigInt(payload.length), 2)
  }
  header[0] = 0x80 | opcode
  if (mask) header[1]! |= 0x80
  const maskKey = mask ? Buffer.from([1, 2, 3, 4]) : Buffer.alloc(0)
  const data = Buffer.from(payload)
  if (mask) {
    for (let i = 0; i < data.length; i++) data[i]! ^= maskKey[i % 4]!
  }
  return Buffer.concat([header, maskKey, data])
}

async function openWs(origin: string): Promise<{
  socket: Duplex
  rpc: (method: string, params?: unknown) => Promise<any>
  notifications: string[]
  close: () => Promise<void>
}> {
  const { connect } = await import('node:net')
  const url = new URL(origin)
  const socket = connect({ host: url.hostname, port: Number(url.port) })
  const key = Buffer.from('moonraker-mock-test-key!!').toString('base64')
  const accept = createHash('sha1')
    .update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11')
    .digest('base64')

  await new Promise<void>((resolve, reject) => {
    socket.once('error', reject)
    socket.once('connect', () => {
      socket.write(
        `GET /websocket HTTP/1.1\r\nHost: ${url.host}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n\r\n`,
      )
    })
    let buffer = Buffer.alloc(0)
    const onData = (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk])
      const idx = buffer.indexOf('\r\n\r\n')
      if (idx === -1) return
      const head = buffer.subarray(0, idx).toString('utf8')
      socket.off('data', onData)
      if (!head.includes(accept)) {
        reject(new Error(`Bad upgrade: ${head}`))
        return
      }
      resolve()
    }
    socket.on('data', onData)
  })

  let buffer = Buffer.alloc(0)
  const pending = new Map<
    number,
    { resolve: (value: any) => void; reject: (err: Error) => void }
  >()
  const notifications: string[] = []
  let nextId = 1

  socket.on('data', (chunk) => {
    buffer = Buffer.concat([buffer, chunk])
    for (;;) {
      if (buffer.length < 2) return
      const opcode = buffer[0]! & 0x0f
      const masked = (buffer[1]! & 0x80) !== 0
      let length = buffer[1]! & 0x7f
      let offset = 2
      if (length === 126) {
        if (buffer.length < 4) return
        length = buffer.readUInt16BE(2)
        offset = 4
      } else if (length === 127) {
        if (buffer.length < 10) return
        length = Number(buffer.readBigUInt64BE(2))
        offset = 10
      }
      if (buffer.length < offset + length + (masked ? 4 : 0)) return
      let payload = buffer.subarray(
        offset + (masked ? 4 : 0),
        offset + (masked ? 4 : 0) + length,
      )
      if (masked) {
        const maskKey = buffer.subarray(offset, offset + 4)
        payload = Buffer.from(payload)
        for (let i = 0; i < payload.length; i++) {
          payload[i]! ^= maskKey[i % 4]!
        }
      }
      buffer = buffer.subarray(offset + (masked ? 4 : 0) + length)
      if (opcode === 0x8) {
        socket.end()
        return
      }
      if (opcode !== 0x1) continue
      try {
        const msg = JSON.parse(payload.toString('utf8')) as {
          id?: number
          result?: unknown
          error?: { message?: string }
          method?: string
          params?: unknown
        }
        if (msg.method) {
          notifications.push(
            JSON.stringify({ method: msg.method, params: msg.params }),
          )
          continue
        }
        if (typeof msg.id === 'number' && pending.has(msg.id)) {
          const waiter = pending.get(msg.id)!
          pending.delete(msg.id)
          if (msg.error)
            waiter.reject(new Error(msg.error.message ?? 'rpc error'))
          else waiter.resolve(msg.result)
        }
      } catch {
        // ignore malformed
      }
    }
  })

  return {
    socket,
    notifications,
    rpc(method, params) {
      const id = nextId++
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject })
        const payload = Buffer.from(
          JSON.stringify({
            jsonrpc: '2.0',
            id,
            method,
            ...(params === undefined ? {} : { params }),
          }),
          'utf8',
        )
        socket.write(frame(0x1, payload))
        setTimeout(() => {
          if (pending.has(id)) {
            pending.delete(id)
            reject(new Error(`RPC timeout: ${method}`))
          }
        }, 3000)
      })
    },
    async close() {
      if (!socket.destroyed) {
        socket.write(frame(0x8, Buffer.alloc(0)))
        socket.end()
      }
      await new Promise<void>((resolve) => {
        if (socket.destroyed) resolve()
        else socket.once('close', () => resolve())
      })
    },
  }
}

describe('moonraker mock full control', () => {
  it('exposes toolhead homing/limits, heaters, fans, leds, pins, exclude_object and bed_mesh', async () => {
    const mock = await start({
      objects: [
        'webhooks',
        'toolhead',
        'exclude_object',
        'bed_mesh',
        'probe',
        'extruder',
        'heater_bed',
        'fan',
        'fan_generic aux',
        'controller_fan mcu',
        'output_pin caselight',
        'output_pin beeper',
        'led status',
        'heater_generic chamber',
      ],
      excludeObjects: [
        {
          name: 'cube',
          center: [10, 10],
          polygon: [
            [0, 0],
            [20, 0],
            [20, 20],
            [0, 20],
          ],
        },
      ],
      bedMeshProfiles: [
        {
          name: 'default',
          points: [
            [0, 0.1, 0],
            [0, 0, 0.05],
            [0.02, 0, 0],
          ],
        },
        {
          name: 'smooth',
          points: [
            [0, 0, 0],
            [0, 0, 0],
            [0, 0, 0],
          ],
        },
      ],
      activeMesh: 'default',
    })
    const ws = await openWs(mock.origin)
    const status = await ws.rpc('printer.objects.query', {
      objects: {
        toolhead: null,
        exclude_object: null,
        bed_mesh: null,
        probe: null,
        'fan_generic aux': null,
        'controller_fan mcu': null,
        'output_pin beeper': null,
        'led status': null,
        'heater_generic chamber': null,
      },
    })
    expect(status.status.toolhead.homed_axes).toBe('xyz')
    expect(status.status.toolhead.axis_minimum).toEqual([0, 0, 0])
    expect(status.status.toolhead.axis_maximum).toEqual([220, 220, 250])
    expect(status.status.exclude_object.objects[0].name).toBe('cube')
    expect(status.status.bed_mesh.profile_name).toBe('default')
    expect(status.status.probe.last_z_result).toBe(0)

    await ws.rpc('printer.gcode.script', {
      script: 'G28\nEXCLUDE_OBJECT NAME=cube',
    })
    await ws.rpc('printer.gcode.script', {
      script:
        'SET_FAN_SPEED FAN=aux SPEED=0.4\nSET_FAN_SPEED FAN=mcu SPEED=0.2\nSET_PIN PIN=beeper VALUE=1\nSET_LED LED=status RED=1 GREEN=0 BLUE=0 WHITE=0\nBED_MESH_PROFILE LOAD=smooth',
    })
    const after = await ws.rpc('printer.objects.query', {
      objects: {
        exclude_object: null,
        bed_mesh: null,
        'fan_generic aux': null,
        'controller_fan mcu': null,
        'output_pin beeper': null,
        'led status': null,
      },
    })
    expect(after.status.exclude_object.excluded_objects).toContain('cube')
    expect(after.status.bed_mesh.profile_name).toBe('smooth')
    expect(after.status['fan_generic aux'].speed).toBe(0.4)
    expect(after.status['controller_fan mcu'].speed).toBe(0.2)
    expect(after.status['output_pin beeper'].value).toBe(1)
    expect(after.status['led status'].color_data[0]).toEqual([1, 0, 0, 0])
    expect(mock.calls()['printer.gcode.script']).toBeGreaterThanOrEqual(2)
    expect(
      ws.notifications.some((n) => n.includes('notify_gcode_response')),
    ).toBe(true)
    await ws.close()
  })

  it('serves temperature_store, gcode help and notify_gcode_response', async () => {
    const mock = await start({ temperatureStoreLength: 3 })
    const store = await httpJson(mock.origin, '/server/temperature_store')
    expect(store.status).toBe(200)
    expect(store.body.result.extruder.temperatures).toHaveLength(3)
    expect(store.body.result.heater_bed.targets).toHaveLength(3)

    const ws = await openWs(mock.origin)
    const help = await ws.rpc('printer.gcode.help')
    expect(help.G28).toMatch(/Home/i)
    const httpHelp = await httpJson(mock.origin, '/printer/gcode/help')
    expect(httpHelp.body.result.M104).toBeTruthy()
    await ws.rpc('printer.gcode.script', { script: 'M117 hello' })
    expect(
      ws.notifications.some((n) => {
        const parsed = JSON.parse(n)
        return parsed.method === 'notify_gcode_response'
      }),
    ).toBe(true)
    const rpcStore = await ws.rpc('server.temperature_store')
    expect(rpcStore.extruder.temperatures).toHaveLength(3)
    await ws.close()
  })

  it('supports file delete/move/mkdir/download and config root', async () => {
    const mock = await start({
      files: [{ path: 'part.gcode', content: 'G28\n' }],
      configFiles: [{ path: 'printer.cfg', content: '[printer]\n' }],
      directories: [{ root: 'gcodes', path: 'jobs' }],
    })

    const listed = await httpJson(mock.origin, '/server/files/list?root=config')
    expect(
      listed.body.result.some(
        (f: { path: string }) => f.path === 'printer.cfg',
      ),
    ).toBe(true)

    const download = await fetch(
      `${mock.origin}/server/files/config/printer.cfg`,
    )
    expect(download.status).toBe(200)
    expect(await download.text()).toContain('[printer]')

    const mkdir = await httpJson(mock.origin, '/server/files/directory', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: 'gcodes/archive' }),
    })
    expect(mkdir.status).toBe(200)
    expect(mkdir.body.result.action).toBe('create_dir')

    const move = await httpJson(mock.origin, '/server/files/move', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        source: 'gcodes/part.gcode',
        dest: 'gcodes/archive/part.gcode',
      }),
    })
    expect(move.status).toBe(200)
    expect(move.body.result.action).toBe('move_file')

    const del = await httpJson(
      mock.origin,
      '/server/files/gcodes/archive/part.gcode',
      { method: 'DELETE' },
    )
    expect(del.status).toBe(200)

    const ws = await openWs(mock.origin)
    await ws.rpc('server.files.create_directory', { path: 'config/backups' })
    const dir = await ws.rpc('server.files.get_directory', { path: 'config' })
    expect(
      dir.dirs.some((d: { dirname: string }) => d.dirname === 'backups'),
    ).toBe(true)
    expect(mock.calls()['server.files.create_directory']).toBe(1)
    await ws.close()
  })

  it('covers history, job queue, power, timelapse, update, services, restarts and proc_stats', async () => {
    const mock = await start({
      files: [{ path: 'queued.gcode', content: 'G28\n' }],
      history: [
        {
          filename: 'old.gcode',
          status: 'completed',
          start_time: 1000,
          end_time: 1600,
          print_duration: 500,
          total_duration: 600,
          filament_used: 12,
        },
      ],
      powerDevices: [
        {
          device: 'printer',
          status: 'on',
          locked_while_printing: true,
          type: 'gpio',
        },
        { device: 'lights', status: 'off', type: 'gpio' },
      ],
      timelapse: { framecount: 3, lastframefile: 'frame.jpg' },
      restartDelayMs: 0,
    })

    const history = await httpJson(mock.origin, '/server/history/list?limit=10')
    expect(history.body.result.jobs[0].filename).toBe('old.gcode')
    const totals = await httpJson(mock.origin, '/server/history/totals')
    expect(totals.body.result.job_totals.total_jobs).toBe(1)

    const queuePost = await httpJson(mock.origin, '/server/job_queue/job', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ filenames: ['queued.gcode'] }),
    })
    expect(queuePost.body.result.queued_jobs).toHaveLength(1)
    const jobId = queuePost.body.result.queued_jobs[0].job_id as string
    await httpJson(mock.origin, '/server/job_queue/pause', { method: 'POST' })
    expect(
      (await httpJson(mock.origin, '/server/job_queue/status')).body.result
        .queue_state,
    ).toBe('paused')
    await httpJson(mock.origin, '/server/job_queue/jump', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ job_id: jobId }),
    })
    await httpJson(mock.origin, '/server/job_queue/start', { method: 'POST' })

    const devices = await httpJson(mock.origin, '/machine/device_power/devices')
    expect(devices.body.result.devices).toHaveLength(2)
    const on = await httpJson(mock.origin, '/machine/device_power/on?lights', {
      method: 'POST',
    })
    expect(on.body.result.lights).toBe('on')

    const tl = await httpJson(mock.origin, '/machine/timelapse/lastframeinfo')
    expect(tl.body.result.framecount).toBe(3)
    const rendered = await httpJson(mock.origin, '/machine/timelapse/render', {
      method: 'POST',
    })
    expect(rendered.body.result.status).toBe('success')

    const update = await httpJson(mock.origin, '/machine/update/status')
    expect(update.body.result.version_info.klipper.version).toBeTruthy()
    const proc = await httpJson(mock.origin, '/machine/proc_stats')
    expect(proc.body.result.cpu_temp).toBeGreaterThan(0)

    await httpJson(mock.origin, '/machine/services/restart', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ service: 'klipper' }),
    })
    await httpJson(mock.origin, '/printer/restart', { method: 'POST' })
    await httpJson(mock.origin, '/printer/firmware_restart', { method: 'POST' })

    const ws = await openWs(mock.origin)
    expect((await ws.rpc('server.history.totals')).job_totals.total_jobs).toBe(
      1,
    )
    expect(
      (await ws.rpc('machine.proc_stats')).websocket_connections,
    ).toBeGreaterThanOrEqual(1)
    expect(
      (await ws.rpc('machine.update.status')).version_info.moonraker,
    ).toBeTruthy()
    await ws.rpc('machine.services.restart', { service: 'moonraker' })
    expect(mock.calls()['machine.services.restart']).toBeGreaterThanOrEqual(1)
    expect(mock.calls()['HTTP POST /printer/firmware_restart']).toBe(1)
    await ws.close()
  })

  it('records writes in calls() and honors fault hooks on new endpoints', async () => {
    const mock = await start({
      files: [{ path: 'a.gcode', content: 'G28\n' }],
    })
    mock.control.faults.setFault({
      fault: { type: 'refuse', statusCode: 503, message: 'injected' },
      path: '/server/job_queue/status',
      method: 'GET',
      count: 1,
    })
    const refused = await httpJson(mock.origin, '/server/job_queue/status')
    expect(refused.status).toBe(503)

    mock.control.faults.setFault({
      fault: { type: 'refuse', code: -32000, message: 'rpc-fault' },
      path: '/websocket',
      topic: 'server.history.list',
      count: 1,
    })
    const ws = await openWs(mock.origin)
    await expect(ws.rpc('server.history.list', { limit: 1 })).rejects.toThrow(
      /rpc-fault/,
    )
    await ws.rpc('server.files.create_directory', { path: 'gcodes/w' })
    expect(mock.calls()['server.files.create_directory']).toBe(1)
    expect(
      mock.calls.all.some((c) => c.method === 'server.files.create_directory'),
    ).toBe(true)
    await ws.close()
  })

  it('starts and closes 100 times without leaked handles', async () => {
    const count = (kind: string) =>
      process.getActiveResourcesInfo().filter((name) => name === kind).length
    const beforeTcp = count('TCPWRAP')
    const beforeTimeout = count('Timeout')
    for (let i = 0; i < 100; i++) {
      const mock = await startMoonrakerMock({
        files: [{ path: 'x.gcode', content: 'G28\n' }],
        restartDelayMs: 0,
      })
      const probe = await httpJson(mock.origin, '/server/info')
      expect(probe.status).toBe(200)
      await mock.close()
    }
    expect(count('TCPWRAP')).toBe(beforeTcp)
    expect(count('Timeout')).toBeLessThanOrEqual(beforeTimeout + 2)
  })
})
