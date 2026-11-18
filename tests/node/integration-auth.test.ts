import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { parse } from 'yaml'
import {
  hashClientSecret,
  type IntegrationGrant,
  type StoredCredential,
} from '../../apps/farm/server/services/integration-apps.ts'
import {
  IntegrationAuth,
  parseIntegrationTokenConfig,
} from '../../apps/farm/server/utils/integration-auth.ts'
import {
  authorizeIntegrationRequest,
  integrationBase,
  integrationGrantFor,
  integrationPolicy,
  integrationTokenRequest,
} from '../../apps/farm/server/utils/integration-auth-http.ts'
import { IntegrationLimits } from '../../apps/farm/server/utils/integration-auth-limits.ts'

const farmA = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const farmB = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const printerA = 'aaaaaaaa-0000-4000-8000-000000000001'
const printerB = 'aaaaaaaa-0000-4000-8000-000000000002'
const printerC = 'bbbbbbbb-0000-4000-8000-000000000001'
const clientId = 'ofc_auth_test_only'
const secret = 'fixture+:secret /'
const basic =
  'Basic ' +
  Buffer.from(clientId + ':' + encodeURIComponent(secret)).toString('base64')

function fixture(ttl = 11) {
  let now = 100_000
  let active = true
  let failure: Error | undefined
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
    farmId: farmA,
    printerAssignmentId: printerA,
    scopes: ['printers:read', 'jobs:read', 'control:basic'],
    requiresApproval: true,
    createdAt: now,
    disabledAt: null,
    disabledReason: null,
  }
  const grants: IntegrationGrant[] = [
    grant,
    {
      ...grant,
      id: 'other-grant',
      farmId: farmB,
      printerAssignmentId: null,
      scopes: ['control:extended'],
    },
  ]
  const store = {
    async findActiveCredential(id: string) {
      if (failure) throw failure
      return active && id === clientId ? credential : null
    },
    async effectiveGrants() {
      return grants
    },
    async activePrinterFarm(id: string) {
      return (
        new Map([
          [printerA, farmA],
          [printerB, farmA],
          [printerC, farmB],
        ]).get(id) ?? null
      )
    },
  }
  const config = (key: number) =>
    parseIntegrationTokenConfig({
      signingKey: Buffer.alloc(32, key).toString('base64url'),
      tokenTtlSeconds: String(ttl),
    })
  let auth = new IntegrationAuth(store, config(1), () => now)
  const rate = new IntegrationLimits(() => now)
  return {
    grants,
    advance(ms: number) {
      now += ms
    },
    revoke() {
      active = false
    },
    rotate() {
      auth = new IntegrationAuth(store, config(2), () => now)
    },
    fail(message: string) {
      failure = new Error(message)
    },
    async exchange(fields: Record<string, string>, headers?: HeadersInit) {
      const request = new Request(
        'http://localhost' + integrationBase + '/oauth/token',
        {
          method: 'POST',
          headers: new Headers(headers),
          body: new URLSearchParams({
            grant_type: 'client_credentials',
            ...fields,
          }),
        },
      )
      return integrationTokenRequest(request, () => auth, rate)
    },
    async request(path: string, token?: string, init?: RequestInit) {
      const headers = new Headers(init?.headers)
      if (token) headers.set('authorization', 'Bearer ' + token)
      const request = new Request('http://localhost' + integrationBase + path, {
        ...init,
        headers,
      })
      return authorizeIntegrationRequest(
        request,
        path.split('?')[0]!,
        () => auth,
        rate,
      )
    },
  }
}

async function problem(
  result: Awaited<ReturnType<ReturnType<typeof fixture>['request']>>,
  status: number,
  code: string,
) {
  assert.ok(result instanceof Response)
  assert.equal(result.status, status)
  assert.equal(result.headers.get('content-type'), 'application/problem+json')
  assert.equal(result.headers.get('cache-control'), 'no-store')
  const body = await result.json()
  assert.equal(body.code, code)
  assert.equal(body.type, 'https://openfarm.dev/problems/' + code)
  assert.equal(body.status, status)
  assert.equal(typeof body.title, 'string')
  return result
}

