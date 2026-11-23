import { expect, test } from '@playwright/test'
import { journeyEnabled, startJourneyHarness } from './harness.ts'

test.use({ actionTimeout: 30_000, navigationTimeout: 30_000 })

if (journeyEnabled())
  test('jornada FullFarmManager: shell responsivo, tema e paleta', async ({
    browser,
  }) => {
    test.setTimeout(10 * 60_000)
    const journey = await startJourneyHarness({ browser })
    try {
      const page = journey.ownerPage
      await journey.openFarm()
      await expect(
        page.getByRole('button', { name: /^Inspecionar / }),
      ).toBeVisible()
      await page.keyboard.press('Control+k')
      const palette = page.getByRole('combobox', {
        name: 'Buscar páginas, impressoras e bobinas',
      })
      await expect(palette).toBeVisible()
      await palette.fill('Bobinas')
      const results = page.getByRole('listbox', { name: 'Resultados da busca' })
      await expect(
        results.getByRole('option', { name: 'Bobinas', exact: true }),
      ).toBeVisible()
      // Chromium clears a populated search input on the first Escape.
      await palette.press('Escape')
      await expect(palette).toHaveValue('')
      await palette.press('Escape')
      await expect(palette).toBeHidden()

      await page.getByRole('button', { name: 'Ativar tema claro' }).click()
      await expect(page.locator('html')).toHaveAttribute('data-theme', 'light')
      await page.reload()
      await expect(page.locator('html')).toHaveAttribute('data-theme', 'light')

      await page.setViewportSize({ width: 390, height: 844 })
      await journey.openFarm()
      await page.getByRole('button', { name: 'Menu', exact: true }).click()
      const menu = page.getByRole('dialog', { name: 'Menu' })
      const navigation = menu.getByRole('navigation', {
        name: 'Navegação principal',
      })
      await expect(navigation).toBeVisible()
      await navigation
        .getByRole('link', { name: 'Bobinas', exact: true })
        .click()
      await expect(page).toHaveURL(/\/bobinas(?:\?|$)/)
      await expect(menu).toBeHidden()
    } finally {
      await journey.close()
    }
  })
