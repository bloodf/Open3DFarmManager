import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import test from 'node:test'
import { decodeApiEnvelopeFrame } from '../../packages/farm-protocol/src/api-envelope.ts'
import { renderFarmComponent } from '../../apps/farm/app/components/farm/render-farm-component.ts'
import {
  APPROVER_ROLES,
  IntegrationApprovalService,
  type ApprovalDecision,
  type DecideOutcome,
  type HeldItem,
  type IntegrationApprovalStore,
} from '../../apps/farm/server/services/integration-approval.ts'
import {
  decideApprovalRequest,
  listApprovalsRequest,
  type ApprovalHttpDeps,
} from '../../apps/farm/server/services/integration-approval-http.ts'
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
  HELD_TTL_MS,
  IntegrationJobsService,
  jobView,
  type CreateJobOutcome,
  type IntegrationJobsStore,
  type JobRecord,
  type NewJob,
} from '../../apps/farm/server/services/integration-jobs.ts'
import type { IntegrationGrant } from '../../apps/farm/server/services/integration-apps.ts'
import type { IntegrationPrincipal } from '../../apps/farm/server/utils/integration-auth.ts'

const T0 = 1_700_000_000_000
const farm = randomUUID()
const agent = randomUUID()
const printer = randomUUID()
const app = randomUUID()
const operator = 'account-operator'
const viewer = 'account-viewer'
const sha = 'ab'.repeat(32)
const body = {
  fileUrl: 'https://files.example.invalid/parts/benchy.gcode',
  sha256: sha,
  sizeBytes: 123456,
  displayName: 'benchy.gcode',
}
const ORIGIN = 'https://farm.example.invalid'

test('approval decision parsing releases the request body reader lock', async () => {
  const body = new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('{"decision":"reject"}'))
      controller.close()
    },
  })
  const request = new Request('https://farm.example.invalid/decision', {
    method: 'POST',
    headers: { origin: ORIGIN, 'content-type': 'application/json' },
    body,
    duplex: 'half',
  } as RequestInit)
  const deps: ApprovalHttpDeps = {
    origin: ORIGIN,
    authenticate: async () => ({ accountId: 'operator' }),
    service: {
      decide: async () => ({ ok: false, problem: 'not-found' }),
    } as unknown as ApprovalHttpDeps['service'],
  }

  await decideApprovalRequest(request, deps, farm, randomUUID())
  assert.equal(body.locked, false)
})

const grant = (requiresApproval: boolean): IntegrationGrant => ({
  id: randomUUID(),
  appId: app,
  farmId: farm,
  printerAssignmentId: printer,
  scopes: ['jobs:start'],
  requiresApproval,
  createdAt: 1,
  disabledAt: null,
  disabledReason: null,
})
const principalOf = (g: IntegrationGrant): IntegrationPrincipal => ({
  appId: app,
  scopes: ['jobs:start'],
  grants: [g],
})

interface AuditRow {
  action: string
  actorKind: string
  actorId: string | null
  resourceId: string | null
  outcome: string
  decision?: string
}

/** One in-memory world shared by the jobs, approval and delivery stores. */
class World {
  clock = { now: T0 }
  jobs: JobRecord[] = []
  grantsOff = new Set<string>()
  envelopeOf = new Map<string, string>()
  audit: AuditRow[] = []
  roles = new Map<string, string>([
    [operator, 'operator'],
    ['account-admin', 'admin'],
    ['account-owner', 'owner'],
    [viewer, 'viewer'],
  ])
  envelopes = new Map<string, EnvelopeRecord>()
  sent: string[] = []
  private chain: Promise<unknown> = Promise.resolve()

