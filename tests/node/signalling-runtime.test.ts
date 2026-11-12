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
import { useSession } from '../../apps/farm/node_modules/nuxt/dist/server/index.js'
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
const origin = 'https://farm.example'
const cookie = {
  name: SESSION_COOKIE_NAME,
  password: 'independent-synthetic-session-secret-123456789',
  cookie: { ...SESSION_COOKIE_ATTRIBUTES },
  maxAge: 3600,
}
const flush = () => new Promise<void>((resolve) => setImmediate(resolve))
class Native extends EventEmitter {
  _autoPong = false
  bufferedAmount = 0
  terminate() {
    this.emit('terminated')
  }
}
interface TestPeer {
  raw: IncomingMessage
  native: Native
  mode: SignallingMode
  wires: (SignallingServerFrame | PauseSignallingServerFrame)[]
  request: { _req: IncomingMessage }
  _internal: { ws: Native }
  send(wire: string): void
  terminate(): void
}
type RuntimeConfig = ConstructorParameters<typeof SignallingRuntime>[0]
async function fixture(
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
        return null
      return { identity: identity(), budget: budget() }
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
const sdp = (hex: string) =>
  `v=0\r\na=fingerprint:sha-256 ${Array(32).fill(hex).join(':')}\r\n`
test('route callbacks retain their admitting runtime and never bind an old socket to a replacement', async () => {
  const first = await fixture(),
    second = await fixture()
  let active = first.runtime
  const hooks = signallingSocketHooks('connector', 'read-only', () => active)
  try {
    const peer = first.peer('connector')
    assert.equal(await hooks.upgrade(peer.request), undefined)
    active = second.runtime
    hooks.open(peer)
    const raw = Buffer.from(
      encodeSignallingClientFrame({
        v: 1,
        t: 'connector.begin',
        farm_id: first.farm,
        agent_id: first.agent,
        jti: first.jti,
        token: first.token,
      }),
    )
    hooks.message(peer, { rawData: raw })
    const challenge = await first.waitFor(peer, 'connector.inbox-challenge')
    assert.equal(challenge.t, 'connector.inbox-challenge')
    assert.equal(peer.raw.socket.destroyed, false)
    hooks.close(peer)
    assert.equal(peer.raw.socket.destroyed, true)
    assert.equal(second.peers.length, 0)
    const unknown = first.peer('connector')
    hooks.open(unknown)
    assert.equal(unknown.raw.socket.destroyed, true)
  } finally {
    first.close()
    second.close()
  }
})
test('runtime replacement while upgrade awaits cannot admit the socket', async () => {
  const first = await fixture(),
    second = await fixture()
  let active = first.runtime
  const hooks = signallingSocketHooks('browser', 'read-only', () => active)
  try {
    const peer = first.peer('browser')
    const pending = hooks.upgrade(peer.request)
    active = second.runtime
    assert.equal((await pending)?.status, 403)
    assert.equal(peer.raw.socket.destroyed, true)
    hooks.open(peer)
    assert.equal(peer.wires.length, 0)
  } finally {
    first.close()
    second.close()
  }
})
test('pause retry retains the original inbox expiry and distinct control transport', async () => {
  const f = await fixture()
  try {
    const machine = await f.inbox('pause')
    f.advance(20000)
    const browser = await f.browserContext('pause'),
      request = machine.wires.at(-1)
    assert.ok(request?.t === 'pause.context-request')
    f.setBusy(true)
    await f.send(machine, {
      v: 1,
      t: 'pause.connector-attach',
      token: f.token,
      transport_id: request.transport_id,
      farm_id: request.farm_id,
      agent_id: request.agent_id,
      assignment_id: request.assignment_id,
    })
    assert.equal(machine.wires.at(-1)?.t, 'pause.retry')
    f.advance(1)
    f.setBusy(false)
    await f.send(machine, { v: 1, t: 'pause.connector-retry' })
    const challenge = machine.wires.at(-1)
    assert.ok(challenge?.t === 'pause.context-challenge')
    assert.equal(challenge.transport_id, request.transport_id)
    assert.equal(challenge.assignment_id, request.assignment_id)
    await f.send(machine, {
      v: 1,
      t: 'pause.connector-context-proof',
      signature: await f.sign(challenge.challenge),
    })
    const ready = browser.wires.at(-1)
    assert.ok(ready?.t === 'pause.ready')
    assert.equal(ready.expires_at, 130000)
    f.advance(10000)
    await f.send(machine, {
      v: 1,
      t: 'rtc.offer',
      transport_id: ready.transport_id,
      seq: 0,
      p: { sdp: sdp('AB') },
    })
    assert.equal(machine.raw.socket.destroyed, true)
    assert.equal(browser.raw.socket.destroyed, true)
    assert.equal(
      browser.wires.some((w) => w.t === 'rtc.offer'),
      false,
    )
  } finally {
    f.close()
  }
})
test('separate pause and readonly contexts share one runtime without upgrading either peer', async () => {
  const f = await fixture()
  try {
    const readonlyMachine = await f.inbox()
    const readonlyBrowser = await f.browserContext()
    await f.attach(readonlyMachine)
    const machine = await f.inbox('pause')
    const browser = await f.browserContext('pause')
    await f.attach(machine)
    const ready = browser.wires.at(-1)
    assert.ok(ready?.t === 'pause.ready')
    assert.equal(ready.assignment_id, f.assignmentId)
    assert.equal(ready.commands_enabled, false)
    await f.send(machine, {
      v: 1,
      t: 'rtc.offer',
      transport_id: ready.transport_id,
      seq: 0,
      p: { sdp: sdp('AB') },
    })
    await f.send(browser, {
      v: 1,
      t: 'rtc.answer',
      transport_id: ready.transport_id,
      seq: 0,
      p: { sdp: sdp('CD') },
    })
    const binding = await f.waitFor(browser, 'pause.binding')
    assert.ok(binding.t === 'pause.binding')
    assert.equal(binding.binding.assignment_id, f.assignmentId)
    assert.equal(binding.binding.purpose, 'pause-rtc')
    assert.equal(binding.binding.audience, 'pause-fixture')
    assert.deepEqual(await f.waitFor(machine, 'pause.binding'), binding)
    assert.equal(readonlyBrowser.wires.at(-1)?.t, 'rtc.ready')
    f.denyPause()
    await f.send(machine, {
      v: 1,
      t: 'rtc.ice',
      transport_id: ready.transport_id,
      seq: 1,
      p: { candidate: '', sdpMid: null, sdpMLineIndex: null },
    })
    assert.equal(browser.raw.socket.destroyed, true)
    assert.equal(machine.raw.socket.destroyed, true)
    assert.equal(readonlyMachine.raw.socket.destroyed, false)
    assert.equal(readonlyBrowser.raw.socket.destroyed, false)
  } finally {
    f.close()
  }
})
test('one inbox per mode permits two for an agent but rejects either duplicate mode', async () => {
  const f = await fixture()
  try {
    const first = await f.inbox(),
      second = await f.inbox('pause')
    for (const mode of ['read-only', 'pause'] as const) {
      const p = await f.connect('connector', mode)
      await f.send(p, {
        v: 1,
        t: mode === 'pause' ? 'pause.connector-begin' : 'connector.begin',
        agent_id: f.agent,
        farm_id: f.farm,
        jti: f.jti,
        token: f.token,
      })
      const challenge = p.wires.at(-1)
      assert.ok(
        challenge?.t === 'connector.inbox-challenge' ||
          challenge?.t === 'pause.connector-inbox-challenge',
      )
      await f.send(p, {
        v: 1,
        t:
          mode === 'pause'
            ? 'pause.connector-inbox-proof'
            : 'connector.inbox-proof',
        signature: await f.sign(challenge.challenge),
      })
      assert.equal(p.raw.socket.destroyed, true)
    }
    assert.equal(first.raw.socket.destroyed, false)
    assert.equal(second.raw.socket.destroyed, false)
  } finally {
    f.close()
  }
})
test('pause facade pins config and database identity; absence cannot disable readonly', async () => {
  for (const field of [
    'missing',
    'origin',
    'credentialIssuer',
    'credentialAudience',
    'database',
    'address',
    'port',
  ] as const) {
    const f = await fixture()
    try {
      const original = f.facade()!
      f.setFacade(
        field === 'missing'
          ? undefined
          : field === 'database' || field === 'address' || field === 'port'
            ? {
                ...original,
                databaseIdentity: {
                  ...original.databaseIdentity,
                  [field]: field === 'port' ? 5433 : 'different',
                },
              }
            : { ...original, [field]: 'different' },
      )
      const p = f.peer('connector', [], 'pause')
      assert.equal(
        (await f.runtime.upgrade(p.request, 'connector', 'pause'))?.status,
        403,
      )
      assert.equal(p.raw.socket.destroyed, true)
      const readonly = await f.inbox()
      assert.equal(readonly.raw.socket.destroyed, false)
    } finally {
      f.close()
    }
  }
})
test('pause facade abort closes both admitted endpoints and never closes the readonly inbox', async () => {
  const f = await fixture()
  try {
    const readonly = await f.inbox(),
      machine = await f.inbox('pause'),
      browser = await f.browserContext('pause')
    await f.attach(machine)
    f.pauseAbort.abort()
    assert.equal(machine.raw.socket.destroyed, true)
    assert.equal(browser.raw.socket.destroyed, true)
    assert.equal(readonly.raw.socket.destroyed, false)
  } finally {
    f.close()
  }
})
test('pause attach checks all four scope fields before issuing a context challenge', async () => {
  for (const field of [
    'transport_id',
    'farm_id',
    'agent_id',
    'assignment_id',
  ] as const) {
    const f = await fixture()
    try {
      const machine = await f.inbox('pause'),
        browser = await f.browserContext('pause')
      const request = machine.wires.at(-1)
      assert.ok(request?.t === 'pause.context-request')
      await f.send(machine, {
        v: 1,
        t: 'pause.connector-attach',
        token: f.token,
        transport_id: request.transport_id,
        farm_id: request.farm_id,
        agent_id: request.agent_id,
        assignment_id: request.assignment_id,
        [field]: randomUUID(),
      })
      assert.equal(machine.raw.socket.destroyed, true)
      assert.equal(browser.raw.socket.destroyed, true)
      assert.equal(
        machine.wires.some((w) => w.t === 'pause.context-challenge'),
        false,
      )
    } finally {
      f.close()
    }
  }
})
test('mode-specific decoding rejects cross-mode begins and command payloads', async () => {
  for (const mode of ['read-only', 'pause'] as const) {
    const f = await fixture()
    try {
      for (const t of [
        mode === 'pause' ? 'browser.begin' : 'pause.begin',
        'control.command',
      ]) {
        const p = await f.connect('browser', mode)
        f.runtime.message(p, {
          rawData: Buffer.from(
            JSON.stringify({
              v: 1,
              t,
              farm_id: f.farm,
              agent_id: f.agent,
              key_id: f.keyId,
            }),
          ),
        })
        await flush()
        assert.equal(p.raw.socket.destroyed, true)
        assert.equal(p.wires.length, 0)
      }
    } finally {
      f.close()
    }
  }
})
test('pause owner loss during an authority await cannot publish a late challenge', async () => {
  const f = await fixture(),
    gate = Promise.withResolvers<void>()
  try {
    await f.inbox('pause')
    const browser = await f.connect('browser', 'pause')
    f.setAuthorityGate(gate.promise)
    const pending = f.send(browser, {
      v: 1,
      t: 'pause.begin',
      farm_id: f.farm,
      agent_id: f.agent,
      key_id: f.keyId,
      assignment_id: f.assignmentId,
    })
    await flush()
    f.pauseAbort.abort()
    gate.resolve()
    await pending
    assert.equal(browser.raw.socket.destroyed, true)
    assert.equal(browser.wires.length, 0)
  } finally {
    gate.resolve()
    f.close()
  }
})
test('two mixed-mode admissions competing for the last shared inbox slot cannot exceed sixteen', async () => {
  const configs: RuntimeConfig[] = []
  let shared: SignallingRuntime | undefined
  let hold = false
  let arrivals = 0
  const both = Promise.withResolvers<void>()
  const gate = Promise.withResolvers<void>()
  const makeRuntime = (config: RuntimeConfig) => {
    configs.push(config)
    shared ??= new SignallingRuntime({
      ...config,
      reader: {
        read: config.reader.read,
        async readConnectorCurrent(input) {
          for (const candidate of configs) {
            const value = await candidate.reader.readConnectorCurrent(input)
            if (value) return value
          }
          return null
        },
      },
      credentials: {
        async issue(input) {
          for (const candidate of configs) {
            const value = await candidate.credentials.issue(input)
            if (value.ok) return value
          }
          return { ok: false, reason: 'denied' }
        },
        async accept(input) {
          for (const candidate of configs) {
            const value = await candidate.credentials.accept(input)
            if (value.ok) {
              if (hold) {
                if (++arrivals === 2) both.resolve()
                await gate.promise
              }
              return value
            }
          }
          return { ok: false, reason: 'denied' }
        },
      },
    })
    return shared
  }
  const fixtures: Awaited<ReturnType<typeof fixture>>[] = []
  const pending: Promise<void>[] = []
  try {
    for (let i = 0; i < 17; i++) fixtures.push(await fixture(makeRuntime))
    for (const f of fixtures.slice(0, 15)) await f.inbox()
    const contenders: TestPeer[] = []
    hold = true
    for (const [index, f] of fixtures.slice(15).entries()) {
      const mode = index === 0 ? 'pause' : 'read-only'
      const p = await f.connect('connector', mode)
      contenders.push(p)
      await f.send(p, {
        v: 1,
        t: mode === 'pause' ? 'pause.connector-begin' : 'connector.begin',
        agent_id: f.agent,
        farm_id: f.farm,
        jti: f.jti,
        token: f.token,
      })
      const challenge = p.wires.at(-1)
      assert.ok(
        challenge?.t === 'connector.inbox-challenge' ||
          challenge?.t === 'pause.connector-inbox-challenge',
      )
      pending.push(
        f.send(p, {
          v: 1,
          t:
            mode === 'pause'
              ? 'pause.connector-inbox-proof'
              : 'connector.inbox-proof',
          signature: await f.sign(challenge.challenge),
        }),
      )
    }
    await Promise.race([
      both.promise,
      ...pending.map((p) =>
        p.then(() => {
          throw new Error('Admission completed before the contention barrier')
        }),
      ),
    ])
    assert.equal(arrivals, 2)
    gate.resolve()
    await Promise.all(pending)
    assert.equal(
      contenders.filter((p) =>
        p.wires.some(
          (w) =>
            w.t === 'connector.inbox-ready' ||
            w.t === 'pause.connector-inbox-ready',
        ),
      ).length,
      1,
    )
    assert.equal(contenders.filter((p) => p.raw.socket.destroyed).length, 1)
    assert.equal(
      fixtures
        .flatMap((f) => f.peers)
        .filter(
          (p) =>
            !p.raw.socket.destroyed &&
            p.wires.some(
              (w) =>
                w.t === 'connector.inbox-ready' ||
                w.t === 'pause.connector-inbox-ready',
            ),
        ).length,
      16,
    )
  } finally {
    gate.resolve()
    await Promise.allSettled(pending)
    for (const f of fixtures) f.close()
  }
})
test('runtime gates both role proofs then relays exact SDP and emits a scoped read-only binding', async () => {
  const f = await fixture()
  try {
    const machine = await f.inbox(),
      browser = await f.browserContext()
    const request = machine.wires.at(-1)
    assert.ok(request?.t === 'connector.context-request')
    const inbox = machine.wires.find(
      (wire) => wire.t === 'connector.inbox-ready',
    )
    assert.ok(inbox?.t === 'connector.inbox-ready')
    assert.notEqual(request.transport_id, inbox.inbox_id)
    const context = await f.attach(machine)
    assert.equal(context.connection_id, request.transport_id)
    const initial = machine.wires.find(
      (wire) => wire.t === 'connector.inbox-challenge',
    )
    assert.ok(initial?.t === 'connector.inbox-challenge')
    assert.ok(context.generation > initial.challenge.generation)
    const ready = browser.wires.at(-1)
    assert.ok(ready?.t === 'rtc.ready')
    assert.ok(ready.expires_at <= inbox.expires_at)
    await f.send(machine, {
      v: 1,
      t: 'rtc.offer',
      transport_id: ready.transport_id,
      seq: 0,
      p: { sdp: sdp('AB') },
    })
    assert.equal(browser.wires.at(-1)?.t, 'rtc.offer')
    await f.send(browser, {
      v: 1,
      t: 'rtc.answer',
      transport_id: ready.transport_id,
      seq: 0,
      p: { sdp: sdp('CD') },
    })
    const binding = await f.waitFor(browser, 'rtc.binding')
    assert.ok(binding?.t === 'rtc.binding')
    assert.equal(binding.binding.transport_id, request.transport_id)
    assert.equal(binding.binding.commands_enabled, false)
    assert.deepEqual(await f.waitFor(machine, 'rtc.binding'), binding)
    f.revoke()
    await f.send(machine, {
      v: 1,
      t: 'rtc.ice',
      transport_id: ready.transport_id,
      seq: 1,
      p: { candidate: '', sdpMid: null, sdpMLineIndex: null },
    })
    assert.equal(machine.raw.socket.destroyed, true)
    assert.equal(browser.raw.socket.destroyed, true)
  } finally {
    f.close()
  }
})
test('same context retries busy proof without extending the original inbox lifetime', async () => {
  const f = await fixture()
  try {
    const machine = await f.inbox()
    f.advance(20_000)
    const browser = await f.browserContext(),
      request = machine.wires.at(-1)
    assert.ok(request?.t === 'connector.context-request')
    f.setBusy(true)
    await f.send(machine, {
      v: 1,
      t: 'connector.attach',
      token: f.token,
    })
    assert.equal(machine.wires.at(-1)?.t, 'retry')
    f.advance(1)
    f.setBusy(false)
    await f.send(machine, { v: 1, t: 'connector.retry' })
    const challenge = machine.wires.at(-1)
    assert.ok(challenge?.t === 'connector.context-challenge')
    assert.equal(challenge.challenge.connection_id, request.transport_id)
    await f.send(machine, {
      v: 1,
      t: 'connector.context-proof',
      signature: await f.sign(challenge.challenge),
    })
    const ready = browser.wires.at(-1)
    assert.ok(ready?.t === 'rtc.ready')
    assert.equal(ready.expires_at, 130_000)
    f.advance(9999)
    await f.send(machine, {
      v: 1,
      t: 'rtc.offer',
      transport_id: ready.transport_id,
      seq: 0,
      p: { sdp: sdp('AB') },
    })
    assert.equal(machine.raw.socket.destroyed, true)
    assert.equal(browser.raw.socket.destroyed, true)
  } finally {
    f.close()
  }
})
test('malformed raw upgrade is destroyed and phase replay/binary input cannot authorize a socket', async () => {
  const f = await fixture()
  try {
    const rejected = f.peer('connector', ['Origin', origin])
    assert.equal(
      (await f.runtime.upgrade(rejected.request, 'connector'))?.status,
      403,
    )
    assert.equal(rejected.raw.socket.destroyed, true)
    const machine = await f.connect('connector')
    await f.send(machine, {
      v: 1,
      t: 'connector.context-proof',
      signature: base64url(randomBytes(64)),
    })
    assert.equal(machine.raw.socket.destroyed, true)
    const binary = await f.connect('connector')
    const payload = Buffer.from('{"v":1,"t":"connector.retry"}')
    binary.native.emit('message', payload, true)
    f.runtime.message(binary, { rawData: payload })
    assert.equal(binary.raw.socket.destroyed, true)
    assert.deepEqual(binary.wires, [])
  } finally {
    f.close()
  }
})

test('token alone, wrong token and wrong private key never produce an authenticated inbox', async () => {
  const f = await fixture()
  try {
    const wrongToken = await f.connect('connector')
    await f.send(wrongToken, {
      v: 1,
      t: 'connector.begin',
      agent_id: f.agent,
      farm_id: f.farm,
      jti: f.jti,
      token: 'wrong',
    })
    assert.equal(wrongToken.raw.socket.destroyed, true)
    assert.deepEqual(wrongToken.wires, [])
    const tokenOnly = await f.connect('connector')
    await f.send(tokenOnly, {
      v: 1,
      t: 'connector.begin',
      agent_id: f.agent,
      farm_id: f.farm,
      jti: f.jti,
      token: f.token,
    })
    const challenge = tokenOnly.wires.at(-1)
    assert.ok(challenge?.t === 'connector.inbox-challenge')
    await f.send(tokenOnly, {
      v: 1,
      t: 'rtc.offer',
      transport_id: challenge.challenge.connection_id,
      seq: 0,
      p: { sdp: sdp('AB') },
    })
    assert.equal(tokenOnly.raw.socket.destroyed, true)
    assert.equal(
      tokenOnly.wires.some((wire) => wire.t === 'connector.inbox-ready'),
      false,
    )
    const wrongKey = await f.connect('connector')
    await f.send(wrongKey, {
      v: 1,
      t: 'connector.begin',
      agent_id: f.agent,
      farm_id: f.farm,
      jti: f.jti,
      token: f.token,
    })
    const keyChallenge = wrongKey.wires.at(-1)
    assert.ok(keyChallenge?.t === 'connector.inbox-challenge')
    const other = await crypto.subtle.generateKey('Ed25519', false, [
      'sign',
      'verify',
    ])
    const signature = base64url(
      new Uint8Array(
        await crypto.subtle.sign(
          'Ed25519',
          other.privateKey,
          new Uint8Array(credentialProofPayload(keyChallenge.challenge)),
        ),
      ),
    )
    await f.send(wrongKey, { v: 1, t: 'connector.inbox-proof', signature })
    assert.equal(wrongKey.raw.socket.destroyed, true)
    assert.equal(
      wrongKey.wires.some((wire) => wire.t === 'connector.inbox-ready'),
      false,
    )
    assert.equal(
      JSON.stringify(f.peers.flatMap((peer) => peer.wires)).includes(f.token),
      false,
    )
  } finally {
    f.close()
  }
})
test('inbox signature cannot be replayed for the distinct context proof', async () => {
  const f = await fixture()
  try {
    const machine = await f.inbox()
    const inboxChallenge = machine.wires.find(
      (wire) => wire.t === 'connector.inbox-challenge',
    )
    assert.ok(inboxChallenge?.t === 'connector.inbox-challenge')
    const browser = await f.browserContext()
    await f.send(machine, {
      v: 1,
      t: 'connector.attach',
      token: f.token,
    })
    await f.send(machine, {
      v: 1,
      t: 'connector.context-proof',
      signature: await f.sign(inboxChallenge.challenge),
    })
    assert.equal(machine.raw.socket.destroyed, true)
    assert.equal(browser.raw.socket.destroyed, true)
    assert.equal(
      browser.wires.some((wire) => wire.t === 'rtc.ready'),
      false,
    )
  } finally {
    f.close()
  }
})
test('proof expiry after async verification and shutdown during pending authority fail closed', async () => {
  const f = await fixture()
  try {
    const machine = await f.connect('connector')
    await f.send(machine, {
      v: 1,
      t: 'connector.begin',
      agent_id: f.agent,
      farm_id: f.farm,
      jti: f.jti,
      token: f.token,
    })
    const challenge = machine.wires.at(-1)
    assert.ok(challenge?.t === 'connector.inbox-challenge')
    f.afterAcceptance(() => f.advance(8000))
    await f.send(machine, {
      v: 1,
      t: 'connector.inbox-proof',
      signature: await f.sign(challenge.challenge),
    })
    assert.equal(machine.raw.socket.destroyed, true)
    assert.equal(
      machine.wires.some((wire) => wire.t === 'connector.inbox-ready'),
      false,
    )
  } finally {
    f.close()
  }
  const pending = await fixture()
  let release = () => {}
  try {
    const barrier = new Promise<void>((resolve) => {
      release = resolve
    })
    pending.setAuthorityGate(barrier)
    const browser = await pending.connect('browser')
    const sent = pending.send(browser, {
      v: 1,
      t: 'browser.begin',
      agent_id: pending.agent,
      farm_id: pending.farm,
      key_id: pending.keyId,
    })
    pending.runtime.close()
    await sent
    release()
    await flush()
    assert.equal(browser.raw.socket.destroyed, true)
    assert.deepEqual(browser.wires, [])
  } finally {
    release()
    pending.close()
  }
})

test('a small local wall regression between messages closes a pending context', async () => {
  const f = await fixture()
  try {
    const machine = await f.inbox()
    const browser = await f.browserContext()
    f.regressWall()
    await f.send(machine, {
      v: 1,
      t: 'connector.attach',
      token: f.token,
    })
    assert.equal(machine.raw.socket.destroyed, true)
    assert.equal(browser.raw.socket.destroyed, true)
  } finally {
    f.close()
  }
})

test('the read-only Connector inbox receives scoped, strictly increasing authority confirmations and a revocation before close', async () => {
  const f = await fixture()
  try {
    const first = await f.inbox()
    const confirm = first.wires.at(-1)
    assert.ok(confirm?.t === 'connector.authority-confirm')
    assert.deepEqual(
      {
        farm_id: confirm.farm_id,
        agent_id: confirm.agent_id,
        credential_jti: confirm.credential_jti,
      },
      { farm_id: f.farm, agent_id: f.agent, credential_jti: f.jti },
    )
    // The pause inbox never carries authority confirmations.
    const pause = await f.inbox('pause')
    assert.ok(
      !pause.wires.some((wire) => wire.t.startsWith('connector.authority')),
    )
    // The next 5 s current-authority reread fails: revoke, then close.
    f.revoke()
    const revoked = await new Promise<{ server_seq: number }>(
      (resolve, reject) => {
        const deadline = Date.now() + 8000
        const poll = () => {
          const frame = first.wires.find(
            (wire) => wire.t === 'connector.authority-revoked',
          )
          if (frame && frame.t === 'connector.authority-revoked') resolve(frame)
          else if (Date.now() > deadline) reject(new Error('No revocation'))
          else setTimeout(poll, 20)
        }
        poll()
      },
    )
    assert.ok(revoked.server_seq > confirm.server_seq)
    await new Promise((resolve) => setTimeout(resolve, 20))
    assert.equal(first.raw.socket.destroyed, true)
  } finally {
    f.close()
  }
})

test('a revocation from an app server whose wall clock runs ahead never blocks later database-time confirmations', async () => {
  const { createOfflineAuthority } =
    await import('../../packages/connector/src/auth/offline-authority.ts')
  const tracker = createOfflineAuthority()
  const sample = () => ({ wall: Date.now(), mono: performance.now() })
  const seq = (p: { wires: { t: string }[] }, t: string) =>
    (p.wires.find((wire) => wire.t === t) as { server_seq: number } | undefined)
      ?.server_seq
  const first = await fixture()
  let revokedSeq: number | undefined
  try {
    // The app server wall clock runs one day ahead of database time.
    first.skewAppWall(86_400_000)
    const inbox = await first.inbox()
    assert.equal(
      tracker.confirm(sample(), seq(inbox, 'connector.authority-confirm')!),
      true,
    )
    // The next current-authority reread fails.
    first.revoke()
    const deadline = Date.now() + 8000
    while (
      (revokedSeq = seq(inbox, 'connector.authority-revoked')) === undefined
    ) {
      if (Date.now() > deadline) throw new Error('No revocation')
      await new Promise((resolve) => setTimeout(resolve, 20))
    }
    tracker.revoke(revokedSeq)
  } finally {
    first.close()
  }
  // Another instance confirms from slightly later database time.
  const second = await fixture()
  try {
    second.advance(1000)
    const inbox = await second.inbox()
    const confirmSeq = seq(inbox, 'connector.authority-confirm')!
    assert.ok(confirmSeq > revokedSeq!)
    assert.equal(tracker.confirm(sample(), confirmSeq), true)
  } finally {
    second.close()
  }
})
