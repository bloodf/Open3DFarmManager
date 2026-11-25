import { expect as browserExpect } from '@playwright/test'
import { afterAll, beforeAll, expect, it, vi } from 'vitest'
import { renderFarmComponent } from '../helpers/render-farm-component.ts'
import {
  createPageHarness,
  reply,
  type PageHarness,
} from '../helpers/page-harness'

vi.setConfig({ testTimeout: 30_000 })
let harness: PageHarness
beforeAll(async () => {
  harness = await createPageHarness()
}, 60_000)
afterAll(async () => {
  await harness?.close()
})

const now = Date.UTC(2026, 10, 19, 12)
const farmId = '00000000-0000-4000-8000-000000000001'

it('renders the chart examples on /ui-gallery', async () => {
  const opened = await harness.open('ui-gallery')
  try {
    const { page } = opened
    await browserExpect(
      page.getByRole('progressbar', {
        name: 'Progresso informado da impressão',
      }),
    ).toHaveAttribute('aria-valuetext', '42,5%')
    await browserExpect(
      page.getByText('Temperatura da mesa: 61,5 °C'),
    ).toBeVisible()
    await browserExpect(
      page
        .getByRole('img', { name: 'Tendência de temperatura da mesa' })
        .locator('polyline'),
    ).toBeVisible()
    await browserExpect(
      page.getByText('Escala de altura da malha', { exact: true }),
    ).toBeVisible()
  } finally {
    await opened.close()
  }
})

it.each(['painel', 'farm'])(
  'renders job progress and localized temperature on /%s',
  async (name) => {
    const observedAt = Date.now() - 1000
    const printer = {
      assignmentId: '00000000-0000-4000-8000-000000000011',
      printerKey: 'impressora-a',
      displayName: 'Bancada Alfa',
      state: 'printing',
      progress: 0.425,
      temperatures: { toolCelsius: 208.5 },
      observedAt,
    }
    const opened = await harness.open(name, {
      'GET /api/auth/me': reply({ accountId: 'account-one' }),
      'GET /api/farms': reply({ farms: [{ farmId }], nextAfter: null }),
      'GET /api/browser-devices': reply({
        currentAccountId: 'account-one',
        currentRole: 'owner',
        devices: [],
        nextAfter: null,
      }),
      [`GET /api/farms/${farmId}/printers`]: reply({
        printers: [],
        nextAfter: null,
        canManage: true,
      }),
      [`GET /api/farms/${farmId}/printer-states`]: reply({ states: [printer] }),
      [`GET /api/farms/${farmId}/status-summary`]: reply({
        generatedAt: Date.now(),
        total: 1,
        counts: { printing: 1 },
        truncated: false,
        printers: [{ ...printer, dataAgeMs: 1000 }],
      }),
    })
    try {
      const { page } = opened
      const card = page.getByRole('article').filter({
        hasText: name === 'farm' ? printer.printerKey : printer.displayName,
      })
      await browserExpect(card.getByRole('progressbar')).toHaveAttribute(
        'aria-valuetext',
        '42,5%',
      )
      await browserExpect(card).toContainText('208,5 °C')
    } finally {
      await opened.close()
    }
  },
)

it('renders job progress, duration and temperature history in the printer detail view', async () => {
  const html = await renderFarmComponent(
    '../printer-detail/PrinterDetailDashboard.vue',
    {
      name: 'Impressora A',
      stateLabel: 'Imprimindo',
      stateTone: 'printing',
      connectorLabel: 'Conexão direta',
      live: true,
      capabilities: ['job', 'heaters'],
      heaters: [{ name: 'extruder', temperature: 208.5 }],
      history: {
        extruder: [
          { time: now - 1000, temperature: 200 },
          { time: now, temperature: 208.5 },
        ],
      },
      printStatus: {
        capabilities: ['job'],
        detail: {
          print: {
            state: 'printing',
            file: 'suporte.gcode',
            elapsedSeconds: 3661,
          },
          virtualFile: { progress: 0.425 },
        },
      },
      canCommand: false,
      canEmergencyStop: false,
    },
  )
  expect(html).toContain('suporte.gcode')
  expect(html).toContain('aria-valuetext="42,5%"')
  expect(html).toContain('1 h 1 min 1 s')
  expect(html).toContain('208,5 °C')
  expect(html).toMatch(
    /aria-label="Tendência de temperatura de [^"]+"><polyline/,
  )
})

it('uses the heightmap colors and localized heights in the bed mesh legend', async () => {
  const html = await renderFarmComponent('../printer-detail/BedMeshPanel.vue', {
    mesh: {
      rows: [
        [-0.2, 0],
        [0.1, 0.2],
      ],
    },
    availability: {},
  })
  expect(html).toContain('<figcaption>Escala de cores da malha</figcaption>')
  expect(html).toMatch(
    /fill="rgb\(68, 1, 84\)"[^>]*><\/rect><\/svg>\s*-0,200 mm/,
  )
  expect(html).toMatch(
    /fill="rgb\(253, 231, 37\)"[^>]*><\/rect><\/svg>\s*0,200 mm/,
  )
})
