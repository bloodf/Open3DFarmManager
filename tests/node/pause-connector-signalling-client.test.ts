import assert from 'node:assert/strict'
import { test } from 'node:test'
import { EventEmitter } from 'node:events'
import {
  createHash,
  createPublicKey,
  generateKeyPairSync,
  randomBytes,
  randomUUID,
  verify,
} from 'node:crypto'
import { ConnectorIdentity } from '../../packages/connector/src/identity/store.ts'
import { PauseConnectorSignallingClient } from '../../packages/connector/src/cloud/pause-signalling-client.ts'
import {
  connectorSocket,
  pauseConnectorSocket,
} from '../../packages/connector/src/cloud/authenticated-signalling-client.ts'
import { encodePauseSignallingServerFrame } from '../../packages/farm-protocol/src/pause-signalling.ts'
import { credentialProofPayload } from '../../packages/farm-protocol/src/credential-proof.ts'
import {
  ControlSessionBinding,
  encodeControlProof,
  signControlSessionProof,
} from '../../packages/farm-protocol/src/control-session-binding.ts'
import { validateBrowserDevicePublicKey } from '../../packages/farm-protocol/src/browser-device-proof.ts'
import type { SocketPort } from '../../packages/connector/src/webrtc/signalling-client-channel.ts'
import type { PauseProofsReady } from '../../packages/connector/src/webrtc/pause-control-session.ts'
const tick = () => new Promise<void>((resolve) => setImmediate(resolve))
const digest = () => randomBytes(32).toString('base64url')
const sdp = 'v=0\r\na=fingerprint:sha-256 ' + 'AA:'.repeat(31) + 'AA\r\n'
type Options = NonNullable<
  ConstructorParameters<typeof PauseConnectorSignallingClient>[1]
