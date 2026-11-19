import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, resolve } from 'node:path'
import { build, type Plugin } from 'esbuild'
import { describe, expect, it } from 'vitest'
import { createSSRApp, type Component } from 'vue'
import { compileScript, parse } from 'vue/compiler-sfc'
import { renderToString } from 'vue/server-renderer'
import {
  deriveAlerts,
  deriveRowAlerts,
  FARM_ALERT_ORDER,
  type Clock,
  type FarmAlertKind,
} from '../../apps/farm/app/utils/farm-alerts.ts'
import {
  createFarmView,
  type FarmAdmittedSession,
  type FarmRow,
  type FarmSnapshot,
  type FarmStatusFeed,
  type FarmViewState,
} from '../../apps/farm/app/utils/farm-view.ts'

const NOW: Clock = { wall: 1_700_000_100_000, mono: 100_000 }
const FARM_ID = '00000000-0000-4000-8000-000000000001'
const AGENT_ID = '00000000-0000-4000-8000-000000000002'
const ASSIGNMENT_ID = '00000000-0000-4000-8000-000000000003'
const KEY_ID = '00000000-0000-4000-8000-000000000004'

type ObservationState = NonNullable<FarmRow['observation']>['state']

function makeRow(
  overrides: Partial<FarmRow> = {},
  stateOverrides: Partial<ObservationState> = {},
  ageMs = 1000,
): FarmRow {
  return {
    assignment: {
      assignmentId: ASSIGNMENT_ID,
      agentId: AGENT_ID,
      printerKey: 'impressora-alfa',
      status: 'active',
      connectorStatus: 'approved',
      ...overrides.assignment,
    },
    connection: overrides.connection ?? 'authenticated',
    localOrigin: overrides.localOrigin ?? null,
    observation:
      'observation' in overrides
        ? overrides.observation!
        : {
            state: {
              printerKey: overrides.assignment?.printerKey ?? 'impressora-alfa',
              state: 'idle',
              progress: 0,
              observedAt: NOW.wall - ageMs,
              ...stateOverrides,
            },
            received: { wall: NOW.wall - ageMs, mono: NOW.mono - ageMs },
            sourceClockComparable: true,
            historical: false,
          },
  }
}

const require = createRequire(import.meta.url)
const vuePlugin: Plugin = {
  name: 'vue-sfc',
  setup(builder) {
    builder.onLoad({ filter: /\.vue$/ }, ({ path }) => {
      const { descriptor, errors } = parse(readFileSync(path, 'utf8'), {
        filename: path,
      })
      if (errors.length) throw errors[0]
      return {
        contents: compileScript(descriptor, {
          id: path,
          inlineTemplate: true,
        }).content,
        loader: 'ts',
        resolveDir: dirname(path),
      }
    })
  },
}

async function renderFarmVue(
  relativePath: string,
  props: Record<string, unknown>,
): Promise<string> {
  const filename = resolve('apps/farm/app/components/farm', relativePath)
  const { outputFiles } = await build({
    stdin: {
      contents: `import Component from ${JSON.stringify(filename)}\nexport default Component`,
      loader: 'ts',
      resolveDir: dirname(filename),
    },
    bundle: true,
    platform: 'node',
    format: 'cjs',
    external: ['vue'],
    plugins: [vuePlugin],
    write: false,
  })
  const module: { exports: { default?: Component } } = { exports: {} }
  new Function('require', 'module', outputFiles[0]!.text)(require, module)
  return renderToString(createSSRApp(module.exports.default!, props))
}

