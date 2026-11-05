import test from 'node:test'
import assert from 'node:assert/strict'
import { generateKeyPairSync, randomBytes, randomUUID } from 'node:crypto'
import { ConnectorIdentity } from '../../packages/connector/src/identity/store.ts'
import { validateBrowserDevicePublicKey } from '../../packages/farm-protocol/src/browser-device-proof.ts'
import {
  RtcSessionBinding,
  signRtcSessionProof,
  decodeRtcProof,
  encodeRtcProof,
} from '../../packages/farm-protocol/src/rtc-session-binding.ts'
import {
  ReadonlyRtcSession,
  READONLY_FIXTURE_STATUS,
} from '../../packages/connector/src/webrtc/readonly-session.ts'

async function fixture() {
  const identity = new ConnectorIdentity(
    generateKeyPairSync('ed25519').privateKey,
  )
  const browser = await crypto.subtle.generateKey(
    { name: 'ECDSA', namedCurve: 'P-256' },
    false,
    ['sign', 'verify'],
  )
  const jwk = await crypto.subtle.exportKey('jwk', browser.publicKey)
  const publicKey = await validateBrowserDevicePublicKey({
    kty: jwk.kty,
    crv: jwk.crv,
    x: jwk.x,
    y: jwk.y,
  })
  const nonce = () => randomBytes(32).toString('base64url')
  const issued = Date.now() - 100
  const binding = RtcSessionBinding.parse({
    v: 1,
    purpose: 'read-only-rtc',
    transport_id: randomUUID(),
    farm_id: randomUUID(),
    agent_id: randomUUID(),
    account_id: 'synthetic_account',
    key_id: randomUUID(),
    browser_public_key: publicKey.publicKey,
    browser_thumbprint: publicKey.thumbprint,
    connector_public_key_spki: identity.publicKeySpki,
    connector_fingerprint: identity.fingerprint,
    credential_jti: randomUUID(),
    origin: 'https://farm.example',
    audience: 'open3dfarmmanager:connector',
    browser_nonce: nonce(),
    connector_nonce: nonce(),
    issued_at: issued,
    expires_at: issued + 30000,
    commands_enabled: false,
    offer_sha256: nonce(),
    answer_sha256: nonce(),
    browser_dtls: Array(32).fill('AA').join(':'),
    connector_dtls: Array(32).fill('BB').join(':'),
  })
  const browserProof = async (value = binding) => ({
    v: 1 as const,
    role: 'browser' as const,
    binding: value,
    signature: await signRtcSessionProof(value, 'browser', browser.privateKey),
  })
  const connectorProof = () =>
    identity.signRtcSessionProof({ binding, expectedAgentId: binding.agent_id })
  const sent: string[] = []
  const make = (
    overrides: Partial<
      ConstructorParameters<typeof ReadonlyRtcSession>[0]
    > = {},
  ) =>
    new ReadonlyRtcSession({
      binding,
      role: 'connector',
      authDeadline: performance.now() + 3000,
      lifetimeDeadline: performance.now() + 5000,
      signProof: connectorProof,
      sendProof: (wire) => sent.push(wire),
      sendApplication: (wire) => sent.push(wire),
      onVerified: () => {},
      onReadonly: () => {},
      ...overrides,
    })
  const decode = (proof: unknown) => decodeRtcProof(encodeRtcProof(proof))
  return { binding, browserProof, connectorProof, decode, make, sent }
}

test('real role proofs authorize only the fixture status and commands stay disabled', async () => {
  const f = await fixture()
  const session = f.make()
  try {
    await session.start()
    await session.inspectProof(f.decode(await f.browserProof()))
    assert.equal(session.snapshot().state, 'verified')
    assert.equal(session.sendStatus(), true)
    session.receiveApplication(READONLY_FIXTURE_STATUS)
    assert.deepEqual(session.snapshot().accepted, ['fixture-idle'])
    assert.equal(session.snapshot().commands_enabled, false)
    session.receiveApplication('{"kind":"command"}')
    assert.equal(session.snapshot().state, 'readonly')
  } finally {
    session.close()
  }
})

