// SPDX-License-Identifier: MIT
import {
  createHash,
  generateKeyPairSync,
  randomBytes,
  sign,
  type KeyObject,
} from 'node:crypto'
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http'
import type { Socket } from 'node:net'
import { FaultController } from './faults.ts'
import type { HttpCallRecord } from './http-mock.ts'
import { assertLoopbackAddress } from './network-guard.ts'
import { ScenarioController, type ScenarioStep } from './scenario.ts'

/** Scripted Google-like IdP behaviours for tests. */
export type OidcMockScenarioName =
  | 'verified'
  | 'unverified'
  | 'hosted-domain'
  | 'expired'
  | 'wrong-audience'
  | 'rotated-key'
  | 'outage'

export interface OidcMockUser {
  sub: string
  email: string
  email_verified: boolean
  /** Google Workspace hosted domain claim. */
  hd?: string | undefined
  name?: string | undefined
  picture?: string | undefined
}

export interface OidcMockOptions {
  /** OAuth client id registered at the mock (default: farm-google-test). */
  clientId?: string | undefined
  /**
   * Confidential-client secret. Pass `null` or `''` for a public client
   * (`token_endpoint_auth_method=none`). Default: a generated secret.
   */
  clientSecret?: string | null | undefined
  /** Allowed redirect_uri values. Default: a loopback farm callback. */
  redirectUris?: readonly string[] | undefined
  /** Initial user profile claims. */
  user?: Partial<OidcMockUser> | undefined
  /** Initial scripted scenario (default: verified). */
  scenario?: OidcMockScenarioName | undefined
  /** Optional scenario timeline steps applied via ScenarioController. */
  scenarioSteps?: ScenarioStep<OidcMockState>[] | undefined
  faults?: FaultController | undefined
  port?: number | undefined
}

export interface OidcMockState {
  scenario: OidcMockScenarioName
  user: OidcMockUser
  clientId: string
  audienceOverride: string | null
  outage: boolean
  /** kid currently advertised in JWKS. */
  activeKid: string
  /** kid used to sign id_tokens (may differ after rotate / rotated-key). */
  signingKid: string
}

export interface OidcMockInstance {
  origin: string
  /** Issuer identifier (same as origin for this in-process mock). */
  issuer: string
  clientId: string
  clientSecret: string | null
  redirectUris: readonly string[]
  ports: { default: number; http: number } & number[]
  control: {
    faults: FaultController
    scenario: ScenarioController<OidcMockState>
    setScenario: (name: OidcMockScenarioName) => void
    getScenario: () => OidcMockScenarioName
    setUser: (patch: Partial<OidcMockUser>) => void
    getUser: () => OidcMockUser
    /** Publish a new JWKS key and sign future tokens with it. */
    rotateKeys: () => void
    /**
     * Sign with a key that is no longer in JWKS (verification must fail).
     * Equivalent to scenario `rotated-key`.
     */
    orphanSigningKey: () => void
    getState: () => OidcMockState
    getJwks: () => { keys: Record<string, string>[] }
    sockets: Set<Socket>
  }
  calls: {
    (): Readonly<Record<string, number>>
    all: readonly HttpCallRecord[]
  }
  close: () => Promise<void>
}

interface SigningKey {
  kid: string
  privateKey: KeyObject
  publicJwk: Record<string, string>
}

interface AuthCodeRecord {
  nonce: string
  challenge: string
  redirect: string
  clientId: string
  scope: string
}

const DEFAULT_USER: OidcMockUser = {
  sub: 'google-subject-1',
  email: 'person@example.test',
  email_verified: true,
}

function defaultRedirectUri(): string {
  return 'http://127.0.0.1/api/auth/oidc/callback'
}

function createSigningKey(kid?: string): SigningKey {
  const { publicKey, privateKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
  })
  const jwk = publicKey.export({ format: 'jwk' }) as Record<string, string>
  const id = kid ?? randomBytes(8).toString('hex')
  jwk.kid = id
  jwk.alg = 'RS256'
  jwk.use = 'sig'
  return { kid: id, privateKey, publicJwk: jwk }
}