describe('deriveAlerts table-driven rules', () => {
  const alertCases: {
    name: string
    expectedKind: FarmAlertKind
    expectedLabel: RegExp
    expectedMessage: RegExp
    expectedHref: string
    state: Parameters<typeof deriveAlerts>[0]
  }[] = [
    {
      name: 'error printer state',
      expectedKind: 'error',
      expectedLabel: /^Erro$/,
      expectedMessage: /estado de erro/i,
      expectedHref: `#printer-${ASSIGNMENT_ID}`,
      state: {
        kind: 'ready',
        rows: [makeRow({}, { state: 'error' })],
      },
    },
    {
      name: 'offline printer state',
      expectedKind: 'offline-or-stale',
      expectedLabel: /^Offline$/,
      expectedMessage: /indisponível segundo o Connector/i,
      expectedHref: `#printer-${ASSIGNMENT_ID}`,
      state: {
        kind: 'ready',
        rows: [makeRow({}, { state: 'offline', progress: undefined })],
      },
    },
    {
      name: 'offline due to missing client certificate',
      expectedKind: 'offline-or-stale',
      expectedLabel: /^Certificado ausente$/,
      expectedMessage: /Certificado do cliente ausente/i,
      expectedHref: `#printer-${ASSIGNMENT_ID}`,
      state: {
        kind: 'ready',
        rows: [
          makeRow(
            {},
            {
              state: 'offline',
              progress: undefined,
              statusReason: 'client-certificate-missing',
            },
          ),
        ],
      },
    },
    {
      name: 'offline when connection closed without observation',
      expectedKind: 'offline-or-stale',
      expectedLabel: /^Offline$/,
      expectedMessage: /Conexão direta encerrada/i,
      expectedHref: `#printer-${ASSIGNMENT_ID}`,
      state: {
        kind: 'ready',
        rows: [makeRow({ connection: 'closed', observation: null })],
      },
    },
    {
      name: 'stale observation over 30 s',
      expectedKind: 'offline-or-stale',
      expectedLabel: /^Dados desatualizados$/,
      expectedMessage: /Dados desatualizados/i,
      expectedHref: `#printer-${ASSIGNMENT_ID}`,
      state: {
        kind: 'ready',
        rows: [makeRow({}, { state: 'printing', progress: 0.5 }, 30_000)],
      },
    },
    {
      name: 'stale historical observation',
      expectedKind: 'offline-or-stale',
      expectedLabel: /^Dados desatualizados$/,
      expectedMessage: /Dados desatualizados/i,
      expectedHref: `#printer-${ASSIGNMENT_ID}`,
      state: {
        kind: 'ready',
        rows: [
          makeRow({
            connection: 'closed',
            observation: {
              state: {
                printerKey: 'impressora-alfa',
                state: 'printing',
                progress: 0.5,
                observedAt: NOW.wall - 1000,
              },
              received: { wall: NOW.wall - 1000, mono: NOW.mono - 1000 },
              sourceClockComparable: true,
              historical: true,
            },
          }),
        ],
      },
    },
    {
      name: 'paused print',
      expectedKind: 'paused',
      expectedLabel: /^Pausada$/,
      expectedMessage: /Impressão pausada \(suporte\.gcode\)/,
      expectedHref: `#printer-${ASSIGNMENT_ID}`,
      state: {
        kind: 'ready',
        rows: [
          makeRow(
            {},
            { state: 'paused', progress: 0.4, filename: 'suporte.gcode' },
          ),
        ],
      },
    },
    {
      name: 'finished and waiting for bed clear',
      expectedKind: 'finished-bed-clear',
      expectedLabel: /^Aguardando limpeza da mesa$/,
      expectedMessage:
        /Impressão concluída \(placa\.3mf\); aguardando limpeza/i,
      expectedHref: `#printer-${ASSIGNMENT_ID}`,
      state: {
        kind: 'ready',
        rows: [
          makeRow(
            {},
            {
              state: 'idle',
              progress: 1,
              lastJob: {
                outcome: 'completed',
                filename: 'placa.3mf',
                endedAt: NOW.wall - 5_000,
              },
            },
          ),
        ],
      },
    },
    {
      name: 'slot under 10 percent',
      expectedKind: 'low-slot',
      expectedLabel: /^Filamento abaixo de 10%$/,
      expectedMessage: /AMS 1, bandeja 2 \(9,5%\)/,
      expectedHref: `#printer-${ASSIGNMENT_ID}`,
      state: {
        kind: 'ready',
        rows: [
          makeRow(
            {},
            {
              state: 'printing',
              progress: 0.6,
              materials: [{ slot: 'ams:0:1', remainingPercent: 9.5 }],
            },
          ),
        ],
      },
    },
    {
      name: 'firmware update available',
      expectedKind: 'firmware-update',
      expectedLabel: /^Atualização de firmware$/,
      expectedMessage: /Atualização de firmware disponível \(2\.1\.0\)/,
      expectedHref: `#printer-${ASSIGNMENT_ID}`,
      state: {
        kind: 'ready',
        rows: [
          makeRow(
            {},
            {
              state: 'idle',
              firmware: {
                current: '2.0.0',
                latest: '2.1.0',
                updateAvailable: true,
              },
            },
          ),
        ],
      },
    },
    {
      name: 'Connector storage degraded with matching row',
      expectedKind: 'connector-storage-degraded',
      expectedLabel: /^Armazenamento do Connector degradado$/,
      expectedMessage: /Armazenamento do Connector degradado.*impressora-alfa/,
      expectedHref: `#printer-${ASSIGNMENT_ID}`,
      state: {
        kind: 'ready',
        rows: [makeRow()],
        connectorStorage: { [AGENT_ID]: 'degraded' },
      },
    },
    {
      name: 'Connector storage degraded without matching row links to /connectors',
      expectedKind: 'connector-storage-degraded',
      expectedLabel: /^Armazenamento do Connector degradado$/,
      expectedMessage: /Armazenamento do Connector degradado/,
      expectedHref: '/connectors',
      state: {
        kind: 'ready',
        rows: [],
        connectorStorage: { [AGENT_ID]: 'degraded' },
      },
    },
  ]

  it.each(alertCases)(
    'fires $name',
    ({ expectedKind, expectedLabel, expectedMessage, expectedHref, state }) => {
      const summary = deriveAlerts(state, NOW)
      expect(summary.total).toBe(1)
      expect(summary.counts[expectedKind]).toBe(1)
      expect(summary.alerts[0]!.kind).toBe(expectedKind)
      expect(summary.alerts[0]!.label).toMatch(expectedLabel)
      expect(summary.alerts[0]!.message).toMatch(expectedMessage)
      expect(summary.alerts[0]!.href).toBe(expectedHref)
      expect(summary.announcement).toMatch(/^1 alerta ativo:/)
    },
  )

  const noAlertCases: {
    name: string
    state: Parameters<typeof deriveAlerts>[0]
  }[] = [
    { name: 'null state', state: null },
    { name: 'undefined state', state: undefined },
    { name: 'loading view state', state: { kind: 'loading' } },
    {
      name: 'sign-in-required view state',
      state: { kind: 'sign-in-required' },
    },
    {
      name: 'error view state',
      state: { kind: 'error', reason: 'unavailable' },
    },
    {
      name: 'ready with empty rows and omitted optional storage',
      state: { kind: 'ready', rows: [] },
    },
    {
      name: 'unavailable row with missing observation',
      state: {
        kind: 'ready',
        rows: [makeRow({ connection: 'unavailable', observation: null })],
      },
    },
    {
      name: 'authenticated row awaiting first observation',
      state: {
        kind: 'ready',
        rows: [makeRow({ connection: 'authenticated', observation: null })],
      },
    },
    {
      name: 'idle printer with all optional fields omitted',
      state: {
        kind: 'ready',
        rows: [makeRow({}, { state: 'idle', progress: 0 })],
      },
    },
    {
      name: 'materials without remainingPercent',
      state: {
        kind: 'ready',
        rows: [
          makeRow(
            {},
            {
              state: 'printing',
              progress: 0.2,
              materials: [{ slot: 'external', materialType: 'PLA' }],
            },
          ),
        ],
      },
    },
    {
      name: 'slot at exact 10 percent threshold',
      state: {
        kind: 'ready',
        rows: [
          makeRow(
            {},
            {
              state: 'printing',
              progress: 0.2,
              materials: [{ slot: 'ams:0:0', remainingPercent: 10 }],
            },
          ),
        ],
      },
    },
    {
      name: 'firmware without updateAvailable flag',
      state: {
        kind: 'ready',
        rows: [
          makeRow(
            {},
            {
              state: 'idle',
              firmware: { current: '1.0.0', latest: '2.0.0' },
            },
          ),
        ],
      },
    },
    {
      name: 'firmware with updateAvailable false',
      state: {
        kind: 'ready',
        rows: [
          makeRow(
            {},
            {
              state: 'idle',
              firmware: {
                current: '2.0.0',
                latest: '2.0.0',
                updateAvailable: false,
              },
            },
          ),
        ],
      },
    },
    {
      name: 'cancelled lastJob on idle printer',
      state: {
        kind: 'ready',
        rows: [
          makeRow(
            {},
            {
              state: 'idle',
              lastJob: { outcome: 'cancelled', endedAt: NOW.wall - 1000 },
            },
          ),
        ],
      },
    },
    {
      name: 'completed lastJob while a new print is running',
      state: {
        kind: 'ready',
        rows: [
          makeRow(
            {},
            {
              state: 'printing',
              progress: 0.1,
              lastJob: { outcome: 'completed', endedAt: NOW.wall - 5000 },
            },
          ),
        ],
      },
    },
    {
      name: 'fresh observation just before 30 s staleness boundary',
      state: {
        kind: 'ready',
        rows: [makeRow({}, { state: 'printing', progress: 0.5 }, 29_999)],
      },
    },
  ]

  it.each(noAlertCases)('fires no alert on $name', ({ state }) => {
    const summary = deriveAlerts(state, NOW)
    expect(summary.total).toBe(0)
    expect(summary.alerts).toEqual([])
    expect(summary.byAssignment).toEqual({})
    expect(summary.announcement).toBe('Nenhum alerta ativo no momento.')
    for (const kind of FARM_ALERT_ORDER) expect(summary.counts[kind]).toBe(0)
  })

  it('aggregates counts, orders by severity, attaches chips per card, and shares Connector alert across rows', () => {
    const assignmentB = '00000000-0000-4000-8000-000000000010'
    const rowA = makeRow(
      {
        assignment: {
          assignmentId: ASSIGNMENT_ID,
          agentId: AGENT_ID,
          printerKey: 'p1',
          status: 'active',
          connectorStatus: 'approved',
        },
      },
      { state: 'paused', progress: 0.5, firmware: { updateAvailable: true } },
    )
    const rowB = makeRow(
      {
        assignment: {
          assignmentId: assignmentB,
          agentId: AGENT_ID,
          printerKey: 'p2',
          status: 'active',
          connectorStatus: 'approved',
        },
      },
      {
        state: 'error',
        progress: 0,
        materials: [{ slot: 'external', remainingPercent: 4 }],
      },
    )
    const summary = deriveAlerts(
      {
        kind: 'ready',
        rows: [rowA, rowB],
        connectorStorage: { [AGENT_ID]: 'degraded' },
      },
      NOW,
    )
    expect(summary.total).toBe(5)
    expect(summary.counts).toEqual({
      error: 1,
      'connector-storage-degraded': 1,
      'offline-or-stale': 0,
      paused: 1,
      'finished-bed-clear': 0,
      'low-slot': 1,
      'firmware-update': 1,
    })
    expect(summary.alerts.map((a) => a.kind)).toEqual([
      'error',
      'connector-storage-degraded',
      'paused',
      'low-slot',
      'firmware-update',
    ])
    expect(summary.byAssignment[ASSIGNMENT_ID]!.map((c) => c.kind)).toEqual([
      'connector-storage-degraded',
      'paused',
      'firmware-update',
    ])
    expect(summary.byAssignment[assignmentB]!.map((c) => c.kind)).toEqual([
      'error',
      'connector-storage-degraded',
      'low-slot',
    ])
    expect(summary.announcement).toBe(
      '5 alertas ativos: 1 em erro, 1 armazenamento do Connector degradado, 1 em pausa, 1 com filamento abaixo de 10%, 1 com atualização de firmware.',
    )
  })
})

