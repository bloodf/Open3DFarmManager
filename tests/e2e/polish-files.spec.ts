import { mkdir, mkdtemp, readdir, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import AxeBuilder from '@axe-core/playwright'
import { expect, test, type Page } from '@playwright/test'
import { setPolishTheme } from '../helpers/polish-theme.ts'
import { mockShellApi } from '../helpers/shell-api.ts'

// Isolated UI checks for /arquivos and /biblioteca on mocked /api routes. No
// real printer, database, auth service or external network is involved: every
// request that is not served by the app itself is fulfilled below or aborted.
//
// Screenshots are always captured by the last test and saved outside the
// repository (POLISH_FILES_SHOTS_DIR or a temporary directory).
const farm = '00000000-0000-4000-8000-0000000000f1'
const otherFarm = '00000000-0000-4000-8000-0000000000f2'
const agent = '00000000-0000-4000-8000-0000000000a1'
const firstAssignment = '00000000-0000-4000-8000-0000000000b1'
const secondAssignment = '00000000-0000-4000-8000-0000000000b2'
const longKey = `impressora-com-um-nome-muito-longo-${'x'.repeat(70)}`
const longTitle = `Suporte-de-ferramentas-com-um-titulo-muito-longo-${'y'.repeat(60)}`
const sha = 'b'.repeat(64)
const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
)

const viewports = [
  { name: '360', width: 360, height: 800 },
  { name: 'desktop', width: 1280, height: 900 },
] as const
const themes = ['light', 'dark'] as const
type Viewport = (typeof viewports)[number]
type Theme = (typeof themes)[number]

type Scenario = {
  name: string
  path: '/arquivos' | '/biblioteca'
  heading: string
  /** The deliberately mocked failure status, which the browser logs. */
  failure?: number
  /** Waits for the state this scenario ends in; no fixed sleeps. */
  settle: (page: Page) => Promise<void>
}

