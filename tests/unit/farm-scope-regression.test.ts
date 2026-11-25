// SPDX-License-Identifier: MIT
import { join } from 'node:path'
import { expect as pw, type Page } from '@playwright/test'
import { afterAll, beforeAll, expect, it, vi } from 'vitest'
import {
  createPageHarness,
  reply,
  type PageHarness,
  type Routes,
} from '../helpers/page-harness'

vi.setConfig({ testTimeout: 30_000 })

const A = '00000000-0000-4000-8000-000000000001'
const B = '00000000-0000-4000-8000-000000000002'
const farmCases = [
  [A, 'A'],
  [B, 'B'],
] as const
const AGENT = '00000000-0000-4000-8000-000000000003'
const PRINTER = '00000000-0000-4000-8000-000000000004'
const baseRoutes: Routes = {
  'GET /api/auth/me': reply({ accountId: 'account-one' }),
  'GET /api/farms': reply({
    farms: [{ farmId: A }, { farmId: B }],
    nextAfter: null,
  }),
  'GET /api/browser-devices': reply({
    currentAccountId: 'account-one',
    currentRole: 'owner',
    devices: [],
    nextAfter: null,
  }),
}

const printer = (letter: string) => ({
  assignmentId: PRINTER,
  agentId: AGENT,
  printerKey: 'printer 1',
  displayName: `Bancada ${letter}`,
  status: 'active',
  connectorStatus: 'approved',
})
const library = (farm: string) => `/api/farms/${farm}/spool-library`
const filament = (name: string) => ({
  id: 1,
  name,
  material: 'PLA',
  color_hex: '112233',
  density: 1.24,
  diameter: 1.75,
  weight: 1000,
  extra: {},
})
const spool = (letter: string) => ({
  id: 1,
  filament: filament(`${letter} bobina`),
  remaining_weight: 120,
  used_weight: 0,
  used_length: 0,
  location: `${letter} local`,
  archived: false,
  extra: {},
})
const spoolRoutes: Routes = {
  ...baseRoutes,
  ...Object.fromEntries(
    farmCases.flatMap(([farm, letter]) => [
      [
        `GET ${library(farm)}/spools`,
        reply({
          items: [spool(letter)],
          total: 1,
          canWrite: true,
          canImport: true,
        }),
      ],
      [
        `GET ${library(farm)}/filaments`,
        reply({ items: [filament(`Catálogo ${letter}`)] }),
      ],
      [`GET ${library(farm)}/vendors`, reply({ items: [] })],
      [
        `GET ${library(farm)}/slots`,
        reply({
          assignments: [
            { spoolId: 1, printerId: `Bancada ${letter}`, unassignedAt: null },
          ],
        }),
      ],
    ]),
  ),
  [`POST /api/spool-finder/${A}/scan`]: reply({
    status: 'moved',
    spoolId: 1,
    to: 'Local registrado em A',
    message: 'Local atualizado em A',
  }),
}

declare const window: Window & {
  __pageRoute: { query: { farm?: string; q?: string } }
  __heldReply: { waiting: boolean; release: () => void }
  __receivedReplies: string[]
  __disconnectFarmFeed: () => void
}
const switchFarm = (page: Page) =>
  page.evaluate((farm) => {
    const { __pageRoute } = window
    __pageRoute.query = { ...__pageRoute.query, farm }
  }, B)

/** Hold the parsed response before delivering it to the component, even on abort. */
function holdReply(path: string, farm?: string) {
  return `
    window.__heldReply = { waiting: false };
    window.__receivedReplies = [];
    window.__beforePageFetchResult = (url, options) => {
      window.__receivedReplies.push(url);
      if (url !== ${JSON.stringify(path)}) return;
      if (${JSON.stringify(farm ?? null)} && options?.query?.farmId !== ${JSON.stringify(farm ?? null)}) return;
      return new Promise((release) => { window.__heldReply = { waiting: true, release } });
    };
  `
}

const waitForHeldReply = (page: Page) =>
  page.waitForFunction(() => window.__heldReply.waiting, undefined, {
    timeout: 5000,
  })
const deliverHeldReply = (page: Page) =>
  page.evaluate(async () => {
    window.__heldReply.release()
    // The response and the resulting Vue render run before the next frame.
    await new Promise(requestAnimationFrame)
  })

let harness: PageHarness
beforeAll(async () => {
  harness = await createPageHarness({
    replace: {
      [join(process.cwd(), 'apps/farm/app/composables/useFarmView.ts')]: join(
        process.cwd(),
        'tests/helpers/farm-scope-view-stub.ts',
      ),
    },
  })
}, 60_000)
afterAll(async () => {
  await harness?.close()
})

const routeA = { query: { farm: A } }

