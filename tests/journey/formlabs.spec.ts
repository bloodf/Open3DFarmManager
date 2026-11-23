import { expect, test } from '@playwright/test'
import { journeyEnabled, startJourneyHarness } from './harness.ts'
import type { startFormlabsJourneyFixture } from './formlabs-fixture.ts'

if (journeyEnabled()) {
  test('journey: Formlabs status, connection loss, recovery and unsupported controls', async ({
    browser,
  }) => {
    const journey = await startJourneyHarness({
      browser,
      simulator: 'formlabs',
    })
    try {
      const fixture = journey.vendor?.raw as Awaited<
        ReturnType<typeof startFormlabsJourneyFixture>
      >
      const row = await journey.openFarm()

      // PreForm reports a connected device but supplies no printer observation
      // timestamp. The Connector withholds telemetry both online and offline.
      const expectReadOnlyWithoutTelemetry = async () => {
        await expect(
          row.getByText('Conexão direta indisponível', {
            exact: true,
          }),
        ).toBeVisible({ timeout: 60_000 })
        await expect(row.getByText('Nenhum estado recebido')).toBeVisible()
        await expect(
          row.getByRole('button', { name: 'Pausar impressão' }),
        ).toBeDisabled()
        await expect(row.getByRole('progressbar')).toHaveCount(0)
        await expect(row.getByText('Imprimindo')).toHaveCount(0)
        await expect(
          row.getByRole('button', {
            name: /retomar|cancelar|iniciar impressão/i,
          }),
        ).toHaveCount(0)
      }
      const requests = fixture.simulator.requests
      const expectPollAfter = async (previousCount: number) => {
        await expect
          .poll(() => requests.length, { timeout: 20_000 })
          .toBeGreaterThan(previousCount)
        expect(new Set(requests)).toEqual(new Set(['GET /devices/']))
      }

      await test.step('Connected PreForm host with no observation timestamp', async () => {
        await expectPollAfter(0)
        await expectReadOnlyWithoutTelemetry()
      })
      await test.step('PreForm host returns 503', async () => {
        const previousCount = requests.length
        fixture.loseConnection()
        await expectPollAfter(previousCount)
        await expectReadOnlyWithoutTelemetry()
      })
      await test.step('PreForm host responds again without an observation timestamp', async () => {
        const previousCount = requests.length
        fixture.recover()
        await expectPollAfter(previousCount)
        await expectReadOnlyWithoutTelemetry()
      })
    } finally {
      await journey.close()
    }
  })
}
