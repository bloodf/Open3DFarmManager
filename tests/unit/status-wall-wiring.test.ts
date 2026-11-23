// SPDX-License-Identifier: MIT
import { expect as pw } from '@playwright/test'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import {
  createPageHarness,
  reply,
  type PageHarness,
  type Routes,
} from '../helpers/page-harness'

/**
 * The real `farm` and `painel` pages mounted in Chrome against an in-process
 * API on 127.0.0.1 (port 0): the wall card, the table links and the status
 * summary run through the pages, not through the components alone.
 */
vi.setConfig({ testTimeout: 30_000 })

const FARM = '00000000-0000-4000-8000-000000000001'
const AGENT = '00000000-0000-4000-8000-000000000002'
const WAIT = 10_000

const assignments = [
  {
    assignmentId: '00000000-0000-4000-8000-000000000011',
    agentId: AGENT,
    printerKey: 'voron 24',
    displayName: 'Bancada Alfa',
    groupName: 'Produção',
    location: 'Sala 1',
    sortOrder: 1,
    status: 'active',
    connectorStatus: 'approved',
  },
  {
    assignmentId: '00000000-0000-4000-8000-000000000012',
    agentId: AGENT,
    printerKey: 'ender-3',
    displayName: 'Bancada Beta',
    groupName: 'Protótipos',
    location: 'Sala 2',
    sortOrder: 2,
    status: 'active',
    connectorStatus: 'approved',
  },
]

const summaryPrinter = (index: number, state: string, ageMs = 2000) => ({
  assignmentId: assignments[index]!.assignmentId,
  printerKey: assignments[index]!.printerKey,
  displayName: assignments[index]!.displayName,
  groupName: assignments[index]!.groupName,
  location: assignments[index]!.location,
  state,
  progress: state === 'printing' ? 0.4 : undefined,
  temperatures: { toolCelsius: 205 },
  observedAt: Date.now() - ageMs,
  dataAgeMs: ageMs,
})

const summaryBody = () => ({
  generatedAt: Date.now(),
  total: 7,
  counts: { printing: 4, idle: 2, error: 1 },
  truncated: false,
  printers: [summaryPrinter(0, 'printing'), summaryPrinter(1, 'idle')],
})

const routes = (extra: Routes = {}): Routes => ({
  'GET /api/auth/me': reply({ accountId: 'account-one' }),
  'GET /api/farms': reply({
    farms: [{ farmId: FARM }],
    nextAfter: null,
  }),
  [`GET /api/farms/${FARM}/printers`]: reply({
    printers: assignments,
    nextAfter: null,
    canManage: true,
  }),
  'GET /api/browser-devices': reply({
    currentAccountId: 'account-one',
    currentRole: 'owner',
    devices: [],
    nextAfter: null,
  }),
  [`GET /api/farms/${FARM}/printer-states`]: reply({ states: [] }),
  [`GET /api/farms/${FARM}/status-summary`]: () => reply(summaryBody()),
  ...extra,
})

let harness: PageHarness
beforeAll(async () => {
  harness = await createPageHarness()
}, 60_000)
afterAll(async () => {
  await harness?.close()
})

