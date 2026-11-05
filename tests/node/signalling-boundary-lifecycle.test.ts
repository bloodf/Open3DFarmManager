import test from 'node:test'
import assert from 'node:assert/strict'
import { createSignallingBoundaryLifecycle } from '../../apps/farm/server/services/signalling-boundary-lifecycle.ts'
function app() {
  const options: { websocket?: unknown } = {}
  return {
    options,
    get websocket() {
      return options.websocket
    },
  }
}
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
test('opted-in build stays capped when disabled; enabled startup prepares no authority or routes', () => {
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
    assert.deepEqual(target.websocket, {
      serverOptions: { maxPayload: 12_288, perMessageDeflate: false },
    })
    assert.equal(Object.isFrozen(target.websocket), true)
    lifecycle.close()
  }
})
