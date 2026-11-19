// SPDX-License-Identifier: MIT
import { readFile } from 'node:fs/promises'
import { basename, dirname } from 'node:path'
import type { IncomingMessage, ServerResponse } from 'node:http'
import AxeBuilder from '@axe-core/playwright'
import type { Page } from '@playwright/test'
import { build } from 'esbuild'
import {
  compileScript,
  compileStyle,
  compileTemplate,
  parse,
} from 'vue/compiler-sfc'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { launchBrowser, type Browser } from '../helpers/browser'
import { startHttpMock } from '../../packages/sim-tools/src/mocks/http-mock'
import {
  compatibleWith,
  filterQuery,
  formatBytes,
  formatDuration,
  nozzleError,
  totalGrams,
  validateLibraryUpload,
  versionStatus,
  type LibraryItem,
  type LibraryVersion,
} from '../../apps/farm/app/utils/library-view'

const FARM = '11111111-1111-4111-8111-111111111111'
const PRINTER_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const AGENT = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'

const version = (n: number, over: Partial<LibraryVersion> = {}) =>
  ({
    id: `v0000000-0000-4000-8000-00000000000${n}`,
    itemId: 'i',
    versionNumber: n,
    sizeBytes: 2 * 1024 * 1024,
    storageLocation: 'connector',
    agentId: AGENT,
    originalName: `peca-v${n}.gcode`,
    kind: 'gcode',
    plateCount: 2,
    metadata: {
      printerModel: 'Voron 2.4',
      slicer: 'OrcaSlicer',
      slicerVersion: '2.3',
      estimatedTimeSeconds: 5400,
      tools: [
        {
          nozzleDiameter: 0.4,
          filamentType: 'PLA',
          filamentColour: '#ff0000',
          filamentGrams: 12.5,
        },
      ],
    },
    hasThumbnail: true,
    notes: '',
    createdAt: Date.UTC(2026, 10, 1, 12),
    deletedAt: null,
    purgedAt: null,
    ...over,
  }) as LibraryVersion
const item = (
  id: string,
  title: string,
  latest: LibraryVersion,
  tags: string[] = [],
): LibraryItem => ({
  id,
  title,
  tags,
  archived: false,
  createdAt: 1,
  latest: { ...latest, itemId: id },
})

const vase = item('1', 'Vaso espiral', version(2), ['decoração'])
const bracket = item(
  '2',
  'Suporte grande',
  version(1, {
    hasThumbnail: false,
    metadata: {
      printerModel: 'Ender 3',
      slicer: 'Cura',
      tools: [{ nozzleDiameter: 0.6, filamentType: 'PETG' }],
    },
  }),
  ['oficina'],
)

type Scenario = {
  items?: LibraryItem[]
  canManage?: boolean
  mode?: 'server' | 'connector'
  /** Failures to answer the first list calls with. */
  listFailures?: number
  listDelayMs?: number
}

