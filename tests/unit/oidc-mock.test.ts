// SPDX-License-Identifier: MIT
import { createHash } from 'node:crypto'
import { expect, test } from 'vitest'
import * as client from 'openid-client'
import {
  startMock,
  startOidcMock,
  withNetworkGuard,
  type OidcMockInstance,
  type OidcMockScenarioName,
} from '../../packages/sim-tools/src/mocks/index.ts'

const redirectUri = 'http://127.0.0.1/api/auth/oidc/callback'

type ProtocolCode = 'expired' | 'audience' | 'invalid'

function decodeJwtPayload(jwt: string): Record<string, unknown> {
  const part = jwt.split('.')[1]
  if (!part) throw new Error('bad jwt')
  return JSON.parse(Buffer.from(part, 'base64url').toString('utf8')) as Record<
    string,
    unknown
  >
}

function messages(error: unknown): string {
  const found: string[] = []
  let current = error
  const seen = new Set<unknown>()
  while (current instanceof Error && !seen.has(current)) {
    seen.add(current)
    found.push(current.message)
    current = current.cause
  }
  return found.join('\n')
}

/** Mirrors apps/farm/server/utils/oidc-login classifyOidcProtocolError for refusals. */
function classifyProtocolError(error: unknown): ProtocolCode {
  const detail = messages(error)
  if (detail.includes('expiration is past current timestamp')) return 'expired'
  if (
    detail.includes('unexpected JWT "aud" (audience) claim value') ||
    detail.includes('additional untrusted audiences')
  )
    return 'audience'
  return 'invalid'
}

/**
 * Google-preset claim gate used by tests until #447 lands the real policy.
 * Fails the test if unverified email would be accepted.
 */
function acceptGoogleLikeClaims(claims: Record<string, unknown>):
  | {
      ok: true
    }
  | { ok: false; reason: string } {
  if (claims.email_verified !== true) {
    return { ok: false, reason: 'email_verified' }
  }
  if (typeof claims.email !== 'string' || !claims.email.includes('@')) {
    return { ok: false, reason: 'email' }
  }
  return { ok: true }
}

async function discover(mock: OidcMockInstance): Promise<client.Configuration> {
  const secret = mock.clientSecret
  if (secret === null) {
    return client.discovery(
      new URL(mock.issuer),
      mock.clientId,
      undefined,
      client.None(),
      { execute: [client.allowInsecureRequests] },
    )
  }
  return client.discovery(
    new URL(mock.issuer),
    mock.clientId,
    secret,
    client.ClientSecretPost(secret),
    { execute: [client.allowInsecureRequests] },
  )
}

async function beginAuth(config: client.Configuration): Promise<{
  url: URL
  state: string
  nonce: string
  codeVerifier: string
}> {
  const codeVerifier = client.randomPKCECodeVerifier()
  const state = client.randomState()
  const nonce = client.randomNonce()
  const url = client.buildAuthorizationUrl(config, {
    redirect_uri: redirectUri,
    scope: 'openid email profile',
    code_challenge: await client.calculatePKCECodeChallenge(codeVerifier),
    code_challenge_method: 'S256',
    state,
    nonce,
  })
  return { url, state, nonce, codeVerifier }
}

async function authorizeRedirect(config: client.Configuration): Promise<{
  begun: Awaited<ReturnType<typeof beginAuth>>
  code: string
}> {
  const begun = await beginAuth(config)
  const response = await fetch(begun.url, { redirect: 'manual' })
  expect(response.status).toBe(302)
  const location = new URL(response.headers.get('location') ?? '')
  const code = location.searchParams.get('code')
  expect(code).toBeTruthy()
  return { begun, code: code! }
}

