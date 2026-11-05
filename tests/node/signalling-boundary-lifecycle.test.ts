import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { realpathSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { createSignallingBoundaryLifecycle } from '../../apps/farm/server/services/signalling-boundary-lifecycle.ts'
const nuxtRequire = createRequire(
  realpathSync(
    new URL('../../apps/farm/node_modules/nuxt/package.json', import.meta.url),
  ),
)
const builderRequire = createRequire(nuxtRequire.resolve('@nuxt/nitro-server'))
const nitroRequire = createRequire(
  builderRequire.resolve('nitropack/package.json'),
)
const { createApp: app } = await import(
  join(dirname(nitroRequire.resolve('h3')), 'index.mjs')
)
test('disabled startup does not touch adapter options or need an adapter', () => {
  const lifecycle = createSignallingBoundaryLifecycle()
  assert.equal(
    lifecycle.start({
      config: undefined,
      buildEnabled: false,
      nativeWebSocketCompiled: false,
      preset: 'unprepared',
      h3App: null,
    }),
    'disabled',
  )
  lifecycle.close()
  lifecycle.close()
})
test('runtime-only opt-in, unknown adapter, invalid config, and closed lifecycle reject', () => {
  for (const change of [
    { buildEnabled: false },
    { nativeWebSocketCompiled: false },
    { preset: 'bun' },
    { h3App: {} },
    { config: { enabled: 'true' } },
  ]) {
    const lifecycle = createSignallingBoundaryLifecycle()
    assert.throws(() =>
      lifecycle.start({
        config: { enabled: true },
        buildEnabled: true,
        nativeWebSocketCompiled: true,
        preset: 'node-server',
        h3App: app(),
        ...change,
      }),
    )
    lifecycle.close()
  }
  const closed = createSignallingBoundaryLifecycle()
  closed.close()
  assert.throws(() =>
    closed.start({
      config: { enabled: true },
      buildEnabled: true,
      nativeWebSocketCompiled: true,
      preset: 'node-server',
      h3App: app(),
    }),
  )
})
test('opted-in build stays capped when disabled; enabled startup prepares no authority or routes', async () => {
  for (const enabled of [false, true]) {
    const target = app(),
      lifecycle = createSignallingBoundaryLifecycle()
    assert.equal(
      lifecycle.start({
        config: { enabled },
        buildEnabled: true,
        nativeWebSocketCompiled: true,
        preset: 'node-server',
        h3App: target,
      }),
      enabled ? 'prepared' : 'disabled',
    )
    assert.deepEqual(target.websocket.serverOptions, {
      maxPayload: 12_288,
      perMessageDeflate: false,
      autoPong: false,
    })
    assert.equal(typeof target.websocket.hooks.upgrade, 'function')
    const resolved = await target.websocket.resolve(
      new Request('https://farm.example/ordinary'),
    )
    await assert.rejects(
      resolved.upgrade(new Request('https://farm.example/ordinary')),
      (error: unknown) => error instanceof Response && error.status === 503,
    )
    assert.equal(Object.isFrozen(target.websocket), true)
    lifecycle.close()
  }
})
