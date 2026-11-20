import { projectVersion } from '@open3dfarmmanager/shared'
import { expect, test } from '@playwright/test'

// The farmView feature flag was removed (see tests/node/no-farmview-flag.test.ts):
// /farm is always served. The legacy server still sets the old hide flag so a
// stale deployment setting is proven not to hide the route again.
const modes = [
  { name: 'default', port: process.env.E2E_PORT },
  { name: 'legacy hide flag set', port: process.env.E2E_LEGACY_FLAG_PORT },
]

for (const mode of modes) {
  test(`homepage is in Portuguese and farm is accessible (${mode.name})`, async ({
    page,
    playwright,
  }) => {
    expect(mode.port, `${mode.name} server port`).toMatch(/^\d+$/)
    const baseURL = `http://127.0.0.1:${mode.port}`
    const request = await playwright.request.newContext({ baseURL })
    try {
      await page.goto(`${baseURL}/`)
      await expect(page.locator('html')).toHaveAttribute('lang', 'pt-BR')
      await expect(page.getByRole('heading', { level: 1 })).toHaveText(
        'Sua farm de impressão, em um só lugar.',
      )
      await expect(
        page
          .getByRole('navigation', { name: 'Navegação principal' })
          .getByRole('link', { name: 'Minha farm' }),
      ).toHaveAttribute('href', '/farm')
      expect((await request.get('/farm')).status()).toBe(200)
      expect(await (await request.get('/healthz')).json()).toEqual({
        status: 'ok',
        version: projectVersion,
        checks: { process: 'ok' },
      })
    } finally {
      await request.dispose()
    }
  })
}
