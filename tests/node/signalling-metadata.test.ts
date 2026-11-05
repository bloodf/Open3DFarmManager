import test from 'node:test'
import assert from 'node:assert/strict'
import {
  DISABLED_SIGNALLING_METADATA,
  SignallingMetadata,
  validatedSignallingMetadata,
  signallingMetadataResponse,
} from '../../apps/farm/server/services/signalling-metadata.ts'
import {
  signallingMetadata,
  signallingRuntime,
} from '../../apps/farm/server/services/signalling-runtime-bootstrap.ts'
import { SignallingRuntime } from '../../apps/farm/server/services/signalling-runtime.ts'

test('public metadata is exactly the strict three-field union', () => {
  for (const candidate of [
    { enabled: false },
    { enabled: false, origin: 'https://farm.example', audience: null },
    { enabled: true, origin: null, audience: null },
    { enabled: true, origin: 'http://127.0.0.1', audience: 'fixture' },
    { enabled: true, origin: 'https://farm.example/', audience: 'fixture' },
    { enabled: true, origin: 'https://user@farm.example', audience: 'fixture' },
    {
      enabled: true,
      origin: 'https://farm.example',
      audience: 'invalid audience',
    },
    { ...DISABLED_SIGNALLING_METADATA, session: 'not-public' },
  ])
    assert.equal(SignallingMetadata.safeParse(candidate).success, false)
  const input = { origin: 'https://farm.example', audience: 'fixture' }
  const publicFields = validatedSignallingMetadata(input)
  input.origin = 'https://other.example'
  input.audience = 'changed'
  assert.deepEqual(publicFields, {
    enabled: true,
    origin: 'https://farm.example',
    audience: 'fixture',
  })
  assert.equal(Object.isFrozen(publicFields), true)
  assert.equal(Object.isFrozen(DISABLED_SIGNALLING_METADATA), true)
  // Creating public fields is not runtime publication or an authentication result.
  assert.equal(signallingRuntime(), undefined)
  assert.deepEqual(signallingMetadata(), DISABLED_SIGNALLING_METADATA)
})

test('portable metadata responses prohibit caching and contain no additional fields', () => {
  for (const metadata of [
    DISABLED_SIGNALLING_METADATA,
    validatedSignallingMetadata({
      origin: 'https://farm.example:4443',
      audience: 'fixture',
    }),
  ]) {
    const event = {
      res: {
        headers: new Headers({
          'Cache-Control': 'public,max-age=60',
          Pragma: 'cache',
        }),
      },
    }
    const response = signallingMetadataResponse(event, metadata)
    assert.equal(event.res.headers.get('cache-control'), 'no-store')
    assert.equal(event.res.headers.get('pragma'), 'no-cache')
    assert.deepEqual(Object.keys(response).sort(), [
      'audience',
      'enabled',
      'origin',
    ])
    assert.deepEqual(response, metadata)
    assert.equal(Object.isFrozen(response), true)
  }
})

test('actual runtime terminal getter stays latched without constructor or authority changes', () => {
  const runtime = new SignallingRuntime({
    reader: { read: async () => null, readConnectorCurrent: async () => null },
    credentials: {
      issue: async () => ({ ok: false, reason: 'denied' }),
      accept: async () => ({ ok: false, reason: 'denied' }),
    },
    origin: 'https://farm.example',
    cookie: {
      name: 'synthetic',
      password: 'independent-synthetic-secret-123456789',
    },
  })
  try {
    assert.equal(runtime.isClosed, false)
    runtime.close()
    assert.equal(runtime.isClosed, true)
    runtime.close()
    assert.equal(runtime.isClosed, true)
  } finally {
    runtime.close()
  }
})
