import assert from 'node:assert/strict'
import {
  createHash,
  generateKeyPairSync,
  sign,
  type KeyObject,
} from 'node:crypto'
import {
  createServer as createHttpServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import * as client from 'openid-client'
import { PostgresOidc } from '../../apps/farm/server/storage/postgres-oidc.ts'
import { readOidcConfig } from '../../apps/farm/server/utils/oidc-config.ts'
import {
  beginOidcAuthorization,
  decideOidcAccount,
  finishOidcAuthorization,
  OidcProtocolError,
  type OidcDirectory,
  type OidcIdentity,
} from '../../apps/farm/server/utils/oidc-login.ts'

const root = fileURLToPath(new URL('../..', import.meta.url))
const redirectUri = 'http://127.0.0.1/api/auth/oidc/callback'
const clientId = 'farm-test'

type Mode = 'ok' | 'expired' | 'wrong-aud'

function signJwt(
  privateKey: KeyObject,
  claims: Record<string, unknown>,
): string {
  const header = Buffer.from(
    JSON.stringify({ alg: 'ES256', typ: 'JWT', kid: 'test' }),
  ).toString('base64url')
  const payload = Buffer.from(JSON.stringify(claims)).toString('base64url')
  const data = `${header}.${payload}`
  const raw = sign('sha256', Buffer.from(data), {
    key: privateKey,
    dsaEncoding: 'ieee-p1363',
  })
  return `${data}.${raw.toString('base64url')}`
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    size += buffer.length
    if (size > 8192) throw new Error('body too large')
    chunks.push(buffer)
  }
  return Buffer.concat(chunks).toString('utf8')
}

function startIdp(): Promise<{
  server: Server
  issuer: string
  port: number
  mode: { value: Mode }
  state: { tokenRequests: number }
}> {
  const { publicKey, privateKey } = generateKeyPairSync('ec', {
    namedCurve: 'P-256',
  })
  const jwk = publicKey.export({ format: 'jwk' }) as Record<string, string>
  jwk.kid = 'test'
  jwk.alg = 'ES256'
  jwk.use = 'sig'
  const mode = { value: 'ok' as Mode }
  const codes = new Map<
    string,
    { nonce: string; challenge: string; redirect: string }
  >()
  const state = { tokenRequests: 0 }
  const server = createHttpServer()
  const bound = new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve())
  })
  return bound.then(() => {
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('no port')
    const issuer = `http://127.0.0.1:${address.port}`
    server.on('request', (req, res) => {
      void handle(req, res, issuer).catch(() => {
        res.statusCode = 500
        res.end()
      })
    })
    return {
      server,
      issuer,
      port: address.port,
      mode,
      state,
    }
  })

  async function handle(
    req: IncomingMessage,
    res: ServerResponse,
    issuer: string,
  ): Promise<void> {
    const url = new URL(req.url ?? '/', issuer)
    if (
      req.method === 'GET' &&
      url.pathname === '/.well-known/openid-configuration'
    ) {
      res.setHeader('content-type', 'application/json')
      res.end(
        JSON.stringify({
          issuer,
          authorization_endpoint: issuer + '/authorize',
          token_endpoint: issuer + '/token',
          jwks_uri: issuer + '/jwks',
          response_types_supported: ['code'],
          subject_types_supported: ['public'],
          id_token_signing_alg_values_supported: ['ES256'],
          code_challenge_methods_supported: ['S256'],
          grant_types_supported: ['authorization_code'],
          token_endpoint_auth_methods_supported: ['none'],
        }),
      )
      return
    }
    if (req.method === 'GET' && url.pathname === '/jwks') {
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify({ keys: [jwk] }))
      return
    }
    if (req.method === 'GET' && url.pathname === '/authorize') {
      const challenge = url.searchParams.get('code_challenge')
      const nonce = url.searchParams.get('nonce')
      const stateValue = url.searchParams.get('state')
      const redirect = url.searchParams.get('redirect_uri')
      if (
        url.searchParams.get('client_id') !== clientId ||
        url.searchParams.get('code_challenge_method') !== 'S256' ||
        url.searchParams.get('scope') !== 'openid' ||
        !challenge ||
        !nonce ||
        !stateValue ||
        redirect !== redirectUri
      ) {
        res.statusCode = 400
        res.end('bad authorization request')
        return
      }
      const code = Buffer.from(
        crypto.getRandomValues(new Uint8Array(32)),
      ).toString('base64url')
      codes.set(code, { nonce, challenge, redirect })
      const location = new URL(redirect)
      location.searchParams.set('code', code)
      location.searchParams.set('state', stateValue)
      location.searchParams.set('iss', issuer)
      res.statusCode = 302
      res.setHeader('location', location.href)
      res.end()
      return
    }
    if (req.method === 'POST' && url.pathname === '/token') {
      state.tokenRequests += 1
      const body = new URLSearchParams(await readBody(req))
      const code = body.get('code') ?? ''
      const saved = codes.get(code)
      codes.delete(code)
      const verifier = body.get('code_verifier') ?? ''
      const challenge = createHash('sha256')
        .update(verifier)
        .digest('base64url')
      if (
        !saved ||
        body.get('grant_type') !== 'authorization_code' ||
        body.get('redirect_uri') !== saved.redirect ||
        body.get('client_id') !== clientId ||
        challenge !== saved.challenge
      ) {
        res.statusCode = 400
        res.setHeader('content-type', 'application/json')
        res.end(JSON.stringify({ error: 'invalid_grant' }))
        return
      }
      const now = Math.floor(Date.now() / 1000)
      const expired = mode.value === 'expired'
      const claims: Record<string, unknown> = {
        iss: issuer,
        sub: 'subject-1',
        aud: mode.value === 'wrong-aud' ? 'some-other-client' : clientId,
        exp: expired ? now - 3600 : now + 300,
        iat: expired ? now - 7200 : now,
        nonce: saved.nonce,
        email: 'person@example.test',
        role: 'owner',
        groups: ['admin'],
      }
      res.setHeader('content-type', 'application/json')
      res.setHeader('cache-control', 'no-store')
      res.end(
        JSON.stringify({
          access_token: 'local-access-token',
          token_type: 'Bearer',
          expires_in: 300,
          id_token: signJwt(privateKey, claims),
        }),
      )
      return
    }
    res.statusCode = 404
    res.end()
  }
}

