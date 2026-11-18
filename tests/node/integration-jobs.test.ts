import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import test from 'node:test'
import { parse } from 'yaml'
import {
  decodeApiEnvelopeFrame,
  encodeApiEnvelopeResultFrame,
  verifyApiEnvelope,
} from '../../packages/farm-protocol/src/api-envelope.ts'
import { IntegrationAuditService } from '../../apps/farm/server/services/integration-audit.ts'
import {
  IntegrationDeliveryService,
  type EnvelopeInbox,
  type EnvelopeRecord,
  type EnvelopeResult,
  type EnvelopeStatus,
  type InsertOutcome,
  type IntegrationDeliveryStore,
  type NewEnvelope,
} from '../../apps/farm/server/services/integration-delivery.ts'
import {
  IntegrationJobsService,
  type CreateJobOutcome,
  type IntegrationJobsStore,
  type JobRecord,
  type JobStatus,
  type JobTarget,
  type NewJob,
} from '../../apps/farm/server/services/integration-jobs.ts'
import type { IntegrationGrant } from '../../apps/farm/server/services/integration-apps.ts'
import type { IntegrationPrincipal } from '../../apps/farm/server/utils/integration-auth.ts'
import { integrationPolicy } from '../../apps/farm/server/utils/integration-auth-http.ts'
import { submitIntegrationJobRequest } from '../../apps/farm/server/utils/integration-jobs-http.ts'

const NOW = 1_700_000_000_000
const farm = randomUUID()
const agent = randomUUID()
const printer = randomUUID()
const otherPrinter = randomUUID()
const app = randomUUID()
const sha = 'ab'.repeat(32)
const goodBody = {
  fileUrl: 'https://files.example.invalid/parts/benchy.gcode',
  sha256: sha,
  sizeBytes: 123456,
  displayName: 'benchy.gcode',
}

function grant(over: Partial<IntegrationGrant> = {}): IntegrationGrant {
  return {
    id: randomUUID(),
    appId: app,
    farmId: farm,
    printerAssignmentId: printer,
    scopes: ['jobs:start'],
    requiresApproval: false,
    createdAt: 1,
    disabledAt: null,
    disabledReason: null,
    ...over,
  }
}
const principalOf = (
  grants: IntegrationGrant[],
  scopes: IntegrationPrincipal['scopes'] = ['jobs:start'],
): IntegrationPrincipal => ({ appId: app, scopes, grants })

