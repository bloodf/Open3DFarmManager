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

      const expectLiveStatus = async (status: string) => {
        await expect(
          row.getByText('Conexão direta autenticada', { exact: true }),
        ).toBeVisible({ timeout: 45_000 })
        await expect(
          row
            .getByRole('definition')
            .filter({ hasText: `PreForm informou: ${status}` }),
        ).toBeVisible({ timeout: 15_000 })
        await expect(row.getByRole('progressbar')).toHaveCount(0)
        await expect(
          row.getByRole('button', {
            name: /pausar|retomar|cancelar|iniciar impressão/i,
          }),
        ).toHaveCount(0)
      }

      await test.step('PreForm returns Printing', async () => {
        await expectLiveStatus('Printing')
      })
      await test.step('PreForm returns 503 and the live reading is withdrawn', async () => {
        const responses = fixture.simulator.deviceResponseStatuses
        const previousCount = responses.length
        fixture.loseConnection()
        await expect
          .poll(() => responses.slice(previousCount), {
            message: 'PreForm must serve a 503 to a Connector poll',
            timeout: 15_000,
          })
          .toContain(503)
        await expect(
          row.getByText(
            'Conexão direta indisponível. Exibindo a última observação.',
            { exact: true },
          ),
        ).toBeVisible({ timeout: 30_000 })
        await expect(
          row.getByText(/Dados desatualizados/).first(),
        ).toBeVisible()
      })
      await test.step('PreForm recovers and returns Idle', async () => {
        fixture.recover()
        await expectLiveStatus('Idle')
      })
      expect(new Set(fixture.simulator.requests)).toEqual(
        new Set(['GET /devices/']),
      )
    } finally {
      await journey.close()
    }
  })
}