>
type PeerOptions = Parameters<NonNullable<Options['peerFactory']>>[0]
async function fixture(
  options: {
    holdPeer?: boolean
    onProofsReady?: (value: PauseProofsReady) => void
  } = {},
) {
  const identity = new ConnectorIdentity(
    generateKeyPairSync('ed25519').privateKey,
  )
  const scope = {
    url: 'wss://farm.example/api/signalling/pause-connector',
    origin: 'https://farm.example',
    audience: 'pause-client-test',
    credentialAudience: 'credential-pop-client-test',
    agentId: randomUUID(),
    farmId: randomUUID(),
    assignmentId: randomUUID(),
    accountId: 'fixture-account',
    keyId: randomUUID(),
    jti: randomUUID(),
    token: 'synthetic-test-token',
    identity,
  }
  let now = performance.now(),
    wall = Date.now(),
    socketClosed = 0,
    peerClosed = 0,
    inboxReady = 0,
    terminal = 0
  let handlers: Parameters<SocketPort['bind']>[0] | undefined,
    input: PeerOptions | undefined
  let binding: unknown
  const sent: Record<string, unknown>[] = []
  const phaseSends: unknown[] = []
  let resolveSocket = () => {},
    resolvePeer = () => {},
    releasePeer = () => {}
  const socketSettled = new Promise<void>((resolve) => {
    resolveSocket = resolve
  })
  const peerSettled = new Promise<void>((resolve) => {
    resolvePeer = resolve
  })
  const held = new Promise<void>((resolve) => {
    releasePeer = resolve
  })
  const port: SocketPort = {
    isOpen: () => true,
    bufferedBytes: () => 0,
    send(wire, done) {
      sent.push(JSON.parse(wire))
      done()
    },
    bind(value) {
      handlers = value
      return () => {}
    },
    close() {
      socketClosed++
      resolveSocket()
    },
    waitClosed: () => socketSettled,
  }
  const client = new PauseConnectorSignallingClient(scope, {
    clock: { now: () => now, wallNow: () => wall },
    socketFactory: () => port,
    onInboxReady() {
      inboxReady++
    },
    onTerminal() {
      terminal++
    },
    ...(options.onProofsReady ? { onProofsReady: options.onProofsReady } : {}),
    peerFactory: async (value) => {
      assert.equal(value.onData, undefined)
      input = value
      void value.expectedBinding.then((b) => {
        binding = b
      })
      if (options.holdPeer) await held
      return {
        offer: async () => sdp,
        answer: () => {},
        closed: peerSettled,
        close() {
          peerClosed++
          resolvePeer()
        },
        sendPhase(message) {
          phaseSends.push(message)
          return true
        },
        diagnostics: () => ({
          certificateMatched: true,
          closeCount: 0,
          cleanupFailures: 0,
          proofsReady: true,
          sentProofs: 1,
          receivedProofs: 1,
          terminal: false,
          commandsEnabled: false,
          pending: 0,
          retainedBytes: 0,
        }),
      }
    },
  })
  const pending = client.start()
  assert.equal(client.start(), pending)
  await tick()
  assert.ok(handlers)
  handlers.open()
  await tick()
  const jwk = createPublicKey({
    key: Buffer.from(identity.publicKeySpki, 'base64url'),
    format: 'der',
    type: 'spki',
  }).export({ format: 'jwk' })
  const challenge = {
    v: 1 as const,
    agent_id: scope.agentId,
    farm_id: scope.farmId,
    jti: scope.jti,
    connection_id: randomUUID(),
    public_key_spki: identity.publicKeySpki,
    fingerprint: identity.fingerprint,
    thumbprint: createHash('sha256')
      .update(JSON.stringify({ crv: jwk.crv, kty: jwk.kty, x: jwk.x }))
      .digest('base64url'),
    token_hash: createHash('sha256').update(scope.token).digest('base64url'),
    origin: scope.origin,
    audience: scope.credentialAudience,
    purpose: 'signalling' as const,
    generation: 7,
    nonce: digest(),
    issued_at: wall - 1,
    expires_at: wall + 5000,
  }
  const context = {
    ...challenge,
    connection_id: randomUUID(),
    generation: 20,
    nonce: digest(),
  }
  const exactScope = {
    transport_id: context.connection_id,
    farm_id: scope.farmId,
    agent_id: scope.agentId,
    assignment_id: scope.assignmentId,
  }
  const lease = () => ({
    issued_at: wall - 1,
    expires_at: wall + 20000,
    commands_enabled: false as const,
  })
  const push = async (frame: unknown) => {
    assert.ok(handlers)
    handlers.message(encodePauseSignallingServerFrame(frame))
    await tick()
  }
  const inbox = async () => {
    await push({ v: 1, t: 'pause.connector-inbox-challenge', challenge })
    await push({
      v: 1,
      t: 'pause.connector-inbox-ready',
      inbox_id: challenge.connection_id,
      ...lease(),
    })
  }
  const notice = () =>
    push({
      v: 1,
      t: 'pause.context-request',
      ...exactScope,
      ...lease(),
      expires_at: wall + 5000,
    })
  const contextProof = () =>
    push({
      v: 1,
      t: 'pause.context-challenge',
      ...exactScope,
      challenge: context,
    })
  const rtcReady = () =>
    push({ v: 1, t: 'pause.ready', ...exactScope, ...lease() })
  const answer = () =>
    push({
      v: 1,
      t: 'rtc.answer',
      transport_id: context.connection_id,
      seq: 0,
      p: { sdp },
    })
  const makeBinding = async () => {
    const keys = await crypto.subtle.generateKey(
      { name: 'ECDSA', namedCurve: 'P-256' },
      false,
      ['sign', 'verify'],
    )
    const { kty, crv, x, y } = await crypto.subtle.exportKey(
      'jwk',
      keys.publicKey,
    )
    const browser = await validateBrowserDevicePublicKey({ kty, crv, x, y })
    const value = ControlSessionBinding.parse({
      v: 1,
      purpose: 'pause-rtc',
      ...exactScope,
      account_id: scope.accountId,
      key_id: scope.keyId,
      browser_public_key: browser.publicKey,
      browser_thumbprint: browser.thumbprint,
      connector_public_key_spki: identity.publicKeySpki,
      connector_fingerprint: identity.fingerprint,
      credential_jti: scope.jti,
      origin: scope.origin,
      audience: scope.audience,
      browser_nonce: digest(),
      connector_nonce: context.nonce,
      issued_at: wall - 1,
      expires_at: wall + 15000,
      offer_sha256: digest(),
      answer_sha256: digest(),
      browser_dtls: 'AA:'.repeat(31) + 'AA',
      connector_dtls: 'AA:'.repeat(31) + 'AA',
    })
    const ready: PauseProofsReady = {
      binding: value,
      deadlineMonoMs: now + 15000,
      browserProofWire: encodeControlProof({
        v: 1,
        role: 'browser',
        binding: value,
        signature: await signControlSessionProof(
          value,
          'browser',
          keys.privateKey,
        ),
      }),
      connectorProofWire: encodeControlProof(
        await identity.signControlSessionProof({
          binding: value,
          expectedAgentId: scope.agentId,
        }),
      ),
    }
    return { value, ready }
  }
  return {
    client,
    pending,
    scope,
    challenge,
    context,
    exactScope,
    lease,
    push,
    inbox,
    notice,
    contextProof,
    rtcReady,
    answer,
    makeBinding,
    sent,
    phaseSends,
    input: () => input,
    binding: () => binding,
    counts: () => ({ socketClosed, peerClosed, inboxReady, terminal }),
    advance(ms: number) {
      now += ms
      wall += ms
    },
    releasePeer,
    async cleanup() {
      releasePeer()
      client.close()
      await pending.catch(() => {})
      await client.dispose(1000)
    },
  }
}