class MemoryJobs implements IntegrationJobsStore {
  jobs: JobRecord[] = []
  envelopes?: MemoryEnvelopes
  audit: { jobId: string; outcome: string }[] = []
  envelopeOf = new Map<string, string>()
  targets = new Map<string, JobTarget>([
    [printer, { farmId: farm, agentId: agent }],
  ])
  async target(id: string) {
    return this.targets.get(id) ?? null
  }
  async get(id: string, appId: string) {
    const record = this.jobs.find((job) => job.id === id && job.appId === appId)
    if (!record) return null
    const cmdId = this.envelopeOf.get(record.id)
    return {
      record,
      envelope: cmdId ? ((await this.envelopes?.get(cmdId)) ?? null) : null,
    }
  }
  async create(job: NewJob, now: number): Promise<CreateJobOutcome> {
    const found = this.jobs.find(
      (j) => j.appId === job.appId && j.idempotencyKey === job.idempotencyKey,
    )
    if (found)
      return {
        kind: 'existing',
        record: found,
        cmdId: this.envelopeOf.get(found.id) ?? null,
      }
    const record: JobRecord = { ...job, createdAt: now, updatedAt: now }
    this.jobs.push(record)
    this.audit.push({
      jobId: record.id,
      outcome: record.status === 'held' ? 'held' : 'accepted',
    })
    return { kind: 'created', record }
  }
}
class MemoryEnvelopes implements IntegrationDeliveryStore {
  rows = new Map<string, EnvelopeRecord>()
  async insert(envelope: NewEnvelope, now: number): Promise<InsertOutcome> {
    for (const row of this.rows.values())
      if (row.kind === envelope.kind && row.resourceId === envelope.resourceId)
        return { kind: 'existing', record: row }
    const record: EnvelopeRecord = {
      ...envelope,
      status: 'pending',
      refusalCode: null,
      resultDetail: null,
      historyEntryId: null,
      createdAt: now,
      updatedAt: now,
    }
    this.rows.set(record.cmdId, record)
    return { kind: 'created', record }
  }
  async get(cmdId: string) {
    return this.rows.get(cmdId) ?? null
  }
  async listPending(
    farmId: string,
    agentId: string,
    now: number,
    limit: number,
  ) {
    return [...this.rows.values()]
      .filter(
        (r) =>
          r.farmId === farmId &&
          r.agentId === agentId &&
          r.status === 'pending' &&
          r.expiresAt > now,
      )
      .slice(0, limit)
  }
  private set(row: EnvelopeRecord, patch: Partial<EnvelopeRecord>) {
    const next = { ...row, ...patch }
    this.rows.set(row.cmdId, next)
    return next
  }
  async claim(cmdId: string, now: number) {
    const row = this.rows.get(cmdId)
    if (!row || row.status !== 'pending' || row.expiresAt <= now) return null
    return this.set(row, { status: 'sending', updatedAt: now })
  }
  async settleUnclaimable() {
    return null
  }
  async transition(
    cmdId: string,
    from: readonly EnvelopeStatus[],
    to: EnvelopeStatus,
    now: number,
    result: EnvelopeResult = {},
  ) {
    const row = this.rows.get(cmdId)
    if (!row || !from.includes(row.status)) return null
    return this.set(row, {
      status: to,
      updatedAt: now,
      refusalCode: result.refusalCode ?? row.refusalCode,
      resultDetail: result.detail ?? row.resultDetail,
      historyEntryId: result.historyEntryId ?? row.historyEntryId,
    })
  }
  async sweep() {
    return []
  }
}

async function fixture(
  options: { signer?: boolean; maxFileBytes?: number } = {},
) {
  const jobs = new MemoryJobs()
  const envelopes = new MemoryEnvelopes()
  jobs.envelopes = envelopes
  const sent: string[] = []
  const inbox: EnvelopeInbox & { live: boolean } = {
    live: true,
    sendToAgentInbox(_farm, _agent, wire) {
      if (!this.live) return 'no-inbox'
      sent.push(wire)
      return 'sent'
    },
  }
  const pair = await crypto.subtle.generateKey('Ed25519', false, [
    'sign',
    'verify',
  ])
  const delivery = new IntegrationDeliveryService({
    store: envelopes,
    inbox,
    audit: new IntegrationAuditService(
      {
        append: async (v) => ({ ...v, id: '1' }),
        listForOwner: async () => [],
      },
      () => NOW,
    ),
    signer: { kid: 'api-1', signingKey: pair.privateKey },
    now: () => NOW,
  })
  const service = new IntegrationJobsService({
    store: jobs,
    ...(options.signer === false
      ? {}
      : {
          envelopes: {
            issue: async (input) => {
              const result = await delivery.issue(input)
              if (result.ok && result.created)
                jobs.envelopeOf.set(input.resourceId, result.record.cmdId)
              return result
            },
            deliver: (id) => delivery.deliver(id),
            get: (id) => envelopes.get(id),
          },
        }),
    ...(options.maxFileBytes ? { maxFileBytes: options.maxFileBytes } : {}),
    now: () => NOW,
  })
  return { jobs, envelopes, sent, inbox, delivery, service, pair }
}

