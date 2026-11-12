import { verifyRtsp } from './rtsp.ts'

const url = process.env.SIM_RTSP_URL ?? 'rtsp://127.0.0.1:8554/test'
const deadline = Date.now() + 60_000
while (true) {
  try {
    const packets = await verifyRtsp(url)
    console.log(`SIM_RTSP_OK: ${packets} RTP packets received over RTSP/TCP`)
    break
  } catch (error) {
    if (Date.now() >= deadline) {
      console.error(
        error instanceof Error ? error.message : 'RTSP verification failed',
      )
      process.exitCode = 1
      break
    }
    await new Promise((resolve) => setTimeout(resolve, 1000))
  }
}
