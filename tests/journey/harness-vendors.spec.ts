import { expect, test } from '@playwright/test'
import {
  journeyEnabled,
  startJourneyHarness,
  type JourneyHarness,
  type VendorName,
} from './harness.ts'

// Opt-in: OPENFARM_JOURNEY=1. For every vendor simulator the harness starts a
// disposable database, the farm app, a Connector configured for that vendor
// and the loopback simulator, then the browser must reach live telemetry.
// Without the opt-in no test is registered, so nothing starts by accident.
const VENDORS = [
  'bambu',
  'creality',
  'anycubic',
  'kobralink',
] as const satisfies readonly VendorName[]

type Raw = Record<string, any> // eslint-disable-line @typescript-eslint/no-explicit-any
const TERMINAL: Record<
  (typeof VENDORS)[number],
  { finished(raw: unknown): boolean; failed(raw: unknown): boolean }
> = {
  bambu: {
    finished: (raw) => (raw as Raw).gcodeState === 'FINISH',
    failed: (raw) => (raw as Raw).gcodeState === 'FAILED',
  },
  creality: {
    finished: (raw) =>
      (raw as Raw).state.state === 0 &&
      (raw as Raw).state.printProgress === 100,
    failed: (raw) => (raw as Raw).state.err === 1,
  },
  anycubic: {
    finished: (raw) => (raw as Raw).lifecycle.state === 'finished',
    failed: (raw) => (raw as Raw).lifecycle.state === 'error',
  },
  kobralink: {
    finished: (raw) => (raw as Raw).state.kobraState === 'finished',
    failed: (raw) => (raw as Raw).state.kobraState === 'failed',
  },
}

const DISCOVERABLE: ReadonlySet<VendorName> = new Set(['creality', 'anycubic'])

if (journeyEnabled())
  for (const vendor of VENDORS)
    test.describe(`journey harness: ${vendor}`, () => {
      test.describe.configure({ mode: 'serial' })
      let harness: JourneyHarness | undefined

      test.beforeAll(async ({ browser }) => {
        test.setTimeout(20 * 60_000)
        harness = await startJourneyHarness({
          browser,
          simulator: vendor,
          openFarmInspector: true,
          // Bambu control is opt-in; the read-only journey leaves it off
          // except for the one binding that proves the option is accepted.
          ...(vendor === 'bambu' ? { control: true } : {}),
        })
      })

      test.afterAll(async () => {
        test.setTimeout(2 * 60_000)
        await harness?.close()
        harness = undefined
      })

      test(`${vendor} simulator reaches live telemetry in the browser`, async () => {
        test.setTimeout(2 * 60_000)
        const journey = harness
        if (!journey) throw new Error('Harness did not start')
        try {
          expect(journey.simulator).toBe(vendor)
          expect(new URL(journey.origin).hostname).toBe('127.0.0.1')
          expect(journey.vendor?.name).toBe(vendor)
          await journey.expectLiveTelemetry()
          // A scripted progress step from the simulator reaches the page.
          journey.controls.setProgress(75)
          await journey.expectProgress(0.75)
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

      // The finish/fail handles drive the vendor's own terminal state; the
      // per-brand specs assert how the page renders it.
      test(`${vendor} simulator finish and fail controls reach the simulator`, async () => {
        const journey = harness
        const sim = journey?.vendor
        if (!journey || !sim) throw new Error('Harness did not start')
        journey.controls.finishPrint()
        expect(TERMINAL[vendor].finished(sim.raw)).toBe(true)
        journey.controls.setProgress(40)
        journey.controls.failPrint()
        expect(TERMINAL[vendor].failed(sim.raw)).toBe(true)
        expect(journey.simulatorObservation()).toMatchObject({ failure: false })
      })

      // Bambu and KobraLink have no network probe step to exercise.
      if (DISCOVERABLE.has(vendor))
        test(`${vendor} discovery probe answers on loopback`, async () => {
          const journey = harness
          if (!journey) throw new Error('Harness did not start')
          const discovery = journey.discovery
          if (!discovery) throw new Error('Discovery responder missing')
          expect(discovery.host).toBe('127.0.0.1')
          expect(await discovery.probe()).toMatchObject({
            vendor,
            host: '127.0.0.1',
          })
        })
    })
