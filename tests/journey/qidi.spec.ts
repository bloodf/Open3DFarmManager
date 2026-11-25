import { expect, test } from '@playwright/test'
import { journeyEnabled, startJourneyHarness } from './harness.ts'
import { recordJourneyDiagnostics } from './journey-diagnostics.ts'
import { statusJourney } from './status-journey.ts'
import type { startStatusFixture } from './status-fixtures.ts'
import { qidiVariants } from '../fixtures/qidi/variants.ts'

statusJourney('qidi')

const FAN_LABELS = {
  part: 'Ventilador da peça',
  aux: 'Ventilador auxiliar',
  chamber: 'Ventilador da câmara',
} as const

// Every model binds to its own cited Klipper objects. Decoy objects in the
// simulator must never reach the page. Chamber temperature has no farm UI;
// tests/unit/qidi-variants.test.ts covers it up to the live snapshot.
for (const variant of qidiVariants)
  if (journeyEnabled())
    test(`qidi ${variant.model}: shows only the model's cited fields`, async ({
      browser,
    }, testInfo) => {
      const journey = await startJourneyHarness({
        browser,
        simulator: 'qidi',
        printerModel: variant.model,
        openFarmInspector: true,
      })
      const page = journey.ownerPage
      const diagnostics = recordJourneyDiagnostics()
      diagnostics.watch('owner', page)
      try {
        const fixture = journey.vendor?.raw as Awaited<
          ReturnType<typeof startStatusFixture>
        >
        const row = await journey.openFarm(page)
        await expect(
          row.getByText('Conexão direta autenticada', { exact: true }),
        ).toBeVisible({ timeout: 90_000 })
        await expect(row).toContainText('Imprimindo', { timeout: 30_000 })

        const environment = row.locator(
          'dl[aria-label="Ventilação e iluminação"]',
        )
        await expect(environment.locator('dt')).toHaveText(
          Object.keys(variant.fans).map(
            (id) => new RegExp(`${FAN_LABELS[id as keyof typeof FAN_LABELS]}$`),
          ),
        )
        await expect(environment.locator('dd')).toHaveText(
          Object.values(variant.fans).map((percent) => `${percent}%`),
        )

        for (const material of variant.materials ?? []) {
          await expect(row).toContainText(material.slot)
          await expect(row).toContainText(
            material.materialType ?? 'Material desconhecido',
          )
          // The card drops the opaque alpha from the colour.
          if (material.colorHex)
            await expect(row).toContainText(
              `Cor #${material.colorHex.slice(0, 6)}`,
            )
        }
        if (!variant.materials)
          await expect(row.getByText(/QIDI Box/)).toHaveCount(0)
        await expect(row.getByText(/DECOY|EMPTY-SLOT|STALE-BOX/)).toHaveCount(0)
        await expect(
          row.getByRole('button', {
            name: /pausar|retomar|cancelar|iniciar impressão/i,
          }),
        ).toHaveCount(0)

        expect(new Set<string | number>([...fixture.requests])).toEqual(
          new Set(['GET /server/info', `GET ${variant.query}`]),
        )
      } catch (error) {
        await diagnostics.attach(testInfo).catch(() => {})
        throw error
      } finally {
        await journey.close()
      }
    })
