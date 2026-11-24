// Shared fixtures for the jobs history screen (/historico): mocked /api routes,
// the states to check and the screenshot capture. Used by polish-jobs.spec.ts
// and by polish-jobs-capture.ts, which captures the pre-polish baseline.
//
// Nothing here reaches a real printer, database, auth service or external
// network: every request that is not served by the app itself is either
// fulfilled here or aborted.
import { mkdir, stat } from 'node:fs/promises'
import { join } from 'node:path'
import AxeBuilder from '@axe-core/playwright'
import { type Page } from '@playwright/test'
import { setPolishTheme } from '../helpers/polish-theme.ts'

export const farm = '00000000-0000-4000-8000-0000000000f1'
export const otherFarm = '00000000-0000-4000-8000-0000000000f2'
export const sha = 'a'.repeat(64)
export const longKey = `impressora-com-um-nome-muito-longo-${'x'.repeat(70)}`
export const longFile = `${'peça-de-teste-'.repeat(8)}versão-final.gcode`

export const viewports = [
  { name: '360', width: 360, height: 800 },
  { name: 'desktop', width: 1280, height: 900 },
] as const
export const themes = ['light', 'dark'] as const
export const scenarios = [
  'populated',
  'empty',
  'no-farms',
  'select-farm',
  'loading',
  'sign-in',
  'error',
] as const

export type Viewport = (typeof viewports)[number]
export type Theme = (typeof themes)[number]
export type Scenario = (typeof scenarios)[number]

const endedAt = Date.UTC(2026, 10, 15, 15, 0, 0)
const jobs = [
  {
    id: '3-3',
    printerKey: longKey,
    outcome: 'failed',
    filename: longFile,
    printDurationSeconds: 5400,
    librarySha256: sha,
    plate: 2,
    endedAt: endedAt - 3_600_000,
  },
  {
    id: '2-2',
    printerKey: 'impressora-2',
    outcome: 'cancelled',
    filename: 'cubo.gcode',
    totalDurationSeconds: 125,
    endedAt: endedAt - 7_200_000,
  },
  {
    id: '1-1',
    printerKey: 'impressora-1',
    outcome: 'completed',
    printDurationSeconds: 3660,
    endedAt,
  },
]

export async function mockApi(page: Page, scenario: Scenario) {
  // Anything not mocked below never leaves the test.
  await page.route(
    (url) => !['127.0.0.1', 'localhost'].includes(url.hostname),
    (route) => route.abort(),
  )
  // Unknown app endpoints answer with an empty failure instead of a real call.
  await page.route('**/api/**', (route) =>
    route.fulfill({ status: 404, json: {} }),
  )
  await page.route('**/api/auth/me', (route) =>
    route.fulfill({ json: { accountId: 'conta-sintetica' } }),
  )
  await page.route('**/api/farms?*', (route) =>
    route.fulfill({
      json: {
        farms:
          scenario === 'no-farms'
            ? []
            : scenario === 'select-farm'
              ? [{ farmId: farm }, { farmId: otherFarm }]
              : [{ farmId: farm }],
        nextAfter: null,
      },
    }),
  )
  await page.route(`**/api/farms/${farm}/printers?*`, (route) =>
    route.fulfill({ json: { printers: [], nextAfter: null, canManage: true } }),
  )
  await page.route(`**/api/farms/${farm}/status-summary*`, (route) =>
    route.fulfill({
      json: {
        generatedAt: Date.now(),
        total: 0,
        counts: {},
        truncated: false,
        printers: [],
      },
    }),
  )
  await page.route(`**/api/farms/${farm}/printer-states*`, (route) =>
    route.fulfill({ json: { states: [] } }),
  )
  await page.route(`**/api/farms/${farm}/integrations/approvals*`, (route) =>
    route.fulfill({ status: 403, json: {} }),
  )
  await page.route('**/api/browser-devices?*', (route) =>
    route.fulfill({
      json: {
        currentAccountId: 'conta-sintetica',
        currentRole: 'owner',
        devices: [],
        nextAfter: null,
        limits: {
          pendingLifetimeMs: 86_400_000,
          proofLifetimeMs: 60_000,
          maxChallengesPerKey: 3,
        },
      },
    }),
  )
  await page.route('**/api/job-history?*', async (route) => {
    const url = new URL(route.request().url())
    if (scenario === 'loading') await new Promise(() => undefined)
    if (scenario === 'sign-in') return route.fulfill({ status: 401, json: {} })
    if (scenario === 'error') return route.fulfill({ status: 500, json: {} })
    if (scenario === 'empty')
      return route.fulfill({ json: { jobs: [], nextBefore: null } })
    // The first page offers "Carregar mais"; the cursor page is the last one.
    return url.searchParams.has('before')
      ? route.fulfill({
          json: {
            jobs: [
              {
                id: '0-0',
                printerKey: 'impressora-3',
                outcome: 'completed',
                filename: 'suporte.gcode',
                printDurationSeconds: 900,
                endedAt: endedAt - 86_400_000,
              },
            ],
            nextBefore: null,
          },
        })
      : route.fulfill({ json: { jobs, nextBefore: '1-1' } })
  })
}

export async function open(
  page: Page,
  scenario: Scenario,
  viewport: Viewport,
  theme: Theme,
) {
  await page.setViewportSize(viewport)
  await setPolishTheme(page, theme)
  await mockApi(page, scenario)
  await page.goto('/historico')
  await page
    .getByRole('heading', { level: 1, name: 'Histórico de trabalhos' })
    .waitFor()
  await settle(page, scenario)
}

/** Waits for the state each scenario ends in; no fixed sleeps. */
export async function settle(page: Page, scenario: Scenario) {
  switch (scenario) {
    case 'populated':
      await page.getByRole('cell', { name: 'cubo.gcode' }).waitFor()
      break
    case 'empty':
      await page
        .getByRole('heading', { name: 'Nenhum trabalho finalizado' })
        .waitFor()
      break
    case 'no-farms':
      await page
        .getByRole('heading', { name: 'Nenhuma farm disponível' })
        .waitFor()
      break
    case 'select-farm':
      await page.getByRole('heading', { name: 'Selecione uma farm' }).waitFor()
      break
    case 'loading':
      await page
        .locator('div[aria-busy="true"]')
        .getByRole('status')
        .filter({ hasText: /^Consultando histórico…$/ })
        .waitFor()
      break
    case 'sign-in':
      await page.getByText('Sua sessão não está disponível').waitFor()
      break
    case 'error':
      await page
        .getByText('Não foi possível consultar o histórico. Tente novamente.')
        .waitFor()
      break
  }
}

export async function violations(page: Page) {
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

export const fits = (page: Page) =>
  page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)

/**
 * One full-page screenshot per state, viewport and theme. Every file must
 * exist and be non-empty, so a missing capture fails the run.
 */
export async function captureAll(page: Page, dir: string) {
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
  const expected = scenarios.length * viewports.length * themes.length
  if (written.length !== expected)
    throw new Error(`Captured ${written.length} of ${expected} screenshots`)
  return written
}