  jobsStore: IntegrationJobsStore = {
    target: async (id) =>
      id === printer ? { farmId: farm, agentId: agent } : null,
    get: async () => null,
    create: async (job: NewJob, now): Promise<CreateJobOutcome> => {
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
        action: 'job.submitted',
        actorKind: 'app',
        actorId: record.appId,
        resourceId: record.id,
        outcome: record.status === 'held' ? 'held' : 'accepted',
      })
      return { kind: 'created', record }
    },
  }

  deliveryStore: IntegrationDeliveryStore = {
    insert: async (envelope: NewEnvelope, now): Promise<InsertOutcome> => {
      for (const row of this.envelopes.values())
        if (
          row.kind === envelope.kind &&
          row.resourceId === envelope.resourceId
        )
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
      this.envelopes.set(record.cmdId, record)
      this.envelopeOf.set(record.resourceId, record.cmdId)
      return { kind: 'created', record }
    },
    get: async (id) => this.envelopes.get(id) ?? null,
    listPending: async () => [],
    claim: async (id, now) => {
      const row = this.envelopes.get(id)
      if (!row || row.status !== 'pending' || row.expiresAt <= now) return null
      const next = { ...row, status: 'sending' as const, updatedAt: now }
      this.envelopes.set(id, next)
      return next
    },
    settleUnclaimable: async () => null,
    transition: async (
      id: string,
      from: readonly EnvelopeStatus[],
      to: EnvelopeStatus,
      now: number,
      _result?: EnvelopeResult,
    ) => {
      const row = this.envelopes.get(id)
      if (!row || !from.includes(row.status)) return null
      const next = { ...row, status: to, updatedAt: now }
      this.envelopes.set(id, next)
      return next
    },
    sweep: async () => [],
  }

  approvalStore: IntegrationApprovalStore = {
    list: async (accountId, farmId, now) => {
      if (!APPROVER_ROLES.includes(this.roles.get(accountId) ?? '')) return null
      return this.jobs
        .filter(
          (j) =>
            j.farmId === farmId &&
            j.status === 'held' &&
            now < j.createdAt + HELD_TTL_MS,
        )
        .map((j) => this.itemOf(j))
    },
    decide: ({ accountId, farmId, id, decision, now }) =>
      // Serialised like a row lock: a concurrent decision sees the settled row.
      (this.chain = this.chain.then(() =>
        this.decideNow(accountId, farmId, id, decision, now),
      )) as Promise<DecideOutcome>,
    rejectApproved: async ({ id, now, reason }) => {
      const job = this.jobs.find((row) => row.id === id)
      if (job?.status !== 'submitted') return
      job.status = 'rejected'
      job.updatedAt = now
      this.audit.push({
        action: 'approval.decided',
        actorKind: 'system',
        actorId: null,
        resourceId: id,
        outcome: 'rejected',
        decision: `envelope-issue-${reason}`,
      })
    },
    expireHeld: async (now) => {
      let count = 0
      for (const job of this.jobs)
        if (job.status === 'held' && now >= job.createdAt + HELD_TTL_MS) {
          job.status = 'expired'
          this.audit.push({
            action: 'approval.decided',
            actorKind: 'system',
            actorId: null,
            resourceId: job.id,
            outcome: 'rejected',
            decision: 'expired',
          })
          count += 1
        }
      return count
    },
  }

  private itemOf(job: JobRecord): HeldItem {
    return {
      kind: 'job',
      id: job.id,
      farmId: job.farmId,
      appId: job.appId,
      appName: 'Aplicativo de teste',
      grantId: job.grantId,
      printerAssignmentId: job.printerAssignmentId,
      printerKey: 'printer-a',
      agentId: agent,
      summary: job.displayName,
      createdAt: job.createdAt,
      expiresAt: job.createdAt + HELD_TTL_MS,
      command: {
        kind: 'job',
        job: {
          file_url: job.fileUrl,
          sha256: job.sha256,
          size_bytes: job.sizeBytes,
          display_name: job.displayName,
        },
      },
    }
  }

  private async decideNow(
    accountId: string,
    farmId: string,
    id: string,
    decision: ApprovalDecision,
    now: number,
  ): Promise<DecideOutcome> {
    if (!APPROVER_ROLES.includes(this.roles.get(accountId) ?? ''))
      return { kind: 'forbidden' }
    const job = this.jobs.find((j) => j.id === id && j.farmId === farmId)
    if (!job) return { kind: 'not-found' }
    if (job.status !== 'held') return { kind: 'conflict' }
    const item = this.itemOf(job)
    const log = (actorKind: string, outcome: string, why: string) =>
      this.audit.push({
        action: 'approval.decided',
        actorKind,
        actorId: actorKind === 'owner' ? accountId : null,
        resourceId: id,
        outcome,
        decision: why,
      })
    if (now >= job.createdAt + HELD_TTL_MS) {
      job.status = 'expired'
      log('system', 'rejected', 'expired')
      return { kind: 'expired', item }
    }
    if (decision === 'reject') {
      job.status = 'rejected'
      log('owner', 'rejected', 'rejected')
      return { kind: 'decided', item, decision }
    }
    if (this.grantsOff.has(job.grantId)) {
      job.status = 'rejected'
      log('owner', 'rejected', 'authority-lost')
      return { kind: 'authority-lost', item }
    }
    job.status = 'submitted'
    log('owner', 'approved', 'approved')
    return { kind: 'decided', item, decision }
  }
}