test('application before authentication and foreign role, context or replay proofs fail closed', async () => {
  const f = await fixture()
  const before = f.make()
  before.receiveApplication(READONLY_FIXTURE_STATUS)
  assert.equal(before.snapshot().state, 'readonly')
  before.close()
  for (const proof of [
    f.connectorProof(),
    await f.browserProof({ ...f.binding, transport_id: randomUUID() }),
  ]) {
    const session = f.make()
    try {
      await session.inspectProof(f.decode(proof))
      assert.equal(session.snapshot().state, 'readonly')
      assert.deepEqual(session.snapshot().accepted, [])
    } finally {
      session.close()
    }
  }
  const replay = f.make()
  try {
    const proof = f.decode(await f.browserProof())
    await replay.start()
    await replay.inspectProof(proof)
    assert.equal(replay.snapshot().state, 'verified')
    await replay.inspectProof(proof)
    assert.equal(replay.snapshot().state, 'readonly')
  } finally {
    replay.close()
  }
})

test('close or expired deadline during signing cannot revive session or emit proof', async () => {
  const f = await fixture()
  for (const mode of ['close', 'deadline'] as const) {
    let release: ((value: unknown) => void) | undefined
    const session = f.make({
      authDeadline: performance.now() + (mode === 'deadline' ? 30 : 3000),
      signProof: () =>
        new Promise((resolve) => {
          release = resolve
        }),
    })
    try {
      const start = session.start()
      if (mode === 'close') session.close()
      else await new Promise((resolve) => setTimeout(resolve, 60))
      release?.(f.connectorProof())
      await start
      assert.equal(session.snapshot().state, 'readonly')
      assert.equal(session.snapshot().localProof, false)
      assert.equal(session.sendStatus(), false)
      assert.deepEqual(f.sent, [])
    } finally {
      session.close()
    }
  }
})

test('remote proof cannot admit application while local signing is pending', async () => {
  const f = await fixture()
  let release: ((proof: unknown) => void) | undefined
  let verified = 0
  const session = f.make({
    signProof: () =>
      new Promise((resolve) => {
        release = resolve
      }),
    onVerified: () => {
      verified++
    },
  })
  try {
    const signing = session.start()
    await session.inspectProof(f.decode(await f.browserProof()))
    assert.equal(session.snapshot().state, 'pending')
    assert.equal(verified, 0)
    session.receiveApplication(READONLY_FIXTURE_STATUS)
    assert.equal(session.snapshot().state, 'readonly')
    assert.deepEqual(session.snapshot().accepted, [])
    release?.(f.connectorProof())
    await signing
    assert.equal(session.snapshot().state, 'readonly')
    assert.equal(session.snapshot().localProof, false)
    assert.equal(verified, 0)
    assert.deepEqual(f.sent, [])
  } finally {
    session.close()
  }
})

test('owner closing reentrantly on verification leaves no session deadline armed', async () => {
  const f = await fixture()
  const schedule = globalThis.setTimeout
  const cancel = globalThis.clearTimeout
  const active = new Set<unknown>()
  globalThis.setTimeout = ((...args: Parameters<typeof setTimeout>) => {
    const handle = schedule(...args)
    active.add(handle)
    return handle
  }) as typeof setTimeout
  globalThis.clearTimeout = (handle) => {
    active.delete(handle)
    Reflect.apply(cancel, globalThis, [handle])
  }
  let notifications = 0
  const session = f.make({
    onVerified: () => session.close('owner-deadline'),
    onReadonly: () => {
      notifications++
    },
  })
  try {
    await session.start()
    await session.inspectProof(f.decode(await f.browserProof()))
    assert.equal(session.snapshot().state, 'readonly')
    assert.equal(session.sendStatus(), false)
    assert.equal(notifications, 1)
    assert.equal(active.size, 0)
  } finally {
    session.close()
    for (const handle of active) Reflect.apply(cancel, globalThis, [handle])
    globalThis.setTimeout = schedule
    globalThis.clearTimeout = cancel
  }
})

