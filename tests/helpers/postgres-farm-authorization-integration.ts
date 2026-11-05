import assert from 'node:assert/strict'
import { generateKeyPairSync, randomUUID } from 'node:crypto'
import postgres, { type Sql } from 'postgres'
import { ConnectorIdentity } from '../../packages/connector/src/identity/store.ts'
import {
  PostgresFarmAuthorization,
  type EnrollmentApproval,
} from '../../apps/farm/server/storage/postgres-farm-authorization.ts'
import { PostgresSessionRepository } from '../../apps/farm/server/storage/postgres-session.ts'

/** Dedicated synthetic PostgreSQL only. Caller applies migrations 0001, 0004 and 0006. */
export async function testPostgresFarmAuthorization(
  admin: Sql,
  port: number,
): Promise<string[]> {
  const checks: string[] = []
  const identity = new ConnectorIdentity(
    generateKeyPairSync('ed25519').privateKey,
  )
  await admin`CREATE ROLE farm_approval_fixture LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS IN ROLE farm_enrollment_approver`
  const sql = postgres({
    host: '127.0.0.1',
    port,
    database: 'fixture',
    username: 'farm_approval_fixture',
    max: 4,
    connect_timeout: 3,
    connection: { application_name: 'farm-approval-fixture' },
  })
  const approval = new PostgresFarmAuthorization(sql)
  async function seed(role = 'owner'): Promise<EnrollmentApproval> {
    const id = randomUUID()
    const farmId = randomUUID()
    const agentId = randomUUID()
    await admin`INSERT INTO farm.session_accounts (id) VALUES (${id})`
    await admin`INSERT INTO farm.account_sessions (id, account_id, account_version, created_at, last_seen_at, absolute_expires_at) VALUES (${id}, ${id}, 0, 100, 100, 1000)`
    await admin`INSERT INTO farm.farms (id) VALUES (${farmId}::uuid)`
    await admin`INSERT INTO farm.memberships (farm_id, account_id, role) VALUES (${farmId}::uuid, ${id}, ${role})`
    await admin`INSERT INTO farm.connector_enrollments (farm_id, agent_id, public_key_spki, fingerprint) VALUES (${farmId}::uuid, ${agentId}::uuid, ${identity.publicKeySpki}, ${identity.fingerprint})`
    return {
      sessionRecordId: id,
      farmId,
      agentId,
      expectedFingerprint: identity.fingerprint,
      now: 101,
      policy: { idleTimeoutMs: 100 },
    }
  }
  async function status(input: EnrollmentApproval) {
    return (
      await admin`SELECT status FROM farm.connector_enrollments WHERE agent_id = ${input.agentId}::uuid`
    )[0]?.status
  }
  async function waiting(fragment: string) {
    const start = performance.now()
    while (true) {
      const rows =
        await admin`SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock' AND query LIKE ${'%' + fragment + '%'}`
      if (rows[0]?.n > 0) return
      assert.ok(
        performance.now() - start < 750,
        'Expected lock wait: ' + fragment,
      )
      await new Promise((resolve) => setTimeout(resolve, 5))
    }
  }
  try {
    for (const role of ['owner', 'admin']) {
      const input = await seed(role)
      assert.deepEqual(await approval.approve(input), {
        ok: true,
        accountId: input.sessionRecordId,
        status: 'approved',
      })
      assert.equal((await approval.approve({ ...input, now: 102 })).ok, true)
      assert.equal(
        (
          await admin`SELECT last_seen_at::int AS n FROM farm.account_sessions WHERE id = ${input.sessionRecordId}`
        )[0]?.n,
        102,
      )
      await admin`UPDATE farm.connector_enrollments SET status = 'revoked' WHERE agent_id = ${input.agentId}::uuid`
      assert.deepEqual(await approval.approve({ ...input, now: 103 }), {
        ok: false,
        reason: 'denied',
      })
    }
    for (const role of ['operator', 'viewer']) {
      const input = await seed(role)
      assert.deepEqual(await approval.approve(input), {
        ok: false,
        reason: 'denied',
      })
      assert.equal(await status(input), 'pending')
    }
    checks.push(
      'owner-admin-only-idempotent-approval-and-terminal-enrollment-revocation',
    )
    const farmA = await seed()
    const farmB = await seed()
    assert.deepEqual(
      await approval.approve({
        ...farmB,
        sessionRecordId: farmA.sessionRecordId,
      }),
      { ok: false, reason: 'denied' },
    )
    assert.equal(await status(farmB), 'pending')
    assert.equal(await status(farmA), 'pending')
    checks.push('owner-of-existing-farm-cannot-approve-another-existing-farm')
    const binding = await seed()
    for (const patch of [
      { farmId: randomUUID() },
      { agentId: randomUUID() },
      { expectedFingerprint: 'SHA256:' + 'A'.repeat(43) },
      { sessionRecordId: 'absent' },
      { now: 200 },
    ])
      assert.deepEqual(await approval.approve({ ...binding, ...patch }), {
        ok: false,
        reason: 'denied',
      })
    assert.equal(await status(binding), 'pending')
    const absolute = await seed()
    assert.deepEqual(
      await approval.approve({
        ...absolute,
        now: 1000,
        policy: { idleTimeoutMs: 10000 },
      }),
      { ok: false, reason: 'denied' },
    )
    const disabled = await seed()
    await admin`UPDATE farm.session_accounts SET disabled = true WHERE id = ${disabled.sessionRecordId}`
    assert.deepEqual(await approval.approve(disabled), {
      ok: false,
      reason: 'denied',
    })
    assert.deepEqual(
      await approval.approve({ ...disabled, farmId: "' OR TRUE --" }),
      { ok: false, reason: 'invalid-input' },
    )
    checks.push(
      'fresh-session-binding-fingerprint-disabled-idle-and-absolute-expiry',
    )

    for (const kind of ['membership', 'downgrade', 'session', 'account']) {
      const first = await seed()
      const blocker = await admin.reserve()
      await blocker`BEGIN`
      if (kind === 'membership')
        await blocker`UPDATE farm.memberships SET revoked_at = 101 WHERE farm_id = ${first.farmId}::uuid`
      if (kind === 'downgrade')
        await blocker`UPDATE farm.memberships SET role = 'viewer' WHERE farm_id = ${first.farmId}::uuid`
      if (kind === 'session' || kind === 'account')
        await blocker`SELECT id FROM farm.session_accounts WHERE id = ${first.sessionRecordId} FOR UPDATE`
      if (kind === 'session')
        await blocker`UPDATE farm.account_sessions SET revoked_at = 101 WHERE id = ${first.sessionRecordId}`
      if (kind === 'account')
        await blocker`UPDATE farm.session_accounts SET session_version = session_version + 1 WHERE id = ${first.sessionRecordId}`
      const denied = approval.approve(first)
      try {
        await waiting(
          kind === 'membership' || kind === 'downgrade'
            ? 'SELECT role, revoked_at'
            : 'SELECT id, session_version',
        )
      } finally {
        await blocker`COMMIT`
        blocker.release()
      }
      assert.deepEqual(await denied, { ok: false, reason: 'denied' })
      assert.equal(await status(first), 'pending')

      const reverse = await seed()
      await admin
        .unsafe(
          `CREATE FUNCTION farm.pause_approval_fixture() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN PERFORM pg_advisory_xact_lock(490060); RETURN NEW; END; $$; CREATE TRIGGER pause_approval_fixture BEFORE UPDATE ON farm.connector_enrollments FOR EACH ROW EXECUTE FUNCTION farm.pause_approval_fixture();`,
        )
        .simple()
      const gate = await admin.reserve()
      await gate`SELECT pg_advisory_lock(490060)`
      let result: ReturnType<typeof approval.approve> | undefined
      let revocation: PromiseLike<unknown> | undefined
      try {
        result = approval.approve(reverse)
        await waiting(
          "UPDATE farm.connector_enrollments SET status = 'approved'",
        )
        if (kind === 'membership')
          revocation =
            admin`UPDATE farm.memberships SET revoked_at = 102 WHERE farm_id = ${reverse.farmId}::uuid`.execute()
        if (kind === 'downgrade')
          revocation =
            admin`UPDATE farm.memberships SET role = 'viewer' WHERE farm_id = ${reverse.farmId}::uuid`.execute()
        if (kind === 'session')
          revocation = new PostgresSessionRepository(admin).revokeSession(
            reverse.sessionRecordId,
            102,
          )
        if (kind === 'account')
          revocation = new PostgresSessionRepository(
            admin,
          ).revokeAccountSessions(reverse.sessionRecordId)
        await waiting(
          kind === 'membership' || kind === 'downgrade'
            ? 'UPDATE farm.memberships SET'
            : kind === 'account'
              ? 'UPDATE farm.session_accounts SET session_version'
              : 'SELECT id FROM farm.session_accounts',
        )
      } finally {
        await gate`SELECT pg_advisory_unlock(490060)`
        gate.release()
      }
      assert.equal((await result)?.ok, true)
      await revocation
      await admin
        .unsafe(
          'DROP TRIGGER pause_approval_fixture ON farm.connector_enrollments; DROP FUNCTION farm.pause_approval_fixture();',
        )
        .simple()
      assert.deepEqual(await approval.approve({ ...reverse, now: 103 }), {
        ok: false,
        reason: 'denied',
      })
      if (kind === 'membership')
        await assert.rejects(
          admin`UPDATE farm.memberships SET revoked_at = NULL WHERE farm_id = ${reverse.farmId}::uuid`,
        )
    }
    checks.push(
      'both-orders-membership-revocation-downgrade-session-and-account-revocation',
    )

    const commit = await seed()
    await admin
      .unsafe(
        `CREATE FUNCTION farm.fail_approval_commit_fixture() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic commit failure'; END; $$; CREATE CONSTRAINT TRIGGER fail_approval_commit_fixture AFTER UPDATE ON farm.connector_enrollments DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION farm.fail_approval_commit_fixture();`,
      )
      .simple()
    assert.deepEqual(await approval.approve(commit), {
      ok: false,
      reason: 'storage-unavailable',
    })
    assert.equal(await status(commit), 'pending')
    assert.equal(
      (
        await admin`SELECT last_seen_at::int AS n FROM farm.account_sessions WHERE id = ${commit.sessionRecordId}`
      )[0]?.n,
      100,
    )
    await admin
      .unsafe(
        'DROP TRIGGER fail_approval_commit_fixture ON farm.connector_enrollments; DROP FUNCTION farm.fail_approval_commit_fixture();',
      )
      .simple()
    const held = await admin.reserve()
    await held`BEGIN`
    await held`SELECT id FROM farm.session_accounts WHERE id = ${commit.sessionRecordId} FOR UPDATE`
    try {
      assert.deepEqual(await approval.approve(commit), {
        ok: false,
        reason: 'storage-unavailable',
      })
    } finally {
      await held`ROLLBACK`
      held.release()
    }
    assert.equal((await approval.approve(commit)).ok, true)
    checks.push(
      'commit-failure-rolls-back-enrollment-and-touch-lock-timeout-recovers',
    )

    for (const query of [
      "UPDATE farm.memberships SET role = 'owner'",
      "UPDATE farm.memberships SET farm_id = '11111111-1111-4111-8111-111111111111'::uuid",
      "UPDATE farm.session_accounts SET id = 'forged-account'",
      "INSERT INTO farm.farms (id) VALUES ('11111111-1111-4111-8111-111111111111'::uuid)",
      'UPDATE farm.memberships SET revoked_at = NULL',
      'DELETE FROM farm.memberships',
      'TRUNCATE farm.memberships',
      'UPDATE farm.session_accounts SET disabled = false',
      'UPDATE farm.session_accounts SET session_version = 0',
      "UPDATE farm.account_sessions SET account_id = 'forged'",
      "UPDATE farm.connector_enrollments SET fingerprint = repeat('x',50)",
      'CREATE TABLE farm.forbidden (id int)',
      'SET ROLE fixture',
      'ALTER ROLE farm_approval_fixture SUPERUSER',
    ])
      await assert.rejects(sql.unsafe(query))
    checks.push(
      'restricted-role-cannot-create-membership-escalate-rebind-or-ddl',
    )
  } finally {
    await sql.end({ timeout: 3 })
    await admin`DROP ROLE farm_approval_fixture`
  }
  assert.deepEqual(
    await approval.approve({
      sessionRecordId: 'closed',
      farmId: randomUUID(),
      agentId: randomUUID(),
      expectedFingerprint: identity.fingerprint,
      now: 101,
      policy: { idleTimeoutMs: 100 },
    }),
    { ok: false, reason: 'storage-unavailable' },
  )
  return [...checks, 'closed-storage-fails-closed']
}
