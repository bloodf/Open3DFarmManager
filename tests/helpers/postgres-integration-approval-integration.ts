import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import type { Sql } from 'postgres'
import { IntegrationAuditService } from '../../apps/farm/server/services/integration-audit.ts'
import { IntegrationApprovalService } from '../../apps/farm/server/services/integration-approval.ts'
import { IntegrationDeliveryService } from '../../apps/farm/server/services/integration-delivery.ts'
import {
  HELD_TTL_MS,
  IntegrationJobsService,
} from '../../apps/farm/server/services/integration-jobs.ts'
import { PostgresIntegrationApprovals } from '../../apps/farm/server/storage/integration-approval-postgres.ts'
import { PostgresIntegrationAudit } from '../../apps/farm/server/storage/integration-audit-postgres.ts'
import { PostgresIntegrationDelivery } from '../../apps/farm/server/storage/integration-delivery-postgres.ts'
import { PostgresIntegrationJobs } from '../../apps/farm/server/storage/integration-jobs-postgres.ts'
import type { IntegrationPrincipal } from '../../apps/farm/server/utils/integration-auth.ts'

const file = {
  fileUrl: 'https://files.example.invalid/a.gcode',
  sha256: 'cd'.repeat(32),
  sizeBytes: 4096,
  displayName: 'a.gcode',
}