describe('farm page', () => {
  it('renders the wall card for every printer with name, group and location', async () => {
    const opened = await harness.open('farm', routes())
    try {
      const { page } = opened
      const tile = page.getByRole('button', {
        name: /Inspecionar Bancada Alfa/,
      })
      await tile.waitFor({ state: 'visible', timeout: WAIT })
      await pw(tile).toContainText('Sem conexão direta')
      await pw(page.getByRole('heading', { name: 'Sala 1' })).toBeVisible()
      expect(await tile.count()).toBe(1)
      await tile.click()
      const inspector = page.getByRole('dialog', {
        name: 'Inspeção da impressora',
      })
      const link = inspector.getByRole('link', {
        name: 'Bancada Alfa',
        exact: true,
      })
      await pw(link).toHaveAttribute('href', '/impressoras/voron%2024')
      await pw(inspector).toContainText('Produção · Sala 1')
      await pw(inspector).toContainText('Sem dados')
      await pw(
        inspector.getByText('Conexão direta', { exact: true }),
      ).not.toHaveCount(0)
      await page.keyboard.press('Escape')
      await pw(inspector).not.toBeVisible()
      await pw(tile).toBeFocused()
      const beta = page.getByRole('button', {
        name: /Inspecionar Bancada Beta/,
      })
      await beta.click()
      await pw(
        inspector.getByRole('link', { name: 'Bancada Beta', exact: true }),
      ).toHaveAttribute('href', '/impressoras/ender-3')
    } finally {
      await opened.close()
    }
  })

  it('keeps the filters and the grouping working on the wall cards', async () => {
    const opened = await harness.open('farm', routes(), {
      route: { query: { q: 'Alfa' } },
    })
    try {
      const { page } = opened
      await page
        .getByRole('button', { name: /Inspecionar Bancada Alfa/ })
        .waitFor({ state: 'visible', timeout: WAIT })
      expect(
        await page
          .getByRole('button', { name: /Inspecionar Bancada Beta/ })
          .count(),
      ).toBe(0)
    } finally {
      await opened.close()
    }
    const grouped = await harness.open('farm', routes(), {
      route: { query: { groupBy: 'groupName' } },
    })
    try {
      const { page } = grouped
      await page
        .getByRole('heading', { name: 'Protótipos' })
        .waitFor({ state: 'visible', timeout: WAIT })
      await pw(page.getByRole('heading', { name: 'Produção' })).toBeVisible()
      // The machine stays available in its group and opens its detailed heading.
      await page
        .getByRole('button', { name: /Inspecionar Bancada Alfa/ })
        .click()
      await pw(
        page
          .getByRole('dialog', { name: 'Inspeção da impressora' })
          .getByRole('heading', { name: 'Bancada Alfa', level: 4 }),
      ).toBeVisible()
    } finally {
      await grouped.close()
    }
  })

  it('links every table row to the printer detail page', async () => {
    const opened = await harness.open('farm', routes())
    try {
      const { page } = opened
      await page
        .getByRole('button', { name: 'Tabela' })
        .click({ timeout: WAIT })
      const table = page.getByRole('table', { name: 'Impressoras atribuídas' })
      await table.waitFor({ state: 'visible', timeout: WAIT })
      const hrefs = await table
        .locator('tbody th a')
        .evaluateAll((anchors) => anchors.map((a) => a.getAttribute('href')))
      expect(hrefs).toEqual(['/impressoras/voron%2024', '/impressoras/ender-3'])
      expect(await table.locator('a[href^="#"]').count()).toBe(0)
    } finally {
      await opened.close()
    }
  })

  it('shows the farm summary read from the status-summary route', async () => {
    const opened = await harness.open('farm', routes())
    try {
      const { page } = opened
      const region = page.getByRole('region', { name: 'Resumo da farm' })
      await region.waitFor({ state: 'visible', timeout: WAIT })
      // Counts cover the whole farm (7), not just the two assignments listed.
      await pw(region).toContainText('7 impressoras na farm')
      await pw(region).toContainText('Imprimindo: 4')
      await pw(region).toContainText('Ociosa: 2')
      await pw(region).toContainText('Erro: 1')
      await pw(region).toContainText('Resumo atualizado há')
      expect(opened.calls('GET', '/status-summary')).toBeGreaterThan(0)
    } finally {
      await opened.close()
    }
  })

  it('flags the summary when the route fails and never shows raw errors', async () => {
    const opened = await harness.open(
      'farm',
      routes({
        [`GET /api/farms/${FARM}/status-summary`]: {
          status: 500,
          body: { statusCode: 500, message: 'TypeError: boom' },
        },
      }),
    )
    try {
      const { page } = opened
      const region = page.getByRole('region', { name: 'Resumo da farm' })
      await region.waitFor({ state: 'visible', timeout: WAIT })
      await pw(region).toContainText('Resumo indisponível')
      await pw(region).not.toContainText(/TypeError|500/)
      // The wall itself still lists the printers.
      await pw(
        page.getByRole('button', { name: /Inspecionar Bancada Alfa/ }),
      ).toBeVisible()
    } finally {
      await opened.close()
    }
  })
})

describe('painel page', () => {
  it('polls the status-summary route, not the stored printer states', async () => {
    const opened = await harness.open('painel', routes())
    try {
      const { page } = opened
      await page
        .getByRole('heading', { name: 'Bancada Alfa' })
        .waitFor({ state: 'visible', timeout: WAIT })
      await pw(
        page.getByRole('heading', { name: 'Bancada Beta' }),
      ).toBeVisible()
      await pw(page.locator('.kiosk__head')).toContainText(
        'Dados atualizados há',
      )
      // Progress and temperature come from the summary.
      await pw(page.locator('.kiosk__progress')).toContainText('40%')
      await pw(page.locator('main')).toContainText('205 °C')
      expect(opened.calls('GET', '/status-summary')).toBeGreaterThan(0)
      expect(opened.calls('GET', '/printer-states')).toBe(0)
      expect(await page.locator('main a, main button').count()).toBe(0)
    } finally {
      await opened.close()
    }
  })

  it('keeps the previous cards and flags them when the summary fails', async () => {
    const opened = await harness.open('painel', routes(), { clock: true })
    try {
      const { page } = opened
      await page
        .getByRole('heading', { name: 'Bancada Alfa' })
        .waitFor({ state: 'visible', timeout: WAIT })
      opened.setRoutes(
        routes({
          [`GET /api/farms/${FARM}/status-summary`]: { status: 500, body: {} },
        }),
      )
      await page.clock.runFor(5_500)
      await pw(page.locator('.kiosk__head')).toContainText(
        'Falha na atualização',
        { timeout: WAIT },
      )
      await pw(
        page.getByRole('heading', { name: 'Bancada Alfa' }),
      ).toBeVisible()
    } finally {
      await opened.close()
    }
  })
})
