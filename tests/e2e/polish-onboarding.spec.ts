import { mkdir, mkdtemp, readdir, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import AxeBuilder from '@axe-core/playwright'
import { expect, test, type Page } from '@playwright/test'

// Isolated UI checks for the onboarding screens: /primeiro-acesso, /criar-conta,
// /parear and /dispositivos. Every /api call is answered by page.route; nothing
// reaches a printer, a database, an auth service or an external network.
//
// Screenshots are always captured by the last test and saved outside the
// repository (POLISH_ONBOARDING_SHOTS_DIR or a temporary directory).
const farm = '00000000-0000-4000-8000-0000000000f1'
const otherFarm = '00000000-0000-4000-8000-0000000000f2'
const cursor = '00000000-0000-4000-8000-0000000000c1'
const account = 'conta-sintetica'
const longAccount = `conta-titular-com-um-nome-muito-longo-${'x'.repeat(80)}`
const thumbprint = `${'A'.repeat(42)}A`
const approvedPrint = `${'B'.repeat(42)}A`
const revokedPrint = `${'C'.repeat(42)}A`
const fingerprint = `SHA256:${'A'.repeat(43)}`
const inviteCode = 'I'.repeat(43)
const password = 'senha-sintetica-longa'
const loopback = ['127.0.0.1', 'localhost']

const viewports = [
  { name: '360', width: 360, height: 800 },
  { name: 'desktop', width: 1280, height: 900 },
] as const
const themes = ['light', 'dark'] as const
type Viewport = (typeof viewports)[number]
type Theme = (typeof themes)[number]

type Options = {
  me?: 'ok' | 'fail' | 'hang'
  farms?: 'one' | 'none' | 'two' | 'paged' | 'fail'
  capability?: 'ok' | 'fail' | 'hang'
  approve?: number
  account?: number
  devices?: 'none' | 'rows'
  challenge?: number
  longValues?: boolean
}
type Device = {
  keyId: string
  accountId: string
  thumbprint: string
  status: 'pending' | 'approved' | 'revoked'
  proofAt: number | null
  createdAt: number
  pendingExpiresAt: number | null
}
type Mock = {
  errors: string[]
  posts: { path: string; headers: Record<string, string>; body: unknown }[]
  gets: string[]
  devices: Device[]
  role: 'owner' | 'admin' | 'operator'
  options: Options
}

const rows = (long: boolean): Device[] => [
  {
    keyId: '00000000-0000-4000-8000-0000000000d1',
    accountId: long ? longAccount : 'outra-conta',
    thumbprint,
    status: 'pending',
    proofAt: 1_800_000_000_000,
    createdAt: Date.UTC(2026, 10, 15, 12, 0, 0),
    pendingExpiresAt: Date.UTC(2026, 10, 16, 12, 0, 0),
  },
  {
    keyId: '00000000-0000-4000-8000-0000000000d2',
    accountId: account,
    thumbprint: approvedPrint,
    status: 'approved',
    proofAt: 1_800_000_000_000,
    createdAt: Date.UTC(2026, 10, 14, 12, 0, 0),
    pendingExpiresAt: null,
  },
  {
    keyId: '00000000-0000-4000-8000-0000000000d3',
    accountId: 'conta-antiga',
    thumbprint: revokedPrint,
    status: 'revoked',
    proofAt: null,
    createdAt: Date.UTC(2026, 10, 13, 12, 0, 0),
    pendingExpiresAt: null,
  },
]

async function mockApi(
  page: Page,
  options: Options = {},
  role: Mock['role'] = 'owner',
): Promise<Mock> {
  const mock: Mock = {
    errors: [],
    posts: [],
    gets: [],
    devices: options.devices === 'rows' ? rows(!!options.longValues) : [],
    role,
    options,
  }
  // Failed responses are part of the states, so the browser's own "Failed to
  // load resource" line is expected. Anything else logged is a real problem.
  page.on('console', (message) => {
    if (
      message.type() === 'error' &&
      !message.text().startsWith('Failed to load resource')
    )
      mock.errors.push(message.text())
  })
  page.on('pageerror', (error) => mock.errors.push(error.message))
  // Anything outside the app never leaves the test.
  await page.route(
    (url) => !loopback.includes(url.hostname),
    (route) => route.abort(),
  )
  await page.route('**/api/**', async (route) => {
    const request = route.request()
    const { pathname, searchParams } = new URL(request.url())
    const key = `${request.method()} ${pathname}`
    const json = (body: unknown, status = 200) =>
      route.fulfill({ status, json: body })
    if (request.method() === 'POST')
      mock.posts.push({
        path: pathname,
        headers: request.headers(),
        body: request.postDataJSON(),
      })
    else mock.gets.push(`${pathname}?${searchParams}`)
    switch (key) {
      case 'GET /api/auth/me':
        if (options.me === 'hang') return new Promise(() => undefined)
        return options.me === 'fail'
          ? json({}, 500)
          : json({ accountId: account })
      case 'GET /api/farms': {
        const mode = options.farms ?? 'one'
        if (mode === 'fail') return json({}, 500)
        if (mode === 'none') return json({ farms: [], nextAfter: null })
        if (mode === 'two')
          return json({
            farms: [{ farmId: farm }, { farmId: otherFarm }],
            nextAfter: null,
          })
        if (mode === 'paged')
          return searchParams.has('after')
            ? json({ farms: [{ farmId: otherFarm }], nextAfter: null })
            : json({ farms: [{ farmId: farm }], nextAfter: cursor })
        return json({ farms: [{ farmId: farm }], nextAfter: null })
      }
      case 'GET /api/connector-pairing/capability':
        if (options.capability === 'hang') return new Promise(() => undefined)
        return options.capability === 'fail'
          ? json({}, 500)
          : json({ enabled: true })
      case 'POST /api/connector-pairing/approve':
        return json({}, options.approve ?? 200)
      case 'POST /api/auth/register':
      case 'POST /api/auth/bootstrap':
        return json({ accountId: account }, options.account ?? 200)
      case 'GET /api/browser-devices':
        return json({
          currentAccountId: account,
          currentRole: mock.role,
          devices: mock.devices,
          nextAfter: options.devices === 'rows' ? cursor : null,
          limits: {
            pendingLifetimeMs: 86_400_000,
            proofLifetimeMs: 60_000,
            maxChallengesPerKey: 3,
          },
        })
      case 'POST /api/browser-devices/challenges':
      case 'POST /api/browser-devices/recovery-challenges':
        return json({}, options.challenge ?? 500)
      default:
        return json({}, 404)
    }
  })
  return mock
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

async function fillAccount(page: Page, submit: string, token: string) {
  await page.getByLabel(token, { exact: true }).fill(inviteCode)
  await page.getByLabel('Usuário', { exact: true }).fill('nova_pessoa')
  await page.getByLabel('Senha', { exact: true }).fill(password)
  await page.getByRole('button', { name: submit, exact: true }).click()
}

type Scenario = {
  id: string
  path: string
  h1: string
  options?: Options
  role?: Mock['role']
  /** Brings the page to the state; runs after the heading is visible. */
  settle: (page: Page) => Promise<void>
}

const farmOption = (page: Page, select: string) =>
  page
    .locator(`${select} option`, { hasText: farm })
    .first()
    .waitFor({ state: 'attached' })

const keysShown = async (page: Page) => {
  await farmOption(page, '#device-farm')
  await page.locator('#device-farm').selectOption(farm)
  await page
    .getByRole('heading', { name: 'Sem chaves neste navegador' })
    .waitFor()
  // The challenge fails on purpose: the key is created in this browser and
  // stays there ("a chave permanece neste navegador"), so it is listed next.
  await page
    .getByRole('button', { name: 'Criar chave e solicitar cadastro' })
    .click()
  await page.getByRole('heading', { name: 'Operação não confirmada' }).waitFor()
  await page.getByRole('button', { name: 'Tentar novamente' }).click()
  await farmOption(page, '#device-farm')
  await page.locator('#device-farm').selectOption(farm)
  await page.getByText('Impressão digital:').first().waitFor()
}

const pairingFilled = async (page: Page, check = true) => {
  await farmOption(page, '#pairing-farm')
  await page.locator('#pairing-farm').selectOption(farm)
  await page.getByLabel('Código exibido no Connector').fill('BCDF-2345')
  await page
    .getByLabel('Impressão digital exibida no Connector')
    .fill(fingerprint)
  if (check)
    await page
      .getByLabel('Conferi a impressão digital completa e a farm de destino.')
      .check()
}

const scenarios: Scenario[] = [
  {
    id: 'criar-conta-form',
    path: '/criar-conta',
    h1: 'Criar conta',
    settle: async (page) => {
      await expect(
        page.getByRole('button', { name: 'Criar conta', exact: true }),
      ).toBeEnabled()
    },
  },
  {
    id: 'criar-conta-error',
    path: '/criar-conta',
    h1: 'Criar conta',
    options: { account: 400 },
    settle: async (page) => {
      await expect(
        page.getByRole('button', { name: 'Criar conta', exact: true }),
      ).toBeEnabled()
      await fillAccount(page, 'Criar conta', 'Código do convite')
      await expect(page.getByRole('alert')).toContainText(
        'Não foi possível criar a conta. Confira o código',
      )
    },
  },
  {
    id: 'primeiro-acesso-form',
    path: '/primeiro-acesso',
    h1: 'Primeiro acesso',
    settle: async (page) => {
      await expect(
        page.getByRole('button', { name: 'Criar conta de proprietário' }),
      ).toBeEnabled()
    },
  },
  {
    id: 'primeiro-acesso-error',
    path: '/primeiro-acesso',
    h1: 'Primeiro acesso',
    options: { account: 429 },
    settle: async (page) => {
      await expect(
        page.getByRole('button', { name: 'Criar conta de proprietário' }),
      ).toBeEnabled()
      await fillAccount(
        page,
        'Criar conta de proprietário',
        'Código de configuração',
      )
      await expect(page.getByRole('alert')).toContainText('Muitas tentativas')
    },
  },
  {
    id: 'parear-loading',
    path: '/parear',
    h1: 'Aprovar Connector',
    options: { capability: 'hang' },
    settle: async (page) => {
      await page.getByText('Carregando suas farms…').waitFor()
    },
  },
  {
    id: 'parear-no-farms',
    path: '/parear',
    h1: 'Aprovar Connector',
    options: { farms: 'none' },
    settle: async (page) => {
      await page
        .getByRole('heading', { name: 'Nenhuma farm disponível' })
        .waitFor()
    },
  },
  {
    id: 'parear-error',
    path: '/parear',
    h1: 'Aprovar Connector',
    options: { capability: 'fail' },
    settle: async (page) => {
      await page
        .getByRole('heading', { name: 'Pareamento não concluído' })
        .waitFor()
    },
  },
  {
    id: 'parear-form',
    path: '/parear',
    h1: 'Aprovar Connector',
    options: { farms: 'paged' },
    settle: async (page) => {
      await farmOption(page, '#pairing-farm')
    },
  },
  {
    id: 'parear-confirmed',
    path: '/parear',
    h1: 'Aprovar Connector',
    settle: async (page) => {
      await pairingFilled(page)
      await expect(
        page.getByRole('button', { name: 'Aprovar Connector', exact: true }),
      ).toBeEnabled()
    },
  },
  {
    id: 'parear-invalid',
    path: '/parear',
    h1: 'Aprovar Connector',
    settle: async (page) => {
      await pairingFilled(page)
      await page.getByLabel('Código exibido no Connector').fill('inválido')
      await page
        .getByLabel('Conferi a impressão digital completa e a farm de destino.')
        .check()
      await page
        .getByRole('button', { name: 'Aprovar Connector', exact: true })
        .click()
      await page
        .getByText('Confira a farm, o código e a impressão digital')
        .waitFor()
    },
  },
  {
    id: 'parear-approved',
    path: '/parear',
    h1: 'Aprovar Connector',
    settle: async (page) => {
      await pairingFilled(page)
      await page
        .getByRole('button', { name: 'Aprovar Connector', exact: true })
        .click()
      await page.getByText('Connector aprovado.').waitFor()
    },
  },
  {
    id: 'parear-approve-error',
    path: '/parear',
    h1: 'Aprovar Connector',
    options: { approve: 500 },
    settle: async (page) => {
      await pairingFilled(page)
      await page
        .getByRole('button', { name: 'Aprovar Connector', exact: true })
        .click()
      await page
        .getByText('Não foi possível confirmar a aprovação.')
        .waitFor()
    },
  },
  {
    id: 'dispositivos-loading',
    path: '/dispositivos',
    h1: 'Dispositivos do navegador',
    options: { me: 'hang' },
    settle: async (page) => {
      await page.getByText('Carregando farms e dispositivos…').waitFor()
    },
  },
  {
    id: 'dispositivos-no-farms',
    path: '/dispositivos',
    h1: 'Dispositivos do navegador',
    options: { farms: 'none' },
    settle: async (page) => {
      await page
        .getByRole('heading', { name: 'Nenhuma farm disponível' })
        .waitFor()
    },
  },
  {
    id: 'dispositivos-select-farm',
    path: '/dispositivos',
    h1: 'Dispositivos do navegador',
    options: { farms: 'two' },
    settle: async (page) => {
      await farmOption(page, '#device-farm')
    },
  },
  {
    id: 'dispositivos-error',
    path: '/dispositivos',
    h1: 'Dispositivos do navegador',
    options: { me: 'fail' },
    settle: async (page) => {
      await page
        .getByRole('heading', { name: 'Operação não confirmada' })
        .waitFor()
    },
  },
  {
    id: 'dispositivos-empty',
    path: '/dispositivos',
    h1: 'Dispositivos do navegador',
    settle: async (page) => {
      await farmOption(page, '#device-farm')
      await page.locator('#device-farm').selectOption(farm)
      await page
        .getByRole('heading', { name: 'Nenhum dispositivo nesta página' })
        .waitFor()
    },
  },
  {
    id: 'dispositivos-populated',
    path: '/dispositivos',
    h1: 'Dispositivos do navegador',
    options: { devices: 'rows', longValues: true },
    settle: async (page) => {
      await farmOption(page, '#device-farm')
      await page.locator('#device-farm').selectOption(farm)
      await page.getByText(approvedPrint).waitFor()
    },
  },
  {
    id: 'dispositivos-member',
    path: '/dispositivos',
    h1: 'Dispositivos do navegador',
    options: { devices: 'rows' },
    role: 'operator',
    settle: async (page) => {
      await farmOption(page, '#device-farm')
      await page.locator('#device-farm').selectOption(farm)
      await page.getByText(approvedPrint).waitFor()
    },
  },
  {
    id: 'dispositivos-keys',
    path: '/dispositivos',
    h1: 'Dispositivos do navegador',
    settle: keysShown,
  },
]

async function open(
  page: Page,
  scenario: Scenario,
  viewport: Viewport,
  theme: Theme,
) {
  await page.setViewportSize(viewport)
  await page.emulateMedia({ colorScheme: theme, reducedMotion: 'reduce' })
  const mock = await mockApi(page, scenario.options, scenario.role)
  await page.goto(scenario.path)
  await page
    .getByRole('heading', { level: 1, name: scenario.h1, exact: true })
    .waitFor()
  await scenario.settle(page)
  return mock
}

const byId = (id: string) => scenarios.find((item) => item.id === id)!

for (const scenario of scenarios)
  for (const viewport of viewports)
    for (const theme of themes) {
      test(`${scenario.id} is accessible, fits and logs no error at ${viewport.name} in the ${theme} theme`, async ({
        page,
      }) => {
        const mock = await open(page, scenario, viewport, theme)
        expect(await fits(page)).toBe(true)
        expect(await violations(page)).toEqual([])
        expect(mock.errors).toEqual([])
      })
    }

test('every screen has one main, one h1 and headings in order', async ({
  page,
}) => {
  for (const id of [
    'criar-conta-form',
    'primeiro-acesso-form',
    'parear-form',
    'dispositivos-populated',
  ]) {
    await open(page, byId(id), viewports[1], 'light')
    await expect(page.getByRole('main')).toHaveCount(1)
    await expect(page.getByRole('heading', { level: 1 })).toHaveCount(1)
    const levels = await page
      .locator('h1, h2, h3, h4, h5, h6')
      .evaluateAll((nodes) => nodes.map((node) => Number(node.tagName[1])))
    for (const [index, level] of levels.entries())
      if (index > 0)
        expect(level - levels[index - 1]!, `${id} heading jump`).toBeLessThanOrEqual(
          1,
        )
    await page.unrouteAll({ behavior: 'ignoreErrors' })
  }
})

test('account forms: labelled fields with help text, keyboard order and a visible focus ring', async ({
  page,
}) => {
  await open(page, byId('criar-conta-form'), viewports[0], 'light')
  const code = page.getByLabel('Código do convite')
  await expect(code).toHaveAccessibleDescription(
    'Cole o código recebido, ou abra o link completo do convite.',
  )
  await expect(page.getByLabel('Usuário', { exact: true })).toHaveAccessibleDescription(
    'Use letras minúsculas, números, hífen ou sublinhado.',
  )
  await expect(page.getByLabel('Senha', { exact: true })).toHaveAccessibleDescription(
    'Use 12 caracteres ou mais.',
  )
  await code.focus()
  const seen: string[] = []
  for (let step = 0; step < 4; step++) {
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
    'account-token',
    'account-username',
    'account-password',
    'Criar conta',
  ])
})

test('first access sends the setup code header, keeps the code, clears the password and focuses the alert', async ({
  page,
}) => {
  const mock = await open(page, byId('primeiro-acesso-error'), viewports[0], 'light')
  const alert = page.getByRole('alert')
  await expect(alert).toBeFocused()
  expect(mock.posts).toHaveLength(1)
  expect(mock.posts[0]!.path).toBe('/api/auth/bootstrap')
  expect(mock.posts[0]!.headers['x-bootstrap-token']).toBe(inviteCode)
  expect(mock.posts[0]!.body).toEqual({
    username: 'nova_pessoa',
    password,
  })
  await expect(page.getByLabel('Senha', { exact: true })).toHaveValue('')
  await expect(page.getByLabel('Código de configuração')).toHaveValue(inviteCode)
  await expect(page.getByLabel('Código de configuração')).toHaveAttribute(
    'type',
    'password',
  )
  await expect(page.getByRole('link', { name: 'Já tenho conta' })).toHaveAttribute(
    'href',
    '/entrar',
  )
})

test('the invite code in the link fragment fills the field and leaves the URL', async ({
  page,
}) => {
  await mockApi(page)
  await page.goto(`/criar-conta#codigo=${inviteCode}`)
  await expect(page.getByLabel('Código do convite')).toHaveValue(inviteCode)
  await expect(page).toHaveURL(/\/criar-conta$/)
})

test('pairing: a bad code is reported in the live region and moves focus there', async ({
  page,
}) => {
  const mock = await open(page, byId('parear-invalid'), viewports[0], 'light')
  const summary = page.getByRole('status').filter({
    hasText: 'Confira a farm, o código e a impressão digital',
  })
  await expect(summary).toBeFocused()
  expect(mock.posts).toEqual([])
})

test('pairing: approval stays locked until the fingerprint is confirmed and sends the same request', async ({
  page,
}) => {
  const mock = await open(page, byId('parear-form'), viewports[1], 'light')
  const approve = page.getByRole('button', {
    name: 'Aprovar Connector',
    exact: true,
  })
  await expect(approve).toBeDisabled()
  await page.locator('#pairing-farm').selectOption(farm)
  await page.getByLabel('Código exibido no Connector').fill('bcdf-2345')
  await page
    .getByLabel('Impressão digital exibida no Connector')
    .fill(fingerprint)
  await expect(approve).toBeDisabled()
  await page
    .getByLabel('Conferi a impressão digital completa e a farm de destino.')
    .check()
  await expect(approve).toBeEnabled()
  // Editing anything withdraws the confirmation again.
  await page.getByLabel('Código exibido no Connector').fill('bcdf-2346')
  await expect(approve).toBeDisabled()
  await page.getByLabel('Código exibido no Connector').fill('bcdf-2345')
  await page
    .getByLabel('Conferi a impressão digital completa e a farm de destino.')
    .check()
  await approve.click()
  await expect(page.getByText('Connector aprovado.')).toBeVisible()
  expect(
    mock.posts.filter((post) => post.path === '/api/connector-pairing/approve'),
  ).toEqual([
    {
      path: '/api/connector-pairing/approve',
      headers: expect.anything(),
      body: {
        user_code: 'BCDF2345',
        farm_id: farm,
        expected_fingerprint: fingerprint,
      },
    },
  ])
  // The form is gone after approval, with no stale values left in the page.
  await expect(page.getByLabel('Código exibido no Connector')).toHaveValue('')
})

test('pairing: the farm field is described and "Próxima página de farms" loads the next page', async ({
  page,
}) => {
  await open(page, byId('parear-form'), viewports[1], 'light')
  await expect(page.locator('#pairing-farm')).toHaveAccessibleDescription(
    'A farm que receberá este Connector.',
  )
  await page.getByRole('button', { name: 'Próxima página de farms' }).click()
  await page
    .locator('#pairing-farm option', { hasText: otherFarm })
    .waitFor({ state: 'attached' })
  await expect(
    page.getByRole('button', { name: 'Próxima página de farms' }),
  ).toHaveCount(0)
})

test('pairing: loading is announced once, marks the area busy and shows skeletons', async ({
  page,
}) => {
  await open(page, byId('parear-loading'), viewports[0], 'light')
  await expect(page.locator('[aria-busy="true"]').getByRole('status')).toHaveText(
    'Carregando suas farms…',
  )
  await expect(page.locator('.skeleton')).toHaveCount(3)
  await expect(page.locator('#pairing-farm')).toHaveCount(0)
})

test('pairing: the error is an alert with a retry that recovers', async ({
  page,
}) => {
  await open(page, byId('parear-error'), viewports[0], 'light')
  const alert = page.getByRole('alert')
  await expect(alert).toContainText('Pareamento indisponível.')
  await page.unroute('**/api/**')
  await mockApi(page)
  await alert.getByRole('button', { name: 'Recarregar formulário' }).click()
  await farmOption(page, '#pairing-farm')
  await expect(page.getByRole('heading', { name: 'Pareamento não concluído' })).toHaveCount(0)
})

test('pairing: the empty state offers a way out', async ({ page }) => {
  await open(page, byId('parear-no-farms'), viewports[0], 'light')
  await expect(page.getByRole('link', { name: 'Usar outra conta' })).toHaveAttribute(
    'href',
    '/entrar',
  )
  await expect(page.locator('#pairing-farm')).toHaveCount(0)
})

test('devices: the title takes focus and the keyboard reaches the farm controls with a focus ring', async ({
  page,
}) => {
  await open(page, byId('dispositivos-select-farm'), viewports[1], 'light')
  await expect(page.getByRole('heading', { level: 1 })).toBeFocused()
  await page.locator('#device-farm').focus()
  const seen: string[] = []
  for (let step = 0; step < 2; step++) {
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
  expect(seen).toEqual(['device-farm', 'Atualizar farms'])
})

test('devices: error moves focus to the alert, drops stale data and retry recovers', async ({
  page,
}) => {
  await open(page, byId('dispositivos-error'), viewports[0], 'light')
  const alert = page.getByRole('alert')
  await expect(alert).toBeFocused()
  await expect(alert).toContainText('A operação não foi confirmada.')
  await page.unroute('**/api/**')
  await mockApi(page)
  await alert.getByRole('button', { name: 'Tentar novamente' }).click()
  await farmOption(page, '#device-farm')
  await expect(alert.getByRole('heading')).toHaveCount(0)
})

test('devices: loading is announced, marks the area busy and shows skeletons', async ({
  page,
}) => {
  await open(page, byId('dispositivos-loading'), viewports[0], 'light')
  await expect(page.locator('[aria-busy="true"]').getByRole('status').first()).toHaveText(
    'Carregando farms e dispositivos…',
  )
  await expect(page.locator('.skeleton')).toHaveCount(3)
})

test('devices: empty states say why and keep creating a key available', async ({
  page,
}) => {
  await open(page, byId('dispositivos-empty'), viewports[0], 'light')
  await expect(page.getByText('Nenhuma chave local para esta conta e farm')).toBeVisible()
  await expect(
    page.getByRole('button', { name: 'Criar chave e solicitar cadastro' }),
  ).toBeEnabled()
})

test('devices: records for an owner show state as text and gate approve and revoke on the typed fingerprint', async ({
  page,
}) => {
  const mock = await open(page, byId('dispositivos-populated'), viewports[0], 'dark')
  const list = page.getByRole('list', { name: 'Dispositivos da farm' })
  await expect(list.getByRole('listitem')).toHaveCount(3)
  for (const label of ['Pendente', 'Aprovado', 'Revogado'])
    await expect(list.getByText(label, { exact: true })).toBeVisible()
  await expect(list.getByText(longAccount)).toBeVisible()
  const approve = page.getByRole('button', { name: 'Aprovar dispositivo' })
  const revoke = page.getByRole('button', { name: 'Revogar definitivamente' })
  await expect(approve).toHaveCount(1)
  await expect(revoke).toHaveCount(2)
  await expect(approve).toBeDisabled()
  await expect(revoke.first()).toBeDisabled()
  await page.getByLabel('Impressão digital confirmada').fill(thumbprint)
  await expect(approve).toBeEnabled()
  await expect(revoke.first()).toBeEnabled()
  await expect(revoke.last()).toBeDisabled()
  expect(mock.posts).toEqual([])
  expect(await fits(page)).toBe(true)
})

test('devices: a non-admin sees the records but no decision controls', async ({
  page,
}) => {
  await open(page, byId('dispositivos-member'), viewports[1], 'light')
  await expect(page.getByLabel('Impressão digital confirmada')).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Aprovar dispositivo' })).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Revogar definitivamente' })).toHaveCount(0)
})

