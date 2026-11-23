import { isMockSim } from './mocks/env.ts'
import { startMoonrakerMock } from './mocks/moonraker-mock.ts'
import { startSpoolmanMock } from './mocks/spoolman-mock.ts'
import { startCameraMock } from './camera-mock.ts'
import { Effect } from 'effect'
import { probePrinter } from './probe.ts'
import {
  verifyFourTools,
  verifyToolSwitching,
  verifyWebcam,
  verifyCamera,
} from './verify.ts'
import { seedSpoolman } from './spoolman.ts'

const close: (() => Promise<void>)[] = []
try {
  const sv06Mock = isMockSim()
    ? await startMoonrakerMock({ profile: 'sv06' })
    : undefined
  if (sv06Mock) close.push(() => sv06Mock.close())
  const sv06 =
    sv06Mock?.origin ?? process.env.SIM_SV06_URL ?? 'http://127.0.0.1:7125'
  const u1Mock = isMockSim()
    ? await startMoonrakerMock({ profile: 'u1' })
    : undefined
  if (u1Mock) close.push(() => u1Mock.close())
  const u1 = u1Mock?.origin ?? process.env.SIM_U1_URL ?? 'http://127.0.0.1:7126'
  const spoolmanMock = isMockSim() ? await startSpoolmanMock() : undefined
  if (spoolmanMock) close.push(() => spoolmanMock.close())
  const spoolman =
    spoolmanMock?.origin ??
    process.env.SIM_SPOOLMAN_URL ??
    'http://127.0.0.1:7912'
  const cameraMock = isMockSim() ? await startCameraMock() : undefined
  if (cameraMock) close.push(() => cameraMock.close())
  const camera =
    cameraMock?.cameraUrl ??
    process.env.SIM_CAMERA_URL ??
    'http://127.0.0.1:8112'
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
  await verifyToolSwitching(u1)
  await verifyWebcam(sv06)
  await verifyWebcam(u1)
  await verifyCamera(camera)
  const first = await seedSpoolman(spoolman)
  const second = await seedSpoolman(spoolman)
  if (JSON.stringify(first) !== JSON.stringify(second))
    throw new Error('Seed was not repeatable')
  console.log(
    'SIM_FULL_OK: 2 ready printers, 4 tools switched with saved state kept over restart, webcams, synthetic JPEG and 6 seeded spools',
  )
} catch (error) {
  console.error(
    error instanceof Error ? error.message : 'Simulator integration failed',
  )
  process.exitCode = 1
} finally {
  await Promise.all(close.map((stop) => stop()))
}