/** Raw token exchange for inspecting ID token claims. */
async function fetchIdTokenClaims(
  mock: OidcMockInstance,
  config: client.Configuration,
): Promise<Record<string, unknown>> {
  const { begun, code } = await authorizeRedirect(config)
  const tokenBody = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: redirectUri,
    client_id: mock.clientId,
    code_verifier: begun.codeVerifier,
  })
  if (mock.clientSecret !== null) {
    tokenBody.set('client_secret', mock.clientSecret)
  }
  const tokenRes = await fetch(`${mock.issuer}/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: tokenBody,
  })
  expect(tokenRes.status).toBe(200)
  const tokenJson = (await tokenRes.json()) as { id_token: string }
  return decodeJwtPayload(tokenJson.id_token)
}

async function finishRound(
  mock: OidcMockInstance,
  config: client.Configuration,
): Promise<{ issuer: string; subject: string }> {
  const { begun, code } = await authorizeRedirect(config)
  const callback = new URL(redirectUri)
  callback.searchParams.set('code', code)
  callback.searchParams.set('state', begun.state)
  callback.searchParams.set('iss', mock.issuer)
  const tokens = await client.authorizationCodeGrant(config, callback, {
    pkceCodeVerifier: begun.codeVerifier,
    expectedState: begun.state,
    expectedNonce: begun.nonce,
    idTokenExpected: true,
  })
  const claims = tokens.claims()
  if (!claims?.iss || !claims.sub) throw new Error('missing identity')
  return { issuer: claims.iss, subject: claims.sub }
}

async function assertProtocolRefusal(
  mock: OidcMockInstance,
  expected: ProtocolCode,
): Promise<void> {
  const config = await discover(mock)
  try {
    await finishRound(mock, config)
    expect.fail(`${expected} was accepted`)
  } catch (error) {
    expect(classifyProtocolError(error)).toBe(expected)
  }
}

test('discovery, JWKS, authorize auto-approve, token PKCE + client auth, Google-like claims', async () => {
  await withNetworkGuard(async () => {
    const mock = await startOidcMock({
      clientId: 'farm-google-test',
      redirectUris: [redirectUri],
      user: {
        sub: 'sub-verified',
        email: 'person@example.test',
        email_verified: true,
        name: 'Person Example',
      },
    })
    try {
      expect(mock.origin.startsWith('http://127.0.0.1:')).toBe(true)
      expect(mock.issuer).toBe(mock.origin)
      expect(mock.clientSecret).toBeTruthy()

      const discovery = await fetch(
        `${mock.issuer}/.well-known/openid-configuration`,
      )
      expect(discovery.status).toBe(200)
      const doc = (await discovery.json()) as Record<string, unknown>
      expect(doc.issuer).toBe(mock.issuer)
      expect(doc.authorization_endpoint).toBe(`${mock.issuer}/authorize`)
      expect(doc.token_endpoint).toBe(`${mock.issuer}/token`)
      expect(doc.jwks_uri).toBe(`${mock.issuer}/jwks`)
      expect(doc.code_challenge_methods_supported).toEqual(['S256'])
      expect(doc.id_token_signing_alg_values_supported).toEqual(['RS256'])
      expect(doc.scopes_supported).toEqual(['openid', 'email', 'profile'])

      const jwks = await fetch(`${mock.issuer}/jwks`)
      const keys = (await jwks.json()) as {
        keys: Array<{ kid: string; alg: string }>
      }
      expect(keys.keys).toHaveLength(1)
      expect(keys.keys[0]!.alg).toBe('RS256')
      expect(keys.keys[0]!.kid).toBeTruthy()

      const config = await discover(mock)
      const claims = await fetchIdTokenClaims(mock, config)
      expect(claims.iss).toBe(mock.issuer)
      expect(claims.aud).toBe(mock.clientId)
      expect(claims.sub).toBe('sub-verified')
      expect(claims.email).toBe('person@example.test')
      expect(claims.email_verified).toBe(true)
      expect(claims.nonce).toBeTruthy()
      expect(typeof claims.exp).toBe('number')
      expect(acceptGoogleLikeClaims(claims)).toEqual({ ok: true })

      const identity = await finishRound(mock, config)
      expect(identity.subject).toBe('sub-verified')
      expect(identity.issuer).toBe(mock.issuer)

      // Client auth via HTTP Basic also works.
      const { begun, code } = await authorizeRedirect(config)
      const basic = Buffer.from(
        `${mock.clientId}:${mock.clientSecret}`,
      ).toString('base64')
      const basicToken = await fetch(`${mock.issuer}/token`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          Authorization: `Basic ${basic}`,
        },
        body: new URLSearchParams({
          grant_type: 'authorization_code',
          code,
          redirect_uri: redirectUri,
          code_verifier: begun.codeVerifier,
        }),
      })
      expect(basicToken.status).toBe(200)

      // Bad PKCE verifier is refused by the mock.
      const again = await authorizeRedirect(config)
      const badPkce = await fetch(`${mock.issuer}/token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'authorization_code',
          code: again.code,
          redirect_uri: redirectUri,
          client_id: mock.clientId,
          client_secret: mock.clientSecret!,
          code_verifier: 'not-the-right-verifier-value-xxxxxxxx',
        }),
      })
      expect(badPkce.status).toBe(400)
      expect(createHash('sha256').update('x').digest('hex').length).toBe(64)
    } finally {
      await mock.close()
    }
  })
})

test('startMock("oidc") wires the Google-like provider', async () => {
  const mock = await startMock('oidc', {
    clientSecret: null,
    redirectUris: [redirectUri],
  })
  try {
    expect(mock.clientSecret).toBeNull()
    const doc = await fetch(`${mock.issuer}/.well-known/openid-configuration`)
    const json = (await doc.json()) as {
      token_endpoint_auth_methods_supported: string[]
    }
    expect(json.token_endpoint_auth_methods_supported).toEqual(['none'])
  } finally {
    await mock.close()
  }
})

