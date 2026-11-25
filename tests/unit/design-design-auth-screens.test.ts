import { mkdir } from 'node:fs/promises'
import AxeBuilder from '@axe-core/playwright'
import type { Page } from '@playwright/test'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { themeStyles } from '../../apps/farm/app/utils/pre-hydration.ts'
import {
  createPageHarness,
  reply,
  type PageHarness,
  type Routes,
} from '../helpers/page-harness'

// Sign-in, account and pairing screens, mounted in the shell against synthetic
// replies. DESIGN_SCREENSHOTS=1 also writes the design comparison captures
// (DESIGN_PHASE=before|after).
const capture = process.env.DESIGN_SCREENSHOTS === '1'
const phase = process.env.DESIGN_PHASE ?? 'after'
const token = 'A'.repeat(43)

const anonymous: Routes = { 'GET /api/auth/me': reply({}, 401) }
const signedIn: Routes = {
  'GET /api/auth/me': reply({ accountId: 'conta-sintetica' }),
  'GET /api/farms': reply({
    farms: [{ farmId: 'farm-demo' }],
    nextAfter: null,
  }),
}
const providers: Routes = {
  ...anonymous,
  'GET /api/auth/google': reply({ enabled: true }),
  'GET /api/auth/oidc': reply({ enabled: true }),
}
const pairing: Routes = {
  ...signedIn,
  'GET /api/connector-pairing/capability': reply({ enabled: true }),
}

const screens: {
  name: string
  heading: string
  /** Visible once the page has finished loading. */
  ready: string
  routes: Routes
}[] = [
  {
    name: 'entrar',
    heading: 'Entrar',
    ready: 'Vincular convite e entrar',
    routes: providers,
  },
  {
    name: 'criar-conta',
    heading: 'Criar conta',
    ready: 'Já tenho conta',
    routes: anonymous,
  },
  {
    name: 'redefinir-senha',
    heading: 'Redefinir senha',
    ready: 'Voltar para entrar',
    routes: anonymous,
  },
  {
    name: 'primeiro-acesso',
    heading: 'Primeiro acesso',
    ready: 'Criar conta de proprietário',
    routes: anonymous,
  },
  {
    name: 'parear',
    heading: 'Aprovar Connector',
    ready: 'Dados do Connector',
    routes: pairing,
  },
  {
    name: 'sair',
    heading: 'Sair da conta',
    ready: 'Sair de todos os dispositivos',
    routes: signedIn,
  },
  {
    name: 'index',
    heading: 'Sua farm de impressão, em um só lugar.',
    ready: 'Recursos ainda indisponíveis',
    routes: signedIn,
  },
]

const sizes = [
  ['desktop', 1440, 900],
  ['mobile', 390, 844],
] as const
const themes = ['light', 'dark'] as const

let harness: PageHarness
beforeAll(async () => {
  harness = await createPageHarness()
}, 120_000)
afterAll(async () => {
  await harness?.close()
})

async function open(
  name: string,
  routes: Routes,
  [width, height]: readonly [number, number],
  theme: (typeof themes)[number],
) {
  const view = await harness.open(name, routes, {
    layout: true,
    width,
    init: `
      Object.defineProperty(navigator, 'onLine', { get: () => true })
      document.documentElement.dataset.theme = ${JSON.stringify(theme)}
    `,
  })
  await view.page.setViewportSize({ width, height })
  await view.page.emulateMedia({ reducedMotion: 'reduce', colorScheme: theme })
  await view.page.addStyleTag({ content: themeStyles })
  return view
}

const violations = async (page: Page) =>
  (await new AxeBuilder({ page }).include('#conteudo').analyze()).violations
const fitsWidth = (page: Page) =>
  page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)

