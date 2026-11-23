import { mkdtemp, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'
import {
  captureAll,
  farm,
  fits,
  longFile,
  longKey,
  open,
  scenarios,
  themes,
  viewports,
  violations,
} from './polish-jobs-fixtures.ts'

// Isolated UI checks for /historico on mocked /api routes. No real printer,
// database, auth service or external network is involved.
//
// Screenshots are always captured by the last test and saved outside the
// repository (POLISH_JOBS_SHOTS_DIR or a temporary directory).
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

test('page has one main, one h1 and headings in order', async ({ page }) => {
  await open(page, 'populated', viewports[1], 'light')
  await expect(page.getByRole('main')).toHaveCount(1)
  await expect(page.getByRole('heading', { level: 1 })).toHaveCount(1)
  const levels = await page
    .locator('h1, h2, h3, h4, h5, h6')
    .evaluateAll((nodes) => nodes.map((node) => Number(node.tagName[1])))
  expect(levels.length).toBeGreaterThan(1)
  for (const [index, level] of levels.entries())
    if (index > 0) expect(level - levels[index - 1]!).toBeLessThanOrEqual(1)
})

test('populated table has column headers, labelled outcomes and wraps long values', async ({
  page,
}) => {
  await open(page, 'populated', viewports[0], 'light')
  const table = page.getByRole('table', { name: 'Trabalhos finalizados' })
  await expect(table.getByRole('columnheader')).toHaveText([
    'Impressora',
    'Resultado',
    'Arquivo',
    'Término',
    'Duração',
    'Biblioteca',
  ])
  await expect(table.getByRole('row')).toHaveCount(4)
  await expect(
    table.getByRole('cell', { name: longKey, exact: true }),
  ).toBeVisible()
  await expect(
    table.getByRole('cell', { name: longFile, exact: true }),
  ).toBeVisible()
  // Outcome is text, never colour alone.
  for (const label of ['Falhou', 'Cancelado', 'Concluído'])
    await expect(table.getByText(label, { exact: true })).toBeVisible()
  await expect(table.getByText('Arquivo desconhecido')).toBeVisible()
  await expect(table.getByText('1 h 1 min')).toBeVisible()
  // Replay is offered only for the job that came from the library.
  await expect(
    table.getByRole('button', { name: /Imprimir de novo/ }),
  ).toHaveCount(1)
  await expect(table.getByText('Fora da biblioteca')).toHaveCount(2)
  expect(await fits(page)).toBe(true)
})

test('the wide table scrolls inside a keyboard-focusable region at 360px', async ({
  page,
}) => {
  await open(page, 'populated', viewports[0], 'dark')
  const region = page.getByRole('region', {
    name: 'Tabela de trabalhos finalizados',
  })
  await region.focus()
  await expect(region).toBeFocused()
  expect(
    await region.evaluate((node) => node.scrollWidth > node.clientWidth),
  ).toBe(true)
  expect(
    await region.evaluate((node) => getComputedStyle(node).outlineStyle),
  ).not.toBe('none')
  expect(await fits(page)).toBe(true)
})

test('"Carregar mais" appends the next page and then disappears', async ({
  page,
}) => {
  await open(page, 'populated', viewports[1], 'light')
  const more = page.getByRole('button', { name: 'Carregar mais' })
  await expect(more).toBeVisible()
  const request = page.waitForRequest(
    (item) =>
      item.url().includes('/api/job-history') &&
      new URL(item.url()).searchParams.get('before') === '1-1',
  )
  await more.click()
  await request
  await expect(page.getByRole('cell', { name: 'suporte.gcode' })).toBeVisible()
  await expect(page.getByRole('cell', { name: 'cubo.gcode' })).toBeVisible()
  await expect(more).toHaveCount(0)
})

test('filters are a named search landmark and Enter applies the printer filter without a reload', async ({
  page,
}) => {
  await open(page, 'populated', viewports[1], 'light')
  const search = page.getByRole('search', { name: 'Filtros' })
  await expect(search).toBeVisible()
  await expect(search.getByLabel('Farm')).toHaveValue(farm)
  await page.evaluate(() => {
    ;(window as unknown as { marker: string }).marker = 'kept'
  })
  const field = search.getByLabel('Impressora (opcional)')
  await field.fill('impressora-2')
  const request = page.waitForRequest(
    (item) =>
      item.url().includes('/api/job-history') &&
      new URL(item.url()).searchParams.get('printerKey') === 'impressora-2',
  )
  await field.press('Enter')
  await request
  expect(
    await page.evaluate(() => (window as unknown as { marker: string }).marker),
  ).toBe('kept')
})

test('keyboard reaches farm, printer and refresh with a visible focus ring', async ({
  page,
}) => {
  await open(page, 'populated', viewports[1], 'light')
  await page.locator('#farm').focus()
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
  expect(seen).toEqual(['farm', 'printer', 'outcome', 'Atualizar histórico'])
})

test('loading is announced once and marks the results busy', async ({
  page,
}) => {
  await open(page, 'loading', viewports[0], 'light')
  const busy = page.locator('div[aria-busy="true"]')
  await expect(busy.getByRole('status')).toHaveText('Consultando histórico…')
  await expect(page.locator('.skeleton')).toHaveCount(3)
  await expect(page.getByRole('table')).toHaveCount(0)
  await expect(page.getByRole('search')).toHaveAttribute('aria-busy', 'true')
})

test('empty states say why and offer a way out', async ({ page }) => {
  await open(page, 'empty', viewports[0], 'light')
  await expect(
    page.getByText('Quando uma impressora concluir, cancelar ou falhar'),
  ).toBeVisible()
  await expect(
    page.getByRole('link', { name: 'Ver impressoras' }),
  ).toHaveAttribute('href', '/impressoras')
  await expect(page.getByRole('table')).toHaveCount(0)
})

test('without a selected farm the page asks for one and does not query jobs', async ({
  page,
}) => {
  const queried: string[] = []
  page.on('request', (item) => {
    if (item.url().includes('/api/job-history')) queried.push(item.url())
  })
  await open(page, 'select-farm', viewports[0], 'light')
  await expect(
    page.getByRole('button', { name: 'Atualizar histórico' }),
  ).toBeDisabled()
  expect(queried).toEqual([])
})

test('error moves focus to the alert, keeps no stale rows and retry recovers', async ({
  page,
}) => {
  await open(page, 'error', viewports[0], 'light')
  const alert = page.getByRole('alert')
  await expect(alert).toBeFocused()
  await expect(
    alert.getByRole('heading', { name: 'Histórico indisponível' }),
  ).toBeVisible()
  await expect(alert).toContainText(
    'Não foi possível consultar o histórico. Tente novamente.',
  )
  await expect(page.getByRole('table')).toHaveCount(0)
  await expect(
    page.getByRole('link', { name: 'Entrar na conta' }),
  ).toHaveAttribute('href', '/entrar')
  await page.route('**/api/job-history?*', (route) =>
    route.fulfill({ json: { jobs: [], nextBefore: null } }),
  )
  await alert.getByRole('button', { name: 'Tentar novamente' }).click()
  await expect(
    page.getByRole('heading', { name: 'Nenhum trabalho finalizado' }),
  ).toBeVisible()
  await expect(alert.getByRole('heading')).toHaveCount(0)
})

test('an expired session says so and links to sign in', async ({ page }) => {
  await open(page, 'sign-in', viewports[0], 'light')
  await expect(page.getByRole('alert')).toContainText(
    'Sua sessão não está disponível',
  )
  await expect(
    page.getByRole('link', { name: 'Entrar na conta' }),
  ).toHaveAttribute('href', '/entrar')
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
  testInfo.setTimeout(180_000)
  const dir =
    process.env.POLISH_JOBS_SHOTS_DIR ??
    (await mkdtemp(join(tmpdir(), 'openfarm-jobs-shots-')))
  const written = await captureAll(page, dir)
  expect(written).toHaveLength(
    scenarios.length * viewports.length * themes.length,
  )
  expect((await readdir(dir)).filter((name) => name.endsWith('.png'))).toEqual(
    expect.arrayContaining(written.map((path) => path.split('/').pop()!)),
  )
})
