import { readFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'

vi.mock('nuxt/server', async () =>
  (await import('../helpers/api-v1-contract/mocks.ts')).nuxtServer(),
)
vi.mock('../../apps/farm/server/utils/integration-auth-runtime.ts', async () =>
  (await import('../helpers/api-v1-contract/mocks.ts')).authRuntime(),
)
vi.mock('../../apps/farm/server/utils/integration-jobs-runtime.ts', async () =>
  (await import('../helpers/api-v1-contract/mocks.ts')).jobsRuntime(),
)
vi.mock(
  '../../apps/farm/server/services/signalling-runtime-bootstrap.ts',
  async () =>
    (await import('../helpers/api-v1-contract/mocks.ts')).signalling(),
)

import { PrinterState } from '../../packages/farm-protocol/src/state.ts'
import { decodeBambuVersion } from '../../packages/connector/src/bambu/version.ts'
import { createBambuTransport } from '../../packages/connector/src/bambu/transport.ts'
import { startBambuSimulator } from '../../packages/sim-tools/src/bambu-simulator.ts'
import { startMoonrakerMock } from '../../packages/sim-tools/src/mocks/moonraker-mock.ts'
import type { IntegrationGrant } from '../../apps/farm/server/services/integration-apps.ts'
import type {
  IntegrationPrincipal,
  IntegrationPrinterRow,
} from '../../apps/farm/server/utils/integration-auth.ts'
import {
  getIntegrationPrinterCapabilities,
  qualifiedFirmwareByCatalogId,
} from '../../apps/farm/server/utils/integration-capabilities.ts'
import {
  listIntegrationPrinterReadiness,
  printerReadiness,
  type PrinterReadiness,
} from '../../apps/farm/server/utils/integration-printers-readiness.ts'
import type { IntegrationPrinterReader } from '../../apps/farm/server/utils/integration-printers.ts'
import { call } from '../helpers/api-v1-contract/router.ts'
import { tokenFor } from '../helpers/api-v1-contract/scenarios.ts'
import { freshWorld, ids } from '../helpers/api-v1-contract/world.ts'

const farmA = ids.farmA
const printerSv06 = 'aaaaaaaa-0000-4000-8000-0000000000a1'
const printerU1 = 'aaaaaaaa-0000-4000-8000-0000000000a2'
const printerBambu = 'aaaaaaaa-0000-4000-8000-0000000000a3'

interface RecordedIdentity {
  vendor: string
  model: string
  firmware: string
}

function recordedReport(path: string) {
  return JSON.parse(readFileSync(new URL(path, import.meta.url), 'utf8')) as {
    identity: RecordedIdentity
  }
}

const sv06Report = recordedReport(
  '../../docs/hardware-reports/2026-11-21-sovol-sv06-moonraker.json',
)
const u1Report = recordedReport(
  '../../docs/hardware-reports/2026-11-21-snapmaker-u1-moonraker.json',
)
const kobraReport = recordedReport(
  '../../docs/hardware-reports/2026-11-21-anycubic-kobra-x-native.json',
)

function grant(printerAssignmentId: string | null = null): IntegrationGrant {
  return {
    id: 'grant-' + (printerAssignmentId ?? farmA),
    appId: 'app',
    farmId: farmA,
    printerAssignmentId,
    scopes: ['printers:read'],
    requiresApproval: false,
    createdAt: 1,
    disabledAt: null,
    disabledReason: null,
  }
}

function principal(
  printerAssignmentId: string | null = null,
): IntegrationPrincipal {
  return {
    appId: 'app',
    scopes: ['printers:read'],
    grants: [grant(printerAssignmentId)],
  }
}

function observed(
  printerKey: string,
  identity: RecordedIdentity,
  kind: 'idle' | 'offline',
  firmware = identity.firmware,
) {
  const shared = {
    printerKey,
    observedAt: Date.now(),
    identity: { ...identity, firmware },
  }
  const state =
    kind === 'offline'
      ? {
          ...shared,
          state: 'offline' as const,
          linkHealth: {
            state: 'offline' as const,
            lastSuccessAt: null,
            p50Ms: null,
            p95Ms: null,
            reconnects: 1,
            lastErrorCode: null,
          },
        }
      : { ...shared, state: 'idle' as const, progress: 0 }
  return PrinterState.parse(state)
}

function row(
  id: string,
  printerKey: string,
  state: PrinterState,
): IntegrationPrinterRow {
  return {
    id,
    farmId: farmA,
    printerKey,
    sandbox: false,
    state,
    observedAt: state.observedAt,
  }
}

function reader(rows: IntegrationPrinterRow[]): IntegrationPrinterReader {
  return {
    async readPrinters(input) {
      return rows
        .filter(
          (entry) =>
            input.farmWideFarmIds.includes(entry.farmId) ||
            input.assignmentIds.includes(entry.id),
        )
        .filter((entry) => !input.farmId || input.farmId === entry.farmId)
        .filter((entry) => !input.afterId || entry.id > input.afterId)
        .slice(0, input.limit)
    },
    async readPrinter(id) {
      return rows.find((entry) => entry.id === id) ?? null
    },
  }
}

function readinessFor(
  page: { data?: PrinterReadiness[]; error?: string },
  id: string,
) {
  if (page.error || !page.data)
    throw new Error(page.error ?? 'no readiness page')
  const item = page.data.find((entry) => entry.printerId === id)
  expect(item).toBeDefined()
  return item!
}

describe('printer readiness and qualified capabilities', () => {
  it('rejects a qualified Moonraker observation older than 60 seconds', () => {
    const state = observed('sv06', sv06Report.identity, 'idle')
    state.observedAt = Date.now() - 72 * 60 * 60 * 1000
    const result = printerReadiness(row(printerSv06, 'sv06', state))
    expect(result).toMatchObject({
      eligible: false,
      degradedReason: 'stale',
      observedAt: state.observedAt,
    })
  })

  it('keeps recorded SV06 and U1 firmware as the qualified set', () => {
    expect(qualifiedFirmwareByCatalogId['klipper-generic-moonraker']).toEqual([
      sv06Report.identity.firmware,
      u1Report.identity.firmware,
    ])
    expect(qualifiedFirmwareByCatalogId['anycubic-kobra-x']).toEqual([
      kobraReport.identity.firmware,
    ])
  })

  it('treats recorded SV06 and U1 observations as eligible monitoring', async () => {
    const sv06 = await startMoonrakerMock({ profile: 'sv06' })
    const u1 = await startMoonrakerMock({ profile: 'u1' })
    try {
      const sv06Info = (
        await (await fetch(sv06.origin + '/server/info')).json()
      ).result as { moonraker_version: string; klippy_state: string }
      const u1Info = (await (await fetch(u1.origin + '/printer/info')).json())
        .result as { hostname: string; state: string }
      const sv06Host = (
        await (await fetch(sv06.origin + '/printer/info')).json()
      ).result as { hostname: string }
      expect(sv06Info.klippy_state).toBe('ready')
      expect(sv06Info.moonraker_version).toBe('v0.9.3-mock')
      expect(sv06Host.hostname).toBe('sv06-mock')
      expect(u1Info.hostname).toBe('u1-mock')
      expect(u1Info.state).toBe('ready')

      const rows = [
        row(printerSv06, 'sv06', observed('sv06', sv06Report.identity, 'idle')),
        row(printerU1, 'u1', observed('u1', u1Report.identity, 'idle')),
        row(
          printerBambu,
          'sv06-mock-firmware',
          observed(
            'sv06-mock-firmware',
            sv06Report.identity,
            'idle',
            sv06Info.moonraker_version,
          ),
        ),
      ]
      const page = await listIntegrationPrinterReadiness(
        principal(),
        reader(rows),
        new URLSearchParams(),
      )
      expect('data' in page).toBe(true)
      if (!('data' in page)) return
      const readySv06 = readinessFor(page, printerSv06)
      const readyU1 = readinessFor(page, printerU1)
      expect(readySv06).toMatchObject({
        paired: true,
        eligible: true,
        degradedReason: null,
        observedAt: rows[0]!.observedAt,
        setupPath: `/impressoras/sv06?farm=${farmA}`,
      })
      expect(readyU1).toMatchObject({
        paired: true,
        eligible: true,
        degradedReason: null,
        setupPath: `/impressoras/u1?farm=${farmA}`,
      })
      const sv06Caps = await getIntegrationPrinterCapabilities(
        principal(),
        reader(rows),
        printerSv06,
      )
      const u1Caps = await getIntegrationPrinterCapabilities(
        principal(),
        reader(rows),
        printerU1,
      )
      const mockCaps = await getIntegrationPrinterCapabilities(
        principal(),
        reader(rows),
        printerBambu,
      )
      expect(sv06Caps).toMatchObject({
        operation: 'monitoring-only',
        catalogId: 'klipper-generic-moonraker',
      })
      expect(u1Caps).toMatchObject({
        operation: 'monitoring-only',
        catalogId: 'klipper-generic-moonraker',
      })
      expect(
        'evidenceRevision' in sv06Caps && sv06Caps.evidenceRevision,
      ).toMatch(/^[a-f0-9]{64}$/)
      expect(
        'evidenceRevision' in sv06Caps &&
          'evidenceRevision' in u1Caps &&
          sv06Caps.evidenceRevision,
      ).toBe('evidenceRevision' in u1Caps && u1Caps.evidenceRevision)
      expect(mockCaps).toMatchObject({
        operation: 'unknown-firmware',
        catalogId: 'klipper-generic-moonraker',
      })
      expect(readinessFor(page, printerBambu).eligible).toBe(false)
      for (const body of [readySv06, sv06Caps, u1Caps, mockCaps]) {
        expect(JSON.stringify(body)).not.toMatch(
          /buildVolume|nozzles|spoolSlots|specifications/,
        )
      }
    } finally {
      await sv06.close()
      await u1.close()
    }
  })

  it('reports an unknown printer state as ineligible and temporarily unavailable', async () => {
    const state = PrinterState.parse({
      printerKey: 'sv06',
      observedAt: Date.now(),
      identity: sv06Report.identity,
      state: 'unknown',
      progress: 0,
    })
    const rows = [row(printerSv06, 'sv06', state)]
    const page = await listIntegrationPrinterReadiness(
      principal(),
      reader(rows),
      new URLSearchParams(),
    )
    if (!('data' in page)) throw new Error('expected a readiness page')
    expect(readinessFor(page, printerSv06)).toMatchObject({
      paired: true,
      eligible: false,
      degradedReason: 'unknown-state',
    })
    await expect(
      getIntegrationPrinterCapabilities(principal(), reader(rows), printerSv06),
    ).resolves.toMatchObject({
      operation: 'temporarily-unavailable',
      catalogId: 'klipper-generic-moonraker',
    })
  })

  it('reports a disconnected SV06 mock as degraded and temporarily unavailable', async () => {
    const sv06 = await startMoonrakerMock({ profile: 'sv06' })
    try {
      sv06.control.setKlippyState('disconnected')
      const info = (await (await fetch(sv06.origin + '/server/info')).json())
        .result as { klippy_connected: boolean; klippy_state: string }
      expect(info.klippy_connected).toBe(false)
      expect(info.klippy_state).toBe('disconnected')
      const rows = [
        row(
          printerSv06,
          'sv06',
          observed('sv06', sv06Report.identity, 'offline'),
        ),
      ]
      const page = await listIntegrationPrinterReadiness(
        principal(),
        reader(rows),
        new URLSearchParams(),
      )
      if (!('data' in page)) throw new Error('expected a readiness page')
      expect(readinessFor(page, printerSv06)).toMatchObject({
        paired: true,
        eligible: false,
        degradedReason: 'offline',
      })
      await expect(
        getIntegrationPrinterCapabilities(
          principal(),
          reader(rows),
          printerSv06,
        ),
      ).resolves.toMatchObject({
        operation: 'temporarily-unavailable',
        catalogId: 'klipper-generic-moonraker',
      })
    } finally {
      await sv06.close()
    }
  })

  it('leaves a Bambu simulator model unqualified', async () => {
    const modules: { name: string; sw_ver: string; product_name: string }[] = [
      { name: 'ota', sw_ver: '01.08.02.00', product_name: 'P2S' },
    ]
    const sim = await startBambuSimulator({
      initialState: 'IDLE',
      versionModules: modules,
      reportIntervalMs: 60_000,
    })
    const abort = new AbortController()
    let closeTransport: (() => Promise<void>) | undefined
    try {
      const version = await new Promise<ReturnType<typeof decodeBambuVersion>>(
        (resolve, reject) => {
          const timer = setTimeout(
            () => reject(new Error('Bambu simulator sent no version')),
            8000,
          )
          const transport = createBambuTransport({
            host: sim.host,
            port: sim.port,
            serial: 'SYNTHETIC',
            credentials: { username: 'bblp', password: 'secret' },
            caPem: sim.syntheticTrust,
            limits: {
              maxFrameBytes: 65536,
              connectTimeoutMs: 3000,
              maxInflight: 4,
              reconnectDelayMs: 50,
              maxReconnects: 2,
            },
            signal: abort.signal,
            onConnection() {},
            onReport(payload) {
              const text = payload.toString('utf8')
              if (!text.includes('get_version')) return
              clearTimeout(timer)
              resolve(decodeBambuVersion(text))
            },
          })
          closeTransport = () => transport.close()
        },
      )
      expect(version?.model).toBe('P2S')
      expect(sim.queries.some((query) => query.command === 'get_version')).toBe(
        true,
      )
      const state = observed(
        'bambu-p2s',
        {
          vendor: 'bambu',
          model: version!.model!,
          firmware: version!.firmware ?? '01.08.02.00',
        },
        'idle',
      )
      const rows = [row(printerBambu, 'bambu-p2s', state)]
      const caps = await getIntegrationPrinterCapabilities(
        principal(),
        reader(rows),
        printerBambu,
      )
      expect(caps).toMatchObject({
        operation: 'unqualified',
        catalogId: 'bambu-p2s',
      })
      expect('evidenceRevision' in caps && caps.evidenceRevision).toMatch(
        /^[a-f0-9]{64}$/,
      )
      const page = await listIntegrationPrinterReadiness(
        principal(),
        reader(rows),
        new URLSearchParams(),
      )
      if (!('data' in page)) throw new Error('expected a readiness page')
      expect(readinessFor(page, printerBambu)).toMatchObject({
        paired: true,
        eligible: false,
        degradedReason: null,
        setupPath: `/impressoras/bambu-p2s?farm=${farmA}`,
      })
      expect(JSON.stringify(caps)).not.toMatch(
        /buildVolume|nozzles|spoolSlots|specifications/,
      )
    } finally {
      abort.abort()
      await closeTransport?.()
      await sim.close()
    }
  })

  it('answers an out-of-grant printer with 404', async () => {
    const world = freshWorld()
    const app = world.addApp([
      { scopes: ['printers:read'], printerId: ids.printerA1 },
    ])
    const token = await tokenFor(world, app)
    const denied = await call({
      method: 'GET',
      path: `/printers/${ids.printerA2}/capabilities`,
      token,
    })
    expect(denied.status).toBe(404)
    expect(denied.json).toMatchObject({ code: 'not-found' })
    expect(denied.text).not.toContain(ids.printerA2)

    const hidden = await getIntegrationPrinterCapabilities(
      principal(printerSv06),
      reader([row(printerU1, 'u1', observed('u1', u1Report.identity, 'idle'))]),
      printerU1,
    )
    expect(hidden).toEqual({ error: 'not-found' })
  })
})
