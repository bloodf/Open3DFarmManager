import test from 'node:test'
import { canonicalize } from '../../packages/farm-protocol/src/canonical.ts'
import assert from 'node:assert/strict'
import {
  randomBytes,
  randomUUID,
  generateKeyPairSync,
  createHash,
} from 'node:crypto'
import {
  PauseBrowserSignallingClient,
  pauseBrowserSocket,
} from '../../apps/farm/app/utils/webrtc/pause-signalling-client.ts'
import {
  PauseSignallingClientChannel,
  SignallingClientChannel,
  type SocketPort,
} from '../../packages/connector/src/webrtc/signalling-client-channel.ts'
import { validateBrowserDevicePublicKey } from '../../packages/farm-protocol/src/browser-device-proof.ts'
import {
  verifyPauseTransportProof,
  encodePauseSignallingServerFrame,
} from '../../packages/farm-protocol/src/pause-signalling.ts'
import type { ControlSessionBinding } from '../../packages/farm-protocol/src/control-session-binding.ts'
import type { PauseBrowserPeer } from '../../apps/farm/app/utils/webrtc/pause-control-peer.ts'

async function until(check: () => boolean) {
  for (let n = 0; n < 100; n++) {
    if (check()) return
    await new Promise((resolve) => setTimeout(resolve, 2))
  }
  assert.fail('Fixture did not settle')
}
async function fixture(
  extra: { reentrant?: boolean; abort?: AbortSignal } = {},
) {
  const key = await crypto.subtle.generateKey(
    { name: 'ECDSA', namedCurve: 'P-256' },
    false,
    ['sign', 'verify'],
  )
  const jwk = await crypto.subtle.exportKey('jwk', key.publicKey)
  const publicKey = {
    kty: 'EC' as const,
    crv: 'P-256' as const,
    x: jwk.x!,
    y: jwk.y!,
  }
  const thumbprint = (await validateBrowserDevicePublicKey(publicKey))
    .thumbprint
  let now = 1000,
    wall = 100000
  const scope = {
    farmId: randomUUID(),
    agentId: randomUUID(),
    assignmentId: randomUUID(),
    keyId: randomUUID(),
    accountId: 'account-text',
    origin: 'https://farm.example',
    audience: 'pause-audience',
    publicKey,
    privateKey: key.privateKey,
  }
  const challenge = {
    v: 1 as const,
    purpose: 'pause-signalling-admission' as const,
    transport_id: randomUUID(),
    farm_id: scope.farmId,
    agent_id: scope.agentId,
    assignment_id: scope.assignmentId,
    key_id: scope.keyId,
    account_id: scope.accountId,
    origin: scope.origin,
    audience: scope.audience,
    thumbprint,
    nonce: randomBytes(32).toString('base64url'),
    issued_at: wall,
    expires_at: wall + 8000,
  }
  let handlers: Parameters<SocketPort['bind']>[0] | undefined
  const sent: string[] = []
  let closes = 0,
    peerCloses = 0,
    phaseSends = 0
  let resolveClosed!: () => void
  const closed = new Promise<void>((resolve) => {
    resolveClosed = resolve
  })
  const socket: SocketPort = {
    isOpen: () => true,
    bufferedBytes: () => 0,
    send: (wire, done) => {
      sent.push(wire)
      done()
    },
    bind: (h) => {
      handlers = h
      return () => {
        handlers = undefined
      }
    },
    close: () => {
      closes++
      resolveClosed()
    },
    waitClosed: () => closed,
  }
  let peerOptions: ConstructorParameters<typeof PauseBrowserPeer>[0] | undefined
  let resolvePeer!: () => void
  const peerClosed = new Promise<void>((resolve) => {
    resolvePeer = resolve
  })
  let ready = 0
  const client = new PauseBrowserSignallingClient(scope, {
    clock: { now: () => now, wallNow: () => wall },
    ...(extra.abort ? { signal: extra.abort } : {}),
    onProofsReady: () => {
      ready++
    },
    peerFactory: (options) => {
      peerOptions = options
      if (extra.reentrant) options.onTerminal?.('construction-terminal')
      return {
        answer: async () =>
          `v=0\r\na=fingerprint:sha-256 ${Array(32).fill('AA').join(':')}\r\n`,
        close: () => {
          peerCloses++
          resolvePeer()
        },
        closed: peerClosed,
        sendPhase: () => {
          phaseSends++
          return true
        },
      }
    },
  })
  const started = client.start(() => socket)
  void started.catch(() => {})
  if (!extra.abort?.aborted) {
    await until(() => !!handlers)
    handlers?.open()
    await until(() => sent.length === 1)
  }
  const emit = (frame: unknown) => handlers?.message(canonicalize(frame))
  async function prove() {
    emit({ v: 1, t: 'pause.challenge', challenge })
    await until(
      () => sent.length === 2 || client.snapshot().reason !== undefined,
    )
  }
  async function offer() {
    emit({
      v: 1,
      t: 'pause.ready',
      transport_id: challenge.transport_id,
      farm_id: scope.farmId,
      agent_id: scope.agentId,
      assignment_id: scope.assignmentId,
      issued_at: wall,
      expires_at: wall + 30000,
      commands_enabled: false,
    })
    await until(() => !!peerOptions)
    emit({
      v: 1,
      t: 'rtc.offer',
      transport_id: challenge.transport_id,
      seq: 0,
      p: {
        sdp: `v=0\r\na=fingerprint:sha-256 ${Array(32).fill('BB').join(':')}\r\n`,
      },
    })
    await until(
      () => sent.length === 3 || client.snapshot().reason !== undefined,
    )
  }
  const spki = generateKeyPairSync('ed25519').publicKey.export({
    type: 'spki',
    format: 'der',
  })
  const binding: ControlSessionBinding = {
    v: 1,
    purpose: 'pause-rtc',
    transport_id: challenge.transport_id,
    farm_id: scope.farmId,
    agent_id: scope.agentId,
    assignment_id: scope.assignmentId,
    account_id: scope.accountId,
    key_id: scope.keyId,
    browser_public_key: publicKey,
    browser_thumbprint: thumbprint,
    connector_public_key_spki: spki.toString('base64url'),
    connector_fingerprint:
      'SHA256:' + createHash('sha256').update(spki).digest('base64url'),
    credential_jti: randomUUID(),
    origin: scope.origin,
    audience: scope.audience,
    browser_nonce: challenge.nonce,
    connector_nonce: randomBytes(32).toString('base64url'),
    issued_at: wall,
    expires_at: wall + 30000,
    offer_sha256: 'A'.repeat(43),
    answer_sha256: 'A'.repeat(43),
    browser_dtls: Array(32).fill('AA').join(':'),
    connector_dtls: Array(32).fill('BB').join(':'),
  }
  async function bind() {
    emit({ v: 1, t: 'pause.binding', binding })
    assert.deepEqual(await peerOptions?.expectedBinding, binding)
  }
  function verified() {
    peerOptions?.onProofsReady?.({
      binding,
      deadlineMonoMs: 31000,
      browserProofWire: 'fixture-browser-proof',
      connectorProofWire: 'fixture-connector-proof',
    })
  }
  return {
    scope,
    challenge,
    binding,
    client,
    started,
    sent,
    emit,
    prove,
    offer,
    bind,
    verified,
    peer: () => peerOptions,
    counts: () => ({ closes, peerCloses, phaseSends, ready }),
    advance: (ms: number) => {
      now += ms
      wall += ms
    },
  }
}

