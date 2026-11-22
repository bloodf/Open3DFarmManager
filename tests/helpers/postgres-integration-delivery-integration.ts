import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import type { Sql } from 'postgres'
import {
  IntegrationDeliveryService,
  type EnvelopeInbox,
} from '../../apps/farm/server/services/integration-delivery.ts'
import { IntegrationAuditService } from '../../apps/farm/server/services/integration-audit.ts'
import { PostgresIntegrationAudit } from '../../apps/farm/server/storage/integration-audit-postgres.ts'
import { PostgresIntegrationDelivery } from '../../apps/farm/server/storage/integration-delivery-postgres.ts'
import { encodeApiEnvelopeResultFrame } from '../../packages/farm-protocol/src/api-envelope.ts'

const denied = async (promise: PromiseLike<unknown>, what: string) => {
  await assert.rejects(Promise.resolve(promise), Error, what)
}

/** Disposable migrated empty database only. Caller owns pools, roles and teardown. */
export async function testPostgresIntegrationDelivery(
  admin: Sql,
  runtime: Sql,
) {
  const checks: string[] = []
  const check = (name: string) => checks.push(name)
  const clock = { now: Date.now() }
  const store = new PostgresIntegrationDelivery(runtime)
  const sent: string[] = []
  const inbox: EnvelopeInbox & { mode: 'sent' | 'no-inbox' | 'throw' } = {
    mode: 'sent',
    sendToAgentInbox(_farm, _agent, wire) {
      if (this.mode === 'throw') throw new Error('socket error')
      if (this.mode === 'no-inbox') return 'no-inbox'
      sent.push(wire)
      return 'sent'
    },
  }
  const pair = await crypto.subtle.generateKey('Ed25519', false, [
    'sign',
    'verify',
  ])
  const service = new IntegrationDeliveryService({
    store,
    inbox,
    audit: new IntegrationAuditService(
      new PostgresIntegrationAudit(admin),
      () => clock.now,
    ),
    signer: { kid: 'api-1', signingKey: pair.privateKey },
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
  ) => {
    const id = randomUUID()
    await admin`INSERT INTO farm.integration_app_grants (id, app_id, farm_id, printer_assignment_id, scopes, created_at, created_by) VALUES (${id}::uuid, ${appId}::uuid, ${farmId}::uuid, ${printer}::uuid, ${scopes}::text[], 1, ${owner})`
    return id
  }
  const printerA = await assignment(farm, 'printer-a')
  const printerB = await assignment(farm, 'printer-b')
  const printerS = await assignment(sandboxFarm, 'printer-s')
  const appId = await app(farm, false)
  const grantId = await grant(appId, farm, ['jobs:start', 'control:basic'])
  const pinnedGrant = await grant(appId, farm, ['jobs:start'], printerA.id)
  const sandboxApp = await app(sandboxFarm, true)
  const sandboxGrant = await grant(sandboxApp, sandboxFarm, ['jobs:start'])

  const job = {
    kind: 'job' as const,
    job: {
      file_url: 'https://files.example.invalid/a.gcode',
      sha256: 'b'.repeat(64),
      size_bytes: 10,
      display_name: 'a.gcode',
    },
  }
  const pause = {
    kind: 'action' as const,
    action: { action: 'pause' as const, args: {} },
  }
  const issue = (
    over: Partial<Parameters<typeof service.issue>[0]> = {},
    command: typeof job | typeof pause = job,
  ) =>
    service.issue({
      appId,
      grantId,
      farmId: farm,
      agentId: printerA.agent,
      printerAssignmentId: printerA.id,
      resourceId: randomUUID(),
      ttlMs: 30_000,
      command,
      ...over,
    })
  const status = async (cmdId: string) =>
    (
      await admin`SELECT status FROM farm.integration_envelopes WHERE cmd_id = ${cmdId}::uuid`
    )[0]?.status
  const must = async (...args: Parameters<typeof issue>) => {
    const result = await issue(...args)
    assert.ok(result.ok, 'issue accepted')
    return result.record
  }

  // The guard: a grant of the app on the farm, the required scope, the right printer and assignment.
  const first = await must()
  assert.equal(first.status, 'pending')
  assert.equal(first.requiredScope, 'jobs:start')
  check('an envelope is stored pending with its signed wire')
  assert.deepEqual(await issue({ resourceId: first.resourceId }), {
    ok: true,
    record: first,
    created: false,
  })
  assert.equal(
    (await admin`SELECT count(*)::int AS n FROM farm.integration_envelopes`)[0]
      ?.n,
    1,
  )
  check('one API resource keeps one envelope')
  const refused = async (
    over: Partial<Parameters<typeof service.issue>[0]>,
    command: typeof job | typeof pause = job,
  ) =>
    assert.deepEqual(await issue(over, command), {
      ok: false,
      reason: 'refused',
    })
  await refused({}, {
    kind: 'action',
    action: { action: 'home', args: { axes: ['x'] } },
  } as never)
  await refused({
    grantId: pinnedGrant,
    printerAssignmentId: printerB.id,
    agentId: printerB.agent,
  })
  await refused({ agentId: printerB.agent })
  await refused({ printerAssignmentId: printerS.id, agentId: printerS.agent })
  await refused({ appId: sandboxApp })
  await refused({
    appId: sandboxApp,
    grantId: sandboxGrant,
    farmId: sandboxFarm,
    agentId: printerA.agent,
    printerAssignmentId: printerA.id,
  })
  await refused({ farmId: sandboxFarm })
  check(
    'scope, grant, printer, agent and farm mismatches are refused by the database',
  )
  assert.ok(
    (
      await issue(
        {
          appId: sandboxApp,
          grantId: sandboxGrant,
          farmId: sandboxFarm,
          agentId: printerS.agent,
          printerAssignmentId: printerS.id,
        },
        job,
      )
    ).ok,
    'a sandbox app reaches its sandbox farm',
  )
  check('a sandbox app only reaches a sandbox farm')

  // At-most-once: concurrent deliveries claim once and write once.
  const racing = await must()
  const before = sent.length
  const outcomes = await Promise.all(
    Array.from({ length: 5 }, () => service.deliver(racing.cmdId)),
  )
  assert.equal(sent.length - before, 1)
  assert.equal(
    outcomes.filter((outcome) => outcome === 'sent').length >= 1,
    true,
  )
  assert.equal(await status(racing.cmdId), 'sent')
  assert.equal(await service.deliver(racing.cmdId), 'sent')
  assert.equal(sent.length - before, 1)
  check('concurrent deliveries write to the inbox once')

  // No inbox: back to pending. Throwing write: unknown and never claimed again.
  clock.now += 1
  inbox.mode = 'no-inbox'
  const waiting = await must()
  assert.equal(await service.deliver(waiting.cmdId), 'no-inbox')
  assert.equal(await status(waiting.cmdId), 'pending')
  inbox.mode = 'throw'
  assert.equal(await service.deliver(waiting.cmdId), 'uncertain')
  assert.equal(await status(waiting.cmdId), 'outcome-unknown')
  inbox.mode = 'sent'
  const written = sent.length
  assert.equal(await service.deliver(waiting.cmdId), 'outcome-unknown')
  assert.equal(sent.length, written)
  check('an uncertain delivery is never resent')

  // Revoked authority is rejected before any write.
  const revoked = await must()
  await admin`UPDATE farm.integration_app_grants SET disabled_at = ${clock.now}, disabled_reason = 'revoked' WHERE id = ${grantId}::uuid`
  assert.equal(await service.deliver(revoked.cmdId), 'rejected')
  assert.equal(sent.length, written)
  assert.deepEqual(await issue(), { ok: false, reason: 'refused' })
  check('a revoked grant rejects a waiting envelope and new ones')

  // Expiry and sweep.
  const expiring = await must({ grantId: pinnedGrant, ttlMs: 1000 })
  const inFlight = await must({ grantId: pinnedGrant, ttlMs: 1000 })
  assert.equal(await service.deliver(inFlight.cmdId), 'sent')
  clock.now += 1000
  assert.equal(await service.deliver(expiring.cmdId), 'expired')
  assert.equal(await service.sweep(), 1)
  assert.equal(await status(inFlight.cmdId), 'outcome-unknown')
  assert.equal(await service.sweep(), 0)
  check('undelivered envelopes expire; unconfirmed ones become unknown')

  // Results through the real store: agent-scoped, forward only, then final.
  const live = await must({ grantId: pinnedGrant })
  assert.equal(await service.deliver(live.cmdId), 'sent')
  const report = (agent: string, cmdId: string, outcome: string, extra = {}) =>
    service.recordResult(
      farm,
      agent,
      encodeApiEnvelopeResultFrame({
        v: 1,
        t: 'api-envelope.result',
        cmd_id: cmdId,
        outcome,
        at: clock.now,
        ...extra,
      }),
    )
  assert.equal(
    await report(printerB.agent, live.cmdId, 'delivered'),
    'unknown-command',
  )
  assert.equal(
    await report(printerA.agent, live.cmdId, 'delivered'),
    'recorded',
  )
  assert.equal(await report(printerA.agent, live.cmdId, 'started'), 'recorded')
  assert.equal(await report(printerA.agent, live.cmdId, 'delivered'), 'ignored')
  assert.equal(
    await report(printerA.agent, live.cmdId, 'completed', {
      history_entry_id: '9007199254740993',
    }),
    'recorded',
  )
  assert.equal(await report(printerA.agent, live.cmdId, 'failed'), 'ignored')
  const stored = (await store.get(live.cmdId))!
  assert.equal(stored.status, 'completed')
  assert.equal(stored.historyEntryId, '9007199254740993')
  check('results are stored for the owning agent, forward only')
  const refusedJob = await must({ grantId: pinnedGrant })
  await service.deliver(refusedJob.cmdId)
  assert.equal(
    await report(printerA.agent, refusedJob.cmdId, 'refused', {
      refusal_code: 'printer-busy',
      detail: 'printing',
    }),
    'recorded',
  )
  const refusedRow = (await store.get(refusedJob.cmdId))!
  assert.deepEqual(
    [refusedRow.status, refusedRow.refusalCode, refusedRow.resultDetail],
    ['refused', 'printer-busy', 'printing'],
  )
  check('a refusal keeps its code and detail')

  // Audit entries exist for sends, results, expiry and unknown outcomes.
  const audit =
    await admin`SELECT outcome, actor_kind, details->>'status' AS status FROM farm.integration_audit WHERE action = 'connector.result' ORDER BY id`
  const seen = new Set(audit.map((row) => `${row.actor_kind}:${row.status}`))
  for (const expected of [
    'system:sent',
    'system:expired',
    'system:outcome-unknown',
    'system:rejected',
    'connector:delivered',
    'connector:completed',
    'connector:refused',
  ])
    assert.ok(seen.has(expected), `audit ${expected}`)
  check('delivery and results are audited')

  // The database enforces the machine for any writer.
  await denied(
    admin`UPDATE farm.integration_envelopes SET status = 'pending' WHERE cmd_id = ${live.cmdId}::uuid`,
    'final status changes',
  )
  await denied(
    admin`UPDATE farm.integration_envelopes SET status = 'sent' WHERE cmd_id = ${expiring.cmdId}::uuid`,
    'expired envelope revives',
  )
  await denied(
    admin`UPDATE farm.integration_envelopes SET wire = 'x' WHERE cmd_id = ${first.cmdId}::uuid`,
    'wire is immutable',
  )
  await denied(
    admin`DELETE FROM farm.integration_envelopes WHERE cmd_id = ${first.cmdId}::uuid`,
    'envelopes are never deleted',
  )
  await denied(admin`TRUNCATE farm.integration_envelopes`, 'no truncate')
  await denied(
    admin`UPDATE farm.integration_envelopes SET kind = 'action', required_scope = 'control:basic' WHERE cmd_id = ${first.cmdId}::uuid`,
    'identity is immutable',
  )
  await denied(
    admin`INSERT INTO farm.integration_envelopes (cmd_id, app_id, grant_id, farm_id, agent_id, printer_assignment_id, kind, resource_id, required_scope, nonce, wire, issued_at, expires_at, status, created_at, updated_at)
      VALUES (${randomUUID()}::uuid, ${appId}::uuid, ${pinnedGrant}::uuid, ${farm}::uuid, ${printerA.agent}::uuid, ${printerA.id}::uuid, 'job', ${randomUUID()}::uuid, 'jobs:start', ${'A'.repeat(22)}, 'w', 1, 2000, 'completed', 1, 1)`,
    'envelopes start pending',
  )
  await denied(
    admin`INSERT INTO farm.integration_envelopes (cmd_id, app_id, grant_id, farm_id, agent_id, printer_assignment_id, kind, resource_id, required_scope, nonce, wire, issued_at, expires_at, created_at, updated_at)
      VALUES (${randomUUID()}::uuid, ${appId}::uuid, ${pinnedGrant}::uuid, ${farm}::uuid, ${printerA.agent}::uuid, ${printerA.id}::uuid, 'job', ${randomUUID()}::uuid, 'jobs:start', ${'B'.repeat(22)}, 'w', 1, 999999, 1, 1)`,
    'lifetime above the maximum',
  )
  await denied(
    admin`INSERT INTO farm.integration_envelopes (cmd_id, app_id, grant_id, farm_id, agent_id, printer_assignment_id, kind, resource_id, required_scope, nonce, wire, issued_at, expires_at, created_at, updated_at)
      VALUES (${randomUUID()}::uuid, ${appId}::uuid, ${pinnedGrant}::uuid, ${farm}::uuid, ${printerA.agent}::uuid, ${printerA.id}::uuid, 'job', ${randomUUID()}::uuid, 'jobs:start', ${'C'.repeat(22)}, ${'w'.repeat(4097)}, 1, 2000, 1, 1)`,
    'wire above the maximum',
  )
  check('the database refuses regressions, edits, deletes and unbounded rows')

  // The least-privilege role cannot rewrite identity or delete.
  await denied(
    runtime`UPDATE farm.integration_envelopes SET wire = 'x'`,
    'runtime role cannot edit the wire',
  )
  await denied(
    runtime`DELETE FROM farm.integration_envelopes`,
    'runtime role cannot delete',
  )
  check('the delivery role is least privilege')
  return checks
}
