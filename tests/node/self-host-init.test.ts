import assert from 'node:assert/strict'
import { createPublicKey } from 'node:crypto'
import { chmod, mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises'
import { registerHooks } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test, { after, type TestContext } from 'node:test'
import { parseEnv } from 'node:util'
import { initialize } from '../../scripts/self-host/init.ts'

const nuxt =
  'data:text/javascript,' +
  encodeURIComponent(
    'export const createError = (details) => Object.assign(new Error(details.message), details); export const useRuntimeConfig = () => ({});',
  )
const hooks = registerHooks({
  resolve(specifier, context, next) {
    if (specifier === 'nuxt/server') return { url: nuxt, shortCircuit: true }
    return next(specifier, context)
  },
})
after(() => hooks.deregister())

const { PairingRuntimeConfig, loadPairingSigningKey } =
  await import('../../apps/farm/server/utils/connector-pairing/runtime.ts')
const { RenewalRuntimeConfig } =
  await import('../../apps/farm/server/utils/connector-renewal/runtime.ts')
const { parseTelemetryRuntimeConfig } =
  await import('../../apps/farm/server/services/telemetry-runtime-config.ts')
const { loadTelemetryVerificationKeys } =
  await import('../../apps/farm/server/services/telemetry-key-registry.ts')
const { parsePauseAuthorityRuntimeConfig } =
  await import('../../apps/farm/server/utils/pause-authority/config.ts')
const { loadPauseIssuerKey } =
  await import('../../apps/farm/server/utils/pause-authority/issuer-key.ts')
const { configuredAuthOrigin } =
  await import('../../apps/farm/server/utils/auth/boundary.ts')
const { assertSameDatabaseTargets, parseDatabaseRuntimeConfig } =
  await import('../../apps/farm/server/utils/database/runtime.ts')

const origin = 'https://farm.example'
const admin = 'postgres://admin:fixture-only@127.0.0.1:5433/fixture'

async function fixture(t: TestContext) {
  const parent = await mkdtemp(join(tmpdir(), 'openfarm-init-'))
  t.after(() => rm(parent, { recursive: true }))
  return join(parent, 'install')
}

function config(env: ReturnType<typeof parseEnv>, section: string) {
  const prefix = `NUXT_${section}_`
  return Object.fromEntries(
    Object.entries(env)
      .filter(([key]) => key.startsWith(prefix))
      .map(([key, value]) => [
        key
          .slice(prefix.length)
          .toLowerCase()
          .replace(/_([a-z])/g, (_, letter: string) => letter.toUpperCase()),
        key.endsWith('_ENABLED') ? value === 'true' : value,
      ]),
  )
}

test('generated environment passes startup parsers and issuer key loaders', async (t) => {
  const directory = await fixture(t)
  let sql = ''
  await initialize(directory, origin, admin, (_, statement) => {
    sql = statement
  })
  const env = parseEnv(await readFile(join(directory, 'app.env'), 'utf8'))
  for (const name of await readdir(directory))
    assert.equal((await stat(join(directory, name))).mode & 0o777, 0o600)
  assert.equal((await stat(directory)).mode & 0o777, 0o700)

  const sections = [
    'AUTH',
    'CONNECTOR_PAIRING',
    'CONNECTOR_RENEWAL',
    'CONNECTOR_TELEMETRY',
    'PAUSE_AUTHORITY',
    'CONNECTOR_INVENTORY',
    'BROWSER_DEVICES',
    'PRINTER_ASSIGNMENTS',
    'PRINTER_STATES',
    'JOB_HISTORY',
  ]
  const database = parseDatabaseRuntimeConfig(config(env, 'DATABASE'))
  assert.ok(database)
  assert.equal(database.migrations, 'verify')
  assertSameDatabaseTargets(
    database,
    Object.fromEntries(sections.map((name) => [name, config(env, name)])),
  )
  for (const name of sections) assert.equal(config(env, name).enabled, true)
  assert.equal(configuredAuthOrigin(env.NUXT_AUTH_ORIGIN!), origin)
  assert.match(env.NUXT_AUTH_SESSION_SECRET!, /^[\w-]{43}$/)
  assert.match(env.NUXT_AUTH_BOOTSTRAP_TOKEN!, /^[\w-]{43}$/)
  assert.ok(env.NUXT_AUTH_SESSION_SECRET !== env.NUXT_AUTH_BOOTSTRAP_TOKEN)

  const pairing = PairingRuntimeConfig.parse(config(env, 'CONNECTOR_PAIRING'))
  const renewal = RenewalRuntimeConfig.parse(config(env, 'CONNECTOR_RENEWAL'))
  const telemetry = parseTelemetryRuntimeConfig(
    config(env, 'CONNECTOR_TELEMETRY'),
  )
  assert.equal(telemetry.kind, 'enabled')
  assert.equal(pairing.issuer, renewal.issuer)
  assert.equal(pairing.audience, renewal.audience)
  const registry = await loadTelemetryVerificationKeys(
    renewal.publicKeyRegistryPath,
  )
  assert.ok(pairing.signingKeyId !== renewal.signingKeyId)
  for (const issuer of [pairing, renewal]) {
    const key = await loadPairingSigningKey(issuer.signingKeyPath)
    const signature = await crypto.subtle.sign(
      'Ed25519',
      key,
      new Uint8Array([1]),
    )
    assert.ok(
      await crypto.subtle.verify(
        'Ed25519',
        registry.get(issuer.signingKeyId)!,
        signature,
        new Uint8Array([1]),
      ),
    )
  }
  const pause = parsePauseAuthorityRuntimeConfig(config(env, 'PAUSE_AUTHORITY'))
  assert.ok(pause)
  assert.equal(pause.credentialIssuer, pairing.issuer)
  assert.equal(pause.credentialAudience, pairing.audience)
  await loadPauseIssuerKey(pause.issuerKeyPath, {
    issuer: pause.issuer,
    kid: pause.kid,
    publicKeySpki: pause.issuerPublicKeySpki,
  })

  const grants = [...sql.matchAll(/GRANT (farm_\w+) TO (o3dfm_\w+);/g)]
  assert.deepEqual(
    grants.map((grant) => grant[1]),
    [
      'farm_schema_reader',
      'farm_account_registration',
      'farm_pairing_runtime',
      'farm_pairing_proof_runtime',
      'farm_connector_revoker',
      'farm_connector_telemetry_writer',
      'farm_connector_credential_renewer',
      'farm_connector_inventory',
      'farm_browser_device_runtime',
      'farm_printer_ownership',
      'farm_printer_state_reader',
      'farm_job_history_reader',
      'farm_pause_authority',
    ],
  )
  const urls = Object.entries(env)
    .filter(([key]) => key.endsWith('_DATABASE_URL'))
    .map(([, value]) => {
      assert.ok(value)
      return new URL(value)
    })
  assert.equal(new Set(urls.map((url) => url.password)).size, grants.length)
  assert.deepEqual(
    urls.map((url) => url.username).sort(),
    grants.map((grant) => grant[2]).sort(),
  )
  assert.ok(!sql.includes('fixture-only'))
  assert.match(sql, /^BEGIN;[\s\S]+COMMIT;\n$/)
})

test('failed provisioning resumes with the same credentials and completed reruns do no work', async (t) => {
  const directory = await fixture(t)
  let firstSql = ''
  await assert.rejects(
    initialize(directory, origin, admin, (_, sql) => {
      firstSql = sql
      throw new Error('mock connection failure')
    }),
    /mock connection failure/,
  )
  const key = await readFile(join(directory, 'pairing.pem'), 'utf8')
  const pending = await readFile(join(directory, '.init-pending'), 'utf8')
  await assert.rejects(readFile(join(directory, 'app.env')), { code: 'ENOENT' })
  await assert.rejects(
    initialize(directory, origin, admin.replace('5433', '5434'), () =>
      assert.fail(),
    ),
    /database target/,
  )
  await initialize(directory, origin, admin, (_, sql) =>
    assert.ok(sql === firstSql),
  )
  await initialize(directory, origin, admin, () =>
    assert.fail('unexpected provisioning'),
  )
  assert.ok((await readFile(join(directory, 'app.env'), 'utf8')) === pending)
  assert.ok((await readFile(join(directory, 'pairing.pem'), 'utf8')) === key)
  assert.equal(createPublicKey(key).asymmetricKeyType, 'ed25519')
  await chmod(join(directory, 'app.env'), 0o644)
  await assert.rejects(
    initialize(directory, origin, admin, () => assert.fail()),
    /Unsafe initialization file/,
  )
})
