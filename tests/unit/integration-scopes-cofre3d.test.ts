import { readFile } from 'node:fs/promises'
import { describe, expect, test } from 'vitest'
import { parse } from 'yaml'
import { loadMigrationCatalog } from '../../scripts/db/migrations.ts'
import {
  hashClientSecret,
  INTEGRATION_SCOPES,
  IntegrationAppsService,
  type IntegrationAppsStore,
  type IntegrationGrant,
  type IntegrationScope,
  type StoredCredential,
  validScopes,
} from '../../apps/farm/server/services/integration-apps.ts'
import {
  IntegrationAuth,
  type IntegrationAuthStore,
  parseIntegrationTokenConfig,
} from '../../apps/farm/server/utils/integration-auth.ts'
import { integrationGrantFor } from '../../apps/farm/server/utils/integration-auth-http.ts'

const NEW_SCOPES = [
  'environment:read',
  'plates:confirm',
  'alerts:write',
  'camera:view',
] as const
const farmId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const printerId = 'aaaaaaaa-0000-4000-8000-000000000001'
const clientId = 'ofc_scopes_test_only'
const secret = 'scopes-fixture-secret'

function authWith(scopes: IntegrationScope[]) {
  const now = 50_000
  const credential: StoredCredential = {
    id: 'credential',
    appId: 'app',
    clientId,
    secretHash: hashClientSecret(secret),
    createdAt: now,
    revokedAt: null,
  }
  const grant: IntegrationGrant = {
    id: 'grant',
    appId: 'app',
    farmId,
    printerAssignmentId: printerId,
    scopes,
    requiresApproval: false,
    createdAt: now,
    disabledAt: null,
    disabledReason: null,
  }
  const store: IntegrationAuthStore = {
    async findActiveCredential(id: string) {
      return id === clientId ? credential : null
    },
    async effectiveGrants() {
      return [grant]
    },
    async activePrinterFarm(id: string) {
      return id === printerId ? farmId : null
    },
  }
  const config = parseIntegrationTokenConfig({
    signingKey: Buffer.alloc(32, 7).toString('base64url'),
    tokenTtlSeconds: '60',
  })
  return new IntegrationAuth(store, config, () => now)
}