it('keeps the selected farm catalog when the previous catalog arrives late', async () => {
  const opened = await harness.open('bobinas/index', spoolRoutes, {
    route: routeA,
    init: holdReply(`${library(A)}/filaments`),
  })
  try {
    const { page } = opened
    await waitForHeldReply(page)
    await switchFarm(page)
    await pw(page.getByRole('heading', { name: 'B bobina #1' })).toBeVisible()
    await page.getByRole('button', { name: 'Nova bobina' }).click()
    const select = page.getByRole('dialog').getByLabel('Filamento')
    await pw(select.locator('option')).toHaveText([
      'Selecione um filamento',
      'Catálogo B (PLA)',
    ])
    await deliverHeldReply(page)
    await pw(select.locator('option')).toHaveText([
      'Selecione um filamento',
      'Catálogo B (PLA)',
    ])
  } finally {
    await opened.close()
  }
})

it('updates the spool search and reloads when the route query changes', async () => {
  const requestedQueries: (string | null)[] = []
  const routes: Routes = {
    ...spoolRoutes,
    [`GET ${library(A)}/spools`]: ({ url }) => {
      requestedQueries.push(url.searchParams.get('q'))
      return {
        body: {
          items: [spool('A')],
          total: 1,
          canWrite: true,
          canImport: true,
        },
      }
    },
  }
  const opened = await harness.open('bobinas/index', routes, {
    route: { query: { farm: A, q: 'Lote-314' } },
  })
  try {
    const { page } = opened
    const search = page.getByRole('searchbox', { name: 'Buscar' })
    await pw(search).toHaveValue('Lote-314')
    await pw.poll(() => requestedQueries).toContain('Lote-314')

    await page.evaluate(() => {
      window.__pageRoute.query.q = '#42'
    })
    await pw(search).toHaveValue('#42')
    await pw.poll(() => requestedQueries).toContain('#42')
  } finally {
    await opened.close()
  }
})

it('closes the previous farm spool editor before a same-id spool loads', async () => {
  const opened = await harness.open('bobinas/index', spoolRoutes, {
    route: routeA,
    init: holdReply(`${library(B)}/spools`),
  })
  try {
    const { page } = opened
    await page.getByRole('button', { name: 'Editar bobina #1' }).click()
    const editor = page.getByRole('dialog')
    await pw(editor).toBeVisible()
    await switchFarm(page)
    await waitForHeldReply(page)
    await pw(editor).not.toBeVisible()
    await deliverHeldReply(page)
    await pw(page.getByRole('heading', { name: 'B bobina #1' })).toBeVisible()
    await pw(editor).not.toBeVisible()
    expect(opened.calls('PATCH', `${library(B)}/spools/1`)).toBe(0)
  } finally {
    await opened.close()
  }
})

it('ignores finder slots that complete after the next farm is visible', async () => {
  const opened = await harness.open('bobinas/localizar', spoolRoutes, {
    route: routeA,
    init: holdReply(`${library(A)}/slots`),
  })
  try {
    const { page } = opened
    await waitForHeldReply(page)
    // Finish the spool fetch and its current-farm check before changing scope.
    await page.waitForFunction(
      (path) => window.__receivedReplies.includes(path),
      `${library(A)}/spools`,
      { timeout: 5000 },
    )
    await switchFarm(page)
    const results = page.getByRole('table')
    await pw(results).toContainText('B bobina')
    await deliverHeldReply(page)
    await pw(results).toContainText('B bobina')
    await pw(results).toContainText('Atribuída a Bancada B')
    await pw(results).not.toContainText('Bancada A')
  } finally {
    await opened.close()
  }
})

it('ignores the previous farm scan when both farms have the same spool ID', async () => {
  const opened = await harness.open('bobinas/localizar', spoolRoutes, {
    route: routeA,
    init: holdReply(`/api/spool-finder/${A}/scan`),
  })
  try {
    const { page } = opened
    const form = page.getByRole('form', {
      name: 'Registrar local por etiqueta',
    })
    await form.getByLabel('Local', { exact: true }).fill('Prateleira')
    await form.getByLabel('Etiqueta da bobina').fill('#1')
    await form.getByRole('button', { name: 'Registrar local' }).click()
    await waitForHeldReply(page)
    expect(opened.calls('POST', '/scan')).toBe(1)
    await switchFarm(page)
    const results = page.getByRole('table')
    await pw(results).toContainText('B local')
    await deliverHeldReply(page)
    await pw(results).toContainText('B local')
    await pw(results).not.toContainText('Local registrado em A')
    await pw(page.getByText('Local atualizado em A')).toHaveCount(0)
    expect(opened.calls('POST', '/scan')).toBe(1)
  } finally {
    await opened.close()
  }
})

it('clears the old history and replay action while the new farm is delayed', async () => {
  const opened = await harness.open(
    'historico',
    {
      ...baseRoutes,
      'GET /api/job-history': ({ url }) => {
        const letter = url.searchParams.get('farmId') === A ? 'A' : 'B'
        return reply({
          jobs: [
            {
              id: 'job-1',
              printerKey: 'printer 1',
              outcome: 'completed',
              filename: `${letter}.gcode`,
              librarySha256: 'a'.repeat(64),
              endedAt: Date.UTC(2026, 10, 2),
            },
          ],
          nextBefore: null,
        })
      },
    },
    {
      route: routeA,
      followRoute: true,
      init: holdReply('/api/job-history', B),
    },
  )
  try {
    const { page } = opened
    const original = page.getByRole('button', {
      name: 'Imprimir de novo A.gcode',
    })
    await pw(original).toBeVisible()
    await page.getByLabel('Farm', { exact: true }).selectOption(B)
    await waitForHeldReply(page)
    await pw(original).toHaveCount(0)
    await pw(page.getByText('A.gcode', { exact: true })).toHaveCount(0)
    await deliverHeldReply(page)
    await pw(
      page.getByRole('button', { name: 'Imprimir de novo B.gcode' }),
    ).toBeVisible()
  } finally {
    await opened.close()
  }
})

