import assert from 'node:assert/strict'
import test from 'node:test'
import {
  createOwnerApp,
  createOwnerGrant,
  listOwnerApps,
  listOwnerGrants,
  revokeOwnerGrant,
  type OwnerAppsDeps,
} from '../../apps/farm/server/services/integration-owner-apps-http.ts'
import {
  IntegrationAppsService,
  type IntegrationAppsStore,
  type IntegrationApp,
  type IntegrationGrant,
  type IntegrationCredential,
  type StoredCredential,
} from '../../apps/farm/server/services/integration-apps.ts'

const farmId = '11111111-1111-4111-8111-111111111111'
const appId = '22222222-2222-4222-8222-222222222222'
const grantId = '33333333-3333-4333-8333-333333333333'
const assignmentId = '44444444-4444-4444-8444-444444444444'

function fixture(): {
  deps: OwnerAppsDeps
  state: {
    owner: boolean
    apps: IntegrationApp[]
    grants: IntegrationGrant[]
    secret: string | null
  }
} {
  const state = {
    owner: true,
    apps: [] as IntegrationApp[],
    grants: [] as IntegrationGrant[],
    secret: null as string | null,
  }
  const credentials = new Map<string, StoredCredential>()
  const store: IntegrationAppsStore = {
    async createApp(_actor, input, now) {
      const app = {
        id: appId,
        farmId: input.farmId,
        name: input.name,
        sandbox: input.sandbox,
        createdAt: now,
        revokedAt: null,
      }
      state.apps.push(app)
      return app
    },
    async revokeApp() {
      return 'not-found'
    },
    async addCredential(_actor, id, input, now) {
      const credential: IntegrationCredential = {
        id: '55555555-5555-4555-8555-555555555555',
        appId: id,
        clientId: input.clientId,
        createdAt: now,
        revokedAt: null,
      }
      credentials.set(input.clientId, {
        ...credential,
        secretHash: input.secretHash,
      })
      return credential
    },
    async revokeCredential() {
      return 'not-found'
    },
    async createGrant(_actor, input, now) {
      const grant = {
        id: grantId,
        appId: input.appId,
        farmId: input.farmId,
        printerAssignmentId: input.printerAssignmentId ?? null,
        scopes: input.scopes,
        requiresApproval: input.requiresApproval ?? false,
        createdAt: now,
        disabledAt: null,
        disabledReason: null,
      }
      state.grants.push(grant)
      return grant
    },
    async revokeGrant(_actor, id, _now, expectedFarmId) {
      const grant = state.grants.find((item) => item.id === id)
      if (!grant) return 'not-found'
      if (expectedFarmId !== undefined && grant.farmId !== expectedFarmId)
        return 'not-found'
      grant.disabledAt = Date.now()
      grant.disabledReason = 'revoked'
      return {
        farmId: grant.farmId,
        appId: grant.appId,
        printerAssignmentId: grant.printerAssignmentId,
      }
    },

    async listApps(_actor, id) {
      return id === farmId ? [...state.apps] : null
    },
    async listGrants(_actor, id) {
      return id === appId
        ? state.grants.filter((grant) => !grant.disabledAt)
        : null
    },
    async findActiveCredential(id) {
      return credentials.get(id) ?? null
    },
    async effectiveGrants(id) {
      return state.grants.filter(
        (grant) => grant.appId === id && !grant.disabledAt,
      )
    },
  }
  return {
    state,
    deps: {
      apps: new IntegrationAppsService(store, () => 1_000),
      isOwner: async (_actor, id) => id === farmId && state.owner,
      listPrinters: async () => [{ assignmentId, printerKey: 'printer-1' }],
    },
  }
}

async function denied(action: () => Promise<unknown>) {
  await assert.rejects(
    action,
    (error: unknown) =>
      !!error &&
      typeof error === 'object' &&
      'statusCode' in error &&
      error.statusCode === 404,
  )
}

test('only an active farm owner can register apps or manage scope grants', async () => {
  const { deps, state } = fixture()
  state.owner = false
  await denied(() => createOwnerApp(deps, 'member', farmId, { name: 'App' }))
  await denied(() => listOwnerApps(deps, 'member', farmId))
  await denied(() => listOwnerGrants(deps, 'member', farmId, appId))
  await denied(() =>
    createOwnerGrant(deps, 'member', farmId, appId, {
      scopes: ['printers:read'],
    }),
  )
  await denied(() => revokeOwnerGrant(deps, 'member', farmId, grantId))
})

test('owner receives a client secret once; listings never include it', async () => {
  const { deps, state } = fixture()
  const created = await createOwnerApp(deps, 'owner', farmId, {
    name: 'Painel',
  })
  assert.match(created.secret, /^ofs_[A-Za-z0-9_-]{43}$/)
  assert.ok(!JSON.stringify(created.app).includes(created.secret))
  const listing = await listOwnerApps(deps, 'owner', farmId)
  assert.equal(JSON.stringify(listing).includes(created.secret), false)
  assert.equal(
    JSON.stringify(listing).includes(created.credential.clientId),
    false,
  )
  assert.equal(state.apps.length, 1)
})

test('owner grants farm or printer scopes and can require approval or revoke access', async () => {
  const { deps } = fixture()
  await createOwnerApp(deps, 'owner', farmId, { name: 'Painel' })
  const created = await createOwnerGrant(deps, 'owner', farmId, appId, {
    printerAssignmentId: assignmentId,
    scopes: ['printers:read', 'jobs:start'],
    requiresApproval: true,
  })
  assert.equal(created.grant.printerAssignmentId, assignmentId)
  assert.equal(created.grant.requiresApproval, true)
  assert.deepEqual(created.grant.scopes, ['printers:read', 'jobs:start'])
  assert.deepEqual(
    (await listOwnerGrants(deps, 'owner', farmId, appId)).grants,
    [created.grant],
  )
  assert.deepEqual(await revokeOwnerGrant(deps, 'owner', farmId, grantId), {
    ok: true,
  })
  assert.deepEqual(
    (await listOwnerGrants(deps, 'owner', farmId, appId)).grants,
    [],
  )
})

test('owner grant rejects empty or unknown scopes', async () => {
  const { deps } = fixture()
  await assert.rejects(
    createOwnerGrant(deps, 'owner', farmId, appId, { scopes: [] }),
  )
  await assert.rejects(
    createOwnerGrant(deps, 'owner', farmId, appId, {
      scopes: ['printers:admin'],
    }),
  )
})
