import { mkdir, mkdtemp, readdir, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { isAbsolute, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import AxeBuilder from '@axe-core/playwright'
import { expect, test, type Page } from '@playwright/test'
import { setPolishTheme } from '../helpers/polish-theme.ts'
import { mockShellApi } from '../helpers/shell-api.ts'

// UI checks of the Spoolman page (apps/farm/app/pages/spoolman.vue) served by
// the real Nuxt build. Every /api route is mocked here and any request that
// leaves loopback is aborted, so no database, Connector, Spoolman, printer or
// external network is involved.
//
// Evidence runs in Docker, offline, on Node 22:
//
//   node tests/e2e/run-spools-docker.mjs
//
// which runs `npx playwright test tests/e2e/polish-spools.spec.ts` in a
// container with no network. The screenshot test always runs: it writes to
// POLISH_SPOOLS_SHOTS_DIR, or to a fresh temp folder, never into the repo.
const farm = '00000000-0000-4000-8000-0000000000f1'
const agentA = '00000000-0000-4000-8000-0000000000a1'
const agentB = '00000000-0000-4000-8000-0000000000a2'
const serviceId = '00000000-0000-4000-8000-0000000000b1'
const longOrigin = `http://spoolman-da-sala-de-impressao-${'x'.repeat(40)}.lan:7912`

const viewports = [
  { name: '360', width: 360, height: 800 },
  { name: 'desktop', width: 1280, height: 900 },
] as const
const themes = ['light', 'dark'] as const

type Scenario =
  | 'populated'
  | 'empty'
  | 'no-connectors'
  | 'viewer'
  | 'no-farm'
  | 'loading'
  | 'error'
  | 'sign-in'

const scenarios: Scenario[] = [
  'populated',
  'empty',
  'no-connectors',
  'viewer',
  'no-farm',
  'loading',
  'error',
  'sign-in',
]

const settings = [
  {
    agentId: agentA,
    origin: longOrigin,
    serviceId,
    status: 'reachable',
    configured: true,
    checkedAt: Date.UTC(2026, 10, 20, 13, 30),
  },
  {
    agentId: agentB,
    origin: 'http://192.168.1.60:7912',
    status: 'unauthorized',
    configured: false,
    checkedAt: Date.UTC(2026, 10, 20, 13, 31),
  },
]

async function mockApi(page: Page, scenario: Scenario) {
  // Anything not mocked below never leaves the test.
  await page.route(
    (url) => !['127.0.0.1', 'localhost'].includes(url.hostname),
    (route) => route.abort(),
  )
  await page.route('**/api/**', (route) =>
    route.fulfill({ status: 404, json: {} }),
  )
  await mockShellApi(page, farm)
  await page.route('**/api/auth/me', (route) =>
    scenario === 'sign-in'
      ? route.fulfill({ status: 401, json: {} })
      : route.fulfill({ json: { accountId: 'conta-sintetica' } }),
  )
  await page.route('**/api/farms?*', async (route) => {
    if (scenario === 'loading') await new Promise(() => undefined)
    if (scenario === 'sign-in') return route.fulfill({ status: 401, json: {} })
    if (scenario === 'error') return route.fulfill({ status: 503, json: {} })
    return route.fulfill({
      json: {
        farms: scenario === 'no-farm' ? [] : [{ farmId: farm }],
        nextAfter: null,
      },
    })
  })
  await page.route(`**/api/farms/${farm}/spoolman`, (route) =>
    route.fulfill({
      json: {
        settings:
          scenario === 'populated' || scenario === 'viewer' ? settings : [],
        canManage: scenario !== 'viewer',
      },
    }),
  )
  await page.route(`**/api/farms/${farm}/connectors`, (route) =>
    route.fulfill({
      json: {
        connectors:
          scenario === 'no-connectors'
            ? [{ agentId: agentA, status: 'pending' }]
            : [
                { agentId: agentA, status: 'approved' },
                { agentId: agentB, status: 'approved' },
              ],
      },
    }),
  )
  await page.route('**/api/browser-devices?*', (route) =>
    route.fulfill({
      json: {
        currentAccountId: 'conta-sintetica',
        currentRole: scenario === 'viewer' ? 'viewer' : 'owner',
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
  await page.goto('/spoolman')
  await expect(
    page.getByRole('heading', { level: 1, name: 'Spoolman da farm' }),
  ).toBeVisible()
  await settle(page, scenario)
}

// Waits only on copy that exists before and after the polish, so the same
// capture also records the genuine pre-change screen.
async function settle(page: Page, scenario: Scenario) {
  switch (scenario) {
    case 'populated':
    case 'viewer':
      await expect(page.getByRole('table')).toBeVisible()
      break
    case 'empty':
    case 'no-connectors':
      await expect(page.getByText('Nenhum Spoolman configurado')).toBeVisible()
      break
    case 'no-farm':
      await expect(page.getByText('Nenhuma farm disponível')).toBeVisible()
      break
    case 'loading':
      await expect(page.getByText('Carregando o Spoolman…')).toBeVisible()
      break
    case 'error':
    case 'sign-in':
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

for (const scenario of scenarios)
  for (const viewport of viewports)
    for (const theme of themes)
      test(`${scenario} state is accessible and fits at ${viewport.name} in the ${theme} theme`, async ({
        page,
      }) => {
        await open(page, scenario, viewport, theme)
        expect(await fits(page)).toBe(true)
        expect(await violations(page)).toEqual([])
      })

test('page has one main, one h1 and headings in order', async ({ page }) => {
  await open(page, 'populated', viewports[1], 'light')
  await expect(page.getByRole('main')).toHaveCount(1)
  await expect(page.getByRole('heading', { level: 1 })).toHaveCount(1)
  await expect(
    page.getByRole('region', { name: 'Conectar o Spoolman' }),
  ).toBeVisible()
  const levels = await page
    .locator('main h1, main h2, main h3, main h4')
    .evaluateAll((nodes) => nodes.map((node) => Number(node.tagName[1])))
  expect(levels[0]).toBe(1)
  for (const [index, level] of levels.entries())
    if (index > 0) expect(level - levels[index - 1]!).toBeLessThanOrEqual(1)
  await expect(page.getByRole('columnheader')).toHaveCount(5)
  await expect(
    page.getByRole('columnheader', { name: 'UUID do serviço' }),
  ).toBeVisible()
  await expect(page.getByRole('cell', { name: longOrigin })).toBeVisible()
  await expect(page.getByRole('cell', { name: serviceId })).toBeVisible()
  await expect(page.getByText('Não autorizado (não aplicado)')).toBeVisible()
})

test('form fields are labelled and touch sized; secrets are password fields', async ({
  page,
}) => {
  await open(page, 'empty', viewports[0], 'light')
  const form = page.getByRole('region', { name: 'Conectar o Spoolman' })
  for (const label of [
    'Endereço do Spoolman',
    'Usuário (opcional)',
    'Senha (opcional)',
    'Token (alternativa a usuário e senha)',
    'UUID do serviço (opcional)',
  ]) {
    const field = form.getByLabel(label)
    await expect(field).toBeVisible()
    expect((await field.boundingBox())!.height).toBeGreaterThanOrEqual(44)
  }
  await expect(form.getByLabel('Senha (opcional)')).toHaveAttribute(
    'type',
    'password',
  )
  await expect(form.getByLabel('UUID do serviço (opcional)')).toHaveAttribute(
    'aria-describedby',
    'spoolman-service-id-help',
  )
  expect(await violations(page)).toEqual([])
  await expect(form.getByLabel('Token (alternativa')).toHaveAttribute(
    'type',
    'password',
  )
  const submit = form.getByRole('button', { name: 'Testar conexão e salvar' })
  await expect(submit).toBeEnabled()
  expect((await submit.boundingBox())!.height).toBeGreaterThanOrEqual(44)
})

test('service UUID accepts a valid value and announces invalid values in Portuguese', async ({
  page,
}) => {
  await open(page, 'empty', viewports[1], 'light')
  const serviceField = page.getByLabel('UUID do serviço (opcional)')
  await expect(serviceField).toBeVisible()
  await serviceField.fill('00000000-0000-4000-8000-0000000000b1')
  await expect(serviceField).toHaveValue('00000000-0000-4000-8000-0000000000b1')
  await serviceField.fill('uuid-invalido')
  await page.getByRole('button', { name: 'Testar conexão e salvar' }).click()
  const error = page.getByRole('alert')
  await expect(error).toBeFocused()
  await expect(error).toContainText(
    'Informe um UUID válido para o serviço Spoolman.',
  )
})

test('submitting without an approved browser key clears secrets and focuses the reason', async ({
  page,
}) => {
  const writes: string[] = []
  page.on('request', (request) => {
    if (request.method() !== 'GET') writes.push(request.url())
  })
  await open(page, 'empty', viewports[1], 'light')
  await page.getByLabel('Endereço do Spoolman').fill('http://192.168.1.60:7912')
  await page.getByLabel('Token (alternativa').fill('segredo-sintetico')
  await page.getByRole('button', { name: 'Testar conexão e salvar' }).click()
  await expect(page.getByRole('alert')).toBeFocused()
  await expect(page.getByRole('alert')).toContainText(
    'Dispositivos do navegador',
  )
  // The safety check rejects before any Connector session or write.
  expect(writes).toEqual([])
})

test('no approved Connector disables the submit button and says why', async ({
  page,
}) => {
  await open(page, 'no-connectors', viewports[0], 'dark')
  await expect(
    page.getByRole('button', { name: 'Testar conexão e salvar' }),
  ).toBeDisabled()
  await expect(
    page.getByText(
      'Nenhum Connector aprovado nesta farm para receber a configuração.',
    ),
  ).toBeVisible()
})

test('viewers see the saved settings without the form', async ({ page }) => {
  await open(page, 'viewer', viewports[0], 'light')
  await expect(
    page.getByText('Apenas proprietários e administradores configuram'),
  ).toBeVisible()
  await expect(page.getByLabel('Endereço do Spoolman')).toHaveCount(0)
  await expect(page.getByRole('table')).toBeVisible()
})

test('loading is announced and marks the content busy', async ({ page }) => {
  await open(page, 'loading', viewports[0], 'light')
  await expect(
    page.getByRole('status').filter({ hasText: 'Carregando o Spoolman…' }),
  ).toBeVisible()
  await expect(page.locator('main [aria-busy="true"]')).toHaveCount(1)
})

test('load failure focuses the alert and retry is a real button that reloads', async ({
  page,
}) => {
  await open(page, 'error', viewports[0], 'light')
  await expect(page.getByRole('alert')).toContainText(
    'Não foi possível carregar o Spoolman. Tente novamente.',
  )
  await expect(page.getByRole('link', { name: 'Entrar' })).toHaveCount(0)
  await page.unroute('**/api/farms?*')
  await page.route('**/api/farms?*', (route) =>
    route.fulfill({ json: { farms: [{ farmId: farm }], nextAfter: null } }),
  )
  await page.getByRole('button', { name: 'Tentar novamente' }).click()
  await expect(page.getByRole('alert')).toHaveCount(0)
  await expect(page.getByText('Nenhum Spoolman configurado')).toBeVisible()
})

test('expired session explains it and links to sign in', async ({ page }) => {
  await open(page, 'sign-in', viewports[0], 'dark')
  await expect(page.getByRole('alert')).toContainText(
    'Entre na sua conta para configurar o Spoolman.',
  )
  await expect(
    page.getByRole('main').getByRole('link', { name: 'Entrar' }),
  ).toHaveAttribute('href', '/entrar')
})

test('no farm offers the way out', async ({ page }) => {
  await open(page, 'no-farm', viewports[0], 'light')
  await expect(
    page.getByRole('link', { name: 'Ir para farms' }),
  ).toHaveAttribute('href', '/farm')
  await expect(page.getByRole('table')).toHaveCount(0)
})

test('keyboard reaches every form control in order with a visible focus ring', async ({
  page,
}) => {
  await open(page, 'empty', viewports[1], 'light')
  await page.getByLabel('Endereço do Spoolman').focus()
  const seen: string[] = []
  for (let step = 0; step < 6; step++) {
    const focus = await page.evaluate(() => {
      const element = document.activeElement as HTMLElement
      const style = getComputedStyle(element)
      return {
        id: element.id || element.textContent?.trim() || element.tagName,
        outline: style.outlineStyle !== 'none' && style.outlineWidth !== '0px',
      }
    })
    expect(focus.outline, `${focus.id} has no focus ring`).toBe(true)
    seen.push(focus.id)
    await page.keyboard.press('Tab')
  }
  expect(seen).toEqual([
    'spoolman-origin',
    'spoolman-service-id',
    'spoolman-username',
    'spoolman-password',
    'spoolman-token',
    'Testar conexão e salvar',
  ])
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

async function shotsDir() {
  const repo = resolve(fileURLToPath(new URL('../..', import.meta.url)))
  const dir =
    process.env.POLISH_SPOOLS_SHOTS_DIR ??
    (await mkdtemp(join(tmpdir(), 'openfarm-spools-shots-')))
  const inside = relative(repo, resolve(dir))
  expect(
    isAbsolute(dir) && (inside.startsWith('..') || isAbsolute(inside)),
    `screenshot folder ${dir} must be absolute and outside the repository`,
  ).toBe(true)
  await mkdir(dir, { recursive: true })
  return dir
}

test('screenshots of real screen states', async ({ page }, testInfo) => {
  testInfo.setTimeout(240_000)
  const dir = await shotsDir()
  const expected: string[] = []
  for (const scenario of scenarios)
    for (const viewport of viewports)
      for (const theme of themes) {
        await page.unrouteAll({ behavior: 'ignoreErrors' })
        await open(page, scenario, viewport, theme)
        const name = `${scenario}-${viewport.name}-${theme}.png`
        await page.screenshot({ path: join(dir, name), fullPage: true })
        expect((await stat(join(dir, name))).size).toBeGreaterThan(1000)
        expected.push(name)
      }
  const written = (await readdir(dir)).filter((file) => file.endsWith('.png'))
  expect(written.sort()).toEqual(expected.sort())
  console.log(`Screenshots: ${dir} (${expected.length})`)
})