function signJwt(
  privateKey: KeyObject,
  kid: string,
  claims: Record<string, unknown>,
): string {
  const header = Buffer.from(
    JSON.stringify({ alg: 'RS256', typ: 'JWT', kid }),
  ).toString('base64url')
  const payload = Buffer.from(JSON.stringify(claims)).toString('base64url')
  const data = `${header}.${payload}`
  const signature = sign('sha256', Buffer.from(data), privateKey)
  return `${data}.${signature.toString('base64url')}`
}

function s256Challenge(verifier: string): string {
  return createHash('sha256').update(verifier).digest('base64url')
}

function parseBasicAuth(
  header: string | undefined,
): { clientId: string; clientSecret: string } | null {
  if (!header || !header.startsWith('Basic ')) return null
  try {
    const decoded = Buffer.from(header.slice(6), 'base64').toString('utf8')
    const colon = decoded.indexOf(':')
    if (colon < 0) return null
    return {
      clientId: decoded.slice(0, colon),
      clientSecret: decoded.slice(colon + 1),
    }
  } catch {
    return null
  }
}

function json(
  res: ServerResponse,
  status: number,
  body: unknown,
  extraHeaders?: Record<string, string>,
): void {
  const payload = JSON.stringify(body)
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Cache-Control': 'no-store',
    ...extraHeaders,
  })
  res.end(payload)
}

function applyScenarioName(
  name: OidcMockScenarioName,
  state: OidcMockState,
  keys: { active: SigningKey; orphan: SigningKey | null },
): {
  state: OidcMockState
  keys: { active: SigningKey; orphan: SigningKey | null }
} {
  const next: OidcMockState = {
    ...state,
    scenario: name,
    outage: name === 'outage',
    audienceOverride: name === 'wrong-audience' ? 'some-other-client' : null,
  }
  let nextKeys = keys
  if (name === 'verified') {
    next.user = {
      ...next.user,
      email_verified: true,
      hd: undefined,
    }
  } else if (name === 'unverified') {
    next.user = {
      ...next.user,
      email_verified: false,
      hd: undefined,
    }
  } else if (name === 'hosted-domain') {
    const email = next.user.email.includes('@')
      ? next.user.email
      : 'person@workspace.test'
    const hd = email.split('@')[1] ?? 'workspace.test'
    next.user = {
      ...next.user,
      email,
      email_verified: true,
      hd,
    }
  } else if (name === 'rotated-key') {
    const orphan = keys.active
    const active = createSigningKey()
    nextKeys = { active, orphan }
    next.activeKid = active.kid
    next.signingKid = orphan.kid
  } else if (
    name === 'expired' ||
    name === 'wrong-audience' ||
    name === 'outage'
  ) {
    // Claims / outage handled at token / request time.
  } else {
    const _exhaustive: never = name
    void _exhaustive
  }
  return { state: next, keys: nextKeys }
}

/**
 * In-process Google-like OpenID Connect provider for offline tests.
 * Discovery, JWKS (RS256), auto-approve authorize, token + PKCE + client auth.
 */
