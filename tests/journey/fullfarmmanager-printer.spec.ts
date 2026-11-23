import { expect, test } from '@playwright/test'
import { journeyEnabled, startJourneyHarness } from './harness.ts'

if (journeyEnabled())
  test('jornada FullFarmManager: inspetor, espera e registro de resina', async ({
    browser,
  }) => {
    test.setTimeout(10 * 60_000)
    const journey = await startJourneyHarness({
      browser,
      simulator: 'moonraker-fixture',
      signedControl: true,
      history: true,
    })
    try {
      const page = journey.ownerPage
      await page.goto(
        `${journey.origin}/impressoras/${encodeURIComponent(journey.printerKey)}?farm=${journey.farmId}`,
      )
      await expect(
        page.getByRole('heading', { name: journey.printerKey }),
      ).toBeVisible()
      await expect(page.getByRole('heading', { name: 'Resina' })).toBeVisible()
      await page.getByLabel('Tipo de registro').selectOption('film')
      await page.getByLabel('Camadas').fill('125')
      await page.getByRole('button', { name: 'Salvar registro' }).click()
      await expect(page.getByRole('status')).toContainText('Registro salvo.')
      await expect(page.getByRole('main')).toContainText('125')
    } finally {
      await journey.close()
    }
  })