async function fixture(options: { signer?: boolean } = {}) {
  const world = new World()
  const inbox: EnvelopeInbox = {
    sendToAgentInbox: (_farm, _agent, wire) => {
      world.sent.push(wire)
      return 'sent'
    },
  }
  const pair = await crypto.subtle.generateKey('Ed25519', false, [
    'sign',
    'verify',
  ])
  const delivery = new IntegrationDeliveryService({
    store: world.deliveryStore,
    inbox,
    audit: new IntegrationAuditService(
      {
        append: async (v) => ({ ...v, id: '1' }),
        listForOwner: async () => [],
      },
      () => world.clock.now,
    ),
    signer: { kid: 'api-1', signingKey: pair.privateKey },
    now: () => world.clock.now,
  })
  const envelopes =
    options.signer === false
      ? undefined
      : {
          issue: (input: Parameters<typeof delivery.issue>[0]) =>
            delivery.issue(input),
          deliver: (id: string) => delivery.deliver(id),
          get: (id: string) => world.deliveryStore.get(id),
        }
  const submit = new IntegrationJobsService({
    store: world.jobsStore,
    ...(envelopes ? { envelopes } : {}),
    now: () => world.clock.now,
  })
  const approvals = new IntegrationApprovalService({
    store: world.approvalStore,
    ...(envelopes ? { envelopes } : {}),
    now: () => world.clock.now,
  })
  return { world, submit, approvals }
}

async function held(f: Awaited<ReturnType<typeof fixture>>, key = 'k-1') {
  const result = await f.submit.submit(
    principalOf(grant(true)),
    printer,
    key,
    body,
  )
  assert.ok(result.ok)
  assert.equal(result.job.status, 'held')
  return result.job.id
}

test('a grant without the requirement skips approval and delivers at once', async () => {
  const f = await fixture()
  const result = await f.submit.submit(
    principalOf(grant(false)),
    printer,
    'k',
    body,
  )
  assert.ok(result.ok)
  assert.equal(result.job.status, 'queued')
  assert.equal(f.world.sent.length, 1)
  assert.deepEqual(await f.approvals.list(operator, farm), {
    ok: true,
    items: [],
  })
})

test('a held job is listed, never delivered while held, and carries no file reference', async () => {
  const f = await fixture()
  const id = await held(f)
  assert.equal(f.world.sent.length, 0)
  assert.equal(f.world.envelopes.size, 0)
  const listed = await f.approvals.list(operator, farm)
  assert.ok(listed.ok)
  assert.equal(listed.items.length, 1)
  assert.equal(listed.items[0]!.id, id)
  assert.equal(listed.items[0]!.summary, 'benchy.gcode')
  const text = JSON.stringify(listed.items)
  assert.ok(!text.includes('files.example.invalid'))
  assert.ok(
    !('command' in listed.items[0]!) && !('agentId' in listed.items[0]!),
  )
})

