import test from 'node:test'
import assert from 'node:assert/strict'
import { generateKeyPairSync, randomBytes, randomUUID } from 'node:crypto'
import { ConnectorIdentity } from '../../packages/connector/src/identity/store.ts'
import { validateBrowserDevicePublicKey } from '../../packages/farm-protocol/src/browser-device-proof.ts'
import {
  FarmStatusSender,
  type FarmSnapshotProvider,
  type CompleteFarmSnapshot,
} from '../../packages/connector/src/webrtc/farm-status-sender.ts'
import {
  immutableAdmission,
  type VerifiedRtcAdmission,
} from '../../packages/connector/src/webrtc/readonly-session.ts'

async function fixture(onSend?: () => void) {
  const identity = new ConnectorIdentity(
    generateKeyPairSync('ed25519').privateKey,
  )
  const keys = await crypto.subtle.generateKey(
    { name: 'ECDSA', namedCurve: 'P-256' },
    false,
    ['sign', 'verify'],
  )
  const jwk = await crypto.subtle.exportKey('jwk', keys.publicKey)
  const key = await validateBrowserDevicePublicKey({
    kty: jwk.kty,
    crv: jwk.crv,
    x: jwk.x,
    y: jwk.y,
  })
  const nonce = () => randomBytes(32).toString('base64url'),
    agent = randomUUID(),
    now = Date.now()
  const binding = {
    v: 1,
    purpose: 'read-only-rtc',
    transport_id: randomUUID(),
    farm_id: randomUUID(),
    agent_id: agent,
    account_id: 'test-account',
    key_id: randomUUID(),
    browser_public_key: key.publicKey,
    browser_thumbprint: key.thumbprint,
    connector_public_key_spki: identity.publicKeySpki,
    connector_fingerprint: identity.fingerprint,
    credential_jti: randomUUID(),
    origin: 'https://farm.example',
    audience: 'farm-test',
    browser_nonce: nonce(),
    connector_nonce: nonce(),
    issued_at: now - 1,
    expires_at: now + 3000,
    commands_enabled: false,
    offer_sha256: nonce(),
    answer_sha256: nonce(),
    browser_dtls: Array(32).fill('AA').join(':'),
    connector_dtls: Array(32).fill('BB').join(':'),
  }
  const admission = immutableAdmission(binding, performance.now() + 2500)
  const refs = [
    { assignmentId: randomUUID(), agentId: agent, printerKey: 'printer-a' },
  ]
  let listener: ((value: VerifiedRtcAdmission) => void) | undefined,
    provider: Parameters<FarmSnapshotProvider>[0] | undefined
  let terminal: ((reason: string) => void) | undefined
  let closed = 0,
    providerClosed = 0,
    unsubscribed = 0
  const sent: unknown[] = []
  const controller = new AbortController()
  const client = {
    start: async () => {},
    subscribeVerifiedAdmission: (
      callback: (value: VerifiedRtcAdmission) => void,
    ) => {
      listener = callback
      return () => {
        unsubscribed++
        listener = undefined
      }
    },
    subscribeTerminal: (listener: (reason: string) => void) => {
      terminal = listener
      return () => {
        terminal = undefined
      }
    },
    sendStatus: (message: unknown) => {
      sent.push(message)
      onSend?.()
      return true
    },
    close: () => {
      closed++
    },
  }
  const sender = new FarmStatusSender({
    client,
    assignmentRefs: refs,
    signal: controller.signal,
    openSnapshots: (input) => {
      provider = input
      return {
        close: () => {
          providerClosed++
        },
      }
    },
  })
  const complete = (overrides: Partial<CompleteFarmSnapshot> = {}) => {
    const captured = performance.now()
    assert.ok(provider)
    provider.onComplete({
      assignmentRefs: refs,
      complete: true,
      printers: [
        {
          printerKey: 'printer-a',
          state: 'printing',
          progress: 0.5,
          observedAt: Date.now(),
        },
      ],
      capturedAtMonoMs: captured,
      validUntilMonoMs: captured + 100,
      ...overrides,
    })
  }
  return {
    sender,
    terminate: () => terminal?.('socket-closed'),
    admission,
    refs,
    sent,
    controller,
    complete,
    admit: () => listener?.(admission),
    provider: () => provider,
    closed: () => closed,
    providerClosed: () => providerClosed,
    unsubscribed: () => unsubscribed,
  }
}

