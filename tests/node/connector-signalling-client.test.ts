import {
  immutableAdmission,
  type VerifiedRtcAdmission,
} from '../../packages/connector/src/webrtc/readonly-session.ts'
import test from 'node:test'
import assert from 'node:assert/strict'
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
import {
  AuthenticatedConnectorSignallingClient,
  connectorSocket,
} from '../../packages/connector/src/cloud/authenticated-signalling-client.ts'
import { credentialProofPayload } from '../../packages/farm-protocol/src/credential-proof.ts'
import { validateBrowserDevicePublicKey } from '../../packages/farm-protocol/src/browser-device-proof.ts'
import type { SocketPort } from '../../packages/connector/src/webrtc/signalling-client-channel.ts'

const tick = () => new Promise<void>((resolve) => setImmediate(resolve))
const nonce = () => randomBytes(32).toString('base64url')
const sdp = `v=0\r\na=fingerprint:sha-256 ${Array(32).fill('AA').join(':')}\r\n`
type PeerOptions = Parameters<
  NonNullable<
    NonNullable<
      ConstructorParameters<typeof AuthenticatedConnectorSignallingClient>[1]
    >['peerFactory']
  >
>[0]
async function fixture(
  holdPeer = false,
  onAdmission?: () => void,
  observedClose = false,
  authority: {
    onAuthorityConfirm?: (serverSeq: number) => void
    onAuthorityRevoked?: (serverSeq: number) => void
  } = {},
) {
  const identity = new ConnectorIdentity(
    generateKeyPairSync('ed25519').privateKey,
  )
  const scope = {
    url: 'wss://farm.example/api/signalling/connector',
    origin: 'https://farm.example',
    audience: 'farm-test',
    agentId: randomUUID(),
    farmId: randomUUID(),
    jti: randomUUID(),
    token: 'fixture-token',
    identity,
  }
  const startedAt = performance.now()
  let now = startedAt,
    wall = Date.now(),
    closed = 0,
    peerClosed = 0
  let listening = 0
  let handlers: Parameters<SocketPort['bind']>[0] | undefined
  let input: PeerOptions | undefined, admitted: unknown
  const sent: Array<Record<string, unknown>> = []
  const answers: string[] = []
  let resolveSocketClose: () => void = () => {}
  const socketClosed = new Promise<void>((resolve) => {
    resolveSocketClose = resolve
  })
  const socket: SocketPort = {
    isOpen: () => true,
    bufferedBytes: () => 0,
    send: (wire, done) => {
      sent.push(JSON.parse(wire))
      done()
    },
    bind: (value) => {
      handlers = value
      return () => {}
    },
    close: () => {
      closed++
      if (observedClose) resolveSocketClose()
    },
    ...(observedClose ? { waitClosed: () => socketClosed } : {}),
  }
  let releasePeer = () => {}
  const peerGate = new Promise<void>((resolve) => {
    releasePeer = resolve
  })
  const client = new AuthenticatedConnectorSignallingClient(scope, {
    onInboxReady: () => {
      listening++
    },
    ...(onAdmission ? { onVerifiedAdmission: onAdmission } : {}),
    ...authority,
    clock: { now: () => now, wallNow: () => wall },
    socketFactory: () => socket,
    peerFactory: async (options) => {
      input = options
      void options.admittedBinding.then((value) => {
        admitted = value
      })
      if (holdPeer) await peerGate
      return {
        offer: async () => sdp,
        answer: (value) => {
          answers.push(value)
        },
        close: () => {
          peerClosed++
        },
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
    audience: scope.audience,
    purpose: 'signalling' as const,
    generation: 7,
    nonce: nonce(),
    issued_at: wall - 1,
    expires_at: wall + 5000,
  }
  const context = {
    ...challenge,
    connection_id: randomUUID(),
    generation: 20,
    nonce: nonce(),
  }
  const push = async (value: unknown) => {
    assert.ok(handlers)
    handlers.message(JSON.stringify(value))
    await tick()
  }
  const lease = () => ({
    issued_at: wall - 1,
    expires_at: wall + 4000,
    commands_enabled: false as const,
  })
  const inbox = async () => {
    await push({ v: 1, t: 'connector.inbox-challenge', challenge })
    await push({
      v: 1,
      t: 'connector.inbox-ready',
      inbox_id: challenge.connection_id,
      ...lease(),
    })
    await push({
      v: 1,
      t: 'connector.context-request',
      transport_id: context.connection_id,
      ...lease(),
    })
  }
  return {
    startedAt,
    releasePeer,
    scope,
    client,
    pending,
    sent,
    challenge,
    context,
    push,
    lease,
    inbox,
    answers,
    input: () => input,
    admitted: () => admitted,
    closed: () => closed,
    peerClosed: () => peerClosed,
    listening: () => listening,
    advance: (ms: number) => {
      now += ms
      wall += ms
    },
  }
}

test('inbox readiness is emitted only after the server acknowledgement and grants no RTC admission', async () => {
  const f = await fixture()
  try {
    assert.equal(f.listening(), 0)
    await f.push({
      v: 1,
      t: 'connector.inbox-challenge',
      challenge: f.challenge,
    })
    assert.equal(f.listening(), 0)
    await f.push({
      v: 1,
      t: 'connector.inbox-ready',
      inbox_id: f.challenge.connection_id,
      ...f.lease(),
    })
    assert.equal(f.listening(), 1)
    assert.equal(f.client.snapshot().phase, 'context-request')
    assert.equal(f.admitted(), undefined)
    assert.equal(f.input(), undefined)
  } finally {
    f.client.close()
    await assert.rejects(f.pending)
  }
})

test('fresh TLS-phase challenges pin scope and permit generation gaps; RTC waits for ready and mutual verification', async () => {
  const admissions: VerifiedRtcAdmission[] = []
  const f = await fixture(false, () => {
    f.client.subscribeVerifiedAdmission((admission) => {
      admissions.push(admission)
    })
  })
  let terminal = 0
  f.client.subscribeTerminal(() => {
    terminal++
  })
  try {
    assert.equal(f.sent[0]?.t, 'connector.begin')
    await f.inbox()
    assert.equal(f.sent[1]?.t, 'connector.inbox-proof')
    assert.equal(
      verify(
        null,
        credentialProofPayload(f.challenge),
        createPublicKey({
          key: Buffer.from(f.scope.identity.publicKeySpki, 'base64url'),
          format: 'der',
          type: 'spki',
        }),
        Buffer.from(String(f.sent[1]?.signature), 'base64url'),
      ),
      true,
    )
    assert.equal(f.input(), undefined)
    await f.push({
      v: 1,
      t: 'connector.context-challenge',
      challenge: f.context,
    })
    assert.equal(f.sent[3]?.t, 'connector.context-proof')
    await f.push({
      v: 1,
      t: 'rtc.ready',
      transport_id: f.context.connection_id,
      ...f.lease(),
    })
    assert.equal(f.sent[4]?.t, 'rtc.offer')
    assert.equal(f.input()?.expectedAgentId, f.scope.agentId)
    assert.ok((f.input()?.authDeadline ?? Infinity) <= f.startedAt + 8000)
    await f.push({
      v: 1,
      t: 'rtc.answer',
      transport_id: f.context.connection_id,
      seq: 0,
      p: { sdp },
    })
    assert.deepEqual(f.answers, [sdp])
    const browser = await crypto.subtle.generateKey(
      { name: 'ECDSA', namedCurve: 'P-256' },
      false,
      ['sign', 'verify'],
    )
    const jwk = await crypto.subtle.exportKey('jwk', browser.publicKey)
    const key = await validateBrowserDevicePublicKey({
      kty: jwk.kty,
      crv: jwk.crv,
      x: jwk.x,
      y: jwk.y,
    })
    const binding = {
      v: 1,
      purpose: 'read-only-rtc',
      transport_id: f.context.connection_id,
      farm_id: f.scope.farmId,
      agent_id: f.scope.agentId,
      account_id: 'fixture-account',
      key_id: randomUUID(),
      browser_public_key: key.publicKey,
      browser_thumbprint: key.thumbprint,
      connector_public_key_spki: f.scope.identity.publicKeySpki,
      connector_fingerprint: f.scope.identity.fingerprint,
      credential_jti: f.scope.jti,
      origin: f.scope.origin,
      audience: f.scope.audience,
      browser_nonce: nonce(),
      connector_nonce: f.context.nonce,
      ...f.lease(),
      offer_sha256: nonce(),
      answer_sha256: nonce(),
      browser_dtls: Array(32).fill('BB').join(':'),
      connector_dtls: Array(32).fill('AA').join(':'),
    }
    await f.push({ v: 1, t: 'rtc.binding', binding })
    assert.deepEqual(f.admitted(), binding)
    let complete = false
    void f.pending.then(() => {
      complete = true
    })
    await tick()
    assert.equal(complete, false)
    f.input()?.onVerifiedAdmission?.(
      immutableAdmission(binding, performance.now() + 1000),
    )
    assert.equal(admissions.length, 1)
    assert.equal(
      Object.isFrozen(admissions[0]?.binding.browser_public_key),
      true,
    )
    f.input()?.onVerified?.()
    await f.pending
    assert.equal(f.client.snapshot().authDeadline, undefined)
    f.client.close('socket-1006')
    assert.equal(f.peerClosed(), 1)
    assert.equal(terminal, 1)
  } finally {
    f.client.close()
  }
  assert.equal(f.closed(), 1)
})

test('foreign scope or identity challenges never sign or construct RTC', async () => {
  for (const field of [
    'agent_id',
    'farm_id',
    'jti',
    'origin',
    'audience',
    'purpose',
    'public_key_spki',
    'fingerprint',
    'thumbprint',
    'token_hash',
    'expires_at',
  ] as const) {
    const f = await fixture()
    try {
      const other = new ConnectorIdentity(
        generateKeyPairSync('ed25519').privateKey,
      )
      const changed = {
        ...f.challenge,
        [field]:
          field === 'expires_at'
            ? 0
            : field === 'origin'
              ? 'https://other.example'
              : field === 'purpose'
                ? 'telemetry-ingestion'
                : field === 'public_key_spki'
                  ? other.publicKeySpki
                  : field === 'fingerprint'
                    ? other.fingerprint
                    : field === 'thumbprint' || field === 'token_hash'
                      ? nonce()
                      : field === 'audience'
                        ? 'other'
                        : randomUUID(),
      }
      await f.push({ v: 1, t: 'connector.inbox-challenge', challenge: changed })
      assert.equal(f.client.snapshot().state, 'readonly', field)
      assert.equal(f.sent.length, 1, field)
      assert.equal(f.input(), undefined)
      await assert.rejects(f.pending)
    } finally {
      f.client.close()
    }
  }
})

test('replayed, changed or non-increasing context challenges and retries after proof are terminal', async () => {
  for (const fault of [
    'equal-generation',
    'lower-generation',
    'reused-nonce',
    'wrong-transport',
    'retry-after-proof',
    'duplicate-challenge',
  ] as const) {
    const f = await fixture()
    try {
      if (fault === 'retry-after-proof' || fault === 'duplicate-challenge') {
        await f.push({
          v: 1,
          t: 'connector.inbox-challenge',
          challenge: f.challenge,
        })
        await f.push(
          fault === 'retry-after-proof'
            ? { v: 1, t: 'retry', phase: 'inbox', retry_after_ms: 1 }
            : {
                v: 1,
                t: 'connector.inbox-challenge',
                challenge: { ...f.challenge, nonce: nonce() },
              },
        )
      } else {
        await f.inbox()
        const challenge = {
          ...f.context,
          ...(fault === 'equal-generation'
            ? { generation: 7 }
            : fault === 'lower-generation'
              ? { generation: 6 }
              : fault === 'reused-nonce'
                ? { nonce: f.challenge.nonce }
                : { connection_id: randomUUID() }),
        }
        await f.push({ v: 1, t: 'connector.context-challenge', challenge })
      }
      assert.equal(f.client.snapshot().state, 'readonly', fault)
      assert.equal(f.input(), undefined)
      await assert.rejects(f.pending)
    } finally {
      f.client.close()
    }
  }
})

test('notice and ready cannot extend original client deadlines; close stops late frames', async () => {
  const f = await fixture()
  try {
    f.advance(7500)
    await f.push({ v: 1, t: 'retry', phase: 'inbox', retry_after_ms: 600 })
    assert.equal(f.client.snapshot().state, 'readonly')
    await assert.rejects(f.pending)
    await f.push({
      v: 1,
      t: 'connector.inbox-challenge',
      challenge: f.challenge,
    })
    assert.equal(f.sent.length, 1)
    assert.equal(f.input(), undefined)
    assert.equal(f.closed(), 1)
  } finally {
    f.client.close()
  }
})

test('ws startup flags gate lazy loading and explicit pure-JS bounded socket options', async () => {
  const before = [
    process.env.WS_NO_BUFFER_UTIL,
    process.env.WS_NO_UTF_8_VALIDATE,
  ]
  let loads = 0
  try {
    delete process.env.WS_NO_BUFFER_UTIL
    delete process.env.WS_NO_UTF_8_VALIDATE
    await assert.rejects(
      connectorSocket(
        'wss://farm.example/api/signalling/connector',
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
      ReturnType<NonNullable<Parameters<typeof connectorSocket>[1]>>
    >
    let options: ConstructorParameters<Module['WebSocket']>[2] | undefined
    let instance: FakeSocket | undefined
    class FakeSocket extends EventEmitter {
      readyState = 1
      protocol = 'open3dfarm.signalling.v1'
      bufferedAmount = 0
      terminated = 0
      constructor(
        _url: URL,
        _protocol: string,
        config: NonNullable<typeof options>,
      ) {
        super()
        options = config
        instance = this
      }
      send(_wire: string, done: (error?: Error) => void) {
        done()
      }
      terminate() {
        this.terminated++
      }
    }
    const port = await connectorSocket(
      'wss://farm.example/api/signalling/connector',
      async () => {
        loads++
        return { WebSocket: FakeSocket }
      },
    )
    assert.deepEqual(options, {
      rejectUnauthorized: true,
      maxPayload: 12288,
      perMessageDeflate: false,
      followRedirects: false,
      allowSynchronousEvents: true,
      skipUTF8Validation: false,
      maxFragments: 16,
      maxBufferedChunks: 16,
      autoPong: false,
    })
    let messages = 0,
      errors = 0
    const unbind = port.bind({
      open: () => {},
      message: () => {
        messages++
      },
      error: () => {
        errors++
      },
      close: () => {},
    })
    instance?.emit('message', Buffer.from('ok'), false)
    instance?.emit('message', Buffer.alloc(12289), false)
    instance?.emit('message', Buffer.from('binary'), true)
    assert.equal(messages, 1)
    assert.equal(errors, 2)
    unbind()
    let closeObserved = false
    const closed = port.waitClosed!().then(() => {
      closeObserved = true
    })
    port.close()
    await tick()
    assert.equal(closeObserved, false)
    assert.equal(instance?.terminated, 1)
    instance?.emit('close')
    await closed
    assert.equal(closeObserved, true)
  } finally {
    for (const [index, name] of [
      'WS_NO_BUFFER_UTIL',
      'WS_NO_UTF_8_VALIDATE',
    ].entries()) {
      const value = before[index]
      if (value === undefined) delete process.env[name]
      else process.env[name] = value
    }
  }
})

test('busy retry is pre-challenge only and preserves the same pending start and deadline', async () => {
  const f = await fixture()
  try {
    const deadline = f.client.snapshot().authDeadline
    await f.push({ v: 1, t: 'retry', phase: 'inbox', retry_after_ms: 1 })
    await new Promise((resolve) => setTimeout(resolve, 5))
    assert.equal(f.sent[1]?.t, 'connector.retry')
    assert.equal(f.client.start(), f.pending)
    assert.equal(f.client.snapshot().authDeadline, deadline)
    await f.push({
      v: 1,
      t: 'connector.inbox-challenge',
      challenge: f.challenge,
    })
    assert.equal(f.sent[2]?.t, 'connector.inbox-proof')
    await f.push({ v: 1, t: 'retry', phase: 'inbox', retry_after_ms: 1 })
    assert.equal(f.client.snapshot().state, 'readonly')
    await assert.rejects(f.pending)
  } finally {
    f.client.close()
  }
})

test('a peer created after the original context deadline closes without emitting an offer', async () => {
  const f = await fixture(true)
  try {
    await f.inbox()
    await f.push({
      v: 1,
      t: 'connector.context-challenge',
      challenge: f.context,
    })
    await f.push({
      v: 1,
      t: 'rtc.ready',
      transport_id: f.context.connection_id,
      ...f.lease(),
    })
    assert.ok(f.input())
    f.advance(9000)
    f.releasePeer()
    await tick()
    assert.equal(f.client.snapshot().state, 'readonly')
    assert.equal(f.client.snapshot().reason, 'deadline')
    assert.equal(f.peerClosed(), 1)
    assert.equal(
      f.sent.some((frame) => frame.t === 'rtc.offer'),
      false,
    )
    await assert.rejects(f.pending)
    f.input()?.onVerified?.()
    assert.equal(f.client.snapshot().state, 'readonly')
  } finally {
    f.releasePeer()
    f.client.close()
  }
})

test('client disposal waits for late peer factory and requests peer close once', async () => {
  const f = await fixture(true, undefined, true)
  try {
    await f.inbox()
    await f.push({
      v: 1,
      t: 'connector.context-challenge',
      challenge: f.context,
    })
    await f.push({
      v: 1,
      t: 'rtc.ready',
      transport_id: f.context.connection_id,
      ...f.lease(),
    })
    assert.ok(f.input())
    const disposal = f.client.dispose(1000)
    assert.equal(f.client.dispose(10000), disposal)
    let done = false
    void disposal.then(() => {
      done = true
    })
    await tick()
    assert.equal(done, false)
    f.releasePeer()
    await disposal
    assert.equal(f.peerClosed(), 1)
    assert.equal(f.closed(), 1)
    await assert.rejects(f.pending)
  } finally {
    f.releasePeer()
    f.client.close()
  }
})

test('client disposal rejects when peer factory remains unsettled', async () => {
  const f = await fixture(true, undefined, true)
  try {
    await f.inbox()
    await f.push({
      v: 1,
      t: 'connector.context-challenge',
      challenge: f.context,
    })
    await f.push({
      v: 1,
      t: 'rtc.ready',
      transport_id: f.context.connection_id,
      ...f.lease(),
    })
    const disposal = f.client.dispose(100)
    await assert.rejects(disposal, /timed out/)
    assert.equal(f.client.dispose(10000), disposal)
    f.releasePeer()
    await tick()
    assert.equal(f.peerClosed(), 1)
    await assert.rejects(f.pending)
  } finally {
    f.releasePeer()
    f.client.close()
  }
})

test('authority confirmations are accepted only after inbox admission and only for the exact credential scope', async () => {
  const confirms: number[] = []
  const revocations: number[] = []
  const early = await fixture(false, undefined, false, {
    onAuthorityConfirm: (seq) => {
      confirms.push(seq)
    },
  })
  const confirm = (f: typeof early, overrides: Record<string, unknown> = {}) =>
    f.push({
      v: 1,
      t: 'connector.authority-confirm',
      server_seq: 10,
      farm_id: f.scope.farmId,
      agent_id: f.scope.agentId,
      credential_jti: f.scope.jti,
      ...overrides,
    })
  // Before the credential proof is admitted the frame is terminal.
  await confirm(early)
  await assert.rejects(early.pending)
  assert.equal(confirms.length, 0)

  const f = await fixture(false, undefined, false, {
    onAuthorityConfirm: (seq) => {
      confirms.push(seq)
    },
    onAuthorityRevoked: (seq) => {
      revocations.push(seq)
    },
  })
  void f.pending.catch(() => {})
  await f.inbox()
  await confirm(f, { server_seq: 11 })
  await f.push({ v: 1, t: 'connector.authority-revoked', server_seq: 12 })
  assert.deepEqual(confirms, [11])
  assert.deepEqual(revocations, [12])
  // A confirmation for another credential closes the session unconfirmed.
  await confirm(f, { server_seq: 13, credential_jti: randomUUID() })
  await assert.rejects(f.pending)
  assert.deepEqual(confirms, [11])
})
