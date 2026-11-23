import { verifyCamera } from './verify.ts'

const origin = process.env.SIM_CAMERA_URL ?? 'http://127.0.0.1:8112'
const budgetMs = 60_000
const started = Date.now()

try {
  while (true) {
    try {
      const bytes = await verifyCamera(origin)
      console.log(`SIM_CAMS_OK: ${bytes}-byte JPEG snapshot`)
      break
    } catch (error) {
      if (Date.now() - started >= budgetMs - 1000) throw error
      await new Promise((resolve) => setTimeout(resolve, 1000))
    }
  }
} catch (error) {
  console.error(
    error instanceof Error ? error.message : 'Camera verification failed',
  )
  process.exitCode = 1
}
