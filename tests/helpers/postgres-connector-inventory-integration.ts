import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { setTimeout as sleep } from 'node:timers/promises'
import type { Sql } from 'postgres'
import { login } from '../../apps/farm/server/services/authenticated-session.ts'
import { connectorInventory } from '../../apps/farm/server/services/connector-inventory.ts'
import { hashPassword } from '../../apps/farm/server/utils/auth/password.ts'
import {
  SESSION_COOKIE_ATTRIBUTES,
  SESSION_COOKIE_NAME,
} from '../../apps/farm/server/utils/auth/boundary.ts'
import { PostgresCredentials } from '../../apps/farm/server/storage/postgres-credentials.ts'
import { PostgresSessionRepository } from '../../apps/farm/server/storage/postgres-session.ts'
import { PostgresConnectorInventory } from '../../apps/farm/server/storage/postgres-connector-inventory.ts'

/** Caller owns a disposable database with the complete migration journal applied. */
export async function testPostgresConnectorInventory(
  admin: Sql,
  runtime: Sql,
  authSql: Sql,
) {
  let now = 101
  const store = new PostgresConnectorInventory(runtime, () => now)
  const account = randomUUID()
  const session = randomUUID().replaceAll('-', '')
  const farms = [randomUUID(), randomUUID(), randomUUID()].sort()
  const otherFarm = randomUUID()
  const agents = [randomUUID(), randomUUID(), randomUUID()].sort()
  const fingerprint = 'SHA256:' + 'A'.repeat(43)
  await admin`INSERT INTO farm.session_accounts (id) VALUES (${account})`
  await admin`INSERT INTO farm.account_sessions (id, account_id, account_version, created_at, last_seen_at, absolute_expires_at) VALUES (${session}, ${account}, 0, 100, 100, 1000)`
  for (const farm of [...farms, otherFarm])
    await admin`INSERT INTO farm.farms (id) VALUES (${farm}::uuid)`
  for (const farm of farms)
    await admin`INSERT INTO farm.memberships (farm_id, account_id, role) VALUES (${farm}::uuid, ${account}, 'viewer')`
  for (const agent of agents)
    await admin`INSERT INTO farm.connector_enrollments (agent_id, farm_id, public_key_spki, fingerprint) VALUES (${agent}::uuid, ${farms[0]!}::uuid, ${'A'.repeat(59)}, ${fingerprint})`
  const input = {
    sessionRecordId: session,
    policy: { idleTimeoutMs: 100 },
    limit: 2,
    after: null,
  }
  const first = await store.listFarms(input)
  assert.deepEqual(first, {
    ok: true,
    farms: farms.slice(0, 2).map((farmId) => ({ farmId })),
    nextAfter: farms[1]!,
  })
  assert.deepEqual(await store.listFarms({ ...input, after: farms[1]! }), {
    ok: true,
    farms: [{ farmId: farms[2]! }],
    nextAfter: null,
  })
  const firstConnectors = await store.listConnectors({
    ...input,
    farmId: farms[0]!,
  })
  assert.deepEqual(firstConnectors, {
    ok: true,
    connectors: agents
      .slice(0, 2)
      .map((agentId) => ({ agentId, fingerprint, status: 'pending' })),
    nextAfter: agents[1]!,
  })
  assert.deepEqual(
    await store.listConnectors({
      ...input,
      farmId: farms[0]!,
      after: agents[1]!,
    }),
    {
      ok: true,
      connectors: [{ agentId: agents[2]!, fingerprint, status: 'pending' }],
      nextAfter: null,
    },
  )
  const beforeDenied = (
    await admin`SELECT last_seen_at::text AS value FROM farm.account_sessions WHERE id = ${session}`
  )[0]?.value
  assert.deepEqual(
    await store.listConnectors({ ...input, farmId: otherFarm }),
    { ok: false, reason: 'forbidden' },
  )
  assert.equal(
    (
      await admin`SELECT last_seen_at::text AS value FROM farm.account_sessions WHERE id = ${session}`
    )[0]?.value,
    beforeDenied,
  )
  assert.deepEqual(
    await store.listFarms({ ...input, sessionRecordId: 'missing' }),
    { ok: false, reason: 'unauthorized' },
  )
  for (const invalid of [
    { limit: 0 },
    { limit: 51 },
    { after: 'invalid' },
    { after: farms[0]!.toUpperCase() },
  ])
    assert.deepEqual(await store.listFarms({ ...input, ...invalid }), {
      ok: false,
      reason: 'invalid-input',
    })

  // Hold each authorization row before the request; commit the denial while it waits.
  for (const kind of [
    'membership',
    'session',
    'account',
    'version',
    'idle-expiry',
    'absolute-expiry',
  ] as const) {
    const id = randomUUID(),
      sid = randomUUID().replaceAll('-', ''),
      farm = randomUUID()
    await admin`INSERT INTO farm.session_accounts (id) VALUES (${id})`
    await admin`INSERT INTO farm.account_sessions (id, account_id, account_version, created_at, last_seen_at, absolute_expires_at) VALUES (${sid}, ${id}, 0, 100, 100, ${kind === 'absolute-expiry' ? 150 : 1000})`
    await admin`INSERT INTO farm.farms (id) VALUES (${farm}::uuid)`
    await admin`INSERT INTO farm.memberships (farm_id, account_id, role) VALUES (${farm}::uuid, ${id}, 'owner')`
    const lock = await admin.reserve()
    await lock`BEGIN`
    if (kind === 'membership')
      await lock`UPDATE farm.memberships SET revoked_at = 101 WHERE farm_id = ${farm}::uuid AND account_id = ${id}`
    else if (kind === 'session')
      await lock`UPDATE farm.account_sessions SET revoked_at = 101 WHERE id = ${sid}`
    else {
      await lock`SELECT id FROM farm.session_accounts WHERE id = ${id} FOR UPDATE`
      if (kind === 'version')
        await lock`UPDATE farm.session_accounts SET session_version = session_version + 1 WHERE id = ${id}`
      if (kind === 'account')
        await lock`UPDATE farm.session_accounts SET disabled = true WHERE id = ${id}`
    }
    now = 101
    const result = store.listConnectors({
      ...input,
      sessionRecordId: sid,
      farmId: farm,
      ...(kind === 'absolute-expiry'
        ? { policy: { idleTimeoutMs: 10000 } }
        : {}),
    })
    try {
      const start = performance.now()
      while (true) {
        const rows =
          await admin`SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock' AND application_name = 'connector-inventory-fixture'`
        if (rows[0]?.n > 0) break
        assert.ok(
          performance.now() - start < 2000,
          'Expected inventory lock wait',
        )
        await sleep(5)
      }
      if (kind === 'idle-expiry' || kind === 'absolute-expiry') now = 200
    } finally {
      await lock`COMMIT`
      lock.release()
    }
    assert.deepEqual(await result, {
      ok: false,
      reason: kind === 'membership' ? 'forbidden' : 'unauthorized',
    })
    assert.equal(
      (
        await admin`SELECT last_seen_at::int AS value FROM farm.account_sessions WHERE id = ${sid}`
      )[0]?.value,
      100,
    )
  }
  now = 101
  for (const query of [
    "UPDATE farm.connector_enrollments SET status = 'approved'",
    'SELECT public_key_spki FROM farm.connector_enrollments',
    `UPDATE farm.session_accounts SET id = 'forged' WHERE id = '${account}'`,
    `UPDATE farm.memberships SET farm_id = '${otherFarm}'::uuid WHERE farm_id = '${farms[0]}'::uuid`,
    "UPDATE farm.memberships SET role = 'owner'",
    'UPDATE farm.session_accounts SET disabled = false',
    'UPDATE farm.account_sessions SET revoked_at = NULL',
    'DELETE FROM farm.connector_enrollments',
    'CREATE TABLE farm.inventory_forbidden (id int)',
    'SET ROLE fixture',
    'GRANT farm_connector_revoker TO CURRENT_USER',
    'GRANT UPDATE ON farm.connector_enrollments TO CURRENT_USER',
  ])
    await assert.rejects(runtime.unsafe(query))
  assert.equal(
    (
      await admin`SELECT count(*)::int AS n FROM farm.connector_enrollments WHERE agent_id = ANY(${agents}::uuid[]) AND status = 'pending'`
    )[0]?.n,
    3,
  )
  const httpAccount = randomUUID().replaceAll('-', '')
  const username = 'inventory_' + httpAccount
  const password = 'synthetic-inventory-password'
  await admin`INSERT INTO farm.session_accounts (id) VALUES (${httpAccount})`
  await admin`INSERT INTO farm.password_credentials (account_id, username, password_hash) VALUES (${httpAccount}, ${username}, ${await hashPassword(password)})`
  await admin`INSERT INTO farm.memberships (farm_id, account_id, role) VALUES (${farms[0]!}::uuid, ${httpAccount}, 'viewer')`
  const auth = {
    origin: 'https://farm.example.invalid',
    cookie: {
      name: SESSION_COOKIE_NAME,
      password: 'synthetic-cookie-key-never-used-outside-tests',
      maxAge: 60,
      cookie: { ...SESSION_COOKIE_ATTRIBUTES },
    },
    sessions: new PostgresSessionRepository(authSql),
    credentials: new PostgresCredentials(authSql),
    idleTimeoutMs: 60000,
    lifetimeMs: 60000,
  }
  const deps = { auth, storage: new PostgresConnectorInventory(runtime) }
  const server = createServer(async (request, response) => {
    const chunks: Uint8Array[] = []
    for await (const chunk of request) chunks.push(chunk)
    const headers = new Headers()
    for (const [key, value] of Object.entries(request.headers)) {
      if (typeof value === 'string') headers.set(key, value)
      else if (value) for (const item of value) headers.append(key, item)
    }
    const path = request.url ?? '/'
    const method = request.method ?? 'GET'
    const event = {
      req: new Request('https://farm.example.invalid' + path, {
        method,
        headers,
        ...(method === 'POST' ? { body: Buffer.concat(chunks) } : {}),
      }),
      res: { status: 200, statusText: 'OK', headers: new Headers() },
    }
    let result: unknown
    try {
      if (method === 'POST' && path === '/api/auth/login')
        result = await login(event, auth)
      else {
        const match = /^\/api\/farms\/([^/]+)\/connectors(?:\?|$)/.exec(path)
        if (method !== 'GET' || (path.split('?')[0] !== '/api/farms' && !match))
          throw new Error('Unexpected fixture route')
        result = await connectorInventory(event, match?.[1], deps)
      }
    } catch (error) {
      response.statusCode =
        typeof error === 'object' &&
        error !== null &&
        'status' in error &&
        typeof error.status === 'number'
          ? error.status
          : 500
      result = { error: true }
    }
    for (const [key, value] of event.res.headers)
      if (key !== 'set-cookie') response.setHeader(key, value)
    const cookies = event.res.headers.getSetCookie()
    if (cookies.length) response.setHeader('set-cookie', cookies)
    response.setHeader('content-type', 'application/json')
    response.end(JSON.stringify(result))
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  try {
    const address = server.address()
    assert.ok(address && typeof address !== 'string')
    const base = `http://127.0.0.1:${address.port}`
    const signedIn = await fetch(base + '/api/auth/login', {
      method: 'POST',
      headers: { origin: auth.origin, 'content-type': 'application/json' },
      body: JSON.stringify({ username, password }),
    })
    assert.equal(signedIn.status, 200)
    assert.deepEqual(await signedIn.json(), { accountId: httpAccount })
    const cookie = signedIn.headers.getSetCookie()[0]
    assert.ok(cookie)
    assert.match(cookie, /HttpOnly/)
    assert.match(cookie, /Secure/)
    assert.match(cookie, /SameSite=Lax/)
    assert.doesNotMatch(cookie, /Domain=/i)
    const pair = cookie.split(';')[0]!
    const good = await fetch(base + '/api/farms', { headers: { cookie: pair } })
    assert.equal(good.status, 200)
    assert.deepEqual(await good.json(), {
      farms: [{ farmId: farms[0] }],
      nextAfter: null,
    })
    assert.equal(good.headers.get('cache-control'), 'no-store')
    const scoped = await fetch(
      base + '/api/farms/' + farms[0] + '/connectors',
      { headers: { cookie: pair } },
    )
    assert.equal(scoped.status, 200)
    assert.deepEqual(await scoped.json(), {
      connectors: agents.map((agentId) => ({
        agentId,
        fingerprint,
        status: 'pending',
      })),
      nextAfter: null,
    })
    for (const headers of [
      {},
      { authorization: 'Bearer ' + pair },
      { cookie: pair + 'tampered' },
    ]) {
      const denied = await fetch(base + '/api/farms', { headers })
      assert.equal(denied.status, 401)
      assert.equal(denied.headers.get('cache-control'), 'no-store')
    }
    for (const query of [
      'limit=0',
      'limit=1&limit=2',
      'after=bad',
      'unknown=1',
    ]) {
      const invalid = await fetch(base + '/api/farms?' + query, {
        headers: { cookie: pair },
      })
      assert.equal(invalid.status, 400)
      assert.equal(invalid.headers.get('cache-control'), 'no-store')
    }
    const wrong = await fetch(
      base + '/api/farms/' + otherFarm + '/connectors',
      { headers: { cookie: pair } },
    )
    assert.equal(wrong.status, 403)
    assert.equal(wrong.headers.get('cache-control'), 'no-store')
    await admin`UPDATE farm.memberships SET revoked_at = 101 WHERE farm_id = ${farms[0]!}::uuid AND account_id = ${httpAccount}`
    const memberRevoked = await fetch(
      base + '/api/farms/' + farms[0] + '/connectors',
      { headers: { cookie: pair } },
    )
    assert.equal(memberRevoked.status, 403)
    await admin`UPDATE farm.account_sessions SET revoked_at = ${Date.now()} WHERE account_id = ${httpAccount}`
    const sessionRevoked = await fetch(base + '/api/farms', {
      headers: { cookie: pair },
    })
    assert.equal(sessionRevoked.status, 401)
    auth.lifetimeMs = 1
    const secondLogin = await fetch(base + '/api/auth/login', {
      method: 'POST',
      headers: { origin: auth.origin, 'content-type': 'application/json' },
      body: JSON.stringify({ username, password }),
    })
    assert.equal(secondLogin.status, 200)
    const secondCookie = secondLogin.headers.getSetCookie()[0]?.split(';')[0]
    assert.ok(secondCookie)
    await sleep(5)
    auth.lifetimeMs = 60000
    const expired = await fetch(base + '/api/farms', {
      headers: { cookie: secondCookie },
    })
    assert.equal(expired.status, 401)
    assert.equal(expired.headers.get('cache-control'), 'no-store')
    const thirdLogin = await fetch(base + '/api/auth/login', {
      method: 'POST',
      headers: { origin: auth.origin, 'content-type': 'application/json' },
      body: JSON.stringify({ username, password }),
    })
    assert.equal(thirdLogin.status, 200)
    const thirdCookie = thirdLogin.headers.getSetCookie()[0]?.split(';')[0]
    assert.ok(thirdCookie)
    await admin`INSERT INTO farm.memberships (farm_id, account_id, role) VALUES (${farms[1]!}::uuid, ${httpAccount}, 'viewer')`
    const runtimeRole = (await runtime`SELECT current_user AS name`)[0]?.name
    assert.equal(typeof runtimeRole, 'string')
    // A real PostgreSQL connection outage for this fixture's runtime identity.
    // Authentication/admin connections remain healthy; no fake HTTP/proxy response.
    await admin`ALTER ROLE ${admin(runtimeRole)} NOLOGIN`
    try {
      await admin`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE usename = ${runtimeRole} AND pid <> pg_backend_pid()`
      for (const path of [
        '/api/farms',
        '/api/farms/' + farms[1] + '/connectors',
      ]) {
        const unavailable: Response = await fetch(base + path, {
          headers: { cookie: thirdCookie },
        })
        assert.equal(unavailable.status, 503)
        assert.equal(unavailable.headers.get('cache-control'), 'no-store')
        assert.deepEqual(await unavailable.json(), { error: true })
      }
      assert.equal((await admin`SELECT 1 AS healthy`)[0]?.healthy, 1)
    } finally {
      await admin`ALTER ROLE ${admin(runtimeRole)} LOGIN`
    }
    const recovered = await fetch(base + '/api/farms', {
      headers: { cookie: thirdCookie },
    })
    assert.equal(recovered.status, 200)
    assert.deepEqual(await recovered.json(), {
      farms: [{ farmId: farms[1] }],
      nextAfter: null,
    })
    await admin`UPDATE farm.session_accounts SET disabled = true WHERE id = ${httpAccount}`
    const revoked = await fetch(base + '/api/farms', {
      headers: { cookie: thirdCookie },
    })
    assert.equal(revoked.status, 401)
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()))
      server.closeAllConnections()
    })
  }
  return [
    'bounded-keyset-discovery-and-exact-public-fields',
    'cross-farm-and-invalid-input-denied',
    'revocation-disable-and-expiry-after-lock',
    'least-privilege-and-no-enrollment-mutation',
    'loopback-http-real-login-sealed-cookie-and-postgres',
    'http-expired-revoked-session-and-cross-farm-denied',
    'http-runtime-postgres-outage-503-and-recovery',
  ]
}
