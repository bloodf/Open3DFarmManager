import AxeBuilder from '@axe-core/playwright'
import type { Page } from '@playwright/test'
import { setPolishTheme } from './polish-theme.ts'
import { mockShellApi } from './shell-api.ts'

export const farm = '00000000-0000-4000-8000-0000000000f1'
export const agent = '00000000-0000-4000-8000-0000000000a1'
export const firstAssignment = '00000000-0000-4000-8000-0000000000b1'
export const secondAssignment = '00000000-0000-4000-8000-0000000000b2'
export const longKey = `impressora-com-um-nome-muito-longo-${'x'.repeat(70)}`

export const viewports = [
  { name: '360', width: 360, height: 800 },
  { name: 'desktop', width: 1280, height: 900 },
] as const
export const themes = ['light', 'dark'] as const

export type Scenario =
  'populated' | 'empty' | 'no-farms' | 'loading' | 'sign-in' | 'error'

export const printer = (
  assignmentId: string,
  printerKey: string,
  extra = {},
) => ({
  assignmentId,
  agentId: agent,
  printerKey,
  status: 'active',
  connectorStatus: 'approved',
  ...extra,
})

export async function mockApi(page: Page, scenario: Scenario) {
  // Anything not mocked below never leaves the test.
  await page.route(
    (url) => !['127.0.0.1', 'localhost'].includes(url.hostname),
    (route) => route.abort(),
  )
  await mockShellApi(page, farm)
  for (const assignment of [firstAssignment, secondAssignment])
    await page.route(
      `**/api/farms/${farm}/printers/${assignment}/mode`,
      (route) => route.fulfill({ json: { mode: 'in-service' } }),
    )
  await page.route('**/api/auth/me', async (route) => {
    if (scenario === 'sign-in') return route.fulfill({ status: 401, json: {} })
    if (scenario === 'error') return route.fulfill({ status: 503, json: {} })
    return route.fulfill({ json: { accountId: 'conta-sintetica' } })
  })
  await page.route('**/api/farms?*', (route) =>
    route.fulfill({
      json: {
        farms: scenario === 'no-farms' ? [] : [{ farmId: farm }],
        nextAfter: null,
      },
    }),
  )
  await page.route(`**/api/farms/${farm}/printers?*`, async (route) => {
    if (scenario === 'loading') await new Promise(() => undefined)
    const printers =
      scenario === 'empty'
        ? []
        : [
            printer(firstAssignment, longKey, {
              displayName: 'Ender da bancada',
              groupName: 'Sala 1',
              location: 'Bancada A',
            }),
            printer(secondAssignment, 'impressora-2', {
              groupName: 'Sala 2',
              location: 'Bancada B',
            }),
          ]
    return route.fulfill({
      json: { printers, nextAfter: null, canManage: true },
    })
  })
  await page.route(`**/api/farms/${farm}/status-summary*`, (route) =>
    route.fulfill({
      json: {
        generatedAt: Date.now(),
        total: scenario === 'empty' ? 0 : 2,
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
}

// Loads /farm in a scenario without asserting anything, so the same steps can
// drive the asserting spec and the pre-polish baseline capture.
export async function prepare(
  page: Page,
  scenario: Scenario,
  viewport: (typeof viewports)[number],
  theme: (typeof themes)[number],
) {
  await page.setViewportSize(viewport)
  await setPolishTheme(page, theme)
  await mockApi(page, scenario)
  await page.goto('/farm')
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

export const scenarios: Scenario[] = [
  'populated',
  'empty',
  'no-farms',
  'loading',
  'sign-in',
  'error',
]