test('local IdP rejects state, nonce, expiry and audience, and ignores provider claims', async () => {
  const idp = await startIdp()
  assert.notEqual(idp.port, 0)
  assert.equal(idp.issuer.startsWith('http://127.0.0.1:'), true)
  try {
    const config = await client.discovery(
      new URL(idp.issuer),
      clientId,
      undefined,
      client.None(),
      { execute: [client.allowInsecureRequests] },
    )
    const directory = memoryDirectory()
    const begun = await beginOidcAuthorization(config, redirectUri)
    assert.equal(begun.url.searchParams.get('scope'), 'openid')
    assert.equal(begun.url.searchParams.get('code_challenge_method'), 'S256')
    assert.equal(begun.url.searchParams.get('client_id'), clientId)
    assert.equal(begun.url.searchParams.get('state'), begun.state)
    assert.equal(begun.url.searchParams.get('nonce'), begun.nonce)
    assert.equal(begun.url.searchParams.get('response_type'), 'code')

    const beforeState = idp.state.tokenRequests
    await assertRefusal(config, idp, 'state', 'swap-state')
    assert.equal(idp.state.tokenRequests, beforeState)

    await assertRefusal(config, idp, 'nonce', 'swap-nonce')
    idp.mode.value = 'expired'
    await assertRefusal(config, idp, 'expired', 'as-is')
    idp.mode.value = 'wrong-aud'
    await assertRefusal(config, idp, 'audience', 'as-is')
    idp.mode.value = 'ok'

    const identity = await finishRound(config, idp, 'as-is')
    assert.deepEqual(Object.keys(identity).sort(), ['issuer', 'subject'])
    assert.equal(identity.subject, 'subject-1')
    assert.equal(identity.issuer, idp.issuer)
    const unlinked = await decideOidcAccount(identity, undefined, directory)
    assert.deepEqual(unlinked, { ok: false, code: 'unlinked' })
    assert.equal(
      directory.links.has(identity.issuer + '\n' + identity.subject),
      false,
    )
    assert.equal(directory.emailAccountId, 'email-account')

    const created = await decideOidcAccount(
      identity,
      { username: 'nova-conta', inviteDigest: 'ab'.repeat(32) },
      directory,
    )
    assert.equal(created.ok, true)
    if (!created.ok) return
    assert.equal(created.created, true)
    assert.equal(created.role, 'viewer')
    assert.notEqual(created.accountId, directory.emailAccountId)
    assert.equal(directory.calls.length, 1)
    assert.equal('email' in directory.calls[0]!, false)
    assert.equal('role' in directory.calls[0]!, false)

    const again = await decideOidcAccount(
      identity,
      { username: 'outra', inviteDigest: 'cd'.repeat(32) },
      directory,
    )
    assert.deepEqual(again, {
      ok: true,
      accountId: created.accountId,
      created: false,
      role: null,
    })
    assert.equal(directory.calls.length, 1)
    assert.equal(directory.roleOf(identity), 'viewer')
  } finally {
    await new Promise<void>((resolve, reject) => {
      idp.server.close((error) => (error ? reject(error) : resolve()))
    })
  }
})

