// SPDX-License-Identifier: MIT
import type { Page } from '@playwright/test'
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

const FARM = '11111111-1111-4111-8111-111111111111'
const ACCOUNT = { accountId: 'account-1' }
const WAIT = { timeout: 15_000 }

/** Opens a page, runs the check and always closes it. */
async function withPage(
  harness: () => PageHarness,
  name: string,
  routes: Routes,
  check: (opened: Awaited<ReturnType<PageHarness['open']>>) => Promise<void>,
  options?: OpenOptions,
) {
  const opened = await harness().open(name, routes, options)
  try {
    await check(opened)
  } finally {
    await opened.close()
  }
}

const noRawError = async (page: Page) =>
  expect(await visibleText(page)).not.toMatch(RAW_ERROR)
const busy = (page: Page) => page.locator('div[aria-busy="true"]')
const skeletons = (page: Page) => page.locator('.skeleton')
const focusedRole = (page: Page) =>
  page.evaluate(() => document.activeElement?.getAttribute('role'))

// ---------------------------------------------------------------- biblioteca

const item = (id: string, title: string) => ({
  id,
  title,
  tags: [],
  archived: false,
  createdAt: 1,
  latest: {
    id: `v-${id}`,
    itemId: id,
    versionNumber: 1,
    sizeBytes: 1024,
    storageLocation: 'server',
    agentId: null,
    originalName: `${title}.gcode`,
    kind: 'gcode',
    plateCount: 1,
    metadata: {
      printerModel: 'Voron 2.4',
      slicer: 'OrcaSlicer',
      estimatedTimeSeconds: 5400,
      tools: [],
    },
    hasThumbnail: false,
    notes: '',
    createdAt: 1,
    deletedAt: null,
    purgedAt: null,
  },
})
const libraryRoutes = (library: Routes[string]): Routes => ({
  'GET /api/farms': reply({ farms: [{ farmId: FARM }] }),
  [`GET /api/farms/${FARM}/library/settings`]: reply({
    settings: {
      storageMode: 'server',
      quotaBytes: 1024 ** 3,
      retentionDays: 30,
    },
    locations: [],
    usage: { usedBytes: 0 },
    canManage: true,
  }),
  [`GET /api/farms/${FARM}/connectors`]: reply({ connectors: [] }),
  [`GET /api/farms/${FARM}/printer-profiles`]: reply({ profiles: [] }),
  [`GET /api/farms/${FARM}/library`]: library,
})
const libraryOk = reply({
  items: [item('1', 'Vaso espiral')],
  nextCursor: null,
})

