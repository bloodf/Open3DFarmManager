import { expect, test } from '@playwright/test'
import {
  journeyEnabled,
  startJourneyHarness,
  type JourneyHarness,
} from './harness.ts'

// Opt-in: OPENFARM_JOURNEY=1. Starts a disposable database, the farm app, a
// Connector runtime and the Moonraker fixture, all on loopback.
test.describe('journey harness', () => {
  test.skip(!journeyEnabled(), 'Set OPENFARM_JOURNEY=1 to run the journeys')
  test.describe.configure({ mode: 'serial' })
  let harness: JourneyHarness | undefined

  test.beforeAll(async ({ browser }) => {
    test.setTimeout(20 * 60_000)
    harness = await startJourneyHarness({
      browser,
      simulator: 'moonraker-fixture',
    })
  })

  test.afterAll(async () => {
    test.setTimeout(2 * 60_000)
    await harness?.close()
    harness = undefined
  })

  test('Moonraker fixture reaches live telemetry in the browser', async () => {
    test.setTimeout(2 * 60_000)
    const journey = harness
    if (!journey) throw new Error('Harness did not start')
    try {
      await journey.expectLiveTelemetry()
      const row = await journey.openFarm()
      // Printing state and a scripted progress step reach the page.
      await journey.advanceSimulator()
      await expect(row.getByRole('progressbar')).toHaveAttribute(
        'value',
        '0.75',
        { timeout: 10_000 },
      )
      expect(journey.simulatorObservation()).toMatchObject({
        failure: false,
      })
    } catch (error) {
      console.error(
        JSON.stringify(journey.simulatorObservation()),
        journey.appLog(),
      )
      throw error
    }
  })
})
