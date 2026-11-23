import { expect, test } from '@playwright/test'
import { journeyEnabled, startJourneyHarness } from './harness.ts'
import type { startPrusaLinkJourneyFixture } from './prusa-link-fixture.ts'

if (journeyEnabled())
  test('PrusaLink status becomes unavailable and recovers read-only', async ({
    browser,
  }) => {
    const journey = await startJourneyHarness({
      browser,
      simulator: 'prusa-link',
    })
    try {
      const fixture = journey.vendor?.raw as Awaited<
        ReturnType<typeof startPrusaLinkJourneyFixture>
      >
      const row = await journey.openFarm()
      const readOnly = async () => {
        await expect(
          row.getByRole('button', {
            name: /pausar|retomar|cancelar|iniciar impressão/i,
          }),
        ).toHaveCount(0)
        await expect(row.getByRole('progressbar')).toHaveCount(0)
      }
      await expect(
        row.getByText('Conexão direta autenticada', { exact: true }),
      ).toBeVisible({ timeout: 90_000 })
      await expect(row).toContainText('Imprimindo')
      await readOnly()
      const count = fixture.requests.length
      fixture.loseConnection()
      await expect
        .poll(
          () =>
            fixture.requests
              .slice(count)
              .some((request) => request.status === 503),
          { timeout: 30_000 },
        )
        .toBe(true)
      await expect(
        row.getByText(
          'Conexão direta indisponível. Exibindo a última observação.',
          { exact: true },
        ),
      ).toBeVisible({ timeout: 90_000 })
      await expect(row.getByText(/Dados desatualizados/).first()).toBeVisible()
      await readOnly()
      fixture.recover()
      await expect(
        row.getByText('Conexão direta autenticada', { exact: true }),
      ).toBeVisible({ timeout: 90_000 })
      await expect(row).toContainText('Ociosa', { timeout: 30_000 })
      await readOnly()
      expect(fixture.requests.length).toBeGreaterThan(0)
      expect(
        fixture.requests.every(
          (request) => request.authorized && request.method === 'GET',
        ),
      ).toBe(true)
      expect(new Set(fixture.requests.map((request) => request.path))).toEqual(
        new Set(['/api/version', '/api/v1/info', '/api/v1/status']),
      )
    } finally {
      await journey.close()
    }
  })
