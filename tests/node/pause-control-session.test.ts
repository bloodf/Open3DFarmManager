import assert from 'node:assert/strict'
import { generateKeyPairSync, randomBytes, randomUUID } from 'node:crypto'
import { test } from 'node:test'
import { ConnectorIdentity } from '../../packages/connector/src/identity/store.ts'
import {
  PauseControlSession,
  type PauseProofsReady,
} from '../../packages/connector/src/webrtc/pause-control-session.ts'
import {
  ControlSessionBinding,
  encodeControlProof,
} from '../../packages/farm-protocol/src/control-session-binding.ts'
import {
  encodePauseChannelFrame,
  decodePauseChannelFrame,
} from '../../packages/farm-protocol/src/pause-channel.ts'
import { validateBrowserDevicePublicKey } from '../../packages/farm-protocol/src/browser-device-proof.ts'

async function fixture() {
  const keys = await crypto.subtle.generateKey(
    { name: 'ECDSA', namedCurve: 'P-256' },
    false,
    ['sign', 'verify'],
  )
  const jwk = await crypto.subtle.exportKey('jwk', keys.publicKey)
  const browser = await validateBrowserDevicePublicKey({
    kty: jwk.kty,
    crv: jwk.crv,
    x: jwk.x,
    y: jwk.y,
  })
  const identity = new ConnectorIdentity(
      generateKeyPairSync('ed25519').privateKey,
    ),
    now = Date.now()
  const binding = ControlSessionBinding.parse({
    v: 1,
    purpose: 'pause-rtc',
    transport_id: randomUUID(),
    farm_id: randomUUID(),
    agent_id: randomUUID(),
    account_id: 'fixture-account',
    key_id: randomUUID(),
    assignment_id: randomUUID(),
    browser_public_key: browser.publicKey,
    browser_thumbprint: browser.thumbprint,
    connector_public_key_spki: identity.publicKeySpki,
    connector_fingerprint: identity.fingerprint,
    credential_jti: randomUUID(),
    origin: 'https://farm.example',
    audience: 'pause-fixture',
    browser_nonce: randomBytes(32).toString('base64url'),
    connector_nonce: randomBytes(32).toString('base64url'),
    issued_at: now,
    expires_at: now + 30000,
    offer_sha256: randomBytes(32).toString('base64url'),
    answer_sha256: randomBytes(32).toString('base64url'),
    browser_dtls: 'AA:'.repeat(31) + 'AA',
    connector_dtls: 'BB:'.repeat(31) + 'BB',
  })
  const expected = {
    transportId: binding.transport_id,
    farmId: binding.farm_id,
    agentId: binding.agent_id,
    assignmentId: binding.assignment_id,
    accountId: binding.account_id,
    keyId: binding.key_id,
    origin: binding.origin,
    audience: binding.audience,
  }
  return { keys, identity, binding, expected }
}
function deferred<T>() {
  let resolve: (value: T) => void = () => {}
  const promise = new Promise<T>((r) => {
    resolve = r
  })
  return { promise, resolve }
}
async function bounded<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(Error('Test deadline')), 2000)
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
}

