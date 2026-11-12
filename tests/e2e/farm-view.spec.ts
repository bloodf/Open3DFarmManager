import AxeBuilder from '@axe-core/playwright'
import { expect, test, type Page } from '@playwright/test'

// Isolated UI checks only. Use playwright.farm-view.config.ts with a built app.
// FARM_VIEW_E2E=true selects these tests; the default flag-off suite stays unchanged.
test.skip(
  process.env.FARM_VIEW_E2E !== 'true',
  'Requires an opt-in farmView build; does not prove real DB/auth/RTC acceptance.',
)
const farm = '00000000-0000-4000-8000-000000000001'
const agent = '00000000-0000-4000-8000-000000000002'
const assignment = '00000000-0000-4000-8000-000000000003'
const key = `  e\u0301/<script>打印机</script> ${'x'.repeat(60)}  `
async function inventory(page: Page) {
  await page.route('**/api/auth/me', (route) =>
    route.fulfill({ json: { accountId: 'synthetic-ui-account' } }),
  )
  await page.route('**/api/farms?*', (route) =>
    route.fulfill({ json: { farms: [{ farmId: farm }], nextAfter: null } }),
  )
  await page.route(`**/api/farms/${farm}/printers?*`, (route) =>
    route.fulfill({
      json: {
        printers: [
          {
            assignmentId: assignment,
            agentId: agent,
            printerKey: key,
            status: 'active',
            connectorStatus: 'approved',
          },
        ],
        nextAfter: null,
        canManage: true,
      },
    }),
  )
  await page.route('**/api/browser-devices?*', (route) =>
    route.fulfill({
      json: {
        currentAccountId: 'synthetic-ui-account',
        currentRole: 'owner',
        devices: [],
        nextAfter: null,
        limits: {
          pendingLifetimeMs: 86_400_000,
          proofLifetimeMs: 60_000,
          maxChallengesPerKey: 3,
        },
      },
    }),
  )
}

test('pt-BR inventory wraps exact keys at 320px, separates approval from status, and always disables pause', async ({
  page,
}) => {
  await inventory(page)
  await page.setViewportSize({ width: 320, height: 800 })
  await page.goto('/farm')
  await expect(
    page.getByRole('heading', { name: 'Minha farm', exact: true }),
  ).toBeFocused()
  await expect(page.getByLabel('Farm atual', { exact: true })).toHaveValue(farm)
  await expect(page.locator(`#printer-${assignment}`)).toHaveText(key)
  expect(
    await page
      .locator(`#printer-${assignment}`)
      .evaluate((node) => node.textContent),
  ).toBe(key)
  await expect(page.getByRole('article')).toContainText('Connector aprovado')
  await expect(page.getByRole('article')).toContainText(
    'Conexão direta indisponível',
  )
  await expect(page.getByRole('article')).toContainText(
    'Nenhum estado recebido',
  )
  await expect(
    page.getByRole('button', { name: 'Pausar impressão' }),
  ).toBeDisabled()
  await expect(page.locator('progress')).toHaveCount(0)
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true)
})

test('explicit origin setup has no outbound probe and renders an external anchor with privacy attributes', async ({
  page,
}) => {
  await inventory(page)
  const outbound: string[] = []
  page.on('request', (request) => {
    if (request.url().startsWith('http://printer.invalid'))
      outbound.push(request.url())
  })
  await page.goto('/farm')
  const setup = page.getByRole('button', {
    name: 'Configurar interface local',
    exact: true,
  })
  await setup.focus()
  await page.keyboard.press('Enter')
  await page.keyboard.press('Tab')
  await expect(
    page.getByLabel('Origem da interface local', { exact: true }),
  ).toBeFocused()
  await page
    .getByLabel('Origem da interface local', { exact: true })
    .fill('http://printer.invalid:8080/')
  await expect(page.getByRole('article')).toContainText(
    'Origem para conferir: http://printer.invalid:8080',
  )
  await page.keyboard.press('Tab')
  const confirmation = page.getByLabel(
    'Conferi que este endereço abre a interface local desta impressora.',
  )
  await expect(confirmation).toBeFocused()
  await page.keyboard.press('Space')
  await expect(confirmation).toBeChecked()
  await page.keyboard.press('Tab')
  const confirm = page.getByRole('button', {
    name: 'Confirmar interface local',
  })
  await expect(confirm).toBeFocused()
  await page.keyboard.press('Enter')
  const link = page.getByRole('link', { name: /Abrir interface local de/ })
  await expect(link).toHaveAttribute('href', 'http://printer.invalid:8080')
  await expect(link).toHaveAttribute('target', '_blank')
  await expect(link).toHaveAttribute('rel', 'noopener noreferrer')
  await expect(link).toHaveAttribute('referrerpolicy', 'no-referrer')
  expect(outbound).toEqual([])
  await page.evaluate(() => window.dispatchEvent(new Event('focus')))
  await expect(link).toHaveCount(0)
  await expect(page.getByRole('article')).toContainText(
    'Nenhum estado recebido',
  )
})

