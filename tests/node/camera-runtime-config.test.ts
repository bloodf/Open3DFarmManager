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
      source: { address: '192.168.1.10', port: 8554, path: '/stream' },
    },
  ],
}

test('opt-in camera config accepts literal sources for runtime assignments', () => {
  for (const address of ['127.0.0.1', '10.1.2.3', 'fd12::5', 'fe80::1'])
    parseCameraRuntimeConfig(
      {
        ...valid,
        cameras: [
          {
            ...valid.cameras[0],
            source: { ...valid.cameras[0]!.source, address },
          },
        ],
      },
      [assignment],
    )
  const config = parseCameraRuntimeConfig(valid, [assignment])
  assert.equal(config.maxSessions, 1)
  assert.equal(config.cameras[0]?.source.address, '192.168.1.10')
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
        { ...camera, source: { ...camera.source, address: '203.0.113.7' } },
      ],
    },
    {
      ...valid,
      cameras: [
        { ...camera, source: { ...camera.source, address: '169.254.169.254' } },
      ],
    },
    {
      ...valid,
      cameras: [
        { ...camera, source: { ...camera.source, address: 'fd00:ec2:0::254' } },
      ],
    },
    {
      ...valid,
      cameras: [
        {
          ...camera,
          source: { ...camera.source, address: '::ffff:127.0.0.1' },
        },
      ],
    },
    {
      ...valid,
      cameras: [
        { ...camera, source: { ...camera.source, address: '::ffff:7f00:1' } },
      ],
    },
    {
      ...valid,
      cameras: [
        { ...camera, source: { ...camera.source, address: 'fe80::1%eth0' } },
      ],
    },
    {
      ...valid,
      cameras: [
        { ...camera, source: { ...camera.source, address: '192.168.1.255' } },
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
