import { createServer } from 'node:net'
import { expect, test } from '@playwright/test'
import { openLocalStatus } from '../../packages/connector/src/status/local.ts'
import { probeRtcBackend } from '../../packages/connector/src/webrtc/rtc-backend.ts'

async function freePort() {
  const probe = createServer()
  await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve))
  const address = probe.address()
  if (!address || typeof address === 'string') throw new Error('no port')
  await new Promise<void>((resolve) => probe.close(() => resolve()))
  return address.port
}

// Connector local status page in system Chrome, with the native module
// reported absent. Loopback only; no native binary and no external network.
test('local status page names the degraded RTC backend', async ({ page }) => {
  const rtc = await probeRtcBackend(() =>
    Promise.reject(
      Object.assign(new Error('missing'), { code: 'ERR_MODULE_NOT_FOUND' }),
    ),
  )
  const port = await freePort()
  const status = await openLocalStatus({
    port,
    read: () => ({
      queueDepth: 0,
      delivered: 0,
      retries: 0,
      credentialExpired: false,
      rtc,
    }),
    onError: (error) => {
      throw error
    },
  })
  try {
    await page.goto(`http://127.0.0.1:${port}/`)
    await expect(page.getByText('Backend WebRTC')).toBeVisible()
    await expect(page.getByText('modo somente leitura degradado')).toBeVisible()
    const json = await page.request.get(`http://127.0.0.1:${port}/status`)
    expect((await json.json()).rtc).toEqual({
      backend: 'none',
      mode: 'read-only-degraded',
      reason: 'native-binary-missing',
    })
  } finally {
    await status.close()
  }
})
