import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { generateKeyPairSync } from 'node:crypto'
import { parseSignallingRuntimeConfig } from '../../apps/farm/server/services/signalling-runtime-config.ts'
import {
  createSignallingRuntimeLifecycle,
  signallingRuntime,
  signallingMetadata,
} from '../../apps/farm/server/services/signalling-runtime-bootstrap.ts'
import {
  SESSION_COOKIE_ATTRIBUTES,
  SESSION_COOKIE_NAME,
} from '../../apps/farm/server/utils/auth/boundary.ts'
const config = {
  enabled: true,
  origin: 'https://farm.example',
  issuer: 'independent-signalling-fixture',
  audience: 'fixture',
  readerDatabaseUrl: 'postgres://reader:synthetic@127.0.0.1:9/fixture',
  proofDatabaseUrl: 'postgres://proof:synthetic@127.0.0.1:9/fixture',
  publicKeyRegistryPath: '/synthetic/signalling-public-keys.json',
  tokenTtlSeconds: 60,
  proofTtlMs: 8000,
}
const cookie = {
  name: SESSION_COOKIE_NAME,
  password: 'synthetic-signalling-bootstrap-secret-123456789',
  cookie: { ...SESSION_COOKIE_ATTRIBUTES },
}
test('disabled needs no secrets; invalid enabled configuration fails synchronously', () => {
  assert.deepEqual(signallingMetadata(), {
    enabled: false,
    origin: null,
    audience: null,
  })
  assert.equal(parseSignallingRuntimeConfig(undefined), null)
  assert.equal(parseSignallingRuntimeConfig({ enabled: false }), null)
  assert.ok(parseSignallingRuntimeConfig(config))
  for (const change of [
    { enabled: 'true' },
    { origin: 'http://farm.example' },
    { proofTtlMs: 8001 },
    { readerDatabaseUrl: '' },
    { proofDatabaseUrl: 'postgres://proof:synthetic@127.0.0.1:9/other' },
    { proofDatabaseUrl: 'postgres://proof:synthetic@127.0.0.1:10/fixture' },
    { publicKeyRegistryPath: 'relative.json' },
    { tokenTtlSeconds: 0 },
    { telemetry: true },
  ])
    assert.throws(() => parseSignallingRuntimeConfig({ ...config, ...change }))
})
test('shutdown during public-key validation never publishes a runtime', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'o3dfm-signalling-bootstrap-'))
  const lifecycle = createSignallingRuntimeLifecycle()
  try {
    const file = join(directory, 'public-keys.json')
    const { publicKey } = generateKeyPairSync('ed25519')
    await writeFile(
      file,
      JSON.stringify({
        fixture: publicKey.export({ type: 'spki', format: 'pem' }),
      }),
      { flag: 'wx' },
    )
    const parsed = parseSignallingRuntimeConfig({
      ...config,
      publicKeyRegistryPath: file,
    })
    assert.ok(parsed)
    const pending = lifecycle.start(parsed, cookie)
    assert.equal(signallingRuntime(), undefined)
    assert.deepEqual(signallingMetadata(), {
      enabled: false,
      origin: null,
      audience: null,
    })
    const rejected = assert.rejects(
      pending,
      /^Error: Signalling startup unavailable$/,
    )
    await lifecycle.close()
    await rejected
    assert.equal(signallingRuntime(), undefined)
    assert.deepEqual(signallingMetadata(), {
      enabled: false,
      origin: null,
      audience: null,
    })
    await lifecycle.close()
  } finally {
    await lifecycle.close()
    await rm(directory, { recursive: true })
  }
})
test('failed key validation stays unavailable and shutdown drains its rejected promise', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'o3dfm-signalling-bootstrap-'))
  const lifecycle = createSignallingRuntimeLifecycle()
  try {
    const parsed = parseSignallingRuntimeConfig({
      ...config,
      publicKeyRegistryPath: join(directory, 'absent.json'),
    })
    assert.ok(parsed)
    await assert.rejects(
      lifecycle.start(parsed, cookie),
      /^Error: Signalling startup unavailable$/,
    )
    assert.equal(signallingRuntime(), undefined)
    assert.deepEqual(signallingMetadata(), {
      enabled: false,
      origin: null,
      audience: null,
    })
    await lifecycle.close()
    assert.throws(() => lifecycle.start(parsed, cookie))
  } finally {
    await lifecycle.close()
    await rm(directory, { recursive: true })
  }
})