test('OIDC config is off by default and documented', () => {
  assert.deepEqual(readOidcConfig(undefined), { state: 'off' })
  assert.deepEqual(readOidcConfig({ enabled: true, oidc: false }), {
    state: 'off',
  })
  assert.deepEqual(readOidcConfig({ enabled: true }), { state: 'off' })
  assert.equal(readOidcConfig({ enabled: false, oidc: true }).state, 'invalid')
  assert.equal(
    readOidcConfig({
      enabled: true,
      oidc: true,
      origin: 'https://farm.example',
      oidcIssuer: 'http://idp.example',
      oidcClientId: 'farm-test',
    }).state,
    'invalid',
  )
  const ready = readOidcConfig({
    enabled: true,
    oidc: true,
    origin: 'https://farm.example',
    oidcIssuer: 'https://idp.example/realms/farm',
    oidcClientId: 'farm-test',
    oidcClientSecret: '',
  })
  assert.equal(ready.state, 'ready')
  if (ready.state !== 'ready') return
  assert.equal(ready.settings.issuer, 'https://idp.example/realms/farm')
  assert.equal(
    ready.settings.redirectUri,
    'https://farm.example/api/auth/oidc/callback',
  )
  assert.equal(ready.settings.clientSecret, undefined)
  const nuxt = readFileSync(root + '/apps/farm/nuxt.config.ts', 'utf8')
  assert.match(nuxt, /oidc:\s*false/)
  const docs = readFileSync(root + '/docs/ACCOUNT-CREATION.md', 'utf8')
  assert.match(docs, /NUXT_AUTH_OIDC=true/)
  assert.match(docs, /off by default/i)
  const page = readFileSync(root + '/apps/farm/app/pages/entrar.vue', 'utf8')
  assert.match(page, /Entrar com OpenID Connect/)
  assert.match(page, /aria-labelledby="oidc-titulo"/)
  assert.match(page, /Vincular convite e entrar/)
  assert.doesNotMatch(page, /google|kobra|facebook/i)
  const source = readFileSync(
    root + '/apps/farm/server/utils/oidc-login.ts',
    'utf8',
  )
  assert.doesNotMatch(source, /google|apple|microsoft|kobra|facebook/i)
  assert.match(source, /scope: 'openid'/)
})

