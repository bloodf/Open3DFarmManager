import { Effect } from 'effect'
import { probePrinter } from './probe.ts'
import { isMockSim } from './mocks/env.ts'
import {
  startMoonrakerMock,
  type MoonrakerMockInstance,
} from './mocks/moonraker-mock.ts'

export interface SmokeTarget {
  name: string
  origin: string
}

export const profileTargets: SmokeTarget[] = [
  { name: 'sv06', origin: process.env.SIM_SV06_URL ?? 'http://127.0.0.1:7125' },
  { name: 'u1', origin: process.env.SIM_U1_URL ?? 'http://127.0.0.1:7126' },
]

export async function runSmoke(
  targets?: SmokeTarget[],
  probe: (origin: string) => Promise<unknown> = (origin) =>
    Effect.runPromise(probePrinter(origin)),
): Promise<boolean> {
  const explicitMode = process.env.OPENFARM_SIM?.trim().toLowerCase()
  const useMocks =
    targets === undefined &&
    isMockSim() &&
    (explicitMode === 'mock' ||
      (!process.env.SIM_SV06_URL && !process.env.SIM_U1_URL))

  const ownedMocks: MoonrakerMockInstance[] = []
  let resolvedTargets: SmokeTarget[]
  try {
    if (useMocks) {
      const sv06 = await startMoonrakerMock({ profile: 'sv06' })
      ownedMocks.push(sv06)
      const u1 = await startMoonrakerMock({ profile: 'u1' })
      ownedMocks.push(u1)
      resolvedTargets = [
        { name: 'sv06', origin: sv06.origin },
        { name: 'u1', origin: u1.origin },
      ]
    } else {
      resolvedTargets = targets ?? profileTargets
    }

    const deadline = Date.now() + 90_000
    const pending = new Set(resolvedTargets)
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

    for (const target of resolvedTargets) {
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
  } finally {
    await Promise.allSettled(ownedMocks.map((mock) => mock.close()))
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  if (!(await runSmoke())) {
    console.error('Check Compose logs.')
    process.exitCode = 1
  }
}
