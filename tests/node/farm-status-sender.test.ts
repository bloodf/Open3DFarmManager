import { assignmentSetDigest } from '../../packages/farm-protocol/src/rtc-assignment-set.ts'
import test, { afterEach, beforeEach, mock } from 'node:test'
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

// Freeze both clocks the sender trusts; admissions map wall expiry onto the
// monotonic clock, so they must stand still together. The 100 ms source
// windows below then expire only through the sender's own timers or an
// explicit test clock, never because this process was descheduled.
const monotonic = Object.getOwnPropertyDescriptor(performance, 'now')
beforeEach(() => {
  const frozenMonoMs = performance.now()
  Object.defineProperty(performance, 'now', {
    configurable: true,
    value: () => frozenMonoMs,
  })
  mock.timers.enable({ apis: ['Date'], now: Date.now() })
})
afterEach(() => {
  mock.timers.reset()
  if (monotonic) Object.defineProperty(performance, 'now', monotonic)
  else Reflect.deleteProperty(performance, 'now')
})

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
  const refs = [
    { assignmentId: randomUUID(), agentId: agent, printerKey: 'printer-a' },
  ]
  const assignments = await assignmentSetDigest(
    { farmId: binding.farm_id, agentId: agent },
    refs,
  )
  const admission = immutableAdmission(
    {
      ...binding,
      v: 2,
      assignment_count: assignments.count,
      assignment_digest: assignments.digest,
    },
    performance.now() + 2500,
  )
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
    admit: async (input = admission) => {
      listener?.(input)
      // Hang guard in turns of the real event loop; both clocks are frozen.
      for (let turn = 0; !provider && !closed && turn < 5000; turn++)
        await new Promise<void>((resolve) => setTimeout(resolve, 1))
    },
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
    await f.admit()
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
      await f.admit()
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
      await f.admit()
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
    await f.admit()
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
    await f.admit()
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
  await f.admit()
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

test('sender never opens a provider for v1, replaced assignment or changed digest', async () => {
  for (const mode of ['v1', 'replacement', 'digest'] as const) {
    const f = await fixture()
    try {
      const binding = f.admission.binding
      const changed =
        mode === 'v1'
          ? (() => {
              const { assignment_count, assignment_digest, ...v1 } =
                binding.v === 2
                  ? binding
                  : (() => {
                      throw Error('v2 fixture required')
                    })()
              return { ...v1, v: 1 }
            })()
          : {
              ...binding,
              assignment_digest: randomBytes(32).toString('base64url'),
            }
      if (mode === 'replacement') {
        const digest = await assignmentSetDigest(
          { farmId: binding.farm_id, agentId: binding.agent_id },
          f.refs.map((ref) => ({ ...ref, assignmentId: randomUUID() })),
        )
        Object.assign(changed, { assignment_digest: digest.digest })
      }
      await f.admit(immutableAdmission(changed, f.admission.deadlineMonoMs))
      assert.equal(f.provider(), undefined)
      assert.equal(f.closed(), 1)
      assert.deepEqual(f.sent, [])
    } finally {
      f.sender.close()
    }
  }
})

test('terminal owner during digest await never opens a snapshot provider', async () => {
  const f = await fixture()
  const subtle = crypto.subtle
  const descriptor = Object.getOwnPropertyDescriptor(subtle, 'digest')
  const originalDigest = subtle.digest
  let gateActive = true
  let enteredResolve: () => void = () => {}
  const entered = new Promise<void>((resolve) => {
    enteredResolve = resolve
  })
  let releaseGate: () => void = () => {}
  const gate = new Promise<void>((resolve) => {
    releaseGate = resolve
  })
  let settledResolve: () => void = () => {}
  const settled = new Promise<void>((resolve) => {
    settledResolve = resolve
  })

  Object.defineProperty(subtle, 'digest', {
    configurable: true,
    writable: true,
    value: async function (...args: Parameters<typeof originalDigest>) {
      const digestPromise = originalDigest.apply(subtle, args)
      if (gateActive) {
        gateActive = false
        enteredResolve()
        await gate
        const result = await digestPromise
        setImmediate(settledResolve)
        return result
      }
      return digestPromise
    },
  })

  try {
    const admitting = f.admit()
    await entered
    f.terminate()
    releaseGate()
    await settled
    await admitting

    assert.equal(f.provider(), undefined)
    assert.equal(f.providerClosed(), 0)
    assert.equal(f.closed(), 1)
    assert.deepEqual(f.sent, [])
  } finally {
    releaseGate()
    if (descriptor) Object.defineProperty(subtle, 'digest', descriptor)
    else Reflect.deleteProperty(subtle, 'digest')
    f.sender.close()
  }
})

test('sender copies optional finite temperatures without making a command or changing assignment scope', async () => {
  const f = await fixture()
  try {
    await f.sender.start()
    await f.admit()
    const printer: CompleteFarmSnapshot['printers'][number] = {
      printerKey: 'printer-a',
      state: 'idle',
      progress: 0,
      observedAt: 77,
      toolTemperatureCelsius: 0,
      bedTemperatureCelsius: -2.5,
    }
    f.complete({ printers: [printer] })
    assert.deepEqual(f.sent, [
      {
        t: 'snapshot',
        seq: 0,
        printers: [
          {
            printerKey: 'printer-a',
            state: 'idle',
            progress: 0,
            observedAt: 77,
            toolTemperatureCelsius: 0,
            bedTemperatureCelsius: -2.5,
          },
        ],
      },
    ])
    printer.toolTemperatureCelsius = 300
    assert.deepEqual(f.sent, [
      {
        t: 'snapshot',
        seq: 0,
        printers: [
          {
            printerKey: 'printer-a',
            state: 'idle',
            progress: 0,
            observedAt: 77,
            toolTemperatureCelsius: 0,
            bedTemperatureCelsius: -2.5,
          },
        ],
      },
    ])
    f.complete({ printers: [{ ...printer, bedTemperatureCelsius: Infinity }] })
    assert.equal(f.sent.length, 1)
    assert.equal(f.closed(), 1)
  } finally {
    f.sender.close()
  }
})
