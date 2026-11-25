import { readFile } from 'node:fs/promises'
import AxeBuilder from '@axe-core/playwright'
import { build } from 'esbuild'
import { compileScript, parse } from 'vue/compiler-sfc'
import { expect, test } from 'vitest'
import { startHttpMock } from '../../packages/sim-tools/src/mocks/http-mock.ts'
import { withBrowser } from '../helpers/browser.ts'
import { vueSfcPlugin } from '../e2e/vue-sfc-plugin.ts'
import { FarmAssignmentPage } from '../../apps/farm/app/utils/farm-view.ts'

const ids = [
  '00000000-0000-4000-8000-000000000001',
  '00000000-0000-4000-8000-000000000002',
]
const printers = ids.map((assignmentId, index) => ({
  assignmentId,
  agentId: ids[0],
  printerKey: `Impressora ${index}`,
  displayName: index ? 'Máquina 10' : 'Máquina 2',
  groupName: 'Produção',
  location: 'Sala 1',
  sortOrder: null,
  status: 'active',
  connectorStatus: 'approved',
}))

test('the assignment inventory accepts grouping metadata', () => {
  expect(
    FarmAssignmentPage.parse({ printers, canManage: true, nextAfter: null })
      .printers,
  ).toEqual(printers)
})

test('remembers the table, sorts by keyboard and links to printer details', async () => {
  const filename = 'apps/farm/app/components/farm/PrinterWallTable.vue'
  const { descriptor, errors } = parse(await readFile(filename, 'utf8'), {
    filename,
  })
  expect(errors).toEqual([])
  const script = compileScript(descriptor, {
    id: 'printer-wall',
    inlineTemplate: true,
    genDefaultAs: 'Wall',
  })
  const bundle = await build({
    stdin: {
      contents: `
        ${script.content}
        import { createApp, h } from 'vue'
        const rows = ${JSON.stringify(printers)}.map((assignment, index) => ({
          assignment,
          connection: 'authenticated',
          observation: {
            received: { wall: 0, mono: 0 },
            state: { state: 'printing', progress: [0.8, 0.2][index] },
          },
        }))
        createApp({
          render: () => h(Wall, { rows, liveNow: () => ({ wall: 0, mono: 0 }) }, {
            default: ({ rows }) => h('ul', rows.map(row => h('li', row.assignment.displayName))),
          }),
        }).mount('#app')
      `,
      resolveDir: new URL(
        '../../apps/farm/app/components/farm/',
        import.meta.url,
      ).pathname,
      loader: 'ts',
    },
    plugins: [vueSfcPlugin],
    bundle: true,
    write: false,
  })
  const outputFile = bundle.outputFiles?.[0]
  expect(outputFile).toBeDefined()
  if (!outputFile) throw new Error('esbuild produced no output file')
  const server = await startHttpMock({
    port: 0,
    routes: {
      '/'(_request, response) {
        response.setHeader('content-type', 'text/html; charset=utf-8')
        response.end(
          '<!doctype html><html lang="pt-BR"><title>Frota</title><main><h1>Frota</h1><div id="app"></div></main><script src="/wall.js"></script></html>',
        )
      },
      '/wall.js'(_request, response) {
        response.setHeader('content-type', 'text/javascript')
        response.end(outputFile.text)
      },
    },
  })
  try {
    await withBrowser(
      { args: ['--disable-background-networking'] },
      async (browser) => {
        const context = await browser.newContext()
        await context.route('**/*', (route) =>
          new URL(route.request().url()).origin === server.origin
            ? route.continue()
            : route.abort(),
        )
        const page = await context.newPage()
        await page.goto(server.origin)
        const toggle = page.getByRole('button', { name: 'Tabela' })
        await toggle.focus()
        await page.keyboard.press('Enter')
        await page.reload()
        const table = page.getByRole('table')
        await table.waitFor()
        const links = table.getByRole('link')
        expect(await links.allTextContents()).toEqual([
          'Máquina 2',
          'Máquina 10',
        ])
        const progress = table.getByRole('button', { name: 'Progresso' })
        await progress.focus()
        await page.keyboard.press('Space')
        expect(await links.allTextContents()).toEqual([
          'Máquina 10',
          'Máquina 2',
        ])
        await page.keyboard.press('Enter')
        expect(await links.allTextContents()).toEqual([
          'Máquina 2',
          'Máquina 10',
        ])
        expect(
          await table
            .getByRole('columnheader', { name: 'Progresso' })
            .getAttribute('aria-sort'),
        ).toBe('descending')
        expect((await new AxeBuilder({ page }).analyze()).violations).toEqual(
          [],
        )
        // Each row opens the printer detail page, not an anchor on this page.
        expect(
          await links.evaluateAll((anchors) =>
            anchors.map((anchor) => anchor.getAttribute('href')),
          ),
        ).toEqual([
          '/impressoras/Impressora%200',
          '/impressoras/Impressora%201',
        ])
        await page.getByRole('button', { name: 'Cartões' }).click()
        await page.reload()
        await page.getByRole('list').waitFor()
        expect(await table.count()).toBe(0)
      },
    )
  } finally {
    await server.close()
  }
}, 90_000)
