import { mkdir, mkdtemp, readdir, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import AxeBuilder from '@axe-core/playwright'
import { expect, test, type Page, type Request } from '@playwright/test'

// Isolated UI checks for the sign-in (/entrar), password reset
// (/redefinir-senha) and sign-out (/sair) screens on mocked /api routes. No
// printer, database, auth service or external network is involved: every
// request that is not served by the app itself is fulfilled here or aborted.
//
// Screenshots are always captured by the last test and saved outside the
// repository (POLISH_AUTH_SHOTS_DIR or a temporary directory).
const viewports = [
  { name: '360', width: 360, height: 800 },
  { name: 'desktop', width: 1280, height: 900 },
] as const
const themes = ['light', 'dark'] as const
type Viewport = (typeof viewports)[number]
type Theme = (typeof themes)[number]

const password = 'senha-muito-longa-123'
const token = 'A'.repeat(43)
const resetDone = 'Senha redefinida. Entre com a nova senha.'

type Mock = {
  account?: 'anonymous' | 'signed-in'
  google?: { enabled: boolean; reason?: string }
  oidc?: boolean
  /** The browser reports no network (the offline Docker runner always does). */
  offline?: boolean
  login?: 'ok' | '401' | '429' | '500' | 'hang'
  reset?: 'ok' | 'error' | 'hang'
  logout?: 'ok' | 'error' | 'hang'
  revoke?: 'ok' | 'error'
}
type Call = { path: string; body: unknown; headers: Record<string, string> }

/** Every /api call of the page is answered here; nothing leaves the test. */
async function mockApi(page: Page, mock: Mock = {}) {
  const calls: Call[] = []
  // The runner has no network, so the browser would report it offline.
  await page.addInitScript((offline) => {
    Object.defineProperty(navigator, 'onLine', {
      configurable: true,
      get: () => !offline,
    })
  }, mock.offline === true)
  const unmocked: string[] = []
  await page.route(
    (url) => !['127.0.0.1', 'localhost'].includes(url.hostname),
    (route) => route.abort(),
  )
  await page.route('**/api/**', (route) => {
    unmocked.push(new URL(route.request().url()).pathname)
    return route.fulfill({ status: 404, json: {} })
  })
  const answer = async (
    path: string,
    outcome: 'ok' | 'error' | '401' | '429' | '500' | 'hang',
    ok: { status: number; json?: unknown },
    request: Request,
  ) => {
    calls.push({
      path,
      body: request.postDataJSON() as unknown,
      headers: request.headers(),
    })
    if (outcome === 'hang') return new Promise<never>(() => undefined)
    const status =
      outcome === 'ok' ? ok.status : outcome === 'error' ? 503 : Number(outcome)
    return { status, json: outcome === 'ok' ? ok.json : {} }
  }
  const fulfillWith = (
    path: string,
    outcome: 'ok' | 'error' | '401' | '429' | '500' | 'hang',
    ok: { status: number; json?: unknown },
  ) =>
    page.route(`**${path}`, async (route) => {
      const reply = await answer(path, outcome, ok, route.request())
      if (reply.json === undefined)
        return route.fulfill({ status: reply.status })
      return route.fulfill(reply)
    })
  await page.route('**/api/auth/me', (route) =>
    mock.account === 'signed-in'
      ? route.fulfill({ json: { accountId: 'conta-sintetica' } })
      : route.fulfill({ status: 401, json: {} }),
  )
  await page.route('**/api/farms?*', (route) =>
    route.fulfill({ json: { farms: [], nextAfter: null } }),
  )
  await page.route('**/api/auth/oidc', (route) =>
    route.fulfill({ json: { enabled: mock.oidc === true } }),
  )
  await page.route('**/api/auth/google', (route) =>
    route.fulfill({ json: mock.google ?? { enabled: false } }),
  )
  await fulfillWith('/api/auth/login', mock.login ?? 'ok', { status: 204 })
  await fulfillWith('/api/auth/password-reset-complete', mock.reset ?? 'ok', {
    status: 200,
    json: { message: resetDone },
  })
  await fulfillWith('/api/auth/logout', mock.logout ?? 'ok', { status: 204 })
  await fulfillWith('/api/auth/sessions/revoke', mock.revoke ?? 'ok', {
    status: 204,
  })
  return { calls, unmocked }
}

const hydrated = (page: Page) =>
  page.waitForFunction(() => {
    const root = document.querySelector('#__nuxt')
    return root !== null && '__vue_app__' in root
  })
const username = (page: Page) => page.getByLabel('Usuário', { exact: true })
const loginButton = (page: Page) =>
  page.getByRole('button', { name: 'Entrar', exact: true })
const resetButton = (page: Page) =>
  page.getByRole('button', { name: 'Redefinir senha', exact: true })

async function signIn(page: Page) {
  await expect(loginButton(page)).toBeEnabled()
  await username(page).fill('ana_01')
  await page.getByLabel('Senha', { exact: true }).fill(password)
  await loginButton(page).click()
}
async function resetPassword(page: Page) {
  await expect(resetButton(page)).toBeEnabled()
  await username(page).fill('ana_01')
  await page.getByLabel('Código de redefinição').fill(token)
  await page.getByLabel('Nova senha').fill(password)
  await resetButton(page).click()
}

type Scenario = {
  name: string
  path: string
  heading: string
  mock?: Mock
  /** Waits for the page to be ready, then drives it into the state. */
  run: (page: Page) => Promise<void>
}
const idle = async (page: Page) => {
  await hydrated(page)
}
const scenarios: Scenario[] = [
  {
    name: 'entrar-vazio',
    path: '/entrar',
    heading: 'Entrar',
    run: async (page) => {
      await expect(loginButton(page)).toBeEnabled()
    },
  },
  {
    name: 'entrar-provedores',
    path: '/entrar',
    heading: 'Entrar',
    mock: { google: { enabled: true }, oidc: true },
    run: async (page) => {
      await expect(
        page.getByRole('link', { name: 'Entrar com Google' }),
      ).toBeVisible()
      await expect(
        page.getByRole('link', { name: 'Entrar com OpenID Connect' }),
      ).toBeVisible()
    },
  },
  {
    name: 'entrar-google-offline',
    path: '/entrar',
    heading: 'Entrar',
    mock: { offline: true },
    run: async (page) => {
      await expect(page.getByText('Sem conexão com a internet.')).toBeVisible()
    },
  },
  {
    name: 'entrar-processando',
    path: '/entrar',
    heading: 'Entrar',
    mock: { login: 'hang' },
    run: async (page) => {
      await signIn(page)
      await expect(
        page.getByRole('button', { name: 'Entrando…' }),
      ).toBeDisabled()
    },
  },
  {
    name: 'entrar-invalido',
    path: '/entrar',
    heading: 'Entrar',
    mock: { login: '401' },
    run: async (page) => {
      await signIn(page)
      await expect(page.getByRole('alert')).toContainText(
        'Usuário ou senha inválidos',
      )
    },
  },
  {
    name: 'entrar-limite',
    path: '/entrar',
    heading: 'Entrar',
    mock: { login: '429' },
    run: async (page) => {
      await signIn(page)
      await expect(page.getByRole('alert')).toContainText('Muitas tentativas')
    },
  },
  {
    name: 'entrar-indisponivel',
    path: '/entrar',
    heading: 'Entrar',
    mock: { login: '500' },
    run: async (page) => {
      await signIn(page)
      await expect(page.getByRole('alert')).toContainText(
        'Não foi possível entrar agora',
      )
    },
  },
  {
    name: 'entrar-erro-provedor',
    path: '/entrar#erro=oidc',
    heading: 'Entrar',
    mock: { oidc: true },
    run: async (page) => {
      await expect(page.getByRole('alert')).toContainText(
        'Não foi possível entrar com o provedor OpenID Connect',
      )
    },
  },
  {
    name: 'redefinir-vazio',
    path: '/redefinir-senha',
    heading: 'Redefinir senha',
    run: async (page) => {
      await expect(resetButton(page)).toBeEnabled()
    },
  },
  {
    name: 'redefinir-link',
    path: `/redefinir-senha#usuario=ana_01&codigo=${token}`,
    heading: 'Redefinir senha',
    run: async (page) => {
      await expect(resetButton(page)).toBeEnabled()
      await expect(username(page)).toHaveValue('ana_01')
    },
  },
  {
    name: 'redefinir-processando',
    path: '/redefinir-senha',
    heading: 'Redefinir senha',
    mock: { reset: 'hang' },
    run: async (page) => {
      await resetPassword(page)
      await expect(page.getByText('Processando solicitação.')).toBeVisible()
    },
  },
  {
    name: 'redefinir-sucesso',
    path: '/redefinir-senha',
    heading: 'Redefinir senha',
    run: async (page) => {
      await resetPassword(page)
      await expect(page.getByText(resetDone)).toBeVisible()
    },
  },
  {
    name: 'redefinir-erro',
    path: '/redefinir-senha',
    heading: 'Redefinir senha',
    mock: { reset: 'error' },
    run: async (page) => {
      await resetPassword(page)
      await expect(
        page.getByText('Não foi possível redefinir a senha.'),
      ).toBeVisible()
    },
  },
  {
    name: 'sair-pronto',
    path: '/sair',
    heading: 'Sair da conta',
    mock: { account: 'signed-in' },
    run: async (page) => {
      await idle(page)
      await expect(
        page.getByRole('button', { name: 'Sair de todos os dispositivos' }),
      ).toBeEnabled()
    },
  },
  {
    name: 'sair-processando',
    path: '/sair',
    heading: 'Sair da conta',
    mock: { account: 'signed-in', logout: 'hang' },
    run: async (page) => {
      await idle(page)
      await page.getByRole('button', { name: 'Sair da conta' }).click()
      await expect(page.getByRole('button', { name: 'Saindo…' })).toBeDisabled()
    },
  },
  {
    name: 'sair-erro',
    path: '/sair',
    heading: 'Sair da conta',
    mock: { account: 'signed-in', logout: 'error' },
    run: async (page) => {
      await idle(page)
      await page.getByRole('button', { name: 'Sair da conta' }).click()
      await expect(page.getByRole('alert')).toContainText(
        'Sua sessão pode continuar ativa',
      )
    },
  },
  {
    name: 'sair-todos-erro',
    path: '/sair',
    heading: 'Sair da conta',
    mock: { account: 'signed-in', revoke: 'error' },
    run: async (page) => {
      await idle(page)
      await page
        .getByRole('button', { name: 'Sair de todos os dispositivos' })
        .click()
      await expect(page.getByRole('alert')).toContainText(
        'Não foi possível encerrar todas as sessões.',
      )
    },
  },
]
const byName = (name: string) => scenarios.find((item) => item.name === name)!

/** Console errors of the page, ignoring the browser's note on mocked failures. */
function watchErrors(page: Page) {
  const errors: string[] = []
  page.on('console', (message) => {
    if (
      message.type() === 'error' &&
      !/^Failed to load resource: the server responded with a status of (401|429|500|503)\b/.test(
        message.text(),
      )
    )
      errors.push(message.text())
  })
  page.on('pageerror', (error) => errors.push(error.message))
  return errors
}

async function open(
  page: Page,
  scenario: Scenario,
  viewport: Viewport,
  theme: Theme,
) {
  // A reused page must reload, not just change the hash.
  await page.goto('about:blank')
  await page.setViewportSize(viewport)
  await page.emulateMedia({ colorScheme: theme, reducedMotion: 'reduce' })
  const api = await mockApi(page, scenario.mock)
  await page.goto(scenario.path)
  await page
    .getByRole('heading', { level: 1, name: scenario.heading, exact: true })
    .waitFor()
  await hydrated(page)
  await scenario.run(page)
  return api
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

for (const scenario of scenarios) {
  for (const viewport of viewports) {
    for (const theme of themes) {
      test(`${scenario.name} is accessible, error-free and fits at ${viewport.name} in the ${theme} theme`, async ({
        page,
      }) => {
        const errors = watchErrors(page)
        const api = await open(page, scenario, viewport, theme)
        expect(await fits(page)).toBe(true)
        expect(await violations(page)).toEqual([])
        expect(api.unmocked).toEqual([])
        expect(errors).toEqual([])
      })
    }
  }
}

for (const name of ['entrar-provedores', 'redefinir-vazio', 'sair-pronto']) {
  test(`${name} has one main, one h1 and headings in order`, async ({
    page,
  }) => {
    await open(page, byName(name), viewports[1], 'light')
    await expect(page.getByRole('main')).toHaveCount(1)
    await expect(page.getByRole('heading', { level: 1 })).toHaveCount(1)
    const levels = await page
      .locator('main h1, main h2, main h3, main h4')
      .evaluateAll((nodes) => nodes.map((node) => Number(node.tagName[1])))
    expect(levels[0]).toBe(1)
    for (const [index, level] of levels.entries())
      if (index > 0) expect(level - levels[index - 1]!).toBeLessThanOrEqual(1)
  })
}

test('sign-in fields are labelled, described and typed for password managers', async ({
  page,
}) => {
  await open(page, byName('entrar-vazio'), viewports[1], 'light')
  const user = username(page)
  await expect(user).toHaveAttribute('autocomplete', 'username')
  await expect(user).toHaveAttribute('aria-describedby', 'username-help')
  await expect(page.locator('#username-help')).toContainText(
    'letras minúsculas',
  )
  const secret = page.getByLabel('Senha', { exact: true })
  await expect(secret).toHaveAttribute('type', 'password')
  await expect(secret).toHaveAttribute('autocomplete', 'current-password')
  await expect(
    page.getByRole('link', { name: 'Esqueci a senha' }),
  ).toHaveAttribute('href', '/redefinir-senha')
  await expect(
    page.getByRole('link', { name: 'Voltar ao início' }),
  ).toHaveAttribute('href', '/')
  // Nothing is announced or shown before something happens.
  expect((await page.getByRole('alert').allInnerTexts()).join('').trim()).toBe(
    '',
  )
  await expect(page.locator('[aria-busy="true"]')).toHaveCount(0)
})

test('keyboard reaches every sign-in control in order with a visible focus ring', async ({
  page,
}) => {
  await open(page, byName('entrar-provedores'), viewports[1], 'light')
  await username(page).focus()
  const seen: string[] = []
  for (let step = 0; step < 9; step++) {
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
    'username',
    'password',
    'Entrar',
    'Entrar com Google',
    'Entrar com OpenID Connect',
    'oidc-username',
    'oidc-invite',
    'Vincular convite e entrar',
    'Esqueci a senha',
  ])
})

test('a failed sign-in moves focus to the alert, clears the password and sends one request', async ({
  page,
}) => {
  const api = await open(page, byName('entrar-invalido'), viewports[0], 'light')
  const alert = page.getByRole('alert')
  await expect(alert).toBeFocused()
  await expect(page.getByLabel('Senha', { exact: true })).toHaveValue('')
  await expect(username(page)).toHaveValue('ana_01')
  await expect(loginButton(page)).toBeEnabled()
  expect(api.calls).toEqual([
    expect.objectContaining({
      path: '/api/auth/login',
      body: { username: 'ana_01', password },
    }),
  ])
  await expect(page).toHaveURL(/\/entrar$/)
})

test('a pending sign-in marks the form busy, disables it and announces progress', async ({
  page,
}) => {
  const api = await open(
    page,
    byName('entrar-processando'),
    viewports[0],
    'light',
  )
  await expect(page.locator('form[aria-busy="true"]')).toHaveCount(1)
  await expect(username(page)).toBeDisabled()
  await expect(page.getByLabel('Senha', { exact: true })).toBeDisabled()
  await expect(page.locator('main').getByRole('status')).toHaveText(
    'Verificando seus dados.',
  )
  await page.locator('form').first().dispatchEvent('submit')
  expect(api.calls).toHaveLength(1)
})

test('a successful sign-in goes home', async ({ page }) => {
  await open(page, byName('entrar-vazio'), viewports[1], 'light')
  await signIn(page)
  await expect(page).toHaveURL('/')
})

test('the provider error in the address is announced and removed from the address', async ({
  page,
}) => {
  await open(page, byName('entrar-erro-provedor'), viewports[0], 'light')
  await expect(page.getByRole('alert')).toBeFocused()
  await expect(page).toHaveURL(/\/entrar$/)
})

test('without network the Google option explains why and is not a link', async ({
  page,
}) => {
  await open(page, byName('entrar-google-offline'), viewports[0], 'light')
  await expect(
    page.getByRole('link', { name: 'Entrar com Google' }),
  ).toHaveCount(0)
  await expect(
    page.getByText('o login por senha continua disponível'),
  ).toBeVisible()
  await expect(loginButton(page)).toBeEnabled()
})

test('reset reads the link from the address, removes it and sends the code only as a header', async ({
  page,
}) => {
  const api = await open(page, byName('redefinir-link'), viewports[1], 'light')
  await expect(page.getByLabel('Código de redefinição')).toHaveValue(token)
  await expect(page.getByLabel('Nova senha')).toHaveValue('')
  await expect(page).toHaveURL(/\/redefinir-senha$/)
  await page.getByLabel('Nova senha').fill(password)
  await resetButton(page).click()
  await expect(page.getByText(resetDone)).toBeVisible()
  expect(api.calls).toEqual([
    expect.objectContaining({
      path: '/api/auth/password-reset-complete',
      body: { username: 'ana_01', password },
      headers: expect.objectContaining({ 'x-password-reset-token': token }),
    }),
  ])
  await expect(page.getByLabel('Nova senha')).toHaveValue('')
  await expect(page.getByLabel('Código de redefinição')).toHaveValue('')
  await expect(page.locator('main').getByRole('status')).toHaveText(resetDone)
})

test('reset fields are labelled, hinted and typed for password managers', async ({
  page,
}) => {
  await open(page, byName('redefinir-vazio'), viewports[1], 'light')
  const fresh = page.getByLabel('Nova senha')
  await expect(fresh).toHaveAttribute('autocomplete', 'new-password')
  await expect(fresh).toHaveAccessibleDescription('Use 12 caracteres ou mais.')
  await expect(
    page.getByLabel('Código de redefinição'),
  ).toHaveAccessibleDescription(
    'Preenchido automaticamente ao abrir o link recebido.',
  )
  await expect(
    page.getByRole('link', { name: 'Voltar para entrar' }),
  ).toHaveAttribute('href', '/entrar')
  expect((await page.getByRole('alert').allInnerTexts()).join('').trim()).toBe(
    '',
  )
})

test('a failed reset moves focus to the alert and keeps no password', async ({
  page,
}) => {
  await open(page, byName('redefinir-erro'), viewports[0], 'dark')
  await expect(page.getByRole('alert')).toBeFocused()
  await expect(page.getByRole('alert')).toContainText('Peça um novo link')
  await expect(page.getByLabel('Nova senha')).toHaveValue('')
  await expect(resetButton(page)).toBeEnabled()
})

test('a pending reset marks the form busy and disables the fields', async ({
  page,
}) => {
  await open(page, byName('redefinir-processando'), viewports[0], 'light')
  await expect(page.locator('form[aria-busy="true"]')).toHaveCount(1)
  await expect(resetButton(page)).toBeDisabled()
  await expect(page.getByLabel('Nova senha')).toBeDisabled()
})

test('sign-out offers both exits, posts only after a click and goes home', async ({
  page,
}) => {
  const api = await open(page, byName('sair-pronto'), viewports[1], 'light')
  expect(api.calls).toEqual([])
  const exit = page.getByRole('button', { name: 'Sair da conta' })
  const everywhere = page.getByRole('button', {
    name: 'Sair de todos os dispositivos',
  })
  await expect(exit).toBeVisible()
  await expect(everywhere).toBeVisible()
  await everywhere.click()
  await expect(page).toHaveURL('/')
  expect(api.calls).toEqual([
    expect.objectContaining({ path: '/api/auth/sessions/revoke', body: {} }),
  ])
})

test('sign-out keyboard order and a failed exit focusing the alert', async ({
  page,
}) => {
  await open(page, byName('sair-erro'), viewports[1], 'light')
  await expect(page.getByRole('alert')).toBeFocused()
  await expect(page.getByRole('alert')).toContainText(
    'Sua sessão pode continuar ativa',
  )
  await expect(
    page.getByRole('button', { name: 'Sair da conta' }),
  ).toBeEnabled()
  await expect(page).toHaveURL(/\/sair$/)
  await page.keyboard.press('Tab')
  await expect(
    page.getByRole('button', { name: 'Sair da conta' }),
  ).toBeFocused()
  await page.keyboard.press('Tab')
  await expect(
    page.getByRole('button', { name: 'Sair de todos os dispositivos' }),
  ).toBeFocused()
})

test('a pending sign-out marks the form busy, disables both exits and announces progress', async ({
  page,
}) => {
  await open(page, byName('sair-processando'), viewports[0], 'light')
  await expect(page.locator('form[aria-busy="true"]')).toHaveCount(1)
  await expect(page.getByRole('button', { name: 'Aguarde…' })).toBeDisabled()
  await expect(page.locator('form').getByRole('status')).toHaveText(
    'Encerrando sua sessão.',
  )
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
  await open(page, byName('entrar-provedores'), viewports[1], 'dark')
  expect(external).toEqual([])
})

test('screenshots of real screen states', async ({ page }, testInfo) => {
  testInfo.setTimeout(300_000)
  const dir =
    process.env.POLISH_AUTH_SHOTS_DIR ??
    (await mkdtemp(join(tmpdir(), 'openfarm-auth-shots-')))
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
