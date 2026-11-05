import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { createFarmStatusKeyResolver } from '../../apps/farm/app/utils/webrtc/farm-status-key-resolver.ts'
import { validateBrowserDevicePublicKey } from '../../packages/farm-protocol/src/browser-device-proof.ts'

async function fixture() {
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
    keyId = randomUUID(),
    signal = new AbortController()
  const device = {
    keyId,
    accountId: scope.accountId,
    thumbprint: key.thumbprint,
    status: 'approved' as const,
    proofAt: Date.now(),
    createdAt: Date.now(),
    pendingExpiresAt: null,
  }
  const limits = {
    pendingLifetimeMs: 86400000,
    proofLifetimeMs: 60000,
    maxChallengesPerKey: 3,
  }
  const page = {
    currentAccountId: scope.accountId,
    currentRole: 'owner',
    devices: [device],
    nextAfter: null,
    limits,
  }
  const localKey = { ...key, keyPair }
  const metadata = {
    enabled: true,
    origin: 'https://farm.example',
    audience: 'farm-test',
  }
  const opts = {
    isCurrent: () => true,
    currentOrigin: () => metadata.origin,
    readMetadata: async () => metadata,
    readAccount: async () => ({ accountId: scope.accountId }),
    readRegistryPage: async () => page,
    listKeys: async () => [localKey],
  }
  return { scope, keyId, signal, device, page, metadata, localKey, opts }
}
const run = (
  f: Awaited<ReturnType<typeof fixture>>,
  opts: Parameters<typeof createFarmStatusKeyResolver>[0] = f.opts,
) =>
  createFarmStatusKeyResolver(opts)({
    scope: f.scope,
    browserKeyId: f.keyId,
    signal: f.signal.signal,
  })

test('selects the exact approved local key and rechecks account and metadata', async () => {
  const f = await fixture()
  let accounts = 0,
    metadata = 0
  const result = await run(f, {
    ...f.opts,
    readAccount: async () => {
      accounts++
      return { accountId: f.scope.accountId }
    },
    readMetadata: async () => {
      metadata++
      return f.metadata
    },
  })
  assert.equal(result.keyId, f.keyId)
  assert.equal(result.localKey.thumbprint, f.localKey.thumbprint)
  assert.equal(accounts, 2)
  assert.equal(metadata, 2)
})

test('disabled, foreign origin, changed account or metadata fail closed', async () => {
  const f = await fixture()
  await assert.rejects(
    run(f, {
      ...f.opts,
      readMetadata: async () => ({
        enabled: false,
        origin: null,
        audience: null,
      }),
    }),
  )
  await assert.rejects(
    run(f, { ...f.opts, currentOrigin: () => 'https://other.example' }),
  )
  let n = 0
  await assert.rejects(
    run(f, {
      ...f.opts,
      readAccount: async () => ({
        accountId: ++n === 1 ? f.scope.accountId : 'different',
      }),
    }),
  )
  let m = 0
  await assert.rejects(
    run(f, {
      ...f.opts,
      readMetadata: async () => ({
        ...f.metadata,
        audience: ++m === 1 ? 'farm-test' : 'changed',
      }),
    }),
  )
})

test('pending, revoked, foreign, duplicate and incomplete registry cannot select a key', async () => {
  const f = await fixture()
  for (const status of ['pending', 'revoked'] as const)
    await assert.rejects(
      run(f, {
        ...f.opts,
        readRegistryPage: async () => ({
          ...f.page,
          devices: [{ ...f.device, status }],
        }),
      }),
    )
  await assert.rejects(
    run(f, {
      ...f.opts,
      readRegistryPage: async () => ({
        ...f.page,
        devices: [{ ...f.device, accountId: 'foreign' }],
      }),
    }),
  )
  await assert.rejects(
    run(f, {
      ...f.opts,
      readRegistryPage: async () => ({
        ...f.page,
        devices: [f.device, f.device],
      }),
    }),
  )
  const cursor = randomUUID()
  await assert.rejects(
    run(f, {
      ...f.opts,
      readRegistryPage: async () => ({
        ...f.page,
        devices: [],
        nextAfter: cursor,
      }),
    }),
  )
})

test('rejects wrong local key, multiple matches and stale or aborted scope', async () => {
  const f = await fixture(),
    other = await fixture()
  await assert.rejects(
    run(f, { ...f.opts, listKeys: async () => [other.localKey] }),
  )
  await assert.rejects(
    run(f, { ...f.opts, listKeys: async () => [f.localKey, f.localKey] }),
  )
  let current = true
  await assert.rejects(
    run(f, {
      ...f.opts,
      isCurrent: () => current,
      readAccount: async () => {
        current = false
        return { accountId: f.scope.accountId }
      },
    }),
  )
  f.signal.abort()
  await assert.rejects(run(f))
})

test('snapshots scope before asynchronous readers', async () => {
  const f = await fixture()
  const farm = f.scope.farmId
  let release: () => void = () => {}
  const held = new Promise<void>((resolve) => {
    release = resolve
  })
  const pending = run(f, {
    ...f.opts,
    readMetadata: async () => {
      await held
      return f.metadata
    },
  })
  f.scope.farmId = randomUUID()
  release()
  const result = await pending
  assert.equal(result.scope.farmId, farm)
  assert.notEqual(f.scope.farmId, farm)
})

test('admin page may contain foreign accounts but only own key is selectable', async () => {
  const f = await fixture(),
    foreign = { ...f.device, keyId: randomUUID(), accountId: 'foreign' }
  const opts = {
    ...f.opts,
    readRegistryPage: async () => ({ ...f.page, devices: [foreign, f.device] }),
  }
  const result = await run(f, opts)
  assert.equal(result.keyId, f.keyId)
  await assert.rejects(
    createFarmStatusKeyResolver(opts)({
      scope: f.scope,
      browserKeyId: foreign.keyId,
      signal: f.signal.signal,
    }),
  )
})
