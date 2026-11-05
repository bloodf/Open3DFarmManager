import test from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes, randomUUID, generateKeyPairSync } from 'node:crypto'
import { createAuthenticatedFarmStatusFeed } from '../../apps/farm/app/utils/webrtc/farm-status-feed.ts'
import { validateBrowserDevicePublicKey } from '../../packages/farm-protocol/src/browser-device-proof.ts'
import { ConnectorIdentity } from '../../packages/connector/src/identity/store.ts'

type Options = Parameters<typeof createAuthenticatedFarmStatusFeed>[0]
async function fixture(asyncAt?: 'authenticated' | 'snapshot') {
  const keyPair = await crypto.subtle.generateKey(
    { name: 'ECDSA', namedCurve: 'P-256' },
    false,
    ['sign', 'verify'],
  )
  const jwk = await crypto.subtle.exportKey('jwk', keyPair.publicKey)
  const key = await validateBrowserDevicePublicKey({
    kty: jwk.kty,
    crv: jwk.crv,
    x: jwk.x,
    y: jwk.y,
  })
  const scope = {
      accountId: 'account_test',
      farmId: randomUUID(),
      viewEpoch: 1,
    },
    agentId = randomUUID(),
    keyId = randomUUID(),
    assignmentId = randomUUID()
  const refs = [
    {
      assignmentId,
      agentId,
      printerKey: 'printer-a',
      status: 'active',
      connectorStatus: 'approved',
    },
  ]
  const connector = new ConnectorIdentity(
      generateKeyPairSync('ed25519').privateKey,
    ),
    nonce = () => randomBytes(32).toString('base64url'),
    now = Date.now()
  const binding = {
    v: 1 as const,
    purpose: 'read-only-rtc' as const,
    transport_id: randomUUID(),
    farm_id: scope.farmId,
    agent_id: agentId,
    account_id: scope.accountId,
    key_id: keyId,
    browser_public_key: key.publicKey,
    browser_thumbprint: key.thumbprint,
    connector_public_key_spki: connector.publicKeySpki,
    connector_fingerprint: connector.fingerprint,
    credential_jti: randomUUID(),
    origin: 'https://farm.example',
    audience: 'farm-test',
    browser_nonce: nonce(),
    connector_nonce: nonce(),
    issued_at: now - 10,
    expires_at: now + 10000,
    commands_enabled: false as const,
    offer_sha256: nonce(),
    answer_sha256: nonce(),
    browser_dtls: Array(32).fill('AA').join(':'),
    connector_dtls: Array(32).fill('BB').join(':'),
  }
  let callbacks:
      | Parameters<NonNullable<Options['createClient']>>[0]
      | undefined,
    closes = 0
  const health: string[] = [],
    snapshots: unknown[] = []
  const feed = createAuthenticatedFarmStatusFeed({
    resolveKey: async (request) => ({
      scope: { ...request.scope },
      keyId,
      origin: binding.origin,
      audience: binding.audience,
      localKey: {
        thumbprint: key.thumbprint,
        publicKey: key.publicKey,
        keyPair,
      },
    }),
    createClient: (input) => {
      callbacks = input
      return {
        start: async () => {},
        close: () => {
          closes++
        },
      }
    },
  })
  const controller = new AbortController()
  const input = {
    scope,
    agentId,
    assignmentRefs: refs,
    browserKeyId: keyId,
    signal: controller.signal,
    onHealth: (value: { kind: string }) => {
      health.push(value.kind)
      if (asyncAt === 'authenticated' && value.kind === 'authenticated')
        return Promise.reject(Error('late failure'))
    },
    onSnapshot: (value: unknown) => {
      snapshots.push(value)
      if (asyncAt === 'snapshot') return Promise.reject(Error('late failure'))
    },
  }
  const handle = feed.open(input)
  for (let i = 0; i < 100 && !callbacks; i++)
    await new Promise((resolve) => setTimeout(resolve, 2))
  assert.ok(callbacks)
  assert.deepEqual(Object.keys(callbacks.assignmentRefs[0]!).sort(), [
    'agentId',
    'assignmentId',
    'printerKey',
  ])
  return {
    scope,
    refs,
    feed,
    input,
    keyId,
    binding,
    callbacks,
    health,
    snapshots,
    handle,
    controller,
    closes: () => closes,
  }
}