/** A real HTTP server on an ephemeral port in front of the request handler. */
async function serve(
  service: IntegrationJobsService,
  principal: IntegrationPrincipal,
) {
  const server: Server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    const request = new Request(url, {
      method: req.method ?? 'POST',
      headers: req.headers as Record<string, string>,
      body: req.method === 'POST' ? (req as unknown as ReadableStream) : null,
      duplex: 'half',
    } as RequestInit)
    const response = await submitIntegrationJobRequest(
      request,
      principal,
      url.pathname.split('/')[2] ?? '',
      service,
      { 'ratelimit-remaining': '29' },
    )
    res.writeHead(response.status, Object.fromEntries(response.headers))
    res.end(Buffer.from(await response.arrayBuffer()))
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  return {
    post: (
      key: string | null,
      body: unknown,
      init: { type?: string | null; raw?: string; id?: string } = {},
    ) =>
      fetch(`${base}/printers/${init.id ?? printer}/jobs`, {
        method: 'POST',
        headers: {
          ...(init.type === null
            ? {}
            : { 'content-type': init.type ?? 'application/json' }),
          ...(key === null ? {} : { 'idempotency-key': key }),
        },
        body: init.raw ?? JSON.stringify(body),
      }),
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  }
}

test('POST /printers/{id}/jobs stores the job and delivers a signed envelope', async () => {
  const f = await fixture()
  const http = await serve(f.service, principalOf([grant()]))
  try {
    const res = await http.post('key-1', goodBody)
    assert.equal(res.status, 202)
    assert.equal(res.headers.get('ratelimit-remaining'), '29')
    const job = (await res.json()) as Record<string, unknown>
    assert.equal(
      res.headers.get('location'),
      `/api/integrations/v1/jobs/${job.id}`,
    )
    assert.deepEqual(Object.keys(job).sort(), [
      'createdAt',
      'displayName',
      'farmId',
      'fileUrl',
      'id',
      'printerId',
      'sha256',
      'sizeBytes',
      'status',
      'updatedAt',
    ])
    assert.equal(job.status, 'queued')
    assert.equal(job.printerId, printer)
    assert.equal(job.farmId, farm)
    assert.equal(f.jobs.jobs.length, 1)
    assert.deepEqual(f.jobs.audit, [{ jobId: job.id, outcome: 'accepted' }])
    // Delivered through the signed envelope path, naming this job.
    assert.equal(f.sent.length, 1)
    const frame = decodeApiEnvelopeFrame(f.sent[0])
    assert.equal(frame.envelope.kind, 'job')
    assert.equal(frame.envelope.resource_id, job.id)
    assert.equal(frame.envelope.app_id, app)
    assert.equal(frame.envelope.agent_id, agent)
    assert.equal(frame.envelope.assignment_id, printer)
    assert.deepEqual(frame.envelope.job, {
      file_url: goodBody.fileUrl,
      sha256: sha,
      size_bytes: goodBody.sizeBytes,
      display_name: goodBody.displayName,
    })
    const verdict = await verifyApiEnvelope(frame.envelope, f.pair.publicKey, {
      farmId: farm,
      agentId: agent,
      now: NOW,
    })
    assert.ok(verdict.ok, 'envelope signature verifies')
  } finally {
    await http.close()
  }
})

test('an idempotent retry returns the same job and delivers once', async () => {
  const f = await fixture()
  const http = await serve(f.service, principalOf([grant()]))
  try {
    const first = (await (await http.post('retry-1', goodBody)).json()) as {
      id: string
    }
    const again = await http.post('retry-1', goodBody)
    assert.equal(again.status, 202)
    const replay = (await again.json()) as { id: string }
    assert.equal(replay.id, first.id)
    assert.equal(f.jobs.jobs.length, 1)
    assert.equal(f.envelopes.rows.size, 1)
    assert.equal(f.sent.length, 1)
    assert.equal(f.jobs.audit.length, 1, 'one audit entry per submission')
    // A different request under the same key is a conflict, never a second job.
    const other = await http.post('retry-1', { ...goodBody, sizeBytes: 7 })
    assert.equal(other.status, 409)
    assert.equal(other.headers.get('content-type'), 'application/problem+json')
    assert.equal(
      ((await other.json()) as { code: string }).code,
      'idempotency-key-reused',
    )
    // The same key and body for another printer is not a replay either.
    const elsewhere = await f.service.submit(
      principalOf([grant({ printerAssignmentId: null })]),
      otherPrinter,
      'retry-1',
      goodBody,
    )
    assert.equal(elsewhere.ok, false)
    // Another key creates another job.
    const next = (await (await http.post('retry-2', goodBody)).json()) as {
      id: string
    }
    assert.notEqual(next.id, first.id)
    assert.equal(f.jobs.jobs.length, 2)
  } finally {
    await http.close()
  }
})

