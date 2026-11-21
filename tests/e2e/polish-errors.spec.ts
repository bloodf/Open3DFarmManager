import { mkdir, mkdtemp, readdir, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import AxeBuilder from '@axe-core/playwright'
import { expect, test, type Page } from '@playwright/test'

// Isolated UI checks for the app error page (404, 403, 500) on mocked /api
// routes. No real printer, database, auth service or external network is
// involved. Screenshots are always captured by the last test and saved outside
// the repository (POLISH_ERRORS_SHOTS_DIR or a temporary directory).
//
// In capture mode (POLISH_CAPTURE=1, used for the pre-polish baseline build)
// the screen is not asserted, only photographed.
const capture = process.env.POLISH_CAPTURE === '1'

const viewports = [
  { name: '360', width: 360, height: 800 },
  { name: 'desktop', width: 1280, height: 900 },
] as const
const themes = ['light', 'dark'] as const
const scenarios = ['not-found', 'forbidden', 'server'] as const
type Viewport = (typeof viewports)[number]
type Theme = (typeof themes)[number]
type Scenario = (typeof scenarios)[number]

const copy = {
  'not-found': { code: 404, title: 'Página não encontrada' },
  forbidden: { code: 403, title: 'Acesso não permitido' },
  server: { code: 500, title: 'Algo deu errado' },
} as const

const issues = new WeakMap<Page, string[]>()

async function mockApi(page: Page) {
  // Anything not mocked below never leaves the test.
  await page.route(
    (url) => !['127.0.0.1', 'localhost'].includes(url.hostname),
    (route) => route.abort(),
  )
  await page.route('**/api/**', (route) =>
    route.fulfill({ status: 404, json: {} }),
  )
  await page.route('**/favicon.ico', (route) => route.fulfill({ status: 204 }))
  await page.route('**/api/auth/me', (route) =>
    route.fulfill({ json: { accountId: 'conta-sintetica' } }),
  )
  await page.route('**/api/farms?*', (route) =>
    route.fulfill({ json: { farms: [], nextAfter: null } }),
  )
}

/** Raises the app error the way a failing page does (showError). */
async function raise(page: Page, statusCode: number) {
  await page.waitForFunction(() => window.useNuxtApp?.().isHydrating === false)
  await page.evaluate((code) => {
    const app = window.useNuxtApp!()
    app.payload.error = {
      __nuxt_error: true,
      statusCode: code,
      statusMessage: 'mensagem interna que não deve aparecer',
      message: 'mensagem interna que não deve aparecer',
    }
  }, statusCode)
}

async function open(
  page: Page,
  scenario: Scenario,
  viewport: Viewport,
  theme: Theme,
) {
  const logged: string[] = []
  issues.set(page, logged)
  page.on('console', (message) => {
    if (message.type() === 'error') logged.push(message.text())
  })
  page.on('pageerror', (error) => logged.push(error.message))
  await page.setViewportSize(viewport)
  await page.emulateMedia({ colorScheme: theme, reducedMotion: 'reduce' })
  await mockApi(page)
  if (scenario === 'not-found') await page.goto('/pagina-que-nao-existe')
  else {
    await page.goto('/')
    await raise(page, copy[scenario].code)
  }
  if (capture) {
    await page.waitForFunction(() => !!window.useNuxtApp?.().payload.error)
    await page.evaluate(() => document.fonts.ready)
    return
  }
  await page
    .getByRole('heading', { level: 1, name: copy[scenario].title })
    .waitFor()
}

const violations = async (page: Page) =>
  (
    await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
      .analyze()
  ).violations.map((violation) => ({
    id: violation.id,
    impact: violation.impact,
    nodes: violation.nodes.map((node) => ({
      target: node.target,
      failureSummary: node.failureSummary,
    })),
  }))

const fits = (page: Page) =>
  page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)

