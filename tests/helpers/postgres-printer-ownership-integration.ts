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
    foreignAgent = randomUUID(),
    cappedAgent = randomUUID()
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
    [cappedAgent, farmId],
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
  const sqlState = (code: string) => (error: unknown) =>
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    error.code === code
  await assert.rejects(
    runtime`UPDATE farm.connector_enrollments SET status='revoked' WHERE agent_id=${agentId}::uuid`,
    sqlState('42501'),
  )
  await assert.rejects(
    runtime`DELETE FROM farm.printer_assignments`,
    sqlState('42501'),
  )
  assert.equal(
    (
      await admin`SELECT status FROM farm.connector_enrollments WHERE agent_id=${agentId}::uuid`
    )[0]?.status,
    'approved',
  )
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
  // Exact Unicode and whitespace keys are distinct, with no normalization.
  for (const variant of [
    'é',
    'e\u0301',
    'Printer',
    'printer',
    'printer ',
    '😀'.repeat(64),
  ]) {
    assert.equal(
      (await service.register({ ...request, printerKey: variant })).ok,
      true,
    )
    const rows =
      await admin`SELECT printer_key FROM farm.printer_assignments WHERE farm_id=${farmId}::uuid AND printer_key=${variant} AND revoked_at IS NULL`
    assert.equal(rows.length, 1)
    assert.equal(rows[0]?.printer_key, variant)
  }
  // Seed one below the API cap; concurrent registrations for this enrollment
  // must serialize and leave exactly 1,000 live rows.
  await admin`INSERT INTO farm.printer_assignments (id,farm_id,agent_id,printer_key,created_at,created_by) SELECT md5('cap-' || n::text || ${cappedAgent})::uuid, ${farmId}::uuid, ${cappedAgent}::uuid, 'cap-' || n::text, ${now}, ${owner} FROM generate_series(1,999) n`
  const capped = await Promise.all([
    service.register({ ...request, agentId: cappedAgent, printerKey: 'cap-a' }),
    service.register({
      ...request,
      sessionRecordId: ownerPeer,
      agentId: cappedAgent,
      printerKey: 'cap-b',
    }),
  ])
  assert.equal(capped.filter((result) => result.ok).length, 1)
  assert.equal(
    capped.filter((result) => !result.ok && result.reason === 'denied').length,
    1,
  )
  assert.equal(
    Number(
      (
        await admin`SELECT count(*)::int AS n FROM farm.printer_assignments WHERE agent_id=${cappedAgent}::uuid AND revoked_at IS NULL`
      )[0]?.n,
    ),
    1000,
  )
  assert.deepEqual(
    await service.register({
      ...request,
      agentId: cappedAgent,
      printerKey: 'cap-c',
    }),
    { ok: false, reason: 'denied' },
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
  if (!first.ok) throw new Error('Missing first assignment')
  assert.equal(
    (
      await service.revoke({
        ...request,
        expectedAssignmentId: first.assignmentId,
      })
    ).ok,
    true,
  )
  const sameAgentReplacement = await service.register(request)
  assert.equal(sameAgentReplacement.ok, true)
  assert.deepEqual(
    await service.revoke({
      ...request,
      expectedAssignmentId: first.assignmentId,
    }),
    { ok: true, assignmentId: first.assignmentId, status: 'revoked' },
  )
  if (!sameAgentReplacement.ok) throw new Error('Missing replacement')
  assert.equal(
    (
      await admin`SELECT revoked_at FROM farm.printer_assignments WHERE id=${sameAgentReplacement.assignmentId}::uuid`
    )[0]?.revoked_at,
    null,
  )
  assert.equal(
    (
      await service.revoke({
        ...request,
        expectedAssignmentId: sameAgentReplacement.assignmentId,
      })
    ).ok,
    true,
  )
  const replacement = await service.register({ ...request, agentId: agent2 })
  assert.equal(replacement.ok, true)
  if (!first.ok || !replacement.ok) throw new Error('Missing assignment')
  assert.notEqual(first.assignmentId, replacement.assignmentId)
  assert.notEqual(
    (
      await admin`SELECT revoked_at FROM farm.printer_assignments WHERE id=${first.assignmentId}::uuid`
    )[0]?.revoked_at,
    null,
  )
  await assert.rejects(
    admin`UPDATE farm.printer_assignments SET revoked_at=NULL,revoked_by=NULL WHERE id=${first.ok ? first.assignmentId : randomUUID()}::uuid`,
    sqlState('P0001'),
  )
  await assert.rejects(
    admin`DELETE FROM farm.printer_assignments WHERE id=${first.assignmentId}::uuid`,
    sqlState('P0001'),
  )
  await assert.rejects(
    admin`TRUNCATE farm.printer_assignments`,
    sqlState('P0001'),
  )
  assert.notEqual(
    (
      await admin`SELECT revoked_at FROM farm.printer_assignments WHERE id=${first.assignmentId}::uuid`
    )[0]?.revoked_at,
    null,
  )
  await admin`UPDATE farm.connector_enrollments SET status='revoked' WHERE agent_id=${agentId}::uuid`
  const accentRows =
    await admin`SELECT id FROM farm.printer_assignments WHERE farm_id=${farmId}::uuid AND agent_id=${agentId}::uuid AND printer_key='é' AND revoked_at IS NULL`
  assert.equal(
    (
      await service.revoke({
        ...request,
        printerKey: 'é',
        expectedAssignmentId: String(accentRows[0]?.id),
      })
    ).ok,
    true,
  )
  assert.equal(
    Number(
      (
        await admin`SELECT count(*)::int AS n FROM farm.printer_assignments WHERE agent_id=${agentId}::uuid AND printer_key='é' AND revoked_at IS NOT NULL`
      )[0]?.n,
    ),
    1,
  )
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
    'active uniqueness, farm isolation and exact UTF-8 keys',
    '999 and 1000 assignment limit under concurrent registration',
    'terminal revocation and reassignment',
    'revoked enrollment and expired session',
  ]
}
