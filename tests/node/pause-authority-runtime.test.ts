import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire, registerHooks } from 'node:module'
import { realpathSync } from 'node:fs'
import { mkdtemp, writeFile, chmod, symlink, link, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { parsePauseAuthorityRuntimeConfig } from '../../apps/farm/server/utils/pause-authority/config.ts'
import { loadPauseIssuerKey } from '../../apps/farm/server/utils/pause-authority/issuer-key.ts'
import { browserDeviceFixture } from '../helpers/browser-device-http-integration.ts'

function deferred<T>() {
  let resolve: (value: T) => void = () => {}
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}
const symbol = Symbol.for('open3dfarm-pause-runtime-test-only')
let created = 0,
  ended = 0
let config: unknown = { enabled: false }
let query: () => Promise<unknown> = async () => [{ allowed: true }]
let finish: () => Promise<void> = async () => {}
let onCreate: (() => void) | undefined
const connectionOptions: unknown[] = []
const statements: string[] = []
Object.defineProperty(globalThis, symbol, {
  configurable: true,
  value: {
    configuration: () => ({ pauseAuthority: config }),
    connect(_url: unknown, options: unknown) {
      created++
      connectionOptions.push(options)
      onCreate?.()
      const sql = (parts: TemplateStringsArray) => {
        statements.push(parts.join('?'))
        return query()
      }
      sql.end = async () => {
        ended++
        await finish()
      }
      return sql
    },
  },
})
const requireNuxt = createRequire(
  realpathSync(
    new URL('../../apps/farm/node_modules/nuxt/package.json', import.meta.url),
  ),
)
const nuxtUrl = pathToFileURL(requireNuxt.resolve('nuxt/server')).href
const state = `globalThis[Symbol.for('open3dfarm-pause-runtime-test-only')]`
const sqlModule = `data:text/javascript,${encodeURIComponent(`export default (...args) => ${state}.connect(...args)`)}`
const nuxtModule = `data:text/javascript,${encodeURIComponent(`export * from ${JSON.stringify(nuxtUrl)}; export const useRuntimeConfig = () => ${state}.configuration()`)}`
const hooks = registerHooks({
  resolve(specifier, context, next) {
    if (
      context.parentURL?.endsWith('/server/utils/pause-authority/runtime.ts')
    ) {
      if (specifier === 'postgres')
        return { url: sqlModule, shortCircuit: true }
      if (specifier === 'nuxt/server')
        return { url: nuxtModule, shortCircuit: true }
    }
    return next(specifier, context)
  },
})
const { createPauseAuthorityRuntimeLifecycle, pauseAuthorityRuntime } =
  await import('../../apps/farm/server/utils/pause-authority/runtime.ts')
after(() => {
  hooks.deregister()
  Reflect.deleteProperty(globalThis, symbol)
})

async function provision(t: test.TestContext) {
  const directory = await mkdtemp(join(tmpdir(), 'pause-issuer-key-test-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const pair = await crypto.subtle.generateKey('Ed25519', true, [
    'sign',
    'verify',
  ])
  const privateKeyPkcs8 = Buffer.from(
    await crypto.subtle.exportKey('pkcs8', pair.privateKey),
  ).toString('base64url')
  const publicKeySpki = Buffer.from(
    await crypto.subtle.exportKey('spki', pair.publicKey),
  ).toString('base64url')
  const path = join(directory, 'issuer.json')
  const file = {
    version: 1,
    issuer: 'test:issuer',
    kid: 'test-kid',
    privateKeyPkcs8,
  }
  await writeFile(path, JSON.stringify(file), { mode: 0o600 })
  const expected = { issuer: file.issuer, kid: file.kid, publicKeySpki }
  const raw = {
    enabled: true,
    databaseUrl: 'postgres://pause:synthetic@127.0.0.1:1/unused',
    issuerKeyPath: path,
    issuerPublicKeySpki: publicKeySpki,
    issuer: file.issuer,
    kid: file.kid,
    audience: 'test:pause',
    credentialIssuer: 'test:credential',
    credentialAudience: 'test:credential',
  }
  const parsed = parsePauseAuthorityRuntimeConfig(raw)
  assert.ok(parsed)
  return { directory, path, file, expected, config: parsed }
}
function resetDb() {
  created = 0
  ended = 0
  connectionOptions.length = 0
  statements.length = 0
  query = async () => [{ allowed: true }]
  finish = async () => {}
  onCreate = undefined
}

test(
  'disabled configuration performs no key/pool work; activation requires boolean true and complete private config',
  { timeout: 10000 },
  async () => {
    resetDb()
    for (const value of [
      undefined,
      null,
      {},
      { enabled: false },
      { enabled: 'true' },
    ]) {
      assert.equal(parsePauseAuthorityRuntimeConfig(value), null)
      config = value
      assert.throws(pauseAuthorityRuntime, { status: 404 })
    }
    assert.throws(() => parsePauseAuthorityRuntimeConfig({ enabled: true }))
    const lifecycle = createPauseAuthorityRuntimeLifecycle()
    await lifecycle.close()
    assert.equal(created, 0)
  },
)

test(
  'private file imports a nonextractable key and checks independent public pin and exact metadata',
  { timeout: 10000 },
  async (t) => {
    const f = await provision(t)
    const keys = await loadPauseIssuerKey(f.path, f.expected)
    assert.equal(keys.signingKey.extractable, false)
    assert.deepEqual(keys.signingKey.usages, ['sign'])
    assert.deepEqual(keys.verificationKey.usages, ['verify'])
    const payload = new TextEncoder().encode('fixture')
    assert.ok(
      await crypto.subtle.verify(
        'Ed25519',
        keys.verificationKey,
        await crypto.subtle.sign('Ed25519', keys.signingKey, payload),
        payload,
      ),
    )
    await assert.rejects(crypto.subtle.exportKey('pkcs8', keys.signingKey))
    await assert.rejects(
      loadPauseIssuerKey(f.path, { ...f.expected, kid: 'other' }),
    )
    const other = await crypto.subtle.generateKey('Ed25519', true, [
      'sign',
      'verify',
    ])
    await assert.rejects(
      loadPauseIssuerKey(f.path, {
        ...f.expected,
        publicKeySpki: Buffer.from(
          await crypto.subtle.exportKey('spki', other.publicKey),
        ).toString('base64url'),
      }),
    )
    await assert.rejects(loadPauseIssuerKey('relative.json', f.expected))
  },
)

test(
  'private file rejects symlink, hardlink, directory, public mode, malformed UTF-8 and oversized/extra-key JSON',
  { timeout: 10000 },
  async (t) => {
    const f = await provision(t)
    const symbolic = join(f.directory, 'symbolic')
    await symlink(f.path, symbolic)
    await assert.rejects(loadPauseIssuerKey(symbolic, f.expected))
    const hard = join(f.directory, 'hard')
    await link(f.path, hard)
    await assert.rejects(loadPauseIssuerKey(f.path, f.expected))
    await rm(hard)
    await assert.rejects(loadPauseIssuerKey(f.directory, f.expected))
    await chmod(f.path, 0o644)
    await assert.rejects(loadPauseIssuerKey(f.path, f.expected))
    await chmod(f.path, 0o600)
    for (const bytes of [
      Buffer.from([0xff, 0xff]),
      Buffer.alloc(4097, 32),
      Buffer.from(JSON.stringify({ ...f.file, publicKey: 'caller' })),
    ]) {
      await writeFile(f.path, bytes)
      await assert.rejects(loadPauseIssuerKey(f.path, f.expected))
    }
  },
)

test(
  'startup publishes only after key and role validation; close stops new work and closes its one pool',
  { timeout: 10000 },
  async (t) => {
    resetDb()
    const f = await provision(t),
      auth = (await browserDeviceFixture()).runtime.auth
    auth.idleTimeoutMs = 1800000
    config = f.config
    const gate = deferred<unknown>(),
      entered = deferred<void>()
    query = async () => {
      entered.resolve()
      return gate.promise
    }
    const lifecycle = createPauseAuthorityRuntimeLifecycle()
    t.after(async () => {
      gate.resolve([{ allowed: false }])
      await lifecycle.close()
    })
    const starting = lifecycle.start(f.config, auth)
    await entered.promise
    assert.throws(pauseAuthorityRuntime, { status: 503 })
    gate.resolve([{ allowed: true }])
    await starting
    const runtime = pauseAuthorityRuntime()
    assert.equal(runtime.auth, auth)
    assert.equal(created, 1)
    assert.deepEqual(connectionOptions[0], {
      max: 4,
      connect_timeout: 3,
      idle_timeout: 20,
      connection: {
        statement_timeout: 2000,
        lock_timeout: 1000,
        transaction_timeout: 10000,
        search_path: 'pg_catalog',
        options: '-c role=farm_pause_authority',
      },
    })
    assert.match(statements[0] ?? '', /session_user/)
    assert.match(statements[0] ?? '', /has_column_privilege/)
    await lifecycle.close()
    assert.throws(pauseAuthorityRuntime, { status: 503 })
    assert.deepEqual(await runtime.authority.issueCapability({}), {
      ok: false,
      reason: 'denied',
    })
    assert.equal(ended, 1)
  },
)

test(
  'close during pending role work retains startup ownership until settlement and never publishes',
  { timeout: 10000 },
  async (t) => {
    resetDb()
    const f = await provision(t),
      auth = (await browserDeviceFixture()).runtime.auth
    auth.idleTimeoutMs = 1800000
    config = f.config
    const gate = deferred<unknown>(),
      entered = deferred<void>()
    query = async () => {
      entered.resolve()
      return gate.promise
    }
    const lifecycle = createPauseAuthorityRuntimeLifecycle()
    t.after(async () => {
      gate.resolve([{ allowed: false }])
      await lifecycle.close()
    })
    const starting = assert.rejects(
      lifecycle.start(f.config, auth),
      /startup unavailable/,
    )
    await entered.promise
    let closed = false
    const close = lifecycle.close().then(() => {
      closed = true
    })
    const second = createPauseAuthorityRuntimeLifecycle()
    assert.throws(() => second.start(f.config, auth), /lifecycle unavailable/)
    await Promise.resolve()
    assert.equal(closed, false)
    assert.equal(ended, 0)
    assert.throws(pauseAuthorityRuntime, { status: 503 })
    gate.resolve([{ allowed: true }])
    await starting
    await close
    assert.equal(ended, 1)
    await second.close()
  },
)

test(
  'reentrant close during pool creation, role denial and pool-end error never publish',
  { timeout: 10000 },
  async (t) => {
    for (const mode of ['reentrant', 'denied', 'end-error'] as const) {
      resetDb()
      const f = await provision(t),
        auth = (await browserDeviceFixture()).runtime.auth
      auth.idleTimeoutMs = 1800000
      config = f.config
      const lifecycle = createPauseAuthorityRuntimeLifecycle()
      let close: Promise<void> | undefined
      if (mode === 'reentrant')
        onCreate = () => {
          close = lifecycle.close()
        }
      else query = async () => [{ allowed: false }]
      if (mode === 'end-error')
        finish = async () => {
          throw new Error('synthetic end failure')
        }
      await assert.rejects(lifecycle.start(f.config, auth))
      await close
      if (mode === 'end-error')
        await assert.rejects(lifecycle.close(), /cleanup failed/)
      else await lifecycle.close()
      assert.throws(pauseAuthorityRuntime, { status: 503 })
      assert.equal(created, 1)
      assert.equal(ended, 1)
    }
  },
)