const files: Scenario[] = [
  {
    name: 'arquivos-printers',
    path: '/arquivos',
    heading: 'Arquivos',
    settle: async (page) => {
      await expect(page.locator('#files-printer option')).toHaveCount(3)
    },
  },
  {
    name: 'arquivos-selected',
    path: '/arquivos',
    heading: 'Arquivos',
    settle: async (page) => {
      await page.locator('#files-printer').selectOption(firstAssignment)
      await page.locator('#files-unavailable').waitFor()
      await page.getByText(`Impressora selecionada: ${longKey}`).waitFor()
    },
  },
  {
    name: 'arquivos-no-printers',
    path: '/arquivos',
    heading: 'Arquivos',
    settle: async (page) => {
      await page
        .getByRole('heading', { name: 'Nenhuma impressora nesta página' })
        .waitFor()
    },
  },
  {
    name: 'arquivos-inventory-loading',
    path: '/arquivos',
    heading: 'Arquivos',
    settle: async (page) => {
      await page.getByText('Carregando impressoras…').waitFor()
    },
  },
  {
    name: 'arquivos-select-farm',
    path: '/arquivos',
    heading: 'Arquivos',
    settle: async (page) => {
      await page.locator('#files-farm').waitFor()
      await expect(page.locator('#files-farm option')).toHaveCount(3)
    },
  },
  {
    name: 'arquivos-no-farms',
    path: '/arquivos',
    heading: 'Arquivos',
    settle: async (page) => {
      await page
        .getByRole('heading', { name: 'Nenhuma farm nesta página' })
        .waitFor()
    },
  },
  {
    name: 'arquivos-loading',
    path: '/arquivos',
    heading: 'Arquivos',
    settle: async (page) => {
      await page.getByText('Carregando farms…').waitFor()
    },
  },
  {
    name: 'arquivos-sign-in',
    path: '/arquivos',
    heading: 'Arquivos',
    failure: 401,
    settle: async (page) => {
      await page.getByText('Sua sessão não está ativa.').waitFor()
    },
  },
  {
    name: 'arquivos-error',
    path: '/arquivos',
    heading: 'Arquivos',
    failure: 503,
    settle: async (page) => {
      await page
        .getByText('Não foi possível carregar suas farms. Tente novamente.')
        .waitFor()
    },
  },
]
const library: Scenario[] = [
  {
    name: 'biblioteca-populated',
    path: '/biblioteca',
    heading: 'Biblioteca',
    settle: async (page) => {
      await page.getByText('3 item(ns) na lista.').waitFor()
    },
  },
  {
    name: 'biblioteca-list',
    path: '/biblioteca',
    heading: 'Biblioteca',
    settle: async (page) => {
      await page.getByText('3 item(ns) na lista.').waitFor()
      await page.getByRole('button', { name: 'Lista' }).click()
      await expect(page.getByRole('button', { name: 'Lista' })).toHaveAttribute(
        'aria-pressed',
        'true',
      )
    },
  },
  {
    name: 'biblioteca-upload',
    path: '/biblioteca',
    heading: 'Biblioteca',
    settle: async (page) => {
      await page.getByText('3 item(ns) na lista.').waitFor()
      await page.getByRole('button', { name: 'Enviar arquivo' }).click()
      await page.locator('#library-upload').waitFor()
    },
  },
  {
    name: 'biblioteca-empty',
    path: '/biblioteca',
    heading: 'Biblioteca',
    settle: async (page) => {
      await page
        .getByRole('heading', { name: 'A biblioteca está vazia' })
        .waitFor()
    },
  },
  {
    name: 'biblioteca-filtered-empty',
    path: '/biblioteca',
    heading: 'Biblioteca',
    settle: async (page) => {
      await page.getByText('3 item(ns) na lista.').waitFor()
      await page.getByLabel('Título').fill('nada')
      await page.getByRole('button', { name: 'Buscar', exact: true }).click()
      await page
        .getByRole('heading', { name: 'Nenhum item encontrado' })
        .waitFor()
    },
  },
  {
    name: 'biblioteca-stale',
    path: '/biblioteca',
    heading: 'Biblioteca',
    failure: 500,
    settle: async (page) => {
      await page.getByText('3 item(ns) na lista.').waitFor()
      await page.getByLabel('Título').fill('falha')
      await page.getByRole('button', { name: 'Buscar', exact: true }).click()
      await page.getByText('Lista desatualizada').waitFor()
    },
  },
  {
    name: 'biblioteca-no-farms',
    path: '/biblioteca',
    heading: 'Biblioteca',
    settle: async (page) => {
      await page
        .getByRole('heading', { name: 'Nenhuma farm disponível' })
        .waitFor()
    },
  },
  {
    name: 'biblioteca-loading',
    path: '/biblioteca',
    heading: 'Biblioteca',
    settle: async (page) => {
      await page.getByText('Carregando a biblioteca…').waitFor()
    },
  },
  {
    name: 'biblioteca-error',
    path: '/biblioteca',
    heading: 'Biblioteca',
    failure: 500,
    settle: async (page) => {
      await page
        .getByRole('heading', { name: 'Biblioteca indisponível' })
        .waitFor()
    },
  },
]
const scenarios = [...files, ...library]
const byName = (name: string) => scenarios.find((item) => item.name === name)!

const printer = (assignmentId: string, printerKey: string) => ({
  assignmentId,
  agentId: agent,
  printerKey,
  status: 'active',
  connectorStatus: 'approved',
})
const version = (id: string, overrides = {}) => ({
  id,
  itemId: id,
  versionNumber: 1,
  sha256: sha,
  sizeBytes: 2_500_000,
  storageLocation: 'server',
  agentId: null,
  originalName: 'peca.gcode',
  kind: 'gcode',
  plateCount: 1,
  metadata: {
    slicer: 'OrcaSlicer',
    printerModel: 'Kobra X',
    estimatedTimeSeconds: 5400,
    tools: [
      {
        nozzleDiameter: 0.4,
        filamentType: 'PLA',
        filamentColour: '#ff0000',
        filamentGrams: 12.5,
      },
    ],
    layerHeight: 0.2,
    objectCount: 1,
    totalLayers: 120,
  },
  hasThumbnail: false,
  notes: '',
  createdAt: Date.UTC(2026, 10, 15),
  deletedAt: null,
  purgedAt: null,
  ...overrides,
})
const items = [
  {
    id: 'item-1',
    title: longTitle,
    tags: ['suporte', 'teste'],
    archived: false,
    createdAt: Date.UTC(2026, 10, 15),
    latest: version('ver-1', { hasThumbnail: true }),
  },
  {
    id: 'item-2',
    title: 'Cubo de calibração',
    tags: [],
    archived: false,
    createdAt: Date.UTC(2026, 10, 14),
    latest: version('ver-2', {
      metadata: { slicer: 'PrusaSlicer', estimatedTimeSeconds: 125 },
    }),
  },
  {
    id: 'item-3',
    title: 'Engrenagem',
    tags: ['mecânica'],
    archived: false,
    createdAt: Date.UTC(2026, 10, 13),
    latest: version('ver-3'),
  },
]