test('a retry after the first call stored the job but never issued its envelope still delivers it', async () => {
  const f = await fixture()
  const principal = principalOf([grant()])
  // Simulate a crash between storing the job and issuing the envelope.
  const withoutEnvelopes = new IntegrationJobsService({
    store: f.jobs,
    now: () => NOW,
  })
  const held = await withoutEnvelopes.submit(
    principalOf([grant({ requiresApproval: true })]),
    printer,
    'crash-1',
    goodBody,
  )
  assert.ok(held.ok)
  f.jobs.jobs[0] = { ...f.jobs.jobs[0]!, status: 'submitted' }
  const replay = await f.service.submit(principal, printer, 'crash-1', goodBody)
  assert.ok(replay.ok)
  assert.equal(replay.created, false)
  assert.equal(replay.job.id, held.job.id)
  assert.equal(f.envelopes.rows.size, 1)
  assert.equal(f.sent.length, 1)
})

test('a job is refused without jobs:start for that printer', async () => {
  const f = await fixture()
  // No jobs:start at all.
  let result = await f.service.submit(
    principalOf([grant({ scopes: ['printers:read'] })], ['printers:read']),
    printer,
    'k',
    goodBody,
  )
  assert.deepEqual(result, { ok: false, problem: 'insufficient-scope' })
  // jobs:start granted for another printer only.
  result = await f.service.submit(
    principalOf([grant({ printerAssignmentId: otherPrinter })]),
    printer,
    'k',
    goodBody,
  )
  assert.deepEqual(result, { ok: false, problem: 'not-found' })
  // jobs:start on another farm only.
  result = await f.service.submit(
    principalOf([grant({ farmId: randomUUID(), printerAssignmentId: null })]),
    printer,
    'k',
    goodBody,
  )
  assert.deepEqual(result, { ok: false, problem: 'not-found' })
  // An unknown or non-UUID printer.
  result = await f.service.submit(
    principalOf([grant()]),
    randomUUID(),
    'k',
    goodBody,
  )
  assert.deepEqual(result, { ok: false, problem: 'not-found' })
  result = await f.service.submit(principalOf([grant()]), 'nope', 'k', goodBody)
  assert.deepEqual(result, { ok: false, problem: 'not-found' })
  assert.equal(f.jobs.jobs.length, 0)
  assert.equal(f.envelopes.rows.size, 0)
  assert.deepEqual(
    integrationPolicy('/printers/' + printer + '/jobs', 'POST')?.scopes,
    ['jobs:start'],
  )
})

test('a farm-wide grant covers every printer on the farm', async () => {
  const f = await fixture()
  const result = await f.service.submit(
    principalOf([grant({ printerAssignmentId: null })]),
    printer,
    'farm-wide',
    goodBody,
  )
  assert.ok(result.ok)
})

