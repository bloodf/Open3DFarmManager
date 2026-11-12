import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import test, { after } from 'node:test'

const token = Symbol.for('connector-renewal-runtime-test-config')
Object.defineProperty(globalThis, token, {
  configurable: true,
  writable: true,
  value: {},
})
const moduleUrl = (source: string) =>
  `data:text/javascript,${encodeURIComponent(source)}`
const hooks = registerHooks({
  resolve(specifier, context, next) {
    if (
      specifier === 'nuxt/server' &&
      context.parentURL?.includes('/server/utils/')
    )
      return {
        url: moduleUrl(
          `export const useRuntimeConfig = () => globalThis[Symbol.for('connector-renewal-runtime-test-config')]
           export const createError = ({ status, message }) => Object.assign(new Error(message), { status })`,
        ),
        shortCircuit: true,
      }
    return next(specifier, context)
  },
})
const lines: string[] = []
const write = process.stderr.write.bind(process.stderr)
process.stderr.write = ((chunk: string | Uint8Array, ...rest: never[]) => {
  lines.push(String(chunk))
  return write(chunk, ...rest)
}) as typeof process.stderr.write
const failures = () =>
  lines.filter((line) => line.includes('connector-renewal-activation-failed'))
const { setDatabasePhase } =
  await import('../../apps/farm/server/utils/database/phase.ts')
const { connectorRenewalHandler, closeConnectorRenewalRuntime } =
  await import('../../apps/farm/server/utils/connector-renewal/runtime.ts')
after(async () => {
  process.stderr.write = write
  await closeConnectorRenewalRuntime()
  hooks.deregister()
})
const configure = (connectorRenewal: unknown) =>
  Reflect.set(globalThis, token, { connectorRenewal })
const valid = {
  enabled: true,
  databaseUrl: 'postgres://renewer:secret@127.0.0.1:1/fixture',
  origin: 'https://farm.example',
  issuer: 'https://farm.example',
  audience: 'open3dfarmmanager:connector',
  proofAudience: 'open3dfarmmanager:renewal',
  signingKeyId: 'fixture',
  signingKeyPath: '/nonexistent/o3dfm-renewal/signing.pem',
  publicKeyRegistryPath: '/nonexistent/o3dfm-renewal/registry.json',
  tokenTtlSeconds: '300',
  proofTtlMs: '30000',
  bodyTimeoutMs: '5000',
}

test('renewal runtime is 404 unless explicitly enabled', async () => {
  for (const value of [
    undefined,
    {},
    { enabled: false },
    { enabled: 'true' },
  ]) {
    configure(value)
    await assert.rejects(connectorRenewalHandler(), { status: 404 })
  }
})

test('invalid enabled configuration fails closed with 503', async () => {
  setDatabasePhase('ready')
  for (const change of [
    { origin: 'http://farm.example' },
    { databaseUrl: 'postgres://nopassword@127.0.0.1/fixture' },
    { signingKeyPath: 'relative.pem' },
    { tokenTtlSeconds: '0' },
    { unexpected: true },
  ]) {
    configure({ ...valid, ...change })
    await assert.rejects(connectorRenewalHandler(), { status: 503 })
  }
})

test('activation is refused unless the database gate reports ready', async () => {
  configure(valid)
  for (const phase of ['disabled', 'starting', 'failed'] as const) {
    setDatabasePhase(phase)
    const before = failures().length
    await assert.rejects(connectorRenewalHandler(), { status: 503 })
    // Refused before any activation attempt.
    assert.equal(failures().length, before)
  }
})

test('failed activation logs a fixed message, then backs off for 30 s', async () => {
  configure(valid)
  setDatabasePhase('ready')
  let clock = 1_000_000
  const now = () => clock
  const before = failures().length
  await assert.rejects(connectorRenewalHandler(now), { status: 503 })
  const logged = failures().slice(before)
  assert.equal(logged.length, 1)
  const entry = JSON.parse(logged[0]!)
  assert.equal(entry.msg, 'connector-renewal-activation-failed')
  assert.equal(entry.errorClass, 'Error')
  // No configured path, URL or secret leaks into the log line.
  assert.doesNotMatch(logged[0]!, /nonexistent|secret|postgres:/)
  clock += 29_999
  await assert.rejects(connectorRenewalHandler(now), { status: 503 })
  assert.equal(failures().length, before + 1)
  clock += 1
  await assert.rejects(connectorRenewalHandler(now), { status: 503 })
  assert.equal(failures().length, before + 2)
})

test('after close, requests never reactivate the runtime', async () => {
  configure(valid)
  setDatabasePhase('ready')
  await closeConnectorRenewalRuntime()
  const before = failures().length
  await assert.rejects(
    connectorRenewalHandler(() => 1e15),
    { status: 503 },
  )
  assert.equal(failures().length, before)
})
