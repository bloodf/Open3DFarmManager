import { assignmentSetDigest } from '../../packages/farm-protocol/src/rtc-assignment-set.ts'
import test from 'node:test'
import assert from 'node:assert/strict'
import { IncomingMessage } from 'node:http'
import { Socket } from 'node:net'
import { EventEmitter } from 'node:events'
import { randomBytes, randomUUID } from 'node:crypto'
import { useSession } from '../../apps/farm/node_modules/nuxt/dist/server/index.js'
import { SignallingRuntime } from '../../apps/farm/server/services/signalling-runtime.ts'
import {
  SESSION_COOKIE_NAME,
  SESSION_COOKIE_ATTRIBUTES,
} from '../../apps/farm/server/utils/auth/boundary.ts'
import { SIGNALLING_SUBPROTOCOL } from '../../apps/farm/server/services/signalling-websocket-boundary.ts'
import {
  decodeSignallingServerFrame,
  encodeSignallingClientFrame,
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
  wires: SignallingServerFrame[]
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
    busyContext = false
  const clock = { wall: () => wall, monotonic: () => mono }
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
  const runtime = makeRuntime({
    reader,
    credentials,
    origin,
    cookie,
    clock,
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
  ): TestPeer {
    const raw = new IncomingMessage(new Socket())
    raw.method = 'GET'
    raw.url = '/api/signalling/' + role
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
      SIGNALLING_SUBPROTOCOL,
      ...(role === 'browser' ? ['Origin', origin, 'Cookie', sealed!] : []),
      ...headers,
    ]
    const native = new Native(),
      wires: SignallingServerFrame[] = []
    const value = {
      raw,
      native,
      wires,
      request: { _req: raw },
      _internal: { ws: native },
      send(wire: string) {
        wires.push(decodeSignallingServerFrame(wire))
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
  async function connect(role: 'browser' | 'connector') {
    const p = peer(role)
    assert.equal(await runtime.upgrade(p.request, role), undefined)
    runtime.open(p)
    assert.equal(p.raw.socket.destroyed, false)
    return p
  }
  async function send(
    p: ReturnType<typeof peer>,
    frame: SignallingClientFrame,
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
    const raw = Buffer.from(encodeSignallingClientFrame(frame))
    p.native.emit('message', raw, false)
    runtime.message(p, { rawData: raw })
    await done
    await flush()
  }
  async function waitFor(
    p: TestPeer,
    type: SignallingServerFrame['t'],
  ): Promise<SignallingServerFrame> {
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
  async function inbox() {
    const p = await connect('connector')
    await send(p, {
      v: 1,
      t: 'connector.begin',
      agent_id: agent,
      farm_id: farm,
      jti,
      token: token,
    })
    const challenge = p.wires.at(-1)
    assert.ok(challenge?.t === 'connector.inbox-challenge')
    await send(p, {
      v: 1,
      t: 'connector.inbox-proof',
      signature: await sign(challenge.challenge),
    })
    assert.equal(p.wires.at(-1)?.t, 'connector.inbox-ready')
    return p
  }
  async function browserContext() {
    const p = await connect('browser')
    await send(p, {
      v: 1,
      t: 'browser.begin',
      agent_id: agent,
      farm_id: farm,
      key_id: keyId,
    })
    const challenge = p.wires.at(-1)
    assert.ok(challenge?.t === 'browser.challenge')
    await send(p, {
      v: 1,
      t: 'browser.proof',
      signature: await signBrowserTransportProof(
        challenge.challenge,
        browserKey.privateKey,
      ),
    })
    return p
  }
  async function attach(p: ReturnType<typeof peer>) {
    await send(p, {
      v: 1,
      t: 'connector.attach',
      token: token,
    })
    const challenge = p.wires.at(-1)
    assert.ok(challenge?.t === 'connector.context-challenge')
    await send(p, {
      v: 1,
      t: 'connector.context-proof',
      signature: await sign(challenge.challenge),
    })
    return challenge.challenge
  }
  return {
    runtime,
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
test('two verified admissions competing for the last inbox slot cannot exceed sixteen', async () => {
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
    for (const f of fixtures.slice(15)) {
      const p = await f.connect('connector')
      contenders.push(p)
      await f.send(p, {
        v: 1,
        t: 'connector.begin',
        agent_id: f.agent,
        farm_id: f.farm,
        jti: f.jti,
        token: f.token,
      })
      const challenge = p.wires.at(-1)
      assert.ok(challenge?.t === 'connector.inbox-challenge')
      pending.push(
        f.send(p, {
          v: 1,
          t: 'connector.inbox-proof',
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
        p.wires.some((w) => w.t === 'connector.inbox-ready'),
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
            p.wires.some((w) => w.t === 'connector.inbox-ready'),
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
