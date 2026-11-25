// In-memory world for the v1 contract test: the real IntegrationAuth, the real
// jobs and actions services and the real handlers run on top of these fakes.
// Nothing here opens a socket or a database; the fakes implement the same
// store seams the PostgreSQL adapters implement.
import type { FarmAlertKind } from '../../../apps/farm/app/utils/farm-alerts.ts'
import type { FleetModeRecord } from '../../../apps/farm/server/utils/integration-fleet-mode.ts'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import {
  hashClientSecret,
  type IntegrationGrant,
  type IntegrationScope,
  type StoredCredential,
} from '../../../apps/farm/server/services/integration-apps.ts'
import {
  IntegrationActionsService,
  type ActionRecord,
  type ActionTarget,
  type IntegrationActionsStore,
  type NewAction,
} from '../../../apps/farm/server/services/integration-actions.ts'
import {
  requiredScopeFor,
  type EnvelopeRecord,
  type IssueEnvelope,
  type IssueResult,
} from '../../../apps/farm/server/services/integration-delivery.ts'
import {
  IntegrationJobsService,
  type IntegrationJobsStore,
  type JobRecord,
  type JobTarget,
  type NewJob,
} from '../../../apps/farm/server/services/integration-jobs.ts'
import {
  IntegrationLibraryService,
  MemoryLibraryStore,
  type NewLibraryVersion,
} from '../../../apps/farm/server/services/integration-library.ts'
import {
  IntegrationAuth,
  parseIntegrationTokenConfig,
  type IntegrationAuthStore,
  type IntegrationPrinterRow,
} from '../../../apps/farm/server/utils/integration-auth.ts'

/** Switches that make one dependency throw, for the 503 cases. */
export type Fault =
  | 'auth-store'
  | 'printers'
  | 'pool'
  | 'jobs-runtime'
  | 'webhooks'
  | 'library-runtime'

export const ids = {
  farmA: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  farmB: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  printerA1: 'aaaaaaaa-0000-4000-8000-000000000001',
  printerA2: 'aaaaaaaa-0000-4000-8000-000000000002',
  printerB1: 'bbbbbbbb-0000-4000-8000-000000000001',
  agentA: 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa',
  agentB: 'bbbbbbbb-1111-4111-8111-bbbbbbbbbbbb',
  alertA: 'aaaaaaaa-4444-4444-8444-aaaaaaaaaaaa',
  unknown: 'ffffffff-ffff-4fff-8fff-ffffffffffff',
  itemA: 'aaaaaaaa-2222-4222-8222-aaaaaaaaaaa1',
  itemB: 'aaaaaaaa-2222-4222-8222-aaaaaaaaaaa2',
  versionA: 'aaaaaaaa-3333-4333-8333-aaaaaaaaaaa1',
  versionB: 'aaaaaaaa-3333-4333-8333-aaaaaaaaaaa2',
  versionServer: 'aaaaaaaa-3333-4333-8333-aaaaaaaaaaa3',
} as const

export const ALL_CONTROLS = [
  'pause',
  'resume',
  'cancel',
  'set_temperature',
  'set_fan',
  'home',
  'set_light',
  'set_speed',
  'run_macro',
  'load_filament',
  'unload_filament',
] as const

const sha = 'ab'.repeat(32)
export const jobBody = {
  fileUrl: 'https://files.example.invalid/parts/benchy.gcode',
  sha256: sha,
  sizeBytes: 123456,
  displayName: 'benchy.gcode',
} as const

export interface App {
  appId: string
  clientId: string
  secret: string
  sandbox: boolean
}

type InboxResult =
  | {
      kind: 'files'
      data: { name: string; sizeBytes: number; modifiedAt: number }[]
      nextOffset: number | null
    }
  | { kind: 'macros'; data: { name: string }[]; nextOffset: number | null }
  | Extract<
      import('../../../packages/farm-protocol/src/api-query.ts').ApiQueryResult,
      { kind: 'dispatch' | 'spool-membership' }
    >
  | {
      kind: 'error'
      error: 'unsupported' | 'connector-unavailable' | 'connector-timeout'
    }

