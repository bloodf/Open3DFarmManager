import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import postgres, { type Sql } from 'postgres'
import { PostgresBrowserDeviceRegistry } from '../../apps/farm/server/storage/postgres-browser-device-registry.ts'

/** Isolated synthetic PostgreSQL only. Caller owns database and disposes fixture rows. */
export async function testBrowserDeviceSqlAcceptance(admin: Sql, port: number) {
  const role = 'browser_http_sql_' + randomUUID().replaceAll('-', '')
  await admin`CREATE ROLE ${admin(role)} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS IN ROLE farm_browser_device_runtime`
  const sql = postgres({
    host: '127.0.0.1',
    port,
    database: 'fixture',
    username: role,
    max: 4,
    connect_timeout: 3,
    connection: {
      statement_timeout: 2000,
      lock_timeout: 1000,
      transaction_timeout: 10000,
      options: '-c role=farm_browser_device_runtime',
    },
  })
  const registry = new PostgresBrowserDeviceRegistry(
    sql,
    {
      origin: 'https://farm.example',
      audience: 'open3dfarmmanager:browser-device',
    },
    () => 1000,
  )
  const policy = { idleTimeoutMs: 1000000 },
    farm = randomUUID(),
    otherFarm = randomUUID()
  const actors = ['owner', 'admin', 'operator', 'viewer'].map((roleName) => ({
    roleName,
    account: 'a_' + randomUUID(),
    session: 's_' + randomUUID(),
  }))
  const checks: string[] = []
  try {
    const settings = (
      await sql`SELECT current_user, current_setting('statement_timeout') AS statement, current_setting('lock_timeout') AS lock, current_setting('transaction_timeout') AS transaction`
    )[0]
    assert.deepEqual(
      { ...settings },
      {
        current_user: 'farm_browser_device_runtime',
        statement: '2s',
        lock: '1s',
        transaction: '10s',
      },
    )
    await assert.rejects(
      sql`SELECT pg_sleep(3)`,
      (error: unknown) =>
        typeof error === 'object' &&
        error !== null &&
        'code' in error &&
        error.code === '57014',
    )
    assert.equal((await sql`SELECT 1 AS n`)[0]?.n, 1)
    const blocker = await admin.reserve()
    await blocker`BEGIN`
    await blocker`SELECT pg_advisory_xact_lock(1870033,999)`
    try {
      await assert.rejects(
        sql`SELECT pg_advisory_xact_lock(1870033,999)`,
        (error: unknown) =>
          typeof error === 'object' &&
          error !== null &&
          'code' in error &&
          error.code === '55P03',
      )
    } finally {
      await blocker`COMMIT`
      blocker.release()
    }
    assert.equal((await sql`SELECT 1 AS n`)[0]?.n, 1)
    const doomed = postgres({
      host: '127.0.0.1',
      port,
      database: 'fixture',
      username: role,
      max: 1,
      connect_timeout: 3,
      connection: {
        statement_timeout: 2000,
        lock_timeout: 1000,
        transaction_timeout: 10000,
        options: '-c role=farm_browser_device_runtime',
      },
    })
    try {
      await doomed`BEGIN`
      const backend = (await doomed`SELECT pg_backend_pid() AS pid`)[0]?.pid
      assert.equal(typeof backend, 'number')
      await new Promise((resolve) => setTimeout(resolve, 10500))
      assert.equal(
        (
          await admin`SELECT count(*)::int AS n FROM pg_stat_activity WHERE pid=${backend}`
        )[0]?.n,
        0,
      )
      console.log(JSON.stringify({ transactionTimeoutBackendPid: backend }))
    } finally {
      await doomed.end({ timeout: 1 })
    }
    assert.equal((await sql`SELECT 1 AS n`)[0]?.n, 1)
    for (const query of [
      'CREATE TABLE farm.forbidden_test(id int)',
      'SET ROLE fixture',
      'DELETE FROM farm.browser_device_keys',
    ])
      await assert.rejects(sql.unsafe(query))
    checks.push(
      'runtime-role-settings-real-statement-lock-transaction-expiry-and-recovery',
    )
    await admin`INSERT INTO farm.farms(id) VALUES (${farm}::uuid),(${otherFarm}::uuid)`
    for (const a of actors) {
      await admin`INSERT INTO farm.session_accounts(id) VALUES (${a.account})`
      await admin`INSERT INTO farm.account_sessions(id,account_id,account_version,created_at,last_seen_at,absolute_expires_at) VALUES (${a.session},${a.account},0,1000,1000,1000000)`
      await admin`INSERT INTO farm.memberships(farm_id,account_id,role) VALUES (${farm}::uuid,${a.account},${a.roleName})`
      const pair = await crypto.subtle.generateKey(
        { name: 'ECDSA', namedCurve: 'P-256' },
        false,
        ['sign', 'verify'],
      )
      const { kty, crv, x, y } = await crypto.subtle.exportKey(
        'jwk',
        pair.publicKey,
      )
      const result = await registry.issueChallenge({
        sessionRecordId: a.session,
        policy,
        request: {
          farm_id: farm,
          public_key: { kty, crv, x, y },
          purpose: 'enroll',
        },
      })
      assert.ok(result.ok)
    }
    async function list(a: (typeof actors)[number], after?: string) {
      return registry.list({
        sessionRecordId: a.session,
        policy,
        request: { farm_id: farm, limit: 1, ...(after ? { after } : {}) },
      })
    }
    for (const a of actors) {
      let after: string | undefined,
        collected: string[] = []
      do {
        const page = await list(a, after)
        assert.ok(page.ok)
        assert.equal(page.currentRole, a.roleName)
        if (['operator', 'viewer'].includes(a.roleName))
          assert.ok(page.devices.every((d) => d.accountId === a.account))
        collected.push(...page.devices.map((d) => d.keyId))
        after = page.nextAfter ?? undefined
      } while (after)
      assert.equal(
        collected.length,
        ['owner', 'admin'].includes(a.roleName) ? 4 : 1,
      )
      assert.deepEqual(collected, [...new Set(collected)].sort())
    }
    const owner = actors[0],
      viewer = actors[3]
    assert.ok(owner && viewer)
    assert.deepEqual(
      await registry.list({
        sessionRecordId: owner.session,
        policy,
        request: { farm_id: otherFarm, limit: 20 },
      }),
      { ok: false, reason: 'denied' },
    )
    await admin`UPDATE farm.memberships SET role='viewer' WHERE farm_id=${farm}::uuid AND account_id=${owner.account}`
    const downgraded = await list(owner)
    assert.ok(downgraded.ok)
    assert.equal(downgraded.currentRole, 'viewer')
    assert.equal(downgraded.devices.length, 1)
    await admin`UPDATE farm.memberships SET revoked_at=1000 WHERE farm_id=${farm}::uuid AND account_id=${viewer.account}`
    assert.deepEqual(await list(viewer), { ok: false, reason: 'denied' })
    for (const change of ['revoked', 'downgraded']) {
      const target = change === 'revoked' ? actors[1] : actors[2]
      assert.ok(target)
      const blocker = await admin.reserve()
      await blocker`BEGIN`
      if (change === 'revoked')
        await blocker`UPDATE farm.memberships SET revoked_at=1000 WHERE farm_id=${farm}::uuid AND account_id=${target.account}`
      else
        await blocker`UPDATE farm.memberships SET role='viewer' WHERE farm_id=${farm}::uuid AND account_id=${target.account}`
      const pending = list(target)
      try {
        const deadline = performance.now() + 800
        while (true) {
          const waits =
            await admin`SELECT count(*)::int AS n FROM pg_stat_activity WHERE usename=${role} AND wait_event_type='Lock'`
          if (waits[0]?.n > 0) break
          assert.ok(
            performance.now() < deadline,
            'Expected membership lock wait',
          )
          await new Promise((resolve) => setTimeout(resolve, 5))
        }
      } finally {
        await blocker`COMMIT`
        blocker.release()
      }
      const result = await pending
      if (change === 'revoked')
        assert.deepEqual(result, { ok: false, reason: 'denied' })
      else {
        assert.ok(result.ok)
        assert.equal(result.currentRole, 'viewer')
        assert.equal(result.devices.length, 1)
      }
    }
    checks.push('list-observes-revocation-and-downgrade-after-row-lock-wait')
    checks.push(
      'current-role-scoped-paginated-list-cross-farm-revocation-downgrade',
    )
  } finally {
    await sql.end({ timeout: 3 })
    await admin`DROP ROLE ${admin(role)}`
  }
  return checks
}
