import { expect, test, vi } from 'vitest'
import {
  verifyFourTools,
  verifyWebcam,
  verifyCamera,
} from '../../packages/sim-tools/src/verify.ts'
import { serveTestServer } from './serve.ts'

test('four-tool acceptance fails when even one expected tool macro is missing', async () => {
  const objects = [
    'extruder',
    'extruder1',
    'extruder2',
    'extruder3',
    'gcode_macro T0',
    'gcode_macro T1',
    'gcode_macro T2',
    'gcode_macro T3',
    'save_variables',
  ]
  const server = await serveTestServer(() =>
    Response.json({ result: { objects } }),
  )
  try {
    expect(await verifyFourTools(server.url.origin)).toBe(9)
    objects.splice(objects.indexOf('gcode_macro T3'), 1)
    await expect(verifyFourTools(server.url.origin)).rejects.toThrow(
      'gcode_macro T3',
    )
  } finally {
    await server.stop()
  }
})
test('webcam acceptance rejects an empty webcam list', async () => {
  const server = await serveTestServer(() =>
    Response.json({ result: { webcams: [] } }),
  )
  try {
    await expect(verifyWebcam(server.url.origin)).rejects.toThrow()
  } finally {
    await server.stop()
  }
})
test('camera acceptance rejects HTML disguised as a snapshot', async () => {
  const server = await serveTestServer(
    () =>
      new Response('<html>error</html>', {
        headers: { 'Content-Type': 'image/jpeg' },
      }),
  )
  try {
    await expect(verifyCamera(server.url.origin)).rejects.toThrow('Invalid')
  } finally {
    await server.stop()
  }
})

test('oversized simulator responses are cancelled while streaming', async () => {
  const { readBytes } = await import('../../packages/sim-tools/src/body.ts')
  let cancelled = false
  const response = new Response(
    new ReadableStream({
      pull(controller) {
        controller.enqueue(new Uint8Array(100))
      },
      cancel() {
        cancelled = true
      },
    }),
  )
  await expect(readBytes(response, 150)).rejects.toThrow('size limit')
  expect(cancelled).toBe(true)
})

test('camera snapshot byte cap cancels a chunked JPEG and releases its reader', async () => {
  let cancelled = false
  const prefix = new Uint8Array(100_000)
  prefix.set([255, 216])
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(prefix)
      controller.enqueue(new Uint8Array([255, 217]))
    },
    cancel() {
      cancelled = true
    },
  })
  const fetchMock = vi
    .spyOn(globalThis, 'fetch')
    .mockResolvedValue(
      new Response(body, { headers: { 'Content-Type': 'image/jpeg' } }),
    )
  try {
    await expect(verifyCamera('http://127.0.0.1:8080')).rejects.toThrow(
      'Simulator response exceeds size limit',
    )
    expect(cancelled).toBe(true)
    expect(body.locked).toBe(false)
  } finally {
    fetchMock.mockRestore()
  }
})