const registerBiblioteca = (harness: () => PageHarness) =>
  describe('page states: biblioteca', () => {
    it('biblioteca: loading', async () => {
      const routes = libraryRoutes({
        delayMs: 1_000,
        body: { items: [], nextCursor: null },
      })
      await withPage(harness, 'biblioteca', routes, async ({ page }) => {
        await page.getByText('Carregando a biblioteca…').waitFor(WAIT)
        expect(await busy(page).getByRole('status').innerText()).toContain(
          'Carregando a biblioteca…',
        )
        expect(await skeletons(page).count()).toBe(3)
        await noRawError(page)
        // Nothing but the loading block stands in for the list.
        expect(
          await page
            .getByRole('heading', { name: 'A biblioteca está vazia' })
            .count(),
        ).toBe(0)
        await page
          .getByRole('heading', { name: 'A biblioteca está vazia' })
          .waitFor(WAIT)
        expect(await skeletons(page).count()).toBe(0)
      })
    })

    it('biblioteca: empty', async () => {
      await withPage(
        harness,
        'biblioteca',
        libraryRoutes(reply({ items: [], nextCursor: null })),
        async ({ page }) => {
          await page
            .getByRole('heading', { name: 'A biblioteca está vazia' })
            .waitFor(WAIT)
          expect(
            await page
              .getByText('Envie um arquivo .gcode ou .3mf para começar.')
              .count(),
          ).toBe(1)
          // Filtered and empty is a different message with a way out.
          await page.getByLabel('Título').fill('nada')
          await page.getByRole('button', { name: 'Buscar' }).click()
          await page
            .getByRole('heading', { name: 'Nenhum item encontrado' })
            .waitFor(WAIT)
          await page.getByRole('button', { name: 'Limpar filtros' }).click()
          await page
            .getByRole('heading', { name: 'A biblioteca está vazia' })
            .waitFor(WAIT)
          await noRawError(page)
        },
      )
      // An account without a farm: empty state that points to the farms page.
      await withPage(
        harness,
        'biblioteca',
        { 'GET /api/farms': reply({ farms: [] }) },
        async ({ page }) => {
          await page
            .getByRole('heading', { name: 'Nenhuma farm disponível' })
            .waitFor(WAIT)
          expect(
            await page
              .getByRole('link', { name: 'Ir para farms' })
              .getAttribute('href'),
          ).toBe('/farm')
          expect(await skeletons(page).count()).toBe(0)
          expect(await page.getByRole('alert').count()).toBe(0)
        },
      )
    })

    it('biblioteca: error', async () => {
      await withPage(
        harness,
        'biblioteca',
        libraryRoutes(rawFailure(500)),
        async ({ page, setRoutes }) => {
          const alert = page.getByRole('alert')
          await alert
            .getByRole('heading', { name: 'Biblioteca indisponível' })
            .waitFor(WAIT)
          expect(await alert.innerText()).toContain(
            'Não foi possível carregar a biblioteca. Tente novamente.',
          )
          await noRawError(page)
          expect(await skeletons(page).count()).toBe(0)
          setRoutes(libraryRoutes(libraryOk))
          await alert.getByRole('button', { name: 'Tentar novamente' }).click()
          await page
            .getByRole('heading', { name: 'Vaso espiral' })
            .waitFor(WAIT)
          expect(await page.getByRole('alert').count()).toBe(0)
        },
      )
      // The farm list failing is also a plain message with retry, never raw text.
      await withPage(
        harness,
        'biblioteca',
        { 'GET /api/farms': rawFailure(503) },
        async ({ page }) => {
          await page
            .getByRole('heading', { name: 'Biblioteca indisponível' })
            .waitFor(WAIT)
          expect(
            await page
              .getByRole('button', { name: 'Tentar novamente' })
              .count(),
          ).toBe(1)
          await noRawError(page)
        },
      )
    })

    it('biblioteca: stale', async () => {
      await withPage(
        harness,
        'biblioteca',
        libraryRoutes(libraryOk),
        async ({ page, setRoutes }) => {
          await page
            .getByRole('heading', { name: 'Vaso espiral' })
            .waitFor(WAIT)
          expect(await page.getByText('Lista desatualizada').count()).toBe(0)
          setRoutes(libraryRoutes(rawFailure(500)))
          await page.getByRole('button', { name: 'Buscar' }).click()
          const notice = page
            .locator('.stale')
            .filter({ hasText: 'Lista desatualizada' })
          await notice.waitFor(WAIT)
          // The last list stays on screen, flagged as old, with a retry.
          await page
            .getByRole('heading', { name: 'Vaso espiral' })
            .waitFor(WAIT)
          expect(await notice.innerText()).toContain(
            'Mostrando a última lista carregada',
          )
          expect(
            await page
              .getByRole('heading', { name: 'Biblioteca indisponível' })
              .count(),
          ).toBe(0)
          await noRawError(page)
          setRoutes(libraryRoutes(libraryOk))
          await notice.getByRole('button', { name: 'Tentar novamente' }).click()
          await notice.waitFor({ state: 'detached', ...WAIT })
          await page
            .getByRole('heading', { name: 'Vaso espiral' })
            .waitFor(WAIT)
        },
      )
    })
  })

// ----------------------------------------------------------------- historico

const job = {
  id: 'job-1',
  printerKey: 'impressora-1',
  outcome: 'completed',
  filename: 'cubo.gcode',
  printDurationSeconds: 600,
  endedAt: Date.UTC(2026, 10, 1, 15),
}
const historyRoutes = (jobs: Routes[string]): Routes => ({
  'GET /api/farms': reply({ farms: [{ farmId: FARM }] }),
  'GET /api/job-history': jobs,
})
const historyOk = reply({ jobs: [job], nextBefore: null })