type Control = { failLibrary: boolean }

async function mockApi(page: Page, scenario: Scenario, control: Control) {
  const name = scenario.name
  const farmsFor = () =>
    name.endsWith('no-farms')
      ? []
      : name === 'arquivos-select-farm'
        ? [{ farmId: farm }, { farmId: otherFarm }]
        : [{ farmId: farm }]
  // Anything not mocked below never leaves the test.
  await page.route(
    (url) => !['127.0.0.1', 'localhost'].includes(url.hostname),
    (route) => route.abort(),
  )
  await page.route('**/api/**', async (route) => {
    const { pathname, searchParams } = new URL(route.request().url())
    const json = (body: unknown, status = 200) =>
      route.fulfill({ status, json: body })
    if (pathname === '/api/auth/me') {
      if (name === 'arquivos-loading') await new Promise(() => undefined)
      if (name === 'arquivos-sign-in') return json({}, 401)
      if (name === 'arquivos-error') return json({}, 503)
      return json({ accountId: 'conta-sintetica' })
    }
    if (pathname === '/api/farms')
      return json({ farms: farmsFor(), nextAfter: null })
    if (pathname === `/api/farms/${farm}/printers`) {
      if (name === 'arquivos-inventory-loading')
        await new Promise(() => undefined)
      return json({
        printers:
          name === 'arquivos-no-printers' || name.startsWith('biblioteca')
            ? []
            : [
                printer(firstAssignment, longKey),
                printer(secondAssignment, 'impressora-2'),
              ],
        nextAfter: null,
        canManage: true,
      })
    }
    if (pathname === '/api/browser-devices')
      return json({
        currentAccountId: 'conta-sintetica',
        currentRole: 'owner',
        devices: [],
        nextAfter: null,
        limits: {
          pendingLifetimeMs: 86_400_000,
          proofLifetimeMs: 60_000,
          maxChallengesPerKey: 3,
        },
      })
    if (pathname === '/api/signalling/pause-metadata')
      return json({ enabled: false })
    if (pathname === `/api/farms/${farm}/library`) {
      if (name === 'biblioteca-loading') await new Promise(() => undefined)
      if (name === 'biblioteca-error' || control.failLibrary)
        return json({}, 500)
      const title = searchParams.get('title')
      return json({
        items:
          name === 'biblioteca-empty' || title === 'nada'
            ? []
            : searchParams.has('cursor')
              ? [{ ...items[2]!, id: 'item-4', title: 'Última página' }]
              : items,
        nextCursor:
          name === 'biblioteca-populated' && !searchParams.has('cursor')
            ? 'cursor-2'
            : null,
      })
    }
    if (pathname === `/api/farms/${farm}/library/settings`)
      return json({
        settings: {
          storageMode: 'server',
          quotaBytes: 10 * 1024 ** 3,
          retentionDays: 30,
        },
        locations: [
          { location: 'server', agentId: null, files: 3, bytes: 7_500_000 },
        ],
        usage: { usedBytes: 7_500_000 },
        canManage: true,
      })
    if (pathname === `/api/farms/${farm}/connectors`)
      return json({ connectors: [{ agentId: agent, status: 'approved' }] })
    if (pathname === `/api/farms/${farm}/printer-profiles`)
      return json({ profiles: [] })
    if (pathname.endsWith('/thumbnail'))
      return route.fulfill({ status: 200, body: png, contentType: 'image/png' })
    return json({}, 404)
  })
  await mockShellApi(page, farm)
  await mockShellApi(page, otherFarm)
}

const consoleErrors = (page: Page, ignoredStatus?: number) => {
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))
  page.on('console', (message) => {
    if (message.type() !== 'error') return
    // A mocked failure is logged by the browser as a failed resource load.
    if (
      ignoredStatus !== undefined &&
      message.text().includes(`status of ${ignoredStatus}`)
    )
      return
    errors.push(message.text())
  })
  return errors
}

