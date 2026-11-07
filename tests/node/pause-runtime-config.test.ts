import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readAgentRuntimeConfig } from '../../packages/connector/src/config/runtime.ts'
import {
  loadPauseIssuerKeys,
  parsePauseRuntimeConfig,
  MAX_PAUSE_ISSUER_KEYRING,
} from '../../packages/connector/src/config/pause.ts'
import { readPrinterBinding } from '../../packages/connector/src/control/printer-binding.ts'
import { validateBrowserDevicePublicKey } from '../../packages/farm-protocol/src/browser-device-proof.ts'
import {
  signPauseCapability,
  verifyPauseCapability,
} from '../../packages/farm-protocol/src/pause-capability.ts'

const ORIGIN = 'http://127.0.0.1:7125'
const ISSUER = 'farm:pause-issuer'
const KID = 'issuer-1'
const SIGNALLING = {
  endpoint: 'wss://farm.example/api/signalling/pause-connector',
  origin: 'https://farm.example',
  audience: 'pause-audience',
  credentialAudience: 'credential-audience',
}

function temporaryDirectory() {
  const path = mkdtempSync(join(tmpdir(), 'open3d-pause-config-'))
  return {
    path,
    close() {
      rmSync(path, { recursive: true, force: true })
    },
  }
}

function writeRuntime(directory: string, value: unknown): string {
  const path = join(directory, 'runtime.json')
  writeFileSync(path, JSON.stringify(value), { mode: 0o600 })
  return path
}

function runtimeFixture(options: { pause?: unknown } = {}) {
  const farm = randomUUID()
  const agent = randomUUID()
  const assignment = randomUUID()
  const value = {
    version: 1,
    collection: {
      version: 1,
      allowedOrigins: [ORIGIN],
      printers: [{ printerKey: 'printer-1', origin: ORIGIN + '/' }],
    },
    assignments: [
      {
        assignment_id: assignment,
        farm_id: farm,
        agent_id: agent,
        printer_key: 'printer-1',
        moonraker_origin: ORIGIN,
      },
    ],
    telemetry: {
      endpoint: 'https://telemetry.example/api/connector/telemetry',
      audience: 'connector-audience',
      timeoutMs: 1000,
      retryMinMs: 100,
      retryMaxMs: 100,
      idleMs: 100,
    },
    ...(options.pause === undefined ? {} : { pause: options.pause }),
  }
  return {
    value,
    farm,
    agent,
    assignment,
    credential: { agent_id: agent, farm_id: farm },
  }
}

async function issuerFixture() {
  const pair = (await crypto.subtle.generateKey('Ed25519', true, [
    'sign',
    'verify',
  ])) as CryptoKeyPair
  const spki = Buffer.from(
    await crypto.subtle.exportKey('spki', pair.publicKey),
  ).toString('base64url')
  const pkcs8 = Buffer.from(
    await crypto.subtle.exportKey('pkcs8', pair.privateKey),
  )
  // The signing key is re-imported as nonextractable, exactly like a production
  // issuer key. The test never keeps an extractable private key.
  const signingKey = await crypto.subtle.importKey(
    'pkcs8',
    pkcs8,
    'Ed25519',
    false,
    ['sign'],
  )
  return { pair, spki, pkcs8, signingKey }
}

async function countImports<T>(run: () => Promise<T>): Promise<{
  result: T
  imports: number
}> {
  const subtle = crypto.subtle
  const descriptor = Object.getOwnPropertyDescriptor(subtle, 'importKey')
  const original = subtle.importKey
  let imports = 0
  Object.defineProperty(subtle, 'importKey', {
    configurable: true,
    writable: true,
    value: (...args: Parameters<typeof original>) => {
      imports++
      return original.apply(subtle, args)
    },
  })
  try {
    return { result: await run(), imports }
  } finally {
    if (descriptor) Object.defineProperty(subtle, 'importKey', descriptor)
    else Reflect.deleteProperty(subtle, 'importKey')
  }
}