export async function startOidcMock(
  options: OidcMockOptions = {},
): Promise<OidcMockInstance> {
  const faults = options.faults ?? new FaultController()
  const sockets = new Set<Socket>()
  const callRecords: HttpCallRecord[] = []
  const callCounts: Record<string, number> = {}
  const codes = new Map<string, AuthCodeRecord>()

  const clientId = options.clientId ?? 'farm-google-test'
  const clientSecret =
    options.clientSecret === undefined
      ? randomBytes(24).toString('base64url')
      : options.clientSecret === '' || options.clientSecret === null
        ? null
        : options.clientSecret
  const redirectUris = Object.freeze(
    [...(options.redirectUris ?? [defaultRedirectUri()])].map(String),
  )

  let activeKey = createSigningKey()
  let orphanKey: SigningKey | null = null

  let state: OidcMockState = {
    scenario: 'verified',
    user: { ...DEFAULT_USER, ...options.user },
    clientId,
    audienceOverride: null,
    outage: false,
    activeKid: activeKey.kid,
    signingKid: activeKey.kid,
  }

  if (options.scenario && options.scenario !== 'verified') {
    const applied = applyScenarioName(options.scenario, state, {
      active: activeKey,
      orphan: orphanKey,
    })
    state = applied.state
    activeKey = applied.keys.active
    orphanKey = applied.keys.orphan
  }

  const recordCall = (key: string) => {
    callCounts[key] = (callCounts[key] ?? 0) + 1
  }

  const scenario = new ScenarioController<OidcMockState>({
    steps: options.scenarioSteps,
    applyState: (patch) => {
      state = { ...state, ...patch }
      if (patch.scenario) {
        const applied = applyScenarioName(patch.scenario, state, {
          active: activeKey,
          orphan: orphanKey,
        })
        state = applied.state
        activeKey = applied.keys.active
        orphanKey = applied.keys.orphan
      }
    },
    publishReport: () => {},
    getState: () => ({ ...state, user: { ...state.user } }),
  })

  const setScenario = (name: OidcMockScenarioName) => {
    const applied = applyScenarioName(name, state, {
      active: activeKey,
      orphan: orphanKey,
    })
    state = applied.state
    activeKey = applied.keys.active
    orphanKey = applied.keys.orphan
  }

  const getPublishedKeys = (): Record<string, string>[] => [activeKey.publicJwk]

  const signingMaterial = (): SigningKey => {
    if (state.scenario === 'rotated-key' && orphanKey) return orphanKey
    return activeKey
  }

  const authenticateClient = (
    req: IncomingMessage,
    body: URLSearchParams,
  ): boolean => {
    const basic = parseBasicAuth(
      typeof req.headers.authorization === 'string'
        ? req.headers.authorization
        : undefined,
    )
    const bodyClientId = body.get('client_id')
    const bodySecret = body.get('client_secret')
    const presentedId = basic?.clientId ?? bodyClientId
    if (presentedId !== clientId) return false
    if (clientSecret === null) {
      // Public client: secret must not be required; ignore extras.
      return true
    }
    const presentedSecret = basic?.clientSecret ?? bodySecret
    return presentedSecret === clientSecret
  }

  const server: Server = createServer((req, res) => {
    void (async () => {
      const chunks: Buffer[] = []
      req.on('data', (chunk: Buffer) => chunks.push(chunk))
      await new Promise<void>((resolve) => req.on('end', () => resolve()))
      const bodyBuf = Buffer.concat(chunks)
      const rawUrl = req.url ?? '/'
      const path = rawUrl.split('?')[0]!
      const method = req.method ?? 'GET'
      recordCall(method)
      recordCall(`${method} ${path}`)

      const fault = faults.matchFault({ path, method, headers: req.headers })
      if (fault) {
        if (fault.type === 'drop') {
          req.socket.destroy()
          callRecords.push({
            method,
            url: rawUrl,
            headers: req.headers,
            body: bodyBuf,
            status: 0,
            timestamp: Date.now(),
          })
          return
        }
        if (fault.type === 'refuse') {
          const status = fault.statusCode ?? 503
          res.writeHead(status, { 'Content-Type': 'text/plain' })
          res.end(fault.message ?? 'Service Unavailable')
          callRecords.push({
            method,
            url: rawUrl,
            headers: req.headers,
            body: bodyBuf,
            status,
            timestamp: Date.now(),
          })
          return
        }
        if (fault.type === 'malformed') {
          const bad = fault.payload ?? 'NOT_A_VALID_HTTP_RESPONSE\r\n\r\n'
          req.socket.write(bad)
          req.socket.destroy()
          return
        }
        if (fault.type === 'delay') {
          await new Promise((r) => setTimeout(r, fault.delayMs))
        }
        if (fault.type === 'stall') {
          return
        }
      }

      if (state.outage || state.scenario === 'outage') {
        res.writeHead(503, { 'Content-Type': 'text/plain' })
        res.end('OIDC mock outage')
        callRecords.push({
          method,
          url: rawUrl,
          headers: req.headers,
          body: bodyBuf,
          status: 503,
          timestamp: Date.now(),
        })
        return
      }

      const address = server.address()
      if (!address || typeof address === 'string') {
        res.writeHead(500)
        res.end()
        return
      }
      const issuer = `http://127.0.0.1:${address.port}`
      const url = new URL(rawUrl, issuer)

      try {
        if (method === 'GET' && path === '/.well-known/openid-configuration') {
          json(res, 200, {
            issuer,
            authorization_endpoint: `${issuer}/authorize`,
            token_endpoint: `${issuer}/token`,
            jwks_uri: `${issuer}/jwks`,
            userinfo_endpoint: `${issuer}/userinfo`,
            response_types_supported: ['code'],
            subject_types_supported: ['public'],
            id_token_signing_alg_values_supported: ['RS256'],
            scopes_supported: ['openid', 'email', 'profile'],
            claims_supported: [
              'iss',
              'aud',
              'sub',
              'email',
              'email_verified',
              'hd',
              'nonce',
              'exp',
              'iat',
              'name',
              'picture',
            ],
            code_challenge_methods_supported: ['S256'],
            grant_types_supported: ['authorization_code'],
            token_endpoint_auth_methods_supported:
              clientSecret === null
                ? ['none']
                : ['client_secret_basic', 'client_secret_post'],
          })
        } else if (method === 'GET' && path === '/jwks') {
          json(res, 200, { keys: getPublishedKeys() })
        } else if (method === 'GET' && path === '/authorize') {
          handleAuthorize(url, res, issuer)
        } else if (method === 'POST' && path === '/token') {
          handleToken(req, bodyBuf, res, issuer)
        } else if (method === 'GET' && path === '/userinfo') {
          handleUserinfo(req, res)
        } else {
          res.writeHead(404, { 'Content-Type': 'text/plain' })
          res.end('Not Found')
        }
      } catch {
        if (!res.writableEnded) {
          res.writeHead(500)
          res.end()
        }
      }

      callRecords.push({
        method,
        url: rawUrl,
        headers: req.headers,
        body: bodyBuf,
        status: res.statusCode || 200,
        timestamp: Date.now(),
      })
    })()
  })

  function handleAuthorize(
    url: URL,
    res: ServerResponse,
    issuer: string,
  ): void {
    const responseType = url.searchParams.get('response_type')
    const reqClientId = url.searchParams.get('client_id')
    const redirect = url.searchParams.get('redirect_uri')
    const challenge = url.searchParams.get('code_challenge')
    const challengeMethod = url.searchParams.get('code_challenge_method')
    const nonce = url.searchParams.get('nonce')
    const stateValue = url.searchParams.get('state')
    const scope = url.searchParams.get('scope') ?? ''

    if (
      responseType !== 'code' ||
      reqClientId !== clientId ||
      !redirect ||
      !redirectUris.includes(redirect) ||
      !challenge ||
      challengeMethod !== 'S256' ||
      !nonce ||
      !stateValue ||
      !scope.split(/\s+/).includes('openid')
    ) {
      res.writeHead(400, { 'Content-Type': 'text/plain' })
      res.end('bad authorization request')
      return
    }

    const code = randomBytes(32).toString('base64url')
    codes.set(code, {
      nonce,
      challenge,
      redirect,
      clientId,
      scope,
    })
    const location = new URL(redirect)
    location.searchParams.set('code', code)
    location.searchParams.set('state', stateValue)
    location.searchParams.set('iss', issuer)
    res.writeHead(302, { Location: location.href })
    res.end()
  }

  function handleToken(
    req: IncomingMessage,
    bodyBuf: Buffer,
    res: ServerResponse,
    issuer: string,
  ): void {
    const body = new URLSearchParams(bodyBuf.toString('utf8'))
    if (!authenticateClient(req, body)) {
      json(res, 401, { error: 'invalid_client' })
      return
    }
    const code = body.get('code') ?? ''
    const saved = codes.get(code)
    codes.delete(code)
    const verifier = body.get('code_verifier') ?? ''
    const challenge = s256Challenge(verifier)
    if (
      !saved ||
      body.get('grant_type') !== 'authorization_code' ||
      body.get('redirect_uri') !== saved.redirect ||
      challenge !== saved.challenge
    ) {
      json(res, 400, { error: 'invalid_grant' })
      return
    }

    const now = Math.floor(Date.now() / 1000)
    const expired = state.scenario === 'expired'
    const aud = state.audienceOverride ?? clientId
    const user = state.user
    const claims: Record<string, unknown> = {
      iss: issuer,
      sub: user.sub,
      aud,
      exp: expired ? now - 3600 : now + 300,
      iat: expired ? now - 7200 : now,
      nonce: saved.nonce,
      email: user.email,
      email_verified: user.email_verified,
    }
    if (user.hd !== undefined) claims.hd = user.hd
    if (user.name !== undefined) claims.name = user.name
    if (user.picture !== undefined) claims.picture = user.picture

    const material = signingMaterial()
    json(res, 200, {
      access_token: randomBytes(24).toString('base64url'),
      token_type: 'Bearer',
      expires_in: 300,
      id_token: signJwt(material.privateKey, material.kid, claims),
      scope: saved.scope,
    })
  }

  function handleUserinfo(req: IncomingMessage, res: ServerResponse): void {
    const auth = req.headers.authorization
    if (!auth || !auth.startsWith('Bearer ')) {
      json(res, 401, { error: 'invalid_token' })
      return
    }
    const user = state.user
    const body: Record<string, unknown> = {
      sub: user.sub,
      email: user.email,
      email_verified: user.email_verified,
    }
    if (user.hd !== undefined) body.hd = user.hd
    if (user.name !== undefined) body.name = user.name
    if (user.picture !== undefined) body.picture = user.picture
    json(res, 200, body)
  }

  server.on('connection', (socket) => {
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
  })

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(options.port ?? 0, '127.0.0.1', () => {
      server.removeListener('error', reject)
      resolve()
    })
  })

  const addr = server.address()
  assertLoopbackAddress(addr)
  if (!addr || typeof addr === 'string') {
    throw new Error('Failed to obtain OIDC mock listening address')
  }

  const port = addr.port
  const origin = `http://127.0.0.1:${port}`

  const ports = Object.assign([port], {
    default: port,
    http: port,
  }) as { default: number; http: number } & number[]

  const callsFn = () => ({ ...callCounts })
  Object.defineProperty(callsFn, 'all', {
    get: () => callRecords,
  })

  const close = async () => {
    scenario.stop()
    for (const socket of sockets) {
      socket.destroy()
    }
    sockets.clear()
    server.closeAllConnections()
    await new Promise<void>((resolve) => {
      server.close(() => resolve())
    })
  }

  return {
    origin,
    issuer: origin,
    clientId,
    clientSecret,
    redirectUris,
    ports,
    control: {
      faults,
      scenario,
      setScenario,
      getScenario: () => state.scenario,
      setUser: (patch) => {
        state = { ...state, user: { ...state.user, ...patch } }
      },
      getUser: () => ({ ...state.user }),
      rotateKeys: () => {
        activeKey = createSigningKey()
        orphanKey = null
        state = {
          ...state,
          activeKid: activeKey.kid,
          signingKid: activeKey.kid,
          scenario:
            state.scenario === 'rotated-key' ? 'verified' : state.scenario,
        }
      },
      orphanSigningKey: () => {
        setScenario('rotated-key')
      },
      getState: () => ({ ...state, user: { ...state.user } }),
      getJwks: () => ({ keys: getPublishedKeys() }),
      sockets,
    },
    calls: callsFn as OidcMockInstance['calls'],
    close,
  }
}
