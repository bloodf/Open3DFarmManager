import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, test } from 'vitest'
import { startMoonrakerMock } from '../../packages/sim-tools/src/mocks/moonraker-mock.ts'
import { startSpoolmanMock } from '../../packages/sim-tools/src/mocks/spoolman-mock.ts'
import { collectIntoQueue } from '../../packages/connector/src/runtime/collect.ts'
import { TelemetryQueue } from '../../packages/connector/src/cloud/queue.ts'
import { parseLocalCollectorConfig } from '../../packages/connector/src/config/local.ts'
import { getIntegrationPrinterStatus } from '../../apps/farm/server/utils/integration-printers.ts'
import type { PrinterState } from '@open3dfarmmanager/farm-protocol'
import type {
  IntegrationPrincipal,
  IntegrationPrinterRow,
} from '../../apps/farm/server/utils/integration-auth.ts'

const farmId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const printerId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const closers: Array<() => Promise<void>> = []
const directories: string[] = []

afterEach(async () => {
  for (const close of closers.splice(0)) await close()
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true })
})

const principal: IntegrationPrincipal = {
  appId: 'app',
  scopes: ['printers:read'],
  grants: [
    {
      id: 'grant',
      appId: 'app',
      farmId,
      printerAssignmentId: null,
      scopes: ['printers:read'],
      requiresApproval: false,
      createdAt: 1,
      disabledAt: null,
      disabledReason: null,
    },
  ],
}

async function post(origin: string, path: string, body: unknown) {
  const response = await fetch(new URL(path, origin), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!response.ok) throw new Error(`${path} ${response.status}`)
  return response.json() as Promise<{ id: number }>
}

test('Klipper active spool reaches stored printer state and activeSpools', async () => {
  const spoolman = await startSpoolmanMock({ seeded: false })
  closers.push(() => spoolman.close())
  const pla = await post(spoolman.origin, '/api/v1/filament', {
    name: 'PLA',
    material: 'PLA',
    color_hex: 'ffffff',
    density: 1.24,
    diameter: 1.75,
    weight: 1000,
  })
  const plaSpool = await post(spoolman.origin, '/api/v1/spool', {
    filament_id: pla.id,
    initial_weight: 1000,
    remaining_weight: 1000,
  })
  expect(plaSpool.id).toBe(1)
  const petg = await post(spoolman.origin, '/api/v1/filament', {
    name: 'PETG',
    material: 'PETG',
    color_hex: '112233',
    density: 1.27,
    diameter: 1.75,
    weight: 1000,
  })
  const petgSpool = await post(spoolman.origin, '/api/v1/spool', {
    filament_id: petg.id,
    initial_weight: 1000,
    remaining_weight: 500,
  })
  expect(petgSpool.id).toBe(2)

  const moonrakerOptions: {
    spoolId: number | null
    initial: { state: 'standby' }
  } = { spoolId: 1, initial: { state: 'standby' } }
  const moonraker = await startMoonrakerMock(moonrakerOptions)
  closers.push(() => moonraker.close())

  const directory = mkdtempSync(join(tmpdir(), 'active-spools-'))
  directories.push(directory)
  const queue = new TelemetryQueue(join(directory, 'queue'), Date.now())
  const controller = new AbortController()
  const done = collectIntoQueue({
    config: parseLocalCollectorConfig({
      version: 1,
      allowedOrigins: [moonraker.origin],
      printers: [{ printerKey: 'klipper', origin: moonraker.origin }],
      spoolman: {
        origin: spoolman.origin,
        farmId: '00000000-0000-4000-8000-000000000001',
        serviceId: '00000000-0000-4000-8000-000000000002',
        limit: 200,
      },
    }),
    queue,
    signal: controller.signal,
    onDiagnostic() {},
  })

  function states() {
    return queue
      .batch(Date.now(), 1000)
      .records.flatMap((record) =>
        record.kind === 'printer-state' ? [record.state] : [],
      )
  }
  function latest() {
    return states().reduce<PrinterState | undefined>((best, state) => {
      if (!best || state.observedAt > best.observedAt) return state
      return best
    }, undefined)
  }
  async function statusFor(state: PrinterState) {
    const row: IntegrationPrinterRow = {
      id: printerId,
      farmId,
      printerKey: state.printerKey,
      sandbox: false,
      observedAt: state.observedAt,
      state,
    }
    const status = await getIntegrationPrinterStatus(
      principal,
      {
        async readPrinter(id) {
          return id === printerId ? row : null
        },
      },
      printerId,
    )
    if ('error' in status) throw new Error(status.error)
    return status
  }
  let progress = 0
  function bump() {
    progress = Math.min(0.95, Number((progress + 0.01).toFixed(2)))
    moonraker.control.update({ progress })
  }
  async function settle(predicate: () => boolean) {
    await expect.poll(predicate, { timeout: 3000 }).toBe(true)
  }

  try {
    await settle(() => latest()?.materials?.[0]?.materialType === 'PLA')
    const plaState = latest()!
    const plaStatus = await statusFor(plaState)
    expect(plaStatus.state).toBe('idle')
    expect(plaStatus.activeSpools).toEqual([
      {
        slot: 'external',
        material: 'PLA',
        colorHex: 'ffffff',
        remainingPercent: 100,
      },
    ])

    const plaAt = plaState.observedAt
    moonrakerOptions.spoolId = null
    bump()
    await settle(
      () =>
        (latest()?.observedAt ?? 0) > plaAt &&
        latest()?.materials?.length === 0,
    )
    const cleared = await statusFor(latest()!)
    expect(cleared.activeSpools).toBeUndefined()

    const clearedAt = latest()!.observedAt
    moonrakerOptions.spoolId = petgSpool.id
    bump()
    await settle(
      () =>
        (latest()?.observedAt ?? 0) > clearedAt &&
        latest()?.materials?.[0]?.materialType === 'PETG',
    )
    const changed = await statusFor(latest()!)
    expect(changed.activeSpools).toEqual([
      {
        slot: 'external',
        material: 'PETG',
        colorHex: '112233',
        remainingPercent: 50,
      },
    ])
  } finally {
    controller.abort()
    await done
    queue.close()
  }
}, 30_000)
