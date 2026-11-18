import assert from 'node:assert/strict'
import { randomBytes, randomUUID } from 'node:crypto'
import test from 'node:test'
import { newClientCredential } from '../../apps/farm/server/services/integration-apps.ts'
import {
  IntegrationAuth,
  parseIntegrationTokenConfig,
} from '../../apps/farm/server/utils/integration-auth.ts'
import {
  authorizeIntegrationRequest,
  integrationBase,
  integrationTokenRequest,
} from '../../apps/farm/server/utils/integration-auth-http.ts'

test('a sandbox credential can read its simulator but cannot access an existing real farm or printer', async () => {
  const { clientId, secret, secretHash } = newClientCredential()
  const appId = randomUUID()
  const sandboxFarm = randomUUID()
  const realFarm = randomUUID()
  const sandboxPrinter = randomUUID()
  const realPrinter = randomUUID()
  const printers = new Map<string, string>([
    [sandboxPrinter, sandboxFarm],
    [realPrinter, realFarm],
  ])
  const auth = new IntegrationAuth(
    {
      async findActiveCredential(id) {
        return id === clientId
          ? {
              id: appId,
              appId,
              clientId,
              secretHash,
              createdAt: 1,
              revokedAt: null,
            }
          : null
      },
      async effectiveGrants() {
        return [
          {
            id: appId,
            appId,
            farmId: sandboxFarm,
            printerAssignmentId: null,
            scopes: ['printers:read'],
            requiresApproval: false,
            createdAt: 1,
            disabledAt: null,
            disabledReason: null,
          },
        ]
      },
      async activePrinterFarm(id) {
        return printers.get(id) ?? null
      },
    },
    parseIntegrationTokenConfig({
      signingKey: randomBytes(32).toString('base64url'),
      tokenTtlSeconds: 300,
    }),
  )

  const base = 'http://localhost' + integrationBase
  const response = await integrationTokenRequest(
    new Request(base + '/oauth/token', {
      method: 'POST',
      body: new URLSearchParams({
        grant_type: 'client_credentials',
        client_id: clientId,
        client_secret: secret,
      }),
    }),
    () => auth,
  )
  assert.equal(response.status, 200)
  const { access_token } = await response.json()
  const authorize = (path: string, query = '') =>
    authorizeIntegrationRequest(
      new Request(base + path + query, {
        headers: { authorization: 'Bearer ' + access_token },
      }),
      path,
      () => auth,
    )
  const allowed = await authorize(`/printers/${sandboxPrinter}/status`)
  assert.ok(!(allowed instanceof Response))
  assert.equal(allowed.principal.grants[0]?.farmId, sandboxFarm)

  for (const denied of [
    await authorize('/printers', '?farmId=' + realFarm),
    await authorize(`/printers/${realPrinter}/status`),
  ]) {
    assert.ok(denied instanceof Response)
    assert.equal(denied.status, 404)
    assert.match(
      denied.headers.get('content-type') ?? '',
      /^application\/problem\+json/,
    )
    assert.equal((await denied.json()).code, 'not-found')
  }
})
