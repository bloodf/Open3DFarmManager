// SPDX-License-Identifier: MIT
// Camera, library and files screens: render and axe on every run. With
// DESIGN_SCREENSHOTS=1 it also writes the captures in
// docs/fullfarmmanager/design (DESIGN_PHASE=before|after).
import { mkdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import AxeBuilder from '@axe-core/playwright'
import type { Page } from '@playwright/test'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  createPageHarness,
  reply,
  type PageHarness,
  type Routes,
} from '../helpers/page-harness'

const FARM = '11111111-1111-4111-8111-111111111111'
const AGENT = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'

const item = (
  id: string,
  title: string,
  printerModel: string,
  filamentType: string,
  filamentColour: string,
  tags: string[],
) => ({
  id,
  title,
  tags,
  archived: false,
  createdAt: 1,
  latest: {
    id: `v-${id}`,
    itemId: id,
    versionNumber: 2,
    sizeBytes: 2 * 1024 * 1024,
    storageLocation: 'connector',
    agentId: AGENT,
    originalName: `${title}.gcode`,
    kind: 'gcode',
    plateCount: 2,
    metadata: {
      printerModel,
      slicer: 'OrcaSlicer',
      slicerVersion: '2.3',
      estimatedTimeSeconds: 5400,
      layerHeight: 0.2,
      tools: [
        {
          nozzleDiameter: 0.4,
          filamentType,
          filamentColour,
          filamentGrams: 42.5,
        },
      ],
    },
    hasThumbnail: false,
    notes: '',
    createdAt: Date.UTC(2026, 10, 1, 12),
    deletedAt: null,
    purgedAt: null,
  },
})

const libraryRoutes: Routes = {
  'GET /api/farms': reply({ farms: [{ farmId: FARM }] }),
  [`GET /api/farms/${FARM}/library/settings`]: reply({
    settings: {
      storageMode: 'connector',
      quotaBytes: 20 * 1024 ** 3,
      retentionDays: 30,
    },
    locations: [
      { location: 'connector', agentId: AGENT, files: 3, bytes: 6291456 },
      { location: 'server', agentId: null, files: 1, bytes: 1048576 },
    ],
    usage: { usedBytes: 7340032 },
    canManage: true,
  }),
  [`GET /api/farms/${FARM}/connectors`]: reply({
    connectors: [{ agentId: AGENT, status: 'approved' }],
  }),
  [`GET /api/farms/${FARM}/printer-profiles`]: reply({ profiles: [] }),
  [`GET /api/farms/${FARM}/printers`]: reply({ printers: [] }),
  [`GET /api/farms/${FARM}/library`]: reply({
    items: [
      item('1', 'Vaso espiral', 'Voron 2.4', 'PLA', '#1F4FE0', ['decoração']),
      item(
        '2',
        'Suporte de bancada com nome bem comprido',
        'Ender 3',
        'PETG',
        '#E86A24',
        ['oficina', 'fixação'],
      ),
      item('3', 'Caixa de eletrônica', 'Voron 2.4', 'ABS', '#202522', []),
    ],
    nextCursor: null,
  }),
}

// pause-metadata must echo the page origin, which is only known in the page.
const filesInit = `
  const native = window.fetch.bind(window)
  window.fetch = (input, init) => String(input).includes('/api/signalling/pause-metadata')
    ? Promise.resolve(new Response(JSON.stringify({ enabled: true, origin: location.origin }), { headers: { 'content-type': 'application/json' } }))
    : native(input, init)
`

type Screen = {
  id: 'view' | 'biblioteca' | 'arquivos'
  page: string
  routes: Routes
  init?: string
  ready: (page: Page) => Promise<unknown>
}

const screens: Screen[] = [
  {
    id: 'view',
    page: 'camera-view/index',
    routes: {
      'POST /api/camera-view': reply({ farmId: 'oficina', printerId: 'a1' }),
    },
    init: "history.replaceState(null, '', '/#bilhete')",
    ready: (page) => page.getByText('Câmera ao vivo.').waitFor(),
  },
  {
    id: 'biblioteca',
    page: 'biblioteca',
    routes: libraryRoutes,
    ready: (page) =>
      page.getByRole('heading', { name: 'Vaso espiral' }).waitFor(),
  },
  {
    id: 'arquivos',
    page: 'arquivos',
    routes: {},
    init: filesInit,
    ready: async (page) => {
      await page.getByLabel('Impressora', { exact: true }).selectOption('a1')
      await page.getByRole('button', { name: 'Consultar arquivos' }).click()
      await page.getByLabel('Arquivo para imprimir').waitFor()
    },
  },
]

const sizes = [
  ['desktop', 1440, 900],
  ['mobile', 390, 844],
] as const

describe('camera, library and files screens', () => {
  let harness: PageHarness

  beforeAll(async () => {
    const root = process.cwd()
    harness = await createPageHarness({
      replace: {
        [resolve(root, 'apps/farm/app/composables/useFarmView.ts')]: resolve(
          root,
          'tests/helpers/design-camera-library-view-stub.ts',
        ),
        [resolve(root, 'apps/farm/app/utils/webrtc/farm-pause-control.ts')]:
          resolve(root, 'tests/helpers/design-camera-library-control-stub.ts'),
        [resolve(root, 'apps/farm/app/composables/useReplayLive.ts')]: resolve(
          root,
          'tests/helpers/replay-live-stub.ts',
        ),
      },
    })
  }, 120_000)

  afterAll(async () => {
    await harness?.close()
  })

  it.each(screens)(
    'renders $id without axe violations or page overflow',
    async (screen) => {
      for (const [size, width, height] of sizes)
        for (const theme of ['light', 'dark'] as const) {
          const opened = await harness.open(screen.page, screen.routes, {
            width,
            init: `
              window.__replayLive = { info: {}, result: { outcome: 'not-sent' }, sent: [] }
              document.addEventListener('DOMContentLoaded', () => document.documentElement.setAttribute('data-theme', '${theme}'))
              ${screen.init ?? ''}
            `,
          })
          try {
            const { page } = opened
            await page.setViewportSize({ width, height })
            await page.emulateMedia({
              colorScheme: theme,
              reducedMotion: 'no-preference',
            })
            await screen.ready(page)
            await page.evaluate(() => {
              ;(document.activeElement as HTMLElement | null)?.blur()
              window.scrollTo(0, 0)
            })
            if (process.env.DESIGN_SCREENSHOTS === '1') {
              await mkdir('docs/fullfarmmanager/design', { recursive: true })
              await page.screenshot({
                path: `docs/fullfarmmanager/design/camera-${screen.id}-${process.env.DESIGN_PHASE ?? 'after'}-${size}-${theme}.png`,
                animations: 'disabled',
              })
            }
            expect
              .soft(
                await page.evaluate(() => document.documentElement.scrollWidth),
              )
              .toBe(width)
            expect
              .soft(
                (await new AxeBuilder({ page }).analyze()).violations.map(
                  ({ id, nodes }) => ({
                    id,
                    targets: nodes.map((node) => node.target.join(' ')),
                  }),
                ),
              )
              .toEqual([])
          } finally {
            await opened.close()
          }
        }
    },
    120_000,
  )
})
