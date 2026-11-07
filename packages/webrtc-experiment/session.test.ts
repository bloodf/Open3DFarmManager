import { expect, test } from 'vitest'
import {
  SyntheticSession,
  transcript,
  randomNonce,
  encodeHex,
} from '../connector/src/webrtc/synthetic-session.ts'
async function fixture() {
  const browser = await crypto.subtle.generateKey('Ed25519', false, [
    'sign',
    'verify',
  ])
  const connector = await crypto.subtle.generateKey('Ed25519', false, [
    'sign',
    'verify',
  ])
  const scope = {
    session: randomNonce(),
    browserNonce: randomNonce(),
    connectorNonce: randomNonce(),
    browserSpki: encodeHex(
      await crypto.subtle.exportKey('spki', browser.publicKey),
    ),
    connectorSpki: encodeHex(
      await crypto.subtle.exportKey('spki', connector.publicKey),
    ),
  }
  const sdp = 'a=fingerprint:sha-256 ' + 'AB:'.repeat(31) + 'AB\r\n'
  const binding = transcript(scope, 'browser', sdp, sdp)
  let proof = ''
  const sender = new SyntheticSession({
    role: 'browser',
    binding,
    privateKey: browser.privateKey,
    remotePublicKey: connector.publicKey,
    send: (value) => {
      proof = value
    },
  })
  await sender.start()
  const receiver = (newBinding = binding) =>
    new SyntheticSession({
      role: 'connector',
      binding: newBinding,
      privateKey: connector.privateKey,
      remotePublicKey: browser.publicKey,
      send: () => {},
      deadlineMs: 100,
    })
  return { sender, receiver, proof, scope, sdp, connector, browser, binding }
}
test('portable synthetic boundary rejects data before proof, extra proof and oversized frames', async () => {
  const f = await fixture()
  const early = f.receiver(),
    extra = f.receiver(),
    oversized = f.receiver()
  try {
    await early.receive(
      JSON.stringify({ kind: 'synthetic-status', value: 'fixture-idle' }),
    )
    expect(early.snapshot()).toMatchObject({
      state: { kind: 'readonly' },
      accepted: [],
    })
    await extra.receive(f.proof)
    expect(extra.snapshot()).toMatchObject({ state: { kind: 'verified' } })
    await extra.receive(f.proof)
    expect(extra.snapshot()).toMatchObject({
      state: { kind: 'readonly' },
      accepted: [],
    })
    await oversized.receive('x'.repeat(2049))
    expect(oversized.snapshot()).toMatchObject({
      state: { kind: 'readonly', reason: 'frame-limit' },
      accepted: [],
    })
  } finally {
    f.sender.dispose()
    early.dispose()
    extra.dispose()
    oversized.dispose()
  }
})
test('fresh scope rejects proof replay under unchanged pinned identities', async () => {
  const f = await fixture()
  const receiver = f.receiver(
    transcript(
      { ...f.scope, session: randomNonce() },
      'connector',
      f.sdp,
      f.sdp,
    ),
  )
  try {
    await receiver.receive(f.proof)
    expect(receiver.snapshot()).toMatchObject({
      state: { kind: 'readonly', reason: 'identity-or-transcript' },
      accepted: [],
    })
  } finally {
    receiver.dispose()
    f.sender.dispose()
  }
})
test('timeout and close stay readonly through late or concurrent crypto completion', async () => {
  const f = await fixture()
  const expired = f.receiver(),
    closed = f.receiver()
  try {
    const verification = closed.receive(f.proof)
    await Promise.resolve()
    closed.readonly('transport-closed')
    await verification
    expect(closed.snapshot()).toMatchObject({
      state: { kind: 'readonly', reason: 'transport-closed' },
      accepted: [],
    })
    await new Promise((resolve) => setTimeout(resolve, 120))
    await expired.receive(f.proof)
    await expired.receive(
      JSON.stringify({ kind: 'synthetic-status', value: 'fixture-idle' }),
    )
    expect(expired.snapshot()).toMatchObject({
      state: { kind: 'readonly', reason: 'deadline' },
      accepted: [],
      rejected: [],
    })
    expect(expired.sendStatus()).toBe(false)
  } finally {
    f.sender.dispose()
    expired.dispose()
    closed.dispose()
  }
})
test('local proof always precedes status when the remote proof arrives before local signing', async () => {
  const f = await fixture()
  const wire: string[] = []
  // Obtain the peer key from the fixture's pinned SPKI, not from its proof.
  const pinned = await crypto.subtle.importKey(
    'spki',
    Uint8Array.from(f.scope.browserSpki.match(/../g) ?? [], (value) =>
      parseInt(value, 16),
    ),
    'Ed25519',
    false,
    ['verify'],
  )
  const receiver = new SyntheticSession({
    role: 'connector',
    binding: transcript(f.scope, 'connector', f.sdp, f.sdp),
    privateKey: f.connector.privateKey,
    remotePublicKey: pinned,
    send: (frame) => wire.push(frame),
  })
  try {
    await receiver.receive(f.proof)
    expect(receiver.snapshot()).toMatchObject({ state: { kind: 'verified' } })
    expect(wire).toEqual([])
    await receiver.start()
    expect(wire.map((frame) => JSON.parse(frame).kind)).toEqual([
      'proof',
      'synthetic-status',
    ])
  } finally {
    receiver.dispose()
    f.sender.dispose()
  }
})