/** In-process fake of the library API on 127.0.0.1, port 0. */
async function startApi(scenario: Scenario, shell: string) {
  let failures = scenario.listFailures ?? 0
  let mode = scenario.mode ?? 'connector'
  const json = (res: ServerResponse, status: number, body: unknown) => {
    res.statusCode = status
    res.setHeader('content-type', 'application/json')
    res.end(JSON.stringify(body))
  }
  const base = `/api/farms/${FARM}`
  const server = await startHttpMock({
    port: 0,
    handler: async (
      req: IncomingMessage,
      res: ServerResponse,
      body: Buffer,
    ) => {
      const url = new URL(req.url ?? '/', 'http://x')
      const path = url.pathname
      const method = req.method
      if (path === '/') {
        res.setHeader('content-type', 'text/html; charset=utf-8')
        return void res.end(shell)
      }
      if (path === '/api/farms')
        return json(res, 200, { farms: [{ farmId: FARM }] })
      if (path === `${base}/connectors`)
        return json(res, 200, {
          connectors: [{ agentId: AGENT, status: 'approved' }],
        })
      if (path === `${base}/printer-profiles`)
        return json(res, 200, {
          profiles: [
            {
              assignmentId: PRINTER_A,
              effective: {
                values: { model: 'Voron 2.4', nozzleDiameterMm: 0.4 },
                compatibleModels: [],
              },
            },
          ],
        })
      if (path === `${base}/library/settings` && method === 'GET')
        return json(res, 200, {
          settings: {
            storageMode: mode,
            quotaBytes: 20 * 1024 ** 3,
            retentionDays: 30,
          },
          locations: [
            { location: 'connector', agentId: AGENT, files: 3, bytes: 4096 },
            { location: 'server', agentId: null, files: 1, bytes: 1024 },
          ],
          usage: { usedBytes: 5120 },
          canManage: scenario.canManage ?? true,
        })
      if (path === `${base}/library/settings` && method === 'PUT') {
        mode = JSON.parse(body.toString()).storageMode
        return json(res, 200, {})
      }
      if (path === `${base}/library` && method === 'GET') {
        if (scenario.listDelayMs)
          await new Promise((r) => setTimeout(r, scenario.listDelayMs))
        if (failures-- > 0)
          return json(res, 503, {
            message: 'Biblioteca indisponível. Tente novamente.',
          })
        const q = url.searchParams
        const wanted = (scenario.items ?? [vase, bracket]).filter(
          (i) =>
            (!q.get('material') ||
              i.latest.metadata.tools?.some(
                (t) =>
                  t.filamentType?.toLowerCase() ===
                  q.get('material')!.toLowerCase(),
              )) &&
            (!q.get('title') ||
              i.title.toLowerCase().includes(q.get('title')!.toLowerCase())),
        )
        return json(res, 200, { items: wanted, nextCursor: null })
      }
      if (path === `${base}/library` && method === 'POST')
        return json(res, 201, {
          item: vase,
          version: version(3, { plateCount: 3 }),
          deduplicated: false,
        })
      if (path.endsWith('/versions') && method === 'GET')
        return json(res, 200, {
          versions: [
            version(2),
            version(1, { purgedAt: 5, deletedAt: 4, hasThumbnail: false }),
          ],
        })
      if (path.includes('/library/versions/') && method === 'DELETE')
        return json(res, 200, { deleted: true, deletedAt: 9 })
      json(res, 404, { message: 'não encontrado' })
    },
  })
  return server
}

describe('library view helpers', () => {
  it('builds the query from filled filters only', () => {
    expect(
      filterQuery(
        {
          title: ' vaso ',
          printerModel: '',
          nozzle: '0.4',
          material: '',
          tag: 'a',
        },
        'abc',
      ),
    ).toEqual({ title: 'vaso', nozzle: '0.4', tag: 'a', cursor: 'abc' })
  })
  it('validates nozzle, upload and formats values', () => {
    expect(nozzleError('')).toBeUndefined()
    expect(nozzleError('0,4')).toBeUndefined()
    expect(nozzleError('abc')).toBeTypeOf('string')
    expect(nozzleError('11')).toBeTypeOf('string')
    expect(validateLibraryUpload({ name: 'a.gcode', size: 1 })).toBeUndefined()
    expect(validateLibraryUpload({ name: 'a.exe', size: 1 })).toBeTypeOf(
      'string',
    )
    expect(validateLibraryUpload({ name: 'a.3mf', size: 0 })).toBeTypeOf(
      'string',
    )
    expect(formatDuration(5400)).toBe('1 h 30 min')
    expect(formatDuration(undefined)).toBe('não informado')
    expect(formatBytes(2 * 1024 * 1024)).toBe('2,0 MiB')
    expect(totalGrams(vase.latest.metadata)).toBe(12.5)
    expect(versionStatus(version(1, { purgedAt: 1 }))).toBe('arquivo removido')
  })
  it('hides what the printer profile blocks', () => {
    const profile = {
      assignmentId: PRINTER_A,
      effective: {
        values: { model: 'Voron 2.4', nozzleDiameterMm: 0.4 },
        compatibleModels: [],
      },
    }
    expect(compatibleWith([vase, bracket], profile).map((i) => i.id)).toEqual([
      '1',
    ])
    expect(compatibleWith([vase, bracket], undefined)).toHaveLength(2)
  })
})

