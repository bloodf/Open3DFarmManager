import { mkdir, mkdtemp, readdir, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import AxeBuilder from '@axe-core/playwright'
import { expect, test, type Page, type Route } from '@playwright/test'
import { setPolishTheme } from '../helpers/polish-theme.ts'
import { mockShellApi } from '../helpers/shell-api.ts'

// Isolated UI checks of /integracoes, /bambu-cloud and /connectors on mocked
// /api routes. No real printer, database, auth service, Bambu Cloud or
// external network is involved: every request that is not served by the app
// itself is either fulfilled here or aborted.
//
// Evidence runs in Docker, offline, on Node 22:
//
//   node tests/e2e/run-polish-docker.mjs --screen integrations \
//     --spec tests/e2e/polish-integrations.spec.ts --baseline <sha>
//
// The last test always captures screenshots, to POLISH_INTEGRATIONS_SHOTS_DIR
// or a fresh temp folder, never into the repo. With POLISH_CAPTURE=1 (baseline
// capture) the states are reached with looser waits, because the assertions of
// the polished page do not hold on the old one.
const farm = '00000000-0000-4000-8000-0000000000f1'
const otherFarm = '00000000-0000-4000-8000-0000000000f2'
const appA = '00000000-0000-4000-8000-0000000000a1'
const appB = '00000000-0000-4000-8000-0000000000a2'
const assignA = '00000000-0000-4000-8000-0000000000b1'
const assignB = '00000000-0000-4000-8000-0000000000b2'
const agentA = '00000000-0000-4000-8000-0000000000c1'
const agentB = '00000000-0000-4000-8000-0000000000c2'
const agentC = '00000000-0000-4000-8000-0000000000c3'
const fingerprint = `SHA256:${'A'.repeat(43)}`
const longKey = `impressora-com-um-nome-muito-longo-${'x'.repeat(60)}`
const longApp = `Aplicativo de monitoramento da sala de impressão ${'longo '.repeat(12)}`
const secret = `ofs_${'s3gr3d0'.repeat(14)}`
const capturing = process.env.POLISH_CAPTURE === '1'

const viewports = [
  { name: '360', width: 360, height: 800 },
  { name: 'desktop', width: 1280, height: 900 },
] as const
const themes = ['light', 'dark'] as const

const screens = {
  integracoes: {
    path: '/integracoes',
    heading: 'Integrações',
    states: [
      'populated',
      'empty',
      'no-farms',
      'loading',
      'error',
      'forbidden',
      'secret',
    ],
  },
  'bambu-cloud': {
    path: '/bambu-cloud',
    heading: 'Conta Bambu Cloud',
    states: [
      'disconnected',
      'connected',
      'unavailable',
      'no-farms',
      'loading',
      'error',
      'tfa',
      'refused',
    ],
  },
  connectors: {
    path: '/connectors',
    heading: 'Connectors da farm',
    states: [
      'populated',
      'empty',
      'no-farms',
      'loading',
      'error',
      'sign-in',
      'recovery',
      'read-only',
    ],
  },
} as const

type Screen = keyof typeof screens
type Viewport = (typeof viewports)[number]
type Theme = (typeof themes)[number]
type State = string

const loopback = ['127.0.0.1', 'localhost']
const when = Date.UTC(2027, 2, 1, 12, 0, 0)

const apps = [
  {
    id: appA,
    name: 'Painel da oficina',
    sandbox: false,
    createdAt: 1000,
    revokedAt: null,
  },
  { id: appB, name: longApp, sandbox: false, createdAt: 2000, revokedAt: 3000 },
]
const printers = [
  { assignmentId: assignA, printerKey: longKey },
  { assignmentId: assignB, printerKey: 'impressora-2' },
]
const grants: Record<string, unknown[]> = {
  [appA]: [
    {
      id: 'g1',
      appId: appA,
      farmId: farm,
      printerAssignmentId: null,
      scopes: ['printers:read', 'jobs:read'],
      requiresApproval: false,
    },
    {
      id: 'g2',
      appId: appA,
      farmId: farm,
      printerAssignmentId: assignA,
      scopes: ['jobs:start', 'control:basic'],
      requiresApproval: true,
    },
  ],
  [appB]: [],
}
const connectors = [
  { agentId: agentA, fingerprint, status: 'pending' },
  {
    agentId: agentB,
    fingerprint: `SHA256:${'B'.repeat(43)}`,
    status: 'approved',
  },
  {
    agentId: agentC,
    fingerprint: `SHA256:${'C'.repeat(43)}`,
    status: 'revoked',
  },
]
const account = {
  connected: true,
  region: 'global',
  account: 'oficina@exemplo.com',
  expiresAt: new Date(when).toISOString(),
  expired: false,
  mqtt: null,
}

type Recorded = { method: string; url: string; body: unknown }
type Session = {
  errors: string[]
  requests: Recorded[]
  failing: string[]
}
const sessions = new WeakMap<Page, Session>()
const sessionOf = (page: Page) => sessions.get(page)!

async function mockApi(page: Page, screen: Screen, state: State) {
  const session: Session = { errors: [], requests: [], failing: [] }
  sessions.set(page, session)
  page.on('console', (message) => {
    if (message.type() !== 'error') return
    const failedResource =
      message.text().startsWith('Failed to load resource') &&
      session.failing.some((part) => message.location().url.includes(part))
    if (!failedResource) session.errors.push(message.text())
  })
  page.on('pageerror', (error) => session.errors.push(error.message))
  page.on('request', (request) => {
    if (request.url().includes('/api/'))
      session.requests.push({
        method: request.method(),
        url: request.url(),
        body: request.postData() ? JSON.parse(request.postData()!) : null,
      })
  })

  const hang = () => new Promise<void>(() => undefined)
  const reply = (route: Route, status: number, json: unknown = {}) =>
    route.fulfill({ status, json })
  const failure = async (pattern: string, status: number) => {
    session.failing.push(pattern)
    await page.route(`**${pattern}*`, (route) => reply(route, status))
  }

  // Anything not mocked below never leaves the test.
  await page.route(
    (url) => !loopback.includes(url.hostname),
    (route) => route.abort(),
  )
  await page.route('**/api/**', (route) => reply(route, 404))
  await mockShellApi(page, farm)
  await mockShellApi(page, otherFarm)
  await page.route('**/api/auth/me', (route) =>
    reply(route, 200, { accountId: 'conta-sintetica' }),
  )
  await page.route('**/api/browser-devices?*', (route) =>
    reply(route, 200, {
      currentAccountId: 'conta-sintetica',
      currentRole: 'owner',
      devices: [],
      nextAfter: null,
      limits: {
        pendingLifetimeMs: 86_400_000,
        proofLifetimeMs: 60_000,
        maxChallengesPerKey: 3,
      },
    }),
  )
  const farmList =
    state === 'no-farms'
      ? []
      : screen === 'bambu-cloud' && state === 'connected'
        ? [{ farmId: farm }, { farmId: otherFarm }]
        : [{ farmId: farm }]
  if (
    screen === 'connectors' &&
    (state === 'error' || state === 'sign-in' || state === 'loading')
  ) {
    if (state === 'loading')
      await page.route('**/api/farms?*', async (route) => {
        await hang()
        return route.abort()
      })
    else await failure('/api/farms', state === 'error' ? 500 : 401)
  } else if (screen === 'bambu-cloud' && state === 'error')
    await failure('/api/farms', 500)
  else
    await page.route('**/api/farms?*', (route) =>
      reply(route, 200, { farms: farmList, nextAfter: null }),
    )
  // The connector version feed reads these; none holds data in the fixtures.
  await page.route(`**/api/farms/${farm}/printers?*`, (route) =>
    reply(route, 200, { printers: [], nextAfter: null, canManage: true }),
  )
  await page.route(`**/api/farms/${farm}/status-summary*`, (route) =>
    reply(route, 200, {
      generatedAt: Date.now(),
      total: 0,
      counts: {},
      truncated: false,
      printers: [],
    }),
  )
  await page.route(`**/api/farms/${farm}/printer-states*`, (route) =>
    reply(route, 200, { states: [] }),
  )

  if (screen === 'integracoes')
    await mockIntegrations(page, state, failure, hang)
  if (screen === 'bambu-cloud') await mockBambu(page, state, hang)
  if (screen === 'connectors') await mockConnectors(page, state)
}

type Failure = (pattern: string, status: number) => Promise<void>
type Hang = () => Promise<void>

async function mockIntegrations(
  page: Page,
  state: State,
  failure: Failure,
  hang: Hang,
) {
  const base = `/api/farms/${farm}/integrations`
  const empty = state === 'empty'
  await page.route(`**${base}/apps/*/grants*`, (route) =>
    route.fulfill({
      json: {
        grants:
          grants[route.request().url().split('/apps/')[1]!.split('/')[0]!],
      },
    }),
  )
  await page.route(`**${base}/apps`, async (route) => {
    if (route.request().method() === 'POST')
      return route.fulfill({
        json: {
          app: apps[0],
          credential: { id: 'cred-1', clientId: 'client-painel-da-oficina' },
          secret,
        },
      })
    if (state === 'loading') {
      await hang()
      return route.abort()
    }
    return route.fulfill({
      json: empty ? { apps: [], printers: [] } : { apps, printers },
    })
  })
  if (state === 'error') await failure(`${base}/apps`, 500)
  if (state === 'forbidden') await failure(`${base}/apps`, 403)
  await page.route(`**${base}/grants/*`, (route) =>
    route.fulfill({ json: { ok: true } }),
  )
  await page.route(`**${base}/apps/*`, (route) =>
    route.request().method() === 'DELETE'
      ? route.fulfill({ json: { ok: true } })
      : route.fallback(),
  )
}

async function mockBambu(page: Page, state: State, hang: Hang) {
  const path = `/api/farms/${farm}/bambu-cloud`
  await page.route(`**${path}`, async (route) => {
    const method = route.request().method()
    if (method === 'POST') {
      const mode = (route.request().postDataJSON() as { mode?: string }).mode
      if (state === 'tfa' && mode !== 'tfa')
        return route.fulfill({ json: { tfaRequired: true, tfaKey: 'chave' } })
      if (state === 'refused') return route.fulfill({ status: 422, json: {} })
      return route.fulfill({ json: account })
    }
    if (method === 'DELETE')
      return route.fulfill({
        json: {
          connected: false,
          region: null,
          account: null,
          expiresAt: null,
          expired: false,
          mqtt: null,
        },
      })
    if (state === 'loading') {
      await hang()
      return route.abort()
    }
    if (state === 'unavailable') return route.fulfill({ status: 404, json: {} })
    return route.fulfill({
      json:
        state === 'connected'
          ? account
          : { ...account, connected: false, account: null, expiresAt: null },
    })
  })
  if (state === 'unavailable' || state === 'refused')
    sessionOf(page).failing.push(path)
}

async function mockConnectors(page: Page, state: State) {
  await page.route('**/api/connector-pairing/capability', (route) =>
    route.fulfill({ json: { enabled: state !== 'read-only' } }),
  )
  await page.route(`**/api/farms/${farm}/connectors?*`, (route) =>
    route.fulfill({
      json: {
        connectors: state === 'empty' ? [] : connectors,
        nextAfter: null,
      },
    }),
  )
  await page.route(`**/api/farms/${farm}/connectors/*/revoke`, (route) =>
    route.fulfill({ json: { ok: true } }),
  )
}

async function open(
  page: Page,
  screen: Screen,
  state: State,
  viewport: Viewport,
  theme: Theme,
) {
  await page.setViewportSize(viewport)
  page.setDefaultTimeout(capturing ? 3000 : 10_000)
  await setPolishTheme(page, theme)
  await mockApi(page, screen, state)
  await page.goto(screens[screen].path)
  await page
    .getByRole('heading', { level: 1, name: screens[screen].heading })
    .waitFor()
  await reach(page, screen, state)
}

/** Drives the page to the state; waits are on content, never fixed sleeps. */
async function reach(page: Page, screen: Screen, state: State) {
  if (capturing) {
    // The old pages do not all share the polished wording: only wait for the
    // network to go quiet before the screenshot is taken.
    await interact(page, screen, state).catch(() => undefined)
    if (state !== 'loading') await page.waitForLoadState('networkidle')
    return
  }
  await interact(page, screen, state)
}

async function interact(page: Page, screen: Screen, state: State) {
  if (screen === 'integracoes') {
    switch (state) {
      case 'populated':
        await page.getByRole('heading', { name: 'Painel da oficina' }).waitFor()
        break
      case 'empty':
        await page
          .getByRole('heading', { name: 'Nenhum aplicativo nesta farm' })
          .waitFor()
        break
      case 'no-farms':
        await page
          .getByRole('heading', { name: 'Nenhuma farm disponível' })
          .waitFor()
        break
      case 'loading':
        await page.getByText('Carregando integrações…').waitFor()
        break
      case 'error':
        await page
          .getByRole('heading', { name: 'Integrações indisponíveis' })
          .waitFor()
        break
      case 'forbidden':
        await page
          .getByText('Entre como proprietária da farm para gerenciar')
          .waitFor()
        break
      case 'secret':
        await page.getByRole('heading', { name: 'Painel da oficina' }).waitFor()
        await page.getByLabel('Nome do aplicativo').fill('Painel da oficina')
        await page.getByRole('button', { name: 'Cadastrar aplicativo' }).click()
        await page.getByLabel('Segredo do cliente').waitFor()
        break
    }
    return
  }
  if (screen === 'bambu-cloud') {
    switch (state) {
      case 'disconnected':
        await page.getByLabel('E-mail da conta Bambu').waitFor()
        break
      case 'connected':
        // This fixture has two farms, so the page requires an explicit choice.
        await page.getByLabel('Farm', { exact: true }).selectOption(farm)
        await page.getByRole('button', { name: 'Desconectar' }).waitFor()
        break
      case 'unavailable':
        await page
          .getByRole('heading', { name: 'Bambu Cloud indisponível' })
          .waitFor()
        break
      case 'no-farms':
        await page
          .getByRole('heading', { name: 'Nenhuma farm disponível' })
          .waitFor()
        break
      case 'loading':
        await page.getByText('Carregando a conta Bambu Cloud.').waitFor()
        break
      case 'error':
        await page.getByText('Não foi possível carregar as farms.').waitFor()
        break
      case 'tfa':
        await submitBambu(page)
        await page.getByLabel('Código de verificação').waitFor()
        break
      case 'refused':
        await submitBambu(page)
        await page
          .getByText('A nuvem recusou o código, a senha ou o token.')
          .waitFor()
        break
    }
    return
  }
  switch (state) {
    case 'populated':
    case 'read-only':
    case 'recovery':
      await page
        .getByLabel('Selecione uma farm', { exact: true })
        .selectOption(farm)
      await page.getByText(agentA, { exact: true }).waitFor()
      if (state === 'recovery')
        await page
          .getByRole('button', { name: 'Revogar este Connector' })
          .first()
          .click()
      break
    case 'empty':
      await page
        .getByLabel('Selecione uma farm', { exact: true })
        .selectOption(farm)
      await page
        .getByRole('heading', { name: 'Nenhum Connector registrado' })
        .waitFor()
      break
    case 'no-farms':
      await page
        .getByRole('heading', { name: 'Nenhuma farm disponível' })
        .waitFor()
      break
    case 'loading':
      await page.getByText('Carregando o inventário…').waitFor()
      break
    case 'error':
      await page
        .getByRole('heading', { name: 'Inventário indisponível' })
        .waitFor()
      break
    case 'sign-in':
      await page.getByText('Sua sessão não está disponível').waitFor()
      break
  }
}

async function submitBambu(page: Page) {
  await page.getByLabel('E-mail da conta Bambu').fill('oficina@exemplo.com')
  await page.getByLabel('Código recebido por e-mail').fill('123456')
  await page.getByRole('button', { name: 'Conectar', exact: true }).click()
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

const posts = (page: Page, part: string) =>
  sessionOf(page).requests.filter(
    (request) => request.method === 'POST' && request.url.includes(part),
  )
const deletes = (page: Page) =>
  sessionOf(page).requests.filter((request) => request.method === 'DELETE')

for (const screen of Object.keys(screens) as Screen[]) {
  for (const state of screens[screen].states) {
    for (const viewport of viewports) {
      for (const theme of themes) {
        test(`${screen}: ${state} state is accessible, error-free and fits at ${viewport.name} in the ${theme} theme`, async ({
          page,
        }) => {
          await open(page, screen, state, viewport, theme)
          expect(await fits(page)).toBe(true)
          expect(await violations(page)).toEqual([])
          expect(sessionOf(page).errors).toEqual([])
        })
      }
    }
  }
}

for (const screen of Object.keys(screens) as Screen[]) {
  test(`${screen}: one main, one h1 and headings in order`, async ({
    page,
  }) => {
    const state = screen === 'bambu-cloud' ? 'connected' : 'populated'
    await open(page, screen, state, viewports[1], 'light')
    await expect(page.locator('main')).toHaveCount(1)
    await expect(page.getByRole('heading', { level: 1 })).toHaveCount(1)
    const levels = await page
      .locator('main h1, main h2, main h3, main h4, main h5, main h6')
      .evaluateAll((nodes) => nodes.map((node) => Number(node.tagName[1])))
    expect(levels.length).toBeGreaterThan(1)
    for (const [index, level] of levels.entries())
      if (index > 0) expect(level - levels[index - 1]!).toBeLessThanOrEqual(1)
  })
}

test('integracoes: apps, grants and long values read clearly', async ({
  page,
}) => {
  await open(page, 'integracoes', 'populated', viewports[0], 'light')
  await expect(
    page.getByRole('heading', { name: longApp.trim() }),
  ).toBeVisible()
  await expect(page.getByText('Aplicativo revogado.')).toBeVisible()
  await expect(page.getByText('Ativo', { exact: true })).toBeVisible()
  await expect(
    page.getByText(
      'Todas as impressoras — Consultar impressoras, Consultar trabalhos',
    ),
  ).toBeVisible()
  await expect(page.getByText('requer aprovação')).toBeVisible()
  // A revoked application cannot be revoked again or receive new scopes.
  await expect(
    page.getByRole('button', { name: 'Revogar aplicativo' }).nth(1),
  ).toBeDisabled()
  await expect(
    page.getByRole('button', { name: 'Conceder escopos' }),
  ).toHaveCount(1)
  expect(await fits(page)).toBe(true)
})

test('integracoes: granting needs at least one scope and sends the same body', async ({
  page,
}) => {
  await open(page, 'integracoes', 'populated', viewports[1], 'light')
  const grant = page.getByRole('button', { name: 'Conceder escopos' })
  await expect(grant).toBeEnabled()
  await page.getByLabel('Consultar impressoras (printers:read)').uncheck()
  await expect(grant).toBeDisabled()
  await page.getByLabel('Iniciar trabalhos (jobs:start)').check()
  await page.getByLabel('Exigir aprovação do proprietário para ações').check()
  await page.getByLabel('Limitar à impressora (opcional)').selectOption(assignB)
  await grant.click()
  await expect(
    page.getByText('Acesso concedido ao aplicativo Painel da oficina.'),
  ).toBeVisible()
  expect(posts(page, `/apps/${appA}/grants`).at(-1)?.body).toEqual({
    scopes: ['jobs:start'],
    printerAssignmentId: assignB,
    requiresApproval: true,
  })
})

test('integracoes: revoking and removing ask first and send nothing when dismissed', async ({
  page,
}) => {
  await open(page, 'integracoes', 'populated', viewports[1], 'light')
  const asked: string[] = []
  page.on('dialog', async (dialog) => {
    asked.push(dialog.message())
    await dialog.dismiss()
  })
  await page.getByRole('button', { name: 'Revogar aplicativo' }).first().click()
  await page
    .getByRole('button', { name: 'Remover acesso de Painel da oficina' })
    .first()
    .click()
  expect(asked).toEqual([
    'Revogar o aplicativo Painel da oficina? Todos os acessos e webhooks serão interrompidos.',
    'Remover este acesso do aplicativo?',
  ])
  expect(deletes(page)).toEqual([])
  page.removeAllListeners('dialog')
  page.once('dialog', (dialog) => void dialog.accept())
  await page
    .getByRole('button', { name: 'Remover acesso de Painel da oficina' })
    .first()
    .click()
  await expect(page.getByText('Acesso removido.')).toBeVisible()
  expect(deletes(page).map((request) => request.url.split('/api')[1])).toEqual([
    `/farms/${farm}/integrations/grants/g1`,
  ])
})

test('integracoes: the one-time secret takes focus, can be hidden and is revoked after confirmation', async ({
  page,
}) => {
  await open(page, 'integracoes', 'secret', viewports[1], 'light')
  expect(posts(page, '/integrations/apps')[0]?.body).toEqual({
    name: 'Painel da oficina',
    sandbox: false,
  })
  const panel = page.getByRole('region', {
    name: 'Guarde o segredo do aplicativo',
  })
  await expect(panel).toBeFocused()
  await expect(panel.getByLabel('Segredo do cliente')).toHaveValue(secret)
  await expect(panel.getByLabel('Segredo do cliente')).toHaveJSProperty(
    'readOnly',
    true,
  )
  page.once('dialog', (dialog) => void dialog.dismiss())
  await panel.getByRole('button', { name: 'Revogar esta credencial' }).click()
  expect(deletes(page)).toEqual([])
  await panel.getByRole('button', { name: 'Fechar e ocultar segredo' }).click()
  await expect(panel).toHaveCount(0)
})

test('integracoes: states say why and offer a way out', async ({ page }) => {
  await open(page, 'integracoes', 'no-farms', viewports[0], 'light')
  await expect(
    page.getByRole('link', { name: 'Abrir a página da farm' }),
  ).toHaveAttribute('href', '/farm')
  await expect(
    page.getByRole('button', { name: 'Cadastrar aplicativo' }),
  ).toHaveCount(0)
  await open(page, 'integracoes', 'empty', viewports[0], 'light')
  await expect(page.getByLabel('Nome do aplicativo')).toBeVisible()
  await expect(
    page.getByRole('button', { name: 'Cadastrar aplicativo' }),
  ).toBeDisabled()
})

test('integracoes: loading is announced once, marks the page busy and shows skeletons', async ({
  page,
}) => {
  await open(page, 'integracoes', 'loading', viewports[0], 'light')
  await expect(page.locator('main')).toHaveAttribute('aria-busy', 'true')
  await expect(
    page.locator('div[aria-busy="true"]').getByRole('status'),
  ).toHaveText('Carregando integrações…')
  await expect(page.locator('.skeleton')).toHaveCount(3)
  await expect(
    page.getByRole('button', { name: 'Cadastrar aplicativo' }),
  ).toHaveCount(0)
})

test('integracoes: an error takes focus, keeps no stale apps and retry recovers', async ({
  page,
}) => {
  await open(page, 'integracoes', 'error', viewports[0], 'light')
  const alert = page.getByRole('alert')
  await expect(alert).toBeFocused()
  await expect(alert).toContainText(
    'Não foi possível carregar os aplicativos. Tente novamente.',
  )
  await expect(page.getByText('Painel da oficina')).toHaveCount(0)
  await page.route(`**/api/farms/${farm}/integrations/apps`, (route) =>
    route.fulfill({ json: { apps: [], printers: [] } }),
  )
  await alert.getByRole('button', { name: 'Tentar novamente' }).click()
  await expect(
    page.getByRole('heading', { name: 'Nenhum aplicativo nesta farm' }),
  ).toBeVisible()
  await expect(alert.getByRole('heading')).toHaveCount(0)
})

test('integracoes: keyboard reaches farm, name and register with a visible focus ring', async ({
  page,
}) => {
  await open(page, 'integracoes', 'empty', viewports[1], 'light')
  await page.locator('#integration-farm').focus()
  await page.getByLabel('Nome do aplicativo').fill('A')
  await page.locator('#integration-farm').focus()
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
  expect(seen).toEqual(['integration-farm', 'app-name', 'Cadastrar aplicativo'])
})

test('bambu-cloud: connected account is shown as facts, not as a sentence', async ({
  page,
}) => {
  await open(page, 'bambu-cloud', 'connected', viewports[0], 'light')
  const section = page.getByRole('region', { name: 'Conta conectada' })
  await expect(section.getByText('Conectada', { exact: true })).toBeVisible()
  await expect(section.getByText('oficina@exemplo.com')).toBeVisible()
  await expect(section.getByText('Global', { exact: true })).toBeVisible()
  await expect(section.getByText('Token válido até')).toBeVisible()
  await expect(page.getByLabel('Farm', { exact: true })).toBeVisible()
  await expect(
    page.getByRole('heading', { name: 'Trocar de conta' }),
  ).toBeVisible()
})

test('bambu-cloud: each mode shows its own fields and no secret value is kept after sending', async ({
  page,
}) => {
  await open(page, 'bambu-cloud', 'disconnected', viewports[1], 'light')
  await expect(page.getByLabel('Código recebido por e-mail')).toBeVisible()
  await page.getByLabel('Senha e verificação').check()
  await expect(page.getByLabel('Senha', { exact: true })).toHaveAttribute(
    'type',
    'password',
  )
  await page.getByLabel('Token colado').check()
  await expect(page.getByLabel('Token de acesso')).toHaveAttribute(
    'type',
    'password',
  )
  await expect(page.getByLabel('Validade do token')).toBeVisible()
  await page.getByLabel('Código por e-mail').check()
  await page.getByLabel('E-mail da conta Bambu').fill('oficina@exemplo.com')
  await page.getByLabel('Código recebido por e-mail').fill('123456')
  await page.getByRole('button', { name: 'Conectar', exact: true }).click()
  await expect(page.getByText('Conta Bambu Cloud conectada.')).toBeVisible()
  expect(posts(page, '/bambu-cloud')[0]?.body).toEqual({
    mode: 'email-code',
    account: 'oficina@exemplo.com',
    code: '123456',
    region: 'global',
  })
  await expect(page.getByLabel('Código recebido por e-mail')).toHaveValue('')
})

test('bambu-cloud: two-step verification locks the account fields and can be cancelled', async ({
  page,
}) => {
  await open(page, 'bambu-cloud', 'tfa', viewports[1], 'light')
  await expect(page.getByText('Informe o código de verificação.')).toBeVisible()
  await expect(page.getByLabel('E-mail da conta Bambu')).toBeDisabled()
  await expect(page.getByLabel('Região', { exact: true })).toBeDisabled()
  await expect(
    page.getByRole('group', { name: 'Modo de conexão' }),
  ).toHaveCount(0)
  await page.getByLabel('Código de verificação').fill('654321')
  await page.getByRole('button', { name: 'Confirmar código' }).click()
  await expect(page.getByText('Conta Bambu Cloud conectada.')).toBeVisible()
  expect(posts(page, '/bambu-cloud').at(-1)?.body).toEqual({
    mode: 'tfa',
    account: 'oficina@exemplo.com',
    tfaKey: 'chave',
    tfaCode: '654321',
    region: 'global',
  })
})

test('bambu-cloud: a refused code moves focus to the alert', async ({
  page,
}) => {
  await open(page, 'bambu-cloud', 'refused', viewports[0], 'light')
  const alert = page.getByRole('alert')
  await expect(alert).toBeFocused()
  await expect(alert).toContainText(
    'A nuvem recusou o código, a senha ou o token.',
  )
  await expect(page.getByLabel('Código recebido por e-mail')).toHaveValue('')
})

test('bambu-cloud: disconnecting sends DELETE and reports it', async ({
  page,
}) => {
  await open(page, 'bambu-cloud', 'connected', viewports[1], 'light')
  await page.getByRole('button', { name: 'Desconectar' }).click()
  await expect(page.getByText('Conta Bambu Cloud desconectada.')).toBeVisible()
  expect(deletes(page).map((request) => request.url.split('/api')[1])).toEqual([
    `/farms/${farm}/bambu-cloud`,
  ])
  await expect(
    page.getByRole('region', { name: 'Conta conectada' }),
  ).toHaveCount(0)
})

test('bambu-cloud: failing to list farms is visible and retry recovers', async ({
  page,
}) => {
  await open(page, 'bambu-cloud', 'error', viewports[0], 'light')
  const alert = page.getByRole('alert')
  await expect(alert).toBeFocused()
  await expect(alert).toContainText('Não foi possível carregar as farms.')
  await expect(
    page.getByRole('heading', { name: 'Farms indisponíveis' }),
  ).toBeVisible()
  await page.route('**/api/farms?*', (route) =>
    route.fulfill({ json: { farms: [{ farmId: farm }], nextAfter: null } }),
  )
  await page.getByRole('button', { name: 'Tentar novamente' }).click()
  await expect(page.getByLabel('E-mail da conta Bambu')).toBeVisible()
})

test('bambu-cloud: loading is announced and marks the page busy', async ({
  page,
}) => {
  await open(page, 'bambu-cloud', 'loading', viewports[0], 'light')
  await expect(page.locator('main')).toHaveAttribute('aria-busy', 'true')
  await expect(page.locator('.skeleton')).toHaveCount(3)
  await expect(page.getByLabel('E-mail da conta Bambu')).toHaveCount(0)
})

test('connectors: inventory shows status as text, wraps long ids and keeps the farm label', async ({
  page,
}) => {
  await open(page, 'connectors', 'populated', viewports[0], 'dark')
  for (const label of ['Pendente', 'Aprovado', 'Revogado'])
    await expect(page.getByText(label, { exact: true })).toBeVisible()
  await expect(page.getByText(fingerprint, { exact: true })).toBeVisible()
  await expect(
    page.getByText('Desconhecida', { exact: true }).first(),
  ).toBeVisible()
  // Revoking is offered for pending and approved registrations only.
  await expect(
    page.getByRole('button', { name: 'Revogar este Connector' }),
  ).toHaveCount(2)
  expect(await fits(page)).toBe(true)
})

test('connectors: the heading takes focus and keyboard order is heading, account links, farm', async ({
  page,
}) => {
  await open(page, 'connectors', 'populated', viewports[1], 'light')
  await page.reload()
  await expect(
    page.getByRole('heading', { name: 'Connectors da farm' }),
  ).toBeFocused()
  const farmSelect = page.getByLabel('Selecione uma farm', { exact: true })
  await expect(farmSelect).toBeVisible()
  await expect(farmSelect).toBeEnabled()
  const account = page.getByRole('navigation', { name: 'Conta' })
  for (const name of ['Início', 'Aprovar Connector', 'Sair da conta']) {
    await page.keyboard.press('Tab')
    await expect(account.getByRole('link', { name })).toBeFocused()
  }
  await page.keyboard.press('Tab')
  await expect(farmSelect).toBeFocused()
})

test('connectors: revocation needs the checkbox, sends the fingerprint and can be cancelled', async ({
  page,
}) => {
  await open(page, 'connectors', 'recovery', viewports[1], 'light')
  const recovery = page.getByRole('region', { name: 'Recuperação e revogação' })
  await expect(recovery).toContainText(farm)
  await expect(recovery).toContainText(agentA)
  await expect(recovery).toContainText(fingerprint)
  const confirm = recovery.getByRole('button', { name: 'Confirmar revogação' })
  await expect(confirm).toBeDisabled()
  await recovery
    .getByLabel('Conferi este Connector e quero revogar seu registro.')
    .check()
  await expect(confirm).toBeEnabled()
  await recovery.getByRole('button', { name: 'Cancelar revogação' }).click()
  await expect(confirm).toHaveCount(0)
  await page
    .getByRole('button', { name: 'Revogar este Connector' })
    .first()
    .click()
  await recovery
    .getByLabel('Conferi este Connector e quero revogar seu registro.')
    .check()
  await confirm.click()
  await expect(
    recovery.getByText('Registro revogado. Inicie um novo pareamento'),
  ).toBeVisible()
  expect(posts(page, `/connectors/${agentA}/revoke`)[0]?.body).toEqual({
    expected_fingerprint: fingerprint,
  })
})

test('connectors: without revocation rights the action is disabled and explained', async ({
  page,
}) => {
  await open(page, 'connectors', 'read-only', viewports[0], 'light')
  const revoke = page.getByRole('button', { name: 'Revogar Connector' })
  await expect(revoke).toBeDisabled()
  await expect(revoke).toHaveAccessibleDescription(
    'A revogação está indisponível nesta sessão.',
  )
  await expect(
    page.getByRole('button', { name: 'Revogar este Connector' }),
  ).toHaveCount(0)
})

test('connectors: loading, empty and error states say why and offer a way out', async ({
  page,
}) => {
  await open(page, 'connectors', 'loading', viewports[0], 'light')
  await expect(
    page.locator('div[aria-busy="true"]').getByRole('status'),
  ).toHaveText('Carregando o inventário…')
  await expect(page.locator('.skeleton')).toHaveCount(3)
  await open(page, 'connectors', 'no-farms', viewports[0], 'light')
  await expect(
    page.getByRole('button', { name: 'Consultar novamente' }),
  ).toBeVisible()
  await open(page, 'connectors', 'empty', viewports[0], 'light')
  await expect(
    page.getByRole('link', { name: 'Aprovar um novo Connector' }),
  ).toHaveAttribute('href', '/parear')
  await open(page, 'connectors', 'error', viewports[0], 'light')
  const alert = page.getByRole('alert')
  await expect(alert).toBeFocused()
  await expect(alert).toContainText('Não foi possível consultar o inventário.')
  await expect(
    page.getByLabel('Selecione uma farm', { exact: true }),
  ).toBeDisabled()
  await expect(
    page.getByRole('link', { name: 'Entrar na conta' }),
  ).toHaveAttribute('href', '/entrar')
})

test('connectors: an expired session says so', async ({ page }) => {
  await open(page, 'connectors', 'sign-in', viewports[0], 'light')
  await expect(page.getByRole('alert')).toContainText('Entre novamente')
})

test('makes no request outside the loopback host', async ({ page }) => {
  const external: string[] = []
  page.on('request', (request) => {
    const { hostname, protocol } = new URL(request.url())
    if (protocol.startsWith('http') && !loopback.includes(hostname))
      external.push(request.url())
  })
  await open(page, 'integracoes', 'populated', viewports[1], 'dark')
  await open(page, 'bambu-cloud', 'connected', viewports[1], 'dark')
  await open(page, 'connectors', 'populated', viewports[1], 'dark')
  expect(external).toEqual([])
})

test('screenshots of real screen states', async ({ page }, testInfo) => {
  testInfo.setTimeout(600_000)
  const dir =
    process.env.POLISH_INTEGRATIONS_SHOTS_DIR ??
    (await mkdtemp(join(tmpdir(), 'openfarm-integrations-shots-')))
  await mkdir(dir, { recursive: true })
  const written: string[] = []
  for (const screen of Object.keys(screens) as Screen[])
    for (const state of screens[screen].states)
      for (const viewport of viewports)
        for (const theme of themes) {
          await page.unrouteAll({ behavior: 'ignoreErrors' })
          page.removeAllListeners('console')
          page.removeAllListeners('pageerror')
          page.removeAllListeners('request')
          await open(page, screen, state, viewport, theme)
          const name = `${screen}-${state}-${viewport.name}-${theme}.png`
          const path = join(dir, name)
          await page.screenshot({ path, fullPage: true })
          if ((await stat(path)).size <= 0) throw new Error(`Empty ${path}`)
          written.push(name)
        }
  const expected = Object.values(screens).reduce(
    (sum, item) => sum + item.states.length * viewports.length * themes.length,
    0,
  )
  expect(written).toHaveLength(expected)
  expect((await readdir(dir)).filter((name) => name.endsWith('.png'))).toEqual(
    expect.arrayContaining(written),
  )
})