test('fresh pause browser proof uses actual P256 and exact immutable assignment; readiness requires peer proofs', async () => {
  const f = await fixture()
  try {
    assert.equal(
      f.client.start(() => {
        throw Error('second socket')
      }),
      f.started,
    )
    const original = structuredClone({ ...f.scope, privateKey: undefined })
    f.scope.accountId = 'changed'
    f.scope.assignmentId = randomUUID()
    await f.prove()
    assert.equal(
      await verifyPauseTransportProof(
        f.challenge,
        original.publicKey,
        JSON.parse(f.sent[1]!).signature,
      ),
      true,
    )
    // Mutating the caller cannot retarget the wrapper; use captured tuple for server messages.
    f.scope.accountId = f.challenge.account_id
    f.scope.assignmentId = f.challenge.assignment_id
    await f.offer()
    await f.bind()
    assert.equal(f.counts().ready, 0)
    assert.equal(
      f.client.sendPhase({ t: 'control.admission-proof', wire: 'invalid' }),
      false,
    )
    f.verified()
    await f.started
    assert.equal(f.counts().ready, 1)
    assert.equal(f.client.diagnostics().certificateMatched, false)
    assert.equal(f.client.diagnostics().commandsEnabled, false)
    assert.equal(f.peer()?.expected.assignmentId, f.challenge.assignment_id)
    assert.equal(f.peer()?.authDeadline, 9000)
    assert.equal(f.peer()?.lifetimeDeadline, 31000)
  } finally {
    await f.client.dispose(1000)
  }
  assert.equal(f.counts().closes, 1)
  assert.equal(f.counts().peerCloses, 1)
})

test('foreign challenge account, assignment, key, audience, origin and replay close without peer creation', async () => {
  for (const [field, value] of [
    ['account_id', 'other'],
    ['assignment_id', randomUUID()],
    ['key_id', randomUUID()],
    ['audience', 'other'],
    ['origin', 'https://other.example'],
  ] as const) {
    const f = await fixture()
    try {
      f.emit({
        v: 1,
        t: 'pause.challenge',
        challenge: { ...f.challenge, [field]: value },
      })
      await assert.rejects(f.started)
      assert.equal(f.peer(), undefined)
      assert.equal(f.sent.length, 1)
    } finally {
      await f.client.dispose(1000)
    }
  }
  const f = await fixture()
  try {
    await f.prove()
    f.emit({ v: 1, t: 'pause.challenge', challenge: f.challenge })
    await assert.rejects(f.started)
  } finally {
    await f.client.dispose(1000)
  }
})