test('pause inbox and context use genuine credential signatures, generation gaps and independent scope', async () => {
  const admissions: PauseProofsReady[] = []
  const f = await fixture({
    onProofsReady(value) {
      admissions.push(value)
    },
  })
  try {
    assert.equal(f.sent[0]?.t, 'pause.connector-begin')
    assert.notEqual(f.scope.credentialAudience, f.scope.audience)
    assert.equal(f.challenge.audience, f.scope.credentialAudience)
    assert.equal(f.counts().inboxReady, 0)
    await f.inbox()
    assert.equal(f.counts().inboxReady, 1)
    assert.equal(f.input(), undefined)
    await f.notice()
    assert.deepEqual(f.sent.at(-1), {
      v: 1,
      t: 'pause.connector-attach',
      ...f.exactScope,
      token: f.scope.token,
    })
    await f.contextProof()
    for (const [c, t] of [
      [f.challenge, 'pause.connector-inbox-proof'],
      [f.context, 'pause.connector-context-proof'],
    ] as const) {
      const proof = f.sent.find((v) => v.t === t)
      assert.ok(proof)
      assert.equal(typeof proof.signature, 'string')
      assert.equal(
        verify(
          null,
          credentialProofPayload(c),
          createPublicKey({
            key: Buffer.from(f.scope.identity.publicKeySpki, 'base64url'),
            type: 'spki',
            format: 'der',
          }),
          Buffer.from(String(proof.signature), 'base64url'),
        ),
        true,
      )
    }
    await f.rtcReady()
    assert.equal(f.sent.at(-1)?.t, 'rtc.offer')
    assert.equal(f.input()?.expected.assignmentId, f.scope.assignmentId)
    await f.answer()
    const b = await f.makeBinding()
    await f.push({ v: 1, t: 'pause.binding', binding: b.value })
    assert.deepEqual(f.binding(), b.value)
    assert.equal(admissions.length, 0)
    f.input()?.onProofsReady?.(b.ready)
    await f.pending
    const ready = admissions[0]
    assert.ok(ready)
    assert.equal(admissions.length, 1)
    assert.ok(Object.isFrozen(ready))
    assert.ok(Object.isFrozen(ready.binding.browser_public_key))
    assert.equal(
      f.client.diagnostics().certificateMatched,
      false,
      'Mock peers never provide real transport evidence',
    )
    assert.equal(
      f.client.sendPhase({
        t: 'control.admission-nonce',
        admission_nonce: digest(),
        issued_at: Date.now(),
        expires_at: Date.now() + 1000,
      }),
      true,
    )
    assert.equal(f.phaseSends.length, 1)
    assert.equal(f.client.diagnostics().commandsEnabled, false)
  } finally {
    await f.cleanup()
  }
})

test('pause challenge rejects wrong credential scope before signing', async () => {
  for (const delta of [
    { agent_id: randomUUID() },
    { farm_id: randomUUID() },
    { jti: randomUUID() },
    { origin: 'https://foreign.example' },
    { audience: 'foreign' },
    { thumbprint: digest() },
    { token_hash: digest() },
    { fingerprint: 'SHA256:' + digest() },
  ]) {
    const f = await fixture()
    try {
      await f.push({
        v: 1,
        t: 'pause.connector-inbox-challenge',
        challenge: { ...f.challenge, ...delta },
      })
      await assert.rejects(f.pending)
      assert.equal(f.sent.length, 1)
    } finally {
      await f.cleanup()
    }
  }
})