test('approval releases the job to the delivery path exactly once', async () => {
  const f = await fixture()
  const id = await held(f)
  const result = await f.approvals.decide(operator, farm, id, 'approve')
  assert.ok(result.ok)
  assert.equal(result.result.status, 'queued')
  assert.equal(f.world.sent.length, 1)
  const frame = decodeApiEnvelopeFrame(f.world.sent[0]!)
  assert.equal(frame.envelope.kind, 'job')
  assert.equal(frame.envelope.resource_id, id)
  assert.equal(frame.envelope.job?.display_name, 'benchy.gcode')
  // A second approval, a rejection after approval and a replay change nothing.
  assert.deepEqual(await f.approvals.decide(operator, farm, id, 'approve'), {
    ok: false,
    problem: 'conflict',
  })
  assert.deepEqual(await f.approvals.decide(operator, farm, id, 'reject'), {
    ok: false,
    problem: 'conflict',
  })
  assert.equal(f.world.sent.length, 1)
  assert.equal(f.world.envelopes.size, 1)
  assert.deepEqual(
    (await f.approvals.list(operator, farm)).ok &&
      (await f.approvals.list(operator, farm)),
    {
      ok: true,
      items: [],
    },
  )
})

test('concurrent approvals deliver once', async () => {
  const f = await fixture()
  const id = await held(f)
  const results = await Promise.all(
    Array.from({ length: 5 }, () =>
      f.approvals.decide(operator, farm, id, 'approve'),
    ),
  )
  assert.equal(results.filter((r) => r.ok).length, 1)
  assert.ok(
    results
      .filter((r) => !r.ok)
      .every((r) => !r.ok && r.problem === 'conflict'),
  )
  assert.equal(f.world.sent.length, 1)
  assert.equal(f.world.envelopes.size, 1)
})

test('a rejected job is never delivered and cannot be approved later', async () => {
  const f = await fixture()
  const id = await held(f)
  const result = await f.approvals.decide(operator, farm, id, 'reject')
  assert.ok(result.ok)
  assert.equal(result.result.status, 'rejected')
  assert.deepEqual(await f.approvals.decide(operator, farm, id, 'approve'), {
    ok: false,
    problem: 'conflict',
  })
  assert.equal(f.world.sent.length, 0)
  assert.equal(f.world.envelopes.size, 0)
  const record = f.world.jobs[0]!
  assert.equal(jobView(record, null).status, 'rejected')
})

test('an expired job is never delivered, whether decided late or swept', async () => {
  const f = await fixture()
  const late = await held(f, 'late')
  const swept = await held(f, 'swept')
  f.world.clock.now = T0 + HELD_TTL_MS
  // Expired items are no longer offered, and the API reports them expired.
  assert.deepEqual(await f.approvals.list(operator, farm), {
    ok: true,
    items: [],
  })
  assert.equal(
    jobView(
      f.world.jobs.find((j) => j.id === late)!,
      null,
      f.world.clock.now,
    ).status,
    'expired',
  )
  assert.deepEqual(await f.approvals.decide(operator, farm, late, 'approve'), {
    ok: false,
    problem: 'expired',
  })
  assert.equal(await f.approvals.sweep(), 1)
  assert.deepEqual(await f.approvals.decide(operator, farm, swept, 'approve'), {
    ok: false,
    problem: 'conflict',
  })
  assert.equal(f.world.sent.length, 0)
  assert.equal(f.world.envelopes.size, 0)
  assert.ok(f.world.jobs.every((j) => j.status === 'expired'))
})

test('the last instant before expiry can still be approved', async () => {
  const f = await fixture()
  const id = await held(f)
  f.world.clock.now = T0 + HELD_TTL_MS - 1
  const result = await f.approvals.decide(operator, farm, id, 'approve')
  assert.ok(result.ok)
  assert.equal(f.world.sent.length, 1)
})

test('a viewer cannot list, approve or reject', async () => {
  const f = await fixture()
  const id = await held(f)
  assert.deepEqual(await f.approvals.list(viewer, farm), {
    ok: false,
    problem: 'forbidden',
  })
  for (const decision of ['approve', 'reject'])
    assert.deepEqual(await f.approvals.decide(viewer, farm, id, decision), {
      ok: false,
      problem: 'forbidden',
    })
  assert.deepEqual(await f.approvals.decide('stranger', farm, id, 'approve'), {
    ok: false,
    problem: 'forbidden',
  })
  assert.equal(f.world.jobs[0]!.status, 'held')
  assert.equal(f.world.sent.length, 0)
  // Owner, admin and operator hold control rights.
  for (const account of ['account-owner', 'account-admin'])
    assert.ok((await f.approvals.list(account, farm)).ok)
})