describe('createFarmView tracks Connector storage degraded snapshots', () => {
  it('propagates storage: degraded to deriveAlerts and clears on recovery or close', async () => {
    let latest: FarmViewState = { kind: 'loading' }
    const time = { wall: NOW.wall, mono: NOW.mono }
    let peerInput: Parameters<FarmStatusFeed['open']>[0] | undefined
    const thumbprint = 'A'.repeat(43)
    const session: FarmAdmittedSession = {
      transportId: 't-1',
      peerGeneration: 1,
      accountId: 'acc-1',
      farmId: FARM_ID,
      agentId: AGENT_ID,
      browserKeyId: KEY_ID,
      expiresAt: time.wall + 30_000,
      deadlineMonoMs: time.mono + 30_000,
    }
    const view = createFarmView({
      read: async (path) => {
        if (path === '/api/auth/me') return { accountId: 'acc-1' }
        if (path === '/api/farms')
          return { farms: [{ farmId: FARM_ID }], nextAfter: null }
        if (path === `/api/farms/${FARM_ID}/printers`)
          return {
            printers: [
              {
                assignmentId: ASSIGNMENT_ID,
                agentId: AGENT_ID,
                printerKey: 'impressora-alfa',
                status: 'active',
                connectorStatus: 'approved',
              },
            ],
            nextAfter: null,
            canManage: true,
          }
        if (path === '/api/browser-devices')
          return {
            currentAccountId: 'acc-1',
            currentRole: 'owner',
            devices: [
              {
                keyId: KEY_ID,
                accountId: 'acc-1',
                thumbprint,
                status: 'approved',
                proofAt: 10,
                createdAt: 0,
                pendingExpiresAt: null,
              },
            ],
            nextAfter: null,
            limits: {
              pendingLifetimeMs: 86_400_000,
              proofLifetimeMs: 60_000,
              maxChallengesPerKey: 3,
            },
          }
        throw new Error(`Unexpected path ${path}`)
      },
      listKeys: async () => [{ thumbprint }],
      clock: () => ({ ...time }),
      changed: (next) => {
        latest = next
      },
      feed: {
        open(input) {
          peerInput = input
          return { close() {} }
        },
      },
    })

    await view.discover()
    expect(peerInput).toBeDefined()
    peerInput!.onHealth({ kind: 'authenticated', session })

    const sendSnapshot = (seq: number, storage?: 'degraded') => {
      const snapshot: FarmSnapshot = {
        session,
        message: {
          t: 'snapshot',
          seq,
          printers: [
            {
              printerKey: 'impressora-alfa',
              state: 'idle',
              progress: 0,
              observedAt: time.wall,
            },
          ],
          ...(storage ? { storage } : {}),
        },
        receivedAtWallMs: time.wall,
        receivedAtMonoMs: time.mono,
        sourceClockComparable: true,
        complete: true,
      }
      peerInput!.onSnapshot(snapshot)
    }

    sendSnapshot(0, 'degraded')
    expect(
      deriveAlerts(latest, time).counts['connector-storage-degraded'],
    ).toBe(1)

    sendSnapshot(1)
    expect(
      deriveAlerts(latest, time).counts['connector-storage-degraded'],
    ).toBe(0)

    sendSnapshot(2, 'degraded')
    expect(
      deriveAlerts(latest, time).counts['connector-storage-degraded'],
    ).toBe(1)

    peerInput!.onHealth({ kind: 'closed', reason: 'disconnected' })
    const afterClose = deriveAlerts(latest, time)
    expect(afterClose.counts['connector-storage-degraded']).toBe(0)
    expect(afterClose.counts['offline-or-stale']).toBe(1)

    view.dispose()
  })
})

