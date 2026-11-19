// SPDX-License-Identifier: MIT
import { expect as pw, type Locator, type Page } from '@playwright/test'
import { describe, expect, it } from 'vitest'
import {
  RAW_ERROR,
  rawFailure,
  reply,
  visibleText,
  type OpenOptions,
  type PageHarness,
  type Routes,
} from '../page-harness'
import type { RegisterStates } from './types'

const FARM = '00000000-0000-4000-8000-000000000001'
const OTHER_FARM = '00000000-0000-4000-8000-000000000009'
const AGENT = '00000000-0000-4000-8000-000000000002'
const ASSIGNMENT = '00000000-0000-4000-8000-000000000003'
const KEY = 'voron-24'
const TIMEOUT = 30_000
const WAIT = 10_000

const printer = {
  assignmentId: ASSIGNMENT,
  agentId: AGENT,
  printerKey: KEY,
  status: 'active',
  connectorStatus: 'approved',
}
const printersPage = (printers: unknown[], canManage = true) =>
  reply({ printers, nextAfter: null, canManage })
const farmsPage = (...ids: string[]) =>
  reply({ farms: ids.map((farmId) => ({ farmId })), nextAfter: null })

/** The farm view reads these three; every page of this group starts there. */
const farmRoutes = (extra: Routes = {}): Routes => ({
  'GET /api/auth/me': reply({ accountId: 'account-one' }),
  'GET /api/farms': farmsPage(FARM),
  [`GET /api/farms/${FARM}/printers`]: printersPage([printer]),
  'GET /api/browser-devices': reply({
    currentAccountId: 'account-one',
    currentRole: 'owner',
    devices: [],
    nextAfter: null,
  }),
  [`GET /api/farms/${FARM}/printer-states`]: reply({ states: [] }),
  [`GET /api/farms/${FARM}/status-summary`]: summaryOf([]),
  ...extra,
})

const storedState = (ageMs: number) => ({
  assignmentId: ASSIGNMENT,
  printerKey: KEY,
  state: 'printing',
  progress: 0.4,
  temperatures: { toolCelsius: 205, bedCelsius: 60 },
  observedAt: Date.now() - ageMs,
})

/** The status-summary answer for printers shaped like `storedState`. */
function summaryOf(printers: ReturnType<typeof storedState>[]) {
  const counts: Record<string, number> = {}
  for (const printer of printers)
    counts[printer.state] = (counts[printer.state] ?? 0) + 1
  return reply({
    generatedAt: Date.now(),
    total: printers.length,
    counts,
    truncated: false,
    printers: printers.map((printer) => ({ ...printer, dataAgeMs: 0 })),
  })
}

type Opened = Awaited<ReturnType<PageHarness['open']>>

async function withPage(
  harness: PageHarness,
  pageName: string,
  routes: Routes,
  options: OpenOptions,
  body: (opened: Opened) => Promise<void>,
) {
  const opened = await harness.open(pageName, routes, options)
  try {
    await body(opened)
  } finally {
    await opened.close()
  }
}

const show = (locator: Locator) =>
  locator.first().waitFor({ state: 'visible', timeout: WAIT })
const attached = (locator: Locator) =>
  locator.first().waitFor({ state: 'attached', timeout: WAIT })
const gone = (locator: Locator) =>
  locator.first().waitFor({ state: 'detached', timeout: WAIT })
/** Stops window focus/visibility events, which make the farm view reload. */
const holdFocus = (page: Page) =>
  page.evaluate(() => {
    const stop = (event: Event) => event.stopImmediatePropagation()
    for (const type of ['focus', 'pageshow', 'pagehide'])
      window.addEventListener(type, stop, true)
    document.addEventListener('visibilitychange', stop, true)
  })
const skeletons = (page: Page) => page.locator('.skeleton')
const busy = (page: Page, text: string) =>
  page.locator('[aria-busy="true"]', { hasText: text })

/** Raw server text, stacks and status codes must never reach the user. */
async function expectClean(page: Page) {
  expect(await visibleText(page)).not.toMatch(RAW_ERROR)
}

