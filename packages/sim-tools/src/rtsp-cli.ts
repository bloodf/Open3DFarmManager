import { isMockSim } from './mocks/env.ts'
import { startCameraMock } from './camera-mock.ts'
import { parseRtspUrl, verifyRtsp } from './rtsp.ts'

const budgetMs = 60_000
const started = Date.now()
const close: (() => Promise<void>)[] = []
try {
  const urlMock = isMockSim() ? await startCameraMock() : undefined
  if (urlMock) close.push(() => urlMock.close())
  const url =
    urlMock?.rtspUrl ?? process.env.SIM_RTSP_URL ?? 'rtsp://127.0.0.1:8554/test'
  parseRtspUrl(url) // invalid input is not retryable
  while (true) {
    const remaining = budgetMs - (Date.now() - started)
    try {
      const packets = await verifyRtsp(url, {
        timeoutMs: Math.min(15_000, Math.max(remaining, 1000)),
      })
      console.log(`SIM_RTSP_OK: ${packets} RTP packets received over RTSP/TCP`)
      break
    } catch (error) {
      if (remaining <= 1000) throw error
      await new Promise((resolve) => setTimeout(resolve, 1000))
    }
  }
} catch (error) {
  console.error(
    error instanceof Error ? error.message : 'RTSP verification failed',
  )
  process.exitCode = 1
} finally {
  await Promise.all(close.map((stop) => stop()))
}
