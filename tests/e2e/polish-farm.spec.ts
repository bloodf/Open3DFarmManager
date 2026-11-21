import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import AxeBuilder from '@axe-core/playwright'
import { expect, test, type Page } from '@playwright/test'

// Isolated UI checks on mocked /api routes. No real printer, database, auth
// service or external network is involved: every request that is not served by
// the page itself is either fulfilled here or aborted.
//
// Screenshots are an opt-in side effect: set POLISH_FARM_SHOTS_DIR to a folder
// outside the repository and run with `--grep screenshots`.
const farm = '00000000-0000-4000-8000-0000000000f1'
const agent = '00000000-0000-4000-8000-0000000000a1'
const firstAssignment = '00000000-0000-4000-8000-0000000000b1'
const secondAssignment = '00000000-0000-4000-8000-0000000000b2'
const longKey = `impressora-com-um-nome-muito-longo-${'x'.repeat(70)}`

const viewports = [
  { name: '360', width: 360, height: 800 },
  { name: 'desktop', width: 1280, height: 900 },
] as const
const themes = ['light', 'dark'] as const

type Scenario =
  'populated' | 'empty' | 'no-farms' | 'loading' | 'sign-in' | 'error'

const printer = (assignmentId: string, printerKey: string, extra = {}) => ({
  assignmentId,
  agentId: agent,
  printerKey,
  status: 'active',
  connectorStatus: 'approved',
  ...extra,
})

