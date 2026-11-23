import { mkdir, mkdtemp, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test, type Page } from '@playwright/test'
import {
  firstAssignment,
  fits,
  longKey,
  prepare,
  scenarios,
  themes,
  viewports,
  violations,
  type Scenario,
} from '../helpers/farm-evidence.ts'

// Isolated UI checks on mocked /api routes. No real printer, database, auth
// service or external network is involved: every request that is not served by
// the page itself is either fulfilled here or aborted. The mocks live in
// tests/helpers/farm-evidence.ts so the baseline capture shares them.
//
// Screenshots are saved outside the repository for evidence.
async function open(
  page: Page,
  scenario: Scenario,
  viewport: (typeof viewports)[number],
  theme: (typeof themes)[number],
) {
  await prepare(page, scenario, viewport, theme)
  const heading = page.getByRole('heading', {
    level: 1,
    name: 'Minha farm',
    exact: true,
  })
  // On failure focus moves on to the alert, so only the other states keep it.
  if (scenario === 'error') await expect(heading).toBeVisible()
  else await expect(heading).toBeFocused()
  await settle(page, scenario)
}

async function settle(page: Page, scenario: Scenario) {
  switch (scenario) {
    case 'populated': {
      const tile = page.getByRole('button', {
        name: /Inspecionar Ender da bancada/,
      })
      await tile.click()
      const inspector = page.getByRole('dialog', {
        name: 'Inspeção da impressora',
      })
      await expect(inspector.locator(`#printer-${firstAssignment}`)).toHaveText(
        longKey,
      )
      await inspector.getByRole('button', { name: 'Fechar inspeção' }).click()
      await expect(tile).toBeFocused()
      await page.getByRole('heading', { level: 1, name: 'Minha farm' }).focus()
      break
    }
    case 'empty':
      await expect(
        page.getByText('Nenhuma impressora atribuída a esta farm.'),
      ).toBeVisible()
      break
    case 'no-farms':
      await expect(
        page.getByText('Sua conta ainda não tem acesso a uma farm.'),
      ).toBeVisible()
      break
    case 'loading':
      await expect(
        page.getByText('Carregando o cadastro de impressoras…'),
      ).toBeVisible()
      break
    case 'sign-in':
      await expect(
        page.getByRole('region', { name: 'Acesso à farm' }),
      ).toBeVisible()
      break
    case 'error':
      await expect(page.getByRole('alert')).toBeFocused()
      break
  }
}

for (const scenario of scenarios) {
  for (const viewport of viewports) {
    for (const theme of themes) {
      test(`${scenario} state is accessible and fits at ${viewport.name} in the ${theme} theme`, async ({
        page,
      }) => {
        await open(page, scenario, viewport, theme)
        expect(await fits(page)).toBe(true)
        expect(await violations(page)).toEqual([])
      })
    }
  }
}

test('page has one landmark main, one h1 and ordered headings with a named navigation', async ({
  page,
}) => {
  await open(page, 'populated', viewports[1], 'light')
  await expect(page.getByRole('main')).toHaveCount(1)
  await expect(page.getByRole('heading', { level: 1 })).toHaveCount(1)
  await expect(
    page.getByRole('navigation', { name: 'Navegação da farm' }),
  ).toBeVisible()
  const levels = await page
    .locator('h1, h2, h3, h4, h5, h6')
    .evaluateAll((nodes) => nodes.map((node) => Number(node.tagName[1])))
  for (const [index, level] of levels.entries())
    if (index > 0) expect(level - levels[index - 1]!).toBeLessThanOrEqual(1)
})