test('input is validated: HTTPS only, checksum and size formats, and the body shape', async () => {
  const f = await fixture({ maxFileBytes: 1000 })
  const http = await serve(f.service, principalOf([grant()]))
  try {
    const invalid: [string, unknown][] = [
      [
        'http url',
        { ...goodBody, fileUrl: 'http://files.example.invalid/a.gcode' },
      ],
      [
        'ftp url',
        { ...goodBody, fileUrl: 'ftp://files.example.invalid/a.gcode' },
      ],
      ['file url', { ...goodBody, fileUrl: 'file:///etc/passwd' }],
      ['no scheme', { ...goodBody, fileUrl: 'files.example.invalid/a.gcode' }],
      [
        'userinfo',
        { ...goodBody, fileUrl: 'https://user:pw@files.example.invalid/a' },
      ],
      [
        'whitespace url',
        { ...goodBody, fileUrl: 'https://files.example.invalid/a b' },
      ],
      [
        'long url',
        { ...goodBody, fileUrl: 'https://x.invalid/' + 'a'.repeat(2048) },
      ],
      ['uppercase sha', { ...goodBody, sha256: sha.toUpperCase() }],
      ['short sha', { ...goodBody, sha256: sha.slice(1) }],
      ['non-hex sha', { ...goodBody, sha256: 'z'.repeat(64) }],
      ['numeric sha', { ...goodBody, sha256: 5 }],
      ['zero size', { ...goodBody, sizeBytes: 0 }],
      ['negative size', { ...goodBody, sizeBytes: -1 }],
      ['fractional size', { ...goodBody, sizeBytes: 1.5 }],
      ['string size', { ...goodBody, sizeBytes: '10' }],
      ['over the configured maximum', { ...goodBody, sizeBytes: 1001 }],
      ['empty name', { ...goodBody, displayName: '' }],
      ['control character in name', { ...goodBody, displayName: 'a\nb' }],
      ['long name', { ...goodBody, displayName: 'n'.repeat(256) }],
      ['extra field', { ...goodBody, extra: true }],
      [
        'missing field',
        { fileUrl: goodBody.fileUrl, sha256: sha, sizeBytes: 5 },
      ],
      ['array body', [goodBody]],
      ['null body', null],
    ]
    for (const [name, body] of invalid) {
      const res = await http.post('v-' + name.length, body)
      assert.equal(res.status, 422, name)
      assert.equal(
        ((await res.json()) as { code: string }).code,
        'validation-failed',
        name,
      )
    }
    assert.equal(
      (await http.post('ok-at-max', { ...goodBody, sizeBytes: 1000 })).status,
      202,
    )
    assert.equal(f.jobs.jobs.length, 1, 'only the valid job was stored')
  } finally {
    await http.close()
  }
})

test('the request envelope is validated: content type, idempotency key, JSON and size', async () => {
  const f = await fixture()
  const http = await serve(f.service, principalOf([grant()]))
  try {
    const code = async (res: Response) =>
      ((await res.json()) as { code: string }).code
    let res = await http.post('k', goodBody, { type: 'text/plain' })
    assert.equal(res.status, 415)
    assert.equal(await code(res), 'unsupported-media-type')
    res = await http.post('k', goodBody, { type: null })
    assert.equal(res.status, 415)
    res = await http.post(null, goodBody)
    assert.equal(res.status, 400)
    assert.equal(await code(res), 'invalid-request')
    for (const key of ['', 'has space', 'x'.repeat(129), 'a/b', 'é'])
      assert.equal((await http.post(key || null, goodBody)).status, 400, key)
    res = await http.post('k', null, { raw: '{not json' })
    assert.equal(res.status, 400)
    res = await http.post('k', null, { raw: '' })
    assert.equal(res.status, 400)
    res = await http.post('k', null, {
      raw: JSON.stringify({ ...goodBody, displayName: 'x'.repeat(20_000) }),
    })
    assert.equal(res.status, 413)
    assert.equal(await code(res), 'payload-too-large')
    assert.equal(f.jobs.jobs.length, 0)
  } finally {
    await http.close()
  }
})

