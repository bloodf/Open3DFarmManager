import { mkdir, mkdtemp, readdir, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import AxeBuilder from '@axe-core/playwright'
import { expect, test, type Page, type Route } from '@playwright/test'
import { setPolishTheme } from '../helpers/polish-theme.ts'
import { mockShellApi } from '../helpers/shell-api.ts'

// Isolated UI checks for the account and network settings screens (/conta,
// /rede and /admin/provedores-entrada) on mocked /api routes. No real printer,
// database, auth service or external network is involved: every request that
// is not served by the app itself is either fulfilled here or aborted.
//
// Screenshots are always captured by the last test and saved outside the
// repository (POLISH_SETTINGS_SHOTS_DIR or a temporary directory).
const farm = '00000000-0000-4000-8000-0000000000f1'
const otherFarm = '00000000-0000-4000-8000-0000000000f2'
const agentA = '00000000-0000-4000-8000-0000000000a1'
const agentB = '00000000-0000-4000-8000-0000000000a2'
const agentC = '00000000-0000-4000-8000-0000000000a3'
const longKey = `impressora-com-um-nome-muito-longo-${'x'.repeat(70)}`
const clientId = '1234567890-abcdefghijklmnop.apps.googleusercontent.com'
const redirectUri = `http://127.0.0.1:3000/api/auth/google/callback/${'segmento'.repeat(8)}`

const viewports = [
  { name: '360', width: 360, height: 800 },
  { name: 'desktop', width: 1280, height: 900 },
] as const
const themes = ['light', 'dark'] as const
type Viewport = (typeof viewports)[number]
type Theme = (typeof themes)[number]

type Identities = { available: boolean; linked: boolean; canUnlink: boolean }
type Provider = { enabled: boolean; hasClientSecret: boolean }

const json = (route: Route, body: unknown, status = 200) =>
  route.fulfill({ status, json: body })
const never = () => new Promise<never>(() => undefined)

function identitiesRoute(page: Page, google: Identities) {
  return page.route('**/api/auth/identities', (route) =>
    json(route, { google }),
  )
}

const providerView = (state: Provider) => ({
  id: 'google',
  enabled: state.enabled,
  clientId: state.enabled || state.hasClientSecret ? clientId : '',
  hasClientSecret: state.hasClientSecret,
  redirectUri,
  issuer: 'https://accounts.google.com',
  scopes: ['openid', 'email', 'profile'],
  pkce: true,
  emailVerifiedRequired: true,
})

function providersRoute(page: Page, state: Provider) {
  return page.route('**/api/admin/sign-in-providers', (route) =>
    json(route, { providers: [providerView(state)] }),
  )
}

const now = Date.UTC(2026, 10, 15, 15, 0, 0)
const network = (canManage: boolean) => ({
  canManage,
  connectors: [
    {
      agentId: agentA,
      fingerprint: 'ab'.repeat(16),
      status: 'approved',
      lastSeenAt: Date.now() - 20_000,
      health: { version: '1.4.2', storage: 'healthy' },
    },
    {
      agentId: agentB,
      fingerprint: 'cd'.repeat(16),
      status: 'approved',
      lastSeenAt: null,
      health: null,
    },
    {
      agentId: agentC,
      fingerprint: 'ef'.repeat(16),
      status: 'pending',
      lastSeenAt: null,
      health: null,
    },
  ],
  printers: [
    {
      assignmentId: '00000000-0000-4000-8000-0000000000b1',
      agentId: agentA,
      printerKey: longKey,
      displayName: 'Ender da bancada',
      link: {
        state: 'connected',
        lastSuccessAt: Date.now() - 10_000,
        p50Ms: 42,
        p95Ms: 130,
      },
    },
    {
      assignmentId: '00000000-0000-4000-8000-0000000000b2',
      agentId: agentA,
      printerKey: 'impressora-2',
      displayName: null,
      link: {
        state: 'reconnecting',
        lastSuccessAt: Date.now() - 90_000,
        p50Ms: null,
        p95Ms: null,
      },
    },
  ],
  discovered: [
    {
      agentId: agentA,
      vendor: 'klipper-moonraker',
      model: 'Voron 2.4',
      name: 'voron-descoberta',
      host: '192.168.1.50',
      port: 7125,
      serial: null,
      adopted: false,
      lastSeen: now,
    },
  ],
})

/** Mocks shared by every screen: the shell asks who is signed in and which farms exist. */
async function baseMocks(page: Page, farms: string[] = [farm]) {
  // The offline Docker network makes the browser report no connection; the
  // pages must see the online state the user normally has.
  await page.addInitScript(() =>
    Object.defineProperty(navigator, 'onLine', {
      configurable: true,
      get: () => true,
    }),
  )
  // Anything not mocked below never leaves the test.
  await page.route(
    (url) => !['127.0.0.1', 'localhost'].includes(url.hostname),
    (route) => route.abort(),
  )
  // Unknown app endpoints answer with an empty failure instead of a real call.
  await page.route('**/api/**', (route) => json(route, {}, 404))
  await mockShellApi(page, farm)
  await mockShellApi(page, otherFarm)
  await page.route('**/api/auth/me', (route) =>
    json(route, { accountId: 'conta-sintetica' }),
  )
  await page.route('**/api/farms?*', (route) =>
    json(route, {
      farms: farms.map((farmId) => ({ farmId })),
      nextAfter: null,
    }),
  )
  await page.route(`**/api/farms/${farm}/printers?*`, (route) =>
    json(route, { printers: [], nextAfter: null, canManage: true }),
  )
  await page.route('**/api/browser-devices?*', (route) =>
    json(route, {
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
}

type Scene = {
  id: string
  path: string
  heading: string
  /** Registers the mocks of this state before the page opens. */
  setup: (page: Page) => Promise<unknown>
  /** Waits for the state, driving the page into it when it takes an action. */
  ready: (page: Page) => Promise<unknown>
}

const conta = (
  id: string,
  google: Identities | 'hang' | number,
  ready: Scene['ready'],
  extra: Scene['setup'] = async () => undefined,
  hash = '',
): Scene => ({
  id,
  path: `/conta${hash}`,
  heading: 'Conta',
  async setup(page) {
    if (google === 'hang') await page.route('**/api/auth/identities', never)
    else if (typeof google === 'number')
      await page.route('**/api/auth/identities', (route) =>
        json(route, {}, google),
      )
    else await identitiesRoute(page, google)
    await extra(page)
  },
  ready,
})

const unlinked = { available: true, linked: false, canUnlink: false }
const linked = { available: true, linked: true, canUnlink: true }

async function submitPassword(page: Page) {
  await page.getByLabel('Senha atual').fill('senha-atual-sintetica')
  await page.getByLabel('Nova senha').fill('nova-senha-sintetica-12')
  await page.getByRole('button', { name: 'Alterar senha' }).click()
}

const passwordRoute = (status: number | 'hang') => (page: Page) =>
  page.route('**/api/auth/password', async (route) => {
    if (status === 'hang') return never()
    return json(route, {}, status)
  })

const contaScenes: Scene[] = [
  conta(
    'conta-sem-provedor',
    { available: false, linked: false, canUnlink: false },
    (page) =>
      expect(
        page.getByText('O vínculo com o Google fica indisponível'),
      ).toBeVisible(),
  ),
  conta('conta-carregando', 'hang', (page) =>
    expect(
      page.getByRole('status').filter({ hasText: 'Consultando o vínculo' }),
    ).toBeVisible(),
  ),
  conta('conta-nao-vinculada', unlinked, (page) =>
    expect(
      page.getByRole('button', { name: 'Vincular conta Google' }),
    ).toBeVisible(),
  ),
  conta('conta-vinculada', linked, (page) =>
    expect(
      page.getByRole('button', { name: 'Desvincular Google' }),
    ).toBeVisible(),
  ),
  conta(
    'conta-vinculada-sem-saida',
    { available: true, linked: true, canUnlink: false },
    (page) =>
      expect(
        page.getByText('Defina uma senha ou vincule outro provedor'),
      ).toBeVisible(),
  ),
  conta('conta-sessao-expirada', 401, (page) =>
    expect(page.getByRole('alert')).toContainText(
      'Sua sessão não está disponível',
    ),
  ),
  conta('conta-erro-vinculo', 500, (page) =>
    expect(page.getByRole('alert')).toContainText(
      'Não foi possível consultar o vínculo com o Google.',
    ),
  ),
  conta(
    'conta-google-vinculado',
    linked,
    (page) =>
      expect(
        page.getByRole('status').filter({ hasText: 'Conta Google vinculada.' }),
      ).toBeFocused(),
    undefined,
    '#google=vinculado',
  ),
  conta(
    'conta-google-erro',
    unlinked,
    (page) =>
      expect(page.getByRole('alert')).toContainText(
        'Não foi possível vincular o Google. Tente novamente.',
      ),
    undefined,
    '#erro=google-vinculo',
  ),
  conta(
    'conta-senha-alterada',
    unlinked,
    async (page) => {
      await submitPassword(page)
      await expect(
        page.getByRole('status').filter({ hasText: 'Senha alterada.' }),
      ).toBeVisible()
    },
    passwordRoute(200),
  ),
  conta(
    'conta-senha-recusada',
    unlinked,
    async (page) => {
      await submitPassword(page)
      await expect(page.getByRole('alert')).toContainText(
        'Confira a senha atual e tente novamente.',
      )
    },
    passwordRoute(401),
  ),
  conta(
    'conta-senha-salvando',
    unlinked,
    async (page) => {
      await submitPassword(page)
      await expect(
        page.getByRole('button', { name: 'Alterando…' }),
      ).toBeDisabled()
    },
    passwordRoute('hang'),
  ),
]

const rede = (
  id: string,
  setup: Scene['setup'],
  ready: Scene['ready'],
): Scene => ({
  id,
  path: '/rede',
  heading: 'Rede da farm',
  setup,
  ready,
})

const networkRoute =
  (handler: (route: Route) => Promise<unknown> | unknown) => (page: Page) =>
    page.route(`**/api/farms/${farm}/network`, handler)

const redeScenes: Scene[] = [
  rede(
    'rede-carregando-farms',
    (page) => page.route('**/api/auth/me', never),
    (page) =>
      expect(
        page.getByRole('status').filter({ hasText: 'Carregando suas farms' }),
      ).toBeVisible(),
  ),
  rede(
    'rede-entrar',
    (page) => page.route('**/api/auth/me', (route) => json(route, {}, 401)),
    (page) =>
      expect(page.getByRole('region', { name: 'Acesso à farm' })).toBeVisible(),
  ),
  rede(
    'rede-erro-farms',
    (page) => page.route('**/api/auth/me', (route) => json(route, {}, 503)),
    (page) =>
      expect(page.getByRole('alert')).toContainText(
        'Não foi possível confirmar seus dados.',
      ),
  ),
  rede(
    'rede-sem-farms',
    (page) =>
      page.route('**/api/farms?*', (route) =>
        json(route, { farms: [], nextAfter: null }),
      ),
    (page) =>
      expect(
        page.getByRole('heading', { name: 'Nenhuma farm disponível' }),
      ).toBeVisible(),
  ),
  rede(
    'rede-escolher-farm',
    (page) =>
      page.route('**/api/farms?*', (route) =>
        json(route, {
          farms: [{ farmId: farm }, { farmId: otherFarm }],
          nextAfter: null,
        }),
      ),
    (page) =>
      expect(
        page.getByRole('heading', { name: 'Nenhuma farm selecionada' }),
      ).toBeVisible(),
  ),
  rede('rede-carregando', networkRoute(never), (page) =>
    expect(
      page.getByRole('status').filter({ hasText: 'Carregando a rede' }),
    ).toBeVisible(),
  ),
  rede(
    'rede-indisponivel',
    networkRoute((route) => json(route, {}, 500)),
    (page) =>
      expect(
        page.getByRole('heading', { name: 'Rede indisponível' }),
      ).toBeVisible(),
  ),
  rede(
    'rede-com-connectors',
    networkRoute((route) => json(route, network(true))),
    async (page) => {
      await expect(
        page.getByRole('button', { name: 'Procurar agora' }),
      ).toBeVisible()
      await expect(page.getByText('Ender da bancada').first()).toBeVisible()
    },
  ),
  rede(
    'rede-somente-leitura',
    networkRoute((route) => json(route, network(false))),
    async (page) => {
      await expect(page.getByText('Ender da bancada').first()).toBeVisible()
      await expect(
        page.getByRole('button', { name: 'Procurar agora' }),
      ).toHaveCount(0)
    },
  ),
  rede(
    'rede-vazia',
    networkRoute((route) =>
      json(route, {
        canManage: true,
        connectors: [],
        printers: [],
        discovered: [],
      }),
    ),
    (page) => expect(page.getByText('Mostrando 0 de 0 itens.')).toBeVisible(),
  ),
]

const provedores = (
  id: string,
  setup: Scene['setup'],
  ready: Scene['ready'],
): Scene => ({
  id,
  path: '/admin/provedores-entrada',
  heading: 'Provedores de entrada',
  setup,
  ready,
})

const saveRoute =
  (handler: (route: Route) => Promise<unknown> | unknown) => (page: Page) =>
    page.route('**/api/admin/sign-in-providers/google', handler)

const configured = { enabled: true, hasClientSecret: true }
const blank = { enabled: false, hasClientSecret: false }

async function save(page: Page) {
  await page.getByLabel('Client ID').fill(`  ${clientId}  `)
  await page.getByRole('button', { name: 'Salvar Google' }).click()
}

const provedoresScenes: Scene[] = [
  provedores(
    'provedores-carregando',
    (page) => page.route('**/api/admin/sign-in-providers', never),
    (page) =>
      expect(
        page
          .getByRole('status')
          .filter({ hasText: 'Carregando provedores de entrada' }),
      ).toBeVisible(),
  ),
  provedores(
    'provedores-sem-permissao',
    (page) =>
      page.route('**/api/admin/sign-in-providers', (route) =>
        json(route, {}, 403),
      ),
    (page) =>
      expect(page.getByRole('alert')).toContainText(
        'Você não tem permissão para abrir',
      ),
  ),
  provedores(
    'provedores-offline',
    async (page) => {
      await page.addInitScript(() =>
        Object.defineProperty(navigator, 'onLine', {
          configurable: true,
          get: () => false,
        }),
      )
      await page.route('**/api/admin/sign-in-providers', (route) =>
        route.abort(),
      )
    },
    (page) =>
      expect(page.getByRole('main').getByRole('status')).toContainText(
        'Sem conexão com a internet',
      ),
  ),
  provedores(
    'provedores-erro',
    (page) =>
      page.route('**/api/admin/sign-in-providers', (route) =>
        json(route, {}, 500),
      ),
    (page) =>
      expect(page.getByRole('alert')).toContainText(
        'Não foi possível carregar os provedores de entrada.',
      ),
  ),
  provedores(
    'provedores-configurado',
    (page) => providersRoute(page, configured),
    (page) => expect(page.getByLabel('Client ID')).toHaveValue(clientId),
  ),
  provedores(
    'provedores-novo',
    (page) => providersRoute(page, blank),
    (page) =>
      expect(
        page.getByPlaceholder('Cole o segredo do projeto Google Cloud'),
      ).toBeVisible(),
  ),
  provedores(
    'provedores-salvando',
    async (page) => {
      await providersRoute(page, blank)
      await saveRoute(never)(page)
    },
    async (page) => {
      await save(page)
      await expect(
        page.getByRole('button', { name: 'Salvando…' }),
      ).toBeDisabled()
    },
  ),
  provedores(
    'provedores-salvo',
    async (page) => {
      await providersRoute(page, blank)
      await saveRoute((route) =>
        json(route, { provider: providerView(configured) }),
      )(page)
    },
    async (page) => {
      await save(page)
      await expect(
        page
          .getByRole('status')
          .filter({ hasText: 'Configuração do Google salva.' }),
      ).toBeFocused()
    },
  ),
  provedores(
    'provedores-erro-ao-salvar',
    async (page) => {
      await providersRoute(page, blank)
      await saveRoute((route) => json(route, {}, 400))(page)
    },
    async (page) => {
      await save(page)
      await expect(page.getByRole('alert')).toContainText(
        'Confira o client ID, o segredo',
      )
    },
  ),
]

const scenes = [...contaScenes, ...redeScenes, ...provedoresScenes]

async function open(
  page: Page,
  scene: Scene,
  viewport: Viewport,
  theme: Theme,
  lenient = false,
) {
  await page.unrouteAll({ behavior: 'ignoreErrors' })
  await page.setViewportSize(viewport)
  await setPolishTheme(page, theme)
  await baseMocks(
    page,
    scene.id === 'rede-escolher-farm' ? [farm, otherFarm] : [farm],
  )
  await scene.setup(page)
  // A fresh document, so a hash-only change still runs the page's mount.
  await page.goto('about:blank')
  await page.goto(scene.path)
  await page
    .getByRole('heading', { level: 1, name: scene.heading, exact: true })
    .waitFor()
  // The pre-polish baseline is captured with the same steps but cannot show
  // text that only the polished pages have: it is photographed as it is.
  if (lenient) {
    const waiting = scene.ready(page)
    waiting.catch(() => undefined)
    await Promise.race([
      waiting.catch(() => undefined),
      new Promise((done) => setTimeout(done, 2500)),
    ])
  } else await scene.ready(page)
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

/** Elements that stick out of the viewport, so an overflow names its cause. */
const overflowing = (page: Page) =>
  page.evaluate(() =>
    [...document.querySelectorAll('body *')]
      // What sits inside a scroll region may be wider than the screen.
      .filter((node) => {
        for (let up = node.parentElement; up; up = up.parentElement)
          if (/auto|scroll|hidden/.test(getComputedStyle(up).overflowX))
            return false
        return true
      })
      .filter(
        (node) => node.getBoundingClientRect().right > window.innerWidth + 1,
      )
      .slice(0, 8)
      .map(
        (node) =>
          `${node.tagName.toLowerCase()}.${String(node.className).slice(0, 40)} ${Math.round(node.getBoundingClientRect().right)}`,
      ),
  )
const fits = (page: Page) =>
  page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)

/** Console errors and uncaught exceptions; deliberate 4xx/5xx mocks only log a resource line. */
function watchConsole(page: Page) {
  const problems: string[] = []
  page.on('console', (message) => {
    if (
      message.type() === 'error' &&
      !message.text().startsWith('Failed to load resource')
    )
      problems.push(message.text())
  })
  page.on('pageerror', (error) => problems.push(error.message))
  return problems
}

const sceneOf = (id: string) => scenes.find((scene) => scene.id === id)!

for (const scene of scenes)
  for (const viewport of viewports)
    for (const theme of themes)
      test(`${scene.id} is accessible, quiet and fits at ${viewport.name} in the ${theme} theme`, async ({
        page,
      }) => {
        const problems = watchConsole(page)
        await open(page, scene, viewport, theme)
        expect(await overflowing(page)).toEqual([])
        expect(await fits(page)).toBe(true)
        expect(await violations(page)).toEqual([])
        expect(problems).toEqual([])
      })

for (const [name, scene] of [
  ['conta', sceneOf('conta-nao-vinculada')],
  ['rede', sceneOf('rede-com-connectors')],
  ['provedores', sceneOf('provedores-configurado')],
] as const)
  test(`${name} has one main, one h1 and headings in order`, async ({
    page,
  }) => {
    await open(page, scene, viewports[1], 'light')
    await expect(page.getByRole('main')).toHaveCount(1)
    await expect(page.getByRole('heading', { level: 1 })).toHaveCount(1)
    const levels = await page
      .locator('main h1, main h2, main h3, main h4')
      .evaluateAll((nodes) => nodes.map((node) => Number(node.tagName[1])))
    expect(levels.length).toBeGreaterThan(1)
    expect(levels[0]).toBe(1)
    for (const [index, level] of levels.entries())
      if (index > 0) expect(level - levels[index - 1]!).toBeLessThanOrEqual(1)
  })

test('conta: fields are labelled, hinted and typed for password managers', async ({
  page,
}) => {
  await open(page, sceneOf('conta-nao-vinculada'), viewports[0], 'light')
  const current = page.getByLabel('Senha atual')
  await expect(current).toHaveAttribute('type', 'password')
  await expect(current).toHaveAttribute('autocomplete', 'current-password')
  await expect(current).toHaveAttribute('required', '')
  const next = page.getByLabel('Nova senha')
  await expect(next).toHaveAttribute('autocomplete', 'new-password')
  await expect(next).toHaveAttribute('minlength', '12')
  await expect(next).toHaveAccessibleDescription('Use 12 caracteres ou mais.')
})

test('conta: keyboard reaches the Google action, both fields and the submit with a visible focus ring', async ({
  page,
}) => {
  await open(page, sceneOf('conta-nao-vinculada'), viewports[1], 'light')
  await page.getByRole('button', { name: 'Vincular conta Google' }).focus()
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
  expect(seen[0]).toBe('Vincular conta Google')
  expect(seen[3]).toBe('Alterar senha')
})

test('conta: the password change keeps its request, clears both fields and moves focus to the result', async ({
  page,
}) => {
  const bodies: unknown[] = []
  await open(
    page,
    {
      ...sceneOf('conta-nao-vinculada'),
      async setup(target) {
        await sceneOf('conta-nao-vinculada').setup(target)
        await target.route('**/api/auth/password', (route) => {
          bodies.push({
            method: route.request().method(),
            body: route.request().postDataJSON(),
          })
          return json(route, {})
        })
      },
    },
    viewports[0],
    'light',
  )
  await submitPassword(page)
  const status = page
    .getByRole('status')
    .filter({ hasText: 'Senha alterada. As outras sessões foram encerradas.' })
  await expect(status).toBeFocused()
  expect(bodies).toEqual([
    {
      method: 'POST',
      body: {
        currentPassword: 'senha-atual-sintetica',
        newPassword: 'nova-senha-sintetica-12',
      },
    },
  ])
  await expect(page.getByLabel('Senha atual')).toHaveValue('')
  await expect(page.getByLabel('Nova senha')).toHaveValue('')
})

test('conta: a refused password announces an alert and a short one is explained', async ({
  page,
}) => {
  await open(page, sceneOf('conta-senha-recusada'), viewports[0], 'light')
  await expect(page.getByRole('alert')).toBeFocused()
  await page.unroute('**/api/auth/password')
  await page.route('**/api/auth/password', (route) => json(route, {}, 400))
  await submitPassword(page)
  await expect(page.getByRole('alert')).toHaveText(
    'Use uma nova senha com 12 caracteres ou mais.',
  )
})

test('conta: linking Google sends the browser to the same start route', async ({
  page,
}) => {
  await open(page, sceneOf('conta-nao-vinculada'), viewports[1], 'light')
  await page.route('**/api/auth/google/link/start', (route) =>
    route.fulfill({ contentType: 'text/html', body: '<title>Google</title>' }),
  )
  const request = page.waitForRequest((item) =>
    item.url().endsWith('/api/auth/google/link/start'),
  )
  await page.getByRole('button', { name: 'Vincular conta Google' }).click()
  await request
})

test('conta: unlinking Google reports success, and a refusal is an alert', async ({
  page,
}) => {
  let done = false
  await open(
    page,
    {
      ...sceneOf('conta-vinculada'),
      async setup(target) {
        await target.route('**/api/auth/identities', (route) =>
          json(route, { google: done ? unlinked : linked }),
        )
        await target.route('**/api/auth/identities/google', (route) => {
          done = true
          return json(route, {})
        })
      },
    },
    viewports[0],
    'light',
  )
  await page.getByRole('button', { name: 'Desvincular Google' }).click()
  await expect(
    page.getByRole('status').filter({ hasText: 'Conta Google desvinculada.' }),
  ).toBeFocused()
  await expect(
    page.getByRole('button', { name: 'Vincular conta Google' }),
  ).toBeVisible()

  done = false
  await page.route('**/api/auth/identities/google', (route) =>
    json(route, {}, 409),
  )
  await page.reload()
  await page.getByRole('button', { name: 'Desvincular Google' }).click()
  await expect(page.getByRole('alert')).toBeFocused()
  await expect(page.getByRole('alert')).toContainText(
    'Mantenha outra forma de entrada antes de desvincular o Google.',
  )
})

test('conta: an expired session links to sign in and retry asks again', async ({
  page,
}) => {
  await open(page, sceneOf('conta-sessao-expirada'), viewports[0], 'light')
  await expect(
    page.getByRole('link', { name: 'Entrar na conta' }),
  ).toHaveAttribute('href', '/entrar')
  await page.route('**/api/auth/identities', (route) =>
    json(route, { google: unlinked }),
  )
  await page.getByRole('button', { name: 'Tentar novamente' }).click()
  await expect(
    page.getByRole('button', { name: 'Vincular conta Google' }),
  ).toBeVisible()
  await expect(page.getByRole('alert').filter({ hasText: /\S/ })).toHaveCount(0)
})

test('conta: loading marks the Google section busy and announces once', async ({
  page,
}) => {
  await open(page, sceneOf('conta-carregando'), viewports[0], 'light')
  await expect(
    page.getByRole('region', { name: 'Conta Google' }),
  ).toHaveAttribute('aria-busy', 'true')
  await expect(page.locator('.skeleton')).toHaveCount(2)
})

test('rede: heading takes focus, the scan names its Connector and the map keeps its table', async ({
  page,
}) => {
  await open(page, sceneOf('rede-com-connectors'), viewports[1], 'light')
  await expect(
    page.getByRole('heading', { level: 1, name: 'Rede da farm' }),
  ).toBeFocused()
  const select = page.getByLabel('Connector para a busca')
  await expect(select).toHaveAttribute('id', 'rede-scan-connector')
  await expect(select.locator('option')).toHaveCount(2)
  await expect(
    page.getByRole('button', { name: 'Procurar agora', exact: true }),
  ).toBeEnabled()
  await expect(page.getByRole('button', { name: 'Tabela' })).toBeVisible()
})

test('rede: a failed network read is an alert with a retry that recovers', async ({
  page,
}) => {
  await open(page, sceneOf('rede-indisponivel'), viewports[0], 'light')
  await expect(page.getByRole('alert')).toContainText(
    'Não foi possível atualizar a rede da farm. Tente novamente.',
  )
  await page.route(`**/api/farms/${farm}/network`, (route) =>
    json(route, network(true)),
  )
  await page.getByRole('button', { name: 'Tentar novamente' }).click()
  await expect(page.getByText('Ender da bancada').first()).toBeVisible()
  await expect(
    page.getByRole('heading', { name: 'Rede indisponível' }),
  ).toHaveCount(0)
})

test('rede: sign-in and empty states offer a way out', async ({ page }) => {
  await open(page, sceneOf('rede-entrar'), viewports[0], 'light')
  await expect(
    page.getByRole('link', { name: 'Entrar', exact: true }),
  ).toHaveAttribute('href', '/entrar')
  await open(page, sceneOf('rede-sem-farms'), viewports[0], 'light')
  await expect(
    page.getByRole('link', { name: 'Entrar com outra conta' }),
  ).toHaveAttribute('href', '/entrar')
})

test('rede: loading marks the region busy and announces it', async ({
  page,
}) => {
  await open(page, sceneOf('rede-carregando'), viewports[0], 'light')
  await expect(page.locator('div[aria-busy="true"]')).toBeVisible()
  await expect(page.locator('.skeleton')).toHaveCount(3)
})

test('provedores: saving trims the client ID, sends the secret only when typed and clears it', async ({
  page,
}) => {
  const bodies: unknown[] = []
  await open(
    page,
    {
      ...sceneOf('provedores-novo'),
      async setup(target) {
        await providersRoute(target, blank)
        await saveRoute((route) => {
          bodies.push({
            method: route.request().method(),
            body: route.request().postDataJSON(),
          })
          return json(route, { provider: providerView(configured) })
        })(target)
      },
    },
    viewports[0],
    'light',
  )
  await page.getByLabel('Ativar Entrar com Google').check()
  await save(page)
  await expect(
    page
      .getByRole('status')
      .filter({ hasText: 'Configuração do Google salva.' }),
  ).toBeFocused()
  await page.getByLabel('Client secret').fill('segredo-sintetico')
  await page.getByRole('button', { name: 'Salvar Google' }).click()
  await expect(page.getByLabel('Client secret')).toHaveValue('')
  await expect.poll(() => bodies.length).toBe(2)
  expect(bodies).toEqual([
    { method: 'PUT', body: { enabled: true, clientId } },
    {
      method: 'PUT',
      body: { enabled: true, clientId, clientSecret: 'segredo-sintetico' },
    },
  ])
})

test('provedores: fields are labelled and the secret hint describes the field', async ({
  page,
}) => {
  await open(page, sceneOf('provedores-configurado'), viewports[1], 'light')
  const secret = page.getByLabel('Client secret')
  await expect(secret).toHaveAttribute('type', 'password')
  await expect(secret).toHaveAttribute(
    'placeholder',
    'Segredo já salvo (deixe em branco para manter)',
  )
  await expect(secret).toHaveAccessibleDescription(
    /nunca é devolvido ao navegador/,
  )
  await expect(page.getByLabel('Ativar Entrar com Google')).toBeChecked()
  await expect(page.getByText(redirectUri)).toBeVisible()
})

test('provedores: keyboard reaches the toggle, both fields and the submit with a visible focus ring', async ({
  page,
}) => {
  await open(page, sceneOf('provedores-configurado'), viewports[1], 'light')
  await page.getByLabel('Ativar Entrar com Google').focus()
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
  expect(seen.slice(1)).toEqual([
    expect.stringMatching(/./),
    expect.stringMatching(/./),
    'Salvar Google',
  ])
})

test('provedores: a load failure offers a retry that recovers', async ({
  page,
}) => {
  await open(page, sceneOf('provedores-erro'), viewports[0], 'light')
  await expect(page.getByRole('alert')).toBeVisible()
  await providersRoute(page, configured)
  await page.getByRole('button', { name: 'Tentar novamente' }).click()
  await expect(page.getByLabel('Client ID')).toHaveValue(clientId)
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
  for (const id of [
    'conta-vinculada',
    'rede-com-connectors',
    'provedores-configurado',
  ])
    await open(page, sceneOf(id), viewports[1], 'dark')
  expect(external).toEqual([])
})

test('screenshots of real screen states', async ({ page }, testInfo) => {
  testInfo.setTimeout(900_000)
  const dir =
    process.env.POLISH_SETTINGS_SHOTS_DIR ??
    (await mkdtemp(join(tmpdir(), 'openfarm-settings-shots-')))
  await mkdir(dir, { recursive: true })
  const capture = process.env.POLISH_CAPTURE === '1'
  const written: string[] = []
  for (const scene of scenes)
    for (const viewport of viewports)
      for (const theme of themes) {
        await page.unrouteAll({ behavior: 'ignoreErrors' })
        await open(page, scene, viewport, theme, capture)
        const path = join(dir, `${scene.id}-${viewport.name}-${theme}.png`)
        await page.screenshot({ path, fullPage: true })
        if ((await stat(path)).size <= 0) throw new Error(`Empty ${path}`)
        written.push(path)
      }
  expect(written).toHaveLength(scenes.length * viewports.length * themes.length)
  expect((await readdir(dir)).filter((name) => name.endsWith('.png'))).toEqual(
    expect.arrayContaining(written.map((path) => path.split('/').pop()!)),
  )
})