const credentials = { client_id: clientId, client_secret: secret }

async function issue(farm: ReturnType<typeof fixture>, scope?: string) {
  const response = await farm.exchange(
    scope ? { ...credentials, scope } : credentials,
  )
  assert.equal(response.status, 200)
  return (await response.json()).access_token as string
}

test('client_secret_basic and client_secret_post issue scoped non-cacheable tokens', async () => {
  const farm = fixture(37)
  const response = await farm.exchange(
    { scope: 'printers:read' },
    { authorization: basic },
  )
  assert.equal(response.status, 200)
  assert.equal(response.headers.get('cache-control'), 'no-store')
  assert.equal(response.headers.get('pragma'), 'no-cache')
  const payload = await response.json()
  assert.equal(payload.token_type, 'Bearer')
  assert.equal(payload.expires_in, 37)
  assert.equal(payload.scope, 'printers:read')
  assert.ok(payload.access_token.length <= 4096)
  const all = await farm.exchange(credentials)
  assert.equal(
    (await all.json()).scope,
    'printers:read jobs:read control:basic control:extended',
  )
  const both = await farm.exchange(credentials, { authorization: basic })
  assert.deepEqual(await both.json(), { error: 'invalid_request' })
  const wrong = await farm.exchange({ ...credentials, client_secret: 'wrong' })
  assert.equal(wrong.status, 401)
  assert.equal(
    wrong.headers.get('www-authenticate'),
    'Basic realm="openfarm-integrations"',
  )
  assert.deepEqual(await wrong.json(), { error: 'invalid_client' })
  const unsupported = await farm.exchange({
    ...credentials,
    grant_type: 'authorization_code',
  })
  assert.deepEqual(await unsupported.json(), {
    error: 'unsupported_grant_type',
  })
  const escalation = await farm.exchange({
    ...credentials,
    scope: 'files:read',
  })
  assert.deepEqual(await escalation.json(), { error: 'invalid_scope' })
})

test('cookie-only, tampered, expired, revoked and old-key tokens return 401', async () => {
  const farm = fixture()
  const missing = await problem(
    await farm.request('/printers', undefined, {
      headers: { cookie: 'session=browser-cookie' },
    }),
    401,
    'invalid-token',
  )
  assert.equal(
    missing.headers.get('www-authenticate'),
    'Bearer realm="openfarm-integrations"',
  )
  const token = await issue(farm)
  const tampered = (token.startsWith('e') ? 'f' : 'e') + token.slice(1)
  const invalid = await problem(
    await farm.request('/printers', tampered),
    401,
    'invalid-token',
  )
  assert.match(
    invalid.headers.get('www-authenticate')!,
    /error="invalid_token"/,
  )
  farm.advance(10_999)
  assert.ok(!((await farm.request('/printers', token)) instanceof Response))
  farm.advance(1)
  await problem(await farm.request('/printers', token), 401, 'invalid-token')
  const oldKey = await issue(farm)
  farm.rotate()
  await problem(await farm.request('/printers', oldKey), 401, 'invalid-token')
  const revoked = await issue(farm)
  farm.revoke()
  await problem(await farm.request('/printers', revoked), 401, 'invalid-token')
  assert.equal((await farm.exchange(credentials)).status, 401)
})

test('each request is bound to matching scope, farm and printer on the same grant', async () => {
  const farm = fixture()
  const token = await issue(farm, 'printers:read jobs:read')
  const allowed = await farm.request('/printers/' + printerA + '/status', token)
  assert.ok(!(allowed instanceof Response))
  assert.equal(allowed.headers['ratelimit-limit'], '120')
  assert.equal(
    integrationGrantFor(allowed.principal, 'printers:read', farmA, printerA)
      ?.requiresApproval,
    true,
  )
  assert.equal(
    integrationGrantFor(allowed.principal, 'printers:read', farmA, printerB),
    undefined,
  )
  await problem(
    await farm.request('/printers/' + printerA + '/files', token),
    403,
    'insufficient-scope',
  )
  await problem(
    await farm.request('/printers/' + printerB + '/status', token),
    404,
    'not-found',
  )
  await problem(
    await farm.request('/printers?farmId=' + farmB, token),
    404,
    'not-found',
  )
  await problem(
    await farm.request(
      '/jobs?farmId=' + farmB + '&printerId=' + printerA,
      token,
    ),
    404,
    'not-found',
  )
  await problem(
    await farm.request('/jobs?farmId=' + farmA + '&farmId=' + farmB, token),
    400,
    'invalid-request',
  )
  farm.grants.shift()
  await problem(await farm.request('/printers', token), 401, 'invalid-token')
})

