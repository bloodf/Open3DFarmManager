import { createMoonrakerDetailStream } from '../../packages/connector/src/moonraker/detail-stream.ts'
import { PrinterDetailUpdate } from '../../packages/farm-protocol/src/printer-detail.ts'
import { startMoonrakerMock } from '../../packages/sim-tools/src/mocks/moonraker-mock.ts'
import { describe, expect, it, vi } from 'vitest'
import {
  controlRoleAllowed,
  controlSourceState,
} from '../../packages/farm-protocol/src/control-actions.ts'
import { buildMoonrakerCommand } from '../../packages/connector/src/moonraker/commands.ts'
import { readSystemServices } from '../../packages/connector/src/moonraker/control-system-services.ts'

const objects = ['print_stats', 'webhooks']
describe('Moonraker system services', () => {
  it.each([
    ['klipper_restart', 'printer.restart'],
    ['firmware_restart', 'printer.firmware_restart'],
    ['moonraker_restart', 'server.restart'],
  ])('maps %s to one fixed RPC', (op, method) => {
    expect(buildMoonrakerCommand('service', { op }, objects)).toEqual({
      method,
    })
  })

  it('refuses unsafe roles, states, invalid arguments and absent capability', () => {
    expect(controlRoleAllowed('owner', 'service')).toBe(true)
    for (const role of ['admin', 'operator', 'viewer'])
      expect(controlRoleAllowed(role, 'service')).toBe(false)
    expect(controlSourceState('service', 'idle')).toBe(true)
    for (const state of ['printing', 'paused', 'unknown', 'offline'])
      expect(controlSourceState('service', state)).toBe(false)
    expect(() =>
      buildMoonrakerCommand('service', { op: 'klipper_restart' }),
    ).toThrow()
    expect(() =>
      buildMoonrakerCommand('service', { op: 'refresh' }, objects),
    ).toThrow()
    expect(() =>
      buildMoonrakerCommand(
        'service',
        { op: 'klipper_restart', refresh: true },
        objects,
      ),
    ).toThrow()
  })

  it('reads cached update status and preserves host data independently of Klippy', async () => {
    const request = vi.fn(async (method: string) => {
      switch (method) {
        case 'machine.proc_stats':
          return {
            system_cpu_usage: { cpu: 9 },
            system_memory: { used: 1024 },
            cpu_temp: 47,
          }
        case 'machine.update.status':
          return {
            version_info: { klipper: { version: 'v1', remote_version: 'v2' } },
          }
        case 'server.info':
          return { klippy_state: 'disconnected' }
        default:
          throw new Error('Unexpected RPC')
      }
    })
    expect(await readSystemServices(request)).toEqual({
      firmware: { state: 'disconnected', message: '' },
      host: { cpuLoad: 9, memoryBytes: 1048576, temperatureC: 47 },
      updates: [{ name: 'klipper', installed: 'v1', available: 'v2' }],
    })
    expect(request.mock.calls).toEqual([
      ['machine.proc_stats'],
      ['machine.update.status', { refresh: false }],
      ['server.info'],
    ])
  })
})

it('reads cached system data through the existing loopback detail stream with Klippy offline', async (t) => {
  const mock = await startMoonrakerMock({
    firmware: { klipper: { version: 'v1', remote_version: 'v2' } },
  })
  mock.control.setKlippyState('shutdown', { connected: false })
  const detail = createMoonrakerDetailStream({
    printerKey: 'sv06',
    origin: mock.origin,
    limits: {
      maxMessageBytes: 65536,
      connectTimeoutMs: 1000,
      requestTimeoutMs: 1000,
      staleAfterMs: 1000,
      reconnectMinMs: 100,
      reconnectMaxMs: 100,
    },
  })
  let stop: (() => void) | undefined
  let timeout: ReturnType<typeof setTimeout> | undefined
  t.onTestFinished(async () => {
    clearTimeout(timeout)
    stop?.()
    await mock.close()
  })
  const frame = await new Promise<ReturnType<typeof PrinterDetailUpdate.parse>>(
    (resolve, reject) => {
      timeout = setTimeout(
        () => reject(new Error('System detail timed out')),
        2500,
      )
      stop = detail.subscribe((value) => {
        const parsed = PrinterDetailUpdate.parse(value)
        if (parsed.capabilities.includes('system')) resolve(parsed)
      })
    },
  )
  expect(frame.detail.host).toMatchObject({ cpuLoad: 0, memoryBytes: 0 })
  expect(frame.detail.updates).toContainEqual({
    name: 'klipper',
    installed: 'v1',
    available: 'v2',
  })
  expect(
    mock.calls.all
      .filter(({ method }) => method.startsWith('machine.update.'))
      .map(({ method, params }) => ({ method, params })),
  ).toEqual([{ method: 'machine.update.status', params: { refresh: false } }])
})
