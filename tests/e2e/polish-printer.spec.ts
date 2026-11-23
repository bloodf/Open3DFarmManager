import { mkdir, mkdtemp, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import AxeBuilder from '@axe-core/playwright'
import { expect, test, type Page } from '@playwright/test'
import { setPolishTheme } from '../helpers/polish-theme.ts'
import { mockShellApi } from '../helpers/shell-api.ts'

// Isolated UI checks for the printer detail screen on mocked /api routes. No
// real printer, database, auth service or external network is involved: every
// request that is not served by the page itself is fulfilled here or aborted,
// and the direct (WebRTC) connection never opens because no browser device key
// is registered, so no command can reach a printer.
//
// Screenshots are saved outside the repository for evidence.
const farm = '00000000-0000-4000-8000-0000000000f1'
const agent = '00000000-0000-4000-8000-0000000000a1'
const assignment = '00000000-0000-4000-8000-0000000000b1'
const shortKey = 'ender-bancada'
const longKey = `impressora-com-um-nome-muito-longo-${'x'.repeat(70)}`
const missingKey = 'impressora-que-nao-existe'

const viewports = [
  { name: '360', width: 360, height: 800 },
  { name: 'desktop', width: 1280, height: 900 },
] as const
const themes = ['light', 'dark'] as const

type Scenario =
  'populated' | 'long-name' | 'not-found' | 'loading' | 'sign-in' | 'error'

const keyFor = (scenario: Scenario) =>
  scenario === 'long-name'
    ? longKey
    : scenario === 'not-found'
      ? missingKey
      : shortKey

async function mockApi(page: Page, scenario: Scenario) {
  // Anything not mocked below never leaves the test.
  await page.route(
    (url) => !['127.0.0.1', 'localhost'].includes(url.hostname),
    (route) => route.abort(),
  )
  await mockShellApi(page, farm)
  await page.route('**/api/auth/me', async (route) => {
    if (scenario === 'sign-in') return route.fulfill({ status: 401, json: {} })
    if (scenario === 'error') return route.fulfill({ status: 503, json: {} })
    return route.fulfill({ json: { accountId: 'conta-sintetica' } })
  })
  await page.route('**/api/farms?*', (route) =>
    route.fulfill({ json: { farms: [{ farmId: farm }], nextAfter: null } }),
  )
  await page.route(`**/api/farms/${farm}/printers?*`, async (route) => {
    if (scenario === 'loading') await new Promise(() => undefined)
    return route.fulfill({
      json: {
        printers: [
          {
            assignmentId: assignment,
            agentId: agent,
            printerKey: keyFor(scenario),
            status: 'active',
            connectorStatus: 'approved',
            ...(scenario === 'populated'
              ? {
                  displayName: 'Ender da bancada',
                  groupName: 'Sala 1',
                  location: 'Bancada A',
                }
              : {}),
          },
        ].filter(() => scenario !== 'not-found'),
        nextAfter: null,
        canManage: true,
      },
    })
  })
  await page.route(`**/api/farms/${farm}/status-summary*`, (route) =>
    route.fulfill({
      json: {
        generatedAt: Date.now(),
        total: scenario === 'not-found' ? 0 : 1,
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
  await setPolishTheme(page, theme)
  await mockApi(page, scenario)
  await page.goto(`/impressoras/${keyFor(scenario)}`)
  await settle(page, scenario)
}

async function settle(page: Page, scenario: Scenario) {
  switch (scenario) {
    case 'populated':
      await expect(
        page.getByRole('heading', {
          level: 1,
          name: 'Ender da bancada',
          exact: true,
        }),
      ).toBeVisible()
      break
    case 'long-name':
      await expect(
        page.getByRole('heading', { level: 1, name: longKey, exact: true }),
      ).toBeVisible()
      break
    case 'not-found':
      await expect(
        page.getByRole('heading', {
          level: 1,
          name: 'Impressora não encontrada',
        }),
      ).toBeVisible()
      break
    case 'loading':
      await expect(page.getByText('Carregando a impressora…')).toBeVisible()
      break
    case 'sign-in':
      await expect(
        page.getByRole('region', { name: 'Acesso à farm' }),
      ).toBeVisible()
      break
    case 'error':
      await expect(page.getByRole('alert')).toBeVisible()
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
  'long-name',
  'not-found',
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

test('page has one main landmark, one h1, ordered headings and a named navigation', async ({
  page,
}) => {
  await open(page, 'populated', viewports[1], 'light')
  await expect(page.getByRole('main')).toHaveCount(1)
  await expect(page.getByRole('heading', { level: 1 })).toHaveCount(1)
  const nav = page.getByRole('navigation', { name: 'Navegação da impressora' })
  await expect(nav.getByRole('listitem')).toHaveCount(2)
  await expect(nav.getByRole('link', { name: 'Minha farm' })).toHaveAttribute(
    'href',
    '/farm',
  )
  await expect(nav.getByRole('link', { name: 'Impressoras' })).toHaveAttribute(
    'href',
    '/impressoras',
  )
  const levels = await page
    .locator('h1, h2, h3, h4, h5, h6')
    .evaluateAll((nodes) => nodes.map((node) => Number(node.tagName[1])))
  expect(levels[0]).toBe(1)
  for (const [index, level] of levels.entries())
    if (index > 0) expect(level - levels[index - 1]!).toBeLessThanOrEqual(1)
})

test('keeps the emergency stop disabled and explained without a direct connection', async ({
  page,
}) => {
  await open(page, 'populated', viewports[0], 'light')
  const stop = page.getByRole('button', { name: 'Parada de emergência' })
  await expect(stop).toBeDisabled()
  await expect(stop).toHaveAccessibleDescription(
    'Indisponível sem conexão direta atual e autorizada.',
  )
  await expect(
    page.getByText('Sem conexão direta: exibindo o último valor conhecido'),
  ).toBeVisible()
  await expect(page.getByRole('dialog')).toHaveCount(0)
})

test('moves focus to the heading of the screen that loaded', async ({
  page,
}) => {
  await open(page, 'populated', viewports[1], 'light')
  await expect(
    page.getByRole('heading', { level: 1, name: 'Ender da bancada' }),
  ).toBeFocused()
})

test('long printer names wrap inside the viewport at 360px', async ({
  page,
}) => {
  await open(page, 'long-name', viewports[0], 'light')
  const box = await page
    .getByRole('heading', { level: 1, name: longKey, exact: true })
    .boundingBox()
  expect(box).not.toBeNull()
  expect(box!.x + box!.width).toBeLessThanOrEqual(360)
  expect(await fits(page)).toBe(true)
})

test('not-found state explains why and offers the way out', async ({
  page,
}) => {
  await open(page, 'not-found', viewports[0], 'light')
  await expect(
    page.getByText(
      'Nenhuma impressora com este identificador está atribuída à farm selecionada.',
    ),
  ).toBeVisible()
  await expect(
    page.getByRole('link', { name: 'Ver impressoras da farm' }),
  ).toHaveAttribute('href', '/impressoras')
  await expect(
    page.getByRole('heading', { level: 1, name: 'Impressora não encontrada' }),
  ).toBeFocused()
})

test('loading state is announced and marks its region busy', async ({
  page,
}) => {
  await open(page, 'loading', viewports[0], 'light')
  await expect(
    page.getByRole('status').filter({ hasText: 'Carregando a impressora' }),
  ).toBeVisible()
  await expect(page.locator('[aria-busy="true"]')).toHaveCount(1)
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Impressora')
})

test('sign-in state keeps one h1 and links to the sign-in page', async ({
  page,
}) => {
  await open(page, 'sign-in', viewports[0], 'light')
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(
    'Entre para ver a impressora',
  )
  await expect(page.getByRole('link', { name: 'Entrar' })).toHaveAttribute(
    'href',
    '/entrar',
  )
})

test('error state announces the failure, focuses it and offers retry and sign-in', async ({
  page,
}) => {
  await open(page, 'error', viewports[0], 'light')
  const alert = page.getByRole('alert')
  await expect(alert).toHaveText(
    'Não foi possível confirmar seus dados. Tente novamente.',
  )
  await expect(alert).toBeFocused()
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Impressora')
  await expect(
    page.getByRole('heading', {
      level: 2,
      name: 'Não foi possível carregar a impressora',
    }),
  ).toBeVisible()
  await expect(
    page.getByRole('button', { name: 'Tentar novamente' }),
  ).toBeVisible()
  await expect(
    page.getByRole('link', { name: 'Entrar novamente' }),
  ).toHaveAttribute('href', '/entrar')
})

test('keyboard reaches the navigation links in order with a visible focus ring', async ({
  page,
}) => {
  await open(page, 'populated', viewports[1], 'light')
  await page.getByRole('heading', { level: 1 }).focus()
  await page.keyboard.press('Shift+Tab')
  const seen: string[] = []
  for (let step = 0; step < 2; step++) {
    const focus = await page.evaluate(() => {
      const element = document.activeElement as HTMLElement | null
      if (!element || element === document.body) return null
      const style = getComputedStyle(element)
      return {
        label: element.textContent?.trim() ?? '',
        outline: style.outlineStyle !== 'none' && style.outlineWidth !== '0px',
      }
    })
    expect(focus, `Tab stop ${step + 1} lost focus`).not.toBeNull()
    expect(focus?.outline, `${focus?.label} has no focus ring`).toBe(true)
    seen.push(focus!.label)
    await page.keyboard.press('Shift+Tab')
  }
  expect(seen.reverse()).toEqual(['Minha farm', 'Impressoras'])
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
  const dir =
    process.env.POLISH_PRINTER_SHOTS_DIR ??
    (await mkdtemp(join(tmpdir(), 'openfarm-printer-shots-')))
  await mkdir(dir, { recursive: true })
  testInfo.setTimeout(240_000)
  for (const scenario of scenarios)
    for (const viewport of viewports)
      for (const theme of themes) {
        await page.unrouteAll({ behavior: 'ignoreErrors' })
        await open(page, scenario, viewport, theme)
        const path = join(dir, `${scenario}-${viewport.name}-${theme}.png`)
        await page.screenshot({ path, fullPage: true })
        expect((await stat(path)).size).toBeGreaterThan(0)
      }
})