test('unauthenticated and failed requests never render a false empty inventory', async ({
  page,
}) => {
  await page.route('**/api/auth/me', (route) =>
    route.fulfill({ status: 401, json: {} }),
  )
  await page.goto('/farm')
  await expect(
    page.getByRole('link', { name: 'Entrar', exact: true }),
  ).toBeVisible()
  await expect(page.getByRole('article')).toHaveCount(0)
  await expect(
    page.getByText('Nenhuma impressora atribuída a esta farm.'),
  ).toHaveCount(0)
  await page.unroute('**/api/auth/me')
  await page.route('**/api/auth/me', (route) =>
    route.fulfill({ status: 503, json: {} }),
  )
  await page.evaluate(() => window.dispatchEvent(new Event('focus')))
  await expect(page.getByRole('alert')).toHaveText(
    'Não foi possível confirmar seus dados. Tente novamente.',
  )
  await expect(page.getByRole('alert')).toBeFocused()
  await expect(page.getByRole('article')).toHaveCount(0)
})

async function violations(page: Page) {
  const result = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
    .analyze()
  return result.violations.map((v) => ({
    id: v.id,
    impact: v.impact,
    helpUrl: v.helpUrl,
    nodes: v.nodes.map((n) => ({
      target: n.target,
      failureSummary: n.failureSummary,
    })),
  }))
}

for (const width of [320, 1280]) {
  test(`axe finds no WCAG A/AA violations in the farm inventory at ${width}px`, async ({
    page,
  }) => {
    await inventory(page)
    await page.setViewportSize({ width, height: 800 })
    await page.goto('/farm')
    await expect(page.locator(`#printer-${assignment}`)).toHaveText(key)
    expect(await violations(page)).toEqual([])
  })
}

test('axe finds no WCAG A/AA violations with the local interface form open and confirmed', async ({
  page,
}) => {
  await inventory(page)
  await page.goto('/farm')
  await page
    .getByRole('button', { name: 'Configurar interface local', exact: true })
    .click()
  await page
    .getByLabel('Origem da interface local', { exact: true })
    .fill('http://printer.invalid:8080/')
  expect(await violations(page)).toEqual([])
  await page
    .getByLabel(
      'Conferi que este endereço abre a interface local desta impressora.',
    )
    .check()
  await page.getByRole('button', { name: 'Confirmar interface local' }).click()
  await expect(
    page.getByRole('link', { name: /Abrir interface local de/ }),
  ).toBeVisible()
  expect(await violations(page)).toEqual([])
})

test('axe finds no WCAG A/AA violations in the sign-in and service-error states', async ({
  page,
}) => {
  await page.route('**/api/auth/me', (route) =>
    route.fulfill({ status: 401, json: {} }),
  )
  await page.goto('/farm')
  await expect(
    page.getByRole('link', { name: 'Entrar', exact: true }),
  ).toBeVisible()
  expect(await violations(page)).toEqual([])
  await page.unroute('**/api/auth/me')
  await page.route('**/api/auth/me', (route) =>
    route.fulfill({ status: 503, json: {} }),
  )
  await page.evaluate(() => window.dispatchEvent(new Event('focus')))
  await expect(page.getByRole('alert')).toBeFocused()
  expect(await violations(page)).toEqual([])
})
