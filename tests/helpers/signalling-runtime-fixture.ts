import {
  decodePauseSignallingServerFrame,
  encodePauseSignallingClientFrame,
  signPauseTransportProof,
  type PauseSignallingClientFrame,
  type PauseSignallingServerFrame,
} from '../../packages/farm-protocol/src/pause-signalling.ts'
import type { PauseNegotiationRuntime } from '../../apps/farm/server/utils/pause-authority/runtime.ts'
import {
  PauseNegotiationAuthority,
  PauseNegotiationScope,
} from '../../apps/farm/server/storage/postgres-pause-negotiation.ts'
import type { SignallingMode } from '../../apps/farm/server/services/signalling-negotiation-adapter.ts'
import { PAUSE_SIGNALLING_SUBPROTOCOL } from '../../apps/farm/server/services/signalling-websocket-boundary.ts'
import { assignmentSetDigest } from '../../packages/farm-protocol/src/rtc-assignment-set.ts'
import test from 'node:test'
import assert from 'node:assert/strict'
import { IncomingMessage } from 'node:http'
import { Socket } from 'node:net'
import { EventEmitter } from 'node:events'
import { randomBytes, randomUUID } from 'node:crypto'
import { useSession } from 'nuxt/server'
import { SignallingRuntime } from '../../apps/farm/server/services/signalling-runtime.ts'
import { signallingSocketHooks } from '../../apps/farm/server/services/signalling-routes.ts'
import {
  SESSION_COOKIE_NAME,
  SESSION_COOKIE_ATTRIBUTES,
} from '../../apps/farm/server/utils/auth/boundary.ts'
import { SIGNALLING_SUBPROTOCOL } from '../../apps/farm/server/services/signalling-websocket-boundary.ts'
import {
  decodeSignallingServerFrame,
  encodeSignallingClientFrame,
  SignallingClientFrame as SignallingClientFrameSchema,
  type SignallingClientFrame,
  type SignallingServerFrame,
} from '../../packages/farm-protocol/src/signalling-socket.ts'
import { signBrowserTransportProof } from '../../packages/farm-protocol/src/browser-transport-proof.ts'
import {
  CredentialProofRequest,
  CredentialProofCompletion,
  CredentialProofChallenge,
  credentialProofPayload,
} from '../../packages/farm-protocol/src/credential-proof.ts'
import {
  base64url,
  decodeBase64url,
} from '../../packages/farm-protocol/src/encoding.ts'
import {
  connectorKeyBinding,
  issueConnectorCredential,
  verifyConnectorCredential,
} from '../../apps/farm/server/utils/connector-credentials.ts'
import type { CredentialAcceptanceDecision } from '../../apps/farm/server/storage/postgres-connector-credential-acceptance.ts'
import type { SignallingAuthority } from '../../apps/farm/server/services/signalling-coordinator.ts'
import { validateBrowserDevicePublicKey } from '../../packages/farm-protocol/src/browser-device-proof.ts'
export const origin = 'https://farm.example'
export const cookie = {
  name: SESSION_COOKIE_NAME,
  password: 'independent-synthetic-session-secret-123456789',
  cookie: { ...SESSION_COOKIE_ATTRIBUTES },
  maxAge: 3600,
}
export const flush = () => new Promise<void>((resolve) => setImmediate(resolve))
export class Native extends EventEmitter {
  _autoPong = false
  bufferedAmount = 0
  terminate() {
    this.emit('terminated')
  }
}
export interface TestPeer {
  raw: IncomingMessage
  native: Native
  mode: SignallingMode
  wires: (SignallingServerFrame | PauseSignallingServerFrame)[]
  request: { _req: IncomingMessage }
  _internal: { ws: Native }
  send(wire: string): void
  terminate(): void
}
export type RuntimeConfig = ConstructorParameters<typeof SignallingRuntime>[0]
export async function fixture(
  makeRuntime = (config: RuntimeConfig) => new SignallingRuntime(config),
) {
  let wall = 100_000,
    mono = 1000,
    revoked = false,
    busyContext = false,
    appSkew = 0
  // The app server clock; `appSkew` models an app wall clock ahead of database time.
  const clock = { wall: () => wall + appSkew, monotonic: () => mono }
  let authorityGate: Promise<void> | null = null
  let afterAccept = () => {}
  const browserKey = await crypto.subtle.generateKey(
    { name: 'ECDSA', namedCurve: 'P-256' },
    false,
    ['sign', 'verify'],
  )
  const connectorKey = await crypto.subtle.generateKey('Ed25519', false, [
    'sign',
    'verify',
  ])
  const publicJwk = await crypto.subtle.exportKey('jwk', browserKey.publicKey)
  const browser = await validateBrowserDevicePublicKey({
    kty: publicJwk.kty,
    crv: publicJwk.crv,
    x: publicJwk.x,
    y: publicJwk.y,
  })
  const spki = base64url(
    new Uint8Array(
      await crypto.subtle.exportKey('spki', connectorKey.publicKey),
    ),
  )
  const connector = await connectorKeyBinding(spki)
  const issuerKey = await crypto.subtle.generateKey('Ed25519', false, [
    'sign',
    'verify',
  ])
  const agent = randomUUID(),
    farm = randomUUID(),
    keyId = randomUUID(),
    jti = randomUUID()
  const assignments = await assignmentSetDigest(
    { farmId: farm, agentId: agent },
    [
      {
        assignmentId: randomUUID(),
        agentId: agent,
        printerKey: 'fixture-printer',
      },
    ],
  )
  const authority: SignallingAuthority = {
    assignment_count: assignments.count,
    assignment_digest: assignments.digest,
    farm_id: farm,
    agent_id: agent,
    key_id: keyId,
    account_id: 'account_text',
    browser_public_key: browser.publicKey,
    browser_thumbprint: browser.thumbprint,
    connector_public_key_spki: spki,
    connector_fingerprint: connector.fingerprint,
    credential_jti: jti,
    origin,
    audience: 'signalling-fixture',
    validUntil: 200_000,
  }
  const token = await issueConnectorCredential({
    issuer: 'independent-signalling-fixture',
    audience: authority.audience,
    kid: 'fixture',
    privateKey: issuerKey.privateKey,
    ttlSeconds: 100,
    nowSeconds: 100,
    agentId: agent,
    farmId: farm,
    publicKeySpki: spki,
    jti,
  })
  async function validToken(value: string): Promise<boolean> {
    try {
      const verified = await verifyConnectorCredential({
        token: value,
        issuer: 'independent-signalling-fixture',
        audience: authority.audience,
        publicKeys: new Map([['fixture', issuerKey.publicKey]]),
        ttlSeconds: 100,
        nowSeconds: Math.floor(wall / 1000),
        agentId: agent,
        farmId: farm,
        publicKeySpki: spki,
      })
      return verified.jti === jti
    } catch {
      return false
    }
  }
  const identity = () => ({
    agent_id: agent,
    farm_id: farm,
    connector_public_key_spki: spki,
    connector_fingerprint: connector.fingerprint,
    credential_jti: jti,
    origin,
    audience: authority.audience,
    validUntil: authority.validUntil,
  })
  const budget = () => ({
    observedAt: wall,
    validUntil: authority.validUntil,
    monotonicDeadline: mono + authority.validUntil - wall,
  })
  const reader = {
    async read(scope: {
      sessionRecordId: string
      agentId: string
      farmId: string
      keyId: string
    }) {
      await authorityGate
      return !revoked &&
        scope.sessionRecordId === 'session_text' &&
        scope.agentId === agent &&
        scope.farmId === farm &&
        scope.keyId === keyId
        ? { authority: { ...authority }, budget: budget() }
        : null
    },
    async readConnectorCurrent(input: unknown) {
      if (
        !input ||
        typeof input !== 'object' ||
        !('agentId' in input) ||
        !('farmId' in input) ||
        !('jti' in input) ||
        input.agentId !== agent ||
        input.farmId !== farm ||
        input.jti !== jti ||
        revoked
      )
        return { kind: 'denied' as const }
      return {
        kind: 'authorized' as const,
        snapshot: { identity: identity(), budget: budget() },
      }
    },
  }
  let inboxId: string | undefined
  const challenges = new Map<string, CredentialProofChallenge>()
  const consumed = new Set<string>()
  const credentials = {
    async issue(input: unknown): Promise<CredentialAcceptanceDecision> {
      const request = CredentialProofRequest.parse(input)
      if (
        !(await validToken(request.token)) ||
        request.agentId !== agent ||
        request.farmId !== farm ||
        revoked
      )
        return { ok: false, reason: 'denied' }
      if (!inboxId) inboxId = request.connectionId
      if (busyContext && request.connectionId !== inboxId)
        return { ok: false, reason: 'busy', retryAfterMs: 1 }
      const challenge = CredentialProofChallenge.parse({
        v: 1,
        agent_id: agent,
        farm_id: farm,
        jti,
        connection_id: request.connectionId,
        public_key_spki: spki,
        fingerprint: connector.fingerprint,
        thumbprint: connector.thumbprint,
        token_hash: base64url(
          new Uint8Array(
            await crypto.subtle.digest(
              'SHA-256',
              new TextEncoder().encode(request.token),
            ),
          ),
        ),
        origin,
        audience: authority.audience,
        purpose: 'signalling',
        generation: challenges.size + 1,
        nonce: base64url(randomBytes(32)),
        issued_at: wall,
        expires_at: wall + 8000,
      })
      challenges.set(request.connectionId, challenge)
      return { ok: true, kind: 'challenge', challenge }
    },
    async accept(input: unknown): Promise<CredentialAcceptanceDecision> {
      const request = CredentialProofCompletion.parse(input),
        challenge = challenges.get(request.connectionId)
      if (
        !challenge ||
        !(await validToken(request.token)) ||
        consumed.has(challenge.nonce) ||
        revoked ||
        wall >= challenge.expires_at ||
        JSON.stringify(challenge) !== JSON.stringify(request.challenge)
      )
        return { ok: false, reason: 'denied' }
      const valid = await crypto.subtle.verify(
        'Ed25519',
        connectorKey.publicKey,
        new Uint8Array(decodeBase64url(request.signature, 64)),
        new Uint8Array(credentialProofPayload(challenge)),
      )
      if (!valid) return { ok: false, reason: 'denied' }
      consumed.add(challenge.nonce)
      const acceptedAt = wall
      afterAccept()
      return {
        ok: true,
        kind: 'accepted',
        agentId: agent,
        farmId: farm,
        jti,
        connectionId: request.connectionId,
        purpose: 'signalling',
        acceptedAt,
        expiresAt: challenge.expires_at,
      }
    },
  }
  const assignmentId = randomUUID()
  const pauseAbort = new AbortController()
  const databaseIdentity = Object.freeze({
    database: 'fixture',
    address: '127.0.0.1',
    port: 5432,
  })
  const pauseAuthority = () => {
    const {
      assignment_count: _count,
      assignment_digest: _digest,
      ...shared
    } = authority
    return PauseNegotiationAuthority.parse({
      ...shared,
      assignment_id: assignmentId,
      role: 'owner',
      audience: 'pause-fixture',
    })
  }
  let pauseDenied = false
  let facade: PauseNegotiationRuntime | undefined = Object.freeze({
    owner: Object.freeze({}),
    signal: pauseAbort.signal,
    origin,
    audience: 'pause-fixture',
    credentialIssuer: 'independent-signalling-fixture',
    credentialAudience: authority.audience,
    databaseIdentity,
    reader: {
      async read(input) {
        const scope = PauseNegotiationScope.parse(input)
        const current = await reader.read(scope)
        return current && !pauseDenied && scope.assignmentId === assignmentId
          ? {
              authority: pauseAuthority(),
              printerKey: 'fixture-printer',
              budget: budget(),
            }
          : null
      },
    },
  })
  const runtime = makeRuntime({
    reader,
    credentials,
    origin,
    cookie,
    clock,
    pause: {
      current: () => facade,
      databaseIdentity,
      credentialIssuer: 'independent-signalling-fixture',
      credentialAudience: authority.audience,
    },
  })
  const changes = new EventEmitter()
  const peers: TestPeer[] = []
  const sealedEvent = {
    req: new Request(origin),
    res: { headers: new Headers() },
  }
  await (
    await useSession(sealedEvent, cookie)
  ).update({ sessionRecordId: 'session_text' })
  const sealed = sealedEvent.res.headers.getSetCookie().at(-1)?.split(';')[0]
  assert.ok(sealed)
  function peer(
    role: 'browser' | 'connector',
    headers: string[] = [],
    mode: SignallingMode = 'read-only',
  ): TestPeer {
    const raw = new IncomingMessage(new Socket())
    raw.method = 'GET'
    raw.url = '/api/signalling/' + (mode === 'pause' ? 'pause-' : '') + role
    raw.rawHeaders = [
      'Host',
      'farm.example',
      'Upgrade',
      'websocket',
      'Connection',
      'Upgrade',
      'Sec-WebSocket-Version',
      '13',
      'Sec-WebSocket-Key',
      randomBytes(16).toString('base64'),
      'Sec-WebSocket-Protocol',
      mode === 'pause' ? PAUSE_SIGNALLING_SUBPROTOCOL : SIGNALLING_SUBPROTOCOL,
      ...(role === 'browser' ? ['Origin', origin, 'Cookie', sealed!] : []),
      ...headers,
    ]
    const native = new Native(),
      wires: (SignallingServerFrame | PauseSignallingServerFrame)[] = []
    const value = {
      mode,
      raw,
      native,
      wires,
      request: { _req: raw },
      _internal: { ws: native },
      send(wire: string) {
        wires.push(
          mode === 'pause'
            ? decodePauseSignallingServerFrame(wire)
            : decodeSignallingServerFrame(wire),
        )
        changes.emit('changed')
      },
      terminate() {
        raw.socket.destroy()
        changes.emit('changed')
      },
    }
    native.once('terminated', () => value.terminate())
    peers.push(value)
    return value
  }
  async function connect(
    role: 'browser' | 'connector',
    mode: SignallingMode = 'read-only',
  ) {
    const p = peer(role, [], mode)
    assert.equal(await runtime.upgrade(p.request, role, mode), undefined)
    runtime.open(p)
    assert.equal(p.raw.socket.destroyed, false)
    return p
  }
  async function send(
    p: ReturnType<typeof peer>,
    frame: SignallingClientFrame | PauseSignallingClientFrame,
  ) {
    const done = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        changes.removeListener('changed', changed)
        reject(new Error('Expected a signalling response or terminal close'))
      }, 2000)
      const changed = () => {
        clearTimeout(timer)
        resolve()
      }
      changes.once('changed', changed)
    })
    const raw = Buffer.from(
      p.mode === 'pause'
        ? encodePauseSignallingClientFrame(frame)
        : encodeSignallingClientFrame(SignallingClientFrameSchema.parse(frame)),
    )
    p.native.emit('message', raw, false)
    runtime.message(p, { rawData: raw })
    await done
    await flush()
  }
  async function waitFor(
    p: TestPeer,
    type: (SignallingServerFrame | PauseSignallingServerFrame)['t'],
  ): Promise<SignallingServerFrame | PauseSignallingServerFrame> {
    const existing = p.wires.find((wire) => wire.t === type)
    if (existing) return existing
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        changes.removeListener('changed', changed)
        reject(new Error('Expected signalling frame: ' + type))
      }, 2000)
      const changed = () => {
        const frame = p.wires.find((wire) => wire.t === type)
        if (frame || p.raw.socket.destroyed) {
          clearTimeout(timer)
          changes.removeListener('changed', changed)
          if (frame) resolve(frame)
          else reject(new Error('Socket closed before signalling frame'))
        }
      }
      changes.on('changed', changed)
    })
  }
  async function sign(challenge: CredentialProofChallenge) {
    return base64url(
      new Uint8Array(
        await crypto.subtle.sign(
          'Ed25519',
          connectorKey.privateKey,
          new Uint8Array(credentialProofPayload(challenge)),
        ),
      ),
    )
  }
  async function inbox(mode: SignallingMode = 'read-only') {
    const p = await connect('connector', mode)
    await send(p, {
      v: 1,
      t: mode === 'pause' ? 'pause.connector-begin' : 'connector.begin',
      agent_id: agent,
      farm_id: farm,
      jti,
      token: token,
    })
    const challenge = p.wires.at(-1)
    assert.ok(
      challenge?.t === 'connector.inbox-challenge' ||
        challenge?.t === 'pause.connector-inbox-challenge',
    )
    await send(p, {
      v: 1,
      t:
        mode === 'pause'
          ? 'pause.connector-inbox-proof'
          : 'connector.inbox-proof',
      signature: await sign(challenge.challenge),
    })
    if (mode === 'pause')
      assert.equal(p.wires.at(-1)?.t, 'pause.connector-inbox-ready')
    else
      assert.deepEqual(
        p.wires.slice(-2).map((wire) => wire.t),
        ['connector.inbox-ready', 'connector.authority-confirm'],
      )
    return p
  }
  async function browserContext(mode: SignallingMode = 'read-only') {
    const p = await connect('browser', mode)
    await send(p, {
      v: 1,
      ...(mode === 'pause'
        ? { t: 'pause.begin' as const, assignment_id: assignmentId }
        : { t: 'browser.begin' as const }),
      agent_id: agent,
      farm_id: farm,
      key_id: keyId,
    })
    const challenge = p.wires.at(-1)
    assert.ok(
      challenge?.t === 'browser.challenge' ||
        challenge?.t === 'pause.challenge',
    )
    await send(
      p,
      challenge.t === 'pause.challenge'
        ? {
            v: 1,
            t: 'pause.browser-proof',
            signature: await signPauseTransportProof(
              challenge.challenge,
              browserKey.privateKey,
            ),
          }
        : {
            v: 1,
            t: 'browser.proof',
            signature: await signBrowserTransportProof(
              challenge.challenge,
              browserKey.privateKey,
            ),
          },
    )
    return p
  }
  async function attach(p: ReturnType<typeof peer>) {
    const request = p.wires.at(-1)
    if (p.mode === 'pause') {
      assert.ok(request?.t === 'pause.context-request')
      await send(p, {
        v: 1,
        t: 'pause.connector-attach',
        token,
        transport_id: request.transport_id,
        farm_id: request.farm_id,
        agent_id: request.agent_id,
        assignment_id: request.assignment_id,
      })
    } else await send(p, { v: 1, t: 'connector.attach', token })
    const challenge = p.wires.at(-1)
    assert.ok(
      challenge?.t === 'connector.context-challenge' ||
        challenge?.t === 'pause.context-challenge',
    )
    await send(p, {
      v: 1,
      t:
        p.mode === 'pause'
          ? 'pause.connector-context-proof'
          : 'connector.context-proof',
      signature: await sign(challenge.challenge),
    })
    return challenge.challenge
  }
  return {
    runtime,
    assignmentId,
    pauseAbort,
    setFacade(value: PauseNegotiationRuntime | undefined) {
      facade = value
    },
    facade: () => facade,
    denyPause() {
      pauseDenied = true
    },
    peer,
    connect,
    send,
    inbox,
    browserContext,
    attach,
    sign,
    waitFor,
    token,
    agent,
    farm,
    jti,
    keyId,
    peers,
    setAuthorityGate(value: Promise<void>) {
      authorityGate = value
    },
    afterAcceptance(callback: () => void) {
      afterAccept = callback
    },
    setBusy(value: boolean) {
      busyContext = value
    },
    advance(ms: number) {
      wall += ms
      mono += ms
    },
    skewAppWall(ms: number) {
      appSkew = ms
    },
    regressWall() {
      wall--
    },
    revoke() {
      revoked = true
    },
    close() {
      runtime.close()
      for (const p of peers) p.raw.socket.destroy()
    },
  }
}
