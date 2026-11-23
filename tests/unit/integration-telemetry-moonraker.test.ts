// spec-derived, not captured: https://moonraker.readthedocs.io/en/latest/external_api/printer/
import { expect, test } from 'vitest'
import { parseMoonrakerSnapshot } from '../../packages/connector/src/moonraker/parse.ts'
import { startMoonrakerMock } from '../../packages/sim-tools/src/mocks/index.ts'
import {
  OBSERVATION_FRESH_MS,
  projectHistory,
} from '../../apps/farm/server/utils/integration-telemetry.ts'

test('a Moonraker loopback outage leaves a gap after the last fresh observation', async () => {
  const simulator = await startMoonrakerMock({
    initial: { state: 'printing', progress: 0.25 },
  })
  const observedAt = 1000
  const url = new URL(
    '/printer/objects/query?webhooks&print_stats&virtual_sdcard',
    simulator.origin,
  )
  const printer = await (async () => {
    try {
      const response = await fetch(url)
      expect(response.ok).toBe(true)
      return parseMoonrakerSnapshot(await response.text(), {
        observedAt,
        printerKey: 'sim-moonraker',
      }).printer
    } finally {
      await simulator.close()
    }
  })()
  await expect(fetch(url)).rejects.toThrow()
  const staleAt = observedAt + OBSERVATION_FRESH_MS
  const until = staleAt + 1000
  const history = projectHistory([{ state: printer }], observedAt, until)
  expect(history.metrics[0]?.progress).toEqual({ value: 0.25, unit: 'ratio' })
  expect(history.intervals).toEqual([
    { from: observedAt, until: staleAt, state: 'printing' },
    { from: staleAt, until, state: 'gap' },
  ])
})
