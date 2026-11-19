import { expect, test } from './fixtures.ts'
import { vendorDetailCatalog } from '../../../apps/farm/app/utils/compatibility/detail-panels.ts'

const families = ['bambu', 'creality', 'anycubic'] as const
const unavailable = [
  ['console', 'Console'],
  ['arquivos', 'Arquivos'],
  ['fila', 'Fila'],
  ['timelapse', 'Timelapse'],
  ['malha', 'Malha'],
  ['configuracao', 'Configuração'],
  ['sistema', 'Sistema'],
  ['historico', 'Histórico'],
] as const

for (const family of families) {
  test(`${family}: confirma pausa e explica recursos indisponíveis`, async ({
    bootFarm,
  }) => {
    const farm = await bootFarm({
      printers: [{ family }],
      control: true,
      signedControl: true,
    })
    const page = farm.owner
    try {
      await farm.openFarm()
      await farm
        .printerCard(farm.harness.printerKey)
        .getByRole('link', { name: /Abrir detalhes da impressora/ })
        .click()
      await expect(
        page.getByRole('heading', {
          name: farm.harness.printerKey,
          exact: true,
        }),
      ).toBeVisible()
      await expect(
        page.getByText('Connector: conexão direta ativa', { exact: true }),
      ).toBeVisible({ timeout: 60_000 })

      const catalog = vendorDetailCatalog[family]
      await expect(
        page.getByText(catalog.hardwareNote, { exact: true }),
      ).toBeVisible()
      const features = page.getByRole('region', {
        name: 'Recursos indisponíveis',
      })
      await expect(features.getByRole('listitem')).toHaveText(
        unavailable.map(
          ([id, panel]) =>
            `${panel}: ${catalog.panelReasons?.[id] ?? catalog.reason}`,
        ),
      )
      for (const [, panel] of unavailable) {
        await expect(
          page.getByRole('tab', { name: panel, exact: true }),
        ).toHaveCount(0)
      }

      farm.harness.controls.setProgress(25)
      const pause = page.getByRole('button', {
        name: 'Pausar impressão',
        exact: true,
      })
      await expect(pause).toBeEnabled({ timeout: 30_000 })
      await expect
        .poll(() => farm.harness.simulatorObservation().pauseInboxReady, {
          timeout: 30_000,
        })
        .toBe(true)
      await pause.click()
      const dialog = page.getByRole('dialog')
      const confirm = dialog.getByRole('button', { name: 'Confirmar comando' })
      await expect(confirm).toBeEnabled({ timeout: 45_000 })
      await confirm.click()
      await expect(dialog.getByRole('status')).toHaveText(
        'Impressão pausada. O Connector confirmou a pausa.',
        { timeout: 45_000 },
      )
    } catch (error) {
      console.error(farm.harness.appLog())
      throw error
    }
  })
}
