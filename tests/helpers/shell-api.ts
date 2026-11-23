import type { Page } from '@playwright/test'

/** Register after the API catchall and before any scenario-specific routes. */
export async function mockShellApi(page: Page, farmId: string) {
  const farmPath = `/api/farms/${encodeURIComponent(farmId)}`
  await page.route(`**${farmPath}/status-summary`, (route) =>
    route.request().method() === 'GET'
      ? route.fulfill({
          json: {
            generatedAt: Date.now(),
            total: 0,
            counts: {},
            truncated: false,
            printers: [],
          },
        })
      : route.fallback(),
  )
  await page.route(
    (url) =>
      url.pathname === '/api/job-history' &&
      url.searchParams.get('farmId') === farmId &&
      url.searchParams.get('limit') === '1',
    (route) =>
      route.request().method() === 'GET'
        ? route.fulfill({ json: { jobs: [], nextBefore: null } })
        : route.fallback(),
  )
  await page.route(
    (url) =>
      url.pathname === `${farmPath}/spool-library/spools` &&
      url.searchParams.get('limit') === '100',
    (route) =>
      route.request().method() === 'GET'
        ? route.fulfill({ json: { items: [], total: 0, nextAfter: null } })
        : route.fallback(),
  )
}