describe('PrinterAlerts and FarmPrinterCard rendering', () => {
  it('renders panel with counts, links, row chips and polite announcement', async () => {
    const row = makeRow(
      {},
      {
        state: 'paused',
        progress: 0.4,
        materials: [{ slot: 'external', remainingPercent: 5 }],
      },
    )
    const summary = deriveAlerts({ kind: 'ready', rows: [row] }, NOW)
    const html = await renderFarmVue('PrinterAlerts.vue', { alerts: summary })

    expect(html).toContain('Alertas da farm')
    expect(html).toContain('(2)')
    expect(html).toContain('role="status"')
    expect(html).toContain('aria-live="polite"')
    expect(html).toContain('aria-atomic="true"')
    expect(html).toContain(summary.announcement)
    expect(html).toContain('Pausada: 1')
    expect(html).toContain('Filamento abaixo de 10%: 1')
    expect(html).toContain(`href="#printer-${ASSIGNMENT_ID}"`)
    expect(html).toContain('Ir para impressora-alfa')
  })

  it('keeps polite live region mounted when zero alerts exist', async () => {
    const summary = deriveAlerts({ kind: 'ready', rows: [] }, NOW)
    const html = await renderFarmVue('PrinterAlerts.vue', { alerts: summary })

    expect(html).toContain('aria-live="polite"')
    expect(html).toContain('Nenhum alerta ativo no momento.')
    expect(html).not.toContain('alert-list')
  })

  it('renders alert chips on FarmPrinterCard and omits them when empty', async () => {
    const alertRow = makeRow({}, { state: 'error', progress: 0 })
    const chips = deriveRowAlerts(alertRow, NOW)
    const cardWithAlerts = await renderFarmVue('FarmPrinterCard.vue', {
      row: alertRow,
      farmId: FARM_ID,
      cameraFor: () => null,
      liveNow: () => NOW,
      alerts: chips,
    })
    expect(cardWithAlerts).toContain('aria-label="Alertas da impressora"')
    expect(cardWithAlerts).toContain('data-alert-kind="error"')
    expect(cardWithAlerts).toContain('Erro')

    const cleanRow = makeRow({}, { state: 'idle', progress: 0 })
    const cardWithoutAlerts = await renderFarmVue('FarmPrinterCard.vue', {
      row: cleanRow,
      farmId: FARM_ID,
      cameraFor: () => null,
      liveNow: () => NOW,
      alerts: [],
    })
    expect(cardWithoutAlerts).not.toContain('alert-chips')
  })
})