test.describe('error page', () => {
  test.skip(capture, 'capture mode only photographs the screen')

  for (const scenario of scenarios)
    for (const viewport of viewports)
      for (const theme of themes)
        test(`${scenario} state is accessible and fits at ${viewport.name} in the ${theme} theme`, async ({
          page,
        }) => {
          await open(page, scenario, viewport, theme)
          expect(await fits(page)).toBe(true)
          expect(await violations(page)).toEqual([])
          expect(issues.get(page)).toEqual([])
        })

  for (const scenario of scenarios)
    test(`${scenario} state has one main, one h1, the code and fixed copy`, async ({
      page,
    }) => {
      await open(page, scenario, viewports[1], 'light')
      await expect(page.getByRole('main')).toHaveCount(1)
      await expect(page.getByRole('heading', { level: 1 })).toHaveCount(1)
      await expect(page.getByRole('main')).toContainText(
        `Erro ${copy[scenario].code}`,
      )
      await expect(page).toHaveTitle(
        `${copy[scenario].title} · Open3DFarmManager`,
      )
      // The server's own message never reaches the reader.
      await expect(page.locator('body')).not.toContainText('mensagem interna')
    })

  test('focus lands on the heading and tab order follows the actions', async ({
    page,
  }) => {
    await open(page, 'server', viewports[1], 'light')
    const heading = page.getByRole('heading', { level: 1 })
    await expect(heading).toBeFocused()
    await heading.press('Tab')
    // Skip link and toolbar come first in the shell; the page actions follow.
    const seen: string[] = []
    const main = page.getByRole('main')
    for (let step = 0; step < 40 && seen.length < 3; step++) {
      const inside = await main.evaluate((node) =>
        node.contains(document.activeElement),
      )
      if (inside) {
        const focus = await page.evaluate(() => {
          const element = document.activeElement as HTMLElement
          const style = getComputedStyle(element)
          return {
            label: element.textContent?.trim() ?? '',
            ring: style.outlineStyle !== 'none' && style.outlineWidth !== '0px',
          }
        })
        expect(focus.ring, `${focus.label} has no focus ring`).toBe(true)
        seen.push(focus.label)
      }
      await page.keyboard.press('Tab')
    }
    expect(seen).toEqual(['Tentar novamente', 'Voltar ao início', 'Minha farm'])
  })

  test('404 offers a way back that clears the error and opens the home page', async ({
    page,
  }) => {
    await open(page, 'not-found', viewports[0], 'light')
    await expect(
      page.getByRole('link', { name: 'Entrar na conta' }),
    ).toHaveCount(0)
    await expect(
      page.getByRole('button', { name: 'Tentar novamente' }),
    ).toHaveCount(0)
    await page.getByRole('link', { name: 'Voltar ao início' }).click()
    await expect(page).toHaveURL(/\/$/)
    await expect(
      page.getByRole('heading', {
        level: 1,
        name: 'Sua farm de impressão, em um só lugar.',
      }),
    ).toBeVisible()
  })

  test('403 points to sign in and the link works', async ({ page }) => {
    await open(page, 'forbidden', viewports[0], 'dark')
    await expect(
      page.getByRole('button', { name: 'Tentar novamente' }),
    ).toHaveCount(0)
    await page.getByRole('link', { name: 'Entrar na conta' }).click()
    await expect(page).toHaveURL(/\/entrar$/)
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible()
  })

  test('500 offers retry, which clears the error on the same route', async ({
    page,
  }) => {
    await open(page, 'server', viewports[0], 'light')
    await page.getByRole('button', { name: 'Tentar novamente' }).click()
    await expect(
      page.getByRole('heading', { level: 1, name: 'Algo deu errado' }),
    ).toHaveCount(0)
    await expect(page).toHaveURL(/\/$/)
    await expect(
      page.getByRole('heading', {
        level: 1,
        name: 'Sua farm de impressão, em um só lugar.',
      }),
    ).toBeVisible()
  })

  test('the action links stay reachable by keyboard at 360px', async ({
    page,
  }) => {
    await open(page, 'forbidden', viewports[0], 'light')
    const link = page.getByRole('link', { name: 'Minha farm' }).last()
    await link.focus()
    await expect(link).toBeFocused()
    expect(
      await link.evaluate((node) => node.getBoundingClientRect().height),
    ).toBeGreaterThanOrEqual(44)
    expect(await fits(page)).toBe(true)
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
    await open(page, 'not-found', viewports[1], 'dark')
    expect(external).toEqual([])
  })
})

test('screenshots of real screen states', async ({ page }, testInfo) => {
  testInfo.setTimeout(180_000)
  const dir =
    process.env.POLISH_ERRORS_SHOTS_DIR ??
    (await mkdtemp(join(tmpdir(), 'openfarm-errors-shots-')))
  await mkdir(dir, { recursive: true })
  const written: string[] = []
  for (const scenario of scenarios)
    for (const viewport of viewports)
      for (const theme of themes) {
        await page.unrouteAll({ behavior: 'ignoreErrors' })
        await open(page, scenario, viewport, theme)
        const path = join(dir, `${scenario}-${viewport.name}-${theme}.png`)
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

declare global {
  interface Window {
    useNuxtApp?: () => {
      isHydrating: boolean
      payload: { error?: unknown }
    }
  }
}
