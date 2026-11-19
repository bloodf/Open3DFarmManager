import { isMockSim } from './mocks/env.ts'
import { startSpoolmanMock } from './mocks/spoolman-mock.ts'
import { seedSpoolman } from './spoolman.ts'
const close: (() => Promise<void>)[] = []
try {
  const spoolmanMock = isMockSim() ? await startSpoolmanMock() : undefined
  if (spoolmanMock) close.push(() => spoolmanMock.close())
  const spoolman =
    spoolmanMock?.origin ??
    process.env.SIM_SPOOLMAN_URL ??
    'http://127.0.0.1:7912'
  console.log(await seedSpoolman(spoolman))
} catch (error) {
  console.error(
    error instanceof Error ? error.message : 'Simulator seed failed',
  )
  process.exitCode = 1
} finally {
  await Promise.all(close.map((stop) => stop()))
}
