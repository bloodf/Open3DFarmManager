import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import type { Sql } from 'postgres'
import { IntegrationAuditService } from '../../apps/farm/server/services/integration-audit.ts'
import { IntegrationDeliveryService } from '../../apps/farm/server/services/integration-delivery.ts'
import {
  IntegrationJobsService,
  jobRequestHash,
  type NewJob,
} from '../../apps/farm/server/services/integration-jobs.ts'
import { PostgresIntegrationAudit } from '../../apps/farm/server/storage/integration-audit-postgres.ts'
import { PostgresIntegrationDelivery } from '../../apps/farm/server/storage/integration-delivery-postgres.ts'
import { PostgresIntegrationJobs } from '../../apps/farm/server/storage/integration-jobs-postgres.ts'
import { encodeApiEnvelopeResultFrame } from '../../packages/farm-protocol/src/api-envelope.ts'
import type { IntegrationPrincipal } from '../../apps/farm/server/utils/integration-auth.ts'

const denied = async (promise: PromiseLike<unknown>, what: string) => {
  await assert.rejects(Promise.resolve(promise), Error, what)
}
const sha = 'cd'.repeat(32)
const file = {
  fileUrl: 'https://files.example.invalid/a.gcode',
  sha256: sha,
  sizeBytes: 4096,
  displayName: 'a.gcode',
}