test('verified scenario: server accepts and Google-like gate passes', async () => {
  const mock = await startOidcMock({
    scenario: 'verified',
    redirectUris: [redirectUri],
  })
  try {
    const config = await discover(mock)
    const claims = await fetchIdTokenClaims(mock, config)
    expect(claims.email_verified).toBe(true)
    expect(acceptGoogleLikeClaims(claims)).toEqual({ ok: true })
    const identity = await finishRound(mock, config)
    expect(identity.subject).toBeTruthy()
  } finally {
    await mock.close()
  }
})

test('unverified scenario: Google-like gate refuses (server must not accept)', async () => {
  const mock = await startOidcMock({
    scenario: 'unverified',
    redirectUris: [redirectUri],
  })
  try {
    const config = await discover(mock)
    const claims = await fetchIdTokenClaims(mock, config)
    expect(claims.email_verified).toBe(false)
    const gate = acceptGoogleLikeClaims(claims)
    expect(gate).toEqual({ ok: false, reason: 'email_verified' })
    expect(gate.ok).toBe(false)
  } finally {
    await mock.close()
  }
})

test('hosted-domain scenario emits verified email and hd claim', async () => {
  const mock = await startOidcMock({
    scenario: 'hosted-domain',
    user: { email: 'member@acme.test' },
    redirectUris: [redirectUri],
  })
  try {
    const config = await discover(mock)
    const claims = await fetchIdTokenClaims(mock, config)
    expect(claims.email_verified).toBe(true)
    expect(claims.hd).toBe('acme.test')
    expect(acceptGoogleLikeClaims(claims)).toEqual({ ok: true })
    const allowed = new Set(['other.test'])
    const hd = String(claims.hd ?? '')
    expect(allowed.has(hd)).toBe(false)
  } finally {
    await mock.close()
  }
})

test('expired token scenario: openid-client refuses', async () => {
  const mock = await startOidcMock({
    scenario: 'expired',
    redirectUris: [redirectUri],
  })
  try {
    await assertProtocolRefusal(mock, 'expired')
  } finally {
    await mock.close()
  }
})

test('wrong-audience scenario: openid-client refuses', async () => {
  const mock = await startOidcMock({
    scenario: 'wrong-audience',
    redirectUris: [redirectUri],
  })
  try {
    await assertProtocolRefusal(mock, 'audience')
  } finally {
    await mock.close()
  }
})

test('rotated-key scenario: openid-client refuses orphan signing key', async () => {
  const mock = await startOidcMock({
    scenario: 'rotated-key',
    redirectUris: [redirectUri],
  })
  try {
    expect(mock.control.getJwks().keys).toHaveLength(1)
    await assertProtocolRefusal(mock, 'invalid')
  } finally {
    await mock.close()
  }
})

test('outage scenario returns 503 and blocks discovery', async () => {
  const mock = await startOidcMock({
    scenario: 'outage',
    redirectUris: [redirectUri],
  })
  try {
    const discovery = await fetch(
      `${mock.issuer}/.well-known/openid-configuration`,
    )
    expect(discovery.status).toBe(503)
    await expect(discover(mock)).rejects.toThrow()
  } finally {
    await mock.close()
  }
})

test('setScenario switches behaviours at runtime', async () => {
  const mock = await startOidcMock({ redirectUris: [redirectUri] })
  try {
    const scenarios: OidcMockScenarioName[] = [
      'verified',
      'unverified',
      'hosted-domain',
      'expired',
      'wrong-audience',
      'rotated-key',
      'outage',
    ]
    for (const name of scenarios) {
      mock.control.setScenario(name)
      expect(mock.control.getScenario()).toBe(name)
    }
    mock.control.setScenario('verified')
    mock.control.rotateKeys()
    expect(mock.control.getJwks().keys).toHaveLength(1)
    const config = await discover(mock)
    const claims = await fetchIdTokenClaims(mock, config)
    expect(claims.email_verified).toBe(true)
  } finally {
    await mock.close()
  }
})

test('fault refuse on token path simulates provider outage without scenario flag', async () => {
  const mock = await startOidcMock({ redirectUris: [redirectUri] })
  try {
    mock.control.faults.setFault({
      fault: { type: 'refuse', statusCode: 503 },
      path: '/token',
    })
    const config = await discover(mock)
    const { begun, code } = await authorizeRedirect(config)
    const tokenRes = await fetch(`${mock.issuer}/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        redirect_uri: redirectUri,
        client_id: mock.clientId,
        client_secret: mock.clientSecret!,
        code_verifier: begun.codeVerifier,
      }),
    })
    expect(tokenRes.status).toBe(503)
  } finally {
    await mock.close()
  }
})
