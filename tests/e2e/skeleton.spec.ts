import { expect, test } from '@playwright/test'
test('homepage is in Portuguese and hidden farm remains inaccessible', async ({
  page,
  request,
}) => {
  await page.goto('/')
  await expect(page.locator('html')).toHaveAttribute('lang', 'pt-BR')
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(
    'Sua farm de impressão, em um só lugar.',
  )
  expect((await request.get('/farm')).status()).toBe(404)
  expect(await (await request.get('/healthz')).json()).toEqual({
    status: 'ok',
    checks: { process: 'ok' },
  })
})