test('only verified complete assigned snapshots reach the view', async () => {
  const f = await fixture()
  try {
    assert.deepEqual(f.health, ['connecting', 'verifying'])
    f.callbacks.onVerifiedAdmission({
      binding: f.binding,
      deadlineMonoMs: performance.now() + 5000,
    })
    assert.deepEqual(f.health, ['connecting', 'verifying', 'authenticated'])
    f.callbacks.onStatus({
      t: 'snapshot',
      seq: 0,
      printers: [
        {
          printerKey: 'printer-a',
          state: 'printing',
          progress: 0.5,
          observedAt: Date.now(),
        },
      ],
    })
    assert.equal(f.snapshots.length, 1)
    const snap = f.snapshots[0] as {
      complete: boolean
      sourceClockComparable: boolean
    }
    assert.equal(snap.complete, true)
    assert.equal(snap.sourceClockComparable, false)
    f.callbacks.onStatus({ t: 'snapshot', seq: 1, printers: [] })
    assert.equal(f.health.at(-1), 'closed')
    assert.equal(f.closes(), 1)
    f.callbacks.onStatus({
      t: 'snapshot',
      seq: 2,
      printers: [
        {
          printerKey: 'printer-a',
          state: 'idle',
          progress: 0,
          observedAt: Date.now(),
        },
      ],
    })
    assert.equal(f.snapshots.length, 1)
  } finally {
    f.handle.close()
  }
})

test('late callbacks after abort cannot publish or reopen', async () => {
  const f = await fixture()
  f.controller.abort()
  assert.equal(f.closes(), 1)
  f.callbacks.onVerifiedAdmission({
    binding: f.binding,
    deadlineMonoMs: performance.now() + 5000,
  })
  f.callbacks.onStatus({ t: 'snapshot', seq: 0, printers: [] })
  assert.deepEqual(f.health, ['connecting', 'verifying', 'closed'])
  assert.equal(f.snapshots.length, 0)
  f.handle.close()
  assert.equal(f.closes(), 1)
})

test('new view epoch retires authenticated prior producer before accepting replacement', async () => {
  const f = await fixture()
  try {
    f.callbacks.onVerifiedAdmission({
      binding: f.binding,
      deadlineMonoMs: performance.now() + 5000,
    })
    const replacement = f.feed.open({
      ...f.input,
      scope: { ...f.scope, viewEpoch: 2 },
      assignmentRefs: [{ ...f.refs[0]!, assignmentId: randomUUID() }],
    })
    assert.equal(f.closes(), 1)
    f.callbacks.onStatus({
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
    })
    assert.equal(f.snapshots.length, 0)
    replacement.close()
  } finally {
    f.handle.close()
  }
})

test('replacement retires a pending key lookup and ignores its late result', async () => {
  let release: ((value: never) => void) | undefined
  let firstSignal: AbortSignal | undefined
  let calls = 0,
    clients = 0
  const feed = createAuthenticatedFarmStatusFeed({
    resolveKey: ({ signal }) => {
      calls++
      if (calls === 1) {
        firstSignal = signal
        return new Promise((resolve) => {
          release = resolve
        })
      }
      return new Promise(() => {})
    },
    createClient: () => {
      clients++
      return { start: async () => {}, close: () => {} }
    },
  })
  const scope = {
      accountId: 'account_test',
      farmId: randomUUID(),
      viewEpoch: 1,
    },
    agentId = randomUUID(),
    keyId = randomUUID()
  const controller = new AbortController(),
    events: string[] = []
  const input = {
    scope,
    agentId,
    browserKeyId: keyId,
    assignmentRefs: [{ assignmentId: randomUUID(), agentId, printerKey: 'p' }],
    signal: controller.signal,
    onHealth: (value: { kind: string }) => {
      events.push(value.kind)
    },
    onSnapshot: () => {},
  }
  const first = feed.open(input)
  await new Promise((resolve) => setTimeout(resolve, 0))
  const second = feed.open({
    ...input,
    scope: { ...scope, viewEpoch: 2 },
    assignmentRefs: [
      { ...input.assignmentRefs[0]!, assignmentId: randomUUID() },
    ],
  })
  assert.equal(firstSignal?.aborted, true)
  release?.(null as never)
  await new Promise((resolve) => setTimeout(resolve, 0))
  assert.equal(clients, 0)
  assert.equal(events.filter((value) => value === 'closed').length, 1)
  first.close()
  second.close()
})

