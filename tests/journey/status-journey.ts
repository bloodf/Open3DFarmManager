import { expect, test } from '@playwright/test'
import { journeyEnabled, startJourneyHarness } from './harness.ts'
import type { startStatusFixture, StatusVendor } from './status-fixtures.ts'

export function statusJourney(name: StatusVendor) {
  if (journeyEnabled())
    test(`${name}: status is withdrawn and recovers read-only`, async ({
      browser,
    }) => {
      const journey = await startJourneyHarness({ browser, simulator: name })
      try {
        const fixture = journey.vendor?.raw as Awaited<
          ReturnType<typeof startStatusFixture>
        >
        const row = await journey.openFarm()
        await journey.ownerPage
          .getByRole('button', {
            name: new RegExp(`^Inspecionar journey-${name}\\b`),
          })
          .click()
        const readOnly = async () => {
          await expect
            .soft(
              row.getByRole('button', {
                name: /pausar|retomar|cancelar|iniciar impressão/i,
              }),
            )
            .toHaveCount(0, { timeout: 2000 })
        }
        await expect(
          row.getByText('Conexão direta autenticada', { exact: true }),
        ).toBeVisible({ timeout: 90_000 })
        await expect(row).toContainText('Imprimindo', { timeout: 30_000 })
        await readOnly()
        const count = fixture.requests.length
        fixture.loseConnection()
        await expect
          .poll(() => fixture.requests.length, { timeout: 30_000 })
          .toBeGreaterThan(count)
        await expect(
          row.getByText(
            'Conexão direta indisponível. Exibindo a última observação.',
            { exact: true },
          ),
        ).toBeVisible({ timeout: 90_000 })
        await expect(
          row.getByText(/Dados desatualizados/).first(),
        ).toBeVisible()
        await readOnly()
        fixture.recover()
        await expect(
          row.getByText('Conexão direta autenticada', { exact: true }),
        ).toBeVisible({ timeout: 90_000 })
        await expect(row).toContainText('Ociosa', { timeout: 30_000 })
        await readOnly()
        if (name === 'qidi') {
          expect(new Set<string | number>([...fixture.requests])).toEqual(
            new Set([
              'GET /server/info',
              'GET /printer/objects/query?webhooks&print_stats&virtual_sdcard&extruder&heater_bed&fan',
            ]),
          )
        } else if (name === 'flashforge') {
          expect(new Set<string | number>([...fixture.requests])).toEqual(
            new Set(['POST /detail']),
          )
        } else {
          expect(new Set<string | number>([...fixture.requests])).toEqual(
            new Set([0]),
          )
        }
      } finally {
        await journey.close()
      }
    })
}
