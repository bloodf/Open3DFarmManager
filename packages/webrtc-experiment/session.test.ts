import { expect, test } from 'bun:test'
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
  return { sender, receiver, proof, scope, sdp, connector }
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
      rejected: ['readonly', 'readonly'],
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