test(
  'genuine Ed/P256 control proofs survive asymmetric activation and ready callback nonce publication',
  { timeout: 5000 },
  async () => {
    const f = await fixture(),
      readyBrowser = deferred<PauseProofsReady>(),
      readyConnector = deferred<PauseProofsReady>(),
      nonceReceived = deferred<number>()
    const wires: string[] = []
    let browserReady = false,
      nonceSends = 0
    let browser: PauseControlSession
    const connector = new PauseControlSession({
      role: 'connector',
      identity: f.identity,
      expected: f.expected,
      send: (wire) => {
        wires.push(wire)
        browser.receive(wire)
      },
      onProofsReady: (value) => {
        readyConnector.resolve(value)
        const now = Date.now()
        nonceSends += Number(
          connector.sendPhase({
            t: 'control.admission-nonce',
            admission_nonce: randomBytes(32).toString('base64url'),
            issued_at: now,
            expires_at: now + 5000,
          }),
        )
      },
    })
    browser = new PauseControlSession({
      role: 'browser',
      privateKey: f.keys.privateKey,
      expected: f.expected,
      send: (wire) => {
        wires.push(wire)
        connector.receive(wire)
      },
      onProofsReady: (value) => {
        browserReady = true
        readyBrowser.resolve(value)
      },
      onPhase: (frame) => {
        assert.equal(browserReady, true)
        assert.equal(frame.t, 'control.admission-nonce')
        nonceReceived.resolve(frame.seq)
      },
    })
    try {
      await connector.activate(f.binding)
      assert.equal(browser.diagnostics().pending, 1)
      await browser.activate(f.binding)
      const [a, b, seq] = await bounded(
        Promise.all([
          readyBrowser.promise,
          readyConnector.promise,
          nonceReceived.promise,
        ]),
      )
      assert.equal(seq, 2)
      assert.equal(nonceSends, 1)
      assert.equal(a.browserProofWire, b.browserProofWire)
      assert.equal(a.connectorProofWire, b.connectorProofWire)
      assert.equal(Object.isFrozen(a), true)
      assert.equal(Object.isFrozen(a.binding), true)
      assert.equal(Object.isFrozen(a.binding.browser_public_key), true)
      for (const peer of [browser, connector]) {
        assert.equal(peer.diagnostics().proofsReady, true)
        assert.equal(peer.diagnostics().sentProofs, 1)
        assert.equal(peer.diagnostics().receivedProofs, 1)
        assert.equal(peer.diagnostics().commandsEnabled, false)
      }
      assert.equal(
        wires.filter(
          (wire) => decodePauseChannelFrame(wire).t === 'control.proof',
        ).length,
        2,
      )
      assert.equal(
        browser.sendPhase({
          t: 'control.admission-nonce',
          admission_nonce: randomBytes(32).toString('base64url'),
          issued_at: Date.now(),
          expires_at: Date.now() + 1000,
        }),
        false,
      )
      assert.equal(browser.diagnostics().terminal, true)
    } finally {
      browser.close()
      connector.close()
      await bounded(Promise.all([browser.closed, connector.closed]))
    }
  },
)
test(
  'expected assignment is independent from a genuinely signed replacement binding',
  { timeout: 5000 },
  async () => {
    const f = await fixture()
    let sent = 0
    const peer = new PauseControlSession({
      role: 'connector',
      identity: f.identity,
      expected: f.expected,
      send: () => {
        sent++
      },
    })
    try {
      await peer.activate({ ...f.binding, assignment_id: randomUUID() })
      assert.equal(sent, 0)
      assert.equal(peer.diagnostics().terminal, true)
    } finally {
      peer.close()
      await peer.closed
    }
  },
)
test(
  'incoming valid signature over a different binding cannot bootstrap expected authority',
  { timeout: 5000 },
  async () => {
    const f = await fixture(),
      wrong = { ...f.binding, assignment_id: randomUUID() }
    const proof = await f.identity.signControlSessionProof({
      binding: wrong,
      expectedAgentId: f.expected.agentId,
    })
    const peer = new PauseControlSession({
      role: 'browser',
      privateKey: f.keys.privateKey,
      expected: f.expected,
      send: () => {},
    })
    try {
      peer.receive(
        encodePauseChannelFrame({
          v: 1,
          t: 'control.proof',
          transport_id: f.binding.transport_id,
          seq: 0,
          wire: encodeControlProof(proof),
        }),
      )
      await peer.activate(f.binding)
      await bounded(peer.closed)
      assert.equal(peer.diagnostics().proofsReady, false)
      assert.equal(peer.diagnostics().receivedProofs, 0)
    } finally {
      peer.close()
      await peer.closed
    }
  },
)
test(
  'preverification queue charges all four slots and closes on a fifth frame',
  { timeout: 5000 },
  async () => {
    const f = await fixture(),
      wire = encodePauseChannelFrame({
        v: 1,
        t: 'control.proofs-ready',
        transport_id: f.binding.transport_id,
        seq: 1,
      })
    const peer = new PauseControlSession({
      role: 'browser',
      privateKey: f.keys.privateKey,
      expected: f.expected,
      send: () => {},
    })
    try {
      for (let i = 0; i < 4; i++) peer.receive(wire)
      assert.equal(peer.diagnostics().pending, 4)
      assert.equal(
        peer.diagnostics().retainedBytes,
        Buffer.byteLength(wire) * 4,
      )
      peer.receive(wire)
      await bounded(peer.closed)
      assert.equal(peer.diagnostics().terminal, true)
      assert.equal(peer.diagnostics().retainedBytes, 0)
    } finally {
      peer.close()
      await peer.closed
    }
  },
)
test(
  'proofs-ready before a proof and oversized binary input both fail closed',
  { timeout: 5000 },
  async () => {
    const f = await fixture()
    for (const raw of [
      new Uint8Array(1),
      encodePauseChannelFrame({
        v: 1,
        t: 'control.proofs-ready',
        transport_id: f.binding.transport_id,
        seq: 0,
      }),
    ]) {
      const peer = new PauseControlSession({
        role: 'browser',
        privateKey: f.keys.privateKey,
        expected: f.expected,
        send: () => {},
      })
      try {
        peer.receive(raw)
        await peer.activate(f.binding)
        await bounded(peer.closed)
        assert.equal(peer.diagnostics().proofsReady, false)
      } finally {
        peer.close()
        await peer.closed
      }
    }
  },
)
test(
  'closing during native signing retains outstanding work and suppresses later publication',
  { timeout: 5000 },
  async (context) => {
    const f = await fixture(),
      gate = deferred<void>(),
      entered = deferred<void>()
    const original = crypto.subtle.sign.bind(crypto.subtle)
    context.mock.method(
      crypto.subtle,
      'sign',
      async (...args: Parameters<SubtleCrypto['sign']>) => {
        entered.resolve()
        await gate.promise
        return original(...args)
      },
    )
    let sent = 0,
      terminal = 0
    const peer = new PauseControlSession({
      role: 'browser',
      privateKey: f.keys.privateKey,
      expected: f.expected,
      send: () => {
        sent++
      },
      onTerminal: () => {
        terminal++
      },
    })
    const active = peer.activate(f.binding)
    try {
      await bounded(entered.promise)
      peer.close()
      peer.close()
      let closed = false
      void peer.closed.then(() => {
        closed = true
      })
      await Promise.resolve()
      assert.equal(closed, false)
      gate.resolve()
      await bounded(Promise.all([active, peer.closed]))
      assert.equal(sent, 0)
      assert.equal(terminal, 1)
    } finally {
      gate.resolve()
      peer.close()
      await bounded(Promise.all([active, peer.closed]))
      context.mock.restoreAll()
    }
  },
)
test(
  'verified transport still rejects result frames and does not expose command authority',
  { timeout: 5000 },
  async () => {
    const f = await fixture(),
      readyA = deferred<void>(),
      readyB = deferred<void>()
    let browser: PauseControlSession
    const connector = new PauseControlSession({
      role: 'connector',
      identity: f.identity,
      expected: f.expected,
      send: (wire) => browser.receive(wire),
      onProofsReady: () => readyA.resolve(),
    })
    browser = new PauseControlSession({
      role: 'browser',
      privateKey: f.keys.privateKey,
      expected: f.expected,
      send: (wire) => connector.receive(wire),
      onProofsReady: () => readyB.resolve(),
    })
    try {
      await Promise.all([
        browser.activate(f.binding),
        connector.activate(f.binding),
      ])
      await bounded(Promise.all([readyA.promise, readyB.promise]))
      browser.receive(
        encodePauseChannelFrame({
          v: 1,
          t: 'control.result',
          transport_id: f.binding.transport_id,
          seq: 2,
          command_id: randomUUID(),
          outcome: 'applied',
        }),
      )
      await bounded(browser.closed)
      assert.equal(browser.diagnostics().terminal, true)
      assert.equal(browser.diagnostics().commandsEnabled, false)
    } finally {
      browser.close()
      connector.close()
      await bounded(Promise.all([browser.closed, connector.closed]))
    }
  },
)
test(
  'reentrant close during ready callback prevents phase publication and notifies once',
  { timeout: 5000 },
  async () => {
    const f = await fixture(),
      ready = deferred<void>()
    let terminal = 0,
      sends = 0
    let browser: PauseControlSession
    const connector = new PauseControlSession({
      role: 'connector',
      identity: f.identity,
      expected: f.expected,
      send: (wire) => {
        if (decodePauseChannelFrame(wire).t === 'control.admission-nonce')
          sends++
        browser.receive(wire)
      },
      onProofsReady: () => {
        connector.close()
        const now = Date.now()
        assert.equal(
          connector.sendPhase({
            t: 'control.admission-nonce',
            admission_nonce: randomBytes(32).toString('base64url'),
            issued_at: now,
            expires_at: now + 1000,
          }),
          false,
        )
        ready.resolve()
      },
      onTerminal: () => {
        terminal++
      },
    })
    browser = new PauseControlSession({
      role: 'browser',
      privateKey: f.keys.privateKey,
      expected: f.expected,
      send: (wire) => connector.receive(wire),
    })
    try {
      await Promise.all([
        browser.activate(f.binding),
        connector.activate(f.binding),
      ])
      await bounded(ready.promise)
      await bounded(connector.closed)
      assert.equal(sends, 0)
      assert.equal(terminal, 1)
    } finally {
      browser.close()
      connector.close()
      await bounded(Promise.all([browser.closed, connector.closed]))
    }
  },
)
