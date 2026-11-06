import assert from 'node:assert/strict'
import { IncomingMessage } from 'node:http'
import { registerHooks } from 'node:module'
import { Socket } from 'node:net'
import test, { after } from 'node:test'

const token = Symbol.for('telemetry-route-test-runtime')
let runtimeCalls = 0
let handlerCalls = 0
let enabled = false
const response = { status: 401, body: { error: 'Não autorizado.' } }
Object.defineProperty(globalThis, token, {
  configurable: true,
  value: () => {
    runtimeCalls++
    return enabled
      ? async () => {
          handlerCalls++
          return response
        }
      : undefined
  },
})
const moduleUrl = (source: string) =>
  `data:text/javascript,${encodeURIComponent(source)}`
const hooks = registerHooks({
  resolve(specifier, context, next) {
    if (context.parentURL?.includes('/server/api/connector/telemetry')) {
      if (specifier === 'nuxt/server')
        return {
          url: moduleUrl(
            'export const defineEventHandler = handler => handler',
          ),
          shortCircuit: true,
        }
      if (specifier.endsWith('/services/telemetry-http-runtime.ts'))
        return {
          url: moduleUrl(
            "export const telemetryHttpRuntime = () => globalThis[Symbol.for('telemetry-route-test-runtime')]()",
          ),
          shortCircuit: true,
        }
    }
    return next(specifier, context)
  },
})
const routes = [
  [
    '/api/connector/telemetry',
    (await import('../../apps/farm/server/api/connector/telemetry.post.ts'))
      .default,
  ],
  [
    '/api/connector/telemetry/challenge',
    (
      await import(
        '../../apps/farm/server/api/connector/telemetry/challenge.post.ts'
      )
    ).default,
  ],
] as const
after(() => {
  hooks.deregister()
  Reflect.deleteProperty(globalThis, token)
})

for (const [path, route] of routes) {
  test(`${path} enforces the boundary before runtime and forwards runtime responses`, async () => {
    const req = new IncomingMessage(new Socket())
    req.method = 'POST'
    req.url = path
    req.rawHeaders = [
      'content-type',
      'application/json',
      'cookie',
      'session=synthetic',
    ]
    const event = {
      '~app': { node: { req } },
      res: { headers: new Headers(), status: 200 },
    }
    runtimeCalls = 0
    handlerCalls = 0
    enabled = true
    assert.deepEqual(await route(event), { error: 'Solicitação inválida.' })
    assert.equal(event.res.status, 400)
    assert.equal(event.res.headers.get('cache-control'), 'no-store')
    assert.equal(runtimeCalls, 0)
    assert.equal(handlerCalls, 0)

    req.rawHeaders = ['content-type', 'application/json']
    enabled = false
    assert.deepEqual(await route(event), { error: 'Telemetria indisponível.' })
    assert.equal(event.res.status, 503)
    assert.equal(event.res.headers.get('cache-control'), 'no-store')
    assert.equal(handlerCalls, 0)

    enabled = true
    assert.deepEqual(await route(event), response.body)
    assert.equal(event.res.status, 401)
    assert.equal(event.res.headers.get('cache-control'), 'no-store')
    assert.equal(handlerCalls, 1)
  })
}
