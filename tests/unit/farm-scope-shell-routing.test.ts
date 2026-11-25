import { expect as browserExpect } from '@playwright/test'
import { afterAll, beforeAll, expect, it, vi } from 'vitest'
import {
  createPageHarness,
  reply,
  type PageHarness,
  type Routes,
} from '../helpers/page-harness'

vi.setConfig({ testTimeout: 30_000 })
const id = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const A = id(1)
const B = id(2)
let harness: PageHarness
beforeAll(async () => {
  harness = await createPageHarness()
}, 90_000)
afterAll(async () => {
  await harness?.close()
})

function routes(farms: string[]): Routes {
  return {
    'GET /api/auth/me': reply({ accountId: 'conta' }),
    'GET /api/farms': ({ url }) => {
      const after = url.searchParams.get('after')
      const offset = after ? farms.indexOf(after) + 1 : 0
      const end = offset + Number(url.searchParams.get('limit') ?? 20)
      return reply({
        farms: farms.slice(offset, end).map((farmId) => ({ farmId })),
        nextAfter: farms.length > end ? farms[end - 1] : null,
      })
    },
    'GET /api/browser-devices': reply({ currentRole: 'owner' }),
  }
}

it('waits for an explicit choice in both the shell and library with multiple memberships', async () => {
  const settingsPath = `/api/farms/${A}/library/settings`
  const opened = await harness.open(
    'biblioteca',
    {
      ...routes([A, B]),
      [`GET ${settingsPath}`]: reply({
        settings: { storageMode: 'server', quotaBytes: 1, retentionDays: 30 },
        locations: [],
        canManage: true,
      }),
      [`GET /api/farms/${A}/library`]: reply({ items: [], nextCursor: null }),
    },
    { layout: true, route: { path: '/biblioteca' } },
  )
  try {
    await browserExpect(opened.page.getByLabel('Trocar farm')).toHaveValue('')
    await browserExpect(
      opened.page.getByRole('link', { name: 'Ir para farms' }),
    ).toBeVisible()
    expect(opened.calls('GET', settingsPath)).toBe(0)
    expect(await opened.navigated()).toEqual([])
  } finally {
    await opened.close()
  }
})

it('retains an explicitly scoped farm beyond the first page of memberships', async () => {
  const farms = Array.from({ length: 25 }, (_, index) => id(index + 1))
  const deep = farms[21]!
  const opened = await harness.open('compatibilidade', routes(farms), {
    layout: true,
    route: { path: '/compatibilidade', query: { farm: deep } },
    init: `
      const pendingPage = new Promise(resolve => window.__releaseMembershipPage = resolve)
      window.__beforePageFetchResult = (url, options) =>
        url === '/api/farms' && options?.query?.after ? pendingPage : undefined
    `,
  })
  try {
    await browserExpect(
      opened.page.getByRole('link', { name: 'Estoque', exact: true }),
    ).toHaveAttribute('href', `/bobinas?farm=${deep}`)
    const select = opened.page.getByLabel('Trocar farm')
    await browserExpect(select).toHaveCount(0)
    await opened.page.evaluate(() =>
      (
        window as Window & { __releaseMembershipPage?: () => void }
      ).__releaseMembershipPage?.(),
    )
    await browserExpect(select).toHaveValue(deep)
    expect(opened.calls('GET', '/api/farms?limit=20&after=')).toBe(1)
  } finally {
    await opened.close()
  }
})

it('carries the farm through shortcuts, breadcrumbs and the farm page links', async () => {
  const opened = await harness.open('farm', routes([A, B]), {
    layout: true,
    route: { path: '/farm/detalhes', query: { farm: B } },
  })
  try {
    const { page } = opened
    await browserExpect(page.getByLabel('Trocar farm')).toHaveValue(B)
    const breadcrumbs = page.getByRole('navigation', { name: 'Localização' })
    await browserExpect(
      breadcrumbs.getByRole('link', { name: 'Início' }),
    ).toHaveAttribute('href', `/?farm=${B}`)
    await browserExpect(
      breadcrumbs.getByRole('link', { name: 'Minha farm' }),
    ).toHaveAttribute('href', `/farm?farm=${B}`)
    const nav = page.getByRole('navigation', { name: 'Navegação da farm' })
    await browserExpect(
      nav.getByRole('link', { name: 'Arquivos' }),
    ).toHaveAttribute('href', `/arquivos?farm=${B}`)
    await page.keyboard.press('g')
    await page.keyboard.press('b')
    expect((await opened.navigated()).at(-1)).toEqual({
      path: '/biblioteca',
      query: { farm: B },
    })
  } finally {
    await opened.close()
  }
})

it('keeps focus, farms and account links while updating the selected farm role', async () => {
  const opened = await harness.open(
    'compatibilidade',
    {
      ...routes([A, B]),
      'GET /api/browser-devices': ({ url }) => ({
        body: {
          currentRole:
            url.searchParams.get('farm_id') === A ? 'owner' : 'member',
        },
        delayMs: url.searchParams.get('farm_id') === B ? 500 : 0,
      }),
    },
    {
      layout: true,
      followRoute: true,
      route: { path: '/farm', query: { farm: A } },
    },
  )
  try {
    const { page } = opened
    const select = page.getByLabel('Trocar farm')
    await browserExpect(select).toHaveValue(A)
    await browserExpect
      .poll(() => opened.calls('GET', '/api/browser-devices'))
      .toBe(1)
    const authCalls = opened.calls('GET', '/api/auth/me')
    const membershipCalls = opened.calls('GET', '/api/farms?limit=20')
    await select.focus()
    await select.selectOption(B)
    await browserExpect(select).toHaveValue(B)
    await browserExpect(select).toBeFocused()
    await page.getByRole('button', { name: /Buscar/ }).click()
    await browserExpect(
      page.getByRole('option', { name: 'Sair da conta' }),
    ).toBeVisible()
    await browserExpect
      .poll(() => opened.calls('GET', '/api/browser-devices'))
      .toBe(2)
    await page.getByRole('option', { name: 'Sair da conta' }).click()
    expect((await opened.navigated()).at(-1)).toBe(`/sair?farm=${B}`)
    expect(opened.calls('GET', '/api/auth/me')).toBe(authCalls)
    expect(opened.calls('GET', '/api/farms?limit=20')).toBe(membershipCalls)
  } finally {
    await opened.close()
  }
})

it('the shell and farm wall share their first status-summary request', async () => {
  const path = `/api/farms/${B}/status-summary`
  const opened = await harness.open(
    'farm',
    {
      ...routes([A, B]),
      [`GET /api/farms/${B}/printers`]: reply({
        printers: [],
        nextAfter: null,
        canManage: true,
      }),
      [`GET ${path}`]: reply({
        generatedAt: Date.now(),
        counts: {
          printing: 0,
          paused: 0,
          error: 0,
          idle: 0,
          offline: 0,
          unknown: 0,
        },
        total: 0,
        printers: [],
      }),
    },
    { layout: true, route: { path: '/farm', query: { farm: B } } },
  )
  try {
    await browserExpect(opened.page.getByLabel('Farm atual')).toHaveValue(B)
    await browserExpect
      .poll(() => opened.calls('GET', `/api/farms/${B}/printers`))
      .toBeGreaterThan(0)
    expect(opened.calls('GET', path)).toBe(1)
  } finally {
    await opened.close()
  }
})
