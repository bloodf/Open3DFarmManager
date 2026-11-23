import { seedSpoolman } from './spoolman.ts'

const origin = process.env.SIM_SPOOLMAN_URL ?? 'http://127.0.0.1:7912'
const budgetMs = 90_000
const started = Date.now()

try {
  let first: Awaited<ReturnType<typeof seedSpoolman>> | undefined
  while (true) {
    try {
      first = await seedSpoolman(origin)
      break
    } catch (error) {
      if (Date.now() - started >= budgetMs - 1000) throw error
      await new Promise((resolve) => setTimeout(resolve, 1000))
    }
  }
  const second = await seedSpoolman(origin)
  if (JSON.stringify(first) !== JSON.stringify(second))
    throw new Error('Seed was not repeatable')
  console.log(
    `SIM_SPOOLMAN_OK: ${second.vendors} vendors, ${second.filaments} filaments, ${second.spools} seeded spools`,
  )
} catch (error) {
  console.error(
    error instanceof Error ? error.message : 'Spoolman verification failed',
  )
  process.exitCode = 1
}