const registerHistorico = (harness: () => PageHarness) =>
  describe('page states: historico', () => {
    it('historico: loading', async () => {
      await withPage(
        harness,
        'historico',
        historyRoutes({ delayMs: 1_000, body: { jobs: [], nextBefore: null } }),
        async ({ page }) => {
          await busy(page).getByText('Consultando histórico…').waitFor(WAIT)
          expect(await busy(page).getByRole('status').count()).toBe(1)
          expect(await skeletons(page).count()).toBe(3)
          expect(await page.getByRole('table').count()).toBe(0)
          await noRawError(page)
          await page
            .getByRole('heading', { name: 'Nenhum trabalho finalizado' })
            .waitFor(WAIT)
          expect(await skeletons(page).count()).toBe(0)
        },
      )
    })

    it('historico: empty', async () => {
      await withPage(
        harness,
        'historico',
        historyRoutes(reply({ jobs: [], nextBefore: null })),
        async ({ page }) => {
          await page
            .getByRole('heading', { name: 'Nenhum trabalho finalizado' })
            .waitFor(WAIT)
          expect(
            await page
              .getByRole('link', { name: 'Ver impressoras' })
              .getAttribute('href'),
          ).toBe('/impressoras')
          expect(await page.getByRole('table').count()).toBe(0)
          expect(
            await page
              .getByRole('heading', { name: 'Histórico indisponível' })
              .count(),
          ).toBe(0)
        },
      )
      await withPage(
        harness,
        'historico',
        { 'GET /api/farms': reply({ farms: [] }) },
        async ({ page }) => {
          await page
            .getByRole('heading', { name: 'Nenhuma farm disponível' })
            .waitFor(WAIT)
          expect(await skeletons(page).count()).toBe(0)
        },
      )
    })

    it('historico: error', async () => {
      await withPage(
        harness,
        'historico',
        historyRoutes(rawFailure(500)),
        async ({ page, setRoutes }) => {
          const alert = page.getByRole('alert')
          await alert
            .getByRole('heading', { name: 'Histórico indisponível' })
            .waitFor(WAIT)
          expect(await alert.innerText()).toContain(
            'Não foi possível consultar o histórico. Tente novamente.',
          )
          // Focus moves to the error summary, as before.
          expect(await focusedRole(page)).toBe('alert')
          await noRawError(page)
          setRoutes(historyRoutes(historyOk))
          await alert.getByRole('button', { name: 'Tentar novamente' }).click()
          await page.getByRole('cell', { name: 'cubo.gcode' }).waitFor(WAIT)
          expect(await alert.getByRole('heading').count()).toBe(0)
        },
      )
      // An expired session says so and offers the sign-in link.
      await withPage(
        harness,
        'historico',
        historyRoutes(
          reply({ message: 'token expirado em /srv/app.js:1:1' }, 401),
        ),
        async ({ page }) => {
          const alert = page.getByRole('alert')
          await alert.getByText('Sua sessão não está disponível').waitFor(WAIT)
          expect(
            await alert
              .getByRole('link', { name: 'Entrar na conta' })
              .getAttribute('href'),
          ).toBe('/entrar')
          await noRawError(page)
        },
      )
    })

    // The page discards authorized rows on a failed refetch by design, so there
    // is no kept-but-old data to flag: the failure replaces the rows.
    it('historico: stale', async () => {
      await withPage(
        harness,
        'historico',
        historyRoutes(historyOk),
        async ({ page, setRoutes }) => {
          await page.getByRole('cell', { name: 'cubo.gcode' }).waitFor(WAIT)
          setRoutes(historyRoutes(rawFailure(500)))
          await page
            .getByRole('button', { name: 'Atualizar histórico' })
            .click()
          await page
            .getByRole('heading', { name: 'Histórico indisponível' })
            .waitFor(WAIT)
          expect(await page.getByRole('table').count()).toBe(0)
          expect(await page.getByText('cubo.gcode').count()).toBe(0)
          expect(await page.getByText('Dados desatualizados').count()).toBe(0)
          await noRawError(page)
        },
      )
    })
  })

