import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import {
  IntegrationAppsService,
  hashClientSecret,
  type IntegrationApp,
  type IntegrationAppsStore,
  type IntegrationGrant,
  type StoredCredential,
} from '../../apps/farm/server/services/integration-apps.ts'
import {
  revokeOwnerApp,
  revokeOwnerCredential,
  type OwnerAppsDeps,
} from '../../apps/farm/server/services/integration-owner-apps-http.ts'
import { deliverNextWebhook } from '../../apps/farm/server/services/webhook-worker.ts'
import {
  IntegrationAuth,
  parseIntegrationTokenConfig,
} from '../../apps/farm/server/utils/integration-auth.ts'

const farmId = '11111111-1111-4111-8111-111111111111'
const appId = '22222222-2222-4222-8222-222222222222'
const credentialId = '33333333-3333-4333-8333-333333333333'
const assignmentId = '44444444-4444-4444-8444-444444444444'
const secret = 'ofs_' + 'A'.repeat(43)
const secretHash = hashClientSecret(secret)

function issuedToken(value: string | { access_token: string }) {
  if (typeof value === 'string')
    throw new Error(`Token was not issued: ${value}`)
  return value.access_token
}

function fixture() {
  const app: IntegrationApp = {
    id: appId,
    farmId,
    name: 'App',
    sandbox: false,
    createdAt: 1,
    revokedAt: null,
  }
  const credential: StoredCredential = {
    id: credentialId,
    appId,
    clientId: 'client_identifier_1234',
    secretHash,
    createdAt: 1,
    revokedAt: null,
  }
  const grant: IntegrationGrant = {
    id: '55555555-5555-4555-8555-555555555555',
    appId,
    farmId,
    printerAssignmentId: assignmentId,
    scopes: ['printers:read'],
    requiresApproval: false,
    createdAt: 1,
    disabledAt: null,
    disabledReason: null,
  }
  let revoked = false
  let assignmentActive = true
  const audits: unknown[] = []
  const store: IntegrationAppsStore = {
    async createApp() {
      return 'not-found'
    },
    async revokeApp(_actorId, id) {
      if (id !== appId || revoked) return 'not-found'
      revoked = true
      return 'ok'
    },
    async addCredential() {
      return 'not-found'
    },
    async revokeCredential(_actorId, id, _now, expectedFarmId) {
      if (id !== credentialId || expectedFarmId !== farmId) return 'not-found'
      credential.revokedAt = 2
      return 'ok'
    },
    async createGrant() {
      return 'not-found'
    },
    async revokeGrant() {
      return 'not-found'
    },
    async listApps() {
      return [{ ...app, revokedAt: revoked ? 2 : null }]
    },
    async listGrants() {
      return [grant]
    },
    async findActiveCredential(clientId) {
      return clientId === credential.clientId &&
        !revoked &&
        credential.revokedAt === null
        ? credential
        : null
    },
    async effectiveGrants() {
      return !revoked && assignmentActive ? [grant] : []
    },
  }
  const service = new IntegrationAppsService(store, () => 2)
  const auth = new IntegrationAuth(
    {
      ...store,
      async activePrinterFarm() {
        return farmId
      },
    },
    parseIntegrationTokenConfig({
      signingKey: Buffer.alloc(32, 7).toString('base64url'),
      tokenTtlSeconds: 300,
    }),
    () => 2,
  )
  const deps: OwnerAppsDeps = {
    apps: service,
    isOwner: async (_actor, id) => id === farmId,
    listPrinters: async () => [],
    audit: {
      record: async (
        entry: Parameters<NonNullable<OwnerAppsDeps['audit']>['record']>[0],
      ) => {
        audits.push(entry)
        return entry as never
      },
      listForOwner: async () => [],
    } as never,
  }
  return {
    app,
    credential,
    grant,
    service,
    auth,
    deps,
    audits,
    revokeAssignment: () => {
      assignmentActive = false
    },
  }
}

test('revoking an app or credential rejects the next client credential authentication', async () => {
  const appFixture = fixture()
  const appToken = await appFixture.auth.issue(
    appFixture.credential.clientId,
    secret,
    undefined,
  )
  assert.notEqual(appToken, 'invalid_client')
  assert.ok(await appFixture.auth.verify(issuedToken(appToken)))
  await revokeOwnerApp(appFixture.deps, 'owner', farmId, appId)
  assert.equal(await appFixture.auth.verify(issuedToken(appToken)), null)
  assert.equal(
    await appFixture.service.authenticate(
      appFixture.credential.clientId,
      secret,
    ),
    null,
  )
  assert.equal(appFixture.audits.length, 1)

  const credentialFixture = fixture()
  const credentialToken = await credentialFixture.auth.issue(
    credentialFixture.credential.clientId,
    secret,
    undefined,
  )
  assert.notEqual(credentialToken, 'invalid_client')
  assert.ok(await credentialFixture.auth.verify(issuedToken(credentialToken)))
  await revokeOwnerCredential(
    credentialFixture.deps,
    'owner',
    farmId,
    credentialId,
  )
  assert.equal(
    await credentialFixture.auth.verify(issuedToken(credentialToken)),
    null,
  )
  assert.equal(
    await credentialFixture.service.authenticate(
      credentialFixture.credential.clientId,
      secret,
    ),
    null,
  )
  assert.equal(credentialFixture.audits.length, 1)
})

test('assignment revocation removes printer-scoped grants on the next authorization lookup', async () => {
  const f = fixture()
  const token = await f.auth.issue(f.credential.clientId, secret, undefined)
  assert.notEqual(token, 'invalid_client')
  assert.deepEqual((await f.auth.verify(issuedToken(token)))?.grants, [f.grant])
  f.revokeAssignment()
  assert.equal(await f.auth.verify(issuedToken(token)), null)
  const storage = await readFile(
    new URL(
      '../../apps/farm/server/storage/integration-apps-postgres.ts',
      import.meta.url,
    ),
    'utf8',
  )
  assert.match(storage, /p\.revoked_at IS NULL/)
  const migration = await readFile(
    new URL(
      '../../infra/db/migrations/0040_integration_apps.up.sql',
      import.meta.url,
    ),
    'utf8',
  )
  assert.match(migration, /disabled_reason = 'assignment-revoked'/)
})

test('webhook delivery for a revoked app is marked dead without sending', async () => {
  let sent = false
  let finish: string | undefined
  const handled = await deliverNextWebhook(
    {
      async claim() {
        return {
          subscriptionId: 'subscription',
          eventId: 'event',
          sandbox: false,
          secret: 'secret',
          body: '{}',
          url: 'https://example.test',
          attempts: 1,
        }
      },
      async eligible() {
        return false
      },
      async finish(_delivery, outcome) {
        finish = outcome
      },
    },
    async () => {
      sent = true
      return true
    },
  )
  assert.equal(handled, true)
  assert.equal(sent, false)
  assert.equal(finish, 'dead')
  const storage = await readFile(
    new URL(
      '../../apps/farm/server/storage/webhook-postgres.ts',
      import.meta.url,
    ),
    'utf8',
  )
  assert.match(
    storage,
    /farm\.integration_webhook_allowed\(w\.app_id, o\.farm_id, o\.printer_id\)/,
  )
})