test('filters are a named search landmark and Enter never reloads the page', async ({
  page,
}) => {
  await open(page, 'populated', viewports[1], 'light')
  const search = page.getByRole('search', { name: 'Filtrar impressoras' })
  await expect(search).toBeVisible()
  const field = search.getByLabel('Buscar impressora, Connector ou atribuição')
  await field.fill('impressora-2')
  await page.evaluate(() => {
    ;(window as unknown as { marker: string }).marker = 'kept'
  })
  await field.press('Enter')
  expect(
    await page.evaluate(() => (window as unknown as { marker: string }).marker),
  ).toBe('kept')
  await expect(page.getByRole('status').filter({ hasText: 'de 2' })).toHaveText(
    '1 de 2 impressoras nesta página.',
  )
  await search.getByRole('button', { name: 'Limpar filtros' }).click()
  await expect(page.getByRole('status').filter({ hasText: 'de 2' })).toHaveText(
    '2 de 2 impressoras nesta página.',
  )
})

test('empty state explains why and offers the way out; loading is announced and busy', async ({
  page,
}) => {
  await open(page, 'empty', viewports[0], 'light')
  await expect(
    page.getByRole('link', { name: 'Gerenciar atribuições' }),
  ).toHaveAttribute('href', '/impressoras')
  await expect(page.locator('article')).toHaveCount(0)
})

test('loading state is announced and marks the region busy', async ({
  page,
}) => {
  await open(page, 'loading', viewports[0], 'light')
  await expect(
    page.getByRole('status').filter({ hasText: 'Carregando o cadastro' }),
  ).toBeVisible()
  await expect(
    page.getByRole('region', { name: 'Impressoras atribuídas' }),
  ).toHaveAttribute('aria-busy', 'true')
})

test('error state moves focus to the alert and retry is a real button', async ({
  page,
}) => {
  await open(page, 'error', viewports[0], 'light')
  await expect(page.getByRole('alert')).toHaveText(
    'Não foi possível confirmar seus dados. Tente novamente.',
  )
  await expect(
    page.getByRole('button', { name: 'Tentar novamente' }),
  ).toBeVisible()
  await expect(
    page.getByRole('link', { name: 'Entrar novamente' }),
  ).toHaveAttribute('href', '/entrar')
  await expect(page.getByRole('article')).toHaveCount(0)
})

test('keyboard reaches navigation, scope and filters in order with a visible focus ring', async ({
  page,
}) => {
  await prepare(page, 'populated', viewports[1], 'light')
  await expect(
    page.getByRole('heading', { level: 1, name: 'Minha farm' }),
  ).toBeFocused()
  await expect(
    page.getByRole('button', { name: /Inspecionar Ender da bancada/ }),
  ).toBeVisible()
  const seen: string[] = []
  for (let step = 0; step < 14; step++) {
    await page.keyboard.press('Tab')
    const focus = await page.evaluate(() => {
      const element = document.activeElement as HTMLElement | null
      if (!element || element === document.body) return null
      const style = getComputedStyle(element)
      return {
        label:
          element.getAttribute('aria-label') ||
          element.id ||
          element.textContent?.trim().slice(0, 40) ||
          element.tagName,
        outline: style.outlineStyle !== 'none' && style.outlineWidth !== '0px',
      }
    })
    expect(focus, `Tab stop ${step + 1} lost focus`).not.toBeNull()
    expect(focus?.outline, `${focus?.label} has no focus ring`).toBe(true)
    seen.push(focus!.label)
  }
  expect(seen.slice(0, 6)).toEqual([
    'Início',
    'Arquivos',
    'Impressoras',
    'Connectors',
    'Dispositivos do navegador',
    'Sair da conta',
  ])
  expect(seen).toContain('farm-scope')
  expect(seen).toContain('farm-search')
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

test('screenshots of real screen states', async ({ page }, testInfo) => {
  const dir =
    process.env.POLISH_FARM_SHOTS_DIR ??
    (await mkdtemp(join(tmpdir(), 'openfarm-shots-')))
  await mkdir(dir, { recursive: true })
  testInfo.setTimeout(180_000)
  for (const scenario of scenarios)
    for (const viewport of viewports)
      for (const theme of themes) {
        await page.unrouteAll({ behavior: 'ignoreErrors' })
        await open(page, scenario, viewport, theme)
        const path = join(dir, `${scenario}-${viewport.name}-${theme}.png`)
        await page.screenshot({ path, fullPage: true })
        expect((await stat(path)).size).toBeGreaterThan(0)
      }
})