const farmRoutes: Routes = {
  ...baseRoutes,
  [`GET /api/farms/${B}/printers`]: reply({
    printers: [printer('B')],
    nextAfter: null,
    canManage: true,
  }),
}

it('writes the farm selected on the wall to the route', async () => {
  const opened = await harness.open('farm', farmRoutes, {
    route: { path: '/farm' },
    followRoute: true,
  })
  try {
    const { page } = opened
    await page.getByLabel('Farm atual').selectOption(B)
    await pw(
      page.getByRole('button', { name: 'Inspecionar Bancada B' }),
    ).toBeVisible()
    expect(await page.evaluate(() => window.__pageRoute.query.farm)).toBe(B)
  } finally {
    await opened.close()
  }
})

it('carries the selected farm on shell module and section links', async () => {
  const opened = await harness.open('farm', farmRoutes, {
    route: { path: '/farm', query: { farm: B } },
    layout: true,
  })
  try {
    const { page } = opened
    const modules = page.getByRole('navigation', {
      name: 'Navegação principal',
    })
    await pw(modules.getByRole('link', { name: 'Estoque' })).toHaveAttribute(
      'href',
      `/bobinas?farm=${B}`,
    )
    const section = page.getByRole('navigation', { name: 'Navegação da seção' })
    await pw(
      section.getByRole('link', { name: 'Impressoras', exact: true }),
    ).toHaveAttribute('href', `/impressoras?farm=${B}`)
  } finally {
    await opened.close()
  }
})

it('opens integrations in the farm named in the route', async () => {
  const opened = await harness.open(
    'integracoes',
    {
      ...baseRoutes,
      ...Object.fromEntries(
        farmCases.flatMap(([farm, letter]) => {
          const directory = `/api/farms/${farm}/integrations/apps`
          return [
            [
              `GET ${directory}`,
              reply({
                apps: [
                  {
                    id: 'integration-1',
                    name: `Aplicativo ${letter}`,
                    sandbox: false,
                    createdAt: 0,
                    revokedAt: null,
                  },
                ],
                printers: [],
              }),
            ],
            [`GET ${directory}/integration-1/grants`, reply({ grants: [] })],
          ]
        }),
      ),
    },
    { route: { query: { farm: B } } },
  )
  try {
    const { page } = opened
    await pw(page.getByRole('heading', { name: /Aplicativo [AB]/ })).toHaveText(
      'Aplicativo B',
    )
    await pw(page.getByLabel('Farm', { exact: true })).toHaveValue(B)
    expect(opened.calls('GET', `/api/farms/${A}/integrations/apps`)).toBe(0)
  } finally {
    await opened.close()
  }
})

it('keeps the selected printer inspector open after stored outage status appears', async () => {
  const assignment = printer('A')
  const opened = await harness.open(
    'farm',
    {
      ...baseRoutes,
      [`GET /api/farms/${A}/printer-states`]: reply({
        states: [
          {
            assignmentId: assignment.assignmentId,
            printerKey: assignment.printerKey,
            displayName: assignment.displayName,
            state: 'idle',
            observedAt: Date.now(),
            temperatures: {},
          },
        ],
      }),
    },
    {
      route: routeA,
      init: `window.__farmInventory = ${JSON.stringify({
        kind: 'ready',
        accountId: 'account-one',
        scope: { accountId: 'account-one', farmId: A, viewEpoch: 1 },
        farms: [{ farmId: A }],
        nextFarm: null,
        farmAfter: null,
        inventory: 'ready',
        feedScope: 'ready',
        rows: [
          {
            assignment,
            connection: 'authenticated',
            observation: null,
            localOrigin: null,
          },
        ],
        spools: [],
        nextPrinter: null,
        printerAfter: null,
        canManage: false,
        keys: { kind: 'unavailable', reason: 'missing' },
      })};`,
    },
  )
  try {
    const { page } = opened
    const tile = page.getByRole('button', { name: 'Inspecionar Bancada A' })
    await tile.click()
    const inspector = page.getByRole('dialog', {
      name: 'Inspeção da impressora',
    })
    await pw(inspector).toContainText('Conexão direta autenticada')
    await page.evaluate(() => window.__disconnectFarmFeed())
    await pw(tile).toHaveCount(0)
    expect(opened.calls('GET', '/printer-states')).toBeGreaterThan(0)
    await pw(inspector).toBeVisible()
    await pw(inspector).toContainText('Conexão direta indisponível')
    await pw(
      inspector.getByRole('link', { name: /Abrir detalhes da impressora/ }),
    ).toHaveAttribute('href', `/impressoras/printer%201?farm=${A}`)
  } finally {
    await opened.close()
  }
})