// ------------------------------------------------------------------ spoolman

const spoolmanRoutes = (over: Routes = {}): Routes => ({
  'GET /api/farms': reply({ farms: [{ farmId: FARM }] }),
  [`GET /api/farms/${FARM}/spoolman`]: reply({ settings: [], canManage: true }),
  [`GET /api/farms/${FARM}/connectors`]: reply({ connectors: [] }),
  ...over,
})

const registerSpoolman = (harness: () => PageHarness) =>
  describe('page states: spoolman', () => {
    it('spoolman: loading', async () => {
      await withPage(
        harness,
        'spoolman',
        spoolmanRoutes({
          'GET /api/farms': {
            delayMs: 1_000,
            body: { farms: [{ farmId: FARM }] },
          },
        }),
        async ({ page }) => {
          await busy(page).getByText('Carregando o Spoolman…').waitFor(WAIT)
          expect(await busy(page).getByRole('status').count()).toBe(1)
          expect(await skeletons(page).count()).toBe(3)
          expect(await page.getByLabel('Endereço do Spoolman').count()).toBe(0)
          await noRawError(page)
          await page.getByLabel('Endereço do Spoolman').waitFor(WAIT)
          expect(await skeletons(page).count()).toBe(0)
        },
      )
    })

    it('spoolman: empty', async () => {
      await withPage(
        harness,
        'spoolman',
        spoolmanRoutes(),
        async ({ page }) => {
          await page
            .getByRole('heading', { name: 'Nenhum Spoolman configurado' })
            .waitFor(WAIT)
          expect(
            await page
              .getByText('Informe o endereço do Spoolman no formulário acima')
              .count(),
          ).toBe(1)
          expect(await page.getByRole('alert').count()).toBe(0)
        },
      )
      // Read-only member: the next step is to ask an administrator.
      await withPage(
        harness,
        'spoolman',
        spoolmanRoutes({
          [`GET /api/farms/${FARM}/spoolman`]: reply({
            settings: [],
            canManage: false,
          }),
        }),
        async ({ page }) => {
          await page
            .getByRole('heading', { name: 'Nenhum Spoolman configurado' })
            .waitFor(WAIT)
          expect(
            await page
              .getByText('Peça a um proprietário ou administrador')
              .count(),
          ).toBe(1)
        },
      )
      await withPage(
        harness,
        'spoolman',
        { 'GET /api/farms': reply({ farms: [] }) },
        async ({ page }) => {
          await page
            .getByRole('heading', { name: 'Nenhuma farm disponível' })
            .waitFor(WAIT)
          expect(
            await page
              .getByRole('link', { name: 'Ir para farms' })
              .getAttribute('href'),
          ).toBe('/farm')
          expect(await page.getByRole('alert').count()).toBe(0)
          expect(await skeletons(page).count()).toBe(0)
        },
      )
    })

    it('spoolman: error', async () => {
      await withPage(
        harness,
        'spoolman',
        spoolmanRoutes({ 'GET /api/farms': rawFailure(500) }),
        async ({ page, setRoutes }) => {
          const alert = page.getByRole('alert')
          await alert
            .getByRole('heading', { name: 'Spoolman indisponível' })
            .waitFor(WAIT)
          expect(await alert.innerText()).toContain(
            'Não foi possível carregar o Spoolman. Tente novamente.',
          )
          expect(await focusedRole(page)).toBe('alert')
          expect(await skeletons(page).count()).toBe(0)
          await noRawError(page)
          setRoutes(spoolmanRoutes())
          await alert.getByRole('button', { name: 'Tentar novamente' }).click()
          await page.getByLabel('Endereço do Spoolman').waitFor(WAIT)
          expect(await page.getByRole('alert').count()).toBe(0)
        },
      )
      await withPage(
        harness,
        'spoolman',
        spoolmanRoutes({ 'GET /api/farms': reply({}, 401) }),
        async ({ page }) => {
          await page
            .getByText('Entre na sua conta para configurar o Spoolman.')
            .waitFor(WAIT)
          await noRawError(page)
        },
      )
    })

    // n/a: the page keeps no previously loaded data to show as old. A failed
    // load hides the form and the saved table instead of keeping them.
    it('spoolman: stale', async () => {
      await withPage(
        harness,
        'spoolman',
        spoolmanRoutes({
          [`GET /api/farms/${FARM}/spoolman`]: rawFailure(500),
        }),
        async ({ page }) => {
          await page
            .getByRole('heading', { name: 'Spoolman indisponível' })
            .waitFor(WAIT)
          expect(await page.getByRole('table').count()).toBe(0)
          expect(await page.getByLabel('Endereço do Spoolman').count()).toBe(0)
          expect(await page.getByText('Dados desatualizados').count()).toBe(0)
          expect(await skeletons(page).count()).toBe(0)
          await noRawError(page)
        },
      )
    })
  })

