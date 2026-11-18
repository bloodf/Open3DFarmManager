import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import type { Sql } from 'postgres'
import {
  IntegrationAppsService,
  hashClientSecret,
} from '../../apps/farm/server/services/integration-apps.ts'
import { PostgresIntegrationApps } from '../../apps/farm/server/storage/integration-apps-postgres.ts'
import { IntegrationAuth } from '../../apps/farm/server/utils/integration-auth.ts'
import {
  authorizeIntegrationRequest,
  integrationBase,
  integrationTokenRequest,
} from '../../apps/farm/server/utils/integration-auth-http.ts'

const denied = async (promise: PromiseLike<unknown>, what: string) => {
  await assert.rejects(Promise.resolve(promise), Error, what)
}

/** Disposable migrated empty database only. Caller owns pools, roles and teardown. */
export async function testPostgresIntegrationApps(
  admin: Sql,
  runtime: Sql,
  ownership: Sql,
) {
  const checks: string[] = []
  const store = new PostgresIntegrationApps(runtime)
  const clock = { now: 1_000_000 }
  const service = new IntegrationAppsService(store, () => ++clock.now)

  // Fixture: a real farm and a sandbox farm, an owner of both, a viewer and a stranger.
  const account = async (id: string) =>
    await admin`INSERT INTO farm.session_accounts (id) VALUES (${id})`
  const owner = 'owner_' + randomUUID().replaceAll('-', '')
  const viewer = 'viewer_' + randomUUID().replaceAll('-', '')
  const stranger = 'stranger_' + randomUUID().replaceAll('-', '')
  for (const id of [owner, viewer, stranger]) await account(id)
  const farm = randomUUID()
  const sandboxFarm = randomUUID()
  const otherFarm = randomUUID()
  await admin`INSERT INTO farm.farms (id, sandbox) VALUES (${farm}, false), (${sandboxFarm}, true), (${otherFarm}, false)`
  await admin`INSERT INTO farm.memberships (farm_id, account_id, role) VALUES (${farm}, ${owner}, 'owner'), (${sandboxFarm}, ${owner}, 'owner'), (${farm}, ${viewer}, 'viewer'), (${otherFarm}, ${stranger}, 'owner')`
  assert.equal(
    (await admin`SELECT sandbox FROM farm.farms WHERE id = ${farm}`)[0]
      ?.sandbox,
    false,
    'farms default to non-sandbox',
  )
  const assignment = async (farmId: string, key: string) => {
    const agent = randomUUID()
    await admin`INSERT INTO farm.connector_enrollments (agent_id, farm_id, public_key_spki, fingerprint) VALUES (${agent}::uuid, ${farmId}::uuid, ${'k'.repeat(59)}, ${key.padEnd(50, 'f')})`
    await admin`UPDATE farm.connector_enrollments SET status = 'approved' WHERE agent_id = ${agent}::uuid`
    const id = randomUUID()
    await admin`INSERT INTO farm.printer_assignments (id, farm_id, agent_id, printer_key, created_at, created_by) VALUES (${id}::uuid, ${farmId}::uuid, ${agent}::uuid, ${key}, 1, ${owner})`
    return id
  }

  // Apps: owner and admin only; unknown farms look like non-membership.
  const app = await service.createApp(owner, {
    farmId: farm,
    name: '  Dashboard  ',
    sandbox: false,
  })
  assert.ok(typeof app === 'object')
  assert.equal(app.name, 'Dashboard')
  assert.equal(app.sandbox, false)
  assert.equal(
    await service.createApp(viewer, {
      farmId: farm,
      name: 'x',
      sandbox: false,
    }),
    'not-found',
  )
  assert.equal(
    await service.createApp(stranger, {
      farmId: farm,
      name: 'x',
      sandbox: false,
    }),
    'not-found',
  )
  assert.equal(
    await service.createApp(owner, {
      farmId: randomUUID(),
      name: 'x',
      sandbox: false,
    }),
    'not-found',
  )
  assert.equal(await store.listApps(viewer, farm), null)
  assert.equal((await store.listApps(owner, farm))?.length, 1)
  checks.push('apps-are-owner-admin-only')

  // Credentials: only the digest is stored; the secret is shown once and authenticates.
  const issued = await service.issueCredential(owner, app.id)
  assert.ok(typeof issued === 'object')
  const row = (
    await admin`SELECT c.*, to_jsonb(c)::text AS dump FROM farm.integration_app_credentials c WHERE c.client_id = ${issued.credential.clientId}`
  )[0]!
  assert.equal(row.secret_hash, hashClientSecret(issued.secret))
  assert.ok(!(row.dump as string).includes(issued.secret))
  const everything = (
    await admin`SELECT string_agg(t::text, ' ') AS dump FROM farm.integration_app_credentials t`
  )[0]!.dump as string
  assert.ok(!everything.includes(issued.secret))
  await denied(
    admin`INSERT INTO farm.integration_app_credentials (id, app_id, client_id, secret_hash, created_at) VALUES (${randomUUID()}::uuid, ${app.id}::uuid, ${'ofc_plain_0123456789'}, ${issued.secret}, 1)`,
    'plaintext secret rejected by the hash check',
  )
  await denied(
    runtime`UPDATE farm.integration_app_credentials SET secret_hash = ${hashClientSecret('other')} WHERE app_id = ${app.id}::uuid`,
    'runtime role cannot rewrite a secret',
  )
  await denied(
    admin`UPDATE farm.integration_app_credentials SET secret_hash = ${hashClientSecret('other')} WHERE app_id = ${app.id}::uuid`,
    'guard trigger keeps secrets immutable even for an administrator',
  )
  await denied(
    runtime`DELETE FROM farm.integration_app_credentials`,
    'credentials are never deleted',
  )
  assert.ok(
    await service.authenticate(issued.credential.clientId, issued.secret),
  )
  assert.equal(
    await service.authenticate(issued.credential.clientId, issued.secret + 'x'),
    null,
  )
  assert.equal(await service.issueCredential(viewer, app.id), 'not-found')
  const second = await service.issueCredential(owner, app.id)
  assert.ok(typeof second === 'object')
  assert.equal(
    await store.revokeCredential(owner, issued.credential.id, ++clock.now),
    'ok',
  )
  assert.equal(
    await service.authenticate(issued.credential.clientId, issued.secret),
    null,
    'revoked credential no longer authenticates',
  )
  assert.ok(
    await service.authenticate(second.credential.clientId, second.secret),
  )
  assert.equal(
    await store.revokeCredential(owner, issued.credential.id, ++clock.now),
    'not-found',
  )
  checks.push('secrets-stored-only-as-hashes-and-revocable')

  // Grants: farm-wide, approval flag stored per grant, scopes checked by the database too.
  const wide = await service.createGrant(owner, {
    appId: app.id,
    farmId: farm,
    scopes: ['printers:read', 'jobs:read'],
  })
  assert.ok(typeof wide === 'object')
  assert.equal(wide.requiresApproval, false)
  assert.equal(wide.printerAssignmentId, null)
  const approval = await service.createGrant(owner, {
    appId: app.id,
    farmId: farm,
    scopes: ['control:basic'],
    requiresApproval: true,
  })
  assert.ok(typeof approval === 'object')
  assert.equal(approval.requiresApproval, true)
  assert.deepEqual(
    (
      await admin`SELECT id, requires_approval FROM farm.integration_app_grants WHERE app_id = ${app.id}::uuid ORDER BY created_at`
    ).map((r) => [r.id, r.requires_approval]),
    [
      [wide.id, false],
      [approval.id, true],
    ],
  )
  assert.equal(
    await service.createGrant(viewer, {
      appId: app.id,
      farmId: farm,
      scopes: ['printers:read'],
    }),
    'not-found',
  )
  assert.equal(
    await service.createGrant(owner, {
      appId: app.id,
      farmId: otherFarm,
      scopes: ['printers:read'],
    }),
    'not-found',
    'the actor must manage the farm the grant exposes',
  )
  for (const bad of [
    ['printers:write'],
    ['printers:read', 'printers:read'],
    [],
  ])
    await denied(
      admin`INSERT INTO farm.integration_app_grants (id, app_id, farm_id, scopes, created_at, created_by) VALUES (${randomUUID()}::uuid, ${app.id}::uuid, ${farm}::uuid, ${bad}::text[], 1, ${owner})`,
      `database rejects scopes ${JSON.stringify(bad)}`,
    )
  await denied(
    runtime`UPDATE farm.integration_app_grants SET scopes = ARRAY['control:extended'] WHERE id = ${wide.id}::uuid`,
    'grant scopes are immutable',
  )
  checks.push('approval-requirement-stored-per-grant')

  // Revoking a printer assignment disables printer-scoped grants (and only those).
  const printerA = await assignment(farm, 'printer-a')
  const printerB = await assignment(farm, 'printer-b')
  const scopedA = await service.createGrant(owner, {
    appId: app.id,
    farmId: farm,
    printerAssignmentId: printerA,
    scopes: ['control:extended'],
  })
  const scopedB = await service.createGrant(owner, {
    appId: app.id,
    farmId: farm,
    printerAssignmentId: printerB,
    scopes: ['control:basic'],
  })
  assert.ok(typeof scopedA === 'object' && typeof scopedB === 'object')
  assert.equal(
    await service.createGrant(owner, {
      appId: app.id,
      farmId: farm,
      printerAssignmentId: randomUUID(),
      scopes: ['printers:read'],
    }),
    'printer-unavailable',
  )
  assert.equal(
    (await store.effectiveGrants(app.id)).length,
    4,
    'two farm-wide and two printer-scoped grants are effective',
  )
  const auth = new IntegrationAuth(store, { key: Buffer.alloc(32, 1), ttl: 60 })
  const issueToken = async () => {
    const response = await integrationTokenRequest(
      new Request('http://localhost' + integrationBase + '/oauth/token', {
        method: 'POST',
        body: new URLSearchParams({
          grant_type: 'client_credentials',
          client_id: second.credential.clientId,
          client_secret: second.secret,
        }),
      }),
      () => auth,
    )
    assert.equal(response.status, 200)
    return (await response.json()).access_token as string
  }
  const statusRequest = (printerId: string, token: string) => {
    const path = '/printers/' + printerId + '/status'
    return authorizeIntegrationRequest(
      new Request('http://localhost' + integrationBase + path, {
        headers: { authorization: 'Bearer ' + token },
      }),
      path,
      () => auth,
    )
  }
  const originalToken = await issueToken()
  assert.ok(
    !((await statusRequest(printerA, originalToken)) instanceof Response),
  )
  assert.equal(await store.activePrinterFarm(printerA), farm)

  // The revoker is the printer-ownership role: it has no right on grants, so the cascade must not depend on it.
  await ownership`UPDATE farm.printer_assignments SET revoked_at = 2000000, revoked_by = ${owner} WHERE id = ${printerA}::uuid`
  const revokedToken = await statusRequest(printerA, originalToken)
  assert.ok(revokedToken instanceof Response)
  assert.equal(revokedToken.status, 401)
  const replacementToken = await issueToken()
  const revokedPrinter = await statusRequest(printerA, replacementToken)
  assert.ok(revokedPrinter instanceof Response)
  assert.equal(revokedPrinter.status, 404)
  assert.ok(
    !((await statusRequest(printerB, replacementToken)) instanceof Response),
  )
  checks.push('oauth-token-grants-and-active-printer-checked-in-postgres')

  const after = await store.listGrants(owner, app.id)
  const byId = new Map(after?.map((g) => [g.id, g]))
  assert.equal(byId.get(scopedA.id)?.disabledAt, 2_000_000)
  assert.equal(byId.get(scopedA.id)?.disabledReason, 'assignment-revoked')
  assert.equal(byId.get(scopedB.id)?.disabledAt, null)
  assert.equal(byId.get(wide.id)?.disabledAt, null)
  assert.deepEqual(
    (await store.effectiveGrants(app.id)).map((g) => g.id).sort(),
    [wide.id, approval.id, scopedB.id].sort(),
  )
  assert.equal(
    await service.createGrant(owner, {
      appId: app.id,
      farmId: farm,
      printerAssignmentId: printerA,
      scopes: ['printers:read'],
    }),
    'printer-unavailable',
    'no new grant on a revoked assignment',
  )
  await denied(
    admin`INSERT INTO farm.integration_app_grants (id, app_id, farm_id, printer_assignment_id, scopes, created_at, created_by) VALUES (${randomUUID()}::uuid, ${app.id}::uuid, ${farm}::uuid, ${printerA}::uuid, ARRAY['printers:read'], 1, ${owner})`,
    'database also refuses a grant on a revoked assignment',
  )
  await denied(
    admin`UPDATE farm.integration_app_grants SET disabled_at = NULL, disabled_reason = NULL WHERE id = ${scopedA.id}::uuid`,
    'disabling is terminal',
  )
  // Wrong-farm assignment.
  const foreign = await assignment(sandboxFarm, 'printer-sandbox')
  assert.equal(
    await service.createGrant(owner, {
      appId: app.id,
      farmId: farm,
      printerAssignmentId: foreign,
      scopes: ['printers:read'],
    }),
    'printer-unavailable',
  )
  assert.equal(await store.revokeGrant(owner, wide.id, ++clock.now), 'ok')
  assert.equal(
    await store.revokeGrant(owner, wide.id, ++clock.now),
    'not-found',
  )
  assert.ok(
    !(await store.effectiveGrants(app.id)).some((g) => g.id === wide.id),
  )
  checks.push('assignment-revocation-disables-printer-grants')

  // Sandbox apps never hold a grant on a non-sandbox farm: store path and database trigger.
  assert.equal(
    await service.createApp(owner, {
      farmId: farm,
      name: 'sbx',
      sandbox: true,
    }),
    'sandbox-violation',
  )
  await denied(
    admin`INSERT INTO farm.integration_apps (id, farm_id, name, sandbox, created_at, created_by) VALUES (${randomUUID()}::uuid, ${farm}::uuid, 'sbx', true, 1, ${owner})`,
    'database refuses a sandbox app on a non-sandbox farm',
  )
  const sandboxApp = await service.createApp(owner, {
    farmId: sandboxFarm,
    name: 'sbx',
    sandbox: true,
  })
  assert.ok(typeof sandboxApp === 'object')
  assert.equal(sandboxApp.sandbox, true)
  assert.equal(
    await service.createGrant(owner, {
      appId: sandboxApp.id,
      farmId: farm,
      scopes: ['printers:read'],
    }),
    'sandbox-violation',
  )
  await denied(
    admin`INSERT INTO farm.integration_app_grants (id, app_id, farm_id, scopes, created_at, created_by) VALUES (${randomUUID()}::uuid, ${sandboxApp.id}::uuid, ${farm}::uuid, ARRAY['printers:read'], 1, ${owner})`,
    'database refuses a sandbox app grant on a non-sandbox farm',
  )
  assert.equal(
    (
      await admin`SELECT count(*)::int AS n FROM farm.integration_app_grants WHERE app_id = ${sandboxApp.id}::uuid`
    )[0]?.n,
    0,
  )
  const sandboxGrant = await service.createGrant(owner, {
    appId: sandboxApp.id,
    farmId: sandboxFarm,
    scopes: ['printers:read'],
  })
  assert.ok(typeof sandboxGrant === 'object')
  await denied(
    admin`UPDATE farm.farms SET sandbox = false WHERE id = ${sandboxFarm}::uuid`,
    'a farm with sandbox apps cannot leave sandbox mode',
  )
  await denied(
    admin`UPDATE farm.integration_apps SET sandbox = false WHERE id = ${sandboxApp.id}::uuid`,
    'an app cannot change its sandbox flag',
  )
  // A regular app may still be granted access to a sandbox farm.
  const regularOnSandbox = await service.createGrant(owner, {
    appId: app.id,
    farmId: sandboxFarm,
    scopes: ['printers:read'],
  })
  assert.ok(typeof regularOnSandbox === 'object')
  checks.push('sandbox-app-never-on-non-sandbox-farm')

  // Least privilege and immutability of the remaining tables.
  for (const statement of [
    runtime`UPDATE farm.integration_apps SET name = 'renamed' WHERE id = ${app.id}::uuid`,
    runtime`DELETE FROM farm.integration_apps`,
    runtime`DELETE FROM farm.integration_app_grants`,
    runtime`TRUNCATE farm.integration_app_grants`,
    runtime`UPDATE farm.farms SET sandbox = true WHERE id = ${farm}::uuid`,
    runtime`INSERT INTO farm.farms (id) VALUES (${randomUUID()}::uuid)`,
    runtime`UPDATE farm.printer_assignments SET revoked_at = 1`,
  ])
    await denied(statement, 'role has no wider rights than the store needs')
  assert.equal(await store.revokeApp(viewer, app.id, ++clock.now), 'not-found')
  assert.equal(await store.revokeApp(owner, app.id, ++clock.now), 'ok')
  assert.equal(
    await service.authenticate(second.credential.clientId, second.secret),
    null,
  )
  assert.deepEqual(await store.effectiveGrants(app.id), [])
  assert.equal(await service.issueCredential(owner, app.id), 'not-found')
  checks.push('role-is-least-privilege-and-rows-are-guarded')
  return checks
}
