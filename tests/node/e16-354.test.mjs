// SPDX-License-Identifier: MIT
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { startCameraMock } from '../../packages/sim-tools/src/camera-mock.ts'
import { verifyRtsp } from '../../packages/sim-tools/src/rtsp.ts'
const exec = promisify(execFile)

test('camera mock serves CLI probes, media and faults', async () => {
  const camera = await startCameraMock()
  try {
    const [snapshot, rtsp] = await Promise.all([
      exec(process.execPath, ['packages/sim-tools/src/camera-cli.ts'], { env: { ...process.env, SIM_CAMERA_URL: camera.cameraUrl }, timeout: 10000 }),
      exec(process.execPath, ['packages/sim-tools/src/rtsp-cli.ts'], { env: { ...process.env, SIM_RTSP_URL: camera.rtspUrl }, timeout: 10000 }),
    ])
    assert.match(snapshot.stdout, /SIM_CAMS_OK/)
    assert.match(rtsp.stdout, /SIM_RTSP_OK/)
    const mjpeg = await fetch(`${camera.cameraUrl}/?action=stream`)
    assert.match(mjpeg.headers.get('content-type'), /multipart\/x-mixed-replace/)
    const mjpegReader = mjpeg.body.getReader()
    assert.ok((await mjpegReader.read()).value.length > 0)
    await mjpegReader.cancel()
    const flv = await fetch(camera.flvUrl)
    const reader = flv.body.getReader()
    assert.equal(Buffer.from((await reader.read()).value).subarray(0, 3).toString(), 'FLV')
    await reader.cancel()
    assert.equal((await fetch(camera.flvUrl + 'bad')).status, 403)
    camera.state.stall = true
    await assert.rejects(verifyRtsp(camera.rtspUrl, { timeoutMs: 200 }), /packets/)
    camera.state.stall = false; camera.state.disconnect = true
    await assert.rejects(verifyRtsp(camera.rtspUrl, { timeoutMs: 1000 }), /closed/)
  } finally { await camera.close() }
})

test('RTSP acceptance helper uses the in-process mock under OPENFARM_SIM=mock without compose', async () => {
  const { readFile } = await import('node:fs/promises')
  const source = await readFile(new URL('../helpers/rtc-farm-rtsp-camera.ts', import.meta.url), 'utf8')
  const mockAt = source.indexOf("OPENFARM_SIM?.trim().toLowerCase() === 'mock'")
  const overrideAt = source.indexOf("const override = join(")
  assert.ok(mockAt > 0 && overrideAt > mockAt, 'mock branch must precede the docker compose override')
  assert.doesNotMatch(source.slice(mockAt, overrideAt), /docker|mediamtx|compose/i)
})

test('camera mock close releases listeners and honors the requested RTSP port', async () => {
  const camera = await startCameraMock()
  const { port } = new URL(camera.rtspUrl)
  await camera.close()
  const again = await startCameraMock({ rtspPort: Number(port) })
  try { assert.equal(new URL(again.rtspUrl).port, port) } finally { await again.close() }
})
