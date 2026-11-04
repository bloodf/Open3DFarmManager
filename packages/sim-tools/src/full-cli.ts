import { Effect } from 'effect'
import { probePrinter } from './probe.ts'
import { verifyFourTools, verifyWebcam, verifyCamera } from './verify.ts'
import { seedSpoolman } from './spoolman.ts'

const sv06 = process.env.SIM_SV06_URL ?? 'http://127.0.0.1:7125'
const u1 = process.env.SIM_U1_URL ?? 'http://127.0.0.1:7126'
const spoolman = process.env.SIM_SPOOLMAN_URL ?? 'http://127.0.0.1:7912'
const camera = process.env.SIM_CAMERA_URL ?? 'http://127.0.0.1:8112'
try {
  for (const origin of [sv06, u1]) {
    const deadline = Date.now() + 90_000
    while (true) {
      try {
        await Effect.runPromise(probePrinter(origin))
        break
      } catch (error) {
        if (Date.now() >= deadline) throw error
        await new Promise((resolve) => setTimeout(resolve, 1000))
      }
    }
  }
  await verifyFourTools(u1)
  await verifyWebcam(sv06)
  await verifyWebcam(u1)
  await verifyCamera(camera)
  const first = await seedSpoolman(spoolman)
  const second = await seedSpoolman(spoolman)
  if (JSON.stringify(first) !== JSON.stringify(second))
    throw new Error('Seed was not repeatable')
  console.log(
    'SIM_FULL_OK: 2 ready printers, 4 tools, webcams, synthetic JPEG and 6 seeded spools',
  )
} catch (error) {
  console.error(
    error instanceof Error ? error.message : 'Simulator integration failed',
  )
  process.exitCode = 1
}