describe('auth screens', () => {
  for (const screen of screens)
    it(`renders ${screen.name} without axe violations`, async () => {
      for (const [size, width, height] of sizes)
        for (const theme of themes) {
          const view = await open(
            screen.name,
            screen.routes,
            [width, height],
            theme,
          )
          try {
            const { page } = view
            await page.getByText(screen.ready).first().waitFor()
            expect(await page.locator('#conteudo h1').textContent()).toContain(
              screen.heading,
            )
            expect(await fitsWidth(page)).toBe(true)
            expect(await violations(page)).toEqual([])
            if (capture) {
              await mkdir('docs/fullfarmmanager/design', { recursive: true })
              // The home page moves focus to its title; keep captures neutral.
              await page.evaluate(() =>
                (document.activeElement as HTMLElement | null)?.blur(),
              )
              await page.screenshot({
                path: `docs/fullfarmmanager/design/auth-${screen.name}-${phase}-${size}-${theme}.png`,
                fullPage: true,
              })
            }
          } finally {
            await view.close()
          }
        }
    }, 120_000)

  it('keeps error, success and focus states accessible in both themes', async () => {
    for (const theme of themes) {
      const login = await open(
        'entrar',
        { ...anonymous, 'POST /api/auth/login': reply({}, 401) },
        [390, 844],
        theme,
      )
      try {
        const { page } = login
        await page.locator('#username').fill('ana_01')
        await page.locator('#password').fill('senha-muito-longa-123')
        // Keyboard submit, so the focus ring on the moved focus is expected.
        await page.locator('#password').press('Enter')
        const alert = page
          .getByRole('alert')
          .filter({ hasText: 'Usuário ou senha inválidos' })
        await alert.waitFor()
        expect(
          await alert.evaluate((node) => node === document.activeElement),
        ).toBe(true)
        expect(
          await alert.evaluate((node) => getComputedStyle(node).outlineStyle),
        ).not.toBe('none')
        expect(await violations(page)).toEqual([])
      } finally {
        await login.close()
      }

      const account = await open(
        'criar-conta',
        { ...anonymous, 'POST /api/auth/register': reply({}, 400) },
        [390, 844],
        theme,
      )
      try {
        const { page } = account
        await page.locator('#account-token').fill(token)
        await page.locator('#account-username').fill('ana_01')
        await page.locator('#account-password').fill('senha-muito-longa-123')
        await page.getByRole('button', { name: 'Criar conta' }).click()
        await page.getByText('Não foi possível criar a conta.').waitFor()
        expect(await fitsWidth(page)).toBe(true)
        expect(await violations(page)).toEqual([])
      } finally {
        await account.close()
      }

      const reset = await open(
        'redefinir-senha',
        {
          ...anonymous,
          'POST /api/auth/password-reset-complete': reply({
            message: 'Senha redefinida. Entre com a nova senha.',
          }),
        },
        [390, 844],
        theme,
      )
      try {
        const { page } = reset
        await page.locator('#reset-username').fill('ana_01')
        await page.locator('#reset-token').fill(token)
        await page.locator('#reset-password').fill('senha-muito-longa-123')
        await page.getByRole('button', { name: 'Redefinir senha' }).click()
        await page.getByText('Senha redefinida.').waitFor()
        expect(await violations(page)).toEqual([])
      } finally {
        await reset.close()
      }

      const unavailable = await open(
        'parear',
        {
          ...signedIn,
          'GET /api/connector-pairing/capability': reply({}, 503),
        },
        [390, 844],
        theme,
      )
      try {
        const { page } = unavailable
        await page.getByText('Pareamento indisponível.').waitFor()
        expect(await fitsWidth(page)).toBe(true)
        expect(await violations(page)).toEqual([])
      } finally {
        await unavailable.close()
      }
    }
  }, 120_000)

  it('keeps 44px targets and reflows at 320px on every screen', async () => {
    for (const screen of screens) {
      const view = await open(screen.name, screen.routes, [390, 844], 'light')
      try {
        await view.page.getByText(screen.ready).first().waitFor()
        const small = await view.page.evaluate(() =>
          [
            ...document.querySelectorAll<HTMLElement>(
              '#conteudo button, #conteudo input:not([type=checkbox]), #conteudo select, #conteudo nav a, #conteudo .links a, #conteudo .provider-link',
            ),
          ]
            .filter((node) => node.getBoundingClientRect().height < 43.5)
            .map((node) => node.id || node.textContent?.trim()),
        )
        expect(small, screen.name).toEqual([])
        // Reflow at the narrowest width, as when zooming the page.
        await view.page.setViewportSize({ width: 320, height: 640 })
        expect(await fitsWidth(view.page), screen.name).toBe(true)
      } finally {
        await view.close()
      }
    }
  }, 120_000)
})
