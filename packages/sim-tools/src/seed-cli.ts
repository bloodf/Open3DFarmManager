import { seedSpoolman } from './spoolman.ts'
try {
  console.log(
    await seedSpoolman(process.env.SIM_SPOOLMAN_URL ?? 'http://127.0.0.1:7912'),
  )
} catch (error) {
  console.error(
    error instanceof Error ? error.message : 'Simulator seed failed',
  )
  process.exitCode = 1
}
