import { expect, test } from 'vitest'
import { get } from 'node:http'
import type { AddressInfo } from 'node:net'
import { createCameraServer } from '../../packages/sim-cams/src/server.ts'

async function start() {
  const camera = await createCameraServer()
  await new Promise<void>((resolve) =>
    camera.server.listen(0, '127.0.0.1', resolve),
  )
  return {
    camera,
    origin: `http://127.0.0.1:${(camera.server.address() as AddressInfo).port}`,
  }
}
test('snapshot returns a bounded JPEG, HEAD omits the body, unknown paths fail', async () => {
  const { camera, origin } = await start()
  try {
    const response = await fetch(`${origin}/?action=snapshot`)
    expect(response.headers.get('content-type')).toBe('image/jpeg')
    const bytes = new Uint8Array(await response.arrayBuffer())
    expect([...bytes.slice(0, 2)]).toEqual([255, 216])
    expect([...bytes.slice(-2)]).toEqual([255, 217])
    expect(bytes.length).toBeLessThan(100_000)
    expect(
      await (
        await fetch(`${origin}/?action=snapshot`, { method: 'HEAD' })
      ).text(),
    ).toBe('')
    expect((await fetch(`${origin}/missing`)).status).toBe(404)
    expect(
      (await fetch(`${origin}/?action=snapshot`, { method: 'POST' })).status,
    ).toBe(405)
  } finally {
    await camera.close()
  }
})
test('MJPEG includes framing and frees disconnected streams', async () => {
  const { camera, origin } = await start()
  try {
    await new Promise<void>((resolve, reject) => {
      const request = get(`${origin}/?action=stream`, (response) => {
        response.once('data', (bytes: Buffer) => {
          try {
            expect(bytes.toString()).toContain('--frame')
            expect(camera.activeStreams).toBe(1)
          } catch (error) {
            reject(error)
          }
          request.destroy()
          resolve()
        })
      })
      request.once('error', reject)
    })
    for (let i = 0; i < 20 && camera.activeStreams; i++)
      await new Promise((resolve) => setTimeout(resolve, 10))
    expect(camera.activeStreams).toBe(0)
  } finally {
    await camera.close()
  }
})