// ------------------------------------------------------------------ arquivos

const filesRoutes = (over: Routes = {}): Routes => ({
  'GET /api/auth/me': reply(ACCOUNT),
  'GET /api/farms': reply({ farms: [{ farmId: FARM }], nextAfter: null }),
  [`GET /api/farms/${FARM}/printers`]: reply({
    printers: [],
    nextAfter: null,
    canManage: false,
  }),
  'GET /api/browser-devices': reply({}, 404),
  'GET /api/signalling/pause-metadata': reply({ enabled: false }),
  ...over,
})

const registerArquivos = (harness: () => PageHarness) =>
  describe('page states: arquivos', () => {
    it('arquivos: loading', async () => {
      await withPage(
        harness,
        'arquivos',
        filesRoutes({
          'GET /api/auth/me': { delayMs: 1_000, body: ACCOUNT },
        }),
        async ({ page }) => {
          await busy(page).getByText('Carregando farms…').waitFor(WAIT)
          expect(await busy(page).getByRole('status').count()).toBe(1)
          expect(await skeletons(page).count()).toBe(3)
          expect(await page.getByLabel('Farm', { exact: true }).count()).toBe(0)
          await noRawError(page)
          await page.getByLabel('Farm', { exact: true }).waitFor(WAIT)
          // The printer inventory loads next, with its own skeleton.
          await page
            .getByRole('heading', { name: 'Nenhuma impressora nesta página' })
            .waitFor(WAIT)
          expect(await skeletons(page).count()).toBe(0)
        },
      )
    })

    it('arquivos: empty', async () => {
      await withPage(
        harness,
        'arquivos',
        filesRoutes({
          'GET /api/farms': reply({ farms: [], nextAfter: null }),
        }),
        async ({ page }) => {
          await page
            .getByRole('heading', { name: 'Nenhuma farm nesta página' })
            .waitFor(WAIT)
          expect(
            await page
              .getByRole('link', { name: 'Ir para farms' })
              .getAttribute('href'),
          ).toBe('/farm')
          expect(await page.getByRole('alert').count()).toBe(0)
        },
      )
      // Farm without printers, and a printer without listed files.
      await withPage(harness, 'arquivos', filesRoutes(), async ({ page }) => {
        await page
          .getByRole('heading', { name: 'Nenhuma impressora nesta página' })
          .waitFor(WAIT)
        expect(
          await page
            .getByRole('link', { name: 'Ir para impressoras' })
            .getAttribute('href'),
        ).toBe('/impressoras')
        await page
          .getByRole('heading', { name: 'Nenhum arquivo listado' })
          .waitFor(WAIT)
        expect(
          await page
            .getByText(
              'Consulte os arquivos da impressora ou envie um arquivo.',
            )
            .count(),
        ).toBe(1)
        expect(await skeletons(page).count()).toBe(0)
        await noRawError(page)
      })
    })

    it('arquivos: error', async () => {
      await withPage(
        harness,
        'arquivos',
        filesRoutes({ 'GET /api/auth/me': rawFailure(500) }),
        async ({ page, setRoutes }) => {
          const alert = page.getByRole('alert')
          await alert
            .getByRole('heading', { name: 'Arquivos indisponíveis' })
            .waitFor(WAIT)
          expect(await alert.innerText()).toContain(
            'Não foi possível carregar suas farms. Tente novamente.',
          )
          expect(
            await alert
              .getByRole('link', { name: 'Entrar' })
              .getAttribute('href'),
          ).toBe('/entrar')
          expect(await skeletons(page).count()).toBe(0)
          await noRawError(page)
          setRoutes(filesRoutes())
          await alert.getByRole('button', { name: 'Tentar novamente' }).click()
          await page.getByLabel('Farm', { exact: true }).waitFor(WAIT)
          expect(await page.getByRole('alert').count()).toBe(0)
        },
      )
      await withPage(
        harness,
        'arquivos',
        filesRoutes({
          'GET /api/auth/me': reply(
            { message: 'jwt expired at /srv/x.js:3:9' },
            401,
          ),
        }),
        async ({ page }) => {
          await page.getByText('Sua sessão não está ativa').waitFor(WAIT)
          await noRawError(page)
        },
      )
    })

    // n/a: the page never shows kept-but-old data. It only gates actions on
    // live state; when a revalidation fails the whole view is replaced by the
    // error state, so no farm, printer or file list survives.
    it('arquivos: stale', async () => {
      await withPage(
        harness,
        'arquivos',
        filesRoutes(),
        async ({ page, setRoutes }) => {
          await page
            .getByRole('heading', { name: 'Nenhuma impressora nesta página' })
            .waitFor(WAIT)
          setRoutes(filesRoutes({ 'GET /api/auth/me': rawFailure(500) }))
          await page.evaluate(() => window.dispatchEvent(new Event('focus')))
          await page
            .getByRole('heading', { name: 'Arquivos indisponíveis' })
            .waitFor(WAIT)
          expect(await page.getByLabel('Farm', { exact: true }).count()).toBe(0)
          expect(
            await page
              .getByRole('heading', { name: 'Nenhuma impressora nesta página' })
              .count(),
          ).toBe(0)
          expect(await page.getByText('Dados desatualizados').count()).toBe(0)
          expect(await skeletons(page).count()).toBe(0)
          await noRawError(page)
        },
      )
    })
  })