test('a runtime configuration without a pause section keeps its previous values and carries no authority', async () => {
  const directory = temporaryDirectory()
  try {
    const fixture = runtimeFixture()
    const path = writeRuntime(directory.path, fixture.value)
    const config = readAgentRuntimeConfig(path, fixture.credential)
    assert.equal(config.pause, null)
    assert.equal(config.signalling, undefined)
    assert.equal(config.collection.printers.length, 1)
    assert.equal(config.telemetry.audience, 'connector-audience')
    assert.deepEqual(
      config.assignments.map((assignment) => assignment.assignment_id),
      [fixture.assignment],
    )
    assert.deepEqual(config.assignments[0]?.printer_key, 'printer-1')
    // An absent pause section performs no key import and yields no issuer.
    const counted = await countImports(async () => {
      const issuers = await loadPauseIssuerKeys(config.pause)
      return issuers
    })
    assert.deepEqual(counted.result, [])
    assert.equal(counted.imports, 0)
  } finally {
    directory.close()
  }
})

test('reading a runtime configuration never imports a key, even with a pause section', async () => {
  const directory = temporaryDirectory()
  try {
    const { spki } = await issuerFixture()
    const fixture = runtimeFixture({
      pause: {
        version: 1,
        signalling: { ...SIGNALLING },
        issuers: [{ issuer: ISSUER, kid: KID, publicKeySpki: spki }],
      },
    })
    const path = writeRuntime(directory.path, fixture.value)
    const counted = await countImports(async () =>
      readAgentRuntimeConfig(path, fixture.credential),
    )
    assert.equal(counted.imports, 0)
    assert.notEqual(counted.result.pause, null)
  } finally {
    directory.close()
  }
})

test('the pause section refuses an oversized, duplicated or malformed issuer keyring', async () => {
  const { spki } = await issuerFixture()
  const entry = { issuer: ISSUER, kid: KID, publicKeySpki: spki }
  assert.throws(() =>
    parsePauseRuntimeConfig({
      version: 1,
      signalling: { ...SIGNALLING },
      issuers: Array.from(
        { length: MAX_PAUSE_ISSUER_KEYRING + 1 },
        (_, index) => ({ ...entry, kid: 'issuer-' + index }),
      ),
    }),
  )
  assert.throws(() =>
    parsePauseRuntimeConfig({
      version: 1,
      signalling: { ...SIGNALLING },
      issuers: [entry, entry],
    }),
  )
  // The same issuer with a different key id is a distinct trusted key.
  const distinct = parsePauseRuntimeConfig({
    version: 1,
    signalling: { ...SIGNALLING },
    issuers: [entry, { ...entry, kid: 'issuer-2' }],
  })
  assert.equal(distinct.issuers.length, 2)
  assert.throws(() =>
    parsePauseRuntimeConfig({
      version: 1,
      signalling: { ...SIGNALLING },
      issuers: [],
    }),
  )
  assert.throws(() =>
    parsePauseRuntimeConfig({
      version: 2,
      signalling: { ...SIGNALLING },
      issuers: [entry],
    }),
  )
  assert.throws(() =>
    parsePauseRuntimeConfig({
      version: 1,
      signalling: { ...SIGNALLING },
      issuers: [{ ...entry, issuer: 'not a valid issuer' }],
    }),
  )
  assert.throws(() =>
    parsePauseRuntimeConfig({
      version: 1,
      signalling: { ...SIGNALLING },
      issuers: [{ ...entry, kid: 'not a kid' }],
    }),
  )
  assert.throws(() =>
    parsePauseRuntimeConfig({
      version: 1,
      signalling: { ...SIGNALLING },
      issuers: [{ ...entry, privateKeyPkcs8: spki }],
    }),
  )
})

test('the loader snapshots the entire keyring before asynchronous imports', async () => {
  const { spki, pair } = await issuerFixture()
  const entry = { issuer: ISSUER, kid: KID, publicKeySpki: spki }
  const config = {
    version: 1 as const,
    signalling: { ...SIGNALLING },
    issuers: [entry, { ...entry, kid: 'second' }],
  }
  const loading = loadPauseIssuerKeys(config)
  entry.issuer = 'farm:changed'
  entry.kid = 'changed'
  config.issuers[1]!.kid = 'changed-second'
  config.issuers.push({ ...entry, kid: 'unexpected' })
  const keys = await loading
  assert.deepEqual(
    keys.map(({ issuer, kid }) => ({ issuer, kid })),
    [
      { issuer: ISSUER, kid: KID },
      { issuer: ISSUER, kid: 'second' },
    ],
  )
  const message = new TextEncoder().encode('snapshot verification')
  const signature = await crypto.subtle.sign(
    'Ed25519',
    pair.privateKey,
    message,
  )
  for (const key of keys)
    assert.equal(
      await crypto.subtle.verify('Ed25519', key.publicKey, signature, message),
      true,
    )
})