test('identity rows store issuer and subject, and membership role comes from the invite', async () => {
  const statements: Array<{ sql: string; values: unknown[] }> = []
  const query = (strings: TemplateStringsArray, ...values: unknown[]) => {
    const sql = strings.join('?')
    statements.push({ sql, values })
    if (sql.includes('FROM farm.account_invites'))
      return Promise.resolve([
        { id: 'invite-1', farm_id: 'farm-1', role: 'viewer' },
      ])
    if (sql.includes('FROM farm.oidc_identities'))
      return Promise.resolve([{ accountId: 'linked-account' }])
    if (sql.includes('RETURNING account_id'))
      return Promise.resolve([{ account_id: 'new-account' }])
    return Promise.resolve([])
  }
  const sql = Object.assign(query, {
    begin: async <T>(operation: (tx: typeof query) => Promise<T>) =>
      operation(query),
  })
  const store = new PostgresOidc(sql as never)
  const found = await store.findLink('https://idp.example', 'subject-1')
  assert.deepEqual(found, { accountId: 'linked-account' })
  const lookup = statements.at(-1)!
  assert.match(lookup.sql, /NOT a\.disabled/)
  assert.doesNotMatch(lookup.sql, /email|memberships|role/)
  const linked = await store.linkThroughInvite({
    issuer: 'https://idp.example',
    subject: 'subject-2',
    username: 'nova-conta',
    inviteDigest: 'ab'.repeat(32),
    passwordHash: 'x'.repeat(40),
  })
  assert.equal(linked?.role, 'viewer')
  const identity = statements.find((entry) =>
    entry.sql.includes('INSERT INTO farm.oidc_identities'),
  )
  assert.ok(identity)
  assert.match(
    identity.sql,
    /INSERT INTO farm\.oidc_identities \(issuer, subject, account_id\)/,
  )
  assert.doesNotMatch(identity.sql, /email|groups/)
  const membership = statements.find((entry) =>
    entry.sql.includes('INSERT INTO farm.memberships'),
  )
  assert.ok(membership)
  assert.equal(membership.values.at(-1), 'viewer')
})

function memoryDirectory(): OidcDirectory & {
  links: Map<string, { accountId: string; role: string }>
  calls: Array<Record<string, unknown>>
  emailAccountId: string
  roleOf(identity: OidcIdentity): string | undefined
} {
  const links = new Map<string, { accountId: string; role: string }>()
  const calls: Array<Record<string, unknown>> = []
  const key = (issuer: string, subject: string) => issuer + '\n' + subject
  return {
    links,
    calls,
    emailAccountId: 'email-account',
    roleOf(identity) {
      return links.get(key(identity.issuer, identity.subject))?.role
    },
    async findLink(issuer, subject) {
      const row = links.get(key(issuer, subject))
      return row ? { accountId: row.accountId } : null
    },
    async linkThroughInvite(input) {
      calls.push(input)
      const accountId = 'created-account'
      links.set(key(input.issuer, input.subject), {
        accountId,
        role: 'viewer',
      })
      return { accountId, role: 'viewer' }
    },
  }
}

async function finishRound(
  config: client.Configuration,
  idp: { issuer: string; mode: { value: Mode } },
  kind: 'as-is' | 'swap-state' | 'swap-nonce',
): Promise<OidcIdentity> {
  const begun = await beginOidcAuthorization(config, redirectUri)
  const response = await fetch(begun.url, { redirect: 'manual' })
  assert.equal(response.status, 302)
  const location = new URL(response.headers.get('location') ?? '')
  const callback = new URL(redirectUri)
  const code = location.searchParams.get('code')
  assert.ok(code)
  callback.searchParams.set('code', code)
  callback.searchParams.set(
    'state',
    kind === 'swap-state'
      ? 'wrong-state-value'
      : (location.searchParams.get('state') ?? ''),
  )
  callback.searchParams.set('iss', idp.issuer)
  return await finishOidcAuthorization(config, callback, {
    state: begun.state,
    nonce: kind === 'swap-nonce' ? 'wrong-nonce-value' : begun.nonce,
    codeVerifier: begun.codeVerifier,
  })
}

async function assertRefusal(
  config: client.Configuration,
  idp: { issuer: string; mode: { value: Mode } },
  code: 'state' | 'nonce' | 'expired' | 'audience',
  kind: 'as-is' | 'swap-state' | 'swap-nonce',
): Promise<void> {
  try {
    await finishRound(config, idp, kind)
    assert.fail(code + ' was accepted')
  } catch (error) {
    assert.equal(
      error instanceof OidcProtocolError ? error.code : String(error),
      code,
      error instanceof OidcProtocolError ? error.detail : undefined,
    )
  }
}