export interface InventoryRow {
  farmId: string
  connectorId: string
  observedAt: number
  snapshot: unknown
}
/** A ranked row of the OpenFarm spool library, as the spool finder selects it. */
export interface SpoolStockRow {
  farmId: string
  spoolId: number
  name: string | null
  material: string | null
  colorHex: string | null
  location: string | null
  remainingGrams: number | null
  colorDistance: number | null
  loaded: boolean
  loadedAt: {
    printerId: string
    slotKind: 'printer' | 'ams' | 'toolhead'
    slotIndex: number
    assignedAt: number
  }[]
}
/** Rows of farm.spool_usage_records, as the usage feed selects them. */
export interface SpoolUsageRow {
  usageId: string
  farmId: string
  jobId: string
  spoolId: number
  printerId: string | null
  grams: number
  source: 'telemetry' | 'manual' | 'api'
  observedAt: number
  corrected: boolean
}
export interface ResinLedgerEntryRow {
  id: string
  printerId: string
  kind: 'vat' | 'bottle' | 'volume' | 'film' | 'lcd'
  target: string | null
  name: string | null
  volumeMl: number | null
  layers: number | null
  hours: number | null
  source: 'manual' | 'reported'
  recordedAt: number
}
export interface HistoryRow {
  id: string
  farmId: string
  printerId: string
  outcome: 'completed' | 'cancelled' | 'failed'
  filename: string | null
  printDurationSeconds: number | null
  totalDurationSeconds: number | null
  filamentUsage: unknown[] | null
  endedAt: number
}

const printerState = {
  printerKey: 'printer-a',
  state: 'printing',
  progress: 0.5,
  observedAt: 1_700_000_000_000,
  identity: { vendor: 'Example', model: 'Model 1' },
  controls: [...ALL_CONTROLS],
  filename: 'part.gcode',
  estimatedRemainingSeconds: 60,
  toolTemperatureCelsius: 210,
  bedTemperatureCelsius: 60,
}

class MemoryAuthStore implements IntegrationAuthStore {
  credentials: StoredCredential[] = []
  grants: IntegrationGrant[] = []
  printers: IntegrationPrinterRow[] = []
  constructor(private readonly world: World) {}
  private guard() {
    if (this.world.faults.has('auth-store')) throw new Error('auth store down')
  }
  async findActiveCredential(clientId: string) {
    this.guard()
    return (
      this.credentials.find(
        (credential) =>
          credential.clientId === clientId && credential.revokedAt === null,
      ) ?? null
    )
  }
  async effectiveGrants(appId: string) {
    this.guard()
    return this.grants.filter(
      (grant) => grant.appId === appId && grant.disabledAt === null,
    )
  }
  async activePrinterFarm(printerId: string) {
    this.guard()
    return this.printers.find((row) => row.id === printerId)?.farmId ?? null
  }
  async readPrinters(input: {
    farmWideFarmIds: string[]
    assignmentIds: string[]
    farmId?: string
    afterId?: string
    limit: number
  }) {
    if (this.world.faults.has('printers')) throw new Error('printers down')
    return this.printers
      .filter(
        (row) =>
          input.farmWideFarmIds.includes(row.farmId) ||
          input.assignmentIds.includes(row.id),
      )
      .filter((row) => !input.farmId || input.farmId === row.farmId)
      .filter((row) => !input.afterId || row.id > input.afterId)
      .sort((a, b) => a.id.localeCompare(b.id))
      .slice(0, input.limit)
  }
  async readPrinter(printerId: string) {
    if (this.world.faults.has('printers')) throw new Error('printers down')
    return this.printers.find((row) => row.id === printerId) ?? null
  }
}

class MemoryEnvelopes {
  rows = new Map<string, EnvelopeRecord>()
  readonly commands = new Map<string, IssueEnvelope['command']>()
  async issue(input: IssueEnvelope): Promise<IssueResult> {
    const existing = this.byResource(input.resourceId)
    if (existing) return { ok: true, record: existing, created: false }
    const now = Date.now()
    const record: EnvelopeRecord = {
      cmdId: randomUUID(),
      appId: input.appId,
      grantId: input.grantId,
      farmId: input.farmId,
      agentId: input.agentId,
      printerAssignmentId: input.printerAssignmentId,
      kind: input.command.kind,
      resourceId: input.resourceId,
      requiredScope: requiredScopeFor(input.command),
      nonce: randomBytes(16).toString('base64url'),
      wire: 'wire',
      issuedAt: now,
      expiresAt: now + input.ttlMs,
      status: 'pending',
      refusalCode: null,
      resultDetail: null,
      historyEntryId: null,
      createdAt: now,
      updatedAt: now,
    }
    this.rows.set(record.cmdId, record)
    this.commands.set(record.cmdId, input.command)
    return { ok: true, record, created: true }
  }
  // No Connector socket in-process: the envelope stays queued.
  async deliver() {
    return 'no-inbox' as const
  }
  async get(cmdId: string) {
    return this.rows.get(cmdId) ?? null
  }
  byResource(resourceId: string) {
    return [...this.rows.values()].find((row) => row.resourceId === resourceId)
  }
}

