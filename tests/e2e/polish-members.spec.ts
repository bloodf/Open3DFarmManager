import { mkdir, mkdtemp, readdir, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import AxeBuilder from '@axe-core/playwright'
import { expect, test, type Page } from '@playwright/test'
import { setPolishTheme } from '../helpers/polish-theme.ts'
import { mockShellApi } from '../helpers/shell-api.ts'

// Isolated UI checks for /membros and /convites on mocked /api routes. No real
// printer, database, auth service or external network is involved: every
// request that is not served by the app itself is fulfilled here or aborted.
//
// Screenshots are always captured by the last test and saved outside the
// repository (POLISH_MEMBERS_SHOTS_DIR or a temporary directory).
const farmA = '00000000-0000-4000-8000-0000000000f1'
const farmB = '00000000-0000-4000-8000-0000000000f2'
const longName = `visualizador-com-um-nome-muito-longo-${'x'.repeat(60)}`
const noNameId = '00000000-0000-4000-8000-00000000abcd'

const viewports = [
  { name: '360', width: 360, height: 800 },
  { name: 'desktop', width: 1280, height: 900 },
] as const
const themes = ['light', 'dark'] as const

const members = [
  { accountId: 'dono-conta', username: 'Marina Souza', role: 'owner' },
  { accountId: 'admin-account', username: 'Admin', role: 'admin' },
  { accountId: 'operador-conta', username: 'Operador 01', role: 'operator' },
  { accountId: 'viewer-conta', username: longName, role: 'viewer' },
  { accountId: noNameId, username: null, role: 'viewer' },
]
const invites = [
  {
    id: '11111111-1111-4111-8111-111111111111',
    role: 'viewer',
    createdAt: '2026-11-15T12:00:00.000Z',
    expiresAt: '2026-11-18T12:00:00.000Z',
    status: 'pending',
  },
  {
    id: '22222222-2222-4222-8222-222222222222',
    role: 'admin',
    createdAt: '2026-11-15T13:00:00.000Z',
    expiresAt: '2026-11-18T13:00:00.000Z',
    status: 'pending',
  },
  {
    id: '33333333-3333-4333-8333-333333333333',
    role: 'operator',
    createdAt: '2026-11-10T13:00:00.000Z',
    expiresAt: '2026-11-13T13:00:00.000Z',
    status: 'expired',
  },
]

const memberScenarios = [
  'populated',
  'empty',
  'no-farms',
  'loading',
  'sign-in',
  'forbidden',
  'error',
  'stale',
  'saved',
  'dialog-role',
  'dialog-remove',
  'dialog-revoke',
  'dialog-error',
] as const
const inviteScenarios = [
  'form',
  'submitting',
  'created',
  'create-forbidden',
  'no-farms',
  'loading',
  'load-error',
] as const
type MemberScenario = (typeof memberScenarios)[number]
type InviteScenario = (typeof inviteScenarios)[number]
type Screen =
  | { page: 'membros'; scenario: MemberScenario }
  | { page: 'convites'; scenario: InviteScenario }
const screens: Screen[] = [
  ...memberScenarios.map(
    (scenario) => ({ page: 'membros', scenario }) as const,
  ),
  ...inviteScenarios.map(
    (scenario) => ({ page: 'convites', scenario }) as const,
  ),
]
type Viewport = (typeof viewports)[number]
type Theme = (typeof themes)[number]

interface Mock {
  scenario: string
  /** Set to true to make the failing or hanging request of the scenario succeed. */
  recovered: boolean
  membersGets: number
  posts: { path: string; body: unknown }[]
  errors: string[]
}

async function mockApi(page: Page, scenario: string): Promise<Mock> {
  const mock: Mock = {
    scenario,
    recovered: false,
    membersGets: 0,
    posts: [],
    errors: [],
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
  // Anything not mocked below never leaves the test.
  await page.route(
    (url) => !['127.0.0.1', 'localhost'].includes(url.hostname),
    (route) => route.abort(),
  )
  const failing = (name: string) => mock.scenario === name && !mock.recovered
  await page.route('**/api/**', async (route) => {
    const request = route.request()
    const { pathname } = new URL(request.url())
    const key = `${request.method()} ${pathname}`
    const json = (body: unknown, status = 200) =>
      route.fulfill({ status, json: body })
    if (key === 'GET /api/auth/me') return json({ accountId: 'dono-conta' })
    if (key === 'GET /api/browser-devices')
      return json({
        currentAccountId: 'dono-conta',
        currentRole: 'owner',
        devices: [],
        nextAfter: null,
        limits: {
          pendingLifetimeMs: 86_400_000,
          proofLifetimeMs: 60_000,
          maxChallengesPerKey: 3,
        },
      })
    if (key === 'GET /api/farms') {
      if (failing('sign-in') || failing('load-error')) return json({}, 401)
      if (failing('loading')) return new Promise(() => undefined)
      const ids =
        mock.scenario === 'no-farms'
          ? []
          : mock.scenario === 'populated'
            ? [farmA, farmB]
            : [farmA]
      return json({ farms: ids.map((farmId) => ({ farmId })), nextAfter: null })
    }
    const directory = pathname.match(
      /^\/api\/farms\/([^/]+)\/(members|invites)$/,
    )
    if (directory && request.method() === 'GET') {
      const [, farm, kind] = directory
      if (kind === 'members') mock.membersGets++
      if (failing('forbidden')) return json({}, 403)
      if (failing('error')) return json({}, 500)
      if (mock.scenario === 'stale' && mock.membersGets > 1)
        return json({}, 500)
      if (mock.scenario === 'members-loading')
        return new Promise(() => undefined)
      const empty = mock.scenario === 'empty' || farm === farmB
      if (kind === 'members') return json({ members: empty ? [] : members })
      return json({ invites: empty ? [] : invites })
    }
    if (request.method() === 'POST') {
      const body = request.postDataJSON() as unknown
      mock.posts.push({ path: pathname, body })
      if (pathname.endsWith('/invites')) {
        if (mock.scenario === 'submitting') return new Promise(() => undefined)
        if (mock.scenario === 'create-forbidden') return json({}, 403)
        return json({
          token: 'token-sintetico-123',
          expiresAt: '2026-11-24T15:00:00.000Z',
        })
      }
      if (mock.scenario === 'dialog-error') return json({}, 409)
      return json({})
    }
    return json({}, 404)
  })
  await mockShellApi(page, farmA)
  await mockShellApi(page, farmB)
  return mock
}

// "loading" on /membros hangs the member list, not the farm list.
async function mockFor(page: Page, screen: Screen) {
  const mock = await mockApi(
    page,
    screen.page === 'membros' && screen.scenario === 'loading'
      ? 'members-loading'
      : screen.scenario,
  )
  return mock
}

const h1 = {
  membros: 'Membros e convites',
  convites: 'Convidar pessoa',
} as const

const row = (page: Page, name: string) =>
  page.locator('li', { has: page.getByText(name, { exact: true }) })

async function removeAdmin(page: Page) {
  await page.getByRole('button', { name: 'Remover Admin' }).click()
  await page.getByRole('dialog').waitFor()
}
async function confirm(page: Page, check: string, button: string) {
  await page.getByLabel(check).check()
  await page.getByRole('button', { name: button }).click()
}
async function askRoleChange(page: Page) {
  await page.getByLabel('Novo papel para Admin').selectOption('viewer')
  await row(page, 'Admin')
    .getByRole('button', { name: 'Alterar papel' })
    .click()
  await page.getByRole('dialog').waitFor()
}

/** Drives the page from its first paint to the state the scenario shows. */
async function act(page: Page, screen: Screen) {
  if (screen.page === 'convites') {
    if (['submitting', 'created', 'create-forbidden'].includes(screen.scenario))
      await page.getByRole('button', { name: 'Criar convite' }).click()
    return
  }
  switch (screen.scenario) {
    case 'stale':
      await removeAdmin(page)
      await confirm(
        page,
        'Confirmei a remoção deste membro.',
        'Confirmar remoção',
      )
      break
    case 'saved':
      await askRoleChange(page)
      await confirm(
        page,
        'Confirmei a alteração de papel.',
        'Confirmar alteração de papel',
      )
      break
    case 'dialog-role':
      await askRoleChange(page)
      break
    case 'dialog-remove':
      await removeAdmin(page)
      break
    case 'dialog-revoke':
      await page
        .getByRole('button', { name: 'Revogar convite de Visualizador' })
        .click()
      await page.getByRole('dialog').waitFor()
      break
    case 'dialog-error':
      await removeAdmin(page)
      await confirm(
        page,
        'Confirmei a remoção deste membro.',
        'Confirmar remoção',
      )
      break
  }
}

const text = (page: Page, value: string) =>
  page.getByText(value, { exact: false }).first().waitFor()

/**
 * Waits for the state each scenario ends in. Only text the page shows both
 * before and after the polish is used, so the baseline capture settles too.
 */
async function settle(page: Page, screen: Screen) {
  if (screen.page === 'convites') {
    switch (screen.scenario) {
      case 'form':
        return page.getByRole('button', { name: 'Criar convite' }).waitFor()
      case 'submitting':
        return page.getByRole('button', { name: 'Criando convite…' }).waitFor()
      case 'created':
        return page.getByRole('heading', { name: 'Convite criado' }).waitFor()
      case 'create-forbidden':
        return text(page, 'Somente proprietários da farm podem criar convites.')
      case 'no-farms':
        return page
          .getByRole('heading', { name: 'Nenhuma farm disponível' })
          .waitFor()
      case 'loading':
        return text(page, 'Carregando suas farms…')
      case 'load-error':
        return text(page, 'Entre na sua conta para criar convites.')
    }
    return
  }
  switch (screen.scenario) {
    case 'populated':
    case 'dialog-role':
    case 'dialog-remove':
    case 'dialog-revoke':
      return page.getByText('Admin', { exact: true }).first().waitFor()
    case 'empty':
      return page
        .getByRole('heading', { name: 'Nenhum membro nesta farm' })
        .waitFor()
    case 'no-farms':
      return page
        .getByRole('heading', { name: 'Nenhuma farm disponível' })
        .waitFor()
    case 'loading':
      return text(page, 'Carregando membros e convites…')
    case 'sign-in':
      return text(page, 'Entre na sua conta para gerenciar membros e convites.')
    case 'forbidden':
      return text(
        page,
        'Somente proprietários da farm podem gerenciar membros e convites.',
      )
    case 'error':
      return text(page, 'Não foi possível carregar membros e convites.')
    case 'stale':
      return text(page, 'Lista desatualizada')
    case 'saved':
      return page
        .getByRole('status')
        .filter({ hasText: 'Papel atualizado.' })
        .first()
        .waitFor()
    case 'dialog-error':
      return text(page, 'A farm precisa de pelo menos um proprietário.')
  }
}

async function open(
  page: Page,
  screen: Screen,
  viewport: Viewport,
  theme: Theme,
) {
  await page.setViewportSize(viewport)
  await setPolishTheme(page, theme)
  const mock = await mockFor(page, screen)
  const scope = screen.scenario === 'populated' ? `?farm=${farmA}` : ''
  await page.goto(`/${screen.page}${scope}`)
  await page.getByRole('heading', { level: 1, name: h1[screen.page] }).waitFor()
  await act(page, screen)
  await settle(page, screen)
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

const populated: Screen = { page: 'membros', scenario: 'populated' }
const form: Screen = { page: 'convites', scenario: 'form' }
const desktop = viewports[1]
const phone = viewports[0]

for (const screen of screens)
  for (const viewport of viewports)
    for (const theme of themes)
      test(`${screen.page} ${screen.scenario} state is accessible, error free and fits at ${viewport.name} in the ${theme} theme`, async ({
        page,
      }) => {
        const mock = await open(page, screen, viewport, theme)
        expect(await fits(page)).toBe(true)
        expect(await violations(page)).toEqual([])
        expect(mock.errors).toEqual([])
      })

test('pages have one main, one h1 and headings in order', async ({ page }) => {
  for (const screen of [
    populated,
    form,
    { page: 'convites', scenario: 'created' } as const,
  ]) {
    await page.unrouteAll({ behavior: 'ignoreErrors' })
    await open(page, screen, desktop, 'light')
    await expect(page.getByRole('main')).toHaveCount(1)
    await expect(page.getByRole('heading', { level: 1 })).toHaveCount(1)
    const levels = await page
      .locator('h1, h2, h3, h4, h5, h6')
      .evaluateAll((nodes) => nodes.map((node) => Number(node.tagName[1])))
    expect(levels.length).toBeGreaterThan(1)
    for (const [index, level] of levels.entries())
      if (index > 0) expect(level - levels[index - 1]!).toBeLessThanOrEqual(1)
  }
})

test('members list names every member, labels every control and wraps long values', async ({
  page,
}) => {
  await open(page, populated, phone, 'light')
  const list = page.getByRole('region', { name: 'Membros' })
  await expect(list.getByRole('listitem')).toHaveCount(members.length)
  await expect(list.getByText('5 membros')).toBeVisible()
  // Role is text, never colour alone, and a member without a name shows the id.
  await expect(row(page, 'Marina Souza')).toContainText(
    'Papel atual: Proprietário',
  )
  await expect(row(page, noNameId)).toBeVisible()
  await expect(row(page, longName)).toBeVisible()
  for (const name of [
    'Admin',
    'Operador 01',
    longName,
    noNameId,
    'Marina Souza',
  ]) {
    await expect(page.getByLabel(`Novo papel para ${name}`)).toBeVisible()
    await expect(
      page.getByRole('button', { name: `Remover ${name}` }),
    ).toBeVisible()
  }
  // Expired invites stay out of the action list.
  const pending = page.getByRole('region', { name: 'Convites pendentes' })
  await expect(pending.getByRole('listitem')).toHaveCount(2)
  await expect(
    pending.getByRole('button', { name: 'Revogar convite de Operador' }),
  ).toHaveCount(0)
  // The owner has no assignable role to switch to until one is picked.
  await expect(
    row(page, 'Marina Souza').getByRole('button', { name: 'Alterar papel' }),
  ).toBeDisabled()
  expect(await fits(page)).toBe(true)
})

test('keyboard reaches the new-invite link, the farm and the first member with a visible focus ring', async ({
  page,
}) => {
  await open(page, populated, desktop, 'light')
  await page
    .getByRole('main')
    .getByRole('link', { name: 'Criar novo convite' })
    .focus()
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
    'Criar novo convite',
    'members-farm',
    'member-role-dono-conta',
  ])
})

test('changing the farm reloads the lists and keeps keyboard focus on the farm field', async ({
  page,
}) => {
  await open(page, populated, desktop, 'light')
  const select = page.getByRole('main').getByLabel('Farm', { exact: true })
  await select.focus()
  const request = page.waitForRequest((item) =>
    item.url().endsWith(`/api/farms/${farmB}/members`),
  )
  await select.selectOption(farmB)
  await request
  await expect(
    page.getByRole('heading', { name: 'Nenhum membro nesta farm' }),
  ).toBeVisible()
  await expect(select).toBeFocused()
})

test('the confirmation is a modal that keeps its checkbox gate, posts the same request and returns focus on Escape', async ({
  page,
}) => {
  const mock = await open(page, populated, desktop, 'light')
  const opener = row(page, 'Admin').getByRole('button', {
    name: 'Remover Admin',
  })
  await opener.click()
  const dialog = page.getByRole('dialog', { name: 'Remover Admin' })
  await expect(dialog).toBeVisible()
  await expect(
    dialog.getByLabel('Confirmei a remoção deste membro.'),
  ).toBeFocused()
  const confirmButton = dialog.getByRole('button', {
    name: 'Confirmar remoção',
  })
  await expect(confirmButton).toBeDisabled()
  expect(mock.posts).toEqual([])
  await page.keyboard.press('Escape')
  await expect(dialog).toBeHidden()
  await expect(opener).toBeFocused()
  expect(mock.posts).toEqual([])

  await opener.click()
  await dialog.getByLabel('Confirmei a remoção deste membro.').check()
  await expect(confirmButton).toBeEnabled()
  await confirmButton.click()
  await expect(dialog).toBeHidden()
  await expect(
    page.getByRole('status').filter({ hasText: 'Membro removido.' }).first(),
  ).toBeVisible()
  expect(mock.posts).toEqual([
    { path: `/api/farms/${farmA}/members/admin-account/remove`, body: {} },
  ])
  // Focus is back on the page (the opener or the farm field), never on <body>.
  expect(await page.evaluate(() => document.activeElement?.tagName)).not.toBe(
    'BODY',
  )
})

test('a role change and a revoke post their original bodies', async ({
  page,
}) => {
  const mock = await open(page, populated, desktop, 'light')
  await askRoleChange(page)
  await expect(
    page.getByRole('heading', { name: 'Alterar papel de Admin' }),
  ).toBeVisible()
  await confirm(
    page,
    'Confirmei a alteração de papel.',
    'Confirmar alteração de papel',
  )
  await expect(page.getByRole('dialog')).toBeHidden()
  await page
    .getByRole('button', { name: 'Revogar convite de Visualizador' })
    .click()
  await confirm(
    page,
    'Confirmei a revogação deste convite.',
    'Confirmar revogação',
  )
  await expect(page.getByRole('dialog')).toBeHidden()
  expect(mock.posts).toEqual([
    {
      path: `/api/farms/${farmA}/members/admin-account/role`,
      body: { role: 'viewer' },
    },
    {
      path: `/api/farms/${farmA}/invites/${invites[0]!.id}/revoke`,
      body: {},
    },
  ])
})

test('a refused action explains itself inside the dialog, moves focus to it and does not linger after cancelling', async ({
  page,
}) => {
  await open(
    page,
    { page: 'membros', scenario: 'dialog-error' },
    phone,
    'light',
  )
  const dialog = page.getByRole('dialog')
  const alert = dialog.getByRole('alert')
  await expect(alert).toContainText(
    'A farm precisa de pelo menos um proprietário.',
  )
  await expect(alert).toBeFocused()
  await dialog.getByRole('button', { name: 'Cancelar' }).click()
  await expect(dialog).toBeHidden()
  await row(page, 'Admin')
    .getByRole('button', { name: 'Remover Admin' })
    .click()
  await expect(page.getByRole('dialog').getByRole('alert')).toHaveCount(0)
})

test('loading is announced once, marks the region busy and shows no list', async ({
  page,
}) => {
  await open(page, { page: 'membros', scenario: 'loading' }, phone, 'light')
  const busy = page.locator('[aria-busy="true"]')
  await expect(busy.getByRole('status')).toHaveText(
    'Carregando membros e convites…',
  )
  await expect(page.locator('.skeleton')).toHaveCount(3)
  await expect(page.getByRole('main').getByRole('listitem')).toHaveCount(0)
  await expect(
    page.getByRole('main').getByLabel('Farm', { exact: true }),
  ).toBeDisabled()
})

test('empty states say why and offer a way out', async ({ page }) => {
  await open(page, { page: 'membros', scenario: 'empty' }, phone, 'light')
  await expect(
    page.getByRole('heading', { name: 'Nenhum convite pendente' }),
  ).toBeVisible()
  await expect(
    page.getByRole('link', { name: 'Convidar uma pessoa' }),
  ).toHaveAttribute('href', '/convites')
  await expect(
    page.getByRole('link', { name: 'Gerar novo convite' }),
  ).toHaveAttribute('href', '/convites')
  await page.unrouteAll({ behavior: 'ignoreErrors' })
  await open(page, { page: 'membros', scenario: 'no-farms' }, phone, 'light')
  await expect(
    page.getByRole('link', { name: 'Abrir a página da farm' }),
  ).toHaveAttribute('href', '/farm')
  await expect(page.getByRole('main').getByRole('listitem')).toHaveCount(0)
})

test('a failed load focuses the alert, keeps no old rows and retry recovers', async ({
  page,
}) => {
  const mock = await open(
    page,
    { page: 'membros', scenario: 'error' },
    phone,
    'light',
  )
  const alert = page.getByRole('alert')
  await expect(alert).toBeFocused()
  await expect(
    alert.getByRole('heading', { name: 'Membros indisponíveis' }),
  ).toBeVisible()
  await expect(page.getByRole('main').getByRole('listitem')).toHaveCount(0)
  await expect(
    page.getByRole('link', { name: 'Entrar na conta' }),
  ).toHaveAttribute('href', '/entrar')
  mock.recovered = true
  await alert.getByRole('button', { name: 'Tentar novamente' }).click()
  await expect(page.getByText('Admin', { exact: true })).toBeVisible()
  await expect(page.getByRole('alert')).toHaveCount(0)
})

test('forbidden and signed-out accounts get their own message', async ({
  page,
}) => {
  await open(page, { page: 'membros', scenario: 'forbidden' }, phone, 'light')
  await expect(page.getByRole('alert')).toContainText(
    'Somente proprietários da farm podem gerenciar membros e convites.',
  )
  await page.unrouteAll({ behavior: 'ignoreErrors' })
  await open(page, { page: 'membros', scenario: 'sign-in' }, phone, 'light')
  await expect(page.getByRole('alert')).toContainText(
    'Entre na sua conta para gerenciar membros e convites.',
  )
})

test('a saved change with a failed reload keeps the old list, flags it and refresh recovers', async ({
  page,
}) => {
  const mock = await open(
    page,
    { page: 'membros', scenario: 'stale' },
    phone,
    'light',
  )
  const notice = page
    .getByRole('status')
    .filter({ hasText: 'Lista desatualizada' })
  await expect(notice).toBeVisible()
  await expect(page.getByText('Admin', { exact: true })).toBeVisible()
  mock.scenario = 'populated'
  await notice.getByRole('button', { name: 'Atualizar lista' }).click()
  await expect(notice).toHaveCount(0)
})

test('the invite form is labelled, posts the chosen role and moves focus to the one-time link', async ({
  page,
}) => {
  const mock = await open(page, form, desktop, 'light')
  await expect(
    page.getByRole('main').getByLabel('Farm', { exact: true }),
  ).toBeVisible()
  await page.getByRole('main').getByLabel('Papel').selectOption('operator')
  await page.getByRole('button', { name: 'Criar convite' }).click()
  const result = page.getByRole('heading', { name: 'Convite criado' })
  await expect(result).toBeFocused()
  const link = page.getByLabel('Link do convite')
  await expect(link).toHaveValue(/\/criar-conta#codigo=token-sintetico-123$/)
  await expect(link).toHaveAttribute('readonly', '')
  await link.focus()
  expect(
    await link.evaluate(
      (node: HTMLInputElement) =>
        node.selectionStart === 0 && node.selectionEnd === node.value.length,
    ),
  ).toBe(true)
  expect(mock.posts).toEqual([
    { path: `/api/farms/${farmA}/invites`, body: { role: 'operator' } },
  ])
})

test('a refused invite shows the reason in the alert and leaves no link behind', async ({
  page,
}) => {
  await open(
    page,
    { page: 'convites', scenario: 'create-forbidden' },
    phone,
    'light',
  )
  await expect(page.getByRole('alert')).toBeFocused()
  await expect(page.getByRole('alert')).toContainText(
    'Somente proprietários da farm podem criar convites.',
  )
  await expect(page.locator('#invite-link')).toHaveCount(0)
})

test('invite loading and load failure follow the same patterns', async ({
  page,
}) => {
  await open(page, { page: 'convites', scenario: 'loading' }, phone, 'light')
  await expect(
    page.locator('[aria-busy="true"]').getByRole('status'),
  ).toHaveText('Carregando suas farms…')
  await expect(page.locator('.skeleton')).toHaveCount(3)
  await page.unrouteAll({ behavior: 'ignoreErrors' })
  const mock = await open(
    page,
    { page: 'convites', scenario: 'load-error' },
    phone,
    'light',
  )
  await expect(page.getByRole('alert')).toBeFocused()
  await expect(
    page.getByRole('link', { name: 'Entrar na conta' }),
  ).toHaveAttribute('href', '/entrar')
  mock.recovered = true
  await page.getByRole('button', { name: 'Tentar novamente' }).click()
  await expect(
    page.getByRole('button', { name: 'Criar convite' }),
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
  await open(page, populated, desktop, 'dark')
  expect(external).toEqual([])
})

test('screenshots of real screen states', async ({ page }, testInfo) => {
  testInfo.setTimeout(300_000)
  const dir =
    process.env.POLISH_MEMBERS_SHOTS_DIR ??
    (await mkdtemp(join(tmpdir(), 'openfarm-members-shots-')))
  await mkdir(dir, { recursive: true })
  const written: string[] = []
  for (const screen of screens)
    for (const viewport of viewports)
      for (const theme of themes) {
        await page.unrouteAll({ behavior: 'ignoreErrors' })
        await open(page, screen, viewport, theme)
        const name = `${screen.page}-${screen.scenario}-${viewport.name}-${theme}.png`
        // A modal covers the viewport, so its states are captured as seen.
        await page.screenshot({
          path: join(dir, name),
          fullPage: !screen.scenario.startsWith('dialog'),
        })
        if ((await stat(join(dir, name))).size <= 0)
          throw new Error(`Empty ${name}`)
        written.push(name)
      }
  expect(written).toHaveLength(
    screens.length * viewports.length * themes.length,
  )
  expect((await readdir(dir)).filter((name) => name.endsWith('.png'))).toEqual(
    expect.arrayContaining(written),
  )
})
