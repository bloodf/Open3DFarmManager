import { expect, test } from '@playwright/test'
import { journeyEnabled, startJourneyHarness } from './harness.ts'

if (journeyEnabled())
  test('jornada FullFarmManager: shell responsivo, tema e paleta', async ({
    browser,
  }) => {
    test.setTimeout(10 * 60_000)
    const journey = await startJourneyHarness({ browser })
    try {
      const page = journey.ownerPage
      await page.goto(`${journey.origin}/farm`)
      await page.getByRole('button', { name: /Buscar \(Ctrl\/⌘ K\)/ }).click()
      const palette = page.getByRole('combobox', {
        name: 'Buscar páginas, impressoras e bobinas',
      })
      await expect(palette).toBeVisible()
      await palette.fill('Bobinas')
      await expect(page.getByRole('listbox')).toContainText('Bobinas')
      await page.keyboard.press('Escape')

      const theme = page.getByRole('button', { name: /tema|escuro|claro/i })
      await theme.click()
      const selectedTheme = await page
        .locator('html')
        .getAttribute('data-theme')
      await page.reload()
      await expect(page.locator('html')).toHaveAttribute(
        'data-theme',
        selectedTheme ?? '',
      )

      await page.setViewportSize({ width: 390, height: 844 })
      await page.goto(`${journey.origin}/farm`)
      const navigation = page.getByRole('navigation', { name: 'Localização' })
      if (!(await navigation.isVisible())) {
        await page.getByRole('button', { name: /menu/i }).click()
        await expect(navigation).toBeVisible()
      }
    } finally {
      await journey.close()
    }
  })
