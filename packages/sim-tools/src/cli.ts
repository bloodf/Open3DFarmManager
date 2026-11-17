import { Effect } from 'effect'
import { probePrinter } from './probe.ts'

export interface SmokeTarget {
  name: string
  origin: string
}

export const profileTargets: SmokeTarget[] = [
  { name: 'sv06', origin: process.env.SIM_SV06_URL ?? 'http://127.0.0.1:7125' },
  { name: 'u1', origin: process.env.SIM_U1_URL ?? 'http://127.0.0.1:7126' },
]

export async function runSmoke(
  targets: SmokeTarget[] = profileTargets,
  probe: (origin: string) => Promise<unknown> = (origin) =>
    Effect.runPromise(probePrinter(origin)),
): Promise<boolean> {
  const deadline = Date.now() + 90_000
  const pending = new Set(targets)
  const ready = new Set<string>()
  const lastErrors = new Map<string, string>()

  while (pending.size > 0 && Date.now() < deadline) {
    for (const target of [...pending]) {
      try {
        await probe(target.origin)
        ready.add(target.name)
        pending.delete(target)
      } catch (error) {
        lastErrors.set(
          target.name,
          error instanceof Error ? error.message : 'probe failed',
        )
      }
    }
    if (pending.size > 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 1000))
    }
  }

  for (const target of targets) {
    if (ready.has(target.name))
      console.log(
        `SIM_SMOKE_READY: ${target.name} Moonraker connected and Klipper ready`,
      )
    else
      console.error(
        `SIM_SMOKE_NOT_READY: ${target.name} did not reach ready state within 90 seconds${lastErrors.has(target.name) ? ` (${lastErrors.get(target.name)})` : ''}`,
      )
  }

  return pending.size === 0
}

if (import.meta.url === `file://${process.argv[1]}`) {
  if (!(await runSmoke())) {
    console.error('Check Compose logs.')
    process.exitCode = 1
  }
}
