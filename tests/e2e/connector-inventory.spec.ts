import { expect, test } from '@playwright/test'

const farm = '11111111-1111-4111-8111-111111111111'
const connector = '22222222-2222-4222-8222-222222222222'

test('inventory displays a selected farm and clears on authorization loss', async ({
  page,
}) => {
  let denied = false
  await page.route('**/api/farms**', async (route) => {
    if (denied) return route.fulfill({ status: 401, json: {} })
    if (new URL(route.request().url()).pathname === '/api/farms')
      return route.fulfill({
        json: { farms: [{ farmId: farm }], nextAfter: null },
      })
    return route.fulfill({
      json: {
        connectors: [
          {
            agentId: connector,
            fingerprint: 'synthetic-fingerprint',
            status: 'pending',
          },
        ],
        nextAfter: null,
      },
    })
  })
  await page.goto('/connectors')
  const selection = page.getByLabel('Selecione uma farm')
  await page.waitForFunction(() => {
    const root = document.querySelector('#__nuxt')
    return root !== null && '__vue_app__' in root
  })
  await expect(selection.locator('option')).toHaveCount(2)
  await expect(selection).toBeEnabled()
  await selection.focus()
  await selection.selectOption(farm)
  await expect(page.getByText(connector)).toBeVisible()
  await expect(page.getByText('Pendente', { exact: true })).toBeVisible()
  await expect(
    page.getByRole('button', { name: 'Revogar Connector' }),
  ).toBeDisabled()
  denied = true
  await page.getByRole('button', { name: 'Atualizar farms' }).click()
  await expect(page.getByRole('alert')).toContainText('Entre novamente')
  await expect(page.getByText(connector)).toHaveCount(0)
  await expect(selection).toBeDisabled()
})