class MemoryJobs implements IntegrationJobsStore {
  jobs: JobRecord[] = []
  targets = new Map<string, JobTarget>()
  constructor(private readonly envelopes: MemoryEnvelopes) {}
  async target(id: string) {
    return this.targets.get(id) ?? null
  }
  async get(id: string, appId: string) {
    const record = this.jobs.find((job) => job.id === id && job.appId === appId)
    return record
      ? { record, envelope: this.envelopes.byResource(record.id) ?? null }
      : null
  }
  async create(job: NewJob, now: number) {
    const found = this.jobs.find(
      (entry) =>
        entry.appId === job.appId &&
        entry.idempotencyKey === job.idempotencyKey,
    )
    if (found)
      return {
        kind: 'existing' as const,
        record: found,
        cmdId: this.envelopes.byResource(found.id)?.cmdId ?? null,
      }
    const record: JobRecord = { ...job, createdAt: now, updatedAt: now }
    this.jobs.push(record)
    return { kind: 'created' as const, record }
  }
}

class MemoryActions implements IntegrationActionsStore {
  actions: ActionRecord[] = []
  targets = new Map<string, ActionTarget>()
  constructor(private readonly envelopes: MemoryEnvelopes) {}
  async target(id: string) {
    return this.targets.get(id) ?? null
  }
  async existing(appId: string, key: string) {
    const record = this.actions.find(
      (entry) => entry.appId === appId && entry.idempotencyKey === key,
    )
    return record
      ? { record, envelope: this.envelopes.byResource(record.id) ?? null }
      : null
  }
  async get(id: string, appId: string) {
    const record = this.actions.find(
      (entry) => entry.id === id && entry.appId === appId,
    )
    return record
      ? { record, envelope: this.envelopes.byResource(record.id) ?? null }
      : null
  }
  async create(action: NewAction, now: number) {
    const found = this.actions.find(
      (entry) =>
        entry.appId === action.appId &&
        entry.idempotencyKey === action.idempotencyKey,
    )
    if (found)
      return {
        kind: 'existing' as const,
        record: found,
        cmdId: this.envelopes.byResource(found.id)?.cmdId ?? null,
      }
    const record: ActionRecord = { ...action, createdAt: now, updatedAt: now }
    this.actions.push(record)
    return { kind: 'created' as const, record }
  }
}

interface StoredWebhook {
  id: string
  url: string
  events: string[]
  description: string | null
  createdAt: number
}
export class MemoryWebhooks {
  rows = new Map<string, StoredWebhook[]>()
  constructor(private readonly world: World) {}
  private guard() {
    if (this.world.faults.has('webhooks')) throw new Error('webhooks down')
  }
  private forApp(appId: string) {
    return this.rows.get(appId) ?? []
  }
  seed(appId: string, count: number) {
    const list = this.forApp(appId)
    for (let index = 0; index < count; index++)
      list.push({
        id: randomUUID(),
        url: 'https://8.8.8.8/seeded',
        events: ['job.ended'],
        description: null,
        createdAt: 100 + index,
      })
    this.rows.set(appId, list)
    return list
  }
  async sandbox(appId: string) {
    this.guard()
    return this.world.apps.get(appId)?.sandbox
  }
  async list(appId: string, after: string | null, limit: number) {
    this.guard()
    const rows = [...this.forApp(appId)]
      .sort((a, b) => a.id.localeCompare(b.id))
      .filter((row) => after === null || row.id > after)
      .slice(0, limit + 1)
    const data = rows
      .slice(0, limit)
      .map(({ description, ...row }) =>
        description === null ? row : { ...row, description },
      )
    const last = data.at(-1)
    return {
      data,
      nextCursor:
        rows.length > limit && last
          ? Buffer.from(last.id).toString('base64url')
          : null,
    }
  }
  async create(
    appId: string,
    input: { url: string; events: string[]; description?: string },
  ) {
    this.guard()
    const list = this.forApp(appId)
    if (list.length >= 20) return 'webhook-limit-reached' as const
    const row: StoredWebhook = {
      id: randomUUID(),
      url: input.url,
      events: input.events,
      description: input.description ?? null,
      createdAt: this.world.clock,
    }
    this.rows.set(appId, [...list, row])
    return {
      id: row.id,
      url: row.url,
      events: row.events,
      createdAt: row.createdAt,
      ...(row.description === null ? {} : { description: row.description }),
      signingSecret: randomBytes(32).toString('base64url'),
    }
  }
  async delete(appId: string, id: string) {
    this.guard()
    const list = this.forApp(appId)
    if (!list.some((row) => row.id === id)) return false
    this.rows.set(
      appId,
      list.filter((row) => row.id !== id),
    )
    return true
  }
  async queueTest(appId: string, id: string) {
    this.guard()
    return this.forApp(appId).some((row) => row.id === id)
      ? { eventId: randomUUID() }
      : null
  }
}

