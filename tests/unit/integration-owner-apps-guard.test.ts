import { expect, test } from 'vitest'
import {
  createOwnerApp,
  readOwnerAppsJsonBody,
  requireOwnerAppsMutation,
  revokeOwnerGrant,
  type OwnerAppsDeps,
} from '../../apps/farm/server/services/integration-owner-apps-http.ts'
import {
  IntegrationAppsService,
  type IntegrationApp,
  type IntegrationAppsStore,
  type IntegrationGrant,
  type StoredCredential,
} from '../../apps/farm/server/services/integration-apps.ts'
import { mutation } from '../../apps/farm/server/services/authenticated-session.ts'
import type { AuthRuntime } from '../../apps/farm/server/utils/auth/runtime.ts'
import { SESSION_COOKIE_NAME } from '../../apps/farm/server/utils/auth/boundary.ts'

const origin = 'https://farm.example.invalid'
const farmA = '11111111-1111-4111-8111-111111111111'
const farmB = '22222222-2222-4222-8222-222222222222'
const appId = '33333333-3333-4333-8333-333333333333'
const grantId = '44444444-4444-4444-8444-444444444444'
const assignmentId = '55555555-5555-4555-8555-555555555555'

function authRuntime(): AuthRuntime {
  return {
    origin,
    cookie: {
      name: SESSION_COOKIE_NAME,
      password: 'synthetic-owner-apps-test-secret-32chars!',
      cookie: { secure: true, httpOnly: true, sameSite: 'lax', path: '/' },
    },
    idleTimeoutMs: 60_000,
    lifetimeMs: 3_600_000,
    sessions: {
      async authorizeAndTouch() {
        throw new Error('unused')
      },
      async revokeSession() {},
      async revokeAccountSessions() {},
    },
    credentials: {
      async consumeLimit() {
        return true
      },
      async find() {
        return null
      },
      async issue() {
        return null
      },
    },
  }
}

function mutationEvent(requestOrigin: string | null, init?: RequestInit) {
  const headers = new Headers(init?.headers)
  if (requestOrigin !== null) headers.set('origin', requestOrigin)
  return {
    req: new Request(`${origin}/api/farms/${farmA}/integrations/apps`, {
      method: 'POST',
      ...init,
      headers,
    }),
    res: { headers: new Headers() },
  }
}

function fixture(grantFarmId: string) {
  const grant: IntegrationGrant = {
    id: grantId,
    appId,
    farmId: grantFarmId,
    printerAssignmentId: assignmentId,
    scopes: ['printers:read'],
    requiresApproval: false,
    createdAt: 1,
    disabledAt: null,
    disabledReason: null,
  }
  const app: IntegrationApp = {
    id: appId,
    farmId: farmA,
    name: 'App',
    sandbox: false,
    createdAt: 1,
    revokedAt: null,
  }
  const audits: {
    farmId: string
    appId: string | null
    printerAssignmentId: string | null
    resourceId: string | null
    outcome: string
  }[] = []
  const revokeCalls: { grantId: string; expectedFarmId?: string }[] = []
  const store: IntegrationAppsStore = {
    async createApp() {
      return app
    },
    async revokeApp() {
      return 'not-found'
    },
    async addCredential(_actor, id, input, now) {
      return {
        id: '66666666-6666-4666-8666-666666666666',
        appId: id,
        clientId: input.clientId,
        createdAt: now,
        revokedAt: null,
      }
    },
    async revokeCredential() {
      return 'not-found'
    },
    async createGrant() {
      return grant
    },
    async revokeGrant(_actor, id, _now, expectedFarmId) {
      revokeCalls.push(
        expectedFarmId === undefined
          ? { grantId: id }
          : { grantId: id, expectedFarmId },
      )
      if (id !== grant.id) return 'not-found'
      if (expectedFarmId !== undefined && grant.farmId !== expectedFarmId)
        return 'not-found'
      if (grant.disabledAt !== null) return 'not-found'
      grant.disabledAt = 2
      grant.disabledReason = 'revoked'
      return {
        farmId: grant.farmId,
        appId: grant.appId,
        printerAssignmentId: grant.printerAssignmentId,
      }
    },
    async listApps() {
      return [app]
    },
    async listGrants() {
      return [grant]
    },
    async findActiveCredential() {
      return null as StoredCredential | null
    },
    async effectiveGrants() {
      return grant.disabledAt ? [] : [grant]
    },
  }
  const deps: OwnerAppsDeps = {
    apps: new IntegrationAppsService(store, () => 2),
    isOwner: async (_actor, id) => id === farmA || id === farmB,
    listPrinters: async () => [],
    audit: {
      record: async (
        entry: Parameters<NonNullable<OwnerAppsDeps['audit']>['record']>[0],
      ) => {
        audits.push({
          farmId: entry.farmId,
          appId: entry.appId,
          printerAssignmentId: entry.printerAssignmentId,
          resourceId: entry.resourceId,
          outcome: entry.outcome,
        })
        return entry as never
      },
      listForOwner: async () => [],
    } as never,
  }
  return { deps, audits, revokeCalls, grant }
}