test('decisions are audited with the deciding account', async () => {
  const f = await fixture()
  const approved = await held(f, 'a')
  const rejected = await held(f, 'r')
  await f.approvals.decide(operator, farm, approved, 'approve')
  await f.approvals.decide('account-admin', farm, rejected, 'reject')
  await f.approvals.decide(viewer, farm, approved, 'approve')
  const decided = f.world.audit.filter((e) => e.action === 'approval.decided')
  assert.deepEqual(decided, [
    {
      action: 'approval.decided',
      actorKind: 'owner',
      actorId: operator,
      resourceId: approved,
      outcome: 'approved',
      decision: 'approved',
    },
    {
      action: 'approval.decided',
      actorKind: 'owner',
      actorId: 'account-admin',
      resourceId: rejected,
      outcome: 'rejected',
      decision: 'rejected',
    },
  ])
})

test('approval is refused when the grant lost authority while held', async () => {
  const f = await fixture()
  const id = await held(f)
  f.world.grantsOff.add(f.world.jobs[0]!.grantId)
  assert.deepEqual(await f.approvals.decide(operator, farm, id, 'approve'), {
    ok: false,
    problem: 'authority-lost',
  })
  assert.equal(f.world.jobs[0]!.status, 'rejected')
  assert.equal(f.world.sent.length, 0)
})

test('failed envelope issue terminally rejects an approved item', async () => {
  const f = await fixture()
  const id = await held(f)
  const service = f.approvals as unknown as {
    o: { envelopes: { issue: () => Promise<{ ok: false; reason: 'refused' }> } }
  }
  service.o.envelopes.issue = async () => ({ ok: false, reason: 'refused' })
  assert.deepEqual(await f.approvals.decide(operator, farm, id, 'approve'), {
    ok: true,
    result: { kind: 'job', id, decision: 'approve', status: 'rejected' },
  })
  assert.equal(f.world.jobs.find((job) => job.id === id)?.status, 'rejected')
  assert.deepEqual(await f.approvals.decide(operator, farm, id, 'approve'), {
    ok: false,
    problem: 'conflict',
  })
  assert.equal(f.world.audit.at(-1)?.decision, 'envelope-issue-refused')
})

test('without an envelope signer approval is refused and the item stays held; rejection still works', async () => {
  const f = await fixture({ signer: false })
  const id = await held(f)
  assert.deepEqual(await f.approvals.decide(operator, farm, id, 'approve'), {
    ok: false,
    problem: 'service-unavailable',
  })
  assert.equal(f.world.jobs[0]!.status, 'held')
  const rejected = await f.approvals.decide(operator, farm, id, 'reject')
  assert.ok(rejected.ok)
})

test('malformed decisions and ids are refused before any store call', async () => {
  const f = await fixture()
  const id = await held(f)
  for (const decision of [undefined, null, 'APPROVE', 'approved', 1, {}])
    assert.deepEqual(await f.approvals.decide(operator, farm, id, decision), {
      ok: false,
      problem: 'validation-failed',
    })
  assert.deepEqual(
    await f.approvals.decide(operator, farm, 'nope', 'approve'),
    {
      ok: false,
      problem: 'not-found',
    },
  )
  assert.deepEqual(
    await f.approvals.decide(operator, farm, randomUUID(), 'approve'),
    {
      ok: false,
      problem: 'not-found',
    },
  )
  assert.equal(f.world.jobs[0]!.status, 'held')
})

