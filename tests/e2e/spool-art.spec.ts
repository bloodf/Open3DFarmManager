import AxeBuilder from '@axe-core/playwright'
import { expect, test, type Page } from '@playwright/test'
import { setPolishTheme } from '../helpers/polish-theme.ts'
import { mockShellApi } from '../helpers/shell-api.ts'

// Visual and accessibility checks of the spool illustration section of the
// component gallery (apps/farm/app/pages/ui-gallery.vue), served by the real
// Nuxt build. Every /api route is mocked and any request that leaves loopback
// is aborted, so no database, Connector, Spoolman or printer is involved.
//
// Baselines live in tests/e2e/spool-art.spec.ts-snapshots. Regenerate them
// only on purpose: npx playwright test tests/e2e/spool-art.spec.ts --update-snapshots
const farm = '00000000-0000-4000-8000-0000000000f1'
const themes = ['light', 'dark'] as const

async function open(page: Page, theme: (typeof themes)[number]) {
  await page.setViewportSize({ width: 1024, height: 900 })
  await setPolishTheme(page, theme)
  await page.route(
    (url) => !['127.0.0.1', 'localhost'].includes(url.hostname),
    (route) => route.abort(),
  )
  await page.route('**/api/**', (route) =>
    route.fulfill({ status: 404, json: {} }),
  )
  await mockShellApi(page, farm)
  await page.route('**/api/auth/me', (route) =>
    route.fulfill({ json: { accountId: 'conta-sintetica' } }),
  )
  await page.route('**/api/farms?*', (route) =>
    route.fulfill({ json: { farms: [{ farmId: farm }], nextAfter: null } }),
  )
  await page.goto('/ui-gallery')
  const section = page.getByTestId('spool-art-gallery')
  await expect(
    section.getByRole('heading', { level: 2, name: 'Carretéis e slots' }),
  ).toBeVisible()
  // Wait for every drawing, so the baseline never captures a half-loaded reel.
  await expect
    .poll(() =>
      section
        .locator('img')
        .evaluateAll((images) =>
          images.every(
            (image) =>
              (image as HTMLImageElement).complete &&
              (image as HTMLImageElement).naturalWidth > 0,
          ),
        ),
    )
    .toBe(true)
  return section
}

for (const theme of themes) {
  test(`the spool section matches its ${theme} baseline`, async ({ page }) => {
    const section = await open(page, theme)
    await expect(section).toHaveScreenshot(`spool-art-${theme}.png`, {
      animations: 'disabled',
      caret: 'hide',
    })
  })

  test(`the spool section keeps text for every level in the ${theme} theme`, async ({
    page,
  }) => {
    const section = await open(page, theme)
    // The amount is never only the drawing.
    await expect(section.getByText('Quantidade desconhecida')).toBeVisible()
    await expect(
      section.getByText('desconhecido', { exact: true }),
    ).toHaveCount(2)
    await expect(section.getByText('Slot vazio')).toBeVisible()
    await expect(section.getByText('ABS · Cor não informada')).toBeVisible()
    await expect(
      section.getByText('informado pela impressora').first(),
    ).toBeVisible()
    const results = await new AxeBuilder({ page })
      .include('[data-testid="spool-art-gallery"]')
      .analyze()
    expect(results.violations).toEqual([])
  })
}
