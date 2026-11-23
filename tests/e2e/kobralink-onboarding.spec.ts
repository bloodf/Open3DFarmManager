import { expect, test } from '@playwright/test'
import { mockShellApi } from '../helpers/shell-api.ts'
import { mkdir } from 'node:fs/promises'
import AxeBuilder from '@axe-core/playwright'
import { randomUUID } from 'node:crypto'

// Synthetic HTTP registry only. These cases do not claim RTC or hardware proof.
for (const width of [320, 375, 768, 1024, 1280]) {
  test(`missing approved browser key refuses configuration at ${width}px`, async ({
    page,
  }) => {
    const farmId = randomUUID()
    const agentId = randomUUID()
    const writes: string[] = []
    await page.setViewportSize({ width, height: 900 })
    await page.route('**/api/**', async (route) => {
      const request = route.request()
      const path = new URL(request.url()).pathname
      if (request.method() !== 'GET') writes.push(path)
      if (path === '/api/auth/me')
        return route.fulfill({ json: { accountId: 'fixture-owner' } })
      if (path === '/api/farms')
        return route.fulfill({ json: { farms: [{ farmId }], nextAfter: null } })
      if (path.endsWith('/printers'))
        return route.fulfill({
          json: { printers: [], nextAfter: null, canManage: true },
        })
      if (path.endsWith('/connectors'))
        return route.fulfill({
          json: {
            connectors: [
              { agentId, fingerprint: 'A'.repeat(64), status: 'approved' },
            ],
            nextAfter: null,
          },
        })
      if (path === '/api/browser-devices')
        return route.fulfill({
          json: {
            currentAccountId: 'fixture-owner',
            currentRole: 'owner',
            devices: [],
            nextAfter: null,
            limits: {
              pendingLifetimeMs: 86400000,
              proofLifetimeMs: 60000,
              maxChallengesPerKey: 3,
            },
          },
        })
      return route.fulfill({
        status: 503,
        json: { message: 'Synthetic fixture: unavailable' },
      })
    })
    await mockShellApi(page, farmId)
    await page.goto('/impressoras')
    await page.getByLabel('Farm', { exact: true }).selectOption(farmId)
    await expect(
      page.getByRole('heading', { name: 'Adicionar impressora' }),
    ).toBeVisible()
    await page
      .getByLabel('Connector aprovado para a impressora')
      .selectOption(agentId)
    await expect(
      page.getByText('Nenhuma chave local aprovada', { exact: false }),
    ).toBeVisible()
    await expect(
      page.getByLabel('Endereço IPv4 da Kobra X na LAN'),
    ).toBeDisabled()
    expect(writes).toEqual([])
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true)
    const setupColumns = await page
      .locator('.setup-columns')
      .evaluate((element) => getComputedStyle(element).gridTemplateColumns)
    expect(setupColumns.split(' ').length).toBe(width >= 768 ? 2 : 1)
    const accessibility = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
      .analyze()
    expect(accessibility.violations).toEqual([])
    await page.getByLabel('Connector aprovado para a impressora').focus()
    await expect(
      page.getByLabel('Connector aprovado para a impressora'),
    ).toBeFocused()
    await page.keyboard.press('Tab')
    const evidenceDir = process.env.KOBRALINK_UI_EVIDENCE
    if (evidenceDir) await mkdir(evidenceDir, { recursive: true })
    await page.screenshot({
      path: evidenceDir
        ? `${evidenceDir}/kobra-missing-key-${width}.png`
        : test.info().outputPath(`kobra-missing-key-${width}.png`),
      fullPage: true,
    })
  })
}
