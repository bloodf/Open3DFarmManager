// SPDX-License-Identifier: MIT
import { expect as pw } from '@playwright/test'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { renderFarmComponent } from '../../apps/farm/app/components/farm/render-farm-component.ts'
import {
  createPageHarness,
  reply,
  type PageHarness,
  type Routes,
} from '../helpers/page-harness'

/**
 * The charts and the shared formatters run through the real pages mounted in
 * Chrome against an in-process API on 127.0.0.1 (port 0): the gallery, the
 * kiosk (`painel`) and the farm page, plus the printer detail panels.
 */
vi.setConfig({ testTimeout: 30_000 })

const FARM = '00000000-0000-4000-8000-000000000001'
const AGENT = '00000000-0000-4000-8000-000000000002'
const ASSIGNMENT = '00000000-0000-4000-8000-000000000011'
const WAIT = 10_000

const assignment = {
  assignmentId: ASSIGNMENT,
  agentId: AGENT,
  printerKey: 'voron 24',
  displayName: 'Bancada Alfa',
  groupName: 'Produção',
  location: 'Sala 1',
  sortOrder: 1,
  status: 'active',
  connectorStatus: 'approved',
}

const routes = (extra: Routes = {}): Routes => ({
  'GET /api/auth/me': reply({ accountId: 'account-one' }),
  'GET /api/farms': reply({ farms: [{ farmId: FARM }], nextAfter: null }),
  [`GET /api/farms/${FARM}/printers`]: reply({
    printers: [assignment],
    nextAfter: null,
    canManage: true,
  }),
  'GET /api/browser-devices': reply({
    currentAccountId: 'account-one',
    currentRole: 'owner',
    devices: [],
    nextAfter: null,
  }),
  [`GET /api/farms/${FARM}/printer-states`]: reply({
    states: [
      {
        assignmentId: ASSIGNMENT,
        printerKey: assignment.printerKey,
        state: 'printing',
        progress: 0.425,
        temperatures: { toolCelsius: 215.04, bedCelsius: 60 },
        observedAt: Date.now() - 5000,
      },
    ],
  }),
  [`GET /api/farms/${FARM}/status-summary`]: () =>
    reply({
      generatedAt: Date.now(),
      total: 1,
      counts: { printing: 1 },
      truncated: false,
      printers: [
        {
          assignmentId: ASSIGNMENT,
          printerKey: assignment.printerKey,
          displayName: assignment.displayName,
          groupName: assignment.groupName,
          location: assignment.location,
          state: 'printing',
          progress: 0.4,
          temperatures: { toolCelsius: 205.25, bedCelsius: 60 },
          observedAt: Date.now() - 2000,
          dataAgeMs: 2000,
        },
      ],
    }),
  ...extra,
})

let harness: PageHarness
beforeAll(async () => {
  harness = await createPageHarness()
}, 60_000)
afterAll(async () => {
  await harness?.close()
})

describe('ui-gallery page', () => {
  it('shows the progress ring, the sparkline, the legend and the formatted values', async () => {
    const opened = await harness.open('ui-gallery', routes())
    try {
      const { page } = opened
      const ring = page.getByRole('progressbar', {
        name: 'Progresso do trabalho',
      })
      await ring.waitFor({ state: 'visible', timeout: WAIT })
      await pw(ring).toHaveAttribute('aria-valuetext', '42%')
      await pw(
        page.getByRole('img', { name: 'Tendência da temperatura do bico' }),
      ).toBeVisible()
      await pw(page.getByText('Escala de cores da malha')).toBeVisible()
      const main = page.locator('main')
      await pw(main).toContainText('19/11/2026, 09:00:00')
      await pw(main).toContainText('1 h 30 min')
      await pw(main).toContainText('215 °C')
      await pw(main).toContainText('742,5 g')
    } finally {
      await opened.close()
    }
  })
})

describe('painel page', () => {
  it('draws the job progress as a ring and formats the temperature', async () => {
    const opened = await harness.open('painel', routes())
    try {
      const { page } = opened
      const ring = page.getByRole('progressbar', {
        name: 'Progresso da impressão',
      })
      await ring.waitFor({ state: 'visible', timeout: WAIT })
      await pw(ring).toHaveAttribute('aria-valuetext', '40%')
      await pw(page.locator('main')).toContainText('205,3 °C')
    } finally {
      await opened.close()
    }
  })
})

describe('farm page', () => {
  it('formats the last known progress and temperatures', async () => {
    const opened = await harness.open('farm', routes())
    try {
      const { page } = opened
      const main = page.locator('main')
      await pw(main).toContainText('Progresso informado da impressão', {
        timeout: WAIT,
      })
      await pw(main).toContainText('42,5%')
      await pw(main).toContainText('215 °C')
    } finally {
      await opened.close()
    }
  })
})

describe('printer detail panels', () => {
  const now = Date.UTC(2026, 10, 19, 12)

  it('draws a sparkline next to every heater reading', async () => {
    const html = await renderFarmComponent(
      '../printer-detail/HeaterPanel.vue',
      {
        heaters: [{ name: 'extruder', temperature: 208.04, target: 210 }],
        history: {
          extruder: [
            { time: now - 60_000, temperature: 200 },
            { time: now, temperature: 208 },
          ],
        },
        canCommand: true,
      },
    )
    expect(html).toContain('Tendência de')
    expect(html).toContain('<polyline')
    expect(html).toContain('208 °C')
  })

  it('draws the bed mesh legend with the colour scale component', async () => {
    const html = await renderFarmComponent(
      '../printer-detail/BedMeshPanel.vue',
      {
        mesh: {
          profile: 'default',
          min: [0, 0],
          max: [100, 100],
          rows: [
            [-0.1, 0, 0.1],
            [0, 0.2, 0.3],
            [0.1, 0.3, 0.5],
          ],
        },
        availability: {},
      },
    )
    expect(html).toContain('<figcaption>Escala de cores')
    expect(html).toContain('-0,100 mm')
    expect(html).toContain('0,500 mm')
    expect(html.match(/<li>/g)?.length).toBeGreaterThanOrEqual(5)
  })
})
