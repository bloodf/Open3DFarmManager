import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import { browserDeviceFixture } from '../helpers/browser-device-http-integration.ts'
import { parsePauseAuthorityRuntimeConfig } from '../../apps/farm/server/utils/pause-authority/config.ts'

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}
const token = 'open3dfarm-pause-negotiation-runtime-test'
const stateExpression = `globalThis[Symbol.for('${token}')]`
let identity: unknown = [
  { database: 'actual-fixture', address: '127.0.0.1', port: 15433 },
]
let identityRead: () => Promise<unknown> = async () => identity
let end: () => Promise<void> = async () => {}
let read: () => Promise<unknown> = async () => null
let creates = 0,
  ends = 0,
  reads = 0
let sqlHandle: unknown, readerPool: unknown, servicePool: unknown
let options: unknown, readerConfig: unknown
let serviceClosed = false
const events: string[] = []
Object.defineProperty(globalThis, Symbol.for(token), {
  configurable: true,
  value: {
    connect(_url: unknown, opts: unknown) {
      creates++
      options = opts
      const sql = async (parts: TemplateStringsArray) => {
        if (parts.join('').includes('inet_server_addr()')) return identityRead()
        throw new Error('Unexpected query')
      }
      sql.end = async () => {
        ends++
        events.push('end')
        await end()
      }
      sqlHandle = sql
      return sql
    },
    reader(pool: unknown, config: unknown) {
      readerPool = pool
      readerConfig = config
      return {
        read: async () => {
          reads++
          return read()
        },
      }
    },
    service(pool: unknown) {
      servicePool = pool
      return {
        close() {
          serviceClosed = true
          events.push('service-close')
        },
      }
    },
  },
})
const moduleUrl = (source: string) =>
  `data:text/javascript,${encodeURIComponent(source)}`
const hooks = registerHooks({
  resolve(specifier, context, next) {
    if (context.parentURL?.endsWith('/utils/pause-authority/runtime.ts')) {
      const replacements: Record<string, string> = {
        postgres: `export default (...a)=>${stateExpression}.connect(...a)`,
        'nuxt/server': `export const useRuntimeConfig=()=>({pauseAuthority:{enabled:true}});export const createError=(v)=>Object.assign(new Error(v.message),v)`,
        './issuer-key.ts': `export async function loadPauseIssuerKey(){return {}}`,
        './role-policy.ts': `export async function validatePauseAuthorityRole(){}`,
        '../../services/pause-authority.ts': `export const createPauseAuthorityService=(...a)=>${stateExpression}.service(...a)`,
        '../../storage/postgres-pause-negotiation.ts': `export class PostgresPauseNegotiation {constructor(...a){return ${stateExpression}.reader(...a)}}`,
      }
      const replacement = replacements[specifier]
      if (replacement)
        return { url: moduleUrl(replacement), shortCircuit: true }
    }
    return next(specifier, context)
  },
})
const {
  createPauseAuthorityRuntimeLifecycle,
  currentPauseNegotiationRuntime,
  pauseAuthorityRuntime,
} = await import('../../apps/farm/server/utils/pause-authority/runtime.ts')
after(() => {
  hooks.deregister()
  Reflect.deleteProperty(globalThis, Symbol.for(token))
})
async function setup() {
  creates = 0
  ends = 0
  reads = 0
  serviceClosed = false
  events.length = 0
  identity = [{ database: 'actual-fixture', address: '127.0.0.1', port: 15433 }]
  identityRead = async () => identity
  end = async () => {}
  read = async () => null
  const config = parsePauseAuthorityRuntimeConfig({
    enabled: true,
    databaseUrl: 'postgres://pause:fixture@127.0.0.1:1/unused',
    issuerKeyPath: '/synthetic/not-read',
    issuerPublicKeySpki: 'A'.repeat(59),
    issuer: 'issuer',
    kid: 'key',
    audience: 'pause-audience',
    credentialIssuer: 'credential-issuer',
    credentialAudience: 'credential-audience',
  })
  assert.ok(config)
  const auth = (await browserDeviceFixture()).runtime.auth
  auth.idleTimeoutMs = 1800000
  return { config, auth, lifecycle: createPauseAuthorityRuntimeLifecycle() }
}

test('atomically publishes HTTP and immutable negotiation metadata from one validated pool', async () => {
  const f = await setup(),
    gate = deferred<unknown>(),
    entered = deferred<void>()
  identityRead = () => {
    entered.resolve()
    return gate.promise
  }
  const starting = f.lifecycle.start(f.config, f.auth)
  await entered.promise
  assert.equal(currentPauseNegotiationRuntime(), undefined)
  assert.throws(pauseAuthorityRuntime, { status: 503 })
  gate.resolve(identity)
  await starting
  try {
    const facade = currentPauseNegotiationRuntime()
    assert.ok(facade)
    assert.equal(pauseAuthorityRuntime().auth, f.auth)
    assert.equal(creates, 1)
    assert.equal(readerPool, sqlHandle)
    assert.equal(servicePool, sqlHandle)
    assert.equal(Reflect.get(Object(options), 'max'), 4)
    assert.deepEqual(facade.databaseIdentity, {
      database: 'actual-fixture',
      address: '127.0.0.1',
      port: 15433,
    })
    assert.deepEqual(readerConfig, {
      origin: f.auth.origin,
      audience: 'pause-audience',
      credentialIssuer: 'credential-issuer',
      credentialAudience: 'credential-audience',
      idleTimeoutMs: 1800000,
    })
    assert.equal(facade.credentialAudience, 'credential-audience')
    assert.equal(facade.audience, 'pause-audience')
    assert.deepEqual(Object.keys(facade.reader), ['read'])
    assert.equal('pool' in facade, false)
    assert.equal('privateKey' in facade, false)
    for (const value of [
      facade,
      facade.owner,
      facade.databaseIdentity,
      facade.reader,
    ])
      assert.equal(Object.isFrozen(value), true)
  } finally {
    await f.lifecycle.close()
  }
})

