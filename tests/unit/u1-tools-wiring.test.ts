import { afterEach, expect, test } from 'vitest'
import { buildMoonrakerCommand } from '../../packages/connector/src/moonraker/commands.ts'
import { moonrakerControls } from '../../packages/connector/src/moonraker/control-support.ts'
import {
  SNAPMAKER_U1_MARKER,
  SnapmakerU1CommandRefused,
  declareSnapmakerU1Printers,
  isDeclaredSnapmakerU1,
} from '../../packages/connector/src/moonraker/u1-tools.ts'
import { LocalCollectorConfigSchema } from '../../packages/connector/src/config/local.ts'

const withdrawals: (() => void)[] = []
afterEach(() => {
  for (const withdraw of withdrawals.splice(0)) withdraw()
})

const objects = ['extruder', 'extruder1', 'heater_bed', 'fan', 'print_stats']

test('only a printer configured as Snapmaker U1 is declared, until withdrawn', () => {
  const withdraw = declareSnapmakerU1Printers([
    { printerKey: 'u1', model: 'Snapmaker U1' },
    { printerKey: 'voron', model: 'Voron 2.4' },
    { printerKey: 'plain' },
  ])
  expect(isDeclaredSnapmakerU1('u1')).toBe(true)
  expect(isDeclaredSnapmakerU1('voron')).toBe(false)
  expect(isDeclaredSnapmakerU1('plain')).toBe(false)
  withdraw()
  withdraw()
  expect(isDeclaredSnapmakerU1('u1')).toBe(false)
})

test('overlapping declarations keep a printer declared until the last withdrawal', () => {
  const first = declareSnapmakerU1Printers([{ printerKey: 'u1', model: 'U1' }])
  const second = declareSnapmakerU1Printers([{ printerKey: 'u1', model: 'U1' }])
  first()
  expect(isDeclaredSnapmakerU1('u1')).toBe(true)
  second()
  expect(isDeclaredSnapmakerU1('u1')).toBe(false)
})

test('a detected U1 advertises its own capability set, not the generic one', () => {
  expect(moonrakerControls(objects)).toContain('set_temperature')
  expect(moonrakerControls([...objects, SNAPMAKER_U1_MARKER])).toEqual([])
})

test('every command built for a U1 is refused with a reason before any write', () => {
  for (const [action, reason] of [
    ['set_temperature', 'not-hardware-qualified'],
    ['pause', 'not-hardware-qualified'],
    ['set_fan', 'not-hardware-qualified'],
    ['select_tool', 'tool-command-not-implemented'],
  ] as const) {
    let refused: unknown
    try {
      buildMoonrakerCommand(action, {}, [...objects, SNAPMAKER_U1_MARKER])
    } catch (error) {
      refused = error
    }
    expect(refused).toBeInstanceOf(SnapmakerU1CommandRefused)
    expect(refused).toMatchObject({ refusal: 'unsupported-action', reason })
  }
  // Without the marker the generic builder still answers.
  expect(buildMoonrakerCommand('pause', {}, objects)).toEqual({
    method: 'printer.print.pause',
  })
})

test('the collector configuration accepts a declared model per Moonraker printer', () => {
  const parsed = LocalCollectorConfigSchema.parse({
    version: 1,
    allowedOrigins: ['http://127.0.0.1:7125'],
    printers: [
      {
        printerKey: 'u1',
        origin: 'http://127.0.0.1:7125',
        model: 'Snapmaker U1',
      },
    ],
  })
  expect(parsed.printers[0]).toMatchObject({ model: 'Snapmaker U1' })
})

test('the Moonraker driver refuses a declared U1 before detection and before any write', async () => {
  const { openFixedMoonrakerPause } =
    await import('../../packages/connector/src/moonraker/pause-driver.ts')
  const { createPrinterBindingRegistry } =
    await import('../../packages/connector/src/control/printer-binding.ts')
  // Never contacted: the refusal happens before any connection or send.
  const origin = 'http://127.0.0.1:9'
  withdrawals.push(
    declareSnapmakerU1Printers([{ printerKey: 'u1', model: 'Snapmaker U1' }]),
  )
  const binding = createPrinterBindingRegistry({
    allowedOrigins: [origin],
  }).provision({
    assignment_id: crypto.randomUUID(),
    farm_id: crypto.randomUUID(),
    agent_id: crypto.randomUUID(),
    printer_key: 'u1',
    moonraker_origin: origin,
  })
  const controller = new AbortController()
  const fixed = openFixedMoonrakerPause({
    binding,
    allowedOrigins: [origin],
    connectionGeneration: 1,
    publish: () => {},
    signal: controller.signal,
    clock: { monotonicNow: () => performance.now() },
    limits: {
      maxMessageBytes: 65536,
      connectTimeoutMs: 500,
      requestTimeoutMs: 500,
      staleAfterMs: 2000,
      reconnectMinMs: 100,
      reconnectMaxMs: 100,
    },
  })
  const beforeSend = () => true
  const request = {
    binding,
    transportId: crypto.randomUUID(),
    beforeSend,
    stillAuthorized: () => true,
    signal: controller.signal,
  }
  try {
    await expect(
      fixed.driver.execute!('set_temperature', {}, request as never),
    ).rejects.toMatchObject({
      refusal: 'unsupported-action',
      reason: 'not-hardware-qualified',
    })
    await expect(
      fixed.driver.pauseOnce({ ...request, action: 'cancel' } as never),
    ).rejects.toBeInstanceOf(SnapmakerU1CommandRefused)
  } finally {
    controller.abort()
    await fixed.close()
  }
})
