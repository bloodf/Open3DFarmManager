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
      await import('../../apps/farm/server/api/connector/telemetry/challenge.post.ts')
    ).default,
  ],
] as const
after(() => {
  hooks.deregister()
  Reflect.deleteProperty(globalThis, token)
})

const good = ['content-type', 'application/json']
for (const [path, route] of routes) {
  const run = async (rawHeaders: string[], method = 'POST') => {
    const req = new IncomingMessage(new Socket())
    req.method = method
    req.url = path
    req.rawHeaders = rawHeaders
    const event = {
      '~app': { node: { req } },
      res: { headers: new Headers(), status: 200 },
    }
    runtimeCalls = 0
    handlerCalls = 0
    const body = await route(event as unknown as Parameters<typeof route>[0])
    return { body, event }
  }
  test(`${path} enforces the boundary before runtime and forwards runtime responses`, async () => {
    enabled = true
    let r = await run([...good, 'cookie', 'session=synthetic'])
    assert.deepEqual(r.body, { error: 'Solicitação inválida.' })
    assert.equal(r.event.res.status, 400)
    assert.equal(r.event.res.headers.get('cache-control'), 'no-store')
    assert.equal(runtimeCalls, 0)
    assert.equal(handlerCalls, 0)

    r = await run(['content-type', 'application/json'], 'GET')
    assert.deepEqual(r.body, { error: 'Solicitação inválida.' })
    assert.equal(r.event.res.status, 400)
    assert.equal(r.event.res.headers.get('cache-control'), 'no-store')
    assert.equal(runtimeCalls, 0)
    assert.equal(handlerCalls, 0)

    enabled = false
    r = await run(good)
    assert.deepEqual(r.body, { error: 'Telemetria indisponível.' })
    assert.equal(r.event.res.status, 503)
    assert.equal(r.event.res.headers.get('cache-control'), 'no-store')
    assert.equal(runtimeCalls, 1)
    assert.equal(handlerCalls, 0)

    enabled = true
    r = await run(good)
    assert.deepEqual(r.body, response.body)
    assert.equal(r.event.res.status, 401)
    assert.equal(r.event.res.headers.get('cache-control'), 'no-store')
    assert.equal(runtimeCalls, 1)
    assert.equal(handlerCalls, 1)
  })
}