export class World {
  clock = 1_700_000_000_000
  private alertActions: {
    appId: string
    action: string
    actedAt: number
    silencedUntil: number | null
  }[] = []
  disabledAlertRules: { farmId: string; kind: FarmAlertKind }[] = []
  get alertActionCount() {
    return this.alertActions.length
  }
  telemetryFixture: { states: unknown[]; transitions: unknown[] } | null = null
  cameraEnabled = false
  readonly faults = new Set<Fault>()
  readonly config: {
    integrationAuth: { readLimit: number; writeLimit: number }
    library?: { maxUploadBytes?: number }
  } = {
    integrationAuth: { readLimit: 1_000_000, writeLimit: 1_000_000 },
  }
  readonly apps = new Map<string, App>()
  readonly authStore = new MemoryAuthStore(this)
  readonly auth: IntegrationAuth
  readonly envelopes = new MemoryEnvelopes()
  readonly jobsStore = new MemoryJobs(this.envelopes)
  readonly actionsStore = new MemoryActions(this.envelopes)
  readonly webhooks = new MemoryWebhooks(this)
  readonly libraryStore = new MemoryLibraryStore()
  readonly library: IntegrationLibraryService
  readonly jobs: IntegrationJobsService
  readonly actions: IntegrationActionsService
  inventory: InventoryRow[] = []
  history: HistoryRow[] = []
  /** Rows of farm.resin_ledger_entries, as the resin reader selects them. */
  resinLedger: ResinLedgerEntryRow[] = []
  spoolStock: SpoolStockRow[] = []
  spoolUsage: SpoolUsageRow[] = []
  inbox: InboxResult = { kind: 'files', data: [], nextOffset: null }
  inboxCalls: { farmId: string; agentId: string; query: unknown }[] = []
  readonly pool: unknown
  physicalSpoolRead?: (
    query: TemplateStringsArray,
    ...values: unknown[]
  ) => unknown

  constructor() {
    this.auth = new IntegrationAuth(
      this.authStore,
      parseIntegrationTokenConfig({
        signingKey: randomBytes(32).toString('base64url'),
        tokenTtlSeconds: 300,
      }),
      () => this.clock,
    )
    this.library = new IntegrationLibraryService(
      this.libraryStore,
      () => this.clock,
    )
    const envelopes = {
      issue: (input: IssueEnvelope) => this.envelopes.issue(input),
      deliver: () => this.envelopes.deliver(),
      get: (cmdId: string) => this.envelopes.get(cmdId),
    }
    this.jobs = new IntegrationJobsService({
      store: this.jobsStore,
      library: {
        version: (id) => this.library.version(id),
        recordReplay: (entry) => this.library.recordReplay(entry),
      },
      envelopes,
      now: () => this.clock,
    })
    this.actions = new IntegrationActionsService({
      store: this.actionsStore,
      envelopes,
      now: () => this.clock,
    })
    this.pool = this.makeSql()
    this.seedFarm()
  }