// ------------------------------------------------------------- compatibilidade

const registerCompatibilidade = (harness: () => PageHarness) =>
  describe('page states: compatibilidade', () => {
    // n/a: the catalog is bundled with the page, so there is nothing to wait for.
    it('compatibilidade: loading', async () => {
      await withPage(
        harness,
        'compatibilidade',
        {},
        async ({ page, calls }) => {
          await page
            .getByRole('heading', {
              name: 'Compatibilidade de impressoras',
              level: 1,
            })
            .waitFor(WAIT)
          expect(await page.getByRole('status').innerText()).toMatch(
            /^[1-9]\d* resultado\(s\)$/,
          )
          expect(await busy(page).count()).toBe(0)
          expect(await skeletons(page).count()).toBe(0)
          expect(calls('GET', '/api')).toBe(0)
        },
      )
    })

    it('compatibilidade: empty', async () => {
      await withPage(harness, 'compatibilidade', {}, async ({ page }) => {
        const search = page.getByLabel('Buscar marca ou modelo')
        await search.fill('zzzz-sem-modelo')
        await page
          .getByRole('heading', { name: 'Nenhum modelo encontrado' })
          .waitFor(WAIT)
        expect(await page.getByRole('status').innerText()).toBe(
          '0 resultado(s)',
        )
        expect(await page.locator('section[aria-labelledby]').count()).toBe(0)
        // The next action restores the catalog.
        await page.getByRole('button', { name: 'Limpar busca' }).click()
        expect(await search.inputValue()).toBe('')
        expect(
          await page
            .getByRole('heading', { name: 'Nenhum modelo encontrado' })
            .count(),
        ).toBe(0)
        expect(
          await page.locator('section[aria-labelledby]').count(),
        ).toBeGreaterThan(0)
      })
    })

    // n/a: no request is made, so nothing can fail. Assert that no error
    // surface or raw text exists.
    it('compatibilidade: error', async () => {
      await withPage(
        harness,
        'compatibilidade',
        {},
        async ({ page, calls }) => {
          await page
            .getByRole('heading', {
              name: 'Compatibilidade de impressoras',
              level: 1,
            })
            .waitFor(WAIT)
          expect(await page.getByRole('alert').count()).toBe(0)
          expect(calls('GET', '/api')).toBe(0)
          expect(
            await page.getByRole('heading', { name: /indisponível/i }).count(),
          ).toBe(0)
          await noRawError(page)
        },
      )
    })

    // n/a: the catalog ships with the page and is never refetched, so it
    // cannot be old data shown after a failed refresh.
    it('compatibilidade: stale', async () => {
      await withPage(harness, 'compatibilidade', {}, async ({ page }) => {
        await page
          .getByRole('heading', {
            name: 'Compatibilidade de impressoras',
            level: 1,
          })
          .waitFor(WAIT)
        expect(await page.getByText('Dados desatualizados').count()).toBe(0)
        expect(await page.getByText('Lista desatualizada').count()).toBe(0)
        expect(await skeletons(page).count()).toBe(0)
      })
    })
  })