describe('Cofre3D integration scopes', () => {
  test('are registered after the existing scopes so token masks stay stable', () => {
    expect(INTEGRATION_SCOPES.slice(0, 11)).toEqual([
      'printers:read',
      'files:read',
      'inventory:read',
      'jobs:read',
      'jobs:start',
      'control:basic',
      'control:extended',
      'events:subscribe',
      'jobs:write',
      'library:read',
      'library:write',
    ])
    expect(INTEGRATION_SCOPES.slice(11)).toEqual([...NEW_SCOPES])
    // Masks are 32-bit bitwise values.
    expect(INTEGRATION_SCOPES.length).toBeLessThanOrEqual(31)
  })

  test('grant validation accepts each new scope and rejects unknown ones', () => {
    for (const scope of NEW_SCOPES) expect(validScopes([scope])).toBe(true)
    expect(validScopes([...INTEGRATION_SCOPES])).toBe(true)
    expect(validScopes(['camera:view', 'camera:view'])).toBe(false)
    expect(validScopes(['camera:control'])).toBe(false)
    expect(validScopes(['plates:read', 'printers:read'])).toBe(false)
  })

  test('passes an owner grant with the new scopes to the store', async () => {
    const store: IntegrationAppsStore = {
      createApp: async () => 'not-found',
      revokeApp: async () => 'not-found',
      addCredential: async () => 'not-found',
      revokeCredential: async () => 'not-found',
      createGrant: async (actor, input, now) => {
        expect(actor).toBe('owner')
        expect(input.scopes).toEqual([...NEW_SCOPES])
        return {
          id: 'grant',
          ...input,
          printerAssignmentId: input.printerAssignmentId ?? null,
          requiresApproval: input.requiresApproval ?? false,
          createdAt: now,
          disabledAt: null,
          disabledReason: null,
        }
      },
      revokeGrant: async () => 'not-found',
      listApps: async () => null,
      listGrants: async () => null,
      findActiveCredential: async () => null,
      effectiveGrants: async () => [],
    }
    const service = new IntegrationAppsService(store, () => 50_000)
    const input = { appId: 'app', farmId, scopes: [...NEW_SCOPES] }
    expect(await service.createGrant('owner', input)).toMatchObject(input)
  })

  test('issues and verifies tokens carrying the new scopes', async () => {
    const auth = authWith(['printers:read', ...NEW_SCOPES])
    const token = await auth.issue(clientId, secret, [...NEW_SCOPES])
    if (typeof token === 'string') throw new Error(token)
    expect(token.scope).toBe(NEW_SCOPES.join(' '))
    const principal = await auth.verify(token.access_token)
    expect(principal?.scopes).toEqual([...NEW_SCOPES])
    for (const scope of NEW_SCOPES)
      expect(
        integrationGrantFor(principal!, scope, farmId, printerId)?.id,
      ).toBe('grant')

    const all = await auth.issue(clientId, secret, undefined)
    if (typeof all === 'string') throw new Error(all)
    expect(all.scope).toBe(['printers:read', ...NEW_SCOPES].join(' '))
  })

  test('refuses a new scope that the owner did not grant', async () => {
    const auth = authWith(['printers:read', 'environment:read'])
    for (const scope of ['plates:confirm', 'alerts:write', 'camera:view'])
      expect(await auth.issue(clientId, secret, [scope])).toBe('invalid_scope')
    expect(
      await auth.issue(clientId, secret, ['environment:read', 'camera:view']),
    ).toBe('invalid_scope')

    const token = await auth.issue(clientId, secret, ['printers:read'])
    if (typeof token === 'string') throw new Error(token)
    const principal = await auth.verify(token.access_token)
    expect(principal?.scopes).toEqual(['printers:read'])
    for (const scope of NEW_SCOPES)
      expect(
        integrationGrantFor(principal!, scope, farmId, printerId),
      ).toBeUndefined()
  })

  test('migration 0094 extends the DB scope check with a guarded rollback', async () => {
    const catalog = await loadMigrationCatalog()
    expect(catalog[93]?.id).toBe('0094_integration_cofre3d_scopes')
    const dir = new URL('../../infra/db/migrations/', import.meta.url)
    const up = await readFile(
      new URL('0094_integration_cofre3d_scopes.up.sql', dir),
      'utf8',
    )
    const down = await readFile(
      new URL('0094_integration_cofre3d_scopes.down.sql', dir),
      'utf8',
    )
    const quoted = INTEGRATION_SCOPES.map((scope) => `'${scope}'`).join(',')
    expect(up).toContain(`ARRAY[${quoted}]::text[]`)
    expect(up).toContain(
      `cardinality(scopes) BETWEEN 1 AND ${INTEGRATION_SCOPES.length}`,
    )
    expect(down).toContain('FROM farm.integration_app_grants')
    expect(down).toContain('RAISE EXCEPTION')
    for (const scope of NEW_SCOPES) expect(down).toContain(`'${scope}'`)
    expect(down).toContain('cardinality(scopes) BETWEEN 1 AND 11')
    expect(down.indexOf('RAISE EXCEPTION')).toBeLessThan(
      down.indexOf('CREATE OR REPLACE FUNCTION'),
    )
  })

  test('documents and labels every new scope', async () => {
    const spec = parse(await readFile('docs/api/openapi-v1.yaml', 'utf8')) as {
      components: {
        securitySchemes: {
          clientCredentials: {
            flows: { clientCredentials: { scopes: Record<string, string> } }
          }
        }
      }
    }
    expect(
      Object.keys(
        spec.components.securitySchemes.clientCredentials.flows
          .clientCredentials.scopes,
      ).sort(),
    ).toEqual([...INTEGRATION_SCOPES].sort())
    const guide = await readFile('docs/INTEGRATION-API.md', 'utf8')
    const page = await readFile('apps/farm/app/pages/integracoes.vue', 'utf8')
    for (const scope of INTEGRATION_SCOPES)
      expect(guide).toMatch(new RegExp(`^\\|[ \t]*\`${scope}\`[ \t]*\\|`, 'm'))
    expect(page).toContain("['environment:read', 'Consultar ambiente']")
    expect(page).toContain("['plates:confirm', 'Confirmar placa livre']")
    expect(page).toContain("['alerts:write', 'Enviar alertas']")
    expect(page).toContain("['camera:view', 'Ver câmera']")
  })
})