async function mockApi(page: Page, scenario: Scenario) {
  // Anything not mocked below never leaves the test.
  await page.route(
    (url) => !['127.0.0.1', 'localhost'].includes(url.hostname),
    (route) => route.abort(),
  )
  await page.route('**/api/auth/me', async (route) => {
    if (scenario === 'sign-in') return route.fulfill({ status: 401, json: {} })
    if (scenario === 'error') return route.fulfill({ status: 503, json: {} })
    return route.fulfill({ json: { accountId: 'conta-sintetica' } })
  })
  await page.route('**/api/farms?*', (route) =>
    route.fulfill({
      json: {
        farms: scenario === 'no-farms' ? [] : [{ farmId: farm }],
        nextAfter: null,
      },
    }),
  )
  await page.route(`**/api/farms/${farm}/printers?*`, async (route) => {
    if (scenario === 'loading') await new Promise(() => undefined)
    const printers =
      scenario === 'empty'
        ? []
        : [
            printer(firstAssignment, longKey, {
              displayName: 'Ender da bancada',
              groupName: 'Sala 1',
              location: 'Bancada A',
            }),
            printer(secondAssignment, 'impressora-2', {
              groupName: 'Sala 2',
              location: 'Bancada B',
            }),
          ]
    return route.fulfill({
      json: { printers, nextAfter: null, canManage: true },
    })
  })
  await page.route(`**/api/farms/${farm}/status-summary*`, (route) =>
    route.fulfill({
      json: {
        generatedAt: Date.now(),
        total: scenario === 'empty' ? 0 : 2,
        counts: {},
        truncated: false,
        printers: [],
      },
    }),
  )
  await page.route(`**/api/farms/${farm}/printer-states*`, (route) =>
    route.fulfill({ json: { states: [] } }),
  )
  await page.route(`**/api/farms/${farm}/integrations/approvals*`, (route) =>
    route.fulfill({ status: 403, json: {} }),
  )
  await page.route('**/api/browser-devices?*', (route) =>
    route.fulfill({
      json: {
        currentAccountId: 'conta-sintetica',
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

async function open(
  page: Page,
  scenario: Scenario,
  viewport: (typeof viewports)[number],
  theme: (typeof themes)[number],
) {
  await page.setViewportSize(viewport)
  await page.emulateMedia({ colorScheme: theme, reducedMotion: 'reduce' })
  await mockApi(page, scenario)
  await page.goto('/farm')
  const heading = page.getByRole('heading', {
    level: 1,
    name: 'Minha farm',
    exact: true,
  })
  // On failure focus moves on to the alert, so only the other states keep it.
  if (scenario === 'error') await expect(heading).toBeVisible()
  else await expect(heading).toBeFocused()
  await settle(page, scenario)
}

async function settle(page: Page, scenario: Scenario) {
  switch (scenario) {
    case 'populated':
      await expect(page.locator(`#printer-${firstAssignment}`)).toHaveText(
        longKey,
      )
      break
    case 'empty':
      await expect(
        page.getByText('Nenhuma impressora atribuída a esta farm.'),
      ).toBeVisible()
      break
    case 'no-farms':
      await expect(
        page.getByText('Sua conta ainda não tem acesso a uma farm.'),
      ).toBeVisible()
      break
    case 'loading':
      await expect(
        page.getByText('Carregando o cadastro de impressoras…'),
      ).toBeVisible()
      break
    case 'sign-in':
      await expect(
        page.getByRole('region', { name: 'Acesso à farm' }),
      ).toBeVisible()
      break
    case 'error':
      await expect(page.getByRole('alert')).toBeFocused()
      break
  }
}

async function violations(page: Page) {
  const result = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
    .analyze()
  return result.violations.map((violation) => ({
    id: violation.id,
    impact: violation.impact,
    nodes: violation.nodes.map((node) => ({
      target: node.target,
      failureSummary: node.failureSummary,
    })),
  }))
}

const fits = (page: Page) =>
  page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)

const scenarios: Scenario[] = [
  'populated',
  'empty',
  'no-farms',
  'loading',
  'sign-in',
  'error',
]

for (const scenario of scenarios) {
  for (const viewport of viewports) {
    for (const theme of themes) {
      test(`${scenario} state is accessible and fits at ${viewport.name} in the ${theme} theme`, async ({
        page,
      }) => {
        await open(page, scenario, viewport, theme)
        expect(await fits(page)).toBe(true)
        expect(await violations(page)).toEqual([])
      })
    }
  }
}

test('page has one landmark main, one h1 and ordered headings with a named navigation', async ({
  page,
}) => {
  await open(page, 'populated', viewports[1], 'light')
  await expect(page.getByRole('main')).toHaveCount(1)
  await expect(page.getByRole('heading', { level: 1 })).toHaveCount(1)
  await expect(
    page.getByRole('navigation', { name: 'Navegação da farm' }),
  ).toBeVisible()
  const levels = await page
    .locator('h1, h2, h3, h4, h5, h6')
    .evaluateAll((nodes) => nodes.map((node) => Number(node.tagName[1])))
  for (const [index, level] of levels.entries())
    if (index > 0) expect(level - levels[index - 1]!).toBeLessThanOrEqual(1)
})

test('filters are a named search landmark and Enter never reloads the page', async ({
  page,
}) => {
  await open(page, 'populated', viewports[1], 'light')
  const search = page.getByRole('search', { name: 'Filtrar impressoras' })
  await expect(search).toBeVisible()
  const field = search.getByLabel('Buscar impressora, Connector ou atribuição')
  await field.fill('impressora-2')
  await page.evaluate(() => {
    ;(window as unknown as { marker: string }).marker = 'kept'
  })
  await field.press('Enter')
  expect(
    await page.evaluate(() => (window as unknown as { marker: string }).marker),
  ).toBe('kept')
  await expect(page.getByRole('status').filter({ hasText: 'de 2' })).toHaveText(
    '1 de 2 impressoras nesta página.',
  )
  await search.getByRole('button', { name: 'Limpar filtros' }).click()
  await expect(page.getByRole('status').filter({ hasText: 'de 2' })).toHaveText(
    '2 de 2 impressoras nesta página.',
  )
})

test('empty state explains why and offers the way out; loading is announced and busy', async ({
  page,
}) => {
  await open(page, 'empty', viewports[0], 'light')
  await expect(
    page.getByRole('link', { name: 'Gerenciar atribuições' }),
  ).toHaveAttribute('href', '/impressoras')
  await expect(page.locator('article')).toHaveCount(0)
})

test('loading state is announced and marks the region busy', async ({
  page,
}) => {
  await open(page, 'loading', viewports[0], 'light')
  await expect(
    page.getByRole('status').filter({ hasText: 'Carregando o cadastro' }),
  ).toBeVisible()
  await expect(
    page.getByRole('region', { name: 'Impressoras atribuídas' }),
  ).toHaveAttribute('aria-busy', 'true')
})

test('error state moves focus to the alert and retry is a real button', async ({
  page,
}) => {
  await open(page, 'error', viewports[0], 'light')
  await expect(page.getByRole('alert')).toHaveText(
    'Não foi possível confirmar seus dados. Tente novamente.',
  )
  await expect(
    page.getByRole('button', { name: 'Tentar novamente' }),
  ).toBeVisible()
  await expect(
    page.getByRole('link', { name: 'Entrar novamente' }),
  ).toHaveAttribute('href', '/entrar')
  await expect(page.getByRole('article')).toHaveCount(0)
})

test('keyboard reaches navigation, scope and filters in order with a visible focus ring', async ({
  page,
}) => {
  await open(page, 'populated', viewports[1], 'light')
  const seen: string[] = []
  for (let step = 0; step < 14; step++) {
    await page.keyboard.press('Tab')
    const focus = await page.evaluate(() => {
      const element = document.activeElement as HTMLElement | null
      if (!element || element === document.body) return null
      const style = getComputedStyle(element)
      return {
        label:
          element.getAttribute('aria-label') ||
          element.id ||
          element.textContent?.trim().slice(0, 40) ||
          element.tagName,
        outline: style.outlineStyle !== 'none' && style.outlineWidth !== '0px',
      }
    })
    expect(focus, `Tab stop ${step + 1} lost focus`).not.toBeNull()
    expect(focus?.outline, `${focus?.label} has no focus ring`).toBe(true)
    seen.push(focus!.label)
  }
  expect(seen.slice(0, 6)).toEqual([
    'Início',
    'Arquivos',
    'Impressoras',
    'Connectors',
    'Dispositivos do navegador',
    'Sair da conta',
  ])
  expect(seen).toContain('farm-scope')
  expect(seen).toContain('farm-search')
})

test('makes no request outside the loopback host', async ({ page }) => {
  const external: string[] = []
  page.on('request', (request) => {
    const { hostname, protocol } = new URL(request.url())
    if (
      protocol.startsWith('http') &&
      !['127.0.0.1', 'localhost'].includes(hostname)
    )
      external.push(request.url())
  })
  await open(page, 'populated', viewports[1], 'dark')
  expect(external).toEqual([])
})

test('screenshots of real screen states', async ({ page }, testInfo) => {
  const dir = process.env.POLISH_FARM_SHOTS_DIR
  test.skip(!dir, 'set POLISH_FARM_SHOTS_DIR to capture evidence screenshots')
  await mkdir(dir!, { recursive: true })
  testInfo.setTimeout(180_000)
  for (const scenario of scenarios)
    for (const viewport of viewports)
      for (const theme of themes) {
        await page.unrouteAll({ behavior: 'ignoreErrors' })
        await open(page, scenario, viewport, theme)
        await page.screenshot({
          path: join(dir!, `${scenario}-${viewport.name}-${theme}.png`),
          fullPage: true,
        })
      }
})
