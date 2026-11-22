import { expect, it } from 'vitest'
import { createLibraryJobLinks } from '../../packages/connector/src/runtime/library-job-links.ts'

it('links and retains a terminal job when running telemetry was missed', () => {
  const links = createLibraryJobLinks()
  const sha256 = 'a'.repeat(64)
  links.remember('p', { name: 'part.gcode', sha256, plate: 2 }, 100)
  const snapshot = {
    printerKey: 'p',
    observedAt: 200,
    state: 'idle' as const,
    lastJob: {
      filename: 'part.gcode',
      outcome: 'completed' as const,
      endedAt: 190,
    },
  }
  expect(links.attach(snapshot).lastJob).toMatchObject({ sha256, plate: 2 })
  expect(links.attach(snapshot).lastJob).toMatchObject({ sha256, plate: 2 })
})
