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
      await resin
        .getByRole('combobox', { name: 'Tipo de registro', exact: true })
        .selectOption('film')
      await resin
        .getByRole('textbox', { name: 'Camadas', exact: true })
        .fill('125')
      await resin.getByRole('button', { name: 'Salvar registro' }).click()
      await expect(resin.getByRole('status')).toContainText('Registro salvo.')
      await expect(resin.getByText(/^125 · Manual$/)).toBeVisible()
      await page.reload()
      await expect(resin.getByText(/^125 · Manual$/)).toBeVisible()
    } finally {
      try {
        await journey?.close()
      } finally {
        await fixture.close()
      }
    }
  })
