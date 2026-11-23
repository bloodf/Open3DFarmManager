import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { parse } from 'yaml'
import {
  findDestructiveOperations,
  stripSqlCommentsAndStrings,
} from '../../scripts/db/migration-rules.ts'
import { PG_SUITE_CONTRACTS } from '../../scripts/test-postgres.ts'
import {
  INTEGRATION_SCOPES,
  IntegrationAppsService,
  hashClientSecret,
  newClientCredential,
  secretMatches,
  validScopes,
  type IntegrationAppsStore,
  type IntegrationCredential,
  type StoredCredential,
} from '../../apps/farm/server/services/integration-apps.ts'
import { PostgresIntegrationApps } from '../../apps/farm/server/storage/integration-apps-postgres.ts'

const read = (path: string) =>
  readFileSync(fileURLToPath(new URL(`../../${path}`, import.meta.url)), 'utf8')
const up = read('infra/db/migrations/0040_integration_apps.up.sql')
const down = read('infra/db/migrations/0040_integration_apps.down.sql')

test('scopes match the OpenAPI contract and the migration check', () => {
  const spec = parse(read('docs/api/openapi-v1.yaml')) as {
    components: {
      securitySchemes: {
        clientCredentials: {
          flows: { clientCredentials: { scopes: Record<string, string> } }
        }
      }
    }
  }
  const declared = Object.keys(
    spec.components.securitySchemes.clientCredentials.flows.clientCredentials
      .scopes,
  )
  assert.deepEqual([...INTEGRATION_SCOPES].sort(), declared.sort())
  const scopesMigration = read(
    'infra/db/migrations/0101_integration_cofre3d_scopes_2.up.sql',
  )
  const inSql = [...scopesMigration.matchAll(/ARRAY\[([^\]]+)\]::text\[\]/g)]
    .map((m) => m[1]!.match(/'([^']+)'/g)!.map((s) => s.slice(1, -1)))
    .find((list) => list.length === declared.length)
  assert.deepEqual([...(inSql ?? [])].sort(), declared.sort())
})

test('migration 0040 has a down file, passes the safety rules and stores no plaintext secret', () => {
  assert.ok(down.includes('DROP TABLE farm.integration_apps'))
  assert.ok(down.includes('DROP COLUMN sandbox'))
  assert.deepEqual(
    findDestructiveOperations(stripSqlCommentsAndStrings(up)),
    [],
  )
  assert.match(up, /secret_hash text NOT NULL CHECK \(secret_hash ~ '\^sha256:/)
  assert.doesNotMatch(up, /\bsecret\s+text\b/i)
  assert.match(up, /requires_approval boolean NOT NULL/)
  assert.match(up, /A sandbox app cannot hold a grant on a non-sandbox farm/)
})

test('the postgres suite is registered with the runner', () => {
  assert.equal(
    PG_SUITE_CONTRACTS['test-postgres-integration-apps.ts']?.migrations,
    'full',
  )
})

test('client secrets are hashed, verified in constant form and never stored in plaintext', () => {
  const fresh = newClientCredential()
  assert.match(fresh.clientId, /^ofc_[A-Za-z0-9_-]{24}$/)
  assert.match(fresh.secret, /^ofs_[A-Za-z0-9_-]{43}$/)
  assert.match(fresh.secretHash, /^sha256:[0-9a-f]{64}$/)
  assert.ok(!fresh.secretHash.includes(fresh.secret))
  assert.equal(fresh.secretHash, hashClientSecret(fresh.secret))
  assert.equal(secretMatches(fresh.secretHash, fresh.secret), true)
  assert.equal(secretMatches(fresh.secretHash, fresh.secret + 'x'), false)
  assert.equal(secretMatches('', fresh.secret), false)
  assert.equal(secretMatches(fresh.secret, fresh.secret), false)
  assert.notEqual(newClientCredential().secret, fresh.secret)
})

test('scope validation rejects empty, unknown and duplicated sets', () => {
  assert.equal(validScopes(['printers:read', 'jobs:start']), true)
  assert.equal(validScopes([]), false)
  assert.equal(validScopes(['printers:write']), false)
  assert.equal(validScopes(['printers:read', 'printers:read']), false)
  assert.equal(validScopes('printers:read'), false)
})

function fakeStore() {
  const calls: { secretHash?: string; clientId?: string } = {}
  const credentials = new Map<string, StoredCredential>()
  const store: IntegrationAppsStore = {
    createApp: async () => 'not-found',
    revokeApp: async () => 'not-found',
    addCredential: async (_actor, appId, input, now) => {
      calls.secretHash = input.secretHash
      calls.clientId = input.clientId
      const credential: IntegrationCredential = {
        id: 'cred-1',
        appId,
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
    revokeCredential: async () => 'not-found',
    createGrant: async () => 'not-found',
    revokeGrant: async () => 'not-found',
    listApps: async () => null,
    listGrants: async () => null,
    findActiveCredential: async (clientId) => credentials.get(clientId) ?? null,
    effectiveGrants: async () => [],
  }
  return { store, calls, credentials }
}

test('service issues a secret once, hands the store only its digest and authenticates it', async () => {
  const { store, calls, credentials } = fakeStore()
  const service = new IntegrationAppsService(store, () => 1_000)
  const issued = await service.issueCredential('actor', 'app-1')
  assert.ok(typeof issued === 'object')
  assert.equal(calls.secretHash, hashClientSecret(issued.secret))
  assert.ok(!JSON.stringify(issued.credential).includes(issued.secret))
  assert.ok(!JSON.stringify([...credentials.values()]).includes(issued.secret))
  assert.deepEqual(
    await service.authenticate(issued.credential.clientId, issued.secret),
    { appId: 'app-1', grants: [] },
  )
  assert.equal(
    await service.authenticate(issued.credential.clientId, 'ofs_wrong'),
    null,
  )
  assert.equal(await service.authenticate('ofc_unknown', issued.secret), null)
})

test('service and store reject invalid input before touching the database', async () => {
  const { store } = fakeStore()
  const service = new IntegrationAppsService(store)
  assert.equal(
    await service.createGrant('actor', {
      appId: 'a',
      farmId: 'f',
      scopes: ['nope' as never],
    }),
    'invalid-input',
  )
  // No connection is ever opened: the fake rejects any query.
  const sql = new Proxy(() => {}, {
    get() {
      throw new Error('database touched')
    },
    apply() {
      throw new Error('database touched')
    },
  }) as never
  const pg = new PostgresIntegrationApps(sql)
  const farmId = '11111111-1111-4111-8111-111111111111'
  assert.equal(
    await pg.createApp('actor', { farmId, name: '   ', sandbox: false }, 1),
    'invalid-input',
  )
  assert.equal(
    await pg.createApp(
      'actor',
      { farmId, name: 'x\u0000y', sandbox: false },
      1,
    ),
    'invalid-input',
  )
  assert.equal(
    await pg.addCredential(
      'actor',
      farmId,
      { clientId: 'ofc_0123456789abcdef', secretHash: 'plaintext-secret' },
      1,
    ),
    'invalid-input',
  )
  assert.equal(
    await pg.createGrant(
      'actor',
      { appId: farmId, farmId, scopes: ['printers:read', 'printers:read'] },
      1,
    ),
    'invalid-input',
  )
  assert.equal(await pg.findActiveCredential('bad id'), null)
  assert.deepEqual(await pg.effectiveGrants('not-a-uuid'), [])
})