test('revoking through another farm route is refused', async () => {
  const { deps, audits, revokeCalls, grant } = fixture(farmB)
  await expect(
    revokeOwnerGrant(deps, 'owner', farmA, grantId),
  ).rejects.toMatchObject({ status: 404 })
  expect(grant.disabledAt).toBeNull()
  expect(audits).toEqual([])
  expect(revokeCalls).toEqual([{ grantId, expectedFarmId: farmA }])
})

test('normal revocation audits the grant farm from the affected row', async () => {
  const { deps, audits, revokeCalls } = fixture(farmA)
  await expect(
    revokeOwnerGrant(deps, 'owner', farmA, grantId),
  ).resolves.toEqual({ ok: true })
  expect(revokeCalls).toEqual([{ grantId, expectedFarmId: farmA }])
  expect(audits).toEqual([
    {
      farmId: farmA,
      appId,
      printerAssignmentId: assignmentId,
      resourceId: grantId,
      outcome: 'revoked',
    },
  ])
})

test('owner app mutations refuse a missing or foreign Origin', () => {
  const runtime = authRuntime()
  for (const requestOrigin of [
    null,
    'null',
    'https://evil.invalid',
    origin + '/',
  ]) {
    const event = mutationEvent(requestOrigin) as Parameters<
      typeof requireOwnerAppsMutation
    >[0]
    expect(() => requireOwnerAppsMutation(event, runtime)).toThrow(
      expect.objectContaining({ status: 403 }),
    )
    expect(() => mutation(event, runtime)).toThrow(
      expect.objectContaining({ status: 403 }),
    )
  }
  expect(() =>
    requireOwnerAppsMutation(
      mutationEvent(origin) as Parameters<typeof requireOwnerAppsMutation>[0],
      runtime,
    ),
  ).not.toThrow()
})

test('owner app mutations accept JSON bodies only', async () => {
  await expect(
    readOwnerAppsJsonBody(
      new Request(`${origin}/x`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: 'name=Painel',
      }),
    ),
  ).rejects.toMatchObject({ status: 415 })
  await expect(
    readOwnerAppsJsonBody(
      new Request(`${origin}/x`, {
        method: 'POST',
        headers: { 'content-type': 'text/plain' },
        body: '{"name":"Painel"}',
      }),
    ),
  ).rejects.toMatchObject({ status: 415 })
  await expect(
    readOwnerAppsJsonBody(
      new Request(`${origin}/x`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'Painel' }),
      }),
    ),
  ).resolves.toEqual({ name: 'Painel' })
})

test('create still works for an owner of the route farm', async () => {
  const { deps } = fixture(farmA)
  const created = await createOwnerApp(deps, 'owner', farmA, { name: 'Painel' })
  expect(created.app.farmId).toBe(farmA)
  expect(created.secret).toMatch(/^ofs_/)
})
