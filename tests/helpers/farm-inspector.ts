import { expect, type Page } from '@playwright/test'

/** Open the printer inspector and return its card. */
export async function openFarmInspector(page: Page, printerKey: string) {
  // These fixtures provision exactly one assignment; the tile may show a display name.
  await page.getByRole('button', { name: /^Inspecionar / }).click()
  const inspector = page.getByRole('dialog', {
    name: 'Inspeção da impressora',
    exact: true,
  })
  await expect(inspector).toBeVisible()
  return inspector.getByRole('article').filter({
    has: page.getByRole('heading', { name: printerKey, exact: true }),
  })
}