  private seedFarm() {
    const row = (
      id: string,
      farmId: string,
      agentId: string,
      key: string,
      grouping: {
        displayName: string
        groupName: string
        location: string
      },
    ): IntegrationPrinterRow => ({
      id,
      farmId,
      agentId,
      printerKey: key,
      displayName: grouping.displayName,
      groupName: grouping.groupName,
      location: grouping.location,
      sandbox: false,
      state: { ...printerState, printerKey: key },
      observedAt: 1_700_000_000_000,
    })
    this.authStore.printers = [
      row(ids.printerA1, ids.farmA, ids.agentA, 'printer-a1', {
        displayName: 'Alpha',
        groupName: 'Linha A',
        location: 'Sala 1',
      }),
      row(ids.printerA2, ids.farmA, ids.agentA, 'printer-a2', {
        displayName: 'Beta',
        groupName: 'Linha A',
        location: 'Sala 1',
      }),
      row(ids.printerB1, ids.farmB, ids.agentB, 'printer-b1', {
        displayName: 'Gamma',
        groupName: 'Linha B',
        location: 'Sala 2',
      }),
    ]
    for (const printer of this.authStore.printers) {
      this.jobsStore.targets.set(printer.id, {
        farmId: printer.farmId,
        agentId: printer.agentId ?? '',
      })
      this.actionsStore.targets.set(printer.id, {
        farmId: printer.farmId,
        agentId: printer.agentId ?? '',
        controls: ALL_CONTROLS,
      })
    }
    const spool = {
      name: 'PLA Red',
      material: 'PLA',
      colorHex: 'ff0000',
      remainingGrams: 640,
      location: 'Shelf 1',
      archived: false,
    }
    this.inventory = [
      {
        farmId: ids.farmA,
        connectorId: ids.agentA,
        observedAt: this.clock,
        snapshot: {
          observedAt: this.clock,
          stale: false,
          total: 2,
          spools: [
            { spoolId: 7, ...spool },
            { ...spool, name: null, remainingGrams: -5 },
          ],
        },
      },
      {
        farmId: ids.farmA,
        connectorId: 'aaaaaaaa-2222-4222-8222-aaaaaaaaaaaa',
        observedAt: this.clock,
        snapshot: { observedAt: this.clock, stale: true, total: 0, spools: [] },
      },
    ]
    this.spoolStock = [
      {
        farmId: ids.farmA,
        spoolId: 7,
        name: 'PLA Red',
        material: 'PLA',
        colorHex: 'ff0000',
        location: 'Shelf 1',
        remainingGrams: 640,
        colorDistance: 0,
        loaded: true,
        loadedAt: [
          {
            printerId: ids.printerA1,
            slotKind: 'ams',
            slotIndex: 0,
            assignedAt: this.clock - 5_000,
          },
        ],
      },
      {
        farmId: ids.farmA,
        spoolId: 8,
        name: 'PLA Red',
        material: 'PLA',
        colorHex: 'ee1100',
        location: null,
        remainingGrams: null,
        colorDistance: 24.5,
        loaded: false,
        loadedAt: [],
      },
    ]
    this.spoolUsage = [
      {
        usageId: '00000000-0000-4000-8000-0000000000a1',
        farmId: ids.farmA,
        jobId: '101',
        spoolId: 7,
        printerId: ids.printerA1,
        grams: 12.5,
        source: 'telemetry',
        observedAt: this.clock - 1_000,
        corrected: true,
      },
      {
        usageId: '00000000-0000-4000-8000-0000000000a2',
        farmId: ids.farmA,
        jobId: '101',
        spoolId: 8,
        printerId: null,
        grams: 3,
        source: 'manual',
        observedAt: this.clock - 500,
        corrected: false,
      },
    ]
    this.resinLedger = [
      {
        id: '00000000-0000-4000-8000-000000000001',
        printerId: ids.printerA1,
        kind: 'bottle',
        target: null,
        name: 'Lote-A1',
        volumeMl: 750,
        layers: null,
        hours: null,
        source: 'manual',
        recordedAt: this.clock - 2_000,
      },
      {
        id: '00000000-0000-4000-8000-000000000002',
        printerId: ids.printerA1,
        kind: 'vat',
        target: null,
        name: 'Vat-1',
        volumeMl: null,
        layers: null,
        hours: null,
        source: 'reported',
        recordedAt: this.clock - 1_000,
      },
      {
        id: '00000000-0000-4000-8000-000000000003',
        printerId: ids.printerA2,
        kind: 'bottle',
        target: null,
        name: 'Lote-B7',
        volumeMl: null,
        layers: null,
        hours: null,
        source: 'manual',
        recordedAt: this.clock - 500,
      },
    ]
    this.history = [3, 2, 1].map((n) => ({
      id: String(100 + n),
      farmId: ids.farmA,
      printerId: ids.printerA1,
      outcome: 'completed' as const,
      filename: `part-${n}.gcode`,
      printDurationSeconds: 600 * n,
      totalDurationSeconds: 700 * n,
      filamentUsage: [{ tool: 'T0', grams: 12.5 * n, millimetres: 4000 * n }],
      endedAt: this.clock - n * 1000,
    }))
    this.libraryStore.agents.set(ids.farmA, ids.agentA)
    this.libraryStore.agents.set(ids.farmB, ids.agentB)
    const seed = (
      itemId: string,
      versionId: string,
      name: string,
      createdAt: number,
      storageLocation: NewLibraryVersion['storageLocation'],
    ) =>
      this.libraryStore.seed({
        id: versionId,
        itemId,
        farmId: ids.farmA,
        title: name.replace(/\.gcode$/u, ''),
        originalName: name,
        kind: 'gcode',
        sha256: createHash('sha256').update(name).digest('hex'),
        sizeBytes: 128,
        plateCount: 1,
        storageLocation,
        agentId: storageLocation === 'connector' ? ids.agentA : null,
        createdAt,
        versionNumber: 1,
      })
    seed(
      ids.itemA,
      ids.versionA,
      'older.gcode',
      this.clock - 2_000,
      'connector',
    )
    seed(
      ids.itemB,
      ids.versionB,
      'newer.gcode',
      this.clock - 1_000,
      'connector',
    )
    seed(
      'aaaaaaaa-2222-4222-8222-aaaaaaaaaaa3',
      ids.versionServer,
      'server.gcode',
      this.clock - 3_000,
      'server',
    )
  }

