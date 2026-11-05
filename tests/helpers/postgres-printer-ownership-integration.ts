import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import type { Sql } from 'postgres'
import { PostgresPrinterOwnership } from '../../apps/farm/server/storage/postgres-printer-ownership.ts'

/** Caller owns a disposable migrated fixture and restricted runtime connection. */
export async function testPostgresPrinterOwnership(
  admin: Sql,
  runtime: Sql,
): Promise<string[]> {
  let now = 1000000
  const service = new PostgresPrinterOwnership(runtime, () => now)
  const farmId = randomUUID(),
    otherFarm = randomUUID(),
    agentId = randomUUID(),
    agent2 = randomUUID(),
    foreignAgent = randomUUID()
  const owner = randomUUID(),
    ownerPeer = randomUUID(),
    viewer = randomUUID(),
    owner2 = randomUUID()
  const key = 'synthetic-printer'
  const fingerprint = 'SHA256:' + 'A'.repeat(43)
  const spki = 'A'.repeat(59)
  for (const farm of [farmId, otherFarm])
    await admin`INSERT INTO farm.farms (id) VALUES (${farm}::uuid)`
  for (const id of [owner, ownerPeer, viewer, owner2]) {
    await admin`INSERT INTO farm.session_accounts (id) VALUES (${id})`
    await admin`INSERT INTO farm.account_sessions (id,account_id,account_version,created_at,last_seen_at,absolute_expires_at) VALUES (${id},${id},0,${now},${now},${now + 100000})`
  }
  await admin`INSERT INTO farm.memberships (farm_id,account_id,role) VALUES (${farmId}::uuid,${owner},'owner'),(${farmId}::uuid,${ownerPeer},'admin'),(${farmId}::uuid,${viewer},'viewer'),(${otherFarm}::uuid,${owner2},'admin')`
  for (const [agent, farm] of [
    [agentId, farmId],
    [agent2, farmId],
    [foreignAgent, otherFarm],
  ] as const) {
    await admin`INSERT INTO farm.connector_enrollments (agent_id,farm_id,public_key_spki,fingerprint) VALUES (${agent}::uuid,${farm}::uuid,${spki},${fingerprint})`
    await admin`UPDATE farm.connector_enrollments SET status='approved' WHERE agent_id=${agent}::uuid`
  }
  const request = {
    sessionRecordId: owner,
    policy: { idleTimeoutMs: 50000 },
    farmId,
    agentId,
    printerKey: key,
  }
  assert.deepEqual(
    await service.register({ ...request, sessionRecordId: viewer }),
    { ok: false, reason: 'denied' },
  )
  assert.deepEqual(
    await service.register({ ...request, agentId: foreignAgent }),
    { ok: false, reason: 'denied' },
  )
  const contenders = await Promise.all([
    service.register({ ...request, printerKey: 'race' }),
    service.register({
      ...request,
      sessionRecordId: ownerPeer,
      agentId: agent2,
      printerKey: 'race',
    }),
  ])
  assert.equal(contenders.filter((result) => result.ok).length, 1)
  assert.equal(
    contenders.filter((result) => !result.ok && result.reason === 'conflict')
      .length,
    1,
  )
  await assert.rejects(
    runtime`UPDATE farm.connector_enrollments SET status='revoked' WHERE agent_id=${agentId}::uuid`,
  )
  await assert.rejects(runtime`DELETE FROM farm.printer_assignments`)
  let clockReads = 0
  const expiring = new PostgresPrinterOwnership(runtime, () =>
    ++clockReads < 3 ? now : now - 1,
  )
  assert.deepEqual(
    await expiring.register({
      ...request,
      sessionRecordId: ownerPeer,
      agentId: agent2,
      printerKey: 'rollback',
    }),
    { ok: false, reason: 'denied' },
  )
  assert.equal(
    Number(
      (
        await admin`SELECT count(*)::int AS n FROM farm.printer_assignments WHERE farm_id=${farmId}::uuid AND printer_key='rollback'`
      )[0]?.n,
    ),
    0,
  )
  const first = await service.register(request)
  assert.equal(first.ok, true)
  assert.deepEqual(await service.register({ ...request, agentId: agent2 }), {
    ok: false,
    reason: 'conflict',
  })
  const foreign = await service.register({
    ...request,
    sessionRecordId: owner2,
    farmId: otherFarm,
    agentId: foreignAgent,
  })
  assert.equal(foreign.ok, true)
  assert.equal((await service.revoke(request)).ok, true)
  assert.equal(
    (await service.register({ ...request, agentId: agent2 })).ok,
    true,
  )
  await assert.rejects(
    admin`UPDATE farm.printer_assignments SET revoked_at=NULL,revoked_by=NULL WHERE id=${first.ok ? first.assignmentId : randomUUID()}::uuid`,
  )
  await admin`UPDATE farm.connector_enrollments SET status='revoked' WHERE agent_id=${agentId}::uuid`
  assert.deepEqual(
    await service.register({ ...request, printerKey: 'other' }),
    { ok: false, reason: 'denied' },
  )
  now += 100001
  assert.deepEqual(
    await service.register({
      ...request,
      agentId: agent2,
      printerKey: 'expired',
    }),
    { ok: false, reason: 'denied' },
  )
  assert.ok(
    (
      await admin`SELECT revoked_at FROM farm.account_sessions WHERE id=${owner}`
    )[0]?.revoked_at !== null,
  )
  return [
    'owner authorization and wrong scope',
    'concurrent unique assignment, rollback and role restrictions',
    'active uniqueness and farm isolation',
    'terminal revocation and reassignment',
    'revoked enrollment and expired session',
  ]
}
