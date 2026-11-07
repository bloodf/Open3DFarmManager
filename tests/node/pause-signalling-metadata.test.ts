import test from 'node:test'
import assert from 'node:assert/strict'
import { SignallingRuntime } from '../../apps/farm/server/services/signalling-runtime.ts'
import { pauseSignallingMetadata } from '../../apps/farm/server/services/signalling-runtime-bootstrap.ts'
import {
  DISABLED_SIGNALLING_METADATA,
  signallingMetadataResponse,
} from '../../apps/farm/server/services/signalling-metadata.ts'
import type { PauseNegotiationRuntime } from '../../apps/farm/server/utils/pause-authority/runtime.ts'
import pauseMetadataRoute from '../../apps/farm/server/api/signalling/pause-metadata.get.ts'

const origin = 'https://farm.example'
const identity = { database: 'private-db', address: '127.0.0.1', port: 5432 }
const disabled = DISABLED_SIGNALLING_METADATA

test('public route returns disabled metadata with no-store headers without an owner', async () => {
  const event = { res: { headers: new Headers() } }
  const response = await pauseMetadataRoute(
    event as Parameters<typeof pauseMetadataRoute>[0],
  )
  assert.deepEqual(response, disabled)
  assert.equal(event.res.headers.get('cache-control'), 'no-store')
  assert.equal(event.res.headers.get('pragma'), 'no-cache')
})

test('metadata follows the matching live owner without admission or authority exposure', () => {
  const abort = new AbortController()
  let reads = 0
  const facade: PauseNegotiationRuntime = {
    owner: {},
    signal: abort.signal,
    origin,
    audience: 'pause-audience',
    credentialIssuer: 'private-issuer',
    credentialAudience: 'private-credential-audience',
    databaseIdentity: identity,
    reader: {
      read: async () => {
        reads++
        return null
      },
    },
  }
  let current: PauseNegotiationRuntime | undefined = facade
  const runtime = new SignallingRuntime({
    origin,
    cookie: {
      name: 'fixture',
      password: 'synthetic-fixture-password-123456789',
    },
    reader: {
      read: async () => {
        reads++
        return null
      },
      readConnectorCurrent: async () => {
        reads++
        return null
      },
    },
    credentials: {
      issue: async () => {
        reads++
        return { ok: false, reason: 'denied' }
      },
      accept: async () => {
        reads++
        return { ok: false, reason: 'denied' }
      },
    },
    pause: {
      current: () => current,
      databaseIdentity: identity,
      credentialIssuer: 'private-issuer',
      credentialAudience: 'private-credential-audience',
    },
  })
  try {
    const expected = { enabled: true, origin, audience: 'pause-audience' }
    assert.deepEqual(runtime.pauseMetadata(), expected)
    for (const change of [
      { origin: 'https://other.example' },
      { credentialIssuer: 'other' },
      { credentialAudience: 'other' },
      { databaseIdentity: { ...identity, database: 'other' } },
      { databaseIdentity: { ...identity, address: 'other' } },
      { databaseIdentity: { ...identity, port: 5433 } },
    ]) {
      current = { ...facade, ...change }
      assert.deepEqual(runtime.pauseMetadata(), disabled)
    }
    current = undefined
    assert.deepEqual(runtime.pauseMetadata(), disabled)
    current = { ...facade, owner: {} }
    assert.deepEqual(runtime.pauseMetadata(), expected)
    abort.abort()
    assert.deepEqual(runtime.pauseMetadata(), disabled)
    const replacement = {
      ...facade,
      owner: {},
      signal: new AbortController().signal,
    }
    current = replacement
    assert.deepEqual(runtime.pauseMetadata(), expected)
    const event = { res: { headers: new Headers() } }
    const response = signallingMetadataResponse(event, runtime.pauseMetadata())
    assert.equal(event.res.headers.get('cache-control'), 'no-store')
    assert.equal(event.res.headers.get('pragma'), 'no-cache')
    assert.deepEqual(Object.keys(response).sort(), [
      'audience',
      'enabled',
      'origin',
    ])
    assert.equal(JSON.stringify(response).includes('private'), false)
    assert.equal(reads, 0)
    runtime.close()
    assert.deepEqual(runtime.pauseMetadata(), disabled)
    assert.deepEqual(pauseSignallingMetadata(), disabled)
  } finally {
    runtime.close()
  }
})

test('a replaced owner during metadata lookup fails closed', () => {
  const facade: PauseNegotiationRuntime = {
    owner: {},
    signal: new AbortController().signal,
    origin,
    audience: 'pause',
    credentialIssuer: 'issuer',
    credentialAudience: 'credential',
    databaseIdentity: identity,
    reader: { read: async () => null },
  }
  let calls = 0
  const runtime = new SignallingRuntime({
    origin,
    cookie: {
      name: 'fixture',
      password: 'synthetic-fixture-password-123456789',
    },
    reader: { read: async () => null, readConnectorCurrent: async () => null },
    credentials: {
      issue: async () => ({ ok: false, reason: 'denied' }),
      accept: async () => ({ ok: false, reason: 'denied' }),
    },
    pause: {
      current: () => (++calls === 1 ? facade : { ...facade, owner: {} }),
      databaseIdentity: identity,
      credentialIssuer: 'issuer',
      credentialAudience: 'credential',
    },
  })
  try {
    assert.deepEqual(runtime.pauseMetadata(), disabled)
  } finally {
    runtime.close()
  }
})
