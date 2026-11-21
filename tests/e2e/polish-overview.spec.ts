import { mkdir, mkdtemp, readdir, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import AxeBuilder from '@axe-core/playwright'
import { expect, test, type Page } from '@playwright/test'

// Isolated UI checks for the overview screens (/, /painel, /impressoras and
// /compatibilidade) on mocked /api routes. No real printer, database, auth
// service or external network is involved: every request that is not served by
// the app itself is either fulfilled here or aborted.
//
// Screenshots are always captured by the last test and saved outside the
// repository (POLISH_OVERVIEW_SHOTS_DIR or a temporary directory).
const farm = '00000000-0000-4000-8000-0000000000f1'
const otherFarm = '00000000-0000-4000-8000-0000000000f2'
const longKey = `impressora-com-um-nome-muito-longo-${'x'.repeat(70)}`

const viewports = [
  { name: '360', width: 360, height: 800 },
  { name: 'desktop', width: 1280, height: 900 },
] as const
const themes = ['light', 'dark'] as const

type Viewport = (typeof viewports)[number]
type Theme = (typeof themes)[number]

const scenarios = [
  {
    name: 'home',
    path: '/',
    heading: 'Sua farm de impressão, em um só lugar.',
  },
  {
    name: 'compat-catalog',
    path: '/compatibilidade',
    heading: 'Compatibilidade de impressoras',
  },
  {
    name: 'compat-filtered',
    path: '/compatibilidade',
    heading: 'Compatibilidade de impressoras',
  },
  {
    name: 'compat-empty',
    path: '/compatibilidade',
    heading: 'Compatibilidade de impressoras',
  },
  {
    name: 'printers-populated',
    path: '/impressoras',
    heading: 'Impressoras da farm',
  },
  {
    name: 'printers-read-only',
    path: '/impressoras',
    heading: 'Impressoras da farm',
  },
  {
    name: 'printers-empty',
    path: '/impressoras',
    heading: 'Impressoras da farm',
  },
  {
    name: 'printers-no-farms',
    path: '/impressoras',
    heading: 'Impressoras da farm',
  },
  {
    name: 'printers-loading',
    path: '/impressoras',
    heading: 'Impressoras da farm',
  },
  {
    name: 'printers-error',
    path: '/impressoras',
    heading: 'Impressoras da farm',
  },
  {
    name: 'wall-populated',
    path: '/painel',
    heading: 'Painel das impressoras',
  },
  { name: 'wall-empty', path: '/painel', heading: 'Painel das impressoras' },
  { name: 'wall-no-farm', path: '/painel', heading: 'Painel das impressoras' },
  { name: 'wall-loading', path: '/painel', heading: 'Painel das impressoras' },
  { name: 'wall-error', path: '/painel', heading: 'Painel das impressoras' },
  { name: 'wall-session', path: '/painel', heading: 'Painel das impressoras' },
  { name: 'wall-stale', path: '/painel', heading: 'Painel das impressoras' },
] as const
type Scenario = (typeof scenarios)[number]['name']

const printers = [
  {
    assignmentId: '00000000-0000-4000-8000-0000000000a1',
    agentId: '00000000-0000-4000-8000-0000000000b1',
    printerKey: longKey,
    status: 'active',
    connectorStatus: 'approved',
  },
  {
    assignmentId: '00000000-0000-4000-8000-0000000000a2',
    agentId: '00000000-0000-4000-8000-0000000000b1',
    printerKey: 'voron-24',
    status: 'active',
    connectorStatus: 'approved',
  },
]

const stateOf = (index: number, key: string, state: string) => ({
  assignmentId: `00000000-0000-4000-8000-0000000000a${index}`,
  printerKey: key,
  state,
  ...(state === 'printing' ? { progress: 0.42 } : {}),
  temperatures: { toolCelsius: 205, bedCelsius: 60 },
  observedAt: Date.now(),
  dataAgeMs: 0,
})
const summary = (items: ReturnType<typeof stateOf>[]) => ({
  generatedAt: Date.now(),
  total: items.length,
  counts: {},
  truncated: false,
  printers: items,
})

async function mockApi(page: Page, scenario: Scenario) {
  // Anything not mocked below never leaves the test.
  await page.route(
    (url) => !['127.0.0.1', 'localhost'].includes(url.hostname),
    (route) => route.abort(),
  )
  // Unknown app endpoints answer with an empty failure instead of a real call.
  await page.route('**/api/**', (route) =>
    route.fulfill({ status: 404, json: {} }),
  )
  await page.route('**/api/auth/me', (route) =>
    route.fulfill({ json: { accountId: 'conta-sintetica' } }),
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
  const farmsFor = (name: Scenario) =>
    name === 'printers-no-farms' || name === 'wall-no-farm'
      ? []
      : name === 'printers-read-only'
        ? [{ farmId: farm }, { farmId: otherFarm }]
        : [{ farmId: farm }]
  await page.route(/\/api\/farms(\?.*)?$/, async (route) => {
    if (scenario === 'printers-loading' || scenario === 'wall-loading')
      await new Promise(() => undefined)
    if (scenario === 'printers-error' || scenario === 'wall-error')
      return route.fulfill({ status: 500, json: {} })
    if (scenario === 'wall-session')
      return route.fulfill({ status: 401, json: {} })
    return route.fulfill({
      json: { farms: farmsFor(scenario), nextAfter: null },
    })
  })
  await page.route(`**/api/farms/${farm}/printers*`, (route) =>
    route.fulfill({
      json: {
        printers: scenario === 'printers-empty' ? [] : printers,
        nextAfter: null,
        canManage: scenario !== 'printers-read-only',
      },
    }),
  )
  await page.route(`**/api/farms/${farm}/connectors*`, (route) =>
    route.fulfill({ json: { connectors: [], nextAfter: null } }),
  )
  let polls = 0
  await page.route(`**/api/farms/${farm}/status-summary*`, (route) => {
    polls += 1
    if (scenario === 'wall-stale' && polls > 1)
      return route.fulfill({ status: 500, json: {} })
    return route.fulfill({
      json: summary(
        scenario === 'wall-empty'
          ? []
          : [
              stateOf(1, longKey, 'printing'),
              stateOf(2, 'voron-24', 'idle'),
              stateOf(3, 'prusa-mk4', 'paused'),
              stateOf(4, 'ender-3', 'error'),
              stateOf(5, 'bambu-x1', 'offline'),
            ],
      ),
    })
  })
}

async function open(
  page: Page,
  scenario: Scenario,
  viewport: Viewport,
  theme: Theme,
) {
  const entry = scenarios.find((item) => item.name === scenario)!
  await page.setViewportSize(viewport)
  await page.emulateMedia({ colorScheme: theme, reducedMotion: 'reduce' })
  await mockApi(page, scenario)
  await page.goto(entry.path)
  await page.getByRole('heading', { level: 1, name: entry.heading }).waitFor()
  // The baseline capture runs this spec against the pre-polish build, where
  // some of the waited-for text does not exist yet: it still takes the shot.
  if (process.env.POLISH_CAPTURE === '1') {
    await settle(page, scenario).catch(() => undefined)
    return
  }
  await settle(page, scenario)
}

/** Waits for the state each scenario ends in; no fixed sleeps. */
async function settle(page: Page, scenario: Scenario) {
  const wait = (locator: ReturnType<Page['getByText']>) =>
    locator.first().waitFor({ timeout: 15_000 })
  switch (scenario) {
    case 'compat-filtered':
      await page.getByLabel('Buscar marca ou modelo').fill('klipper')
      await wait(page.getByText('resultado(s)'))
      break
    case 'compat-empty':
      await page.getByLabel('Buscar marca ou modelo').fill('zzzz-sem-modelo')
      await wait(
        page.getByRole('heading', { name: 'Nenhum modelo encontrado' }),
      )
      break
    case 'printers-populated':
    case 'printers-read-only':
    case 'printers-empty':
      await page
        .locator('#printer-farm')
        .selectOption(farm, { timeout: 15_000 })
      await wait(
        scenario === 'printers-empty'
          ? page.getByRole('heading', {
              name: 'Nenhuma atribuição nesta página.',
            })
          : page.getByText(longKey),
      )
      break
    case 'printers-no-farms':
      await wait(page.getByRole('heading', { name: 'Nenhuma farm disponível' }))
      break
    case 'printers-loading':
      await wait(page.getByText('Carregando as impressoras…'))
      break
    case 'printers-error':
      await wait(
        page.getByRole('heading', {
          name: 'Não foi possível carregar as impressoras',
        }),
      )
      break
    case 'wall-populated':
      await wait(page.getByRole('heading', { name: 'voron-24' }))
      break
    case 'wall-empty':
      await wait(
        page.getByRole('heading', {
          name: 'Nenhuma impressora com estado registrado',
        }),
      )
      break
    case 'wall-no-farm':
      await wait(page.getByRole('heading', { name: 'Nenhuma farm disponível' }))
      break
    case 'wall-loading':
      await wait(page.getByText('Carregando o painel. Aguardando dados…'))
      break
    case 'wall-error':
      await wait(page.getByRole('heading', { name: 'Painel indisponível' }))
      break
    case 'wall-session':
      await wait(
        page.getByText(
          'Sessão indisponível. Entre novamente em outro dispositivo.',
        ),
      )
      break
    case 'wall-stale':
      await wait(page.getByRole('heading', { name: 'voron-24' }))
      // The next poll (5 s) fails: the old states stay, flagged as stale.
      await page
        .getByText('Falha na atualização')
        .first()
        .waitFor({ timeout: 15_000 })
      break
    default:
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

/** Console errors the app itself raised; the mocked 404s are expected noise. */
function watchConsole(page: Page) {
  const errors: string[] = []
  page.on('console', (message) => {
    if (message.type() !== 'error') return
    const text = message.text()
    if (/Failed to load resource/.test(text)) return
    errors.push(text)
  })
  page.on('pageerror', (error) => errors.push(error.message))
  return errors
}

for (const { name } of scenarios) {
  for (const viewport of viewports) {
    for (const theme of themes) {
      test(`${name} is accessible, fits and is quiet at ${viewport.name} in the ${theme} theme`, async ({
        page,
      }) => {
        test.setTimeout(60_000)
        const errors = watchConsole(page)
        await open(page, name, viewport, theme)
        expect(await fits(page)).toBe(true)
        expect(await violations(page)).toEqual([])
        expect(errors).toEqual([])
      })
    }
  }
}

test('each page has one main, one h1 and headings in order', async ({
  page,
}) => {
  for (const name of [
    'home',
    'compat-catalog',
    'printers-populated',
    'wall-populated',
  ] as const) {
    await page.unrouteAll({ behavior: 'ignoreErrors' })
    await open(page, name, viewports[1], 'light')
    await expect(page.getByRole('main')).toHaveCount(1)
    await expect(page.getByRole('heading', { level: 1 })).toHaveCount(1)
    const levels = await page
      .locator('h1, h2, h3, h4, h5, h6')
      .evaluateAll((nodes) => nodes.map((node) => Number(node.tagName[1])))
    for (const [index, level] of levels.entries())
      if (index > 0)
        expect(
          level - levels[index - 1]!,
          `${name} heading order`,
        ).toBeLessThanOrEqual(1)
  }
})

test('home focuses the heading and lists every quick link in a named nav', async ({
  page,
}) => {
  await open(page, 'home', viewports[1], 'light')
  await expect(
    page.getByRole('heading', { level: 1, name: scenarios[0].heading }),
  ).toBeFocused()
  const nav = page.getByRole('navigation', { name: 'Acessos rápidos' })
  await expect(nav.getByRole('link')).toHaveText([
    'Minha farm',
    'Consultar Connectors',
    'Aprovar Connector',
    'Dispositivos do navegador',
    'Entrar',
    'Contas · Provedores de entrada',
    'Convidar pessoa',
    'Sair da conta',
  ])
  await expect(page.getByText('Recursos ainda indisponíveis')).toBeVisible()
  // The home page is static: no loading chrome and no request to /api.
  await expect(page.locator('.skeleton, [aria-busy="true"]')).toHaveCount(0)
})

test('keyboard reaches every home link with a visible focus ring', async ({
  page,
}) => {
  await open(page, 'home', viewports[1], 'dark')
  await page.getByRole('link', { name: 'Minha farm' }).first().focus()
  for (let step = 0; step < 4; step++) {
    const ring = await page.evaluate(() => {
      const style = getComputedStyle(document.activeElement as HTMLElement)
      return style.outlineStyle !== 'none' && style.outlineWidth !== '0px'
    })
    expect(ring, `step ${step} has no focus ring`).toBe(true)
    await page.keyboard.press('Tab')
  }
})

test('compatibility search is a named landmark, announces the count and clears', async ({
  page,
}) => {
  await open(page, 'compat-catalog', viewports[0], 'light')
  const search = page.getByRole('search', { name: 'Buscar no catálogo' })
  await expect(search).toBeVisible()
  const field = search.getByLabel('Buscar marca ou modelo')
  const total = await search.getByRole('status').innerText()
  expect(total).toMatch(/^[1-9]\d* resultado\(s\)$/)
  await field.fill('zzzz-sem-modelo')
  await expect(search.getByRole('status')).toHaveText('0 resultado(s)')
  await expect(
    page.getByRole('heading', { name: 'Nenhum modelo encontrado' }),
  ).toBeVisible()
  await page.getByRole('button', { name: 'Limpar busca' }).click()
  await expect(field).toHaveValue('')
  await expect(search.getByRole('status')).toHaveText(total)
  // The catalog is bundled: nothing was requested.
  expect(await fits(page)).toBe(true)
})

test('each compatibility entry labels its sources and limits', async ({
  page,
}) => {
  await open(page, 'compat-catalog', viewports[0], 'light')
  const first = page.locator('section[aria-labelledby]').first()
  for (const name of ['Áreas de controle', 'Limitações', 'Fontes'])
    await expect(first.getByRole('heading', { name })).toBeVisible()
  await expect(first.getByRole('link').first()).toHaveAttribute(
    'href',
    /^https?:/,
  )
})

test('printers: farm selector sits in a labelled region and the list shows exact keys', async ({
  page,
}) => {
  await open(page, 'printers-populated', viewports[0], 'light')
  const region = page.getByRole('region', { name: 'Escolher farm' })
  await expect(region.getByLabel('Farm')).toHaveValue(farm)
  await expect(
    page.getByRole('heading', { level: 1, name: 'Impressoras da farm' }),
  ).toBeVisible()
  await expect(page.getByText(longKey).first()).toBeVisible()
  await expect(
    page.getByRole('link', {
      name: 'Consultar compatibilidade de impressoras',
    }),
  ).toHaveAttribute('href', '/compatibilidade')
  // Managers see the add form; it is a region of its own.
  await expect(
    page.getByRole('region', { name: 'Adicionar impressora' }),
  ).toBeVisible()
})

test('printers without manage rights see no add form', async ({ page }) => {
  await open(page, 'printers-read-only', viewports[1], 'light')
  await expect(page.getByText(longKey).first()).toBeVisible()
  await expect(
    page.getByRole('region', { name: 'Adicionar impressora' }),
  ).toHaveCount(0)
})

test('printers loading is announced once with skeletons and no empty flash', async ({
  page,
}) => {
  await open(page, 'printers-loading', viewports[0], 'light')
  const busy = page.locator('[aria-busy="true"]', {
    hasText: 'Carregando as impressoras',
  })
  await expect(busy.getByRole('status')).toHaveText(
    'Carregando as impressoras…',
  )
  await expect(busy.locator('.skeleton')).toHaveCount(3)
  await expect(
    page.getByRole('heading', { name: 'Nenhuma farm disponível' }),
  ).toHaveCount(0)
})

test('printers empty states say why and offer a way out', async ({ page }) => {
  await open(page, 'printers-no-farms', viewports[0], 'light')
  await expect(
    page.getByText('Sua conta ainda não tem acesso a uma farm.'),
  ).toBeVisible()
  await expect(
    page.getByRole('link', { name: 'Aprovar Connector' }),
  ).toHaveAttribute('href', '/parear')
  await page.unrouteAll({ behavior: 'ignoreErrors' })
  await open(page, 'printers-empty', viewports[0], 'light')
  await expect(
    page.getByRole('link', { name: 'Ver Connectors' }),
  ).toHaveAttribute('href', '/connectors')
})

test('printers error moves focus to the alert and retry recovers', async ({
  page,
}) => {
  await open(page, 'printers-error', viewports[0], 'light')
  const alert = page.getByRole('alert')
  await expect(alert).toBeFocused()
  await expect(alert).toContainText('Não foi possível confirmar os dados')
  await expect(
    page.getByRole('link', { name: 'Entrar novamente' }),
  ).toHaveAttribute('href', '/entrar')
  await page.unrouteAll({ behavior: 'ignoreErrors' })
  await mockApi(page, 'printers-read-only')
  await page.getByRole('button', { name: 'Tentar novamente' }).click()
  await expect(page.locator('#printer-farm')).toBeEnabled()
  await expect(page.getByRole('alert')).toHaveCount(0)
})

test('wall renders no control, announces its states and flags stale data', async ({
  page,
}) => {
  await open(page, 'wall-populated', viewports[1], 'dark')
  await expect(page.locator('main a, main button')).toHaveCount(0)
  await expect(page.getByText('Dados atualizados há').first()).toBeVisible()
  await page.unrouteAll({ behavior: 'ignoreErrors' })
  await open(page, 'wall-error', viewports[0], 'light')
  await expect(
    page.getByText('Uma nova tentativa será feita automaticamente'),
  ).toBeVisible()
  await page.unrouteAll({ behavior: 'ignoreErrors' })
  await open(page, 'wall-stale', viewports[1], 'light')
  await expect(page.getByRole('heading', { name: 'voron-24' })).toBeVisible()
  await expect(page.locator('.kiosk__card--stale')).not.toHaveCount(0)
})

test('wall follows the saved theme, not a fixed dark palette', async ({
  page,
}) => {
  await open(page, 'wall-populated', viewports[1], 'light')
  const light = await page
    .locator('main')
    .evaluate((node) => getComputedStyle(node).backgroundColor)
  await page.unrouteAll({ behavior: 'ignoreErrors' })
  await open(page, 'wall-populated', viewports[1], 'dark')
  const dark = await page
    .locator('main')
    .evaluate((node) => getComputedStyle(node).backgroundColor)
  expect(light).not.toBe(dark)
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
  await open(page, 'printers-populated', viewports[1], 'dark')
  expect(external).toEqual([])
})

test('screenshots of real screen states', async ({ page }, testInfo) => {
  testInfo.setTimeout(600_000)
  const dir =
    process.env.POLISH_OVERVIEW_SHOTS_DIR ??
    (await mkdtemp(join(tmpdir(), 'openfarm-overview-shots-')))
  await mkdir(dir, { recursive: true })
  const written: string[] = []
  for (const { name } of scenarios)
    for (const viewport of viewports)
      for (const theme of themes) {
        await page.unrouteAll({ behavior: 'ignoreErrors' })
        await open(page, name, viewport, theme)
        const path = join(dir, `${name}-${viewport.name}-${theme}.png`)
        await page.screenshot({ path, fullPage: true })
        if ((await stat(path)).size <= 0) throw new Error(`Empty ${path}`)
        written.push(path)
      }
  expect(written).toHaveLength(
    scenarios.length * viewports.length * themes.length,
  )
  expect((await readdir(dir)).filter((name) => name.endsWith('.png'))).toEqual(
    expect.arrayContaining(written.map((path) => path.split('/').pop()!)),
  )
})