test('the loader validates the whole keyring before importing any key', async () => {
  const { spki } = await issuerFixture()
  const entry = { issuer: ISSUER, kid: KID, publicKeySpki: spki }
  const counted = await countImports(async () => {
    for (const issuers of [
      [],
      Array.from({ length: 9 }, (_, index) => ({
        ...entry,
        kid: `key-${index}`,
      })),
      [entry, { ...entry }],
      [entry, { ...entry, kid: 'invalid key' }],
    ])
      await assert.rejects(
        loadPauseIssuerKeys({
          version: 1,
          signalling: { ...SIGNALLING },
          issuers,
        }),
      )
  })
  assert.equal(counted.imports, 0)
})

test('the pause section refuses a noncanonical, wrong algorithm or private public key', async () => {
  const { spki } = await issuerFixture()
  const entry = { issuer: ISSUER, kid: KID, publicKeySpki: spki }
  // A trailing padding bit change decodes to the same bytes but is not canonical.
  const noncanonical = spki.slice(0, -1) + 'B'
  assert.notEqual(noncanonical, spki)
  assert.throws(() =>
    parsePauseRuntimeConfig({
      version: 1,
      signalling: { ...SIGNALLING },
      issuers: [{ ...entry, publicKeySpki: noncanonical }],
    }),
  )
  assert.throws(() =>
    parsePauseRuntimeConfig({
      version: 1,
      signalling: { ...SIGNALLING },
      issuers: [{ ...entry, publicKeySpki: spki.slice(0, -1) + '+' }],
    }),
  )
  assert.throws(() =>
    parsePauseRuntimeConfig({
      version: 1,
      signalling: { ...SIGNALLING },
      issuers: [{ ...entry, publicKeySpki: 'AAAA' }],
    }),
  )
  assert.throws(() =>
    parsePauseRuntimeConfig({
      version: 1,
      signalling: { ...SIGNALLING },
      issuers: [{ ...entry, publicKeySpki: 'A'.repeat(59) }],
    }),
  )
  // A P-256 public key is a valid SPKI, but not the Ed25519 algorithm.
  const p256 = await crypto.subtle.generateKey(
    { name: 'ECDSA', namedCurve: 'P-256' },
    true,
    ['sign', 'verify'],
  )
  const p256Spki = Buffer.from(
    await crypto.subtle.exportKey('spki', p256.publicKey),
  ).toString('base64url')
  assert.throws(() =>
    parsePauseRuntimeConfig({
      version: 1,
      signalling: { ...SIGNALLING },
      issuers: [{ ...entry, publicKeySpki: p256Spki }],
    }),
  )
  // A private PKCS#8 payload is never a public key.
  const pkcs8 = (await issuerFixture()).pkcs8.toString('base64url')
  assert.throws(() =>
    parsePauseRuntimeConfig({
      version: 1,
      signalling: { ...SIGNALLING },
      issuers: [{ ...entry, publicKeySpki: pkcs8 }],
    }),
  )
})

test('the parsed pause configuration and the loaded issuer list are deeply immutable', async () => {
  const { spki } = await issuerFixture()
  const directory = temporaryDirectory()
  try {
    const fixture = runtimeFixture({
      pause: {
        version: 1,
        signalling: { ...SIGNALLING },
        issuers: [{ issuer: ISSUER, kid: KID, publicKeySpki: spki }],
      },
    })
    const path = writeRuntime(directory.path, fixture.value)
    const config = readAgentRuntimeConfig(path, fixture.credential)
    const pause = config.pause
    assert.ok(pause)
    assert.equal(Object.isFrozen(pause), true)
    assert.equal(Object.isFrozen(pause.issuers), true)
    assert.equal(Object.isFrozen(pause.issuers[0]), true)
    assert.throws(() => {
      ;(pause as { issuers: unknown }).issuers = []
    })
    assert.throws(() => {
      ;(pause.issuers[0] as { issuer: string }).issuer = 'other'
    })
    const issuers = await loadPauseIssuerKeys(pause)
    assert.equal(Object.isFrozen(issuers), true)
    assert.equal(Object.isFrozen(issuers[0]), true)
  } finally {
    directory.close()
  }
})