test('devices: "Próxima página de dispositivos" queries the next page', async ({
  page,
}) => {
  const mock = await open(page, byId('dispositivos-populated'), viewports[1], 'light')
  await page.getByRole('button', { name: 'Próxima página de dispositivos' }).click()
  await expect
    .poll(() => mock.gets.some((item) => item.includes(`after=${cursor}`)))
    .toBe(true)
})

test('devices: a key kept in this browser is listed with its actions', async ({
  page,
}) => {
  await open(page, byId('dispositivos-keys'), viewports[0], 'light')
  const keys = page.getByRole('list', { name: 'Chaves locais' })
  await expect(keys.getByRole('listitem')).toHaveCount(1)
  await expect(
    keys.getByText('O registro desta chave não aparece nesta página.'),
  ).toBeVisible()
  await expect(
    keys.getByRole('button', { name: 'Retomar cadastro com esta chave' }),
  ).toBeEnabled()
  await expect(
    keys.getByRole('button', { name: 'Confirmar posse da chave existente' }),
  ).toBeEnabled()
})

test('makes no request outside the loopback host', async ({ page }) => {
  const external: string[] = []
  page.on('request', (request) => {
    const { hostname, protocol } = new URL(request.url())
    if (protocol.startsWith('http') && !loopback.includes(hostname))
      external.push(request.url())
  })
  await open(page, byId('dispositivos-populated'), viewports[1], 'dark')
  expect(external).toEqual([])
})

test('screenshots of real screen states', async ({ page }, testInfo) => {
  testInfo.setTimeout(600_000)
  // A state that cannot be reached fails fast instead of waiting for the test timeout.
  page.setDefaultTimeout(20_000)
  const dir =
    process.env.POLISH_ONBOARDING_SHOTS_DIR ??
    (await mkdtemp(join(tmpdir(), 'openfarm-onboarding-shots-')))
  await mkdir(dir, { recursive: true })
  const written: string[] = []
  for (const scenario of scenarios)
    for (const viewport of viewports)
      for (const theme of themes) {
        await page.unrouteAll({ behavior: 'ignoreErrors' })
        await open(page, scenario, viewport, theme)
        const path = join(dir, `${scenario.id}-${viewport.name}-${theme}.png`)
        await page.screenshot({ path, fullPage: true })
        if ((await stat(path)).size <= 0) throw new Error(`Empty ${path}`)
        written.push(path)
      }
  expect(written).toHaveLength(scenarios.length * viewports.length * themes.length)
  expect((await readdir(dir)).filter((name) => name.endsWith('.png'))).toEqual(
    expect.arrayContaining(written.map((path) => path.split('/').pop()!)),
  )
})
