import { expect, test } from '@playwright/test'
import { journeyEnabled, startJourneyHarness } from './harness.ts'
import type { startSdcpFixture } from './sdcp-fixture.ts'

if (journeyEnabled())
  test('SDCP status becomes stale and recovers without controls', async ({
    browser,
  }) => {
    test.setTimeout(300_000)
    const journey = await startJourneyHarness({ browser, simulator: 'sdcp' })
    try {
      const sim = journey.vendor?.raw as Awaited<
        ReturnType<typeof startSdcpFixture>
      >
      await journey.expectLiveTelemetry()
      const row = journey.farmRow()
      await expect(row).toContainText('Imprimindo')
      await journey.expectProgress(0.25)
      await expect(
        row.getByRole('button', { name: /^(Pausar|Retomar|Cancelar)$/ }),
      ).toHaveCount(0)
      sim.setOnline(false)
      await expect(row).not.toContainText('Imprimindo', { timeout: 90_000 })
      sim.setProgress(40)
      sim.setOnline(true)
      await journey.expectProgress(0.4)
      await expect(row).toContainText('Imprimindo')
    } finally {
      await journey.close()
    }
  })