describe('library page in a browser', () => {
  let browser: Browser
  let appJs = ''
  let appCss = ''
  const shell = `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Biblioteca</title><link rel="stylesheet" href="/app.css"></head><body><div id="app"></div><script src="/app.js" defer></script></body></html>`

  beforeAll(async () => {
    const result = await build({
      stdin: {
        contents: `
          import { createApp } from 'vue'
          import Page from './apps/farm/app/pages/biblioteca.vue'
          import './apps/farm/app/assets/css/main.css'
          // Nuxt provides $fetch; this is the part of ofetch the page uses.
          globalThis.$fetch = async (url, o = {}) => {
            const q = o.query ? '?' + new URLSearchParams(o.query) : ''
            const response = await fetch(url + q, {
              method: o.method ?? 'GET',
              headers: o.body ? { 'content-type': 'application/json' } : {},
              body: o.body ? JSON.stringify(o.body) : undefined,
              signal: o.signal,
            })
            const data = await response.json().catch(() => undefined)
            if (!response.ok) throw Object.assign(new Error('http'), { data })
            return data
          }
          createApp(Page).mount('#app')
        `,
        resolveDir: process.cwd(),
      },
      bundle: true,
      write: false,
      outfile: 'app.js',
      define: { 'process.env.NODE_ENV': '"production"' },
      plugins: [
        {
          name: 'vue-sfc',
          setup(b) {
            b.onLoad({ filter: /\.vue$/ }, async ({ path }) => {
              const { descriptor, errors } = parse(
                await readFile(path, 'utf8'),
                {
                  filename: path,
                },
              )
              if (errors.length) throw new Error(errors.join('\n'))
              const id = `data-v-${basename(path, '.vue')}`
              let code: string
              if (descriptor.scriptSetup) {
                code = compileScript(descriptor, {
                  id,
                  inlineTemplate: true,
                  genDefaultAs: 'component',
                }).content
              } else {
                const template = compileTemplate({
                  filename: path,
                  id,
                  source: descriptor.template?.content ?? '',
                })
                if (template.errors.length)
                  throw new Error(template.errors.join('\n'))
                code = `${template.code}\nconst component = { render }`
              }
              const css = descriptor.styles
                .map(
                  ({ content, scoped }) =>
                    compileStyle({
                      filename: path,
                      id,
                      source: content,
                      scoped: Boolean(scoped),
                    }).code,
                )
                .join('\n')
              return {
                loader: 'ts',
                resolveDir: dirname(path),
                contents: `${code}
                component.__scopeId = ${JSON.stringify(id)}
                const style = document.createElement('style')
                style.textContent = ${JSON.stringify(css)}
                document.head.append(style)
                export default component`,
              }
            })
          },
        },
      ],
    })
    appJs = result.outputFiles.find((f) => f.path.endsWith('.js'))!.text
    appCss = result.outputFiles.find((f) => f.path.endsWith('.css'))!.text
    browser = await launchBrowser({ args: ['--disable-background-networking'] })
  }, 30_000)

  afterAll(async () => {
    await Promise.race([
      browser?.close(),
      new Promise((resolve) => setTimeout(resolve, 5_000).unref()),
    ])
  })

  /** Starts the fake API, opens the page and returns helpers. */
  async function open(scenario: Scenario = {}, width = 1280) {
    const server = await startApi(scenario, shell)
    const context = await browser.newContext({
      viewport: { width, height: 900 },
    })
    await context.route('**/*', (route) => {
      const url = new URL(route.request().url())
      if (url.origin !== server.origin) return route.abort()
      if (url.pathname === '/app.js')
        return route.fulfill({ contentType: 'text/javascript', body: appJs })
      if (url.pathname === '/app.css')
        return route.fulfill({ contentType: 'text/css', body: appCss })
      return route.continue()
    })
    const page = await context.newPage()
    await page.goto(server.origin)
    const calls = (method: string, fragment: string) =>
      server.calls.all.filter(
        (c) => c.method === method && c.url.includes(fragment),
      )
    const close = async () => {
      await context.close()
      await server.close()
    }
    return { page, server, calls, close }
  }

  async function ready(page: Page) {
    await page.getByRole('heading', { name: 'Vaso espiral' }).waitFor()
  }

  it('lists items as a grid with thumbnail, model, time, grams, slicer and materials', async () => {
    const { page, close } = await open()
    try {
      await ready(page)
      const card = page.getByRole('article').filter({ hasText: 'Vaso espiral' })
      await card.getByText('Voron 2.4').waitFor()
      const text = await card.innerText()
      expect(text).toContain('1 h 30 min')
      expect(text).toContain('12,5 g')
      expect(text).toContain('OrcaSlicer')
      expect(text).toContain('PLA')
      expect(text).toContain('decoração')
      expect(await card.locator('img').getAttribute('src')).toMatch(
        /\/library\/versions\/v0000000-0000-4000-8000-000000000002\/thumbnail$/,
      )
      // No thumbnail: placeholder, not a broken image.
      const other = page
        .getByRole('article')
        .filter({ hasText: 'Suporte grande' })
      expect(await other.locator('img').count()).toBe(0)
      await page.getByRole('button', { name: 'Lista' }).click()
      const row = page.getByRole('article').filter({ hasText: 'Vaso espiral' })
      await row.getByText('Bico').waitFor()
      expect(await row.innerText()).toContain('0.4 mm'.replace('.', ','))
      expect(await row.innerText()).toContain('#ff0000')
      expect(
        await page
          .getByRole('button', { name: 'Lista' })
          .getAttribute('aria-pressed'),
      ).toBe('true')
    } finally {
      await close()
    }
  })

  it('filters by query, rejects a bad nozzle and hides items a printer cannot print', async () => {
    const { page, calls, close } = await open()
    try {
      await ready(page)
      await page.getByLabel('Material').fill('PETG')
      await page.getByRole('button', { name: 'Buscar' }).click()
      await page.getByRole('heading', { name: 'Suporte grande' }).waitFor()
      expect(
        await page.getByRole('heading', { name: 'Vaso espiral' }).count(),
      ).toBe(0)
      expect(calls('GET', 'material=PETG')).toHaveLength(1)

      const before = calls('GET', '/library?').length
      await page.getByLabel('Bico (mm)').fill('abc')
      await page.getByRole('button', { name: 'Buscar' }).click()
      await page.getByText('Informe um diâmetro entre 0,1 e 10 mm.').waitFor()
      expect(calls('GET', '/library?').length).toBe(before)

      await page.getByRole('button', { name: 'Limpar filtros' }).click()
      await ready(page)
      await page.getByLabel('Compatível com').selectOption(PRINTER_A)
      expect(
        await page.getByRole('heading', { name: 'Suporte grande' }).count(),
      ).toBe(0)
      await page.getByText('1 item(ns) na lista.').waitFor()
    } finally {
      await close()
    }
  })

  it('shows loading, error with retry, and empty states', async () => {
    const slow = await open({ listDelayMs: 400, listFailures: 1 })
    try {
      await slow.page.getByText('Carregando a biblioteca…').waitFor()
      await slow.page
        .getByRole('heading', { name: 'Biblioteca indisponível' })
        .waitFor()
      await slow.page.getByRole('button', { name: 'Tentar novamente' }).click()
      await ready(slow.page)
    } finally {
      await slow.close()
    }
    const empty = await open({ items: [] })
    try {
      await empty.page
        .getByRole('heading', { name: 'A biblioteca está vazia' })
        .waitFor()
      await empty.page.getByLabel('Título').fill('nada')
      await empty.page.getByRole('button', { name: 'Buscar' }).click()
      await empty.page
        .getByRole('heading', { name: 'Nenhum item encontrado' })
        .waitFor()
    } finally {
      await empty.close()
    }
  })

  it('uploads with validation, sends the file and previews the parsed metadata', async () => {
    const { page, calls, close } = await open()
    try {
      await ready(page)
      await page.getByRole('button', { name: 'Enviar arquivo' }).click()
      const form = page.locator('#library-upload')
      await form.getByLabel(/Arquivo/).setInputFiles({
        name: 'virus.exe',
        mimeType: 'application/octet-stream',
        buffer: Buffer.from('x'),
      })
      await form.getByText('Selecione um arquivo .gcode ou .3mf.').waitFor()
      // Connector mode needs a destination before any byte moves.
      await form.getByLabel(/Arquivo/).setInputFiles({
        name: 'peca.gcode',
        mimeType: 'application/octet-stream',
        buffer: Buffer.from('G1 X1'),
      })
      await form
        .getByRole('button', { name: 'Enviar para a biblioteca' })
        .click()
      await form
        .getByText('Escolha o Connector que vai guardar o arquivo.')
        .waitFor()
      expect(calls('POST', '/library?')).toHaveLength(0)

      await form.getByLabel('Título (opcional)').fill('Peça nova')
      await form.getByLabel('Etiquetas').fill('a, b')
      await form.getByLabel('Connector de destino').selectOption(AGENT)
      await form
        .getByRole('button', { name: 'Enviar para a biblioteca' })
        .click()
      await form
        .getByRole('heading', { name: 'Arquivo enviado: versão 3' })
        .waitFor()
      expect(await form.innerText()).toContain('3 placa(s) no arquivo.')
      expect(await form.innerText()).toContain('OrcaSlicer')

      const [post] = calls('POST', '/library?')
      const url = new URL(post!.url, 'http://x')
      expect(url.searchParams.get('name')).toBe('peca.gcode')
      expect(url.searchParams.get('title')).toBe('Peça nova')
      expect(url.searchParams.get('agentId')).toBe(AGENT)
      expect(url.searchParams.getAll('tag')).toEqual(['a', 'b'])
      expect(post!.headers['content-type']).toBe('application/octet-stream')
      expect(post!.body?.toString()).toBe('G1 X1')
      // The list is reloaded after the upload.
      expect(calls('GET', '/library?').length).toBeGreaterThanOrEqual(2)
    } finally {
      await close()
    }
  })

  it('opens the item, shows version history and plates, and deletes only by role', async () => {
    const managed = await open({ canManage: true })
    try {
      await ready(managed.page)
      await managed.page
        .getByRole('button', { name: 'Ver detalhes de Vaso espiral' })
        .click()
      const dialog = managed.page.getByRole('dialog', { name: 'Vaso espiral' })
      const table = dialog.getByRole('region', { name: 'Histórico de versões' })
      await table.getByText('peca-v2.gcode').waitFor()
      const text = await table.innerText()
      expect(text).toContain('arquivo removido')
      expect(text).toContain('disponível')
      expect(text).toContain('Connector')
      await dialog.getByLabel('Placa').selectOption('2')
      expect(await dialog.getByLabel('Placa').inputValue()).toBe('2')
      // Only the live version can be deleted, and it asks first.
      expect(
        await dialog.getByRole('button', { name: /Excluir versão/ }).count(),
      ).toBe(1)
      await dialog.getByRole('button', { name: 'Excluir versão v2' }).click()
      await dialog.getByRole('button', { name: 'Cancelar' }).click()
      expect(managed.calls('DELETE', '/library/versions/')).toHaveLength(0)
      await dialog.getByRole('button', { name: 'Excluir versão v2' }).click()
      await dialog.getByRole('button', { name: 'Confirmar exclusão' }).click()
      await dialog.getByText(/Versão excluída/).waitFor()
      expect(managed.calls('DELETE', '/library/versions/')).toHaveLength(1)
    } finally {
      await managed.close()
    }
    const viewer = await open({ canManage: false })
    try {
      await ready(viewer.page)
      await viewer.page
        .getByRole('button', { name: 'Ver detalhes de Vaso espiral' })
        .click()
      const dialog = viewer.page.getByRole('dialog', { name: 'Vaso espiral' })
      await dialog.getByText('peca-v2.gcode').waitFor()
      expect(
        await dialog.getByRole('button', { name: /Excluir/ }).count(),
      ).toBe(0)
    } finally {
      await viewer.close()
    }
  })

  it('reports where files are and switches the storage mode for future uploads only', async () => {
    const { page, calls, close } = await open()
    try {
      await ready(page)
      const storage = page.getByRole('region', { name: 'Armazenamento' })
      const text = await storage.innerText()
      expect(text).toContain('Modo atual: Connector')
      expect(text).toContain('Cota: 20,0 GiB')
      expect(text).toContain('30 dias')
      expect(text).toContain('Servidor: 1 arquivo(s)')
      expect(text).toContain('sem migração')
      await storage.getByLabel('Modo para novos envios').selectOption('server')
      await storage.getByRole('button', { name: 'Alterar modo' }).click()
      await page.getByText(/Modo de armazenamento alterado/).waitFor()
      expect(
        JSON.parse(calls('PUT', '/library/settings')[0]!.body!.toString()),
      ).toEqual({
        storageMode: 'server',
      })
      await storage.getByText('Modo atual: Servidor').waitFor()
    } finally {
      await close()
    }
  })

  it.each([320, 768, 1280])(
    'passes axe, fits and is keyboard reachable at %i px',
    async (width) => {
      const { page, close } = await open({}, width)
      try {
        await ready(page)
        await page.getByRole('button', { name: 'Enviar arquivo' }).click()
        await page.locator('#library-upload').waitFor()
        expect(
          await page.evaluate(() => document.documentElement.scrollWidth),
        ).toBe(width)
        expect((await new AxeBuilder({ page }).analyze()).violations).toEqual(
          [],
        )
        // Keyboard: the first filter is the first stop.
        await page
          .getByRole('heading', { name: 'Biblioteca', level: 1 })
          .click()
        await page.keyboard.press('Tab')
        expect(
          await page.evaluate(
            () => (document.activeElement as HTMLInputElement | null)?.type,
          ),
        ).toBe('search')
        // Open details by keyboard; the dialog is modal and Escape closes it.
        const detail = page.getByRole('button', {
          name: 'Ver detalhes de Vaso espiral',
        })
        await detail.focus()
        await page.keyboard.press('Enter')
        const dialog = page.getByRole('dialog', { name: 'Vaso espiral' })
        await dialog.getByText('peca-v2.gcode').waitFor()
        expect(
          await page.evaluate(() => document.documentElement.scrollWidth),
        ).toBe(width)
        expect((await new AxeBuilder({ page }).analyze()).violations).toEqual(
          [],
        )
        await page.keyboard.press('Escape')
        await dialog.waitFor({ state: 'hidden' })
        expect(
          await detail.evaluate((el) => el === document.activeElement),
        ).toBe(true)
      } finally {
        await close()
      }
    },
    120_000,
  )
})