test('the local mapping resolver returns the provisioned handle and refuses foreign identifiers', async () => {
  const directory = temporaryDirectory()
  try {
    const fixture = runtimeFixture()
    const path = writeRuntime(directory.path, fixture.value)
    const config = readAgentRuntimeConfig(path, fixture.credential)
    const handle = config.bindingFor(fixture.assignment)
    assert.notEqual(handle, undefined)
    // The same provisioned handle is returned on every call.
    assert.equal(config.bindingFor(fixture.assignment), handle)
    const mapping = readPrinterBinding(handle!)
    assert.deepEqual(mapping, config.assignments[0])
    assert.equal(mapping?.assignment_id, fixture.assignment)
    assert.equal(mapping?.farm_id, fixture.farm)
    assert.equal(mapping?.agent_id, fixture.agent)
    // An unknown or foreign identifier is never mapped.
    assert.equal(config.bindingFor(randomUUID()), undefined)
    assert.equal(config.bindingFor(''), undefined)
    assert.equal(config.bindingFor('not-an-assignment'), undefined)
  } finally {
    directory.close()
  }
})

test('a printer binding handle cannot be serialized', async () => {
  const directory = temporaryDirectory()
  try {
    const fixture = runtimeFixture()
    const path = writeRuntime(directory.path, fixture.value)
    const config = readAgentRuntimeConfig(path, fixture.credential)
    const handle = config.bindingFor(fixture.assignment)
    assert.throws(() => JSON.stringify(handle), /cannot be serialized/)
    assert.throws(() => JSON.stringify({ handle }), /cannot be serialized/)
  } finally {
    directory.close()
  }
})

test('the loaded issuer verifies a genuine capability with a verification-only key', async () => {
  const { signingKey, spki } = await issuerFixture()
  const directory = temporaryDirectory()
  try {
    const fixture = runtimeFixture({
      pause: {
        version: 1,
        signalling: { ...SIGNALLING },
        issuers: [{ issuer: ISSUER, kid: KID, publicKeySpki: spki }],
      },
    })
    const path = writeRuntime(directory.path, fixture.value)
    const config = readAgentRuntimeConfig(path, fixture.credential)
    const counted = await countImports(() => loadPauseIssuerKeys(config.pause))
    assert.equal(counted.imports, 1)
    const issuers = counted.result
    assert.equal(issuers.length, 1)
    assert.equal(issuers[0]?.issuer, ISSUER)
    assert.equal(issuers[0]?.kid, KID)
    const key = issuers[0]!.publicKey
    assert.equal(key.type, 'public')
    assert.equal(key.algorithm.name, 'Ed25519')
    assert.deepEqual([...key.usages], ['verify'])
    assert.equal(key.extractable, false)

    const browser = (await crypto.subtle.generateKey(
      { name: 'ECDSA', namedCurve: 'P-256' },
      true,
      ['sign', 'verify'],
    )) as CryptoKeyPair
    const jwk = await crypto.subtle.exportKey('jwk', browser.publicKey)
    const { kty, crv, x, y } = jwk
    const { publicKey, thumbprint } = await validateBrowserDevicePublicKey({
      kty,
      crv,
      x,
      y,
    })
    const digest = 'A'.repeat(43)
    const capability = await signPauseCapability(
      {
        v: 1,
        purpose: 'pause-authority',
        capability_id: randomUUID(),
        kid: KID,
        issuer: ISSUER,
        audience: 'open3dfarmmanager:pause',
        origin: 'https://farm.example',
        issued_at: 1000,
        expires_at: 30000,
        account_id: 'operator_account',
        role: 'operator',
        farm_id: fixture.farm,
        agent_id: fixture.agent,
        key_id: randomUUID(),
        assignment_id: fixture.assignment,
        transport_id: randomUUID(),
        browser_public_key: publicKey,
        browser_thumbprint: thumbprint,
        connector_fingerprint: 'SHA256:' + digest,
        credential_jti: randomUUID(),
        printer_key: 'printer-1',
        control_binding_sha256: digest,
        admission_nonce: digest,
        actions: ['pause'],
      },
      signingKey,
    )
    assert.equal(await verifyPauseCapability(capability, key), true)
    // A key of another issuer never verifies the capability.
    const other = await issuerFixture()
    const otherIssuers = await loadPauseIssuerKeys(
      parsePauseRuntimeConfig({
        version: 1,
        signalling: { ...SIGNALLING },
        issuers: [{ issuer: ISSUER, kid: KID, publicKeySpki: other.spki }],
      }),
    )
    assert.equal(
      await verifyPauseCapability(capability, otherIssuers[0]!.publicKey),
      false,
    )
    // Every explicit load imports its own key: there is no global cache.
    const reloaded = await loadPauseIssuerKeys(config.pause)
    assert.notEqual(reloaded[0]!.publicKey, key)
  } finally {
    directory.close()
  }
})