  private makeSql() {
    const fleetModes = new Map<string, FleetModeRecord>()
    const fn = async (strings: TemplateStringsArray, ...v: unknown[]) => {
      if (this.faults.has('pool')) throw new Error('pool down')
      const text = strings.join('?')
      if (
        this.physicalSpoolRead &&
        (text.trim() === '' ||
          text.includes('SELECT g.id FROM farm.integration_apps') ||
          text.includes('farm.read_physical_spool_observations'))
      )
        return this.physicalSpoolRead(strings, ...v)
      if (
        text.startsWith('\n      SELECT p.id FROM farm.printer_assignments p')
      )
        return v[0]
      if (text.includes('farm.integration_fleet_mode')) {
        if (text.includes('INSERT INTO')) {
          const [mode, version, previousMode, appId, target] = v
          const printerId = (await target) as string
          if (fleetModes.has(printerId)) return { count: 0 }
          fleetModes.set(printerId, {
            mode,
            version,
            previousMode,
            appId,
          } as FleetModeRecord)
          return { count: 1 }
        }
        if (text.includes('UPDATE')) {
          const [mode, version, previousMode, appId, target, expectedVersion] =
            v
          const printerId = (await target) as string
          if (fleetModes.get(printerId)?.version !== expectedVersion)
            return { count: 0 }
          fleetModes.set(printerId, {
            mode,
            version,
            previousMode,
            appId,
          } as FleetModeRecord)
          return { count: 1 }
        }
        const current = fleetModes.get(v[0] as string)
        return current ? [current] : []
      }
      if (
        text.includes('FROM farm.integration_alert_rules') &&
        text.includes('AND NOT enabled')
      ) {
        const [farmIds] = v as [string[]]
        return this.disabledAlertRules.filter(({ farmId }) =>
          farmIds.includes(farmId),
        )
      }
      if (text.includes('farm.integration_alert_lifecycle')) {
        if (text.includes('INSERT INTO farm.integration_alert_actions')) {
          const [appId, action, actedAt, silencedUntil, printerId, alertId] =
            v as [string, string, number, number | null, string, string]
          if (printerId !== ids.printerA1 || alertId !== ids.alertA) return []
          const previous = this.alertActions.find(
            (entry) => entry.appId === appId,
          )
          if (previous && text.includes('ON CONFLICT (alert_id, app_id)')) {
            if (previous.action !== 'acknowledge') {
              previous.action = action
              previous.actedAt = actedAt
            }
            if (silencedUntil !== null)
              previous.silencedUntil = Math.max(
                previous.silencedUntil ?? 0,
                silencedUntil,
              )
          } else {
            this.alertActions.push({ appId, action, actedAt, silencedUntil })
          }
          const actions = this.alertActions.filter(
            (entry) => entry.appId === appId,
          )
          const acknowledgements = actions
            .filter((entry) => entry.action === 'acknowledge')
            .map((entry) => entry.actedAt)
          const silences = actions.flatMap((entry) =>
            entry.silencedUntil === null ? [] : [entry.silencedUntil],
          )
          return [
            {
              id: alertId,
              acknowledgedAt: acknowledgements.length
                ? Math.min(...acknowledgements)
                : null,
              silencedUntil: silences.length ? Math.max(...silences) : null,
            },
          ]
        }
        const [now, appId, printerId] = v as [number, string, string]
        const actions = this.alertActions.filter(
          (entry) => entry.appId === appId,
        )
        const acknowledgements = actions
          .filter((entry) => entry.action === 'acknowledge')
          .map((entry) => entry.actedAt)
        const silences = actions.flatMap((entry) =>
          entry.silencedUntil === null ? [] : [entry.silencedUntil],
        )
        const acknowledgedAt = acknowledgements.length
          ? Math.min(...acknowledgements)
          : null
        const silencedUntil = silences.length ? Math.max(...silences) : null
        return printerId === ids.printerA1
          ? [
              {
                id: ids.alertA,
                kind: 'error',
                label: 'Erro',
                message: 'Impressora em estado de erro.',
                openedAt: this.clock,
                resolvedAt: null,
                acknowledgedAt,
                silencedUntil,
                needsAttention:
                  acknowledgedAt === null &&
                  (silencedUntil === null || silencedUntil <= now),
              },
            ]
          : []
      }
      if (text.includes('farm.connector_heartbeats')) {
        if (!this.cameraEnabled) return []
        return [
          {
            health: {
              connector: {
                version: 'fixture',
                uptimeMs: 1,
                queueBacklog: 0,
                storage: 'healthy',
                rtcScope: 'lan',
              },
              printers: [],
              cameraAssignments: [ids.printerA1],
            },
          },
        ]
      }
      if (text.includes('farm.telemetry_events')) {
        if (this.telemetryFixture) {
          if (text.includes("'printer-transition'"))
            return this.telemetryFixture.transitions.map((payload) => ({
              payload,
            }))
          if (text.includes('DESC, event_id DESC LIMIT 1')) return []
          return this.telemetryFixture.states.map((payload) => ({ payload }))
        }
        if (!text.includes("'printer-state'") || !text.includes('LIMIT ?'))
          return []
        const [farmId, agentId, printerKey, since, until] = v
        return this.authStore.printers
          .filter(
            (row) =>
              row.farmId === farmId &&
              row.agentId === agentId &&
              row.printerKey === printerKey &&
              row.observedAt !== null &&
              row.observedAt >= Number(since) &&
              row.observedAt < Number(until),
          )
          .map((row) => ({ payload: { state: row.state } }))
      }
      if (text.includes('jsonb_array_elements(s.snapshot')) {
        const [farmIds, posFarm, , posConnector, posIndex, limit] = v as [
          string[],
          string | null,
          string | null,
          string | null,
          number | null,
          number,
        ]
        const key = (farm: string, connector: string, index: number) =>
          `${farm}|${connector}|${String(index).padStart(4, '0')}`
        return this.inventory
          .filter((row) => farmIds.includes(row.farmId))
          .flatMap((row) =>
            (row.snapshot as { spools: unknown[] }).spools.map((_, index) => ({
              ...row,
              index,
            })),
          )
          .sort((a, b) =>
            key(a.farmId, a.connectorId, a.index).localeCompare(
              key(b.farmId, b.connectorId, b.index),
            ),
          )
          .filter(
            (row) =>
              posFarm === null ||
              key(row.farmId, row.connectorId, row.index) >
                key(posFarm, posConnector ?? '', posIndex ?? 0),
          )
          .slice(0, limit)
      }
      if (text.includes('farm.spool_usage_records')) {
        const [farmIds, jobId, cursor, , limit] = v as [
          string[],
          string,
          string | null,
          unknown,
          number,
        ]
        return this.spoolUsage
          .filter((row) => farmIds.includes(row.farmId))
          .filter((row) => row.jobId === jobId)
          .filter((row) => cursor === null || row.usageId > cursor)
          .sort((a, b) => a.usageId.localeCompare(b.usageId))
          .slice(0, limit)
      }
      if (text.includes('farm.spool_slot_assignments')) {
        const farmIds = v.find(Array.isArray) as string[]
        const limit = v.at(-1) as number
        return this.spoolStock
          .filter((row) => farmIds.includes(row.farmId))
          .slice(0, limit)
      }
      if (text.includes('farm.connector_inventory_snapshots')) {
        const [farmIds, posFarm, , posConnector, limit] = v as [
          string[],
          string | null,
          string | null,
          string | null,
          number,
        ]
        return this.inventory
          .filter((row) => farmIds.includes(row.farmId))
          .sort(
            (a, b) =>
              a.farmId.localeCompare(b.farmId) ||
              a.connectorId.localeCompare(b.connectorId),
          )
          .filter(
            (row) =>
              posFarm === null ||
              `${row.farmId}|${row.connectorId}` > `${posFarm}|${posConnector}`,
          )
          .slice(0, limit)
      }
      if (text.includes('farm.resin_ledger_entries')) {
        if (text.includes('ranked')) {
          const [printerIds, limit] = v as [string[], number]
          return this.resinLedger
            .filter((row) => printerIds.includes(row.printerId))
            .sort((a, b) => b.recordedAt - a.recordedAt)
            .slice(0, limit)
        }
        const [farmWide, assignments, farmId, , afterId, , limit] = v as [
          string[],
          string[],
          string | null,
          unknown,
          string | null,
          unknown,
          number,
        ]
        return this.authStore.printers
          .filter(
            (row) =>
              farmWide.includes(row.farmId) || assignments.includes(row.id),
          )
          .filter((row) => farmId === null || row.farmId === farmId)
          .filter((row) => afterId === null || row.id > afterId)
          .filter((row) =>
            this.resinLedger.some((entry) => entry.printerId === row.id),
          )
          .sort((a, b) => a.id.localeCompare(b.id))
          .slice(0, limit)
          .map((row) => ({
            id: row.id,
            farmId: row.farmId,
            printerKey: row.printerKey,
          }))
      }
      if (text.includes('PARTITION BY p.id')) {
        const [printerIds, limit] = v as [string[], number]
        return this.history
          .filter((row) => printerIds.includes(row.printerId))
          .sort((a, b) => b.endedAt - a.endedAt || Number(b.id) - Number(a.id))
          .slice(0, limit)
          .map((row) => ({
            id: row.id,
            printerId: row.printerId,
            outcome: row.outcome,
            endedAt: row.endedAt,
          }))
      }
      if (text.includes('farm.job_history')) {
        const [
          farmWide,
          assignments,
          printerId,
          ,
          since,
          ,
          until,
          ,
          endedAt,
          ,
          id,
          limit,
        ] = v as [
          string[],
          string[],
          string | null,
          unknown,
          number | null,
          unknown,
          number | null,
          unknown,
          number | null,
          unknown,
          string | null,
          number,
        ]
        return this.history
          .filter(
            (row) =>
              farmWide.includes(row.farmId) ||
              assignments.includes(row.printerId),
          )
          .filter((row) => printerId === null || row.printerId === printerId)
          .filter((row) => since === null || row.endedAt >= since)
          .filter((row) => until === null || row.endedAt < until)
          .sort((a, b) => b.endedAt - a.endedAt || Number(b.id) - Number(a.id))
          .filter(
            (row) =>
              endedAt === null ||
              row.endedAt < endedAt ||
              (row.endedAt === endedAt && Number(row.id) < Number(id)),
          )
          .slice(0, limit)
      }
      throw new Error(
        'Unexpected SQL in the contract world: ' + text.slice(0, 80),
      )
    }
    return Object.assign(fn, {
      array: (value: unknown[]) => value,
      begin: async <T>(run: (tx: typeof fn) => Promise<T>) => {
        if (this.faults.has('pool')) throw new Error('pool down')
        return run(fn)
      },
    })
  }

