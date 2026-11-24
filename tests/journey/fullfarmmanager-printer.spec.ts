import { expect, test } from '@playwright/test'
import { journeyEnabled, startJourneyHarness } from './harness.ts'

import { startResinFixture } from './fullfarmmanager-resin-fixture.ts'
import { openLiveInspector } from './fullfarmmanager-fixture.ts'

test.use({ actionTimeout: 30_000, navigationTimeout: 30_000 })

if (journeyEnabled())
  test('jornada FullFarmManager: inspetor e registro de resina', async ({
    browser,
  }) => {
    test.setTimeout(10 * 60_000)
    const fixture = await startResinFixture()
    let journey: Awaited<ReturnType<typeof startJourneyHarness>> | undefined
    try {
      journey = await startJourneyHarness({ browser })
      await fixture.provision()
      const printer = await openLiveInspector(journey)
      const page = journey.ownerPage
      await printer
        .getByRole('link', { name: /^Abrir detalhes da impressora/ })
        .click()
      await expect(
        page.getByRole('heading', { name: journey.printerKey }),
      ).toBeVisible()
      await expect(
        page.getByText('Connector: conexão direta ativa', { exact: true }),
      ).toBeVisible()
      const resin = page.getByRole('region', { name: 'Resina' })
      await expect(
        resin.getByText('Filme (camadas)', { exact: true }),
      ).toBeVisible()
      const kind = resin.getByRole('combobox', {
        name: 'Tipo de registro',
        exact: true,
      })
      for (const label of [
        'Cuba atual',
        'Volume da cuba',
        'Filme (camadas)',
        'LCD (horas)',
      ]) {
        await expect(
          resin
            .locator('dl.resin-summary > div')
            .filter({ has: resin.getByText(label, { exact: true }) })
            .locator('dd'),
        ).toHaveText('Não informado')
      }
      await kind.selectOption('vat')
      await resin
        .getByRole('textbox', { name: 'Nome', exact: true })
        .fill('Cuba A')
      await resin.getByRole('button', { name: 'Salvar registro' }).click()
      await expect(
        resin.getByText('Cuba A · Manual', { exact: true }),
      ).toBeVisible()
      await kind.selectOption('volume')
      await resin
        .getByRole('textbox', { name: 'Nome', exact: true })
        .fill('Cuba A')
      await resin
        .getByRole('textbox', { name: 'Volume (mL)', exact: true })
        .fill('250')
      await resin.getByRole('button', { name: 'Salvar registro' }).click()
      await expect(resin.getByText(/^250 mL · Manual/)).toBeVisible()
      await resin
        .getByRole('combobox', { name: 'Tipo de registro', exact: true })
        .selectOption('film')
      await resin
        .getByRole('textbox', { name: 'Camadas', exact: true })
        .fill('125')
      await resin.getByRole('button', { name: 'Salvar registro' }).click()
      await expect(resin.getByRole('status')).toContainText('Registro salvo.')
      await expect(resin.getByText(/^125 · Manual$/)).toBeVisible()
      await kind.selectOption('lcd')
      await resin
        .getByRole('textbox', { name: 'Horas', exact: true })
        .fill('12')
      await resin.getByRole('button', { name: 'Salvar registro' }).click()
      await expect(resin.getByText(/^12 · Manual$/)).toBeVisible()
      await page.reload()
      await expect(resin.getByText(/^125 · Manual$/)).toBeVisible()
      await expect(resin.getByText(/^12 · Manual$/)).toBeVisible()
      await expect(
        resin.getByText('Cuba A · Manual', { exact: true }),
      ).toBeVisible()
      await expect(resin.getByText(/^250 mL · Manual/)).toBeVisible()
    } finally {
      try {
        await journey?.close()
      } finally {
        await fixture.close()
      }
    }
  })