test('context assignment/farm/agent/transport and challenge replay are fail-closed', async () => {
  for (const fault of [
    'assignment',
    'farm',
    'agent',
    'transport',
    'generation',
    'nonce',
  ] as const) {
    const f = await fixture()
    try {
      await f.inbox()
      if (fault === 'assignment' || fault === 'farm' || fault === 'agent') {
        await f.push({
          v: 1,
          t: 'pause.context-request',
          ...f.exactScope,
          ...f.lease(),
          ...(fault === 'assignment'
            ? { assignment_id: randomUUID() }
            : fault === 'farm'
              ? { farm_id: randomUUID() }
              : { agent_id: randomUUID() }),
        })
      } else {
        await f.notice()
        const other = randomUUID()
        await f.push({
          v: 1,
          t: 'pause.context-challenge',
          ...f.exactScope,
          ...(fault === 'transport' ? { transport_id: other } : {}),
          challenge: {
            ...f.context,
            ...(fault === 'generation'
              ? { generation: 7 }
              : fault === 'nonce'
                ? { nonce: f.challenge.nonce }
                : { connection_id: other }),
          },
        })
      }
      await assert.rejects(f.pending)
      assert.equal(f.input(), undefined)
    } finally {
      await f.cleanup()
    }
  }
})

test('retry remains prechallenge only and cannot extend original auth deadline', async () => {
  const f = await fixture()
  try {
    await f.push({ v: 1, t: 'pause.retry', phase: 'inbox', retry_after_ms: 1 })
    await new Promise((resolve) => setTimeout(resolve, 5))
    assert.equal(f.sent.at(-1)?.t, 'pause.connector-retry')
    await f.push({
      v: 1,
      t: 'pause.connector-inbox-challenge',
      challenge: f.challenge,
    })
    await f.push({ v: 1, t: 'pause.retry', phase: 'inbox', retry_after_ms: 1 })
    await assert.rejects(f.pending)
  } finally {
    await f.cleanup()
  }
  const expired = await fixture()
  try {
    expired.advance(7900)
    await expired.push({
      v: 1,
      t: 'pause.retry',
      phase: 'inbox',
      retry_after_ms: 200,
    })
    await assert.rejects(expired.pending)
    assert.equal(expired.sent.length, 1)
  } finally {
    await expired.cleanup()
  }
})

test('late peer completion closes and settles after original context expiry', async () => {
  const f = await fixture({ holdPeer: true })
  try {
    await f.inbox()
    await f.notice()
    await f.contextProof()
    await f.rtcReady()
    assert.ok(f.input())
    f.advance(6000)
    f.client.snapshot()
    f.releasePeer()
    await tick()
    await assert.rejects(f.pending)
    await f.client.dispose(1000)
    assert.equal(f.counts().peerClosed, 1)
    assert.equal(
      f.sent.some((v) => v.t === 'rtc.offer'),
      false,
    )
  } finally {
    await f.cleanup()
  }
})

test('server binding operator and assignment mismatch never resolves trusted peer promise', async () => {
  for (const field of [
    'assignment_id',
    'key_id',
    'account_id',
    'credential_jti',
    'connector_nonce',
  ] as const) {
    const f = await fixture()
    try {
      await f.inbox()
      await f.notice()
      await f.contextProof()
      await f.rtcReady()
      await f.answer()
      const b = await f.makeBinding()
      await f.push({
        v: 1,
        t: 'pause.binding',
        binding: {
          ...b.value,
          [field]:
            field === 'account_id'
              ? 'foreign-account'
              : field === 'connector_nonce'
                ? digest()
                : randomUUID(),
        },
      })
      await assert.rejects(f.pending)
      assert.equal(f.binding(), undefined)
    } finally {
      await f.cleanup()
    }
  }
})

test('proofs-ready reentrant close prevents publication and resolves disposal once', async () => {
  const f = await fixture({
    onProofsReady() {
      f.client.close('callback-close')
    },
  })
  try {
    await f.inbox()
    await f.notice()
    await f.contextProof()
    await f.rtcReady()
    await f.answer()
    const b = await f.makeBinding()
    await f.push({ v: 1, t: 'pause.binding', binding: b.value })
    f.input()?.onProofsReady?.(b.ready)
    await assert.rejects(f.pending)
    assert.equal(
      f.client.sendPhase({
        t: 'control.admission-nonce',
        admission_nonce: digest(),
        issued_at: Date.now(),
        expires_at: Date.now() + 1000,
      }),
      false,
    )
    await f.client.dispose(1000)
    assert.deepEqual(f.counts(), {
      socketClosed: 1,
      peerClosed: 1,
      inboxReady: 1,
      terminal: 1,
    })
  } finally {
    await f.cleanup()
  }
})