  async queryAgentInbox(
    farmId: string,
    agentId: string,
    query: unknown,
  ): Promise<InboxResult> {
    this.inboxCalls.push({ farmId, agentId, query })
    return this.inbox
  }

  /** Registers an app with one credential and the given grants. */
  addApp(
    grants: {
      farmId?: string
      printerId?: string | null
      scopes: IntegrationScope[]
      requiresApproval?: boolean
    }[],
    options: { sandbox?: boolean } = {},
  ): App {
    const appId = randomUUID()
    const secret = 'ofs_' + randomBytes(32).toString('base64url')
    const app: App = {
      appId,
      clientId: 'ofc_' + randomBytes(18).toString('base64url'),
      secret,
      sandbox: options.sandbox ?? false,
    }
    this.apps.set(appId, app)
    this.authStore.credentials.push({
      id: randomUUID(),
      appId,
      clientId: app.clientId,
      createdAt: 1,
      revokedAt: null,
      secretHash: hashClientSecret(secret),
    })
    for (const grant of grants)
      this.authStore.grants.push({
        id: randomUUID(),
        appId,
        farmId: grant.farmId ?? ids.farmA,
        printerAssignmentId: grant.printerId ?? null,
        scopes: grant.scopes,
        requiresApproval: grant.requiresApproval ?? false,
        createdAt: 1,
        disabledAt: null,
        disabledReason: null,
      })
    return app
  }

