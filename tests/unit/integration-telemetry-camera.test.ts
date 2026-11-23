// spec-derived, not captured: https://www.rfc-editor.org/rfc/rfc2326
import { once } from 'node:events'
import { connect } from 'node:net'
import { expect, test } from 'vitest'
import { startCameraMock } from '../../packages/sim-tools/src/camera-mock.ts'
import { freshWorld, ids } from '../helpers/api-v1-contract/world.ts'

test('an RTSP fixture disconnect leaves only a bounded, revocable OpenFarm link', async () => {
  const camera = await startCameraMock({ token: 'fixture-camera-secret' })
  const source = new URL(camera.rtspUrl)
  const socket = connect(Number(source.port), source.hostname)
  let closed = false
  try {
    await once(socket, 'connect')
    const response = once(socket, 'data')
    socket.write(`OPTIONS ${source.href} RTSP/1.0\r\nCSeq: 1\r\n\r\n`)
    expect(String((await response)[0])).toMatch(/^RTSP\/1\.0 200 OK/)
    const world = freshWorld()
    const app = world.addApp([
      { printerId: ids.printerA1, scopes: ['camera:view'] },
    ])
    const [grant] = await world.authStore.effectiveGrants(app.appId)
    const link = world.auth.issueCameraLink(app.appId, ids.printerA1, grant!.id)
    expect(link.url).toMatch(/^\/camera-view#[A-Za-z0-9_.-]+$/)
    expect(link.url).not.toContain(source.host)
    expect(link.url).not.toContain('fixture-camera-secret')
    const ticket = new URL(link.url, 'https://farm.example.invalid').hash.slice(
      1,
    )
    await expect(world.auth.redeemCameraTicket(ticket)).resolves.toMatchObject({
      id: ids.printerA1,
    })
    await expect(
      world.auth.redeemCameraTicket(ticket + 'x'),
    ).resolves.toBeNull()

    const disconnected = once(socket, 'close')
    await camera.close()
    closed = true
    await disconnected
    world.clock = link.expiresAt
    await expect(world.auth.redeemCameraTicket(ticket)).resolves.toBeNull()

    const fresh = world.auth.issueCameraLink(
      app.appId,
      ids.printerA1,
      grant!.id,
    )
    world.disableGrants(app)
    await expect(
      world.auth.redeemCameraTicket(fresh.url.split('#')[1]!),
    ).resolves.toBeNull()
  } finally {
    socket.destroy()
    if (!closed) await camera.close()
  }
})
