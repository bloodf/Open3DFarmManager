import test from 'node:test'
import assert from 'node:assert/strict'
import {
  assertSignallingRuntimeBoundary,
  signallingBuildEnabled,
} from '../../apps/farm/server/services/signalling-build-policy.ts'

test('signalling build opt-in is explicit and cannot be supplied as a string flag', () => {
  for (const value of [undefined, {}, { enabled: false }])
    assert.equal(signallingBuildEnabled(value), false)
  assert.equal(signallingBuildEnabled({ enabled: true }), true)
  for (const value of [null, true, 'true', { enabled: 'true' }, { enabled: 1 }])
    assert.throws(() => signallingBuildEnabled(value))
})

test('runtime enablement requires the dedicated compiled node-server boundary', () => {
  const supported = {
    runtimeEnabled: true,
    buildEnabled: true,
    nativeWebSocketCompiled: true,
    preset: 'node-server',
  }
  assert.doesNotThrow(() => assertSignallingRuntimeBoundary(supported))
  for (const value of [
    { ...supported, buildEnabled: false },
    { ...supported, nativeWebSocketCompiled: false },
    { ...supported, preset: 'bun' },
  ])
    assert.throws(() => assertSignallingRuntimeBoundary(value))
  assert.doesNotThrow(() =>
    assertSignallingRuntimeBoundary({
      runtimeEnabled: false,
      buildEnabled: false,
      nativeWebSocketCompiled: false,
      preset: 'node-server',
    }),
  )
})