test('unpublishes and aborts borrowers before end, with reentrant close and stale reads denied', async () => {
  const f = await setup()
  await f.lifecycle.start(f.config, f.auth)
  const facade = currentPauseNegotiationRuntime()
  assert.ok(facade)
  const heldRead = deferred<unknown>(),
    heldEnd = deferred<void>()
  read = () => heldRead.promise
  end = () => heldEnd.promise
  const reading = facade.reader.read({})
  let reentrant: Promise<void> | undefined
  facade.signal.addEventListener('abort', () => {
    events.push('abort')
    assert.equal(currentPauseNegotiationRuntime(), undefined)
    assert.throws(pauseAuthorityRuntime, { status: 503 })
    assert.equal(ends, 0)
    reentrant = f.lifecycle.close()
  })
  const closing = f.lifecycle.close()
  assert.equal(reentrant, closing)
  assert.equal(facade.signal.aborted, true)
  assert.equal(await facade.reader.read({}), null)
  assert.equal(reads, 1)
  heldRead.resolve({ mustNotEscape: true })
  assert.equal(await reading, null)
  await Promise.resolve()
  assert.ok(events.indexOf('abort') < events.indexOf('end'))
  assert.equal(serviceClosed, true)
  const other = createPauseAuthorityRuntimeLifecycle()
  assert.throws(() => other.start(f.config, f.auth), /unavailable/)
  heldEnd.resolve()
  await closing
  assert.equal(ends, 1)
  await other.start(f.config, f.auth)
  assert.notEqual(currentPauseNegotiationRuntime()?.owner, facade.owner)
  assert.equal(await facade.reader.read({}), null)
  await other.close()
})

test('close during actual identity lookup retains owner until settlement and prevents late publication', async () => {
  const f = await setup(),
    gate = deferred<unknown>(),
    entered = deferred<void>()
  identityRead = () => {
    entered.resolve()
    return gate.promise
  }
  const starting = assert.rejects(
    f.lifecycle.start(f.config, f.auth),
    /startup unavailable/,
  )
  await entered.promise
  const closing = f.lifecycle.close(),
    other = createPauseAuthorityRuntimeLifecycle()
  assert.equal(ends, 0)
  assert.equal(currentPauseNegotiationRuntime(), undefined)
  assert.throws(() => other.start(f.config, f.auth), /unavailable/)
  gate.resolve(identity)
  await starting
  await closing
  assert.equal(ends, 1)
  assert.equal(currentPauseNegotiationRuntime(), undefined)
  await other.close()
})

test('malformed or nonunique database identity fails closed; null socket identity is represented exactly', async () => {
  for (const invalid of [
    [],
    [{ database: 'x', address: 'host', port: 0 }],
    [{ database: 'x', address: 'host', port: 1, extra: true }],
    [
      { database: 'a', address: null, port: null },
      { database: 'b', address: null, port: null },
    ],
  ]) {
    const f = await setup()
    identity = invalid
    await assert.rejects(f.lifecycle.start(f.config, f.auth))
    await f.lifecycle.close()
    assert.equal(currentPauseNegotiationRuntime(), undefined)
    assert.equal(ends, 1)
  }
  const f = await setup()
  identity = [{ database: 'socket-fixture', address: null, port: null }]
  await f.lifecycle.start(f.config, f.auth)
  assert.deepEqual(currentPauseNegotiationRuntime()?.databaseIdentity, {
    database: 'socket-fixture',
    address: null,
    port: null,
  })
  await f.lifecycle.close()
})

test('failed pool cleanup leaves facades terminal and startup ownership reserved', async () => {
  const f = await setup()
  await f.lifecycle.start(f.config, f.auth)
  const facade = currentPauseNegotiationRuntime()
  assert.ok(facade)
  end = async () => {
    throw new Error('synthetic end failure')
  }
  await assert.rejects(f.lifecycle.close(), /cleanup failed/)
  assert.equal(currentPauseNegotiationRuntime(), undefined)
  assert.equal(facade.signal.aborted, true)
  assert.equal(await facade.reader.read({}), null)
  assert.equal(ends, 1)
  const other = createPauseAuthorityRuntimeLifecycle()
  assert.throws(() => other.start(f.config, f.auth), /unavailable/)
  await other.close()
})