/** A real HTTP server on an ephemeral port in front of the approval handlers. */
async function serve(f: Awaited<ReturnType<typeof fixture>>) {
  const deps = (request: Request): ApprovalHttpDeps => ({
    origin: ORIGIN,
    service: f.approvals,
    authenticate: async () => {
      const account = request.headers.get('x-test-account')
      if (!account) throw new Error('unauthenticated')
      return { accountId: account }
    },
  })
  const server: Server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    const request = new Request(url, {
      method: req.method ?? 'GET',
      headers: req.headers as Record<string, string>,
      body: req.method === 'POST' ? (req as unknown as ReadableStream) : null,
      duplex: 'half',
    } as RequestInit)
    const parts = url.pathname.split('/').filter(Boolean)
    let response: Response
    try {
      response =
        req.method === 'POST'
          ? await decideApprovalRequest(
              request,
              deps(request),
              farm,
              parts[0] ?? '',
            )
          : await listApprovalsRequest(deps(request), farm)
    } catch {
      response = new Response('{}', { status: 401 })
    }
    res.writeHead(response.status, Object.fromEntries(response.headers))
    res.end(Buffer.from(await response.arrayBuffer()))
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  return {
    get: (account: string | null) =>
      fetch(`${base}/`, {
        headers: account ? { 'x-test-account': account } : {},
      }),
    post: (
      id: string,
      account: string | null,
      payload: string,
      headers: Record<string, string> = {},
    ) =>
      fetch(`${base}/${id}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          origin: ORIGIN,
          ...(account ? { 'x-test-account': account } : {}),
          ...headers,
        },
        body: payload,
      }),
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  }
}

test('the HTTP endpoints enforce session, origin, role and body shape', async () => {
  const f = await fixture()
  const id = await held(f)
  const http = await serve(f)
  try {
    assert.equal((await http.get(null)).status, 401)
    assert.equal((await http.get(viewer)).status, 403)
    const list = await http.get(operator)
    assert.equal(list.status, 200)
    assert.equal(list.headers.get('cache-control'), 'no-store')
    assert.equal(((await list.json()) as { items: unknown[] }).items.length, 1)

    const approve = JSON.stringify({ decision: 'approve' })
    assert.equal((await http.post(id, null, approve)).status, 401)
    assert.equal(
      (
        await http.post(id, operator, approve, {
          origin: 'https://evil.example.invalid',
        })
      ).status,
      403,
    )
    assert.equal((await http.post(id, viewer, approve)).status, 403)
    assert.equal(
      (await http.post(id, operator, '{"decision":"maybe"}')).status,
      400,
    )
    assert.equal(
      (await http.post(id, operator, '{"decision":"approve","x":1}')).status,
      400,
    )
    assert.equal((await http.post(id, operator, 'not json')).status, 400)
    assert.equal(
      (await http.post(id, operator, approve, { 'content-type': 'text/plain' }))
        .status,
      400,
    )
    assert.equal(f.world.sent.length, 0)

    const ok = await http.post(id, operator, approve)
    assert.equal(ok.status, 200)
    assert.deepEqual(await ok.json(), {
      kind: 'job',
      id,
      decision: 'approve',
      status: 'queued',
    })
    const again = await http.post(id, operator, approve)
    assert.equal(again.status, 409)
    assert.equal(((await again.json()) as { code: string }).code, 'conflict')
    assert.equal((await http.post(randomUUID(), operator, approve)).status, 404)
    assert.equal(f.world.sent.length, 1)
  } finally {
    await http.close()
  }
})

test('the approval queue renders held items with labelled decisions, or an empty state', async () => {
  const item = {
    kind: 'job' as const,
    id: randomUUID(),
    appName: 'Aplicativo de teste',
    printerKey: 'printer-a',
    summary: 'benchy.gcode',
    createdAt: T0,
    expiresAt: T0 + HELD_TTL_MS,
  }
  const html = await renderFarmComponent('../integrations/ApprovalQueue.vue', {
    items: [item],
  })
  assert.match(html, /Aprovações pendentes/)
  assert.match(html, /benchy\.gcode/)
  assert.match(html, /aria-label="Aprovar benchy\.gcode"/)
  assert.match(html, /aria-label="Rejeitar benchy\.gcode"/)
  assert.doesNotMatch(html, /disabled/)
  const busy = await renderFarmComponent('../integrations/ApprovalQueue.vue', {
    items: [item],
    busyId: item.id,
    message: 'Solicitação rejeitada.',
  })
  assert.match(busy, /disabled/)
  assert.match(busy, /role="status"[^>]*>Solicitação rejeitada\./)
  const empty = await renderFarmComponent('../integrations/ApprovalQueue.vue', {
    items: [],
  })
  assert.match(empty, /Nenhuma solicitação aguardando aprovação\./)
  assert.doesNotMatch(empty, /<button/)
})