async function open(
  page: Page,
  scenario: Scenario,
  viewport: Viewport,
  theme: Theme,
  control: Control = { failLibrary: false },
) {
  // A state that never shows up fails fast instead of hanging the run.
  page.setDefaultTimeout(15_000)
  await page.setViewportSize(viewport)
  await setPolishTheme(page, theme)
  await mockApi(page, scenario, control)
  await page.goto(scenario.path)
  await page
    .getByRole('heading', { level: 1, name: scenario.heading, exact: true })
    .waitFor()
  // "Stale" fails only the refresh after the first successful load.
  if (scenario.name === 'biblioteca-stale') {
    await page.getByText('3 item(ns) na lista.').waitFor()
    control.failLibrary = true
  }
  await scenario.settle(page)
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
      test(`${scenario.name} is accessible, fits and logs no errors at ${viewport.name} in the ${theme} theme`, async ({
        page,
      }) => {
        const errors = consoleErrors(page, scenario.failure)
        await open(page, scenario, viewport, theme)
        expect(await fits(page)).toBe(true)
        expect(await violations(page)).toEqual([])
        expect(errors).toEqual([])
      })

for (const name of ['arquivos-printers', 'biblioteca-populated'])
  test(`${name} has one main, one h1 and headings in order`, async ({
    page,
  }) => {
    await open(page, byName(name), viewports[1], 'light')
    await expect(page.getByRole('main')).toHaveCount(1)
    await expect(page.getByRole('heading', { level: 1 })).toHaveCount(1)
    const levels = await page
      .locator('main h1, main h2, main h3, main h4')
      .evaluateAll((nodes) => nodes.map((node) => Number(node.tagName[1])))
    expect(levels.length).toBeGreaterThan(1)
    for (const [index, level] of levels.entries())
      if (index > 0) expect(level - levels[index - 1]!).toBeLessThanOrEqual(1)
  })

test('arquivos: controls are labelled and disabled with the reason while the direct connection is unavailable', async ({
  page,
}) => {
  await open(page, byName('arquivos-selected'), viewports[0], 'light')
  const main = page.getByRole('main')
  await expect(main.getByLabel('Farm')).toBeEnabled()
  await expect(main.getByLabel('Impressora', { exact: true })).toHaveValue(
    firstAssignment,
  )
  await expect(
    main.getByLabel('Arquivo .gcode ou .3mf (até 512 MiB)'),
  ).toBeDisabled()
  await expect(
    main.getByRole('button', { name: 'Enviar arquivo' }),
  ).toBeDisabled()
  await expect(
    main.getByRole('button', { name: 'Consultar arquivos' }),
  ).toBeDisabled()
  await expect(page.locator('#files-unavailable')).toContainText(
    'A impressora não anuncia suporte para iniciar impressão. O modo degradado permite somente leitura.',
  )
  await expect(
    main.getByRole('heading', { name: 'Nenhum arquivo listado' }),
  ).toBeVisible()
  await expect(
    main.getByRole('link', { name: 'Gerenciar dispositivos' }),
  ).toHaveAttribute('href', '/dispositivos')
  // Sections are named regions for screen-reader navigation.
  for (const name of ['Destino', 'Enviar arquivo', 'Arquivos da impressora'])
    await expect(main.getByRole('region', { name })).toBeVisible()
})

test('arquivos: keyboard reaches farm, printer and device link with a visible focus ring', async ({
  page,
}) => {
  await open(page, byName('arquivos-printers'), viewports[1], 'light')
  await page.locator('#files-farm').focus()
  const seen: string[] = []
  for (let step = 0; step < 3; step++) {
    const focus = await page.evaluate(() => {
      const element = document.activeElement as HTMLElement
      const style = getComputedStyle(element)
      return {
        label:
          element.id || element.textContent?.trim().slice(0, 40) || 'sem nome',
        outline: style.outlineStyle !== 'none' && style.outlineWidth !== '0px',
      }
    })
    expect(focus.outline, `${focus.label} has no focus ring`).toBe(true)
    seen.push(focus.label)
    await page.keyboard.press('Tab')
  }
  expect(seen).toEqual([
    'files-farm',
    'files-printer',
    'Gerenciar dispositivos',
  ])
})

test('arquivos: loading is announced once and marks the area busy', async ({
  page,
}) => {
  await open(page, byName('arquivos-loading'), viewports[0], 'light')
  const busy = page.locator('div[aria-busy="true"]')
  await expect(busy.getByRole('status')).toHaveText('Carregando farms…')
  await expect(page.locator('.skeleton')).toHaveCount(3)
})

test('arquivos: error moves focus to the alert and retry recovers', async ({
  page,
}) => {
  await open(page, byName('arquivos-error'), viewports[0], 'light')
  const alert = page.getByRole('alert')
  await expect(alert).toBeFocused()
  await expect(
    alert.getByRole('heading', { name: 'Arquivos indisponíveis' }),
  ).toBeVisible()
  await expect(alert.getByRole('link', { name: 'Entrar' })).toHaveAttribute(
    'href',
    '/entrar',
  )
  await page.route('**/api/auth/me', (route) =>
    route.fulfill({ json: { accountId: 'conta-sintetica' } }),
  )
  await alert.getByRole('button', { name: 'Tentar novamente' }).click()
  await expect(page.locator('#files-farm')).toBeVisible()
  await expect(page.getByRole('alert')).toHaveCount(0)
})

test('arquivos: an expired session says so and links to sign in', async ({
  page,
}) => {
  await open(page, byName('arquivos-sign-in'), viewports[0], 'light')
  await expect(page.getByRole('alert')).toBeFocused()
  await expect(page.getByRole('alert')).toContainText(
    'Sua sessão não está ativa. Entre novamente para ver suas farms.',
  )
  await expect(
    page.getByRole('alert').getByRole('link', { name: 'Entrar' }),
  ).toHaveAttribute('href', '/entrar')
})

test('arquivos: empty states say why and offer a way out', async ({ page }) => {
  await open(page, byName('arquivos-no-farms'), viewports[0], 'light')
  await expect(
    page.getByRole('link', { name: 'Ir para farms' }),
  ).toHaveAttribute('href', '/farm')
  await page.unrouteAll({ behavior: 'ignoreErrors' })
  await open(page, byName('arquivos-no-printers'), viewports[0], 'light')
  await expect(
    page.getByRole('link', { name: 'Ir para impressoras' }),
  ).toHaveAttribute('href', '/impressoras')
})

test('biblioteca: filters are a named search landmark and Enter applies them without a reload', async ({
  page,
}) => {
  await open(page, byName('biblioteca-populated'), viewports[1], 'light')
  const search = page.getByRole('search', { name: 'Filtros' })
  await expect(search).toBeVisible()
  await page.evaluate(() => {
    ;(window as unknown as { marker: string }).marker = 'kept'
  })
  const field = search.getByLabel('Título')
  await field.fill('cubo')
  const request = page.waitForRequest(
    (item) =>
      item.url().includes('/library?') &&
      new URL(item.url()).searchParams.get('title') === 'cubo',
  )
  await field.press('Enter')
  await request
  expect(
    await page.evaluate(() => (window as unknown as { marker: string }).marker),
  ).toBe('kept')
})

test('biblioteca: items are a named list with labelled actions and long titles wrap', async ({
  page,
}) => {
  await open(page, byName('biblioteca-populated'), viewports[0], 'light')
  const list = page.getByRole('list', { name: 'Itens da biblioteca' })
  await expect(list.getByRole('listitem')).toHaveCount(3)
  await expect(
    list.getByRole('button', { name: `Ver detalhes de ${longTitle}` }),
  ).toBeVisible()
  await expect(list.getByRole('heading', { name: longTitle })).toBeVisible()
  expect(await fits(page)).toBe(true)
})

test('biblioteca: view toggle and upload disclosure expose their state', async ({
  page,
}) => {
  await open(page, byName('biblioteca-populated'), viewports[1], 'light')
  const grid = page.getByRole('button', { name: 'Grade' })
  const listing = page.getByRole('button', { name: 'Lista' })
  await expect(grid).toHaveAttribute('aria-pressed', 'true')
  await listing.click()
  await expect(listing).toHaveAttribute('aria-pressed', 'true')
  await expect(grid).toHaveAttribute('aria-pressed', 'false')
  const toggle = page.getByRole('button', { name: 'Enviar arquivo' })
  await expect(toggle).toHaveAttribute('aria-expanded', 'false')
  await toggle.click()
  await expect(toggle).toHaveAttribute('aria-expanded', 'true')
  await expect(page.locator('#library-upload')).toBeVisible()
})

test('biblioteca: "Carregar mais" appends the next page and then disappears', async ({
  page,
}) => {
  await open(page, byName('biblioteca-populated'), viewports[1], 'light')
  const more = page.getByRole('button', { name: 'Carregar mais' })
  await expect(more).toBeVisible()
  await more.click()
  await expect(page.getByText('Última página')).toBeVisible()
  await expect(more).toHaveCount(0)
})

test('biblioteca: loading is announced and busy; empty states offer the way out', async ({
  page,
}) => {
  await open(page, byName('biblioteca-loading'), viewports[0], 'light')
  await expect(
    page.locator('div[aria-busy="true"]').getByRole('status'),
  ).toHaveText('Carregando a biblioteca…')
  await expect(page.locator('.skeleton')).toHaveCount(3)
  await page.unrouteAll({ behavior: 'ignoreErrors' })
  await open(page, byName('biblioteca-no-farms'), viewports[0], 'light')
  await expect(
    page.getByRole('link', { name: 'Ir para farms' }),
  ).toHaveAttribute('href', '/farm')
})

test('biblioteca: error moves focus to the alert and retry recovers', async ({
  page,
}) => {
  await open(page, byName('biblioteca-error'), viewports[0], 'light')
  const alert = page.getByRole('alert')
  await expect(alert).toBeFocused()
  await expect(
    alert.getByRole('heading', { name: 'Biblioteca indisponível' }),
  ).toBeVisible()
  await expect(alert).toContainText(
    'Não foi possível carregar a biblioteca. Tente novamente.',
  )
  await expect(
    page.getByRole('list', { name: 'Itens da biblioteca' }),
  ).toHaveCount(0)
  await expect(
    alert.getByRole('link', { name: 'Entrar na conta' }),
  ).toHaveAttribute('href', '/entrar')
  await page.route('**/api/farms/*/library?*', (route) =>
    route.fulfill({ json: { items: [], nextCursor: null } }),
  )
  await alert.getByRole('button', { name: 'Tentar novamente' }).click()
  await expect(
    page.getByRole('heading', { name: 'A biblioteca está vazia' }),
  ).toBeVisible()
})

test('biblioteca: a failed refresh keeps the last list and says it is outdated', async ({
  page,
}) => {
  await open(page, byName('biblioteca-stale'), viewports[0], 'light')
  const notice = page.getByRole('alert')
  await expect(notice).toContainText('Lista desatualizada')
  await expect(
    page
      .getByRole('list', { name: 'Itens da biblioteca' })
      .getByRole('listitem'),
  ).toHaveCount(3)
  await expect(
    notice.getByRole('button', { name: 'Tentar novamente' }),
  ).toBeVisible()
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
  await open(page, byName('arquivos-printers'), viewports[1], 'dark')
  await page.unrouteAll({ behavior: 'ignoreErrors' })
  await open(page, byName('biblioteca-populated'), viewports[1], 'dark')
  expect(external).toEqual([])
})

test('screenshots of real screen states', async ({ page }, testInfo) => {
  testInfo.setTimeout(600_000)
  const dir =
    process.env.POLISH_FILES_SHOTS_DIR ??
    (await mkdtemp(join(tmpdir(), 'openfarm-files-shots-')))
  await mkdir(dir, { recursive: true })
  const written: string[] = []
  for (const scenario of scenarios)
    for (const viewport of viewports)
      for (const theme of themes) {
        await page.unrouteAll({ behavior: 'ignoreErrors' })
        await open(page, scenario, viewport, theme)
        const path = join(dir, `${scenario.name}-${viewport.name}-${theme}.png`)
        await page.screenshot({ path, fullPage: true })
        expect((await stat(path)).size).toBeGreaterThan(0)
        written.push(path)
      }
  expect(written).toHaveLength(
    scenarios.length * viewports.length * themes.length,
  )
  expect((await readdir(dir)).filter((name) => name.endsWith('.png'))).toEqual(
    expect.arrayContaining(written.map((path) => path.split('/').pop()!)),
  )
})