// ----------------------------------------------------------------- ui-gallery

const registerGallery = (harness: () => PageHarness) =>
  describe('page states: ui-gallery', () => {
    // The gallery shows each state as a fixed example, with no data to load.
    it('ui-gallery: loading', async () => {
      await withPage(harness, 'ui-gallery', {}, async ({ page }) => {
        const loading = busy(page)
        await loading.getByText('Carregando histórico…').waitFor(WAIT)
        expect(await loading.getByRole('status').count()).toBe(1)
        expect(await loading.locator('.skeleton').count()).toBe(2)
        // Skeletons are decoration for assistive technology.
        expect(
          await loading
            .locator('.skeleton')
            .first()
            .getAttribute('aria-hidden'),
        ).toBe('true')
      })
    })

    it('ui-gallery: empty', async () => {
      await withPage(harness, 'ui-gallery', {}, async ({ page }) => {
        await page.getByRole('tab', { name: 'Materiais' }).click()
        const panel = page.getByRole('tabpanel', { name: 'Materiais' })
        await panel
          .getByRole('heading', { name: 'Nenhum material cadastrado' })
          .waitFor(WAIT)
        expect(await panel.innerText()).toContain('Cadastre um material')
        // The next action is a real button.
        await panel.getByRole('button', { name: 'Cadastrar material' }).click()
        await page.getByText('Cadastro de material iniciado.').waitFor(WAIT)
      })
    })

    it('ui-gallery: error', async () => {
      await withPage(harness, 'ui-gallery', {}, async ({ page }) => {
        await page
          .getByRole('heading', { name: 'Histórico indisponível' })
          .waitFor(WAIT)
        expect(
          await page.getByText('Tente carregar o histórico novamente.').count(),
        ).toBe(1)
        await page.getByRole('button', { name: 'Tentar novamente' }).click()
        await page.getByText('O histórico continua indisponível.').waitFor(WAIT)
        await noRawError(page)
      })
    })

    it('ui-gallery: stale', async () => {
      await withPage(harness, 'ui-gallery', {}, async ({ page }) => {
        const notice = page
          .getByRole('status')
          .filter({ hasText: 'Histórico desatualizado' })
        await notice.waitFor(WAIT)
        expect(await notice.innerText()).toContain(
          'Mostrando os últimos dados carregados.',
        )
        await notice.getByRole('button', { name: 'Atualizar' }).click()
        await page.getByText('Atualizando o histórico.').waitFor(WAIT)
      })
    })
  })

export const register: RegisterStates = (harness) => {
  registerBiblioteca(harness)
  registerHistorico(harness)
  registerSpoolman(harness)
  registerArquivos(harness)
  registerCompatibilidade(harness)
  registerGallery(harness)
}
