import { readFile } from 'node:fs/promises'
import AxeBuilder from '@axe-core/playwright'
import { build } from 'esbuild'
import { compileScript, parse } from 'vue/compiler-sfc'
import { expect, test } from 'vitest'
import { startHttpMock } from '../../packages/sim-tools/src/mocks/http-mock.ts'
import { launchBrowser } from '../helpers/browser.ts'
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

test('remembers the table, sorts by keyboard and opens printer details', async () => {
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
    bundle: true,
    write: false,
  })
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
        response.end(bundle.outputFiles[0].text)
      },
    },
  })
  try {
    const browser = await launchBrowser({
      args: ['--disable-background-networking'],
    })
    try {
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
      expect(await links.allTextContents()).toEqual(['Máquina 2', 'Máquina 10'])
      const progress = table.getByRole('button', { name: 'Progresso' })
      await progress.focus()
      await page.keyboard.press('Space')
      expect(await links.allTextContents()).toEqual(['Máquina 10', 'Máquina 2'])
      await page.keyboard.press('Enter')
      expect(await links.allTextContents()).toEqual(['Máquina 2', 'Máquina 10'])
      expect(
        await table
          .getByRole('columnheader', { name: 'Progresso' })
          .getAttribute('aria-sort'),
      ).toBe('descending')
      expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([])
      await links.first().focus()
      await page.keyboard.press('Enter')
      const heading = page.getByRole('heading', {
        name: 'Detalhes da impressora',
      })
      await heading.waitFor()
      expect(
        await heading.evaluate((element) => element === document.activeElement),
      ).toBe(true)
      expect(await page.getByRole('listitem').allTextContents()).toEqual([
        'Máquina 2',
      ])
      await page.goBack()
      await table.waitFor()
      await page.getByRole('button', { name: 'Cartões' }).click()
      await page.reload()
      await page.getByRole('list').waitFor()
      expect(await table.count()).toBe(0)
    } finally {
      await browser.close()
    }
  } finally {
    await server.close()
  }
}, 30_000)
