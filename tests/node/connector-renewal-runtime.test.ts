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
const { connectorRenewalHandler, closeConnectorRenewalRuntime } =
  await import('../../apps/farm/server/utils/connector-renewal/runtime.ts')
after(async () => {
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

test('failed activation is 503, installs nothing and retries later', async () => {
  configure(valid)
  await assert.rejects(connectorRenewalHandler(), { status: 503 })
  await assert.rejects(connectorRenewalHandler(), { status: 503 })
})
