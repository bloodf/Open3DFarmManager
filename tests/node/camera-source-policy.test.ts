import test from 'node:test'
import assert from 'node:assert/strict'
import { createLocalCameraRegistry } from '../../packages/connector/src/camera/source-policy.ts'

test('registry snapshots configuration and resolves only the exact scope', () => {
  const scope = { farmId: 'farm', agentId: 'agent', printerId: 'printer' }
  const config = { cameraId: 'camera', scope, sourceHandle: 'local-reference' }
  const registry = createLocalCameraRegistry([config])
  scope.printerId = 'changed'
  config.sourceHandle = 'changed'
  const original = { farmId: 'farm', agentId: 'agent', printerId: 'printer' }
  assert.equal(
    registry.resolve({ cameraId: 'camera', scope: original }),
    'local-reference',
  )
  assert.equal(
    registry.resolve({ cameraId: 'missing', scope: original }),
    undefined,
  )
  for (const key of ['farmId', 'agentId', 'printerId'] as const) {
    assert.equal(
      registry.resolve({
        cameraId: 'camera',
        scope: { ...original, [key]: 'other' },
      }),
      undefined,
    )
  }
  assert.throws(
    () => createLocalCameraRegistry([config, config]),
    /Invalid camera configuration/,
  )
  assert.throws(
    () =>
      createLocalCameraRegistry([
        { ...config, sourceHandle: 'https://secret' },
      ]),
    /Invalid camera configuration/,
  )
  for (const bad of [
    { ...config, cameraId: 'https://secret' },
    { ...config, sourceHandle: 'x'.repeat(129) },
    { ...config, scope: { ...scope, farmId: 'bad/secret' } },
  ])
    assert.throws(
      () => createLocalCameraRegistry([bad]),
      /^Error: Invalid camera configuration$/,
    )
  assert.throws(
    () => createLocalCameraRegistry(Array(257).fill(config)),
    /^Error: Invalid camera configuration$/,
  )
})
