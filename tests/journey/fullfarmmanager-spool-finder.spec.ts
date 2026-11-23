import { expect, test } from '@playwright/test'
import { journeyEnabled, startJourneyHarness } from './harness.ts'
import { startSpoolmanMock } from './helpers/spoolman-mock.ts'

test.use({ actionTimeout: 30_000, navigationTimeout: 30_000 })

if (journeyEnabled())
  test('jornada FullFarmManager: localizar e mover bobina por etiqueta', async ({
    browser,
  }) => {
    test.setTimeout(10 * 60_000)
    const spoolman = await startSpoolmanMock()
    const prior = process.env.NUXT_SPOOL_LIBRARY_IMPORT_ALLOWED_ORIGINS
    process.env.NUXT_SPOOL_LIBRARY_IMPORT_ALLOWED_ORIGINS = spoolman.origin
    let journey: Awaited<ReturnType<typeof startJourneyHarness>> | undefined
    try {
      journey = await startJourneyHarness({ browser })
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
      const spool = page
        .getByRole('table', { name: 'Bobinas encontradas' })
        .getByRole('row')
        .filter({ hasText: 'PLA Azul Jornada' })
      await expect(
        spool.getByRole('cell', { name: 'Estante da jornada', exact: true }),
      ).toBeVisible()
      const form = page.getByRole('form', {
        name: 'Registrar local por etiqueta',
      })
      await form.getByLabel('Local').fill('Estante A')
      await form.getByLabel('Etiqueta da bobina').fill('#1')
      await form
        .getByRole('button', { name: 'Registrar local', exact: true })
        .click()
      await expect(
        page
          .getByRole('status')
          .filter({ hasText: 'Bobina #1 movida para “Estante A”.' }),
      ).toBeVisible()
      await page.reload()
      await expect(
        spool.getByRole('cell', { name: 'Estante A', exact: true }),
      ).toBeVisible()
    } finally {
      try {
        await Promise.all([journey?.close(), spoolman.close()])
      } finally {
        if (prior === undefined)
          delete process.env.NUXT_SPOOL_LIBRARY_IMPORT_ALLOWED_ORIGINS
        else process.env.NUXT_SPOOL_LIBRARY_IMPORT_ALLOWED_ORIGINS = prior
      }
    }
  })