test('ready and binding must retain exact server transport and assignment, readonly frames never upgrade', async () => {
  for (const mode of [
    'ready-assignment',
    'binding-transport',
    'binding-key',
    'readonly',
  ] as const) {
    const f = await fixture()
    try {
      await f.prove()
      if (mode === 'ready-assignment')
        f.emit({
          v: 1,
          t: 'pause.ready',
          transport_id: f.challenge.transport_id,
          farm_id: f.scope.farmId,
          agent_id: f.scope.agentId,
          assignment_id: randomUUID(),
          issued_at: 100000,
          expires_at: 130000,
          commands_enabled: false,
        })
      else if (mode === 'readonly')
        f.emit({
          v: 1,
          t: 'rtc.ready',
          transport_id: f.challenge.transport_id,
          issued_at: 100000,
          expires_at: 130000,
          commands_enabled: false,
        })
      else {
        await f.offer()
        assert.equal(f.sent.length, 3)
        f.emit({
          v: 1,
          t: 'pause.binding',
          binding: {
            ...f.binding,
            ...(mode === 'binding-key'
              ? { key_id: randomUUID() }
              : { transport_id: randomUUID() }),
          },
        })
      }
      await assert.rejects(f.started)
      assert.equal(f.counts().ready, 0)
    } finally {
      await f.client.dispose(1000)
    }
  }
})

test('original admission deadline, late peer constructor and account-owner abort remain terminal', async () => {
  const late = await fixture()
  try {
    await late.prove()
    late.advance(8000)
    assert.equal(
      late.client.sendPhase({ t: 'control.admission-proof', wire: 'invalid' }),
      false,
    )
    await assert.rejects(late.started)
    assert.equal(late.peer(), undefined)
  } finally {
    await late.client.dispose(1000)
  }
  const reentrant = await fixture({ reentrant: true })
  try {
    await reentrant.prove()
    await reentrant.offer()
    await assert.rejects(reentrant.started)
    assert.equal(reentrant.counts().peerCloses, 1)
  } finally {
    await reentrant.client.dispose(1000)
  }
  const abort = new AbortController(),
    f = await fixture({ abort: abort.signal })
  try {
    await f.prove()
    abort.abort()
    await assert.rejects(f.started)
    assert.equal(f.client.snapshot().reason, 'aborted')
  } finally {
    await f.client.dispose(1000)
  }
})

test('separate channel codecs reject cross-domain frames and retain identical write/receive limits', async () => {
  for (const pause of [true, false]) {
    let handlers: Parameters<SocketPort['bind']>[0] | undefined
    let reason = '',
      closes = 0
    const options = {
      onOpen: () => {},
      onFrame: async () => {},
      onTerminal: (value: string) => {
        reason = value
      },
    }
    const channel = pause
      ? new PauseSignallingClientChannel(options)
      : new SignallingClientChannel(options)
    channel.connect(() => ({
      isOpen: () => true,
      bufferedBytes: () => 0,
      send: () => {},
      bind: (h) => {
        handlers = h
        return () => {}
      },
      close: () => {
        closes++
      },
      waitClosed: async () => {},
    }))
    await until(() => !!handlers)
    handlers?.open()
    handlers?.message(
      JSON.stringify({
        v: 1,
        t: pause ? 'retry' : 'pause.retry',
        phase: 'inbox',
        retry_after_ms: 1,
      }),
    )
    await until(() => reason !== '')
    assert.equal(reason, 'invalid-server-frame')
    await channel.dispose(1000)
    assert.equal(closes, 1)
  }
  const channel = new PauseSignallingClientChannel({
    onOpen: () => {},
    onFrame: async () => {},
    onTerminal: () => {},
  })
  let handlers: Parameters<SocketPort['bind']>[0] | undefined
  channel.connect(() => ({
    isOpen: () => true,
    bufferedBytes: () => 32768,
    send: () => assert.fail('over-budget write'),
    bind: (h) => {
      handlers = h
      return () => {}
    },
    close: () => {},
    waitClosed: async () => {},
  }))
  await until(() => !!handlers)
  assert.throws(() => channel.send({ v: 1, t: 'pause.connector-retry' }))
  assert.equal(channel.snapshot().reason, 'send-failed')
  await channel.dispose(1000)
  assert.throws(() =>
    encodePauseSignallingServerFrame({
      v: 1,
      t: 'control.command',
      command: 'x',
    }),
  )
})

test('browser socket validates exact HTTPS origin, pause path and credentials before allocating WebSocket', () => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'location')
  Object.defineProperty(globalThis, 'location', {
    configurable: true,
    value: { origin: 'https://farm.example' },
  })
  try {
    for (const url of [
      'wss://other.example/api/signalling/pause-browser',
      '/api/signalling/browser',
      '/api/signalling/pause-browser?x=1',
      'wss://user:pass@farm.example/api/signalling/pause-browser',
    ])
      assert.throws(() => pauseBrowserSocket(url, 'https://farm.example'))
    assert.throws(() => pauseBrowserSocket(undefined, 'https://other.example'))
  } finally {
    if (previous) Object.defineProperty(globalThis, 'location', previous)
    else Reflect.deleteProperty(globalThis, 'location')
  }
})
