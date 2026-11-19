import { expect, test } from '@playwright/test'
test('homepage is in Portuguese and the farm page is served', async ({
  page,
  request,
}) => {
  await page.goto('/')
  await expect(page.locator('html')).toHaveAttribute('lang', 'pt-BR')
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(
    'Sua farm de impressão, em um só lugar.',
  )
  // The farmView flag is gone: the farm page is always served.
  expect((await request.get('/farm')).status()).toBe(200)
  expect(await (await request.get('/healthz')).json()).toEqual({
    status: 'ok',
    checks: { process: 'ok' },
  })
})