test('genuine status mode requires real mutual proofs, complete assignment keys and increasing sequence', async () => {
  const f = await fixture()
  const refs = [
    {
      assignmentId: randomUUID(),
      agentId: f.binding.agent_id,
      printerKey: 'printer-a',
    },
  ]
  const session = f.make({ genuineStatus: { assignmentRefs: refs } })
  refs[0]!.printerKey = 'mutated-caller-ref'
  const message = {
    t: 'snapshot',
    seq: 0,
    printers: [
      {
        printerKey: 'printer-a',
        state: 'idle',
        progress: 0,
        observedAt: Date.now(),
      },
    ],
  }
  try {
    assert.equal(session.sendGenuineStatus(message), false)
    await session.start()
    await session.inspectProof(f.decode(await f.browserProof()))
    assert.equal(session.sendStatus(), false)
    assert.equal(session.sendGenuineStatus(message), true)
    assert.deepEqual(JSON.parse(f.sent.at(-1)!), message)
    assert.equal(session.sendGenuineStatus(message), false)
    assert.equal(session.snapshot().state, 'readonly')
  } finally {
    session.close()
  }
})

test('browser genuine status is immutable, bounded and never translates the fixture literal', async () => {
  const f = await fixture()
  const refs = [
    {
      assignmentId: randomUUID(),
      agentId: f.binding.agent_id,
      printerKey: 'printer-a',
    },
  ]
  let received: unknown
  const session = f.make({
    role: 'browser',
    signProof: f.browserProof,
    genuineStatus: {
      assignmentRefs: refs,
      onStatus: (message) => {
        received = message
      },
    },
  })
  try {
    await session.start()
    await session.inspectProof(f.decode(f.connectorProof()))
    const message = {
      t: 'snapshot',
      seq: 2,
      printers: [
        {
          printerKey: 'printer-a',
          state: 'printing',
          progress: 0.5,
          observedAt: Date.now(),
        },
      ],
    }
    session.receiveApplication(JSON.stringify(message))
    assert.deepEqual(received, message)
    assert.equal(Object.isFrozen(received), true)
    assert.equal(
      Object.isFrozen((received as typeof message).printers[0]),
      true,
    )
    session.receiveApplication(READONLY_FIXTURE_STATUS)
    assert.equal(session.snapshot().state, 'readonly')
    assert.equal(session.snapshot().acceptedTotal, 1)
  } finally {
    session.close()
  }
})

test('genuine status rejects incomplete, foreign or oversized complete snapshots without sending', async () => {
  for (const fault of ['missing', 'foreign', 'oversize'] as const) {
    const f = await fixture()
    const refs = Array.from(
      { length: fault === 'oversize' ? 30 : 1 },
      (_, index) => ({
        assignmentId: randomUUID(),
        agentId: f.binding.agent_id,
        printerKey: 'printer-' + index,
      }),
    )
    const session = f.make({ genuineStatus: { assignmentRefs: refs } })
    try {
      await session.start()
      await session.inspectProof(f.decode(await f.browserProof()))
      const before = f.sent.length
      const printers =
        fault === 'missing'
          ? []
          : refs.map((ref) => ({
              printerKey: fault === 'foreign' ? 'other' : ref.printerKey,
              state: 'idle',
              progress: 0,
              observedAt: Date.now(),
            }))
      assert.equal(
        session.sendGenuineStatus({ t: 'snapshot', seq: 0, printers }),
        false,
      )
      assert.equal(session.snapshot().state, 'readonly')
      assert.equal(f.sent.length, before)
    } finally {
      session.close()
    }
  }
})

test('an async genuine-status consumer is terminal and its rejection is handled', async () => {
  const f = await fixture()
  const session = f.make({
    role: 'browser',
    signProof: f.browserProof,
    genuineStatus: {
      assignmentRefs: [
        {
          assignmentId: randomUUID(),
          agentId: f.binding.agent_id,
          printerKey: 'printer-a',
        },
      ],
      onStatus: async () => {
        throw Error('async consumer forbidden')
      },
    },
  })
  try {
    await session.start()
    await session.inspectProof(f.decode(f.connectorProof()))
    session.receiveApplication(
      JSON.stringify({
        t: 'snapshot',
        seq: 0,
        printers: [
          {
            printerKey: 'printer-a',
            state: 'idle',
            progress: 0,
            observedAt: Date.now(),
          },
        ],
      }),
    )
    assert.equal(session.snapshot().state, 'readonly')
    await new Promise<void>((resolve) => setImmediate(resolve))
    assert.equal(session.snapshot().acceptedTotal, 1)
  } finally {
    session.close()
  }
})