  revokeCredential(app: App) {
    for (const credential of this.authStore.credentials)
      if (credential.appId === app.appId) credential.revokedAt = this.clock
  }
  disableGrants(app: App) {
    for (const grant of this.authStore.grants)
      if (grant.appId === app.appId) {
        grant.disabledAt = this.clock
        grant.disabledReason = 'revoked'
      }
  }

  /** Seeds a stored job (and optionally its envelope) for GET /jobs/{id}. */
  seedJob(
    app: App,
    over: Partial<JobRecord> = {},
    envelope?: Partial<EnvelopeRecord>,
  ) {
    const record: JobRecord = {
      ...jobBody,
      id: randomUUID(),
      appId: app.appId,
      grantId: randomUUID(),
      farmId: ids.farmA,
      printerAssignmentId: ids.printerA1,
      idempotencyKey: randomUUID(),
      requestHash: 'hash',
      status: 'submitted',
      createdAt: this.clock,
      updatedAt: this.clock,
      ...over,
    }
    this.jobsStore.jobs.push(record)
    if (envelope) this.seedEnvelope(record.id, 'job', envelope)
    return record
  }
  seedAction(
    app: App,
    over: Partial<ActionRecord> = {},
    envelope?: Partial<EnvelopeRecord>,
  ) {
    const record: ActionRecord = {
      id: randomUUID(),
      appId: app.appId,
      grantId: randomUUID(),
      farmId: ids.farmA,
      printerAssignmentId: ids.printerA1,
      idempotencyKey: randomUUID(),
      requestHash: 'hash',
      action: { action: 'pause', args: {} } as ActionRecord['action'],
      requiredScope: 'control:basic',
      status: 'submitted',
      createdAt: this.clock,
      updatedAt: this.clock,
      ...over,
    }
    this.actionsStore.actions.push(record)
    if (envelope) this.seedEnvelope(record.id, 'action', envelope)
    return record
  }
  private seedEnvelope(
    resourceId: string,
    kind: 'job' | 'action',
    over: Partial<EnvelopeRecord>,
  ) {
    const record: EnvelopeRecord = {
      cmdId: randomUUID(),
      appId: '',
      grantId: '',
      farmId: ids.farmA,
      agentId: ids.agentA,
      printerAssignmentId: ids.printerA1,
      kind,
      resourceId,
      requiredScope: kind === 'job' ? 'jobs:start' : 'control:basic',
      nonce: 'nonce',
      wire: 'wire',
      issuedAt: this.clock,
      expiresAt: this.clock + 300_000,
      status: 'delivered',
      refusalCode: null,
      resultDetail: null,
      historyEntryId: null,
      createdAt: this.clock,
      updatedAt: this.clock,
      ...over,
    }
    this.envelopes.rows.set(record.cmdId, record)
  }
}

let active = new World()
export const currentWorld = () => active
export function freshWorld() {
  active = new World()
  return active
}
export const sha256Hex = (text: string) =>
  createHash('sha256').update(text).digest('hex')
