import test from 'node:test'
import assert from 'node:assert/strict'
import { get } from 'node:http'
import type { ClientRequest } from 'node:http'
import type { AddressInfo } from 'node:net'
import { createCameraServer } from '../../packages/sim-cams/src/server.ts'

test(
  'Node runtime serves JPEG and enforces five simultaneous streams',
  { timeout: 5000 },
  async () => {
    const camera = await createCameraServer()
    await new Promise<void>((resolve) =>
      camera.server.listen(0, '127.0.0.1', resolve),
    )
    const origin = `http://127.0.0.1:${(camera.server.address() as AddressInfo).port}`
    const clients: ClientRequest[] = []
    try {
      const snapshot = await fetch(`${origin}/?action=snapshot`)
      assert.equal(snapshot.status, 200)
      assert.equal(snapshot.headers.get('content-type'), 'image/jpeg')
      assert.ok((await snapshot.arrayBuffer()).byteLength > 100)
      for (let index = 0; index < 5; index++) {
        await new Promise<void>((resolve, reject) => {
          const request = get(`${origin}/?action=stream`, (response) => {
            response.resume()
            resolve()
          })
          request.on('error', reject)
          clients.push(request)
        })
      }
      assert.equal(camera.activeStreams, 5)
      assert.equal((await fetch(`${origin}/?action=stream`)).status, 503)
    } finally {
      for (const request of clients) request.destroy()
      await camera.close()
      await camera.close()
    }
  },
)