test('sender opens only after admitted context and sends copied complete genuine snapshots', async () => {
  const f = await fixture()
  try {
    await f.sender.start()
    assert.equal(f.provider(), undefined)
    assert.equal(f.sent.length, 0)
    f.admit()
    assert.ok(f.provider())
    assert.equal(f.provider()?.deadlineMonoMs, f.admission.deadlineMonoMs)
    assert.equal(
      Object.isFrozen(f.provider()?.binding.browser_public_key),
      true,
    )
    f.complete()
    assert.deepEqual(f.sent[0], {
      t: 'snapshot',
      seq: 0,
      printers: [
        {
          printerKey: 'printer-a',
          state: 'printing',
          progress: 0.5,
          observedAt: (f.sent[0] as { printers: Array<{ observedAt: number }> })
            .printers[0]!.observedAt,
        },
      ],
    })
    assert.equal(Object.isFrozen(f.sent[0]), true)
    f.complete()
    assert.equal((f.sent[1] as { seq: number }).seq, 1)
    f.controller.abort()
    f.complete()
    assert.equal(f.sent.length, 2)
    assert.equal(f.closed(), 1)
    assert.equal(f.providerClosed(), 1)
    assert.equal(f.unsubscribed(), 1)
  } finally {
    f.sender.close()
  }
})

test('incomplete, changed authority or invalid source clock evidence terminates without invented status', async () => {
  for (const fault of [
    'partial',
    'assignment',
    'printer',
    'nan',
    'negative',
    'future',
    'expired',
    'beyond-lease',
  ] as const) {
    const f = await fixture()
    try {
      f.admit()
      const now = performance.now()
      const overrides =
        fault === 'partial'
          ? { complete: false }
          : fault === 'assignment'
            ? {
                assignmentRefs: [{ ...f.refs[0]!, assignmentId: randomUUID() }],
              }
            : fault === 'printer'
              ? { printers: [] }
              : fault === 'nan'
                ? { capturedAtMonoMs: NaN }
                : fault === 'negative'
                  ? { capturedAtMonoMs: -1 }
                  : fault === 'future'
                    ? { capturedAtMonoMs: now + 100 }
                    : fault === 'expired'
                      ? { validUntilMonoMs: now - 1 }
                      : { validUntilMonoMs: f.admission.deadlineMonoMs + 1 }
      // Deliberately malformed provider boundary, no type assertion disguises it.
      const provider = f.provider()
      assert.ok(provider)
      Reflect.apply(provider.onComplete, undefined, [
        Object.assign(
          {
            assignmentRefs: f.refs,
            complete: true as const,
            printers: [
              {
                printerKey: 'printer-a',
                state: 'idle' as const,
                progress: 0,
                observedAt: Date.now(),
              },
            ],
            capturedAtMonoMs: now,
            validUntilMonoMs: now + 100,
          },
          overrides,
        ),
      ])
      assert.equal(f.sent.length, 0, fault)
      assert.equal(f.closed(), 1, fault)
      assert.equal(f.providerClosed(), 1, fault)
      f.complete()
      assert.equal(f.sent.length, 0)
    } finally {
      f.sender.close()
    }
  }
})

test('source expiry and unavailable independently close session; later complete cannot revive it', async () => {
  for (const unavailable of [false, true]) {
    const f = await fixture()
    try {
      f.admit()
      f.complete({ validUntilMonoMs: performance.now() + 15 })
      if (unavailable) f.provider()?.onUnavailable()
      else await new Promise((resolve) => setTimeout(resolve, 30))
      assert.equal(f.closed(), 1)
      assert.equal(f.providerClosed(), 1)
      f.complete()
      assert.equal(f.sent.length, 1)
    } finally {
      f.sender.close()
    }
  }
})

test('reentrant owner close during send never rearms publishing or provider timers', async () => {
  let stop = () => {}
  const f = await fixture(() => stop())
  stop = () => f.sender.close('owner-close')
  try {
    f.admit()
    f.complete()
    assert.equal(f.closed(), 1)
    f.complete()
    assert.equal(f.sent.length, 1)
    assert.equal(f.providerClosed(), 1)
  } finally {
    f.sender.close()
  }
})

test('client terminal notification immediately closes idle provider without another snapshot', async () => {
  const f = await fixture()
  try {
    f.admit()
    const provider = f.provider()
    assert.ok(provider)
    f.terminate()
    assert.equal(provider.signal.aborted, true)
    assert.equal(f.providerClosed(), 1)
    assert.equal(f.closed(), 1)
    assert.equal(f.sent.length, 0)
    f.complete()
    assert.equal(f.sent.length, 0)
  } finally {
    f.sender.close()
  }
})

test('source expiry during validation prevents the first send', async () => {
  const f = await fixture()
  f.admit()
  const now = performance.now()
  const original = Object.getOwnPropertyDescriptor(performance, 'now')
  let clock = now
  Object.defineProperty(performance, 'now', {
    configurable: true,
    value: () => clock,
  })
  try {
    f.complete({
      capturedAtMonoMs: now,
      validUntilMonoMs: now + 10,
      printers: [
        {
          printerKey: 'printer-a',
          state: 'printing',
          progress: 0.5,
          get observedAt() {
            clock = now + 11
            return Date.now()
          },
        },
      ],
    })
    assert.equal(f.sent.length, 0)
    assert.equal(f.closed(), 1)
  } finally {
    if (original) Object.defineProperty(performance, 'now', original)
    else Reflect.deleteProperty(performance, 'now')
    f.sender.close()
  }
})