/** Disposable migrated empty database only. Caller owns pools, roles and teardown. */
export async function testPostgresIntegrationApproval(
  admin: Sql,
  runtime: Sql,
) {
  const checks: string[] = []
  const check = (name: string) => checks.push(name)
  // The fixture advances through two held-job lifetimes. Keep those audit writes within the database clock window.
  const clock = { now: Date.now() - 2 * HELD_TTL_MS }
  const sent: string[] = []
  const pair = await crypto.subtle.generateKey('Ed25519', false, [
    'sign',
    'verify',
  ])
  const deliveryStore = new PostgresIntegrationDelivery(runtime)
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
  const envelopes = {
    issue: (input: Parameters<typeof delivery.issue>[0]) =>
      delivery.issue(input),
    deliver: (id: string) => delivery.deliver(id),
    get: (id: string) => deliveryStore.get(id),
  }
  const jobs = new IntegrationJobsService({
    store: new PostgresIntegrationJobs(runtime),
    envelopes,
    maxFileBytes: 1_000_000,
    now: () => clock.now,
  })
  const approvals = new IntegrationApprovalService({
    store: new PostgresIntegrationApprovals(runtime),
    envelopes,
    now: () => clock.now,
  })

  const account = async (role: string | null) => {
    const id = 'acct_' + randomUUID().replaceAll('-', '')
    await admin`INSERT INTO farm.session_accounts (id) VALUES (${id})`
    return { id, role }
  }
  const owner = await account('owner')
  const operator = await account('operator')
  const admins = await account('admin')
  const viewer = await account('viewer')
  const revoked = await account('operator')
  const stranger = await account(null)
  const farm = randomUUID()
  const otherFarm = randomUUID()
  await admin`INSERT INTO farm.farms (id, sandbox) VALUES (${farm}, false), (${otherFarm}, false)`
  for (const member of [owner, operator, admins, viewer, revoked])
    await admin`INSERT INTO farm.memberships (farm_id, account_id, role) VALUES (${farm}::uuid, ${member.id}, ${member.role})`
  await admin`UPDATE farm.memberships SET revoked_at = 1 WHERE farm_id = ${farm}::uuid AND account_id = ${revoked.id}`
  // The operator of one farm holds no rights on another.
  await admin`INSERT INTO farm.memberships (farm_id, account_id, role) VALUES (${otherFarm}::uuid, ${stranger.id}, 'operator')`

  const agent = randomUUID()
  await admin`INSERT INTO farm.connector_enrollments (agent_id, farm_id, public_key_spki, fingerprint) VALUES (${agent}::uuid, ${farm}::uuid, ${'k'.repeat(59)}, ${'approval'.padEnd(50, 'f')})`
  await admin`UPDATE farm.connector_enrollments SET status = 'approved' WHERE agent_id = ${agent}::uuid`
  const printer = randomUUID()
  await admin`INSERT INTO farm.printer_assignments (id, farm_id, agent_id, printer_key, created_at, created_by) VALUES (${printer}::uuid, ${farm}::uuid, ${agent}::uuid, 'printer-a', 1, ${owner.id})`
  const appId = randomUUID()
  await admin`INSERT INTO farm.integration_apps (id, farm_id, name, sandbox, created_at, created_by) VALUES (${appId}::uuid, ${farm}::uuid, 'app', false, 1, ${owner.id})`
  const grant = async (scopes: string[], requiresApproval: boolean) => {
    const id = randomUUID()
    await admin`INSERT INTO farm.integration_app_grants (id, app_id, farm_id, printer_assignment_id, scopes, requires_approval, created_at, created_by) VALUES (${id}::uuid, ${appId}::uuid, ${farm}::uuid, ${printer}::uuid, ${scopes}::text[], ${requiresApproval}, 1, ${owner.id})`
    return id
  }
  const approvalGrant = await grant(['jobs:start', 'control:basic'], true)
  const openGrant = await grant(['jobs:start'], false)
  const principal = (
    grantId: string,
    requiresApproval: boolean,
  ): IntegrationPrincipal => ({
    appId,
    scopes: ['jobs:start'],
    grants: [
      {
        id: grantId,
        appId,
        farmId: farm,
        printerAssignmentId: printer,
        scopes: ['jobs:start'],
        requiresApproval,
        createdAt: 1,
        disabledAt: null,
        disabledReason: null,
      },
    ],
  })
  const submit = async (key: string, over = principal(approvalGrant, true)) => {
    const result = await jobs.submit(over, printer, key, file)
    assert.ok(result.ok)
    return result.job
  }
  const envelopeCount = async (resourceId: string) =>
    (
      await admin`SELECT count(*)::int AS n FROM farm.integration_envelopes WHERE resource_id = ${resourceId}::uuid`
    )[0]?.n as number
  const statusOf = async (table: 'jobs' | 'actions', id: string) =>
    (
      await (table === 'jobs'
        ? admin`SELECT status FROM farm.integration_jobs WHERE id = ${id}::uuid`
        : admin`SELECT status FROM farm.integration_actions WHERE id = ${id}::uuid`)
    )[0]?.status as string
  const decisions = async (id: string) =>
    await admin`SELECT actor_kind, actor_id, outcome, resource_type, details FROM farm.integration_audit WHERE resource_id = ${id} AND action = 'approval.decided' ORDER BY id`

  // A grant that does not require approval never holds anything.
  const open = await submit('open', principal(openGrant, false))
  assert.equal(open.status, 'queued')
  assert.equal(sent.length, 1)
  assert.deepEqual(await approvals.list(operator.id, farm), {
    ok: true,
    items: [],
  })
  check('a grant without the requirement skips approval')

  // Held: stored, listed, never delivered.
  const job = await submit('held-1')
  assert.equal(job.status, 'held')
  assert.equal(await envelopeCount(job.id), 0)
  assert.equal(sent.length, 1)
  const listed = await approvals.list(operator.id, farm)
  assert.ok(listed.ok)
  assert.equal(listed.items.length, 1)
  assert.equal(listed.items[0]?.id, job.id)
  assert.equal(listed.items[0]?.kind, 'job')
  assert.equal(listed.items[0]?.appName, 'app')
  assert.equal(listed.items[0]?.printerKey, 'printer-a')
  assert.equal(listed.items[0]?.summary, 'a.gcode')
  assert.ok(!JSON.stringify(listed.items).includes('files.example.invalid'))
  check('a held job is listed with its app and printer and has no envelope')

  // Roles: control rights decide; viewers, revoked members and other farms do not.
  for (const who of [viewer, revoked, stranger]) {
    assert.deepEqual(await approvals.list(who.id, farm), {
      ok: false,
      problem: 'forbidden',
    })
    for (const decision of ['approve', 'reject'])
      assert.deepEqual(await approvals.decide(who.id, farm, job.id, decision), {
        ok: false,
        problem: 'forbidden',
      })
  }
  assert.equal(await statusOf('jobs', job.id), 'held')
  assert.equal(await envelopeCount(job.id), 0)
  assert.equal((await decisions(job.id)).length, 0)
  for (const who of [owner, admins, operator])
    assert.ok((await approvals.list(who.id, farm)).ok)
  assert.deepEqual(
    await approvals.decide(operator.id, otherFarm, job.id, 'approve'),
    {
      ok: false,
      problem: 'forbidden',
    },
  )
  check('a viewer, a revoked member and another farm cannot list or decide')

  // Approval releases exactly one signed envelope; repeats and races change nothing.
  const approved = await approvals.decide(operator.id, farm, job.id, 'approve')
  assert.ok(approved.ok)
  assert.equal(approved.result.status, 'queued')
  assert.equal(await statusOf('jobs', job.id), 'submitted')
  assert.equal(await envelopeCount(job.id), 1)
  assert.equal(sent.length, 2)
  for (const decision of ['approve', 'reject'])
    assert.deepEqual(
      await approvals.decide(operator.id, farm, job.id, decision),
      {
        ok: false,
        problem: 'conflict',
      },
    )
  assert.equal(sent.length, 2)
  assert.equal(await envelopeCount(job.id), 1)
  const audit = await decisions(job.id)
  assert.equal(audit.length, 1)
  assert.equal(audit[0]?.actor_kind, 'owner')
  assert.equal(audit[0]?.actor_id, operator.id)
  assert.equal(audit[0]?.outcome, 'approved')
  assert.equal(audit[0]?.resource_type, 'job')
  assert.deepEqual(audit[0]?.details, { approvalDecision: 'approved' })
  check('approval delivers exactly once and writes one audit entry')

  const racing = await submit('racing')
  const results = await Promise.all(
    Array.from({ length: 6 }, (_, i) =>
      approvals.decide(
        [operator, admins, owner][i % 3]!.id,
        farm,
        racing.id,
        'approve',
      ),
    ),
  )
  assert.equal(results.filter((r) => r.ok).length, 1)
  assert.ok(
    results
      .filter((r) => !r.ok)
      .every((r) => !r.ok && r.problem === 'conflict'),
  )
  assert.equal(await envelopeCount(racing.id), 1)
  assert.equal(sent.length, 3)
  assert.equal((await decisions(racing.id)).length, 1)
  const mixed = await submit('mixed')
  const duel = await Promise.all([
    approvals.decide(operator.id, farm, mixed.id, 'approve'),
    approvals.decide(admins.id, farm, mixed.id, 'reject'),
  ])
  assert.equal(duel.filter((r) => r.ok).length, 1)
  const mixedStatus = await statusOf('jobs', mixed.id)
  assert.equal(
    await envelopeCount(mixed.id),
    mixedStatus === 'submitted' ? 1 : 0,
  )
  assert.equal((await decisions(mixed.id)).length, 1)
  check('concurrent decisions produce one winner and at most one envelope')

  // Rejection: never delivered, final.
  const rejected = await submit('rejected')
  const rejection = await approvals.decide(
    admins.id,
    farm,
    rejected.id,
    'reject',
  )
  assert.ok(rejection.ok)
  assert.equal(rejection.result.status, 'rejected')
  assert.equal(await statusOf('jobs', rejected.id), 'rejected')
  assert.deepEqual(
    await approvals.decide(operator.id, farm, rejected.id, 'approve'),
    {
      ok: false,
      problem: 'conflict',
    },
  )
  assert.equal(await envelopeCount(rejected.id), 0)
  const rejectedAudit = await decisions(rejected.id)
  assert.equal(rejectedAudit.length, 1)
  assert.equal(rejectedAudit[0]?.actor_id, admins.id)
  assert.equal(rejectedAudit[0]?.outcome, 'rejected')
  await assert.rejects(
    admin`UPDATE farm.integration_jobs SET status = 'submitted' WHERE id = ${rejected.id}::uuid`,
    /Illegal job status change/,
  )
  await assert.rejects(
    admin`UPDATE farm.integration_jobs SET status = 'held' WHERE id = ${job.id}::uuid`,
    /Illegal job status change/,
  )
  check('a rejected job never delivers and its decision is final')

  // Expiry: late decisions and the sweep both end in expired, never delivered.
  const late = await submit('late')
  const swept = await submit('swept')
  const edge = await submit('edge')
  clock.now += HELD_TTL_MS - 1
  const edgeDecision = await approvals.decide(
    operator.id,
    farm,
    edge.id,
    'approve',
  )
  assert.ok(edgeDecision.ok)
  clock.now += 1
  assert.deepEqual(await approvals.list(operator.id, farm), {
    ok: true,
    items: [],
  })
  assert.deepEqual(
    await approvals.decide(operator.id, farm, late.id, 'approve'),
    {
      ok: false,
      problem: 'expired',
    },
  )
  assert.equal(await statusOf('jobs', late.id), 'expired')
  assert.equal(await approvals.sweep(), 1)
  assert.equal(await statusOf('jobs', swept.id), 'expired')
  assert.equal(await approvals.sweep(), 0)
  for (const id of [late.id, swept.id]) {
    assert.deepEqual(await approvals.decide(operator.id, farm, id, 'approve'), {
      ok: false,
      problem: 'conflict',
    })
    assert.equal(await envelopeCount(id), 0)
    const rows = await decisions(id)
    assert.equal(rows.length, 1)
    assert.equal(rows[0]?.actor_kind, 'system')
    assert.deepEqual(rows[0]?.details, { approvalDecision: 'expired' })
  }
  await assert.rejects(
    admin`UPDATE farm.integration_jobs SET status = 'submitted' WHERE id = ${late.id}::uuid`,
    /Illegal job status change/,
  )
  check('expired jobs never deliver, by late decision or sweep')

  // Authority lost while held: approval turns into rejection.
  const stale = await submit('stale')
  await admin`UPDATE farm.integration_app_grants SET disabled_at = 1, disabled_reason = 'revoked' WHERE id = ${approvalGrant}::uuid`
  assert.deepEqual(
    await approvals.decide(operator.id, farm, stale.id, 'approve'),
    {
      ok: false,
      problem: 'authority-lost',
    },
  )
  assert.equal(await statusOf('jobs', stale.id), 'rejected')
  assert.equal(await envelopeCount(stale.id), 0)
  check('approval of an item whose grant was disabled is refused')

  // Held actions take the same path. Re-enable by using a fresh grant.
  const actionGrant = await grant(['control:basic'], true)
  const actionId = randomUUID()
  const insertAction = async (id: string, key: string) =>
    await admin`INSERT INTO farm.integration_actions (id, app_id, grant_id, farm_id, printer_assignment_id, idempotency_key, request_hash, action, required_scope, status, created_at, updated_at) VALUES (${id}::uuid, ${appId}::uuid, ${actionGrant}::uuid, ${farm}::uuid, ${printer}::uuid, ${key}, ${'a'.repeat(64)}, ${admin.json({ action: 'pause', args: {} })}, 'control:basic', 'held', ${clock.now}, ${clock.now})`
  await insertAction(actionId, 'act-1')
  const held = await approvals.list(operator.id, farm)
  assert.ok(held.ok)
  assert.deepEqual(
    held.items.map((i) => [i.kind, i.id, i.summary]),
    [['action', actionId, 'pause']],
  )
  assert.deepEqual(
    await approvals.decide(viewer.id, farm, actionId, 'approve'),
    {
      ok: false,
      problem: 'forbidden',
    },
  )
  const before = sent.length
  const actionApproved = await approvals.decide(
    operator.id,
    farm,
    actionId,
    'approve',
  )
  assert.ok(actionApproved.ok)
  assert.equal(actionApproved.result.kind, 'action')
  assert.equal(await statusOf('actions', actionId), 'submitted')
  assert.equal(await envelopeCount(actionId), 1)
  assert.equal(sent.length, before + 1)
  assert.deepEqual(
    await approvals.decide(operator.id, farm, actionId, 'approve'),
    {
      ok: false,
      problem: 'conflict',
    },
  )
  const actionAudit = await decisions(actionId)
  assert.equal(actionAudit.length, 1)
  assert.equal(actionAudit[0]?.resource_type, 'action')
  const rejectedAction = randomUUID()
  await insertAction(rejectedAction, 'act-2')
  assert.ok(
    (await approvals.decide(operator.id, farm, rejectedAction, 'reject')).ok,
  )
  assert.equal(await statusOf('actions', rejectedAction), 'rejected')
  assert.equal(await envelopeCount(rejectedAction), 0)
  const expiredAction = randomUUID()
  await insertAction(expiredAction, 'act-3')
  clock.now += HELD_TTL_MS
  assert.equal(await approvals.sweep(), 1)
  assert.equal(await statusOf('actions', expiredAction), 'expired')
  assert.equal(await envelopeCount(expiredAction), 0)
  check('held actions are approved once, rejected or expired like jobs')

  // The runtime role can only decide: no direct identity change, no deletion.
  await assert.rejects(
    runtime`UPDATE farm.integration_jobs SET file_url = 'https://other.example.invalid/x' WHERE id = ${job.id}::uuid`,
    Error,
  )
  await assert.rejects(
    runtime`DELETE FROM farm.integration_jobs WHERE id = ${job.id}::uuid`,
    Error,
  )
  check('the runtime role cannot change a job beyond its decision')

  return checks
}