/** Disposable migrated empty database only. Caller owns pools, roles and teardown. */
export async function testPostgresIntegrationJobs(admin: Sql, runtime: Sql) {
  const checks: string[] = []
  const check = (name: string) => checks.push(name)
  const clock = { now: 7_000_000 }
  const store = new PostgresIntegrationJobs(runtime)
  const deliveryStore = new PostgresIntegrationDelivery(runtime)
  const sent: string[] = []
  const pair = await crypto.subtle.generateKey('Ed25519', false, [
    'sign',
    'verify',
  ])
  const delivery = new IntegrationDeliveryService({
    store: deliveryStore,
    inbox: {
      sendToAgentInbox(_farm, _agent, wire) {
        sent.push(wire)
        return 'sent'
      },
    },
    audit: new IntegrationAuditService(
      new PostgresIntegrationAudit(runtime),
      () => clock.now,
    ),
    signer: { kid: 'api-1', signingKey: pair.privateKey },
    now: () => clock.now,
  })
  const service = new IntegrationJobsService({
    store,
    envelopes: {
      issue: (input) => delivery.issue(input),
      deliver: (id) => delivery.deliver(id),
      get: (id) => deliveryStore.get(id),
    },
    maxFileBytes: 1_000_000,
    now: () => clock.now,
  })

  const owner = 'owner_' + randomUUID().replaceAll('-', '')
  await admin`INSERT INTO farm.session_accounts (id) VALUES (${owner})`
  const farm = randomUUID()
  const sandboxFarm = randomUUID()
  await admin`INSERT INTO farm.farms (id, sandbox) VALUES (${farm}, false), (${sandboxFarm}, true)`
  const assignment = async (farmId: string, key: string) => {
    const agent = randomUUID()
    await admin`INSERT INTO farm.connector_enrollments (agent_id, farm_id, public_key_spki, fingerprint) VALUES (${agent}::uuid, ${farmId}::uuid, ${'k'.repeat(59)}, ${key.padEnd(50, 'f')})`
    await admin`UPDATE farm.connector_enrollments SET status = 'approved' WHERE agent_id = ${agent}::uuid`
    const id = randomUUID()
    await admin`INSERT INTO farm.printer_assignments (id, farm_id, agent_id, printer_key, created_at, created_by) VALUES (${id}::uuid, ${farmId}::uuid, ${agent}::uuid, ${key}, 1, ${owner})`
    return { agent, id }
  }
  const app = async (farmId: string, sandbox: boolean) => {
    const id = randomUUID()
    await admin`INSERT INTO farm.integration_apps (id, farm_id, name, sandbox, created_at, created_by) VALUES (${id}::uuid, ${farmId}::uuid, 'app', ${sandbox}, 1, ${owner})`
    return id
  }
  const grant = async (
    appId: string,
    farmId: string,
    scopes: string[],
    printer: string | null = null,
    requiresApproval = false,
  ) => {
    const id = randomUUID()
    await admin`INSERT INTO farm.integration_app_grants (id, app_id, farm_id, printer_assignment_id, scopes, requires_approval, created_at, created_by) VALUES (${id}::uuid, ${appId}::uuid, ${farmId}::uuid, ${printer}::uuid, ${scopes}::text[], ${requiresApproval}, 1, ${owner})`
    return id
  }
  const printerA = await assignment(farm, 'printer-a')
  const printerB = await assignment(farm, 'printer-b')
  const printerGone = await assignment(farm, 'printer-gone')
  const appId = await app(farm, false)
  const otherApp = await app(farm, false)
  const openGrant = await grant(appId, farm, ['jobs:start'], printerA.id)
  const approvalGrant = await grant(
    appId,
    farm,
    ['jobs:start'],
    printerB.id,
    true,
  )
  const readOnlyGrant = await grant(appId, farm, ['printers:read'])
  const otherGrant = await grant(otherApp, farm, ['jobs:start'])
  const principal = (
    id: string,
    grantId: string,
    printer: string | null,
    requiresApproval = false,
    scopes: ('jobs:start' | 'printers:read')[] = ['jobs:start'],
  ): IntegrationPrincipal => ({
    appId: id,
    scopes,
    grants: [
      {
        id: grantId,
        appId: id,
        farmId: farm,
        printerAssignmentId: printer,
        scopes,
        requiresApproval,
        createdAt: 1,
        disabledAt: null,
        disabledReason: null,
      },
    ],
  })
  const audit = async (jobId: string) =>
    await admin`SELECT outcome, action, resource_type, actor_kind, actor_id, app_id::text, printer_assignment_id::text, details FROM farm.integration_audit WHERE resource_id = ${jobId} AND action = 'job.submitted'`
  const base = (over: Partial<NewJob> = {}): NewJob => ({
    id: randomUUID(),
    appId,
    grantId: openGrant,
    farmId: farm,
    printerAssignmentId: printerA.id,
    idempotencyKey: 'key-' + randomUUID(),
    requestHash: jobRequestHash(printerA.id, file),
    ...file,
    status: 'submitted',
    ...over,
  })

  // The target printer: active assignments only.
  assert.deepEqual(await store.target(printerA.id), {
    farmId: farm,
    agentId: printerA.agent,
  })
  assert.equal(await store.target(randomUUID()), null)
  assert.equal(await store.target('not-a-uuid'), null)
  check('the target printer resolves its farm and Connector agent')

  // Create stores the job and its audit entry; a retry stores nothing.
  const first = base({ idempotencyKey: 'first' })
  const created = await store.create(first, clock.now)
  assert.ok(created.kind === 'created')
  assert.equal(created.record.fileUrl, file.fileUrl)
  assert.equal(created.record.sizeBytes, file.sizeBytes)
  assert.equal(created.record.status, 'submitted')
  const entries = await audit(first.id)
  assert.equal(entries.length, 1)
  assert.equal(entries[0]?.action, 'job.submitted')
  assert.equal(entries[0]?.resource_type, 'job')
  assert.equal(entries[0]?.outcome, 'accepted')
  assert.equal(entries[0]?.actor_kind, 'app')
  assert.equal(entries[0]?.app_id, appId)
  assert.equal(entries[0]?.printer_assignment_id, printerA.id)
  check('a submission stores the job and one audit entry')
  const replay = await store.create(
    { ...first, id: randomUUID() },
    clock.now + 1,
  )
  assert.ok(replay.kind === 'existing')
  assert.equal(replay.record.id, first.id)
  assert.equal(replay.cmdId, null)
  assert.equal(
    (await admin`SELECT count(*)::int AS n FROM farm.integration_jobs`)[0]?.n,
    1,
  )
  assert.equal((await audit(first.id)).length, 1)
  check('an idempotent retry returns the stored job and writes nothing')
  const otherAppJob = await store.create(
    base({ appId: otherApp, grantId: otherGrant, idempotencyKey: 'first' }),
    clock.now,
  )
  assert.equal(otherAppJob.kind, 'created')
  check('idempotency keys are scoped to the app')

  // Concurrent retries of one key converge on one job and one audit entry.
  const racing = base({ idempotencyKey: 'racing' })
  const races = await Promise.all(
    Array.from({ length: 6 }, () =>
      store.create({ ...racing, id: randomUUID() }, clock.now),
    ),
  )
  assert.equal(races.filter((r) => r.kind === 'created').length, 1)
  assert.equal(
    new Set(races.map((r) => (r.kind === 'refused' ? null : r.record.id))).size,
    1,
  )
  assert.equal(
    (
      await admin`SELECT count(*)::int AS n FROM farm.integration_jobs WHERE idempotency_key = 'racing'`
    )[0]?.n,
    1,
  )
  check('concurrent retries create exactly one job')

  // The database refuses what the grant does not allow.
  const refused = async (job: NewJob, what: string) => {
    assert.deepEqual(
      await store.create(job, clock.now),
      { kind: 'refused' },
      what,
    )
    assert.equal(
      (
        await admin`SELECT count(*)::int AS n FROM farm.integration_jobs WHERE id = ${job.id}::uuid`
      )[0]?.n,
      0,
      what,
    )
    assert.equal((await audit(job.id)).length, 0, what)
  }
  await refused(base({ grantId: readOnlyGrant }), 'a grant without jobs:start')
  await refused(
    base({ printerAssignmentId: printerB.id }),
    'a grant pinned to another printer',
  )
  await refused(
    base({ grantId: approvalGrant, printerAssignmentId: printerB.id }),
    'a grant that requires approval cannot submit directly',
  )
  await refused(
    base({ status: 'held' }),
    'a held job needs a grant that requires approval',
  )
  await refused(base({ appId: otherApp }), "another app's grant")
  await refused(base({ farmId: sandboxFarm }), 'another farm')
  await refused(
    base({ fileUrl: 'http://files.example.invalid/a.gcode' }),
    'a non-HTTPS file URL',
  )
  await refused(base({ sha256: 'AB'.repeat(32) }), 'a malformed checksum')
  await refused(base({ sizeBytes: 0 }), 'a zero size')
  await refused(base({ displayName: 'a\nb' }), 'a control character')
  await refused(base({ idempotencyKey: 'has space' }), 'a malformed key')
  check(
    'scope, printer, farm, approval, URL, checksum, size and key rules are enforced by the database',
  )
  const held = base({
    grantId: approvalGrant,
    printerAssignmentId: printerB.id,
    status: 'held',
    requestHash: jobRequestHash(printerB.id, file),
  })
  assert.equal((await store.create(held, clock.now)).kind, 'created')
  assert.equal((await audit(held.id))[0]?.outcome, 'held')
  check('a job under an approval grant is held and audited as held')

  // Revoked authority.
  const goneGrant = await grant(appId, farm, ['jobs:start'], printerGone.id)
  await admin`UPDATE farm.printer_assignments SET revoked_at = 2 WHERE id = ${printerGone.id}::uuid`
  assert.equal(await store.target(printerGone.id), null)
  await refused(
    base({ grantId: goneGrant, printerAssignmentId: printerGone.id }),
    'a revoked printer',
  )
  const disabledGrant = await grant(appId, farm, ['jobs:start'])
  await admin`UPDATE farm.integration_app_grants SET disabled_at = 2, disabled_reason = 'revoked' WHERE id = ${disabledGrant}::uuid`
  await refused(base({ grantId: disabledGrant }), 'a disabled grant')
  check('a revoked printer or disabled grant refuses new jobs')

  // Least privilege: no change or removal, no authority tables beyond the guarded reads.
  await denied(
    runtime`UPDATE farm.integration_jobs SET status = 'rejected'`,
    'update',
  )
  await denied(runtime`DELETE FROM farm.integration_jobs`, 'delete')
  await denied(runtime`TRUNCATE farm.integration_jobs`, 'truncate')
  await denied(runtime`SELECT * FROM farm.integration_apps`, 'apps')
  await denied(runtime`SELECT * FROM farm.integration_audit`, 'audit read')
  await denied(runtime`DELETE FROM farm.integration_audit`, 'audit delete')
  await denied(
    admin`UPDATE farm.integration_jobs SET file_url = 'https://x.invalid/'`,
    'identity',
  )
  await denied(admin`DELETE FROM farm.integration_jobs`, 'guard delete')
  check('jobs are append-only for the runtime role and immutable to everyone')

  // The service end to end on the real stores.
  const submit = (key: string, printer: string, p: IntegrationPrincipal) =>
    service.submit(p, printer, key, file)
  const openPrincipal = principal(appId, openGrant, printerA.id)
  const live = await submit('svc-1', printerA.id, openPrincipal)
  assert.ok(live.ok && live.created)
  assert.equal(live.job.status, 'queued')
  assert.equal(sent.length, 1)
  const envelope = (
    await admin`SELECT cmd_id::text, status, kind, app_id::text, agent_id::text FROM farm.integration_envelopes WHERE resource_id = ${live.job.id}::uuid`
  )[0]
  assert.equal(envelope?.kind, 'job')
  assert.equal(envelope?.status, 'sent')
  assert.equal(envelope?.app_id, appId)
  assert.equal(envelope?.agent_id, printerA.agent)
  check('a job is stored and handed to the signed envelope path')
  const again = await submit('svc-1', printerA.id, openPrincipal)
  assert.ok(again.ok && !again.created && again.job.id === live.job.id)
  assert.equal(sent.length, 1)
  assert.equal(
    (
      await admin`SELECT count(*)::int AS n FROM farm.integration_envelopes WHERE resource_id = ${live.job.id}::uuid`
    )[0]?.n,
    1,
  )
  assert.equal((await audit(live.job.id)).length, 1)
  assert.deepEqual(
    await service.submit(openPrincipal, printerA.id, 'svc-1', {
      ...file,
      sizeBytes: 5,
    }),
    { ok: false, problem: 'idempotency-key-reused' },
  )
  check('a service retry returns the same job, envelope and audit entry')
  const heldView = await submit(
    'svc-held',
    printerB.id,
    principal(appId, approvalGrant, printerB.id, true),
  )
  assert.ok(heldView.ok)
  assert.equal(heldView.job.status, 'held')
  assert.equal(
    (
      await admin`SELECT count(*)::int AS n FROM farm.integration_envelopes WHERE resource_id = ${heldView.job.id}::uuid`
    )[0]?.n,
    0,
  )
  check('an approval grant holds the job without an envelope')
  assert.deepEqual(
    await submit(
      'svc-scope',
      printerA.id,
      principal(appId, readOnlyGrant, null, false, ['printers:read']),
    ),
    { ok: false, problem: 'insufficient-scope' },
  )
  assert.deepEqual(await submit('svc-other', printerB.id, openPrincipal), {
    ok: false,
    problem: 'not-found',
  })
  check('a missing jobs:start grant for the printer is refused')

  // The Connector's answer reads back through a retry.
  assert.equal(
    await delivery.recordResult(
      farm,
      printerA.agent,
      encodeApiEnvelopeResultFrame({
        v: 1,
        t: 'api-envelope.result',
        cmd_id: envelope?.cmd_id,
        outcome: 'refused',
        refusal_code: 'printer-busy',
        at: clock.now,
      }),
    ),
    'recorded',
  )
  const refusedJob = await submit('svc-1', printerA.id, openPrincipal)
  assert.ok(refusedJob.ok)
  assert.equal(refusedJob.job.status, 'refused')
  assert.equal(refusedJob.job.refusal?.code, 'printer-busy')
  check('the Connector outcome shows on the job')

  // Nothing but the file reference is stored.
  const columns = (
    await admin`SELECT column_name FROM information_schema.columns WHERE table_schema = 'farm' AND table_name = 'integration_jobs'`
  )
    .map((row) => row.column_name as string)
    .sort()
  assert.deepEqual(
    columns,
    [
      'app_id',
      'created_at',
      'display_name',
      'farm_id',
      'file_url',
      'grant_id',
      'id',
      'idempotency_key',
      'printer_assignment_id',
      'request_hash',
      'sha256',
      'size_bytes',
      'status',
      'updated_at',
    ].sort(),
  )
  check('the job row holds a file reference and no file content')
  return checks
}
