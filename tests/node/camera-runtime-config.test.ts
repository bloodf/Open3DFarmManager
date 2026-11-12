import test from 'node:test'
import assert from 'node:assert/strict'
import { parseCameraRuntimeConfig } from '../../packages/connector/src/config/camera.ts'

const assignment = '11111111-1111-4111-8111-111111111111'
const valid = {
  helper: { path: '/opt/connector/rtsp-ingest', sha256: 'a'.repeat(64) },
  cameras: [
    {
      cameraId: 'cam-1',
      assignmentId: assignment,
      source: { address: '192.0.2.10', port: 8554, path: '/stream' },
    },
  ],
}

test('opt-in camera config accepts literal sources for runtime assignments', () => {
  const config = parseCameraRuntimeConfig(valid, [assignment])
  assert.equal(config.maxSessions, 1)
  assert.equal(config.cameras[0]?.source.address, '192.0.2.10')
})

test('camera config rejects names, credentials, foreign assignments and unbounded sessions', () => {
  const camera = valid.cameras[0]!
  for (const changed of [
    {
      ...valid,
      cameras: [
        { ...camera, source: { ...camera.source, address: 'camera.local' } },
      ],
    },
    {
      ...valid,
      cameras: [
        { ...camera, source: { ...camera.source, path: '/user:pw@stream' } },
      ],
    },
    {
      ...valid,
      cameras: [
        { ...camera, source: { ...camera.source, path: '/s?token=x' } },
      ],
    },
    {
      ...valid,
      cameras: [
        { ...camera, source: { ...camera.source, url: 'rtsp://u:p@h/' } },
      ],
    },
    {
      ...valid,
      cameras: [
        { ...camera, assignmentId: '22222222-2222-4222-8222-222222222222' },
      ],
    },
    { ...valid, cameras: [camera, { ...camera, cameraId: 'cam-2' }] },
    { ...valid, helper: { ...valid.helper, path: 'relative/helper' } },
    { ...valid, maxSessions: 5 },
  ])
    assert.throws(() => parseCameraRuntimeConfig(changed, [assignment]))
})
