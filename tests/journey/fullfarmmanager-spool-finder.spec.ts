import { expect, test } from '@playwright/test'
import { journeyEnabled, startJourneyHarness } from './harness.ts'
import { startSpoolmanMock } from './helpers/spoolman-mock.ts'

if (journeyEnabled())
  test('jornada FullFarmManager: localizar e mover bobina por etiqueta', async ({
    browser,
  }) => {
    test.setTimeout(10 * 60_000)
    const spoolman = await startSpoolmanMock()
    const prior = process.env.NUXT_SPOOL_LIBRARY_IMPORT_ALLOWED_ORIGINS
    process.env.NUXT_SPOOL_LIBRARY_IMPORT_ALLOWED_ORIGINS = spoolman.origin
    const journey = await startJourneyHarness({ browser })
    try {
      const page = journey.ownerPage
      await page.goto(
        `${journey.origin}/bobinas/importar?farm=${journey.farmId}`,
      )
      await page.getByRole('button', { name: 'API do Spoolman' }).click()
      await page.getByLabel('Endereço do Spoolman *').fill(spoolman.origin)
      await page.getByLabel(/Simulação/).uncheck()
      await page.getByRole('button', { name: 'Executar importação' }).click()
      await expect(
        page.getByText(/Importação aplicada com sucesso/),
      ).toBeVisible()
      await page.goto(
        `${journey.origin}/bobinas/localizar?farm=${journey.farmId}`,
      )
      await expect(
        page.getByRole('heading', { name: 'Localizar bobinas' }),
      ).toBeVisible()
      await expect(page.getByRole('main')).toContainText('Bobinas encontradas')
      const form = page.getByRole('form', {
        name: 'Registrar local por etiqueta',
      })
      await form.getByLabel('Local').fill('Estante A')
      await form.getByLabel('Etiqueta da bobina').fill('#1')
      await form.getByRole('button', { name: /escanear|registrar/i }).click()
      await expect(
        page.getByRole('status').filter({ hasText: /local|bobina/i }),
      ).toBeVisible()
    } finally {
      await journey.close()
      await spoolman.close()
      if (prior === undefined)
        delete process.env.NUXT_SPOOL_LIBRARY_IMPORT_ALLOWED_ORIGINS
      else process.env.NUXT_SPOOL_LIBRARY_IMPORT_ALLOWED_ORIGINS = prior
    }
  })