test('a grant that requires approval holds the job instead of delivering it', async () => {
  const f = await fixture()
  const result = await f.service.submit(
    principalOf([grant({ requiresApproval: true })]),
    printer,
    'held-1',
    goodBody,
  )
  assert.ok(result.ok)
  assert.equal(result.job.status, 'held')
  assert.equal(f.jobs.jobs[0]!.status, 'held')
  assert.equal(f.envelopes.rows.size, 0)
  assert.equal(f.sent.length, 0)
  assert.deepEqual(f.jobs.audit, [{ jobId: result.job.id, outcome: 'held' }])
  // A retry stays held and still issues nothing.
  const again = await f.service.submit(
    principalOf([grant({ requiresApproval: true })]),
    printer,
    'held-1',
    goodBody,
  )
  assert.ok(again.ok && again.job.id === result.job.id && !again.created)
  assert.equal(f.envelopes.rows.size, 0)
  // Where grants overlap, the one that needs no approval wins.
  const open = await f.service.submit(
    principalOf([
      grant({ requiresApproval: true }),
      grant({ printerAssignmentId: null }),
    ]),
    printer,
    'overlap',
    goodBody,
  )
  assert.ok(open.ok && open.job.status === 'queued')
})

test('without a live inbox the job stays queued and is delivered when the Connector connects', async () => {
  const f = await fixture()
  f.inbox.live = false
  const result = await f.service.submit(
    principalOf([grant()]),
    printer,
    'q-1',
    goodBody,
  )
  assert.ok(result.ok)
  assert.equal(result.job.status, 'queued')
  assert.equal(f.sent.length, 0)
  assert.equal([...f.envelopes.rows.values()][0]!.status, 'pending')
  f.inbox.live = true
  assert.deepEqual(await f.delivery.deliverPending(farm, agent), ['sent'])
  assert.equal(f.sent.length, 1)
})

test('the Connector outcome shows through the job status', async () => {
  const f = await fixture()
  const result = await f.service.submit(
    principalOf([grant()]),
    printer,
    'o-1',
    goodBody,
  )
  assert.ok(result.ok)
  const [row] = [...f.envelopes.rows.values()]
  const report = async (outcome: string, extra: object = {}) => {
    // Results arrive through the delivery service; the job reads them back on retry.
    const wire = encodeApiEnvelopeResultFrame({
      v: 1,
      t: 'api-envelope.result',
      cmd_id: row!.cmdId,
      outcome,
      at: NOW,
      ...extra,
    })

    return f.delivery.recordResult(farm, agent, wire)
  }
  assert.equal(
    await report('refused', {
      refusal_code: 'printer-busy',
      detail: 'busy',
    }),
    'recorded',
  )
  f.jobs.envelopeOf.set(result.job.id, row!.cmdId)
  const outcome = await f.service.get(principalOf([grant()]), result.job.id)
  assert.equal('error' in outcome ? outcome.error : outcome.status, 'refused')
  if (!('error' in outcome)) {
    assert.deepEqual(outcome.refusal, { code: 'printer-busy', detail: 'busy' })
  }
  assert.equal(await report('started'), 'ignored')
  const stillRefused = await f.service.get(
    principalOf([grant()]),
    result.job.id,
  )
  assert.equal(
    'error' in stillRefused ? stillRefused.error : stillRefused.status,
    'refused',
  )
  const replay = await f.service.submit(
    principalOf([grant()]),
    printer,
    'o-1',
    goodBody,
  )
  assert.ok(replay.ok)
  assert.equal(replay.job.status, 'refused')
  assert.deepEqual(replay.job.refusal, { code: 'printer-busy', detail: 'busy' })
})

test('without an envelope signer only held jobs are accepted and nothing is stored otherwise', async () => {
  const f = await fixture({ signer: false })
  const open = await f.service.submit(
    principalOf([grant()]),
    printer,
    's-1',
    goodBody,
  )
  assert.deepEqual(open, { ok: false, problem: 'service-unavailable' })
  assert.equal(f.jobs.jobs.length, 0)
  const held = await f.service.submit(
    principalOf([grant({ requiresApproval: true })]),
    printer,
    's-2',
    goodBody,
  )
  assert.ok(held.ok && held.job.status === 'held')
})

