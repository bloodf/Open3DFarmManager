import assert from 'node:assert/strict'
import type {
  FixtureIdentityHandles,
  SignallingFixtureExtension,
} from './signalling-https-fixture-contract.ts'
import { randomBytes } from 'node:crypto'
import { connect as tlsConnect } from 'node:tls'

/** Bounded raw handshake through the fixture proxy to the actual Nitro listener. */
export async function rawUpgrade(input: {
  port: number
  ca: Buffer
  path: string
  headers?: readonly (readonly [string, string])[]
}): Promise<{ response: string; closed: boolean }> {
  if (
    !Number.isInteger(input.port) ||
    input.port < 1024 ||
    input.port > 65535 ||
    !input.path.startsWith('/') ||
    /[\r\n]/.test(input.path)
  )
    throw new Error('Invalid synthetic upgrade target')
  const fields = input.headers ?? []
  if (
    fields.length > 64 ||
    fields.some(
      ([name, value]) =>
        !/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(name) || /[\r\n]/.test(value),
    )
  )
    throw new Error('Invalid synthetic upgrade headers')
  const socket = tlsConnect({
    host: '127.0.0.1',
    port: input.port,
    ca: input.ca,
    servername: 'localhost',
    rejectUnauthorized: true,
  })
  const request = [
    `GET ${input.path} HTTP/1.1`,
    `Host: 127.0.0.1:${input.port}`,
    'Connection: Upgrade',
    'Upgrade: websocket',
    'Sec-WebSocket-Version: 13',
    `Sec-WebSocket-Key: ${randomBytes(16).toString('base64')}`,
    'Sec-WebSocket-Protocol: open3dfarm.signalling.v1',
    ...fields.map(([name, value]) => `${name}: ${value}`),
    '',
    '',
  ].join('\r\n')
  return await new Promise((resolve, reject) => {
    let response = ''
    let settled = false
    const finish = (error?: Error) => {
      if (settled) return
      settled = true
      socket.destroy()
      if (error) reject(error)
      else resolve({ response, closed: true })
    }
    socket.setTimeout(5000, () =>
      finish(new Error('Fixture upgrade timed out')),
    )
    socket.once('secureConnect', () => socket.write(request))
    socket.on('data', (chunk: Buffer) => {
      response += chunk.toString('latin1')
      if (Buffer.byteLength(response, 'latin1') > 16384)
        finish(new Error('Upgrade response exceeded bound'))
      else if (/^HTTP\/1\.[01] 101\b/.test(response))
        finish(new Error('Unexpected accepted raw upgrade'))
    })
    socket.once('error', (error: Error) => {
      // Rejected upgrades may be reset without a response by the native boundary.
      if (
        'code' in error &&
        ['ECONNRESET', 'EPIPE'].includes(String(error.code))
      )
        finish()
      else finish(error)
    })
    socket.once('close', () => finish())
  })
}

/** These malformed paths/headers must fail closed while Nitro remains live. */
export async function testRawUpgradeRejection(input: {
  port: number
  ca: Buffer
  origin: string
}) {
  const cases = [
    { path: '/api/signalling/missing' },
    { path: '/api/signalling/connector?unexpected=1' },
    {
      path: '/api/signalling/connector',
      headers: [
        ['Origin', input.origin],
        ['Origin', input.origin],
      ] as const,
    },
    {
      path: '/api/signalling/connector',
      headers: [['Cookie', 'synthetic=1']] as const,
    },
  ]
  for (const item of cases) {
    const result = await rawUpgrade({ port: input.port, ca: input.ca, ...item })
    assert.equal(result.closed, true)
    assert.doesNotMatch(result.response, /^HTTP\/1\.[01] 101\b/)
  }
}

import { createRequire } from 'node:module'
import type WebSocketType from '../../packages/connector/node_modules/@types/ws'
const WebSocket: typeof WebSocketType = createRequire(
  new URL('../../packages/connector/package.json', import.meta.url),
)('ws')
export function createFixtureSocket(
  url: string,
  options: { ca: Buffer; origin?: string; cookie?: string },
) {
  return new WebSocket(url, 'open3dfarm.signalling.v1', {
    ca: options.ca,
    rejectUnauthorized: true,
    handshakeTimeout: 5000,
    perMessageDeflate: false,
    ...(options.origin ? { origin: options.origin } : {}),
    ...(options.cookie ? { headers: { cookie: options.cookie } } : {}),
  })
}

