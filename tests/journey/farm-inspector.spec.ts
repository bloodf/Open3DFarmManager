import { expect, test } from '@playwright/test'
import { openFarmInspector } from '../helpers/farm-inspector.ts'

test('opens the only tile and returns the card for the exact printer key', async ({
  page,
}) => {
  await page.setContent(`
    <button onclick="this.dataset.clicks = String(Number(this.dataset.clicks || 0) + 1); document.querySelector('dialog').showModal()">Inspecionar Apelido</button>
    <dialog aria-label="Inspeção da impressora">
      <article><h2>printer-10</h2><p>Outra impressora</p></article>
      <article><h2>printer-1</h2><p>Impressora correta</p></article>
    </dialog>
  `)

  const card = await openFarmInspector(page, 'printer-1')
  await expect(
    page.getByRole('button', { name: 'Inspecionar Apelido' }),
  ).toHaveAttribute('data-clicks', '1')
  await expect(
    page.getByRole('dialog', { name: 'Inspeção da impressora' }),
  ).toBeVisible()
  await expect(card).toHaveCount(1)
  await expect(card).toContainText('Impressora correta')
})

test('rejects a tile that does not open the inspector', async ({ page }) => {
  await page.setContent(`
    <button>Inspecionar Apelido</button>
    <dialog aria-label="Inspeção da impressora">
      <article><h2>printer-1</h2></article>
    </dialog>
  `)

  await expect(openFarmInspector(page, 'printer-1')).rejects.toThrow()
})