test('action scopes are selected from the body and cannot cross grant boundaries', async () => {
  const farm = fixture()
  const all = await issue(farm)
  const basicOnly = await issue(farm, 'control:basic')
  const action = (printer: string, name: string, token: string) =>
    farm.request('/printers/' + printer + '/actions', token, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: name, args: {} }),
    })
  const result = await action(printerA, 'pause', all)
  assert.ok(!(result instanceof Response))
  assert.deepEqual(result.principal.scopes, ['control:basic'])
  await problem(
    await action(printerA, 'home', basicOnly),
    403,
    'insufficient-scope',
  )
  await problem(await action(printerA, 'home', all), 404, 'not-found')
  assert.ok(!((await action(printerC, 'home', all)) instanceof Response))
})

test('credentials, tokens and error causes are absent from logs and failure responses', async (t) => {
  const output: string[] = []
  for (const stream of [process.stdout, process.stderr])
    t.mock.method(stream, 'write', (chunk: unknown) => {
      output.push(String(chunk))
      return true
    })
  const farm = fixture()
  const token = await issue(farm)
  farm.fail([secret, basic, token].join(' '))
  const exchange = await farm.exchange(credentials)
  const response = await farm.request('/printers', token)
  assert.equal(exchange.status, 503)
  assert.ok(response instanceof Response)
  assert.equal(response.status, 503)
  for (const sensitive of [secret, basic, token]) {
    assert.ok(!output.join('').includes(sensitive))
    assert.ok(!(await exchange.clone().text()).includes(sensitive))
    assert.ok(!(await response.clone().text()).includes(sensitive))
  }
})

test('route scopes cover the protected OpenAPI operations', () => {
  const contract = parse(
    readFileSync(
      new URL('../../docs/api/openapi-v1.yaml', import.meta.url),
      'utf8',
    ),
  )
  for (const [template, operations] of Object.entries(contract.paths)) {
    if (['/openapi.json', '/oauth/token'].includes(template)) continue
    const path = template.replace(/\{[^}]+\}/g, printerA)
    for (const [method, value] of Object.entries(
      operations as Record<
        string,
        {
          security?: { clientCredentials: string[] }[]
        }
      >,
    )) {
      const scopes = (value.security ?? contract.security).flatMap(
        (alternative: { clientCredentials: string[] }) =>
          alternative.clientCredentials,
      )
      assert.deepEqual(
        integrationPolicy(path, method.toUpperCase())?.scopes,
        scopes,
        method + ' ' + path,
      )
    }
  }
})

test('token, read and write requests use separate rate buckets', async () => {
  const farm = fixture(300)
  const token = await issue(farm)
  for (let i = 0; i < 29; i++) {
    assert.equal((await farm.exchange(credentials)).status, 200)
  }
  const throttled = await farm.exchange(credentials)
  assert.equal(throttled.status, 429)
  assert.equal(throttled.headers.get('retry-after'), '2')
  assert.deepEqual(await throttled.json(), { error: 'rate_limited' })

  for (let i = 0; i < 30; i++) {
    assert.ok(
      !(
        (await farm.request('/intents', token, { method: 'POST' })) instanceof
        Response
      ),
    )
  }
  const write = await problem(
    await farm.request('/intents', token, { method: 'POST' }),
    429,
    'rate-limited',
  )
  assert.equal(write.headers.get('ratelimit-remaining'), '0')
  assert.equal(write.headers.get('ratelimit-reset'), '60')
  assert.ok(!((await farm.request('/printers', token)) instanceof Response))
  farm.advance(2000)
  assert.equal((await farm.exchange(credentials)).status, 200)
})
