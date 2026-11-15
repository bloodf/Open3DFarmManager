import { expect, test } from '@playwright/test'
import { farmControlsBundle } from './mount-farm-controls.ts'

test('advertised controls and legacy fallback require confirmation', async ({
  page,
}) => {
  await page.route('**/api/auth/me', (route) =>
    route.fulfill({ json: { accountId: 'synthetic-ui-account' } }),
  )
  await page.goto('/farm')
  await expect(page.getByRole('alert')).toBeVisible()
  await page.evaluate(() => {
    const target = document.createElement('div')
    target.id = 'controls-fixture'
    document.querySelector('main')!.append(target)
  })
  await page.addScriptTag({ content: await farmControlsBundle() })
  await page.evaluate(() =>
    (window as any).mountFarmControls(
      document.querySelector('#controls-fixture'),
    ),
  )
  for (const name of ['KobraLink', 'Bambu']) {
    await expect(
      page.getByRole('article', { name }).getByRole('button'),
    ).toHaveCount(0)
  }
  const legacy = page.getByRole('article', { name: 'Legada' })
  await expect(
    legacy.getByRole('button', { name: 'Pausar', exact: true }),
  ).toBeVisible()
  const printer = page.getByRole('article', { name: 'Klipper' })
  await expect(
    printer.getByRole('button', { name: 'Pausar', exact: true }),
  ).toBeVisible()
  await expect(
    printer.getByRole('button', { name: 'Definir temperatura' }),
  ).toBeVisible()
  for (const label of [
    'Referenciar eixos',
    'Reiniciar firmware',
    'Parada de emergência',
  ]) {
    await printer.getByRole('button', { name: label }).click()
    const dialog = page.getByRole('dialog')
    await expect(dialog).toContainText(label)
    await expect(dialog).toContainText('Confirme o comando')
    expect(
      await page.evaluate(() => (window as any).farmControlsIssued),
    ).toHaveLength(0)
    await dialog.getByRole('button', { name: 'Cancelar' }).click()
  }
  await printer.getByRole('button', { name: 'Referenciar eixos' }).click()
  const dialog = page.getByRole('dialog')
  await expect(dialog).toContainText('Referenciar eixos')
  await dialog.getByRole('button', { name: 'Confirmar comando' }).click()
  expect(await page.evaluate(() => (window as any).farmControlsIssued)).toEqual(
    [
      {
        printerKey: 'Klipper',
        action: 'home',
        args: { axes: ['x', 'y', 'z'] },
      },
    ],
  )
})