/** The shared loading pattern: busy wrapper, status text and skeletons. */
async function expectLoading(page: Page, text: string) {
  await show(busy(page, text))
  const wrapper = busy(page, text).first()
  await pw(wrapper.getByRole('status')).toHaveText(new RegExp(text))
  expect(await wrapper.locator('.skeleton').count()).toBeGreaterThan(0)
  await expectClean(page)
}

/** A shared stale notice is a status region with the fixed pt-BR title. */
const staleNotice = (page: Page, text?: string | RegExp) =>
  page
    .locator('.stale')
    .filter({ hasText: 'Dados desatualizados' })
    .filter(text ? { hasText: text } : {})

const failing = (status = 500) => rawFailure(status)

export const register: RegisterStates = (harness) => {
  describe('farm page states', () => {
    it(
      'farm: loading',
      async () => {
        await withPage(
          harness(),
          'farm',
          farmRoutes({
            'GET /api/auth/me': {
              ...reply({ accountId: 'account-one' }),
              delayMs: 1500,
            },
          }),
          {},
          async ({ page }) => {
            await expectLoading(page, 'Carregando suas farms')
            await show(page.getByText(KEY))
            expect(await skeletons(page).count()).toBe(0)
            await expectClean(page)
          },
        )
      },
      TIMEOUT,
    )

    it(
      'farm: loading the inventory',
      async () => {
        await withPage(
          harness(),
          'farm',
          farmRoutes({
            [`GET /api/farms/${FARM}/printers`]: {
              ...printersPage([printer]),
              delayMs: 1500,
            },
          }),
          {},
          async ({ page }) => {
            await expectLoading(page, 'Carregando o cadastro de impressoras')
            await show(page.getByText(KEY))
            expect(await skeletons(page).count()).toBe(0)
          },
        )
      },
      TIMEOUT,
    )

    it(
      'farm: empty',
      async () => {
        await withPage(
          harness(),
          'farm',
          farmRoutes({ [`GET /api/farms/${FARM}/printers`]: printersPage([]) }),
          {},
          async ({ page }) => {
            await show(
              page.getByRole('heading', {
                name: 'Nenhuma impressora atribuída a esta farm.',
              }),
            )
            const link = page.getByRole('link', {
              name: 'Gerenciar atribuições',
            })
            await show(link)
            expect(await link.getAttribute('href')).toBe('/impressoras')
            expect(await skeletons(page).count()).toBe(0)
            await expectClean(page)
          },
        )
      },
      TIMEOUT,
    )

    it(
      'farm: error',
      async () => {
        await withPage(
          harness(),
          'farm',
          farmRoutes({ 'GET /api/auth/me': failing(503) }),
          {},
          async ({ page, setRoutes }) => {
            const alert = page.getByRole('alert')
            await show(alert)
            await pw(alert).toHaveText(
              'Não foi possível confirmar seus dados. Tente novamente.',
            )
            expect(
              await alert.evaluate((el) => el === document.activeElement),
            ).toBe(true)
            await show(
              page.getByRole('heading', {
                name: 'Não foi possível carregar suas farms',
              }),
            )
            expect(await skeletons(page).count()).toBe(0)
            await expectClean(page)
            setRoutes(farmRoutes())
            await page.getByRole('button', { name: 'Tentar novamente' }).click()
            await show(page.getByText(KEY))
            expect(await page.getByRole('alert').count()).toBe(0)
          },
        )
      },
      TIMEOUT,
    )

    it(
      'farm: stale',
      async () => {
        await withPage(
          harness(),
          'farm',
          // The stored snapshot only fills in printers the live rows do not own.
          farmRoutes({
            [`GET /api/farms/${FARM}/printers`]: printersPage([]),
            [`GET /api/farms/${FARM}/printer-states`]: reply({
              states: [storedState(120_000)],
            }),
          }),
          {},
          async ({ page }) => {
            const section = page.getByRole('region', {
              name: 'Última observação conhecida',
            })
            await show(section)
            const notice = section.getByRole('status')
            await pw(notice).toContainText('Dados desatualizados')
            await pw(notice).toContainText('somente leitura')
            await pw(section).toContainText('Observação com 2 min')
            // The notice describes the section, as the old paragraph did.
            expect(
              await section.evaluate((el) =>
                el.getAttribute('aria-describedby'),
              ),
            ).toBe('last-known-description')
            await expectClean(page)
          },
        )
        // A failed read of the stored states shows no notice and no raw text.
        await withPage(
          harness(),
          'farm',
          farmRoutes({
            [`GET /api/farms/${FARM}/printers`]: printersPage([]),
            [`GET /api/farms/${FARM}/printer-states`]: failing(500),
          }),
          {},
          async ({ page }) => {
            await show(page.getByText('Nenhuma impressora atribuída'))
            await page.waitForTimeout(300)
            expect(await staleNotice(page).count()).toBe(0)
            await expectClean(page)
          },
        )
      },
      TIMEOUT,
    )
  })

  describe('painel page states', () => {
    const painelRoutes = (extra: Routes = {}): Routes => ({
      'GET /api/farms': farmsPage(FARM),
      [`GET /api/farms/${FARM}/status-summary`]: summaryOf([storedState(1000)]),
      ...extra,
    })

    it(
      'painel: loading',
      async () => {
        await withPage(
          harness(),
          'painel',
          painelRoutes({
            'GET /api/farms': { ...farmsPage(FARM), delayMs: 1500 },
          }),
          {},
          async ({ page }) => {
            await expectLoading(page, 'Aguardando dados')
            await show(page.getByRole('heading', { name: KEY }))
            expect(await skeletons(page).count()).toBe(0)
          },
        )
      },
      TIMEOUT,
    )

    it(
      'painel: empty',
      async () => {
        await withPage(
          harness(),
          'painel',
          painelRoutes({
            [`GET /api/farms/${FARM}/status-summary`]: summaryOf([]),
          }),
          {},
          async ({ page }) => {
            await show(
              page.getByRole('heading', {
                name: 'Nenhuma impressora com estado registrado',
              }),
            )
            // A TV wall has no controls: the next action is text, not a link.
            await pw(page.locator('main')).toContainText(
              'Atribua uma impressora a um Connector',
            )
            expect(await page.locator('main a, main button').count()).toBe(0)
            expect(await skeletons(page).count()).toBe(0)
            await expectClean(page)
          },
        )
        await withPage(
          harness(),
          'painel',
          { 'GET /api/farms': reply({ farms: [], nextAfter: null }) },
          {},
          async ({ page }) => {
            await show(
              page.getByRole('heading', { name: 'Nenhuma farm disponível' }),
            )
            await pw(page.locator('main')).toContainText(
              'Entre com outra conta para ver o painel.',
            )
            expect(await page.locator('main a, main button').count()).toBe(0)
            expect(await skeletons(page).count()).toBe(0)
            await expectClean(page)
          },
        )
      },
      TIMEOUT,
    )

    it(
      'painel: error',
      async () => {
        await withPage(
          harness(),
          'painel',
          painelRoutes({ 'GET /api/farms': failing(500) }),
          { clock: true },
          async ({ page, setRoutes }) => {
            await show(
              page.getByRole('heading', { name: 'Painel indisponível' }),
            )
            await pw(page.locator('main')).toContainText(
              'Não foi possível carregar os estados das impressoras.',
            )
            expect(await skeletons(page).count()).toBe(0)
            expect(await page.getByText('Aguardando dados').count()).toBe(0)
            await expectClean(page)
            // No button on a TV wall: the next poll retries by itself.
            expect(await page.locator('main button').count()).toBe(0)
            setRoutes(painelRoutes())
            await page.clock.runFor(5_500)
            await show(page.getByRole('heading', { name: KEY }))
            expect(
              await page
                .getByRole('heading', { name: 'Painel indisponível' })
                .count(),
            ).toBe(0)
          },
        )
        await withPage(
          harness(),
          'painel',
          painelRoutes({ 'GET /api/farms': { status: 401, body: {} } }),
          {},
          async ({ page }) => {
            await show(
              page.getByRole('heading', { name: 'Painel indisponível' }),
            )
            await pw(page.locator('main')).toContainText(
              'Sessão indisponível. Entre novamente em outro dispositivo.',
            )
            await expectClean(page)
          },
        )
      },
      TIMEOUT,
    )

    it(
      'painel: stale',
      async () => {
        await withPage(
          harness(),
          'painel',
          painelRoutes(),
          { clock: true },
          async ({ page, setRoutes }) => {
            await show(page.getByRole('heading', { name: KEY }))
            await pw(page.locator('.kiosk__head')).toContainText(
              'Dados atualizados há',
            )
            expect(await staleNotice(page).count()).toBe(0)
            // The next poll fails: the old states stay, flagged as stale.
            setRoutes(
              painelRoutes({
                [`GET /api/farms/${FARM}/status-summary`]: failing(500),
              }),
            )
            await page.clock.runFor(5_500)
            const notice = page
              .locator('.stale')
              .filter({ hasText: 'Falha na atualização' })
            await show(notice)
            await pw(page.getByRole('heading', { name: KEY })).toBeVisible()
            await pw(page.locator('.kiosk__card--stale')).toHaveCount(1)
            expect(await skeletons(page).count()).toBe(0)
            await expectClean(page)
            // Without a new answer the age keeps growing and the cards say so.
            await page.clock.runFor(40_000)
            await pw(page.locator('.kiosk__head')).toContainText(
              /Dados atualizados há (4|5)\d s/,
            )
            await pw(page.locator('.kiosk__age')).toContainText(
              'Dados desatualizados',
            )
          },
        )
      },
      TIMEOUT,
    )
  })

  describe('rede page states', () => {
    const network = (connectors = true) =>
      reply({
        canManage: false,
        connectors: connectors
          ? [
              {
                agentId: AGENT,
                fingerprint: 'ab12',
                status: 'approved',
                lastSeenAt: Date.now(),
                health: { version: '1.0.0', storage: 'healthy' },
              },
            ]
          : [],
        printers: connectors
          ? [
              {
                assignmentId: ASSIGNMENT,
                agentId: AGENT,
                printerKey: KEY,
                displayName: null,
                link: {
                  state: 'connected',
                  lastSuccessAt: Date.now(),
                  p50Ms: 20,
                  p95Ms: 40,
                },
              },
            ]
          : [],
        discovered: [],
      })
    const redeRoutes = (extra: Routes = {}) =>
      farmRoutes({ [`GET /api/farms/${FARM}/network`]: network(), ...extra })

    it(
      'rede: loading',
      async () => {
        await withPage(
          harness(),
          'rede',
          redeRoutes({
            [`GET /api/farms/${FARM}/network`]: { ...network(), delayMs: 1500 },
          }),
          {},
          async ({ page }) => {
            await expectLoading(page, 'Carregando a rede')
            await show(page.getByText('Mostrando 2 de 2 itens.'))
            expect(await skeletons(page).count()).toBe(0)
          },
        )
        await withPage(
          harness(),
          'rede',
          redeRoutes({
            'GET /api/auth/me': {
              ...reply({ accountId: 'account-one' }),
              delayMs: 1500,
            },
          }),
          {},
          async ({ page }) => {
            await expectLoading(page, 'Carregando suas farms')
            await show(page.getByText('Mostrando 2 de 2 itens.'))
            expect(await skeletons(page).count()).toBe(0)
          },
        )
      },
      TIMEOUT,
    )

    it(
      'rede: empty',
      async () => {
        await withPage(
          harness(),
          'rede',
          redeRoutes({ [`GET /api/farms/${FARM}/network`]: network(false) }),
          {},
          async ({ page }) => {
            await show(
              page.getByRole('heading', {
                name: 'Nenhum Connector nesta farm.',
              }),
            )
            const link = page.getByRole('link', { name: 'Parear um Connector' })
            expect(await link.getAttribute('href')).toBe('/parear')
            expect(await skeletons(page).count()).toBe(0)
            await expectClean(page)
          },
        )
        // Two farms and none chosen: the page asks for a choice.
        await withPage(
          harness(),
          'rede',
          redeRoutes({ 'GET /api/farms': farmsPage(FARM, OTHER_FARM) }),
          {},
          async ({ page }) => {
            await show(
              page.getByRole('heading', { name: 'Nenhuma farm selecionada' }),
            )
            expect(
              await page
                .getByText('Selecione uma farm para ver a rede.')
                .count(),
            ).toBe(1)
            expect(await skeletons(page).count()).toBe(0)
          },
        )
        await withPage(
          harness(),
          'rede',
          redeRoutes({ 'GET /api/farms': farmsPage() }),
          {},
          async ({ page }) => {
            await show(
              page.getByRole('heading', { name: 'Nenhuma farm disponível' }),
            )
            await show(
              page.getByRole('link', { name: 'Entrar com outra conta' }),
            )
            expect(await skeletons(page).count()).toBe(0)
            await expectClean(page)
          },
        )
      },
      TIMEOUT,
    )

    it(
      'rede: error',
      async () => {
        await withPage(
          harness(),
          'rede',
          redeRoutes({ [`GET /api/farms/${FARM}/network`]: failing(500) }),
          {},
          async ({ page, setRoutes }) => {
            await show(page.getByRole('heading', { name: 'Rede indisponível' }))
            await pw(page.getByRole('alert')).toHaveText(
              'Não foi possível atualizar a rede da farm. Tente novamente.',
            )
            expect(await skeletons(page).count()).toBe(0)
            expect(await staleNotice(page).count()).toBe(0)
            await expectClean(page)
            setRoutes(redeRoutes())
            await page.getByRole('button', { name: 'Tentar novamente' }).click()
            await show(page.getByText('Mostrando 2 de 2 itens.'))
            expect(await page.getByRole('alert').count()).toBe(0)
          },
        )
        await withPage(
          harness(),
          'rede',
          redeRoutes({ 'GET /api/auth/me': failing(503) }),
          {},
          async ({ page, setRoutes }) => {
            await show(
              page.getByRole('heading', {
                name: 'Não foi possível carregar suas farms',
              }),
            )
            await pw(page.getByRole('alert')).toHaveText(
              'Não foi possível confirmar seus dados. Tente novamente.',
            )
            await expectClean(page)
            setRoutes(redeRoutes())
            await page.getByRole('button', { name: 'Tentar novamente' }).click()
            await show(page.getByText('Mostrando 2 de 2 itens.'))
          },
        )
      },
      TIMEOUT,
    )

    it(
      'rede: stale',
      async () => {
        await withPage(
          harness(),
          'rede',
          redeRoutes(),
          { clock: true },
          async ({ page, setRoutes }) => {
            await show(page.getByText('Mostrando 2 de 2 itens.'))
            await holdFocus(page)
            expect(await staleNotice(page).count()).toBe(0)
            // The 30 s refresh fails: the data read before stays, flagged.
            setRoutes(
              redeRoutes({ [`GET /api/farms/${FARM}/network`]: failing(500) }),
            )
            await page.clock.runFor(30_500)
            const notice = staleNotice(
              page,
              'Não foi possível atualizar a rede da farm. Tente novamente.',
            )
            await show(notice)
            await show(page.getByText('Mostrando 2 de 2 itens.'))
            await show(page.getByText(/Dados do servidor, lidos/))
            // A failed refresh is announced at once, as the notice itself.
            expect(await notice.getAttribute('role')).toBe('alert')
            expect(await page.getByRole('alert').count()).toBe(1)
            expect(
              await page
                .getByRole('heading', { name: 'Rede indisponível' })
                .count(),
            ).toBe(0)
            expect(await skeletons(page).count()).toBe(0)
            await expectClean(page)
            setRoutes(redeRoutes())
            await notice
              .getByRole('button', { name: 'Tentar novamente' })
              .click()
            await gone(notice)
          },
        )
      },
      TIMEOUT,
    )
  })

  describe('impressoras page states', () => {
    const farmSelect = (page: Page) => page.locator('#printer-farm')
    const farmOption = (page: Page) =>
      farmSelect(page).locator(`option[value="${FARM}"]`)
    const listRoutes = (extra: Routes = {}) =>
      farmRoutes({
        [`GET /api/farms/${FARM}/printers`]: printersPage([printer], false),
        ...extra,
      })
    const choose = async (page: Page) => {
      await attached(farmOption(page))
      await farmSelect(page).selectOption(FARM)
    }

    it(
      'impressoras: loading',
      async () => {
        await withPage(
          harness(),
          'impressoras',
          listRoutes({
            'GET /api/farms': { ...farmsPage(FARM), delayMs: 1500 },
          }),
          {},
          async ({ page }) => {
            await expectLoading(page, 'Carregando as impressoras')
            await attached(farmOption(page))
            expect(await skeletons(page).count()).toBe(0)
          },
        )
        await withPage(
          harness(),
          'impressoras',
          listRoutes({
            [`GET /api/farms/${FARM}/printers`]: {
              ...printersPage([printer], false),
              delayMs: 1500,
            },
          }),
          {},
          async ({ page }) => {
            await choose(page)
            await expectLoading(page, 'Carregando as atribuições')
            await show(page.getByText(KEY))
            expect(await skeletons(page).count()).toBe(0)
          },
        )
      },
      TIMEOUT,
    )

    it(
      'impressoras: empty',
      async () => {
        await withPage(
          harness(),
          'impressoras',
          listRoutes({ 'GET /api/farms': farmsPage() }),
          {},
          async ({ page }) => {
            await show(
              page.getByRole('heading', { name: 'Nenhuma farm disponível' }),
            )
            const link = page
              .getByRole('link', { name: 'Aprovar Connector' })
              .last()
            expect(await link.getAttribute('href')).toBe('/parear')
            expect(await skeletons(page).count()).toBe(0)
            await expectClean(page)
          },
        )
        await withPage(
          harness(),
          'impressoras',
          listRoutes({
            [`GET /api/farms/${FARM}/printers`]: printersPage([], false),
          }),
          {},
          async ({ page }) => {
            await choose(page)
            await show(
              page.getByRole('heading', {
                name: 'Nenhuma atribuição nesta página.',
              }),
            )
            await show(page.getByRole('link', { name: 'Ver Connectors' }))
            await show(
              page.getByText('Peça a um proprietário ou administrador'),
            )
            expect(await skeletons(page).count()).toBe(0)
            await expectClean(page)
          },
        )
      },
      TIMEOUT,
    )

    it(
      'impressoras: error',
      async () => {
        await withPage(
          harness(),
          'impressoras',
          listRoutes({ 'GET /api/farms': failing(500) }),
          {},
          async ({ page, setRoutes }) => {
            const alert = page.getByRole('alert')
            await show(alert)
            await pw(alert).toHaveText(
              'Não foi possível confirmar os dados. Entre novamente e atualize a página antes de continuar.',
            )
            expect(
              await alert.evaluate((el) => el === document.activeElement),
            ).toBe(true)
            await show(
              page.getByRole('heading', {
                name: 'Não foi possível carregar as impressoras',
              }),
            )
            expect(await skeletons(page).count()).toBe(0)
            expect(
              await page
                .getByRole('heading', { name: 'Nenhuma farm disponível' })
                .count(),
            ).toBe(0)
            await expectClean(page)
            setRoutes(listRoutes())
            await page.getByRole('button', { name: 'Tentar novamente' }).click()
            await attached(farmOption(page))
            expect(await page.getByRole('alert').count()).toBe(0)
          },
        )
      },
      TIMEOUT,
    )

    // n/a: the page never keeps old rows after a failed read; it clears them
    // and shows the error, so there is no "kept but old" data to flag.
    it(
      'impressoras: stale',
      async () => {
        await withPage(
          harness(),
          'impressoras',
          listRoutes(),
          {},
          async ({ page, setRoutes }) => {
            await choose(page)
            await show(page.getByText(KEY).first())
            setRoutes(
              listRoutes({ [`GET /api/farms/${FARM}/printers`]: failing(500) }),
            )
            await farmSelect(page).selectOption('')
            await farmSelect(page).selectOption(FARM)
            await show(page.getByRole('alert'))
            await pw(page.getByRole('alert')).toHaveText(
              'Não foi possível confirmar os dados. Entre novamente e atualize a página antes de continuar.',
            )
            const text = await visibleText(page)
            expect(text).not.toContain(KEY)
            expect(await staleNotice(page).count()).toBe(0)
            expect(await skeletons(page).count()).toBe(0)
            await expectClean(page)
          },
        )
      },
      TIMEOUT,
    )
  })

  describe('impressoras/[printerKey] page states', () => {
    const detail = 'impressoras/[printerKey]'
    const route = (printerKey = KEY): OpenOptions => ({
      route: { path: `/impressoras/${printerKey}`, params: { printerKey } },
    })

    it(
      'impressoras/[printerKey]: loading',
      async () => {
        await withPage(
          harness(),
          detail,
          farmRoutes({
            'GET /api/auth/me': {
              ...reply({ accountId: 'account-one' }),
              delayMs: 1500,
            },
          }),
          route(),
          async ({ page }) => {
            await expectLoading(page, 'Carregando a impressora')
            await show(page.getByRole('heading', { name: KEY }))
            expect(await skeletons(page).count()).toBe(0)
            await expectClean(page)
          },
        )
      },
      TIMEOUT,
    )

    it(
      'impressoras/[printerKey]: empty',
      async () => {
        await withPage(
          harness(),
          detail,
          farmRoutes(),
          route('inexistente'),
          async ({ page }) => {
            await show(
              page.getByRole('heading', { name: 'Impressora não encontrada' }),
            )
            await show(
              page.getByRole('heading', {
                name: 'Nenhuma impressora com este identificador',
              }),
            )
            const link = page.getByRole('link', {
              name: 'Ver impressoras da farm',
            })
            expect(await link.getAttribute('href')).toBe('/impressoras')
            expect(await skeletons(page).count()).toBe(0)
            await expectClean(page)
          },
        )
      },
      TIMEOUT,
    )

    it(
      'impressoras/[printerKey]: error',
      async () => {
        await withPage(
          harness(),
          detail,
          farmRoutes({ 'GET /api/auth/me': failing(503) }),
          route(),
          async ({ page, setRoutes }) => {
            await show(
              page.getByRole('heading', {
                name: 'Não foi possível carregar a impressora',
              }),
            )
            await pw(page.getByRole('alert')).toHaveText(
              'Não foi possível confirmar seus dados. Tente novamente.',
            )
            // The loading text must not linger once the read has failed.
            expect(
              await page.getByText('Carregando a impressora').count(),
            ).toBe(0)
            expect(await skeletons(page).count()).toBe(0)
            await expectClean(page)
            setRoutes(farmRoutes())
            await page.getByRole('button', { name: 'Tentar novamente' }).click()
            await show(page.getByRole('heading', { name: KEY }))
            expect(await page.getByRole('alert').count()).toBe(0)
          },
        )
      },
      TIMEOUT,
    )

    it(
      'impressoras/[printerKey]: stale',
      async () => {
        await withPage(
          harness(),
          detail,
          farmRoutes(),
          route(),
          async ({ page }) => {
            await show(page.getByRole('heading', { name: KEY }))
            // No direct connection here: the page is read-only and says so.
            const notice = staleNotice(
              page,
              'Sem conexão direta: exibindo o último valor conhecido',
            )
            await show(notice)
            await pw(notice).toContainText('Somente leitura.')
            await pw(
              page.getByRole('button', { name: 'Parada de emergência' }),
            ).toBeDisabled()
            expect(await skeletons(page).count()).toBe(0)
            await expectClean(page)
          },
        )
      },
      TIMEOUT,
    )
  })
}