test('a store failure answers 503 problem+json without leaking details', async () => {
  const f = await fixture()
  f.jobs.create = async () => {
    throw new Error('connect ECONNREFUSED secret-host:5432')
  }
  const http = await serve(f.service, principalOf([grant()]))
  try {
    const res = await http.post('boom', goodBody)
    assert.equal(res.status, 503)
    const text = await res.text()
    assert.ok(!text.includes('secret-host'))
    assert.equal(
      (JSON.parse(text) as { code: string }).code,
      'service-unavailable',
    )
  } finally {
    await http.close()
  }
})

test('the server never downloads or stores the file', async () => {
  const f = await fixture()
  const realFetch = globalThis.fetch
  const calls: string[] = []
  globalThis.fetch = (async (input: unknown) => {
    calls.push(String(input))
    throw new Error('no network allowed')
  }) as typeof fetch
  try {
    const result = await f.service.submit(
      principalOf([grant()]),
      printer,
      'nd-1',
      goodBody,
    )
    assert.ok(result.ok)
  } finally {
    globalThis.fetch = realFetch
  }
  assert.deepEqual(calls, [])
  // The stored job is the reference only.
  assert.deepEqual(Object.keys(f.jobs.jobs[0]!).sort(), [
    'appId',
    'createdAt',
    'displayName',
    'farmId',
    'fileUrl',
    'grantId',
    'id',
    'idempotencyKey',
    'printerAssignmentId',
    'requestHash',
    'sha256',
    'sizeBytes',
    'status',
    'updatedAt',
  ])
  for (const path of [
    '../../apps/farm/server/services/integration-jobs.ts',
    '../../apps/farm/server/storage/integration-jobs-postgres.ts',
    '../../apps/farm/server/utils/integration-jobs-http.ts',
    '../../apps/farm/server/utils/integration-jobs-runtime.ts',
    '../../apps/farm/server/api/integrations/v1/printers/[id]/jobs.post.ts',
  ]) {
    const source = readFileSync(new URL(path, import.meta.url), 'utf8')
    assert.doesNotMatch(
      source,
      /\bfetch\s*\(|node:https?|node:net|node:fs|undici|XMLHttpRequest/,
      path,
    )
  }
  const migration = readFileSync(
    new URL(
      '../../infra/db/migrations/0044_integration_jobs.up.sql',
      import.meta.url,
    ),
    'utf8',
  )
  assert.doesNotMatch(migration, /\b(bytea|lo_import|file_content|payload)\b/i)
})

test('the OpenAPI contract describes what the endpoint answers', () => {
  const spec = parse(
    readFileSync(
      new URL('../../docs/api/openapi-v1.yaml', import.meta.url),
      'utf8',
    ),
  ) as {
    paths: Record<
      string,
      { post?: { responses: Record<string, unknown>; security: unknown } }
    >
    components: {
      schemas: Record<
        string,
        { properties: Record<string, { enum?: string[] }>; required: string[] }
      >
    }
  }
  const post = spec.paths['/printers/{printerId}/jobs']?.post
  assert.ok(post)
  assert.ok(
    '202' in post.responses &&
      '409' in post.responses &&
      '422' in post.responses,
  )
  assert.deepEqual(post.security, [{ clientCredentials: ['jobs:start'] }])
  const request = spec.components.schemas.JobRequest!
  assert.deepEqual(Object.keys(request.properties).sort(), [
    'displayName',
    'fileUrl',
    'sha256',
    'sizeBytes',
  ])
  const statuses: JobStatus[] = [
    'held',
    'rejected',
    'queued',
    'expired',
    'delivered',
    'refused',
    'started',
    'completed',
    'cancelled',
    'failed',
    'outcome-unknown',
  ]
  assert.deepEqual(
    spec.components.schemas.Job!.properties.status!.enum,
    statuses,
  )
})