test('pause signalling requires explicit independent canonical fields', async () => {
  const { spki } = await issuerFixture()
  const base = {
    version: 1,
    issuers: [{ issuer: ISSUER, kid: KID, publicKeySpki: spki }],
  }
  const parsed = parsePauseRuntimeConfig({ ...base, signalling: SIGNALLING })
  assert.deepEqual(parsed.signalling, SIGNALLING)
  assert.notEqual(
    parsed.signalling.audience,
    parsed.signalling.credentialAudience,
  )
  assert.equal(Object.isFrozen(parsed.signalling), true)
  for (const endpoint of [
    {
      origin: 'https://farm.example:8443',
      endpoint: 'wss://farm.example:8443/api/signalling/pause-connector',
    },
    {
      origin: 'https://[::1]:8443',
      endpoint: 'wss://[::1]:8443/api/signalling/pause-connector',
    },
  ]) {
    const signalling = {
      ...SIGNALLING,
      ...endpoint,
    }
    assert.deepEqual(
      parsePauseRuntimeConfig({ ...base, signalling }).signalling,
      signalling,
    )
  }
  assert.throws(() => parsePauseRuntimeConfig(base))
  const directory = temporaryDirectory()
  try {
    const fixture = runtimeFixture({ pause: base })
    const counted = await countImports(async () => {
      assert.throws(() =>
        readAgentRuntimeConfig(
          writeRuntime(directory.path, fixture.value),
          fixture.credential,
        ),
      )
    })
    assert.equal(counted.imports, 0)
  } finally {
    directory.close()
  }
  for (const field of Object.keys(SIGNALLING)) {
    const incomplete = { ...SIGNALLING }
    Reflect.deleteProperty(incomplete, field)
    assert.throws(() =>
      parsePauseRuntimeConfig({ ...base, signalling: incomplete }),
    )
  }
  for (const change of [
    { origin: 'http://127.0.0.1' },
    { origin: 'https://farm.example/' },
    { endpoint: 'wss://other.example/api/signalling/pause-connector' },
    { endpoint: 'wss://farm.example/api/signalling/connector' },
    { endpoint: 'wss://farm.example/api/signalling/pause-connector?x=1' },
    { endpoint: 'wss://farm.example/api/signalling/pause-connector?' },
    { endpoint: 'wss://farm.example/api/signalling/pause-connector#' },
    { endpoint: 'wss://farm.example/api/signalling/pause-connector#fragment' },
    { endpoint: 'wss://user@farm.example/api/signalling/pause-connector' },
    { endpoint: 'wss://farm.example:443/api/signalling/pause-connector' },
    { audience: '' },
    { credentialAudience: 'bad audience' },
    { unexpected: true },
  ])
    assert.throws(() =>
      parsePauseRuntimeConfig({
        ...base,
        signalling: { ...SIGNALLING, ...change },
      }),
    )
})