test('genuine send lifetime count stays bounded without retaining a status history', async () => {
  const f = await fixture()
  const session = f.make({ genuineStatus: { assignmentRefs: [] } })
  try {
    await session.start()
    await session.inspectProof(f.decode(await f.browserProof()))
    for (let seq = 0; seq < 1024; seq++)
      assert.equal(
        session.sendGenuineStatus({ t: 'snapshot', seq, printers: [] }),
        true,
      )
    assert.equal(
      session.sendGenuineStatus({ t: 'snapshot', seq: 1024, printers: [] }),
      false,
    )
    assert.equal(session.snapshot().state, 'readonly')
    assert.deepEqual(session.snapshot().accepted, [])
  } finally {
    session.close()
  }
})

test('genuine status reserves sequence before a reentrant transport send', async () => {
  const f = await fixture()
  const emitted: string[] = []
  let nested: boolean | undefined
  const session = f.make({
    genuineStatus: { assignmentRefs: [] },
    sendApplication: (wire) => {
      emitted.push(wire)
      nested = session.sendGenuineStatus({
        t: 'snapshot',
        seq: 0,
        printers: [],
      })
    },
  })
  try {
    await session.start()
    await session.inspectProof(f.decode(await f.browserProof()))
    assert.equal(
      session.sendGenuineStatus({ t: 'snapshot', seq: 0, printers: [] }),
      true,
    )
    assert.equal(nested, false)
    assert.equal(emitted.length, 1)
    assert.equal(
      session.sendGenuineStatus({ t: 'snapshot', seq: 0, printers: [] }),
      false,
    )
    assert.equal(emitted.length, 1)
  } finally {
    session.close()
  }
})

test('one early complete status waits for browser proof verification; overflow and closure discard it', async () => {
  for (const mode of ['verify', 'overflow', 'close'] as const) {
    const f = await fixture()
    const received: unknown[] = []
    const browser = f.make({
      role: 'browser',
      signProof: f.browserProof,
      genuineStatus: {
        assignmentRefs: [],
        onStatus: (message) => {
          received.push(message)
        },
      },
    })
    const connector = f.make({
      genuineStatus: { assignmentRefs: [] },
      sendApplication: (wire) => browser.receiveApplication(wire),
    })
    try {
      await browser.start()
      await connector.start()
      await connector.inspectProof(f.decode(await f.browserProof()))
      assert.equal(
        connector.sendGenuineStatus({ t: 'snapshot', seq: 0, printers: [] }),
        true,
      )
      assert.equal(browser.snapshot().state, 'pending')
      assert.equal(received.length, 0)
      if (mode === 'overflow')
        connector.sendGenuineStatus({ t: 'snapshot', seq: 1, printers: [] })
      if (mode === 'close') browser.close()
      await browser.inspectProof(f.decode(f.connectorProof()))
      assert.equal(received.length, mode === 'verify' ? 1 : 0)
      assert.equal(
        browser.snapshot().state,
        mode === 'verify' ? 'verified' : 'readonly',
      )
    } finally {
      browser.close()
      connector.close()
    }
  }
})

test('verification and consumer reentry preserve queued status order', async () => {
  const f = await fixture()
  const received: number[] = []
  const frame = (seq: number) =>
    JSON.stringify({ t: 'snapshot', seq, printers: [] })
  const session = f.make({
    role: 'browser',
    signProof: f.browserProof,
    genuineStatus: {
      assignmentRefs: [],
      onStatus: (message) => {
        received.push(message.seq)
        if (message.seq === 1) session.receiveApplication(frame(2))
      },
    },
    onVerified: () => {
      session.receiveApplication(frame(1))
    },
  })
  try {
    await session.start()
    session.receiveApplication(frame(0))
    await session.inspectProof(f.decode(f.connectorProof()))
    assert.deepEqual(received, [0, 1, 2])
    assert.equal(session.snapshot().state, 'verified')
  } finally {
    session.close()
  }
})