const STATUS = JSON.stringify({
  kind: 'synthetic-status',
  value: 'fixture-idle',
})
async function boundedFixture(waitForTransport = false) {
  const f = await fixture()
  let closes = 0
  const session = new SyntheticSession({
    role: 'connector',
    binding: f.binding,
    privateKey: f.connector.privateKey,
    remotePublicKey: f.browser.publicKey,
    waitForTransport,
    send: () => {},
    onReadonly: () => {
      closes++
    },
  })
  return { ...f, session, closes: () => closes }
}
test('100k pre-certificate callbacks share one batch, cap retained raw payload, then stop all observations', async () => {
  const f = await boundedFixture(true)
  try {
    const raw = 'x'.repeat(2048)
    const batch = f.session.receive(raw)
    let differentPromises = 0
    for (let i = 1; i < 8; i++)
      if (f.session.receive(raw) !== batch) differentPromises++
    expect(f.session.snapshot()).toMatchObject({
      state: { kind: 'pending' },
      work: {
        admitted: 8,
        pending: 8,
        retainedBytes: 32768,
        maxPending: 8,
        maxRetainedBytes: 32768,
      },
    })
    for (let i = 0; i < 100000; i++) void f.session.receive(raw)
    await batch
    expect(differentPromises).toBe(0)
    expect(f.session.snapshot()).toMatchObject({
      state: { kind: 'readonly', reason: 'pending-limit' },
      received: 0,
      rejected: ['pending-limit'],
      work: { admitted: 8, pending: 0, retainedBytes: 0 },
    })
    const stopped = f.session.snapshot()
    const huge = 'é'.repeat(1000000)
    const terminalPromise = f.session.receive(huge)
    for (let i = 0; i < 100000; i++)
      if (f.session.receive(huge) !== terminalPromise) differentPromises++
    expect(differentPromises).toBe(0)
    expect(f.session.snapshot()).toEqual(stopped)
    expect(f.closes()).toBe(1)
  } finally {
    f.session.dispose()
    f.sender.dispose()
  }
})
test('pending bound includes active real crypto and drops queued payload on overload', async () => {
  const f = await boundedFixture()
  try {
    const batch = f.session.receive(f.proof)
    for (let i = 0; i < 7; i++) void f.session.receive(STATUS)
    expect(f.session.snapshot().work.pending).toBe(8)
    void f.session.receive(STATUS)
    const terminal = f.session.snapshot()
    expect(terminal).toMatchObject({
      state: { kind: 'readonly', reason: 'pending-limit' },
      work: { pending: 1, retainedBytes: f.proof.length * 2, maxPending: 8 },
    })
    await batch
    expect(f.session.snapshot()).toMatchObject({
      state: { kind: 'readonly', reason: 'pending-limit' },
      accepted: [],
      received: 1,
      work: { pending: 0, retainedBytes: 0 },
    })
    expect(f.closes()).toBe(1)
  } finally {
    f.session.dispose()
    f.sender.dispose()
  }
})
test('100k sequential authenticated status inputs cap lifetime work and all snapshots', async () => {
  const f = await boundedFixture()
  try {
    await f.session.receive(f.proof)
    expect(f.session.state).toEqual({ kind: 'verified' })
    for (let i = 0; i < 100000; i++) await f.session.receive(STATUS)
    const result = f.session.snapshot()
    expect(result).toMatchObject({
      state: { kind: 'readonly', reason: 'message-budget' },
      acceptedTotal: 1023,
      received: 1024,
      rejected: ['message-budget'],
      work: { admitted: 1024, pending: 0, retainedBytes: 0, maxPending: 1 },
      resources: { authTimer: false, lifetimeTimer: false },
    })
    expect(result.accepted).toEqual(Array(16).fill('fixture-idle'))
    expect(JSON.stringify(result).length).toBeLessThan(2048)
    expect(f.closes()).toBe(1)
  } finally {
    f.session.dispose()
    f.sender.dispose()
  }
})
test('UTF-8 byte and cheap code-unit caps reject before retaining payload', async () => {
  const a = await boundedFixture(true),
    b = await boundedFixture(true)
  try {
    await a.session.receive('é'.repeat(1025))
    await b.session.receive('x'.repeat(1000000))
    for (const f of [a, b])
      expect(f.session.snapshot()).toMatchObject({
        state: { kind: 'readonly', reason: 'frame-limit' },
        work: {
          admitted: 0,
          pending: 0,
          retainedBytes: 0,
          maxRetainedBytes: 0,
        },
      })
  } finally {
    a.session.dispose()
    a.sender.dispose()
    b.session.dispose()
    b.sender.dispose()
  }
})

test('verified session expires by hard fixture lifetime even after auth timer clears', async () => {
  const f = await fixture()
  let closes = 0
  const options = {
    role: 'connector',
    binding: f.binding,
    privateKey: f.connector.privateKey,
    remotePublicKey: f.browser.publicKey,
    send: () => {},
    lifetimeMs: 150,
    onReadonly: () => {
      closes++
    },
  } satisfies ConstructorParameters<typeof SyntheticSession>[0]
  const session = new SyntheticSession(options)
  try {
    await session.receive(f.proof)
    expect(session.snapshot()).toMatchObject({
      state: { kind: 'verified' },
      resources: { authTimer: false, lifetimeTimer: true },
    })
    await new Promise((resolve) => setTimeout(resolve, 180))
    expect(session.snapshot()).toMatchObject({
      state: { kind: 'readonly', reason: 'fixture-lifetime' },
      resources: { authTimer: false, lifetimeTimer: false },
      work: { pending: 0, retainedBytes: 0 },
    })
    expect(closes).toBe(1)
    expect(
      () => new SyntheticSession({ ...options, lifetimeMs: 30001 }),
    ).toThrow('Invalid fixture lifetime')
  } finally {
    session.dispose()
    f.sender.dispose()
  }
})