test('pause socket preserves strict TLS/noOrigin/addon guards and distinct route/subprotocol', async () => {
  const before = [
    process.env.WS_NO_BUFFER_UTIL,
    process.env.WS_NO_UTF_8_VALIDATE,
  ]
  let loads = 0
  try {
    delete process.env.WS_NO_BUFFER_UTIL
    delete process.env.WS_NO_UTF_8_VALIDATE
    await assert.rejects(
      pauseConnectorSocket(
        'wss://farm.example/api/signalling/pause-connector',
        async () => {
          loads++
          throw Error('must not load')
        },
      ),
    )
    assert.equal(loads, 0)
    process.env.WS_NO_BUFFER_UTIL = '1'
    process.env.WS_NO_UTF_8_VALIDATE = '1'
    type Module = Awaited<
      ReturnType<NonNullable<Parameters<typeof pauseConnectorSocket>[1]>>
    >
    let config: ConstructorParameters<Module['WebSocket']>[2] | undefined
    let protocol: string | undefined, instance: FakeSocket | undefined
    class FakeSocket extends EventEmitter {
      readyState = 1
      protocol = ''
      bufferedAmount = 0
      constructor(
        _url: URL,
        value: string,
        options: NonNullable<typeof config>,
      ) {
        super()
        protocol = value
        this.protocol = value
        config = options
        instance = this
      }
      send(_wire: string, done: (error?: Error) => void) {
        done()
      }
      terminate() {
        this.emit('close')
      }
    }
    const port = await pauseConnectorSocket(
      'wss://farm.example/api/signalling/pause-connector',
      async () => ({ WebSocket: FakeSocket }),
    )
    assert.equal(protocol, 'open3dfarm.pause-signalling.v1')
    assert.ok(config)
    assert.equal(config.rejectUnauthorized, true)
    assert.equal('origin' in config, false)
    assert.equal(config.maxPayload, 12288)
    assert.equal(config.autoPong, false)
    assert.equal(config.followRedirects, false)
    assert.equal(config.perMessageDeflate, false)
    let opened = 0,
      errors = 0
    port.bind({
      open() {
        opened++
      },
      message() {},
      close() {},
      error() {
        errors++
      },
    })
    instance?.emit('open')
    assert.equal(opened, 1)
    if (instance) instance.protocol = 'open3dfarm.signalling.v1'
    instance?.emit('open')
    assert.equal(errors, 1)
    port.close()
    await port.waitClosed?.()
    await assert.rejects(
      pauseConnectorSocket(
        'wss://farm.example/api/signalling/connector',
        async () => ({ WebSocket: FakeSocket }),
      ),
    )
    const readonly = await connectorSocket(
      'wss://farm.example/api/signalling/connector',
      async () => ({ WebSocket: FakeSocket }),
    )
    assert.equal(protocol, 'open3dfarm.signalling.v1')
    readonly.close()
  } finally {
    for (const [index, key] of [
      'WS_NO_BUFFER_UTIL',
      'WS_NO_UTF_8_VALIDATE',
    ].entries()) {
      const value = before[index]
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
})

test('credential and pause audiences cannot substitute for one another', async () => {
  const credential = await fixture()
  try {
    await credential.push({
      v: 1,
      t: 'pause.connector-inbox-challenge',
      challenge: {
        ...credential.challenge,
        audience: credential.scope.audience,
      },
    })
    await assert.rejects(credential.pending)
    assert.equal(credential.sent.length, 1)
  } finally {
    await credential.cleanup()
  }
  const binding = await fixture()
  try {
    await binding.inbox()
    await binding.notice()
    await binding.contextProof()
    await binding.rtcReady()
    await binding.answer()
    const value = await binding.makeBinding()
    await binding.push({
      v: 1,
      t: 'pause.binding',
      binding: { ...value.value, audience: binding.scope.credentialAudience },
    })
    await assert.rejects(binding.pending)
    assert.equal(binding.binding(), undefined)
  } finally {
    await binding.cleanup()
  }
})
