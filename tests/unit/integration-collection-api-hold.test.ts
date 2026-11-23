// A finished Integration API job holds the bed until confirm_collection.
// Loopback Moonraker only. Nothing here contacts a physical printer.
import { createHash, randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { appendFileSync } from 'node:fs'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { createServer } from 'node:https'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { IntegrationActionsService } from '../../apps/farm/server/services/integration-actions.ts'
import type {
  ActionEnvelopes,
  ActionRecord,
  IntegrationActionsStore,
} from '../../apps/farm/server/services/integration-actions.ts'
import {
  requiredScopeFor,
  type EnvelopeRecord,
  type IssueEnvelope,
} from '../../apps/farm/server/services/integration-delivery.ts'
import type { IntegrationGrant } from '../../apps/farm/server/services/integration-apps.ts'
import type { IntegrationPrincipal } from '../../apps/farm/server/utils/integration-auth.ts'
import {
  getIntegrationPrinterStatus,
  listIntegrationPrinters,
} from '../../apps/farm/server/utils/integration-printers.ts'
import type { IntegrationPrinterRow } from '../../apps/farm/server/utils/integration-auth.ts'
import { startMoonrakerMock } from '../../packages/sim-tools/src/mocks/moonraker-mock.ts'
import {
  API_ENVELOPE_ISSUER,
  encodeApiEnvelopeFrame,
  newApiEnvelopeNonce,
  scopeForApiAction,
  signApiEnvelope,
  type ApiEnvelopeAction,
} from '../../packages/farm-protocol/src/api-envelope.ts'
import {
  closeCommandJournal,
  openCommandJournal,
} from '../../packages/connector/src/control/command-journal.ts'
import type { ControlObservation } from '../../packages/connector/src/control/pause-dispatcher.ts'
import { createPrinterBindingRegistry } from '../../packages/connector/src/control/printer-binding.ts'
import { withCollectionHold } from '../../packages/connector/src/control/queue-collection-hold.ts'
import { openQueueCollectionJournal } from '../../packages/connector/src/control/queue-collection-journal.ts'
import { createApiCommandRunner } from '../../packages/connector/src/runtime/api-command.ts'
import { openApiJobLifecycle } from '../../packages/connector/src/runtime/api-job-lifecycle.ts'
import { createPauseDriverRouter } from '../../packages/connector/src/runtime/pause-driver-router.ts'

function record(resource: string, state: 'created' | 'removed') {
  const ledger = process.env.MOONRAKER_TEST_LEDGER
  if (ledger) appendFileSync(ledger, JSON.stringify({ resource, state }) + '\n')
}

test('an integration client sees the collection hold and releases it', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'integration-collection-api-'))
  record(directory, 'created')
  const journal = openCommandJournal({ directory, clock: Date.now })
  const mock = await startMoonrakerMock({ initial: { state: 'standby' } })
  record(mock.origin, 'created')
  const cert = await readFile(
    new URL('../fixtures/bambu-ftps/cert.pem', import.meta.url),
  )
  const key = await readFile(
    new URL('../fixtures/bambu-ftps/key.pem', import.meta.url),
  )
  const file = Buffer.from('G28\n')
  let fetches = 0
  const source = createServer({ cert, key }, (_req, res) => {
    fetches += 1
    res.end(file)
  })
  source.listen(0, '127.0.0.1')
  await once(source, 'listening')
  const address = source.address()
  if (!address || typeof address === 'string')
    throw new Error('Fixture port missing')
  record(String(address.port), 'created')

  const farmId = randomUUID()
  const agentId = randomUUID()
  const grantId = randomUUID()
  const appId = randomUUID()
  const printerId = randomUUID()
  const printerKey = 'simulated'
  const pair = await crypto.subtle.generateKey('Ed25519', false, [
    'sign',
    'verify',
  ])
  const collection = openQueueCollectionJournal(
    join(directory, 'collection.json'),
  )
  const apiJobs = openApiJobLifecycle({ path: join(directory, 'jobs.json') })
  const clock = { wallNow: Date.now, monotonicNow: () => performance.now() }
  const registry = createPrinterBindingRegistry({
    allowedOrigins: [mock.origin],
  })
  const binding = registry.provision({
    assignment_id: printerId,
    farm_id: farmId,
    agent_id: agentId,
    printer_key: printerKey,
    moonraker_origin: mock.origin,
  })
  let observed: ControlObservation | null = null
  const router = createPauseDriverRouter({
    allowedOrigins: [mock.origin],
    limits: {
      maxMessageBytes: 65536,
      connectTimeoutMs: 2000,
      requestTimeoutMs: 2000,
      staleAfterMs: 5000,
      reconnectMinMs: 100,
      reconnectMaxMs: 1000,
    },
    clock,
    observe(_binding, next) {
      observed = next
      return true
    },
  })
  const driver = withCollectionHold(router, {
    journal: collection,
    printerKey: () => printerKey,
  })
  const envelopesByResource = new Map<string, EnvelopeRecord>()
  let delivers = 0
  const runner = createApiCommandRunner({
    farmId,
    agentId,
    journal,
    driver,
    apiJobs,
    clock,
    keys: { issuer: () => pair.publicKey },
    printer: () => binding,
    observe: () =>
      observed
        ? { ready: observed.ready, printState: observed.printState }
        : null,
    grants: {
      lookup: (id) =>
        id === grantId
          ? {
              grant_id: grantId,
              app_id: appId,
              farm_id: farmId,
              revoked: false,
              scopes: ['jobs:start', 'plates:confirm'],
            }
          : undefined,
      freshness: { freshAt: () => true },
    },
    jobFiles: {
      directory: join(directory, 'staging'),
      ca: cert,
      targetFor: () => ({ backend: 'moonraker', origin: mock.origin }),
    },
    report() {},
  })
  const envelopes: ActionEnvelopes = {
    async issue(input: IssueEnvelope) {
      const issuedAt = Date.now()
      const cmdId = randomUUID()
      const nonce = newApiEnvelopeNonce()
      const signed = await signApiEnvelope(
        {
          v: 1,
          purpose: 'api-envelope',
          issuer: API_ENVELOPE_ISSUER,
          kid: 'test',
          app_id: input.appId,
          grant_id: input.grantId,
          farm_id: input.farmId,
          agent_id: input.agentId,
          assignment_id: input.printerAssignmentId,
          resource_id: input.resourceId,
          cmd_id: cmdId,
          nonce,
          issued_at: issuedAt,
          expires_at: issuedAt + input.ttlMs,
          scope: requiredScopeFor(input.command),
          grant_epoch: issuedAt,
          kind: input.command.kind,
          ...(input.command.kind === 'job'
            ? { job: input.command.job }
            : { action: input.command.action }),
        },
        pair.privateKey,
      )
      const record: EnvelopeRecord = {
        cmdId,
        appId: input.appId,
        grantId: input.grantId,
        farmId: input.farmId,
        agentId: input.agentId,
        printerAssignmentId: input.printerAssignmentId,
        kind: input.command.kind,
        resourceId: input.resourceId,
        requiredScope: requiredScopeFor(input.command),
        nonce,
        wire: encodeApiEnvelopeFrame({
          v: 1,
          t: 'api-envelope.command',
          envelope: signed,
        }),
        issuedAt,
        expiresAt: issuedAt + input.ttlMs,
        status: 'pending',
        refusalCode: null,
        resultDetail: null,
        historyEntryId: null,
        createdAt: issuedAt,
        updatedAt: issuedAt,
      }
      envelopesByResource.set(input.resourceId, record)
      return { ok: true, record, created: true }
    },
    async deliver(cmdId) {
      const record = [...envelopesByResource.values()].find(
        (entry) => entry.cmdId === cmdId,
      )
      if (!record) return 'rejected'
      delivers += 1
      const result = await runner.run(record.wire)
      record.updatedAt = Date.now()
      if (result.kind === 'completed') record.status = 'completed'
      else if (result.kind === 'refused') {
        record.status = 'refused'
        record.refusalCode = result.code
        record.resultDetail = result.detail ?? null
      } else record.status = 'outcome-unknown'
      return record.status
    },
    async get(cmdId) {
      return (
        [...envelopesByResource.values()].find(
          (entry) => entry.cmdId === cmdId,
        ) ?? null
      )
    },
  }
  const stored: ActionRecord[] = []
  const actionsStore: IntegrationActionsStore = {
    async target() {
      const controls = driver.controls(binding)
      return { farmId, agentId, controls: controls ? [...controls] : null }
    },
    async create(action, now) {
      const found = stored.find(
        (entry) =>
          entry.appId === action.appId &&
          entry.idempotencyKey === action.idempotencyKey,
      )
      if (found)
        return {
          kind: 'existing',
          record: found,
          cmdId: envelopesByResource.get(found.id)?.cmdId ?? null,
        }
      const record: ActionRecord = {
        ...action,
        createdAt: now,
        updatedAt: now,
      }
      stored.push(record)
      return { kind: 'created', record }
    },
    async existing(owner, idempotencyKey) {
      const record = stored.find(
        (entry) =>
          entry.appId === owner && entry.idempotencyKey === idempotencyKey,
      )
      return record
        ? { record, envelope: envelopesByResource.get(record.id) ?? null }
        : null
    },
    async get(id, owner) {
      const record = stored.find(
        (entry) => entry.id === id && entry.appId === owner,
      )
      return record
        ? { record, envelope: envelopesByResource.get(record.id) ?? null }
        : null
    },
  }
  const actions = new IntegrationActionsService({
    store: actionsStore,
    envelopes,
  })
  const grant: IntegrationGrant = {
    id: grantId,
    appId,
    farmId,
    printerAssignmentId: null,
    scopes: ['jobs:start', 'plates:confirm', 'printers:read'],
    requiresApproval: false,
    createdAt: 1,
    disabledAt: null,
    disabledReason: null,
  }
  const principal: IntegrationPrincipal = {
    appId,
    scopes: ['jobs:start', 'plates:confirm', 'printers:read'],
    grants: [grant],
  }
  const row: IntegrationPrinterRow = {
    id: printerId,
    farmId,
    agentId,
    printerKey,
    sandbox: false,
    state: { printerKey, state: 'idle' },
    observedAt: null,
  }
  const reader = {
    async readPrinter(id: string) {
      return id === printerId ? row : null
    },
    async readPrinters() {
      return [row]
    },
  }
  const jobWire = async (displayName: string) => {
    const issuedAt = Date.now()
    return encodeApiEnvelopeFrame({
      v: 1,
      t: 'api-envelope.command',
      envelope: await signApiEnvelope(
        {
          v: 1,
          purpose: 'api-envelope',
          issuer: API_ENVELOPE_ISSUER,
          kid: 'test',
          app_id: appId,
          grant_id: grantId,
          farm_id: farmId,
          agent_id: agentId,
          assignment_id: printerId,
          resource_id: randomUUID(),
          cmd_id: randomUUID(),
          nonce: newApiEnvelopeNonce(),
          issued_at: issuedAt,
          expires_at: issuedAt + 60_000,
          scope: 'jobs:start',
          grant_epoch: issuedAt,
          kind: 'job',
          job: {
            file_url: `https://localhost:${address.port}/file`,
            sha256: createHash('sha256').update(file).digest('hex'),
            size_bytes: file.length,
            display_name: displayName,
          },
        },
        pair.privateKey,
      ),
    })
  }
  const confirmWire = async (attempt: string) => {
    const action: ApiEnvelopeAction = {
      action: 'confirm_collection',
      args: { attempt },
    }
    const issuedAt = Date.now()
    return encodeApiEnvelopeFrame({
      v: 1,
      t: 'api-envelope.command',
      envelope: await signApiEnvelope(
        {
          v: 1,
          purpose: 'api-envelope',
          issuer: API_ENVELOPE_ISSUER,
          kind: 'action',
          kid: 'test',
          app_id: appId,
          grant_id: grantId,
          farm_id: farmId,
          agent_id: agentId,
          assignment_id: printerId,
          resource_id: randomUUID(),
          cmd_id: randomUUID(),
          nonce: newApiEnvelopeNonce(),
          issued_at: issuedAt,
          expires_at: issuedAt + 60_000,
          scope: scopeForApiAction(action.action),
          grant_epoch: issuedAt,
          action,
        },
        pair.privateKey,
      ),
    })
  }
  const printStats = async () => {
    const response = await fetch(
      new URL('/printer/objects/query?print_stats=state,filename', mock.origin),
    )
    expect(response.ok).toBe(true)
    const body = (await response.json()) as {
      result: { status: { print_stats: { state: string; filename: string } } }
    }
    return body.result.status.print_stats
  }

  try {
    expect(await driver.detect(binding)).toContain('start_print')
    expect(driver.controls(binding)).toContain('start_print')
    expect(driver.controls(binding)).not.toContain('confirm_collection')

    expect((await runner.run(await jobWire('one.gcode'))).kind).toBe(
      'completed',
    )
    expect(await printStats()).toMatchObject({
      state: 'printing',
      filename: 'one.gcode',
    })
    const fetchedForFirst = fetches
    expect(fetchedForFirst).toBeGreaterThan(0)

    mock.control.completePrint()
    const dispatchedAt = collection.read(printerKey).dispatchedAt
    expect(dispatchedAt).toEqual(expect.any(Number))
    const endedAt = Math.max(Date.now(), dispatchedAt ?? 0)
    collection.finished(printerKey, endedAt)
    const attempt = String(endedAt)
    expect(collection.awaiting(printerKey)).toEqual([attempt])
    expect(driver.controls(binding)).not.toContain('start_print')
    expect(driver.controls(binding)).not.toContain('start_library_print')
    expect(driver.controls(binding)).toContain('confirm_collection')

    row.state = {
      printerKey,
      state: 'idle',
      progress: 0,
      observedAt: endedAt,
      controls: [...driver.controls(binding)],
      lastJob: { outcome: 'completed', endedAt },
    }
    row.observedAt = endedAt
    const status = await getIntegrationPrinterStatus(
      principal,
      reader,
      printerId,
    )
    expect(status).toMatchObject({
      state: 'idle',
      plate: { state: 'awaiting-collection', attemptId: attempt },
    })
    const listed = await listIntegrationPrinters(
      principal,
      reader,
      new URLSearchParams(),
    )
    expect(listed).toMatchObject({
      data: [
        {
          id: printerId,
          controls: expect.not.arrayContaining(['start_print']),
        },
      ],
    })
    if ('data' in listed)
      expect(listed.data[0]?.controls).toContain('confirm_collection')

    expect(await runner.run(await jobWire('two.gcode'))).toMatchObject({
      kind: 'refused',
      code: 'wrong-state',
      detail: 'awaiting-collection',
    })
    expect(fetches).toBe(fetchedForFirst)
    expect(await printStats()).toMatchObject({ state: 'complete' })

    const body = { action: 'confirm_collection', args: { attempt } }
    const denied = await actions.submit(
      { ...principal, scopes: ['control:basic'] },
      printerId,
      'collect-denied',
      body,
    )
    expect(denied).toEqual({ ok: false, problem: 'insufficient-scope' })
    expect(collection.awaiting(printerKey)).toEqual([attempt])

    const released = await actions.submit(
      principal,
      printerId,
      'collect-bed',
      body,
    )
    expect(released.ok).toBe(true)
    if (!released.ok) return
    expect(released.created).toBe(true)
    expect(released.action).toMatchObject({
      action: 'confirm_collection',
      status: 'completed',
      args: { attempt },
    })
    expect(delivers).toBe(1)
    expect(collection.awaiting(printerKey)).toEqual([])
    expect(driver.controls(binding)).toContain('start_print')
    expect(driver.controls(binding)).not.toContain('confirm_collection')

    const replay = await actions.submit(
      principal,
      printerId,
      'collect-bed',
      body,
    )
    expect(replay).toMatchObject({
      ok: true,
      created: false,
      action: { id: released.action.id, status: 'completed' },
    })
    expect(delivers).toBe(1)
    expect(await runner.run(await confirmWire(attempt))).toEqual({
      kind: 'completed',
    })
    expect(collection.awaiting(printerKey)).toEqual([])

    expect((await runner.run(await jobWire('two.gcode'))).kind).toBe(
      'completed',
    )
    expect(fetches).toBeGreaterThan(fetchedForFirst)
    expect(await printStats()).toMatchObject({
      state: 'printing',
      filename: 'two.gcode',
    })
  } finally {
    source.close()
    record(String(address.port), 'removed')
    await mock.close()
    record(mock.origin, 'removed')
    closeCommandJournal(journal)
    await rm(directory, { recursive: true, force: true })
    record(directory, 'removed')
  }
}, 30_000)
