import { expect, test } from '@playwright/test'
import { journeyEnabled, startJourneyHarness } from './harness.ts'
import type { startFormlabsJourneyFixture } from './formlabs-fixture.ts'

if (journeyEnabled()) {
  test('journey: Formlabs status, remaining time, model binding, connection loss, recovery and unsupported controls', async ({
    browser,
  }) => {
    const journey = await startJourneyHarness({
      browser,
      simulator: 'formlabs',
      openFarmInspector: true,
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

      const remaining = row.getByLabel('Trabalho atual').getByRole('definition')

      await test.step('PreForm returns Printing with the remaining time', async () => {
        await expectLiveStatus('Printing')
        await expect(row.getByText('Tempo restante estimado')).toBeVisible()
        // 5 400 000 ms in the spec-derived fixture: 1 h 30 min.
        await expect(remaining.filter({ hasText: /1\D+30/ })).toBeVisible()
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
        await expect(row.getByText('Tempo restante estimado')).toHaveCount(0)
      })
      await test.step('PreForm reports another model and the reading is withheld', async () => {
        fixture.reportModel('Form 4L')
        await expect(
          row.getByText(
            'Conexão direta indisponível. Exibindo a última observação.',
            { exact: true },
          ),
        ).toBeVisible({ timeout: 30_000 })
        await expect(
          row
            .getByRole('definition')
            .filter({ hasText: 'PreForm informou: Idle' }),
        ).toBeVisible()
      })
      expect(new Set(fixture.simulator.requests)).toEqual(
        new Set(['GET /devices/']),
      )
    } finally {
      await journey.close()
    }
  })
}
