import { expect, test, type Locator } from '@playwright/test'
import WebSocket from 'ws'
import { journeyEnabled, startJourneyHarness } from './harness.ts'
import { startSpoolmanMock } from './helpers/spoolman-mock.ts'

const path = (farmId: string, route: string) =>
  `${route}?farm=${encodeURIComponent(farmId)}`

async function selectImportedSpool(select: Locator) {
  const option = select.locator('option').filter({
    hasText: 'PLA Azul Jornada',
  })
  await expect(option).toHaveCount(1)
  const value = await option.getAttribute('value')
  if (!value) throw new Error('Imported spool option has no value')
  await select.selectOption(value, { timeout: 5_000 })
  await expect(select).toHaveValue(value)
}

if (journeyEnabled())
  test('importa e usa biblioteca de bobinas de ponta a ponta', async ({
    browser,
  }) => {
    test.setTimeout(10 * 60_000)
    const source = await startSpoolmanMock()
    const priorAllowedOrigins =
      process.env.NUXT_SPOOL_LIBRARY_IMPORT_ALLOWED_ORIGINS
    process.env.NUXT_SPOOL_LIBRARY_IMPORT_ALLOWED_ORIGINS = source.origin
    let journey: Awaited<ReturnType<typeof startJourneyHarness>> | undefined
    try {
      journey = await startJourneyHarness({
        browser,
        simulator: 'moonraker-fixture',
        signedControl: true,
        history: true,
      })
      const page = journey.ownerPage
      await page.goto(
        `${journey.origin}${path(journey.farmId, '/bobinas/importar')}`,
      )
      await expect(
        page.getByRole('heading', { name: 'Importar biblioteca de bobinas' }),
      ).toBeVisible()
      await page.getByRole('button', { name: 'API do Spoolman' }).click()
      await page.getByLabel('Endereço do Spoolman *').fill(source.origin)
      await page.getByLabel(/Simulação/).uncheck()
      await page.getByRole('button', { name: 'Executar importação' }).click()
      await expect(
        page.getByText(/Importação aplicada com sucesso/),
      ).toBeVisible()

      await page.goto(`${journey.origin}${path(journey.farmId, '/bobinas')}`)
      await expect(
        page.getByRole('article').filter({ hasText: 'PLA Azul Jornada' }),
      ).toBeVisible()
      const credentialResponse = await page.request.post(
        `${journey.origin}/api/farms/${journey.farmId}/spool-library/credentials`,
        {
          data: { label: 'Journey legacy client', access: 'write' },
          headers: { origin: journey.origin },
        },
      )
      expect(credentialResponse.ok()).toBe(true)
      const { token } = (await credentialResponse.json()) as { token: string }
      const legacyPath = `${journey.origin}/spoolman/${token}/api/v1`
      const legacyInventory = await page.request.get(`${legacyPath}/spool`)
      expect(legacyInventory.ok()).toBe(true)
      expect(await legacyInventory.json()).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            filament: expect.objectContaining({ name: 'PLA Azul Jornada' }),
          }),
        ]),
      )
      const otherFarmPage = await journey.signInAs('viewer')
      try {
        const otherCredential = await otherFarmPage.request.post(
          `${journey.origin}/api/farms/${journey.otherFarmId}/spool-library/credentials`,
          {
            data: { label: 'Other farm legacy client', access: 'read' },
            headers: { origin: journey.origin },
          },
        )
        expect(otherCredential.ok()).toBe(true)
        const { token: otherToken } = (await otherCredential.json()) as {
          token: string
        }
        const otherInventory = await page.request.get(
          `${journey.origin}/spoolman/${otherToken}/api/v1/spool`,
        )
        expect(otherInventory.ok()).toBe(true)
        expect(await otherInventory.json()).toEqual([])
      } finally {
        await otherFarmPage.close()
      }
      const feed = new WebSocket(`${legacyPath.replace(/^https:/, 'wss:')}/`, {
        rejectUnauthorized: false,
        origin: journey.origin,
      })
      await new Promise<void>((resolve, reject) => {
        feed.once('open', resolve)
        feed.once('error', reject)
      })
      const feedEvent = new Promise<string>((resolve, reject) => {
        feed.once('message', (data) => resolve(data.toString()))
        feed.once('error', reject)
      })
      feed.send('ping')
      expect(await feedEvent).toContain('healthy')
      feed.close()
      await page.goto(
        `${journey.origin}${path(journey.farmId, '/bobinas/slots')}`,
      )
      const assignment = page.getByRole('form', {
        name: `Atribuir bobina a ${journey.printerKey}`,
      })
      await assignment.getByLabel('Número do slot').fill('1')
      await selectImportedSpool(assignment.getByLabel('Bobina'))
      await assignment.getByRole('button', { name: 'Atribuir' }).click()
      await expect(
        page.getByRole('list', {
          name: `Slots ativos de ${journey.printerKey}`,
        }),
      ).toContainText('PLA Azul Jornada')

      await journey.expectLiveTelemetry()
      journey.advanceSimulator()
      await journey.expectProgress(0.75)
      journey.controls.finishPrint()
      await expect(journey.farmRow()).toContainText('Concluído', {
        timeout: 60_000,
      })
      await journey.setTelemetryUpload(true)
      await page.goto(
        `${journey.origin}${path(journey.farmId, '/bobinas/uso')}`,
      )
      await page
        .getByRole('button', { name: 'Registrar consumo manual' })
        .click()
      const usageDialog = page.getByRole('dialog')
      await selectImportedSpool(usageDialog.getByLabel('Bobina'))
      await usageDialog.getByLabel('Gramas usadas').fill('100')
      await usageDialog
        .getByLabel('Impressora (opcional)')
        .selectOption({ label: journey.printerKey })
      await usageDialog.getByRole('button', { name: 'Registrar' }).click()
      await expect(page.getByRole('main')).toContainText('PLA Azul Jornada')
      await expect(page.getByRole('main')).toContainText(/US\$|\$/)
      const thresholdResponse = await page.request.put(
        `${journey.origin}/api/farms/${journey.farmId}/spool-library/low-stock/filaments/1`,
        {
          data: { thresholdGrams: 950 },
          headers: { origin: journey.origin },
        },
      )
      expect(thresholdResponse.ok()).toBe(true)
      await page.goto(
        `${journey.origin}${path(journey.farmId, '/bobinas/estoque')}`,
      )
      await expect(page.getByRole('main')).toContainText('PLA Azul Jornada')

      await page.goto(
        `${journey.origin}${path(journey.farmId, '/bobinas/etiquetas')}`,
      )
      await page.getByLabel(/PLA Azul Jornada/).check()
      const labelsLink = page.getByRole('link', { name: /Abrir etiquetas/ })
      await expect(labelsLink).toHaveAttribute('href', /labels/)
      const labelPagePromise = page.waitForEvent('popup')
      await labelsLink.click()
      const labelPage = await labelPagePromise
      await expect(labelPage).toHaveTitle('Etiquetas de carretéis')
      await expect(labelPage.locator('article')).toContainText(
        'PLA Azul Jornada',
      )
      await labelPage.close()
      await page.goto(
        `${journey.origin}${path(journey.farmId, '/bobinas/secagem')}`,
      )
      const drying = page.getByRole('main')
      await selectImportedSpool(drying.getByLabel('Escolha a bobina'))
      const dryingForm = page.getByRole('form', { name: 'Registrar secagem' })
      await dryingForm.getByLabel('Temperatura (°C)').fill('55')
      await dryingForm.getByLabel('Observações').fill('Registro da jornada')
      await dryingForm
        .getByRole('button', { name: 'Registrar secagem' })
        .click()
      await expect(drying).toContainText('Registro da jornada')
    } finally {
      await journey?.close()
      await source.close()
      if (priorAllowedOrigins === undefined)
        delete process.env.NUXT_SPOOL_LIBRARY_IMPORT_ALLOWED_ORIGINS
      else
        process.env.NUXT_SPOOL_LIBRARY_IMPORT_ALLOWED_ORIGINS =
          priorAllowedOrigins
    }
  })