import { generateKeyPairSync } from 'node:crypto'
import { once } from 'node:events'
import { chromium, type Page } from '@playwright/test'
import { ConnectorIdentity } from '../../packages/connector/src/identity/store.ts'
import { connectorSocket } from '../../packages/connector/src/cloud/authenticated-signalling-client.ts'
import {
  PairingStartResponse,
  PairingPollResponse,
} from '../../packages/farm-protocol/src/pairing.ts'
import { PairingProofChallenge } from '../../packages/farm-protocol/src/pairing-proof.ts'
import {
  BrowserDeviceHttpChallengeResponse,
  BrowserDeviceHttpMutationResponse,
} from '../../packages/farm-protocol/src/browser-device-http.ts'
import { signBrowserDeviceProof } from '../../packages/farm-protocol/src/browser-device-proof.ts'
import { signBrowserTransportProof } from '../../packages/farm-protocol/src/browser-transport-proof.ts'
import {
  decodeSignallingServerFrame,
  encodeSignallingClientFrame,
  type SignallingClientFrame,
  type SignallingServerFrame,
} from '../../packages/farm-protocol/src/signalling-socket.ts'

class FixturePeer {
  readonly socket: WebSocketType
  readonly #queue: SignallingServerFrame[] = []
  #wake: (() => void) | undefined
  #error: Error | undefined
  constructor(socket: WebSocketType) {
    this.socket = socket
    socket.on('message', (data, binary) => {
      try {
        if (binary || !Buffer.isBuffer(data) || data.byteLength > 12288)
          throw new Error('Invalid fixture frame')
        if (this.#queue.length >= 64)
          throw new Error('Fixture queue exceeded bound')
        this.#queue.push(decodeSignallingServerFrame(data.toString('utf8')))
      } catch {
        this.#error = new Error('Invalid server signalling frame')
      }
      this.#wake?.()
    })
    socket.on('error', () => {
      this.#error = new Error('Fixture socket error')
      this.#wake?.()
    })
    socket.on('close', () => this.#wake?.())
  }
  send(frame: SignallingClientFrame) {
    this.socket.send(encodeSignallingClientFrame(frame))
  }
  async next(): Promise<SignallingServerFrame> {
    const deadline = Date.now() + 8000
    while (!this.#queue.length) {
      if (this.#error || this.socket.readyState >= WebSocket.CLOSING)
        throw new Error('Signalling closed before response')
      const remaining = deadline - Date.now()
      if (remaining <= 0) throw new Error('Signalling response timed out')
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          this.#wake = undefined
          resolve()
        }, remaining)
        this.#wake = () => {
          clearTimeout(timer)
          this.#wake = undefined
          resolve()
        }
      })
    }
    const frame = this.#queue.shift()
    if (!frame) throw new Error('Signalling queue empty')
    return frame
  }
  close() {
    this.socket.terminate()
  }
}
async function waitSocket(
  socket: WebSocketType,
  event: 'open' | 'close',
  timeoutMs: number,
) {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    await Promise.race([
      once(socket, event),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`Socket ${event} timed out`)),
          timeoutMs,
        )
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
}
async function opened(socket: WebSocketType) {
  if (socket.readyState === WebSocket.OPEN) return
  await waitSocket(socket, 'open', 5000)
}
async function browserLogin(
  page: Page,
  origin: string,
  username: string,
  password: string,
) {
  await page.goto(origin + '/entrar', { timeout: 10000 })
  await page.getByLabel('Usuário').fill(username)
  await page.getByLabel('Senha').fill(password)
  await page.getByRole('button', { name: 'Entrar', exact: true }).click()
  await page.waitForURL((url) => url.pathname !== '/entrar', { timeout: 10000 })
}
async function pagePost(
  page: Page,
  path: string,
  body: unknown,
): Promise<unknown> {
  return await page.evaluate(
    async ({ path, body }) => {
      const response = await fetch(path, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      })
      if (!response.ok)
        throw new Error(`Synthetic browser HTTP rejected: ${response.status}`)
      return await response.json()
    },
    { path, body },
  )
}
async function machinePost(
  origin: string,
  path: string,
  body: unknown,
): Promise<unknown> {
  const response = await fetch(origin + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    redirect: 'error',
    signal: AbortSignal.timeout(5000),
  })
  if (!response.ok)
    throw new Error(`Synthetic machine HTTP rejected: ${response.status}`)
  return await response.json()
}
async function closed(socket: WebSocketType, timeoutMs: number) {
  if (socket.readyState === WebSocket.CLOSED) return
  await waitSocket(socket, 'close', timeoutMs)
}
async function actualConnectorHandshake(origin: string) {
  const socket = await connectorSocket(
    origin.replace('https:', 'wss:') + '/api/signalling/connector',
  )
  let timer: ReturnType<typeof setTimeout> | undefined
  let unbind: (() => void) | undefined
  try {
    await new Promise<void>((resolve, reject) => {
      timer = setTimeout(
        () => reject(new Error('Integrated Connector handshake timed out')),
        5000,
      )
      unbind = socket.bind({
        open: resolve,
        message: () => {},
        error: () =>
          reject(new Error('Integrated Connector handshake rejected')),
        close: () =>
          reject(new Error('Integrated Connector closed before open')),
      })
      if (socket.isOpen()) resolve()
    })
  } finally {
    clearTimeout(timer)
    unbind?.()
    socket.close()
  }
}
async function controlBounds(origin: string, ca: Buffer) {
  const url = origin.replace('https:', 'wss:') + '/api/signalling/connector'
  for (const kind of ['ping', 'oversize', 'idle'] as const) {
    console.error(`[fixture-stage] control-${kind}`)
    const socket = createFixtureSocket(url, { ca })
    socket.on('error', () => {})
    try {
      const start = performance.now()
      await opened(socket)
      let pong = false
      socket.on('pong', () => {
        pong = true
      })
      if (kind === 'ping') socket.ping(Buffer.from('fixture'))
      if (kind === 'oversize') socket.send('x'.repeat(12289))
      await closed(socket, kind === 'idle' ? 10500 : 5000)
      if (kind === 'ping' && pong)
        throw new Error('Ping unexpectedly produced pong')
      if (kind === 'idle') {
        const elapsed = performance.now() - start
        if (elapsed < 7000 || elapsed > 10500)
          throw new Error('Admission deadline outside original bound')
      }
    } finally {
      socket.terminate()
    }
  }
}
/** Real HTTPS login, registry, pairing, and WSS proof path. No WebRTC claim. */
export async function runSignallingHttpsAcceptance(input: {
  origin: string
  ca: Buffer
  farmId: string
  owner: string
  admin: string
  password: string
  caPath?: string
  extension?: SignallingFixtureExtension
  extensionKind?: 'rtc' | 'pause-authority' | 'pause-rtc' | 'pause-execution-rtc'
  signal?: AbortSignal
  disconnectSignalling?: () => Promise<void>
}) {
  const parsedOrigin = new URL(input.origin)
  if (
    parsedOrigin.origin !== input.origin ||
    parsedOrigin.protocol !== 'https:' ||
    parsedOrigin.hostname !== '127.0.0.1'
  )
    throw new Error('Fixture requires canonical HTTPS loopback')
  const port = Number(parsedOrigin.port),
    audience = 'open3dfarmmanager:signalling'
  if (!input.extension) {
    console.error('[fixture-stage] raw-negative-upgrades')
    await testRawUpgradeRejection({ port, ca: input.ca, origin: input.origin })
    console.error('[fixture-stage] health-after-negatives')
    const health = await fetch(input.origin + '/healthz', {
      signal: AbortSignal.timeout(5000),
    })
    if (!health.ok)
      throw new Error('Nitro listener unavailable after rejected upgrades')
    console.error('[fixture-stage] integrated-connector-handshake')
    await actualConnectorHandshake(input.origin)
    await controlBounds(input.origin, input.ca)
  }
  console.error('[fixture-stage] chromium-launch')
  const browser = await chromium.launch({ headless: true })
  const sockets: FixturePeer[] = []
  let identities: FixtureIdentityHandles | undefined
  try {
    // The synthetic browser fixture trusts its private test certificate; the native child validates the supplied CA.
    const ownerContext = await browser.newContext({ ignoreHTTPSErrors: true })
    const adminContext = await browser.newContext({ ignoreHTTPSErrors: true })
    const owner = await ownerContext.newPage(),
      admin = await adminContext.newPage()
    console.error('[fixture-stage] owner-login')
    await browserLogin(owner, input.origin, input.owner, input.password)
    console.error('[fixture-stage] admin-login')
    await browserLogin(admin, input.origin, input.admin, input.password)
    const extensionInput =
      input.extension && input.caPath && input.disconnectSignalling
        ? {
            origin: input.origin,
            audience,
            caPath: input.caPath,
            ownerPage: owner,
            ownerContext,
            adminPage: admin,
            accountId: await owner.evaluate(async () => {
              const response = await fetch('/api/auth/me')
              if (!response.ok) throw new Error('Fixture account lookup denied')
              const data: unknown = await response.json()
              if (
                !data ||
                typeof data !== 'object' ||
                !('accountId' in data) ||
                typeof data.accountId !== 'string'
              )
                throw new Error('Invalid fixture account')
              return data.accountId
            }),
            farmId: input.farmId,
            signal: input.signal ?? AbortSignal.timeout(180000),
          }
        : undefined
    if (input.extension && !extensionInput)
      throw new Error('Incomplete extension fixture')
    if (input.extension && extensionInput)
      identities = await input.extension.identityHandles(extensionInput)
    if (input.extension && !identities)
      throw new Error('Fixture identity handles unavailable')
    console.error('[fixture-stage] browser-registration')
    const keyPair = identities
      ? undefined
      : await crypto.subtle.generateKey(
          { name: 'ECDSA', namedCurve: 'P-256' },
          false,
          ['sign', 'verify'],
        )
    const jwk = identities
      ? identities.browser.publicJwk
      : await crypto.subtle.exportKey('jwk', keyPair!.publicKey)
    const challenge = BrowserDeviceHttpChallengeResponse.parse(
      await pagePost(owner, '/api/browser-devices/challenges', {
        farm_id: input.farmId,
        public_key: { kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y },
      }),
    ).challenge
    const signature = identities
      ? await identities.browser.signEnrollment(challenge)
      : await signBrowserDeviceProof(challenge, keyPair!.privateKey)
    BrowserDeviceHttpMutationResponse.parse(
      await pagePost(owner, '/api/browser-devices/proofs', {
        challenge_id: challenge.challenge_id,
        signature,
      }),
    )
    BrowserDeviceHttpMutationResponse.parse(
      await pagePost(admin, '/api/browser-devices/approve', {
        farm_id: input.farmId,
        key_id: challenge.key_id,
        expected_thumbprint: challenge.thumbprint,
      }),
    )
    console.error('[fixture-stage] connector-pairing')
    const identity = identities
      ? undefined
      : new ConnectorIdentity(generateKeyPairSync('ed25519').privateKey)
    const connector = identities?.connector ?? identity!
    const started = PairingStartResponse.parse(
      await machinePost(input.origin, '/api/connector-pairing/start', {
        public_key_spki: connector.publicKeySpki,
        platform: 'linux',
        version: '0.0.1',
      }),
    )
    const pairing = PairingProofChallenge.parse(
      await machinePost(input.origin, '/api/connector-pairing/challenge', {
        device_code: started.device_code,
      }),
    )
    await machinePost(input.origin, '/api/connector-pairing/proof', {
      device_code: started.device_code,
      challenge: pairing,
      signature: identities
        ? await identities.connector.signPairing(
            pairing,
            input.origin,
            audience,
          )
        : identity!.signPairingProof({
            challenge: pairing,
            expectedOrigin: input.origin,
            expectedAudience: audience,
            now: Date.now(),
          }),
    })
    await pagePost(owner, '/api/connector-pairing/approve', {
      user_code: started.user_code,
      farm_id: input.farmId,
      expected_fingerprint: connector.fingerprint,
    })
    const claim = PairingPollResponse.parse(
      await machinePost(input.origin, '/api/connector-pairing/claim', {
        device_code: started.device_code,
      }),
    )
    if (claim.status !== 'approved' || claim.farm_id !== input.farmId)
      throw new Error('Synthetic pairing did not complete')
    if (
      input.extension &&
      extensionInput &&
      identities &&
      input.disconnectSignalling
    ) {
      const printerKey = 'synthetic-readonly-printer'
      const path = `/api/farms/${input.farmId}/printers`
      const registration = await pagePost(owner, path, {
        agentId: claim.agent_id,
        printerKey,
        confirmedLocalConfiguration: true,
      })
      if (
        !registration ||
        typeof registration !== 'object' ||
        !('assignmentId' in registration) ||
        typeof registration.assignmentId !== 'string'
      )
        throw new Error('Fixture printer registration failed')
      const assignmentId = registration.assignmentId
      const listing: unknown = await owner.evaluate(async (target) => {
        const response = await fetch(target)
        if (!response.ok) throw new Error('Fixture printer readback failed')
        return await response.json()
      }, path)
      if (
        !listing ||
        typeof listing !== 'object' ||
        !('printers' in listing) ||
        !Array.isArray(listing.printers) ||
        !listing.printers.some(
          (row: unknown) =>
            row &&
            typeof row === 'object' &&
            'assignmentId' in row &&
            row.assignmentId === assignmentId &&
            'agentId' in row &&
            row.agentId === claim.agent_id &&
            'printerKey' in row &&
            row.printerKey === printerKey,
        )
      )
        throw new Error('Fixture printer readback mismatch')
      await input.extension.afterProvisioned({
        ...extensionInput,
        identities,
        claim,
        browserKeyId: challenge.key_id,
        browserThumbprint: challenge.thumbprint,
        assignmentRefs: [{ assignmentId, agentId: claim.agent_id, printerKey }],
        disconnectSignalling: input.disconnectSignalling,
        revokeConnector: async () => {
          await pagePost(
            owner,
            `/api/farms/${input.farmId}/connectors/${claim.agent_id}/revoke`,
            { expected_fingerprint: connector.fingerprint },
          )
        },
      })
      if (input.extensionKind === 'pause-authority')
        return {
          pauseIssuerHttpCompleted: true,
          syntheticControlProofs: true,
          rtcExecuted: false,
          commandsExecuted: false,
        }
      if (input.extensionKind === 'pause-execution-rtc')
        return { pauseExecutionRtcFixtureCompleted: true, syntheticMoonraker: true, realKlipperAccepted: false }
      if (input.extensionKind === 'pause-rtc')
        return { pauseRtcFixtureCompleted: true, commandsExecuted: false }
      return {
        realWrapperFixtureCompleted: true,
        syntheticPrinterObservation: true,
      }
    }
    const payload: unknown = JSON.parse(
      Buffer.from(claim.device_token.split('.')[1] ?? '', 'base64url').toString(
        'utf8',
      ),
    )
    if (
      !payload ||
      typeof payload !== 'object' ||
      !('jti' in payload) ||
      typeof payload.jti !== 'string'
    )
      throw new Error('Claim token has no credential selector')
    const inboxStarted = performance.now()
    const machine = new FixturePeer(
      createFixtureSocket(
        input.origin.replace('https:', 'wss:') + '/api/signalling/connector',
        { ca: input.ca },
      ),
    )
    sockets.push(machine)
    console.error('[fixture-stage] machine-proof')
    await opened(machine.socket)
    machine.send({
      v: 1,
      t: 'connector.begin',
      farm_id: input.farmId,
      agent_id: claim.agent_id,
      jti: payload.jti,
      token: claim.device_token,
    })
    const inbox = await machine.next()
    if (!('t' in inbox) || inbox.t !== 'connector.inbox-challenge')
      throw new Error('Expected inbox proof challenge')
    machine.send({
      v: 1,
      t: 'connector.inbox-proof',
      signature: identity!.signCredentialProof({
        challenge: inbox.challenge,
        token: claim.device_token,
        expectedOrigin: input.origin,
        expectedAudience: audience,
        expectedPurpose: 'signalling',
        expectedConnectionId: inbox.challenge.connection_id,
        now: Date.now(),
      }),
    })
    const inboxReady = await machine.next()
    if (
      !('t' in inboxReady) ||
      inboxReady.t !== 'connector.inbox-ready' ||
      inboxReady.commands_enabled !== false
    )
      throw new Error('Expected bounded read-only inbox')
    const cookie = (await ownerContext.cookies()).find(
      (item) => item.name === '__Host-open3dfarmmanager-session',
    )
    if (!cookie || !cookie.secure || !cookie.httpOnly)
      throw new Error('Missing host-only browser session')
    const browserPeer = new FixturePeer(
      createFixtureSocket(
        input.origin.replace('https:', 'wss:') + '/api/signalling/browser',
        {
          ca: input.ca,
          origin: input.origin,
          cookie: `${cookie.name}=${cookie.value}`,
        },
      ),
    )
    sockets.push(browserPeer)
    browserPeer.socket.once('unexpected-response', (_request, response) => {
      const status = response.statusCode
      console.error(
        `[fixture-browser-upgrade-status] ${Number.isInteger(status) && status! >= 100 && status! <= 599 ? status : 'invalid'}`,
      )
      response.resume()
      browserPeer.socket.terminate()
    })
    console.error('[fixture-stage] browser-proof')
    await opened(browserPeer.socket)
    console.error('[fixture-stage] browser-opened')
    browserPeer.send({
      v: 1,
      t: 'browser.begin',
      farm_id: input.farmId,
      agent_id: claim.agent_id,
      key_id: challenge.key_id,
    })
    console.error('[fixture-stage] browser-begin-sent')
    const browserChallenge = await browserPeer.next()
    if (
      !('t' in browserChallenge) ||
      browserChallenge.t !== 'browser.challenge'
    )
      throw new Error('Expected browser proof challenge')
    console.error('[fixture-stage] browser-challenge-received')
    browserPeer.send({
      v: 1,
      t: 'browser.proof',
      signature: await signBrowserTransportProof(
        browserChallenge.challenge,
        keyPair!.privateKey,
      ),
    })
    console.error('[fixture-stage] browser-proof-sent')
    const contextRequest = await machine.next()
    if (
      !('t' in contextRequest) ||
      contextRequest.t !== 'connector.context-request'
    )
      throw new Error('Expected connector context request')
    machine.send({ v: 1, t: 'connector.attach', token: claim.device_token })
    let next = await machine.next()
    if ('t' in next && next.t === 'retry') {
      if (next.retry_after_ms > 2000)
        throw new Error('Retry exceeds fixture budget')
      const delay = next.retry_after_ms
      await new Promise((resolve) => setTimeout(resolve, delay))
      machine.send({ v: 1, t: 'connector.retry' })
      next = await machine.next()
    }
    if (!('t' in next) || next.t !== 'connector.context-challenge')
      throw new Error('Expected context proof challenge')
    machine.send({
      v: 1,
      t: 'connector.context-proof',
      signature: identity!.signCredentialProof({
        challenge: next.challenge,
        token: claim.device_token,
        expectedOrigin: input.origin,
        expectedAudience: audience,
        expectedPurpose: 'signalling',
        expectedConnectionId: next.challenge.connection_id,
        now: Date.now(),
      }),
    })
    const browserReady = await browserPeer.next(),
      connectorReady = await machine.next()
    if (
      !('t' in browserReady) ||
      browserReady.t !== 'rtc.ready' ||
      !('t' in connectorReady) ||
      connectorReady.t !== 'rtc.ready' ||
      browserReady.transport_id !== connectorReady.transport_id ||
      browserReady.commands_enabled !== false ||
      connectorReady.commands_enabled !== false
    )
      throw new Error('Signalling binding was not read-only')
    console.error('[fixture-stage] original-lifetime')
    await closed(machine.socket, 35000)
    const leaseElapsed = performance.now() - inboxStarted
    if (leaseElapsed < 28000 || leaseElapsed > 33000)
      throw new Error('Signalling lifetime outside original 30-second bound')
    return {
      integratedConnectorHandshake: true,
      nativeControlFrames: true,
      admissionDeadline: true,
      signallingLifetime: true,
      rawUpgradeRejection: true,
      login: true,
      browserRegistry: true,
      pairedCredential: true,
      inboxProof: true,
      browserProof: true,
      contextProof: true,
      readOnlyRendezvous: true,
      rtcTransport: 'pending-real-client-integration',
    }
  } finally {
    for (const peer of sockets) peer.close()
    try {
      await identities?.dispose()
    } finally {
      await browser.close()
    }
  }
}