test('caller scope and assignment mutation cannot alter lookup or generation', async () => {
  const scope = {
      accountId: 'account_test',
      farmId: randomUUID(),
      viewEpoch: 1,
    },
    agentId = randomUUID(),
    keyId = randomUUID()
  const refs = [{ assignmentId: randomUUID(), agentId, printerKey: 'p' }],
    originalFarm = scope.farmId
  let observed: string | undefined
  const feed = createAuthenticatedFarmStatusFeed({
    resolveKey: async (request) => {
      await Promise.resolve()
      observed = request.scope.farmId
      throw Error('stop')
    },
  })
  const handle = feed.open({
    scope,
    agentId,
    browserKeyId: keyId,
    assignmentRefs: refs,
    signal: new AbortController().signal,
    onHealth: () => {},
    onSnapshot: () => {},
  })
  scope.farmId = randomUUID()
  refs[0]!.printerKey = 'other'
  await new Promise((resolve) => setTimeout(resolve, 0))
  assert.equal(observed, originalFarm)
  handle.close()
})

test('admitted monotonic lease closes without further status callbacks', async () => {
  const f = await fixture()
  try {
    f.callbacks.onVerifiedAdmission({
      binding: f.binding,
      deadlineMonoMs: performance.now() + 60,
    })
    await new Promise((resolve) => setTimeout(resolve, 100))
    assert.equal(f.health.at(-1), 'closed')
    assert.equal(f.closes(), 1)
    f.callbacks.onStatus({
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
    })
    assert.equal(f.snapshots.length, 0)
  } finally {
    f.handle.close()
  }
})

test('foreign key, oversized complete frame and malformed callbacks fail closed', async () => {
  for (const mode of ['foreign', 'oversized', 'malformed'] as const) {
    const f = await fixture()
    try {
      f.callbacks.onVerifiedAdmission({
        binding: f.binding,
        deadlineMonoMs: performance.now() + 5000,
      })
      if (mode === 'malformed') f.callbacks.onStatus(() => {})
      else if (mode === 'foreign')
        f.callbacks.onStatus({
          t: 'snapshot',
          seq: 0,
          printers: [
            {
              printerKey: 'other',
              state: 'idle',
              progress: 0,
              observedAt: Date.now(),
            },
          ],
        })
      else
        f.callbacks.onStatus({
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
          extra: 'x'.repeat(3000),
        })
      assert.equal(f.health.at(-1), 'closed')
      assert.equal(f.snapshots.length, 0)
      assert.equal(f.closes(), 1)
    } finally {
      f.handle.close()
    }
  }
})

test('an asynchronous view callback fails closed before key lookup', async () => {
  let lookups = 0,
    closes = 0
  const feed = createAuthenticatedFarmStatusFeed({
    resolveKey: async () => {
      lookups++
      throw Error('unexpected')
    },
  })
  const agentId = randomUUID()
  const handle = feed.open({
    scope: { accountId: 'account_test', farmId: randomUUID(), viewEpoch: 1 },
    agentId,
    browserKeyId: randomUUID(),
    assignmentRefs: [{ assignmentId: randomUUID(), agentId, printerKey: 'p' }],
    signal: new AbortController().signal,
    onHealth: async (value) => {
      if (value.kind === 'closed') closes++
    },
    onSnapshot: () => {},
  })
  await new Promise((resolve) => setTimeout(resolve, 0))
  assert.equal(lookups, 0)
  assert.equal(closes, 1)
  handle.close()
})

test('asynchronous authenticated health and snapshot callbacks fail closed', async () => {
  for (const mode of ['authenticated', 'snapshot'] as const) {
    const f = await fixture(mode)
    try {
      f.callbacks.onVerifiedAdmission({
        binding: f.binding,
        deadlineMonoMs: performance.now() + 5000,
      })
      if (mode === 'snapshot')
        f.callbacks.onStatus({
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
        })
      await new Promise((resolve) => setTimeout(resolve, 0))
      assert.equal(f.health.at(-1), 'closed')
      assert.equal(f.closes(), 1)
      const count = f.snapshots.length
      f.callbacks.onStatus({ t: 'snapshot', seq: 1, printers: [] })
      assert.equal(f.snapshots.length, count)
    } finally {
      f.handle.close()
    }
  }
})
